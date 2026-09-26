// Supabase Edge Function: import-ibkr-statement
//
// Imports an Interactive Brokers Activity Statement, CSV (Performance &
// Reports -> Statements -> Activity Statement -> Format CSV; one file per
// period, e.g. U21558468_2025_2025.csv, U21558468_20260101_20260925.csv).
// The file is a stack of sections, each "Section,Header,..." row naming the
// columns of the "Section,Data,..." rows after it (a section can restart
// with a new header -- Trades has one for Stocks and one for Forex).
//
// Written, all with account 'IBKR':
//   trades (external_source 'ibkr_csv')
//     - Trades / Stocks: buy / sell, price = T. Price, fee_tax = Comm/Fee
//       (in the trade currency), exchange from Financial Instrument
//       Information (LSEETF -> LSE, as Snowball names it);
//     - Dividends: side 'dividend', quantity = the amount paid, price = the
//       per-share rate from the description ("USD 0.21 per Share") -- the
//       shape Snowball's DIVIDEND rows have.
//   bank_transactions (external_source 'ibkr_csv') -- the cash, per currency:
//     every Deposits & Withdrawals row, every trade's proceeds + commission,
//     both legs of every Forex conversion (EUR.USD: -EUR quantity,
//     +USD proceeds, commission in EUR), Dividends, Withholding Tax, Interest
//     and Fees. balance_after is a running balance starting from the
//     period's Cash Report "Starting Cash", so each file stands on its own
//     and its last row per currency lands on its "Ending Cash" (checked
//     against both statements: USD 121.576183901, EUR 5.10243763). Rows
//     that share a timestamp are spread a millisecond apart in file order;
//     date-only rows (deposits, dividends) sit at the start of their day.
//
// The statement has priority over Snowball's hand-entered rows: Snowball
// trades matching one written here (same side, ticker, date and quantity;
// for a dividend, same ticker and date -- IBKR rounds the amount) are
// deleted, and import-trades-csv leaves them out of later uploads.
// Everything is upserted by content, so re-uploading a period is harmless.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ACCOUNT = 'IBKR';
const SOURCE = 'ibkr_csv';
const EXCHANGE_NAMES: Record<string, string> = { LSEETF: 'LSE' };

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

// "-1,621" / "4252.13" / "" -> number (IBKR writes thousands separators).
const num = (s: string | undefined) => {
  const t = (s || '').replace(/,/g, '').trim();
  return t ? Number(t) : 0;
};
const round = (x: number, d = 9) => Math.round(x * 10 ** d) / 10 ** d;

interface CashMove { time: string; currency: string; amount: number; description: string }

function parse(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  if (!/^Statement,Header,/.test(lines[0] || '')) return null;
  const header: Record<string, string[]> = {};
  const data: { section: string; get: (col: string) => string; cells: string[] }[] = [];
  let title = '';
  for (const line of lines) {
    const c = parseCsvLine(line);
    if (c[1] === 'Header') { header[c[0]] = c; continue; }
    if (c[1] !== 'Data') continue;
    const h = header[c[0]] ?? [];
    if (c[0] === 'Statement' && c[2] === 'Title') title = c[3];
    data.push({ section: c[0], cells: c, get: (col: string) => { const i = h.indexOf(col); return i < 0 ? '' : (c[i] ?? ''); } });
  }
  if (title !== 'Activity Statement') return null;

  const exchange: Record<string, string> = {};
  for (const d of data.filter(d => d.section === 'Financial Instrument Information')) {
    const ex = d.get('Listing Exch');
    exchange[d.get('Symbol')] = EXCHANGE_NAMES[ex] ?? ex;
  }
  const starting: Record<string, number> = {};
  const ending: Record<string, number> = {};
  for (const d of data.filter(d => d.section === 'Cash Report')) {
    const ccy = d.get('Currency');
    if (ccy === 'Base Currency Summary') continue;
    if (d.get('Currency Summary') === 'Starting Cash') starting[ccy] = num(d.get('Total'));
    if (d.get('Currency Summary') === 'Ending Cash') ending[ccy] = num(d.get('Total'));
  }

  const trades = [];
  const cash: CashMove[] = [];
  for (const d of data) {
    const isTotal = (d.cells[2] || '').startsWith('Total');
    if (d.section === 'Trades' && d.get('DataDiscriminator') === 'Order') {
      const time = d.get('Date/Time').replace(', ', 'T');
      const ccy = d.get('Currency');
      const commCol = d.get('Comm/Fee') !== '' ? 'Comm/Fee' : 'Comm in EUR';
      const comm = num(d.get(commCol));
      if (d.get('Asset Category') === 'Stocks') {
        const qty = num(d.get('Quantity'));
        const symbol = d.get('Symbol');
        trades.push({
          ticker: symbol, side: qty >= 0 ? 'buy' : 'sell', quantity: Math.abs(qty), price: num(d.get('T. Price')),
          trade_date: time.slice(0, 10), currency: ccy, fee_tax: Math.abs(comm), fee_currency: ccy,
          exchange: exchange[symbol] || null, note: null, external_id: `trade:${time}:${symbol}:${qty}:${d.get('T. Price')}`,
        });
        cash.push({ time, currency: ccy, amount: num(d.get('Proceeds')) + comm, description: `${qty >= 0 ? 'Buy' : 'Sell'} ${Math.abs(qty)} ${symbol} @ ${d.get('T. Price')}` });
      } else if (d.get('Asset Category') === 'Forex') {
        const [base, quote] = d.get('Symbol').split('.');
        const qty = num(d.get('Quantity'));
        const desc = `Forex ${d.get('Symbol')} ${qty} @ ${d.get('T. Price')}`;
        cash.push({ time, currency: base, amount: qty, description: desc });
        cash.push({ time, currency: quote, amount: num(d.get('Proceeds')), description: desc });
        if (comm) cash.push({ time, currency: 'EUR', amount: comm, description: `${desc} -- commission` });
      }
    } else if (d.section === 'Deposits & Withdrawals' && !isTotal) {
      cash.push({ time: `${d.get('Settle Date')}T00:00:00`, currency: d.get('Currency'), amount: num(d.get('Amount')), description: d.get('Description') });
    } else if (['Dividends', 'Withholding Tax', 'Interest', 'Fees'].includes(d.section) && !isTotal) {
      const date = d.get('Date');
      const description = d.get('Description');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      cash.push({ time: `${date}T00:00:00`, currency: d.get('Currency'), amount: num(d.get('Amount')), description });
      if (d.section === 'Dividends') {
        const symbol = description.match(/^([A-Z0-9.]+)\(/)?.[1];
        const rate = description.match(/ ([\d.]+) per Share/)?.[1];
        if (symbol) trades.push({
          ticker: symbol, side: 'dividend', quantity: num(d.get('Amount')), price: rate ? Number(rate) : num(d.get('Amount')),
          trade_date: date, currency: d.get('Currency'), fee_tax: null, fee_currency: null,
          exchange: exchange[symbol] || null, note: description, external_id: `dividend:${date}:${symbol}:${d.get('Amount')}`,
        });
      }
    }
  }

  // Running balance per currency, from the period's starting cash.
  cash.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const balance: Record<string, number> = { ...starting };
  const seenTime = new Map<string, number>();
  const occ = new Map<string, number>();
  const bank = cash.map(m => {
    balance[m.currency] = round((balance[m.currency] ?? 0) + m.amount);
    const n = seenTime.get(m.time) ?? 0; seenTime.set(m.time, n + 1);
    const sig = `${m.time}:${m.currency}:${round(m.amount)}:${m.description}`;
    const o = occ.get(sig) ?? 0; occ.set(sig, o + 1);
    return {
      tx_date: new Date(Date.parse(`${m.time}Z`) + n).toISOString(), currency: m.currency, amount: round(m.amount),
      description: m.description, balance_after: balance[m.currency],
      external_id: o === 0 ? sig : `${sig}:dup${o}`,
    };
  });
  const tOcc = new Map<string, number>();
  for (const t of trades) {
    const o = tOcc.get(t.external_id) ?? 0; tOcc.set(t.external_id, o + 1);
    if (o) t.external_id = `${t.external_id}:dup${o}`;
  }
  return { trades, bank, balance, ending };
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
    if (!parsed) return json({ error: 'Not an IBKR Activity Statement CSV' }, 400);

    const trades = parsed.trades.map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null, external_source: SOURCE,
    }));
    for (let i = 0; i < bank.length; i += 500) {
      const { error } = await supabase.from('bank_transactions')
        .upsert(bank.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    if (trades.length) {
      const { error } = await supabase.from('trades').upsert(trades, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }

    // Statement over Snowball: drop the Snowball rows of these same operations.
    let removedSnowball = 0;
    for (const t of trades) {
      let q = supabase.from('trades').delete({ count: 'exact' })
        .eq('user_id', user.id).eq('external_source', 'snowball_csv')
        .eq('ticker', t.ticker).eq('side', t.side).eq('trade_date', t.trade_date);
      if (t.side !== 'dividend') q = q.eq('quantity', t.quantity);
      const { error, count } = await q;
      if (error) return json({ error: error.message }, 500);
      removedSnowball += count ?? 0;
    }

    return json({
      trades: trades.filter(t => t.side !== 'dividend').length,
      dividends: trades.filter(t => t.side === 'dividend').length,
      cash_rows: bank.length,
      removed_snowball_duplicates: removedSnowball,
      cash: parsed.balance,
      statement_ending_cash: parsed.ending,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
