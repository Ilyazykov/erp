// Supabase Edge Function: import-revolut-invest
//
// Imports Revolut's brokerage (Invest -- stocks & ETFs) account statement,
// CSV:
//   Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate
//   2025-09-26T13:34:45.686110Z,,CASH TOP-UP,,,EUR 1,EUR,1.0000
//   2025-09-26T13:34:47.417Z,XSX6,BUY - MARKET,0.00709219,EUR 141,EUR 1,EUR,1.0000
// Written, with account 'Revolut' and external_source 'revolut_invest_csv':
//   trades -- BUY / SELL (market or limit) at "Price per share", DIVIDEND
//     (quantity = the amount, Snowball's DIVIDEND shape), exchange XETRA
//     (Revolut's EU brokerage lists these ETFs there);
//   bank_transactions -- the brokerage account's own cash in its currency:
//     top-ups / withdrawals (the other side of the current account's
//     transfers), each trade's Total Amount, dividends, fees; running
//     balance from zero, so the file must cover the account from its
//     opening (the checked one does: EUR 0.00 at the end, all invested).
// Statement over Snowball: Snowball rows of the same operations are removed
// (_shared/statement_priority.ts), and import-trades-csv leaves them out.
// Rows are upserted by their own content.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'Revolut';
const SOURCE = 'revolut_invest_csv';
const EXCHANGE = 'XETRA';

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

// "EUR 1,430.50" / "EUR -300" -> 1430.5 / -300; "" -> null.
const amount = (s: string) => {
  const t = (s || '').replace(/[A-Z]{3}/g, '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;

function parse(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  const header = parseCsvLine(lines[0] || '').map(h => h.trim());
  const col = (n: string) => header.indexOf(n);
  const [cDate, cTicker, cType, cQty, cPrice, cTotal, cCcy] =
    ['Date', 'Ticker', 'Type', 'Quantity', 'Price per share', 'Total Amount', 'Currency'].map(col);
  if ([cDate, cType, cTotal, cCcy].some(i => i < 0)) return null;

  const trades = [];
  const cash: { time: string; currency: string; amount: number; description: string }[] = [];
  const occ = new Map<string, number>();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const time = (c[cDate] || '').trim();
    const type = (c[cType] || '').trim().toUpperCase();
    const ticker = (c[cTicker] || '').trim().toUpperCase();
    const currency = (c[cCcy] || '').trim();
    const total = amount(c[cTotal]);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(time) || total === null) { skipped++; continue; }
    const date = time.slice(0, 10);
    const sig = `${time}:${type}:${ticker}:${total}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    const id = n === 0 ? sig : `${sig}:dup${n}`;

    if (/^(BUY|SELL)/.test(type) && ticker) {
      const qty = Number((c[cQty] || '').replace(/,/g, ''));
      const price = amount(c[cPrice]);
      const side = type.startsWith('BUY') ? 'buy' : 'sell';
      trades.push({
        ticker, side, quantity: qty, price: price ?? round(Math.abs(total) / qty, 6), trade_date: date,
        currency, fee_tax: null, fee_currency: null, exchange: EXCHANGE, note: type, external_id: id,
      });
      cash.push({ time, currency, amount: side === 'buy' ? -Math.abs(total) : Math.abs(total), description: `${type} ${qty} ${ticker}` });
    } else if (type.startsWith('DIVIDEND') && ticker) {
      trades.push({
        ticker, side: 'dividend', quantity: total, price: total, trade_date: date,
        currency, fee_tax: null, fee_currency: null, exchange: EXCHANGE, note: type, external_id: id,
      });
      cash.push({ time, currency, amount: total, description: `${type} ${ticker}` });
    } else if (/CASH TOP-UP|CASH WITHDRAWAL|FEE|TAX|INTEREST/.test(type)) {
      cash.push({ time, currency, amount: total, description: type });
    } else {
      skipped++;
    }
  }

  cash.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const balance: Record<string, number> = {};
  const bank = cash.map(m => {
    balance[m.currency] = round((balance[m.currency] ?? 0) + m.amount);
    return {
      tx_date: new Date(Date.parse(m.time)).toISOString(), currency: m.currency, amount: m.amount,
      description: m.description, balance_after: balance[m.currency], external_id: `${m.time}:${m.description}:${m.amount}`,
    };
  });
  return { trades, bank, balance, skipped };
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
    if (!parsed) return json({ error: 'Not a Revolut brokerage (Invest) account statement' }, 400);

    const trades = parsed.trades.map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null, external_source: SOURCE,
    }));
    if (bank.length) {
      const { error } = await supabase.from('bank_transactions').upsert(bank, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    if (trades.length) {
      const { error } = await supabase.from('trades').upsert(trades, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, trades);

    const holdings: Record<string, number> = {};
    for (const t of trades) {
      if (t.side === 'buy') holdings[t.ticker] = round((holdings[t.ticker] ?? 0) + t.quantity);
      if (t.side === 'sell') holdings[t.ticker] = round((holdings[t.ticker] ?? 0) - t.quantity);
    }
    return json({
      trades: trades.filter(t => t.side !== 'dividend').length, dividends: trades.filter(t => t.side === 'dividend').length,
      cash_rows: bank.length, skipped: parsed.skipped, removed_snowball_duplicates: removedSnowball,
      holdings, cash: parsed.balance,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
