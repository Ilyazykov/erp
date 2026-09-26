// Supabase Edge Function: import-sber-broker
//
// Imports a Sber broker report, HTML ("Отчет брокера за период с ... по ...",
// СберБанк Онлайн -> Инвестиции -> счёт -> Отчёты и справки; one file per
// month). Each table follows a title paragraph ("<br>Title</br>"):
//   "Сводная информация по движению денежных средств" -- opening / closing
//     cash per currency;
//   "Портфель Ценных Бумаг" -- per security: quantity at the start / end;
//   "Движение денежных средств за период" -- every money operation;
//   "Сделки купли/продажи ценных бумаг" -- deals;
//   "Справочник Ценных Бумаг" -- name -> code (SBER, SU29008RMFS8, a bond's
//     ISIN -- the tickers Snowball uses) and ISIN.
// Written, with account 'Sber':
//   trades (external_source 'sber_broker_html')
//     - deals: buy / sell, price as reported (a bond's in % of nominal), NKD,
//       fee_tax = broker + exchange commission;
//     - payouts from the money table, matched to a security by the name in
//       the description: "Выплата купонов <name>" / "Выплата дивидендов
//       <name>" / "Зачисление д/с (купон по <name>)" -> 'dividend',
//       "(амортизация <name>)" -> 'amortisation', "(погашение <name>)" ->
//       'repayment' (quantity = the amount, Snowball's shape);
//     - one adjusting row where a security's start + deals doesn't reach its
//       reported end quantity (a redemption "Погашение ЦБ", a transfer) --
//       price 0, dated the period end.
//   bank_transactions (external_source 'sber_broker_html:<agreement>') -- the
//     money operations with a running balance from the period's opening;
//     booked_at keeps the report's row order.
// Each report also leaves one balance_snapshot row per currency at its period
// end (amount 0, balance = the reported closing balance, note naming the
// period) -- the record of which months are covered.
// Statement over Snowball (_shared/statement_priority.ts): a monthly report
// covers the account for its whole period, so every Snowball row of account
// 'Sber' dated within any covered month, for a security any Sber report
// knows, is removed (re-checked on every upload, so the order months are
// uploaded in doesn't matter) --
// Snowball's hand-entered Sber history has wrong dates / quantities that
// wouldn't match operation by operation (an OZON buy a month off, 12 SBER
// that were 10 + 2) -- plus any matched row outside it. import-trades-csv
// leaves such rows out of later uploads.
// Upserted by content, so months can be uploaded in any order, repeatedly.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { removeCoveredSnowball, removeSnowballInPeriod } from '../_shared/statement_priority.ts';

const ACCOUNT = 'Sber';
const SOURCE = 'sber_broker_html';

const text = (s: string) => s.replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&sup2;/g, '').replace(/\s+/g, ' ').trim();
const num = (s?: string) => { const n = Number((s || '').replace(/[\s ]/g, '').replace(/,/g, '.').replace(/^\+/, '')); return Number.isFinite(n) ? n : 0; };
const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
const iso = (s?: string) => { const m = (s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// Tables with the title paragraph before each.
function tables(htmlDoc: string) {
  const out: { title: string; rows: string[][] }[] = [];
  const re = /<table\b[\s\S]*?<\/table>/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(htmlDoc))) {
    const before = htmlDoc.slice(last, m.index);
    const titles = [...before.matchAll(/<br>([\s\S]*?)<\/br>/g)].map(t => text(t[1])).filter(Boolean);
    const rows = [...m[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(r => [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => text(c[1])));
    out.push({ title: titles[0] ?? '', rows });
    last = m.index + m[0].length;
  }
  return out;
}

function parse(doc: string) {
  // The header comes after a long <style> block, so strip that first.
  const head = text(doc.replace(/<style[\s\S]*?<\/style>/g, '').slice(0, 20000));
  const period = head.match(/Отчет брокера за период с (\d{2}\.\d{2}\.\d{4}) по (\d{2}\.\d{2}\.\d{4})/);
  // "Договор 422XX2Y от ..." / "Договор на ведение индивидуального
  // инвестиционного счета S23188F от ..." (an ИИС).
  const agreement = head.match(/Договор[^.]*?\s([A-Z0-9]{5,}) от \d{2}\.\d{2}\.\d{4}/)?.[1];
  if (!period || !agreement) return null;
  const periodStart = iso(period[1])!;
  const periodEnd = iso(period[2])!;
  const tbl = tables(doc);
  const find = (t: string) => tbl.filter(x => x.title.startsWith(t));

  // Directory: name -> { code, isin }
  const byName = new Map<string, { code: string; isin: string }>();
  const byIsin = new Map<string, string>();
  for (const t of find('Справочник Ценных Бумаг')) for (const r of t.rows) {
    if (r.length >= 3 && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(r[2])) { byName.set(r[0], { code: r[1], isin: r[2] }); byIsin.set(r[2], r[1]); }
  }

  // Opening / closing cash per currency.
  const opening: Record<string, number> = {};
  const closing: Record<string, number> = {};
  for (const t of find('Сводная информация по движению денежных средств')) for (const r of t.rows) {
    if (r[0] === 'Входящий остаток') opening[r[2]] = (opening[r[2]] ?? 0) + num(r[1]);
    if (r[0] === 'Исходящий остаток') closing[r[2]] = (closing[r[2]] ?? 0) + num(r[1]);
  }

  // Start / end quantities.
  const startQty = new Map<string, number>();
  const endQty = new Map<string, number>();
  for (const t of find('Портфель Ценных Бумаг')) for (const r of t.rows) {
    if (r.length < 13 || !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(r[1])) continue;
    startQty.set(r[1], (startQty.get(r[1]) ?? 0) + num(r[3]));
    endQty.set(r[1], (endQty.get(r[1]) ?? 0) + num(r[8]));
    if (!byIsin.has(r[1])) { byIsin.set(r[1], r[1]); byName.set(r[0], { code: r[1], isin: r[1] }); }
  }
  // A deal may name a security by its ISIN (OFZ 29007: "RU000A0JV4M0") where
  // the directory has its exchange code (SU29007RMFS0) -- use the code.
  const ticker = (code: string) => byIsin.get(code) ?? code;

  const trades = [];
  const netDeals = new Map<string, number>();
  const isinOfCode = (code: string) => [...byIsin].find(([, c]) => c === code)?.[0] ?? code;
  for (const t of find('Сделки купли/продажи ценных бумаг')) for (const r of t.rows) {
    const date = iso(r[0]);
    if (!date || r.length < 14 || !/^(Покупка|Продажа)$/.test(r[6])) continue;
    const qty = num(r[7]);
    const side = r[6] === 'Покупка' ? 'buy' : 'sell';
    // A deal concluded at a month's end settles in the next and is listed in
    // both reports; the portfolio table moves on settlement, so only deals
    // settling within this period count toward its quantity change.
    const settles = iso(r[1]) ?? date;
    if (settles >= periodStart && settles <= periodEnd) {
      const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(r[4]) && byIsin.has(r[4]) ? r[4] : isinOfCode(r[4]);
      netDeals.set(isin, (netDeals.get(isin) ?? 0) + (side === 'buy' ? qty : -qty));
    }
    trades.push({
      ticker: ticker(r[4]), side, quantity: qty, price: num(r[8]), trade_date: date, currency: r[5] || 'RUB',
      fee_tax: round(num(r[11]) + num(r[12]), 2), fee_currency: r[5] || 'RUB', nkd: num(r[10]) || null, exchange: 'MOEX',
      note: `${r[3]} (сделка ${r[13]}, ${r[2]})`, external_id: `${agreement}:deal:${r[13]}`,
    });
  }

  // Money operations, and payouts among them.
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const cashOps: { date: string; ccy: string; amount: number; description: string }[] = [];
  for (const t of find('Движение денежных средств за период')) for (const r of t.rows) {
    const date = iso(r[0]);
    if (!date || r.length < 6) continue;
    cashOps.push({ date, ccy: r[3], amount: round(num(r[4]) - num(r[5]), 2), description: r[2] });
  }
  const occ = new Map<string, number>();
  const uniq = (s: string) => { const n = occ.get(s) ?? 0; occ.set(s, n + 1); return n ? `${s}:dup${n}` : s; };
  for (const op of cashOps) {
    const d = op.description;
    const kind = /амортизац/i.test(d) ? 'amortisation' : /погашени/i.test(d) ? 'repayment'
      : /Выплата купонов|Выплата дивидендов|купон|^Дивиденды/i.test(d) ? 'dividend' : null;
    if (!kind || op.amount <= 0) continue;
    const isin = d.match(/ISIN ([A-Z0-9]{12})/)?.[1];
    const name = names.find(n => d.includes(n));
    const code = isin ? (byIsin.get(isin) ?? isin) : name ? byName.get(name)!.code : null;
    if (!code) continue;
    trades.push({
      ticker: ticker(code), side: kind, quantity: op.amount, price: op.amount, trade_date: op.date, currency: op.ccy,
      fee_tax: null, fee_currency: null, nkd: null, exchange: 'MOEX', note: d.slice(0, 500),
      external_id: uniq(`${agreement}:income:${op.date}:${code}:${op.amount}`),
    });
  }

  const adjustments = [];
  for (const [isin, end] of endQty) {
    const diff = round(end - (startQty.get(isin) ?? 0) - (netDeals.get(isin) ?? 0));
    if (Math.abs(diff) < 1e-9) continue;
    adjustments.push({
      ticker: ticker(byIsin.get(isin) ?? isin), side: diff > 0 ? 'buy' : 'sell', quantity: Math.abs(diff), price: 0,
      trade_date: periodEnd, currency: 'RUB', fee_tax: null, fee_currency: null, nkd: null, exchange: 'MOEX',
      note: 'Movement without a deal per the portfolio table (redemption / transfer); the report gives no date',
      external_id: `${agreement}:adjust:${isin}:${periodEnd}`,
    });
  }

  const balance: Record<string, number> = { ...opening };
  const lastBooked: Record<string, number> = {};
  const bank = cashOps.map(op => {
    balance[op.ccy] = round((balance[op.ccy] ?? 0) + op.amount, 2);
    const t = Math.max(Date.parse(`${op.date}T00:00:00Z`), (lastBooked[op.ccy] ?? -Infinity) + 1);
    lastBooked[op.ccy] = t;
    return {
      tx_date: `${op.date}T00:00:00Z`, booked_at: new Date(t).toISOString(), currency: op.ccy, amount: op.amount,
      description: op.description.slice(0, 500), balance_after: balance[op.ccy], synthetic: false,
      synthetic_kind: null as string | null, note: null as string | null,
      external_id: uniq(`${agreement}:cash:${op.ccy}:${op.date}:${op.description}:${op.amount}`),
    };
  });
  for (const ccy of Object.keys({ ...opening, ...closing })) {
    const t = Math.max(Date.parse(`${periodEnd}T23:59:59Z`), (lastBooked[ccy] ?? -Infinity) + 1);
    bank.push({
      tx_date: `${periodEnd}T23:59:59Z`, booked_at: new Date(t).toISOString(), currency: ccy, amount: 0,
      description: `Report period ${periodStart}..${periodEnd}: closing balance`, balance_after: closing[ccy] ?? 0,
      synthetic: true, synthetic_kind: 'balance_snapshot', note: `period ${periodStart}..${periodEnd}`,
      external_id: `${agreement}:period:${ccy}:${periodStart}`,
    });
  }
  const cash = Object.fromEntries(Object.keys({ ...opening, ...closing }).map(c => [c, { computed: balance[c] ?? 0, reported: closing[c] ?? 0 }]));
  const holdings = Object.fromEntries([...endQty].filter(([, q]) => q).map(([isin, q]) => [byIsin.get(isin) ?? isin, q]));
  const tickers = [...new Set([...byIsin.values(), ...trades.map(t => t.ticker)])];
  return { agreement, periodStart, periodEnd, tickers, trades, adjustments, bank, cash, holdings };
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
    if (!parsed) return json({ error: 'Not a Sber broker report (HTML)' }, 400);

    const all = [...parsed.trades, ...parsed.adjustments].map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    if (all.length) {
      const { error } = await supabase.from('trades').upsert(all, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null, external_source: `${SOURCE}:${parsed.agreement}`,
    }));
    if (bank.length) {
      const { error } = await supabase.from('bank_transactions').upsert(bank, { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    // Covered months and known securities across every Sber report stored.
    const { data: marks } = await supabase.from('bank_transactions').select('note')
      .like('external_source', `${SOURCE}:%`).eq('synthetic_kind', 'balance_snapshot');
    const periods = new Map<string, string>();
    for (const m of marks ?? []) {
      const p = String(m.note ?? '').match(/^period (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
      if (p) periods.set(p[1], p[2]);
    }
    const { data: known } = await supabase.from('trades').select('ticker').eq('external_source', SOURCE);
    const tickers = [...new Set([...parsed.tickers, ...(known ?? []).map((k: { ticker: string }) => k.ticker)])];
    let removedSnowball = 0;
    for (const [from, to] of periods) removedSnowball += await removeSnowballInPeriod(supabase, user.id, ACCOUNT, tickers, from, to);
    removedSnowball += await removeCoveredSnowball(supabase, user.id, parsed.trades);
    return json({
      agreement: parsed.agreement, period_start: parsed.periodStart,
      period_end: parsed.periodEnd,
      deals: parsed.trades.filter(t => t.side === 'buy' || t.side === 'sell').length,
      payouts: parsed.trades.filter(t => !['buy', 'sell'].includes(t.side)).length,
      adjustments: parsed.adjustments.length, cash_rows: bank.length, removed_snowball_duplicates: removedSnowball,
      holdings: parsed.holdings, cash: parsed.cash,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
