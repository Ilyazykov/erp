// Supabase Edge Function: import-revolut-crypto
//
// Imports Revolut's crypto account statement, CSV (Crypto -> ... ->
// Statement):
//   Symbol,Type,Quantity,Price,Value,Fees,Date
//   MEW,Sell,"3,140.45654399",€0.00,€0.97,€0.48,"Jun 7, 2026, 4:56:16 AM"
//   MON,Learn reward,26.6083914,,,,"Jun 7, 2026, 3:35:20 AM"
// Written to trades (account 'Revolut', external_source
// 'revolut_crypto_csv'), so the coins count as holdings:
//   - Buy -> buy, Sell -> sell: price = Value / Quantity (the Price column is
//     rounded to cents -- €0.00 for a meme coin), fee_tax = Fees, in the
//     Value's currency;
//   - any reward ("Learn reward", staking, ...) -> stock_as_dividend at
//     price 0 (coins received for free).
// The cash side isn't written here: a sale's proceeds (Value - Fees) arrive
// in the Revolut current account as "Transfer from Revolut Digital Assets
// Europe Ltd", which import-revolut-statement already imports.
// Statement over Snowball: Snowball rows of the same operations are removed
// (_shared/statement_priority.ts). Rows are upserted by their own content.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'Revolut';
const SOURCE = 'revolut_crypto_csv';
const CURRENCY_BY_SIGN: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// "€2.21" -> { amount: 2.21, currency: 'EUR' }; "" -> null.
function money(s: string) {
  const t = (s || '').trim();
  if (!t) return null;
  const currency = CURRENCY_BY_SIGN[t[0]] ?? null;
  const amount = Number(t.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(amount) ? { amount, currency } : null;
}
// "Jun 7, 2026, 4:56:16 AM" -> "2026-06-07".
function isoDate(s: string): string | null {
  const m = s.trim().match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
  return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null;
}

function parse(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  const header = parseCsvLine(lines[0] || '').map(h => h.trim());
  const col = (n: string) => header.indexOf(n);
  const [cSym, cType, cQty, cValue, cFees, cDate] = ['Symbol', 'Type', 'Quantity', 'Value', 'Fees', 'Date'].map(col);
  if ([cSym, cType, cQty, cDate].some(i => i < 0)) return null;
  const occ = new Map<string, number>();
  const trades = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const ticker = (c[cSym] || '').trim().toUpperCase();
    const type = (c[cType] || '').trim();
    const qty = Number((c[cQty] || '').replace(/,/g, ''));
    const date = isoDate(c[cDate] || '');
    if (!ticker || !date || !Number.isFinite(qty) || qty <= 0) { skipped++; continue; }
    const value = money(c[cValue]);
    const fees = money(c[cFees]);
    const side = /^buy$/i.test(type) ? 'buy' : /^sell$/i.test(type) ? 'sell' : /reward|staking|bonus|airdrop/i.test(type) ? 'stock_as_dividend' : null;
    if (!side) { skipped++; continue; }
    const sig = `${c[cDate].trim()}:${ticker}:${type}:${qty}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    trades.push({
      ticker, side, quantity: qty,
      price: side === 'stock_as_dividend' || !value ? 0 : Math.round(value.amount / qty * 1e10) / 1e10,
      trade_date: date, currency: value?.currency ?? fees?.currency ?? 'EUR',
      fee_tax: fees ? fees.amount : null, fee_currency: fees?.currency ?? null,
      exchange: null, note: `${type}${value ? ` for ${c[cValue].trim()}` : ''}`,
      external_id: n === 0 ? sig : `${sig}:dup${n}`,
    });
  }
  return { trades, skipped };
}

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

    const parsed = parse(await req.text());
    if (!parsed) return json({ error: 'Not a Revolut crypto account statement' }, 400);
    const trades = parsed.trades.map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    if (trades.length) {
      const { error } = await supabase.from('trades').upsert(trades, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, trades);

    const holdings: Record<string, number> = {};
    for (const t of trades) holdings[t.ticker] = (holdings[t.ticker] ?? 0) + (t.side === 'sell' ? -t.quantity : t.quantity);
    return json({
      imported: trades.length, skipped: parsed.skipped, removed_snowball_duplicates: removedSnowball,
      holdings: Object.fromEntries(Object.entries(holdings).filter(([, q]) => Math.abs(q) > 1e-9)),
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
