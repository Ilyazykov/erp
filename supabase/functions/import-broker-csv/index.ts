// Supabase Edge Function: import-broker-csv
//
// Parses this project's own flat broker-operations CSV -- the trades of a
// broker that gives no full report to download (Alfa-Investments: its
// operation history is only in the app), transcribed out of band -- and
// writes them to `trades`, the way the broker-statement importers do. The
// broker's cash goes separately, through import-bank-csv (product
// 'brokerage_cash').
//
// CSV shape (this project's own):
//   broker,account_number,date,operation,ticker,name,quantity,price,currency,
//   nkd,fee,amount,record_date,source_file
// operation: buy / sell / dividend (a coupon too) / amortisation / repayment.
// buy / sell: quantity in units, price per unit in `currency` (a bond's
// clean price in money, not %), nkd accrued interest per unit, fee the
// broker's commission. dividend etc.: quantity = the amount received (as
// Snowball and the other importers store payouts), price = per unit held.
// amount is the signed cash effect -- informational. record_date (optional)
// is a payout's record date where it's known to differ from the payment
// date; it goes into the note as "Дата фиксации: DD-MON-YY", which is what
// statement-over-Snowball matching dates a payout by.
//
// Written with account = the `broker` column, external_source 'broker_csv'.
// Statement over Snowball: Snowball rows of the same operations are removed
// (_shared/statement_priority.ts), and import-trades-csv leaves them out of
// later uploads. Upserted by content -- safe to re-upload.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const SOURCE = 'broker_csv';
const SIDES = new Set(['buy', 'sell', 'dividend', 'amortisation', 'repayment']);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

const num = (s?: string) => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
const recordNote = (d: string) => `Дата фиксации: ${d.slice(8, 10)}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const lines = (await req.text()).replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
    const header = parseCsvLine(lines[0] || '').map(h => h.trim());
    const col = (name: string) => header.indexOf(name);
    const idx = Object.fromEntries(['broker', 'account_number', 'date', 'operation', 'ticker', 'name', 'quantity', 'price',
      'currency', 'nkd', 'fee', 'amount', 'record_date'].map(n => [n, col(n)]));
    if (['broker', 'date', 'operation', 'ticker', 'quantity', 'price'].some(n => idx[n] < 0)) {
      return json({ error: 'Unrecognized CSV header' }, 400);
    }

    const rows = [];
    const occ = new Map<string, number>();
    const holdings: Record<string, number> = {};
    let skipped = 0;
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const get = (n: string) => (idx[n] >= 0 ? (c[idx[n]] ?? '').trim() : '');
      const side = get('operation').toLowerCase();
      const date = get('date');
      const ticker = get('ticker');
      const quantity = num(get('quantity'));
      const price = num(get('price'));
      if (!SIDES.has(side) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !ticker || quantity === null || price === null) { skipped++; continue; }
      const recordDate = get('record_date');
      const sig = `${get('account_number')}:${date}:${side}:${ticker}:${quantity}:${price}`;
      const n = occ.get(sig) ?? 0;
      occ.set(sig, n + 1);
      if (side === 'buy' || side === 'sell') holdings[ticker] = (holdings[ticker] ?? 0) + (side === 'buy' ? quantity : -quantity);
      rows.push({
        user_id: user.id, account: get('broker'), ticker, side, quantity, price, trade_date: date,
        currency: get('currency') || null, fee_tax: num(get('fee')) || null, fee_currency: num(get('fee')) ? (get('currency') || null) : null,
        nkd: num(get('nkd')) || null, exchange: null,
        note: [get('name'), /^\d{4}-\d{2}-\d{2}$/.test(recordDate) ? recordNote(recordDate) : ''].filter(Boolean).join('; ') || null,
        external_source: SOURCE, external_id: n ? `${sig}:dup${n}` : sig,
      });
    }
    if (!rows.length) return json({ error: 'No importable rows found', skipped }, 400);

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('trades').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, rows);
    const round = (x: number) => Math.round(x * 1e8) / 1e8;
    return json({
      imported: rows.length, skipped,
      trades: rows.filter(r => r.side === 'buy' || r.side === 'sell').length,
      payouts: rows.filter(r => r.side !== 'buy' && r.side !== 'sell').length,
      removed_snowball_duplicates: removedSnowball,
      holdings: Object.fromEntries(Object.entries(holdings).map(([t, q]) => [t, round(q)]).filter(([, q]) => q)),
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
