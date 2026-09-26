// Supabase Edge Function: import-tbank-broker
//
// Imports a T-Bank (Т-Инвестиции) broker report, .xlsx ("Отчет о сделках и
// операциях", one file per agreement -- the investor line names it:
// "ЗЫКОВ ... / <agreement> от <date>"). The sheets are a stack of numbered
// sections; each table's header row names its columns by the sheet column
// letters the data rows use too, so rows are read by letter.
//
// Written, all with account 'T-Bank':
//   trades (external_source 'tbank_broker_xlsx', external_id prefixed with
//   the agreement)
//     - 1.1 deals "Покупка" / "Продажа" in securities (REPO legs are skipped
//       -- a loan of the securities, not a change of holding; so are currency
//       deals, USD000UTSTOM & co -- their cash is in section 2): price,
//       quantity, NKD,
//       fee_tax = broker + exchange + clearing commission;
//     - section 2 "Выплата доходов по корпоративным действиям": dividend /
//       coupon -> side 'dividend' (quantity = the amount, price = "Выплата на
//       1 бумагу"), "Частичное погашение" -> 'amortisation', "Погашение в
//       уст. срок" -> 'repayment' -- matched to the security by the ISIN in
//       the comment;
//     - 3.1 "Движение по ценным бумагам": a security whose opening + net
//       deals differ from its reported closing balance (a transfer between
//       agreements, a code change, a redemption) gets one adjusting row for
//       the difference (price 0, dated the period end -- the report doesn't
//       date it), so the holding equals the report's closing balance. The
//       closing balance is trusted over the in / out columns, which a report
//       can get wrong (a closed 2020 agreement shows GAZP "in 0, out 10"
//       after a buy and a sell of 10).
//   bank_transactions (external_source 'tbank_broker_xlsx:<agreement>' --
//   one cash balance per agreement and currency): every section 2 operation,
//   running balance from the period's opening ("Входящий остаток"). Where the
//   operations don't add up to the reported closing balance (a closed
//   agreement's report leaves out the final transfer of what was left), one
//   balance_snapshot row after the currency's last operation sets the
//   balance to the reported one -- amount = the unlisted difference.
// Securities are keyed by ISIN; the ticker is the exchange code without
// T-Bank's "@..." suffix (TLCB@ -> TLCB), or the ISIN where there's no code
// (bonds -- as Snowball has them).
//
// Statement over Snowball (_shared/statement_priority.ts): the Snowball rows
// of the same deals / payouts are removed; import-trades-csv leaves them out.
// Everything is upserted by its own content, so a report can be re-uploaded.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { xlsxRows } from '../_shared/xlsx_rows.ts';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'T-Bank';
const SOURCE = 'tbank_broker_xlsx';
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

type Row = Record<string, string>;
const num = (s: string | undefined) => {
  const t = (s || '').replace(/\s/g, '').replace(/,/g, '');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : 0;
};
const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
// "13.07.2026" -> "2026-07-13"
const iso = (s: string | undefined) => {
  const m = (s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

function parse(bytes: Uint8Array) {
  const rows: Row[] = xlsxRows(bytes);
  const investor = rows.find(r => /^Инвестор:/.test(r.A || ''))?.A ?? '';
  const agreement = investor.match(/\/\s*(\S+)\s+от\s+(\d{2}\.\d{2}\.\d{4})/);
  const period = rows.find(r => /^Отчет о сделках и операциях за период/.test(r.A || ''))?.A
    ?.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
  if (!agreement || !period) return null;
  const agr = agreement[1];
  const periodEnd = iso(period[2])!;

  // Walk the sections; `hdr` maps column letter -> header of the table in effect.
  let sec = '';
  let hdr: Row | null = null;
  let cashCcy = '';
  const deals: Row[] = [];
  const cashOps: (Row & { ccy: string })[] = [];
  const cashSummary: Record<string, { open: number; close: number }> = {};
  const moves: Row[] = [];
  const instruments: Row[] = [];
  for (const r of rows) {
    const a = r.A || '';
    if (Object.keys(r).length === 1 && /^\d+(\.\d+)?\.? [А-ЯA-Z]/.test(a)) { sec = a.split(' ')[0].replace(/\.$/, ''); hdr = null; continue; }
    if (r.CB && /из/.test(r.CB)) continue;   // page footer "N из M"
    if (['Номер сделки', 'Наименование актива', 'Валюта', 'Дата', 'Номер', 'Номер комиссии', 'Код'].includes(a) && Object.keys(r).length > 2) {
      hdr = r; continue;
    }
    if (sec === '2' && Object.keys(r).length === 1 && /^[A-Z]{3}$/.test(a)) { cashCcy = a; continue; }
    if (!hdr) continue;
    const get = (name: string) => { const col = Object.keys(hdr!).find(k => hdr![k] === name); return col ? r[col] : undefined; };
    const named: Row = {};
    for (const [col, name] of Object.entries(hdr)) if (r[col] !== undefined) named[name] = r[col];
    if (sec === '1.1' && get('Вид сделки')) deals.push(named);
    else if (sec === '2' && hdr.A === 'Валюта' && /^[A-Z]{3}$/.test(a)) {
      cashSummary[a] = { open: num(get('Входящий остаток')), close: num(get('Исходящий остаток')) };
    } else if (sec === '2' && hdr.A === 'Дата' && get('Операция')) cashOps.push({ ...named, ccy: cashCcy });
    else if (sec === '3.1' && get('ISIN')) moves.push(named);
    else if (sec === '4.1' && get('ISIN')) instruments.push(named);
  }

  // Securities by ISIN, with the ticker to store.
  const isinOf = new Map<string, string>();
  const codes = new Map<string, Set<string>>();
  for (const x of [...moves, ...instruments]) {
    const code = x['Код актива'];
    const isin = x['ISIN'];
    if (!code || !isin) continue;
    isinOf.set(code, isin);
    codes.set(isin, (codes.get(isin) ?? new Set()).add(code));
  }
  const tickerOf = (isin: string) => {
    const cs = [...(codes.get(isin) ?? [])].filter(c => !ISIN.test(c));
    return cs.length ? cs.sort((p, q) => p.length - q.length)[0].replace(/@.*$/, '') : isin;
  };
  const isinOfCode = (code: string) => isinOf.get(code) ?? code;

  const trades = [];
  const netDeals = new Map<string, number>();
  for (const d of deals) {
    const kind = d['Вид сделки'];
    if (kind !== 'Покупка' && kind !== 'Продажа') continue;   // REPO legs
    const code = d['Код актива'];
    if (!code || (!isinOf.has(code) && !ISIN.test(code))) continue;   // currency deals (no ISIN)
    const date = iso(d['Дата заключения']);
    const qty = num(d['Количество']);
    if (!code || !date || !qty) continue;
    const isin = isinOfCode(code);
    netDeals.set(isin, (netDeals.get(isin) ?? 0) + (kind === 'Покупка' ? qty : -qty));
    trades.push({
      ticker: tickerOf(isin), side: kind === 'Покупка' ? 'buy' : 'sell', quantity: qty,
      price: num(d['Цена за единицу']), trade_date: date, currency: d['Валюта цены'] || d['Валюта расчетов'] || 'RUB',
      fee_tax: round(num(d['Комиссия брокера']) + num(d['Комиссия биржи']) + num(d['Комиссия клир. центра']), 2),
      fee_currency: d['Валюта комиссии'] || null, nkd: num(d['НКД']) || null,
      exchange: d['Торговая площадка'] || null, note: `${d['Наименование актива'] ?? ''} (сделка ${d['Номер сделки']})`,
      external_id: `${agr}:deal:${d['Номер сделки']}:${d['Время'] ?? ''}`,
    });
  }

  // Payouts from the cash section.
  const occ = new Map<string, number>();
  const uniq = (s: string) => { const n = occ.get(s) ?? 0; occ.set(s, n + 1); return n ? `${s}:dup${n}` : s; };
  for (const op of cashOps) {
    if (!/Выплата доходов по корпоративным действиям/.test(op['Операция'])) continue;
    const note = op['Примечание'] ?? '';
    const isin = note.match(/ISIN:\s*([A-Z0-9]{12})/)?.[1];
    const date = iso(op['Дата']) ?? iso(op['Дата исполнения']);
    const amount = num(op['Сумма зачисления']);
    if (!isin || !date || !amount) continue;
    const type = note.match(/Тип КД:\s*([^,]+)/)?.[1] ?? '';
    const side = /Частичное погашение/.test(type) ? 'amortisation' : /Погашение/.test(type) ? 'repayment' : 'dividend';
    const per = num(note.match(/Выплата на 1 бумагу:\s*([\d.]+)/)?.[1]);
    trades.push({
      ticker: tickerOf(isin), side, quantity: amount, price: per || amount, trade_date: date, currency: op.ccy,
      fee_tax: null, fee_currency: null, nkd: null, exchange: null, note: `${type}: ${note}`.slice(0, 500),
      external_id: uniq(`${agr}:income:${date}:${isin}:${amount}`),
    });
  }

  // Security movements without a deal (3.1 in - out vs net deals).
  const opening = new Map<string, number>();
  const closing = new Map<string, number>();
  for (const m of moves) {
    const isin = m['ISIN'];
    opening.set(isin, (opening.get(isin) ?? 0) + num(m['Входящий остаток']));
    closing.set(isin, (closing.get(isin) ?? 0) + num(m['Исходящий остаток']));
  }
  const adjustments = [];
  for (const [isin, close] of closing) {
    const diff = round(close - (opening.get(isin) ?? 0) - (netDeals.get(isin) ?? 0));
    if (Math.abs(diff) < 1e-9) continue;
    adjustments.push({
      ticker: tickerOf(isin), side: diff > 0 ? 'buy' : 'sell', quantity: Math.abs(diff), price: 0, trade_date: periodEnd,
      currency: 'RUB', fee_tax: null, fee_currency: null, nkd: null, exchange: null,
      note: 'Movement without a deal per report section 3.1 (transfer between agreements / code change / redemption); the report gives no date',
      external_id: `${agr}:adjust:${isin}`,
    });
  }

  // Cash, one running balance per currency.
  const balance: Record<string, number> = Object.fromEntries(Object.entries(cashSummary).map(([c, s]) => [c, s.open]));
  const seq = new Map<string, number>();
  const bank = cashOps.map(op => {
    const date = iso(op['Дата']) ?? iso(op['Дата исполнения'])!;
    const time = /^\d{2}:\d{2}:\d{2}$/.test(op['Время совершения'] ?? '') ? op['Время совершения'] : '00:00:00';
    const amount = round(num(op['Сумма зачисления']) - num(op['Сумма списания']), 2);
    balance[op.ccy] = round((balance[op.ccy] ?? 0) + amount, 2);
    const k = `${date}T${time}`;
    const n = seq.get(k) ?? 0; seq.set(k, n + 1);
    const description = `${op['Операция']}${op['Примечание'] ? `: ${op['Примечание']}` : ''}`.slice(0, 500);
    return {
      tx_date: new Date(Date.parse(`${k}Z`) + n).toISOString(), currency: op.ccy, amount, description,
      balance_after: balance[op.ccy], external_id: uniq(`${agr}:cash:${op.ccy}:${k}:${op['Операция']}:${amount}`),
    };
  }).filter(b => b.tx_date && b.currency);
  // Operations the report doesn't list (see header): close the gap.
  const snapshots: ((typeof bank)[number] & { synthetic: boolean; synthetic_kind: string; note: string })[] = [];
  for (const [ccy, s] of Object.entries(cashSummary)) {
    const computed = balance[ccy] ?? s.open;
    const gap = round(s.close - computed, 2);
    if (Math.abs(gap) < 0.005) continue;
    const last = bank.filter(b => b.currency === ccy).map(b => b.tx_date).sort().pop() ?? `${periodEnd}T00:00:00.000Z`;
    snapshots.push({
      tx_date: new Date(Date.parse(last) + 1000).toISOString(), currency: ccy, amount: gap,
      description: 'Balance per the report (operation not listed in it)', balance_after: s.close,
      synthetic: true, synthetic_kind: 'balance_snapshot',
      note: `The report's operations add up to ${computed} ${ccy}, its closing balance is ${s.close} ${ccy}; the difference (${gap}) was moved without a listed operation -- typically the transfer of what was left when an agreement was closed`,
      external_id: `${agr}:cash:${ccy}:closing-gap`,
    });
  }
  bank.push(...snapshots);
  const cashCheck = Object.fromEntries(Object.entries(cashSummary).map(([c, s]) =>
    [c, { computed: balance[c] ?? s.open, reported: s.close, unlisted: snapshots.find(x => x.currency === c)?.amount ?? 0 }]));
  const holdings = Object.fromEntries([...closing].filter(([, q]) => q).map(([isin, q]) => [tickerOf(isin), q]));
  return { agreement: agr, periodEnd, trades, adjustments, bank, cashCheck, holdings };
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
    if (!parsed) return json({ error: 'Not a T-Bank broker report' }, 400);

    const all = [...parsed.trades, ...parsed.adjustments]
      .map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    for (let i = 0; i < all.length; i += 500) {
      const { error } = await supabase.from('trades').upsert(all.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const bank = parsed.bank.map(b => ({
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null,
      external_source: `${SOURCE}:${parsed.agreement}`,
    }));
    for (let i = 0; i < bank.length; i += 500) {
      const { error } = await supabase.from('bank_transactions').upsert(bank.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, parsed.trades);

    return json({
      agreement: parsed.agreement,
      deals: parsed.trades.filter(t => t.side === 'buy' || t.side === 'sell').length,
      payouts: parsed.trades.filter(t => !['buy', 'sell'].includes(t.side)).length,
      adjustments: parsed.adjustments.length, cash_rows: bank.length,
      removed_snowball_duplicates: removedSnowball, holdings: parsed.holdings, cash: parsed.cashCheck,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
