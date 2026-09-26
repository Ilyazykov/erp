// Supabase Edge Function: import-atomyze
//
// Imports an Atomyze (ООО «Атомайз», digital financial assets / ЦФА --
// T-Bank's "Цифровой счёт") platform report, .xlsx ("Отчет оператора
// информационной системы ... Отчет платформы за период ... по кошельку ..."),
// normally reached through import-xlsx. Three tables, each after its title:
//   "Остатки и позиции"  -- per ЦФА: ticker, closing balance, nominal;
//   "Сделки за период"   -- buys / sells: quantity, price, platform fee;
//   "Операции с денежными средствами" -- the wallet's money, with its own
//     running balance ("Остаток, руб.").
// Written, with account 'T-Bank':
//   trades (external_source 'atomyze_xlsx') -- ticker "CFA:<ticker>", so
//     update-market-prices prices it at its nominal (a ЦФА has no market);
//     deals -> buy / sell; "Периодическая выплата по ЦФА (<ticker>)" ->
//     'dividend' (quantity = the amount), "Погашение" -> 'repayment'; and,
//     like import-tbank-broker, one adjusting row where deals don't reach
//     the reported closing balance (a redemption) -- price 0, period end;
//   bank_transactions (external_source 'atomyze_xlsx:<wallet>') -- every
//     money operation with the report's own balance; booked_at keeps the
//     report's order (a tax and a withdrawal share one timestamp).
// Statement over Snowball: Snowball rows of the same operations are removed
// (_shared/statement_priority.ts). Upserted by content -- safe to re-upload.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { xlsxRows, type XlsxRow } from '../_shared/xlsx_rows.ts';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'T-Bank';
const SOURCE = 'atomyze_xlsx';
const num = (s?: string) => { const n = Number((s || '').replace(/\s/g, '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;

function parse(bytes: Uint8Array) {
  const rows = xlsxRows(bytes);
  const text = rows.slice(0, 12).map(r => Object.values(r).join(' ')).join('\n');
  if (!/Атомайз/.test(text) || !/Отчет платформы/.test(text)) return null;
  const wallet = rows.find(r => /^по кошельку/.test(r.A || ''))?.E;
  const periodRow = rows.find(r => r.A === 'с' && r.C === 'по');
  const periodEnd = (periodRow?.D || '').split('.').reverse().join('-');
  if (!wallet || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return null;

  let section = '';
  let hdr: XlsxRow | null = null;
  const positions: Record<string, string>[] = [];
  const deals: Record<string, string>[] = [];
  const cash: Record<string, string>[] = [];
  let opening = 0;
  let closing: number | null = null;
  for (const r of rows) {
    const a = r.A || '';
    if (['Остатки и позиции', 'Сделки за период', 'Операции с денежными средствами'].includes(a)) { section = a; hdr = null; continue; }
    if (/^Входящий остаток/.test(a)) { opening = num(r.C); continue; }
    if (/^Исходящий остаток/.test(a)) { closing = num(r.C); continue; }
    if (a === '№ п/п') { hdr = r; continue; }
    if (!hdr || !/^\d+$/.test(a)) continue;
    const named: Record<string, string> = {};
    for (const [col, name] of Object.entries(hdr)) if (r[col] !== undefined) named[name] = r[col];
    if (section === 'Остатки и позиции') positions.push(named);
    else if (section === 'Сделки за период') deals.push(named);
    else if (section === 'Операции с денежными средствами') cash.push(named);
  }

  const ticker = (t: string) => `CFA:${t}`;
  const trades = [];
  const net = new Map<string, number>();
  for (const d of deals) {
    const t = d['Тикер ЦФА'];
    const qty = num(d['Количество ЦФА, шт.']);
    const side = /Покупка/i.test(d['Тип сделки']) ? 'buy' : /Продажа/i.test(d['Тип сделки']) ? 'sell' : null;
    const date = (d['Дата и время заключения сделки'] || '').slice(0, 10);
    if (!t || !qty || !side || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    net.set(t, (net.get(t) ?? 0) + (side === 'buy' ? qty : -qty));
    trades.push({
      ticker: ticker(t), side, quantity: qty, price: num(d['Цена за 1 ЦФА, руб']), trade_date: date, currency: 'RUB',
      fee_tax: num(d['Комиссия платформы, руб.']) || null, fee_currency: 'RUB', nkd: null, exchange: 'Atomyze',
      note: `${d['Наименование выпуска']} (${d['Тип сделки']}, ${d['Дата и время заключения сделки']})`,
      external_id: `deal:${d['Дата и время заключения сделки']}:${t}:${side}:${qty}`,
    });
  }
  const held = new Map(positions.map(p => [p['Тикер'], num(p['Количество ЦФА, шт.'] ?? p['Остаток на конец периода'])]));
  for (const c of cash) {
    const type = c['Тип операции'] || '';
    const t = type.match(/\(([^,)]+)/)?.[1]?.trim();
    const credit = num(c['Зачисление, руб.']);
    const date = (c['Дата и время'] || '').slice(0, 10);
    if (!t || !credit || !/выплата|погашение/i.test(type)) continue;
    const side = /погашение/i.test(type) ? 'repayment' : 'dividend';
    const qty = held.get(t) || net.get(t) || 0;
    trades.push({
      ticker: ticker(t), side, quantity: credit, price: qty ? round(credit / qty, 6) : credit, trade_date: date, currency: 'RUB',
      fee_tax: null, fee_currency: null, nkd: null, exchange: 'Atomyze', note: type,
      external_id: `payout:${c['Дата и время']}:${t}:${credit}`,
    });
  }
  const adjustments = [];
  for (const p of positions) {
    const t = p['Тикер'];
    const diff = round(num(p['Остаток на конец периода']) - num(p['Остаток на начало периода']) - (net.get(t) ?? 0));
    if (Math.abs(diff) < 1e-9) continue;
    adjustments.push({
      ticker: ticker(t), side: diff > 0 ? 'buy' : 'sell', quantity: Math.abs(diff), price: 0, trade_date: periodEnd,
      currency: 'RUB', fee_tax: null, fee_currency: null, nkd: null, exchange: 'Atomyze',
      note: 'Movement without a deal per the positions table (e.g. redemption); the report gives no date',
      external_id: `adjust:${t}:${periodEnd}`,
    });
  }

  let last = -Infinity;
  const occ = new Map<string, number>();
  const bank = cash.map(c => {
    const when = (c['Дата и время'] || '').replace(' ', 'T');
    const t = Math.max(Date.parse(`${when}Z`), last + 1);
    last = t;
    const amount = round(num(c['Зачисление, руб.']) - num(c['Списание, руб.']), 2);
    const sig = `${when}:${c['Тип операции']}:${amount}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    return {
      tx_date: `${when}Z`, booked_at: new Date(t).toISOString(), currency: 'RUB', amount,
      description: `${c['Тип операции'] || ''}${c['Комментарий'] ? `: ${c['Комментарий']}` : ''}`.slice(0, 500),
      balance_after: num(c['Остаток, руб.']), synthetic: false, synthetic_kind: null, note: null,
      external_id: n ? `${sig}:dup${n}` : sig,
    };
  });
  const holdings = Object.fromEntries(positions.map(p => [p['Тикер'], num(p['Остаток на конец периода'])]));
  return { wallet, trades, adjustments, bank, holdings, cash: { opening, closing, last: bank.at(-1)?.balance_after ?? opening } };
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

    const parsed = parse(new Uint8Array(await req.arrayBuffer()));
    if (!parsed) return json({ error: 'Not an Atomyze platform report' }, 400);

    const all = [...parsed.trades, ...parsed.adjustments].map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    if (all.length) {
      const { error } = await supabase.from('trades').upsert(all, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null, external_source: `${SOURCE}:${parsed.wallet}`,
    }));
    if (bank.length) {
      const { error } = await supabase.from('bank_transactions').upsert(bank, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, parsed.trades);
    return json({
      deals: parsed.trades.filter(t => t.side === 'buy' || t.side === 'sell').length,
      payouts: parsed.trades.filter(t => !['buy', 'sell'].includes(t.side)).length,
      adjustments: parsed.adjustments.length, cash_rows: bank.length, removed_snowball_duplicates: removedSnowball,
      holdings: parsed.holdings, cash: parsed.cash,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
