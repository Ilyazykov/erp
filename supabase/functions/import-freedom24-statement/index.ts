// Supabase Edge Function: import-freedom24-statement
//
// Imports Freedom24's (Tradernet) cash-movement report, .xlsx
// (tradernet_table.xlsx; one sheet, newest first):
//   Операция № | Дата | Операция | Комментарий | Сумма | Валюта
// Дата is an Excel serial (the broker's own clock, kept as is). Операция is
// "Банковский перевод" (deposit), "Сделка" (a trade's cash leg, or one leg of
// a currency conversion), "Комиссия за сделки" (commission, always EUR),
// "Дивиденды", "Налоги". Операция № is the broker's own id -- the dedup key.
//
// Written, all with account 'Freedom24':
//   bank_transactions (external_source 'freedom24_xlsx') -- every row, with a
//     running balance per currency from zero: the report has no opening
//     balance, so it must cover the account from its opening (the checked
//     one does: 2026-05-04 .. -- EUR 2.69, USD 0.21 at the end);
//   trades (same source)
//     - "Купить / Продать N TICKER.MKT (сделка №ID)": buy / sell, ticker
//       without the market suffix, price = |amount| / N, fee_tax = the
//       commission row naming that trade ("(Trade ID ...)"), in EUR;
//     - "Дивиденды": side 'dividend', quantity = the amount, price = "Per
//       security" -- Snowball's DIVIDEND shape.
// Shares credited without money (the welcome gift SNAP, WMT) aren't in the
// cash report at all. They come from the broker report instead (Кабинет ->
// Отчеты брокера, downloaded as JSON: <client>_<from>_<to>_all.json): its
// securities_in_outs rows are written as stock_as_dividend at price 0
// (external_id 'in_out:<id>'); nothing else is taken from it, the cash
// report already has the trades, money and dividends. The statement has
// priority over
// Snowball's rows of the same operations (_shared/statement_priority.ts):
// those are deleted, and import-trades-csv leaves them out of later uploads.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'Freedom24';
const SOURCE = 'freedom24_xlsx';
const EXCHANGE_BY_MARKET: Record<string, string> = { EU: 'XETRA' };

const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
// Excel serial (days since 1899-12-30) -> "2026-05-04T21:47:27.000Z".
const fromSerial = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? new Date(Math.round((n - 25569) * 86_400_000 / 1000) * 1000).toISOString() : null;
};

// Broker report JSON -> shares credited / debited without money.
function parseBrokerReport(text: string) {
  let d: any;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || !Array.isArray(d.securities_in_outs) || !d.plainAccountInfoData) return null;
  const trades = [];
  let skipped = 0;
  for (const x of d.securities_in_outs) {
    const qty = Number(x.quantity);
    const m = String(x.ticker || '').match(/^([A-Z0-9.\-]+?)\.([A-Z]+)$/);
    const date = String(x.datetime || '').slice(0, 10);
    if (!m || !qty || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(x.reverted)) { skipped++; continue; }
    if (qty < 0 || !/award|gift|bonus|promo/i.test(`${x.type} ${x.comment}`)) { skipped++; continue; }
    trades.push({
      ticker: m[1], side: 'stock_as_dividend', quantity: qty, price: 0, trade_date: date,
      currency: x.balance_currency || 'USD', fee_tax: null, fee_currency: null,
      exchange: EXCHANGE_BY_MARKET[m[2]] ?? null,
      note: `${x.type}:${String(x.comment || '').trim()} (market value ${x.market_value} ${x.balance_currency || ''})`.slice(0, 500),
      external_id: `in_out:${x.id}`,
    });
  }
  return { trades, skipped };
}

function parse(bytes: Uint8Array) {
  const wb = XLSX.read(bytes, { type: 'array' });
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const head = (grid[0] ?? []).map(c => String(c ?? '').trim());
  const col = (n: string) => head.indexOf(n);
  const [cId, cDate, cOp, cComment, cAmount, cCcy] = ['Операция №', 'Дата', 'Операция', 'Комментарий', 'Сумма', 'Валюта'].map(col);
  if ([cId, cDate, cOp, cComment, cAmount, cCcy].some(i => i < 0)) return null;

  const rows = grid.slice(1).map(r => ({
    id: String(r[cId] ?? '').trim(), time: fromSerial(r[cDate]), op: String(r[cOp] ?? '').trim(),
    comment: String(r[cComment] ?? '').trim(), amount: Number(r[cAmount]), currency: String(r[cCcy] ?? '').trim(),
  })).filter(r => r.id && r.time && Number.isFinite(r.amount) && r.currency);
  rows.reverse();   // oldest first (the sheet is newest first; same-second rows keep their order)

  const commission = new Map<string, number>();   // trade id -> EUR commission
  for (const r of rows) {
    const id = /Комиссия/i.test(r.op) ? r.comment.match(/\(Trade (\d+) /)?.[1] : undefined;
    if (id) commission.set(id, (commission.get(id) ?? 0) + Math.abs(r.amount));
  }

  const balance: Record<string, number> = {};
  const seenTime = new Map<string, number>();
  const bank = rows.map(r => {
    balance[r.currency] = round((balance[r.currency] ?? 0) + r.amount);
    const n = seenTime.get(r.time!) ?? 0; seenTime.set(r.time!, n + 1);
    return {
      tx_date: new Date(Date.parse(r.time!) + n).toISOString(), currency: r.currency, amount: r.amount,
      description: `${r.op}: ${r.comment}`.slice(0, 500), balance_after: balance[r.currency], external_id: r.id,
    };
  });

  const trades = [];
  for (const r of rows) {
    const date = r.time!.slice(0, 10);
    const t = r.op === 'Сделка' ? r.comment.match(/(Купить|Продать) ([\d.]+) ([A-Z0-9.\-]+?)\.([A-Z]+) \(сделка [№#](\d+)\)/) : null;
    if (t) {
      const qty = Number(t[2]);
      trades.push({
        ticker: t[3], side: t[1] === 'Купить' ? 'buy' : 'sell', quantity: qty, price: round(Math.abs(r.amount) / qty, 6),
        trade_date: date, currency: r.currency, fee_tax: commission.get(t[5]) ?? null, fee_currency: 'EUR',
        exchange: EXCHANGE_BY_MARKET[t[4]] ?? null, note: r.comment, external_id: `trade:${t[5]}`,
      });
    }
    const d = r.op === 'Дивиденды' ? r.comment.match(/\(([A-Z0-9.\-]+?)\.[A-Z]+\)\)/) : null;
    if (d) {
      const per = r.comment.match(/Per security ([\d.]+)/)?.[1];
      trades.push({
        ticker: d[1], side: 'dividend', quantity: r.amount, price: per ? Number(per) : r.amount,
        trade_date: date, currency: r.currency, fee_tax: null, fee_currency: null,
        exchange: null, note: r.comment, external_id: `dividend:${r.id}`,
      });
    }
  }
  return { bank, trades, balance };
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

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes[0] === 0x7b) {   // "{" -- the broker report JSON
      const report = parseBrokerReport(new TextDecoder().decode(bytes));
      if (!report) return json({ error: 'Not a Freedom24 broker report (JSON)' }, 400);
      const gifts = report.trades.map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
      if (gifts.length) {
        const { error } = await supabase.from('trades').upsert(gifts, { onConflict: 'user_id,external_source,external_id' });
        if (error) return json({ error: error.message }, 500);
      }
      const removed = await removeCoveredSnowball(supabase, user.id, gifts);
      return json({ report: 'broker_json', securities_credited: gifts.map(g => `${g.quantity} ${g.ticker} (${g.trade_date})`),
        skipped: report.skipped, removed_snowball_duplicates: removed });
    }
    const parsed = parse(bytes);
    if (!parsed) return json({ error: 'Not a Freedom24 (Tradernet) cash-movement report' }, 400);

    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null, external_source: SOURCE,
    }));
    const trades = parsed.trades.map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    if (bank.length) {
      const { error } = await supabase.from('bank_transactions').upsert(bank, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    if (trades.length) {
      const { error } = await supabase.from('trades').upsert(trades, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, trades);

    return json({
      trades: trades.filter(t => t.side !== 'dividend').length,
      dividends: trades.filter(t => t.side === 'dividend').length,
      cash_rows: bank.length,
      removed_snowball_duplicates: removedSnowball,
      cash: parsed.balance,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
