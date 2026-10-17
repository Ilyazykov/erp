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
//       quantity, NKD, settle_date (the deal's cash settlement day),
//       fee_tax = broker + exchange + clearing commission;
//     - section 2 "Выплата доходов по корпоративным действиям": dividend /
//       coupon -> side 'dividend' (quantity = the amount, price = "Выплата на
//       1 бумагу"), "Частичное погашение" -> 'amortisation', "Погашение в
//       уст. срок" -> 'repayment' -- matched to the security by the ISIN in
//       the comment;
//     - 3.1 "Движение по ценным бумагам": each security's stored holding is
//       brought to the report's closing balance (a transfer between
//       agreements, a code change, a redemption) by reconciling rows dated
//       the period end -- against what's stored, under every ticker the
//       security sits under (reconcileHoldings), so reports can come in any
//       order and overlap. The
//       closing balance is trusted over the in / out columns, which a report
//       can get wrong (a closed 2020 agreement shows GAZP "in 0, out 10"
//       after a buy and a sell of 10). The report never lists a stock
//       split: when the period's splits (stock_splits, migration 034)
//       account for the whole difference -- the shares held the day before
//       each split times (ratio - 1) -- it's booked as one row per split on
//       the split day instead (AAPL 4:1 on 31.08.2020: 2 held -> +6).
//   bank_transactions (external_source 'tbank_broker_xlsx:<agreement>' --
//   one cash balance per agreement and currency): every section 2 operation,
//   running balance from the period's opening ("Входящий остаток"). Where the
//   operations don't add up to the reported closing balance (a closed
//   agreement's report leaves out the final transfer of what was left), one
//   balance_snapshot row after the currency's last operation sets the
//   balance to the reported one -- amount = the unlisted difference.
//   The running balance follows the report's own row order, which isn't
//   always the order of the rows' dates (a time on one row, a bare date on
//   the settlement row after it; a later-dated row listed first), so
//   booked_at carries that order -- strictly increasing per currency, never
//   before the row's own date -- and the latest balance is read by it
//   (migrations/20250101000025_bank_booked_at.sql).
// Blocked assets (user's rule: they count at zero): T-Bank keeps securities
// it can't trade (foreign shares, sanctioned funds) on a separate agreement
// that only ever received them by transfer -- every security it holds at the
// period end has no deal on it. Such an agreement's holdings are written as
// "BLOCKED:<ticker>", which update-market-prices prices at 0.
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
import { removeAppRows } from '../_shared/app_rows.ts';

const ACCOUNT = 'T-Bank';

// Holdings per security are brought to a report's closing balance against
// what's stored -- order-free, whatever reports were uploaded before:
//   - one reconciling row per security and ticker ('<agr>:adjust:<isin>' on
//     the security's ticker, '<agr>:adjust:<isin>:<ticker>' on another one it
//     sits under), dated the report's period end; a report whose period ends
//     before the stored reconciling rows leaves them (the later report holds);
//   - the security can sit under more than one ticker: a full report names
//     Volkswagen VOW3, a monthly one by its ISIN (DE0007664039) -- the deals of
//     the agreement booked under the security's name count too; all of it ends
//     on the one ticker, the others at zero.
// Before (a single '<agr>:adjust:<isin>' row from the report's own opening
// balance) a monthly report overwrote the full report's correction: -2
// DE0007664039 against +2 VOW3.
// deno-lint-ignore no-explicit-any
async function reconcileHoldings(db: any, userId: string, agr: string, periodEnd: string,
  items: { isin: string; close: number; name: string; primary: string; tickers: string[] }[]): Promise<number> {
  const stored: { external_id: string; ticker: string; side: string; quantity: number; trade_date: string; note: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('trades').select('external_id, ticker, side, quantity, trade_date, note')
      .eq('user_id', userId).eq('external_source', SOURCE).like('external_id', `${agr}:%`).order('external_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    stored.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const signed = (r: { side: string; quantity: number }) =>
    r.side === 'buy' || r.side === 'stock_as_dividend' ? Number(r.quantity) : r.side === 'sell' ? -Number(r.quantity) : 0;
  const rows = [];
  const drop: string[] = [];
  for (const it of items) {
    const prefix = `${agr}:adjust:${it.isin}`;
    const recon = stored.filter(r => r.external_id === prefix || r.external_id.startsWith(`${prefix}:`));
    if (recon.some(r => r.trade_date > periodEnd)) continue;   // a later report's
    const cand = new Set([it.primary, ...it.tickers, ...recon.map(r => r.ticker)]);
    if (it.name) for (const r of stored) if ((r.note ?? '').startsWith(`${it.name} (`)) cand.add(r.ticker);
    const qty = new Map<string, number>();
    for (const r of stored) {
      if (!cand.has(r.ticker) || recon.includes(r) || r.trade_date > periodEnd) continue;
      qty.set(r.ticker, Math.round(((qty.get(r.ticker) ?? 0) + signed(r)) * 1e8) / 1e8);
    }
    const keep = new Set<string>();
    for (const t of cand) {
      const need = Math.round(((t === it.primary ? it.close : 0) - (qty.get(t) ?? 0)) * 1e8) / 1e8;
      if (Math.abs(need) < 1e-9) continue;
      const id = t === it.primary ? prefix : `${prefix}:${t}`;
      keep.add(id);
      rows.push({
        user_id: userId, account: ACCOUNT, external_source: SOURCE, external_id: id,
        ticker: t, side: need > 0 ? 'buy' : 'sell', quantity: Math.abs(need), price: 0, trade_date: periodEnd,
        currency: 'RUB', fee_tax: null, fee_currency: null, nkd: null, exchange: null,
        note: t === it.primary
          ? `Movement without a deal per report section 3.1 (transfer between agreements / code change / redemption), holding brought to the report's closing ${it.close}; the report gives no date`
          : `${it.name || it.isin} held under ${it.primary}: moved off this ticker`,
      });
    }
    for (const r of recon) if (!keep.has(r.external_id)) drop.push(r.external_id);
  }
  if (rows.length) {
    const { error } = await db.from('trades').upsert(rows, { onConflict: 'user_id,external_source,external_id' });
    if (error) throw new Error(error.message);
  }
  for (let i = 0; i < drop.length; i += 200) {
    const { error } = await db.from('trades').delete().eq('user_id', userId).eq('external_source', SOURCE).in('external_id', drop.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
const SOURCE = 'tbank_broker_xlsx';
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

type Row = Record<string, string>;
const num = (s: string | undefined) => {
  const t = (s || '').replace(/\s/g, '').replace(/,/g, '');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : 0;
};
const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
const settleDate = (cell?: string) => {
  const [plan, fact] = String(cell ?? '').split('/').map(x => iso(x.trim()));
  return fact ?? plan ?? null;
};
// "13.07.2026" -> "2026-07-13"
const iso = (s: string | undefined) => {
  const m = (s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

type Split = { day: string; ratio: number };

function parse(bytes: Uint8Array, splits: Map<string, Split[]>) {
  const rows: Row[] = xlsxRows(bytes);
  const investor = rows.find(r => /^Инвестор:/.test(r.A || ''))?.A ?? '';
  const agreement = investor.match(/\/\s*(\S+)\s+от\s+(\d{2}\.\d{2}\.\d{4})/);
  const period = rows.find(r => /^Отчет о сделках и операциях за период/.test(r.A || ''))?.A
    ?.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
  if (!agreement || !period) return null;
  const agr = agreement[1];
  const periodStart = iso(period[1])!;
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
  const dealLog = new Map<string, { date: string; qty: number }[]>();
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
    dealLog.set(isin, [...(dealLog.get(isin) ?? []), { date, qty: kind === 'Покупка' ? qty : -qty }]);
    trades.push({
      ticker: tickerOf(isin), side: kind === 'Покупка' ? 'buy' : 'sell', quantity: qty,
      price: num(d['Цена за единицу']), trade_date: date,
      // "Дата расчетов план/факт" -- "10.01.2022 / 10.01.2022": the cash moves
      // then (section 2 books it on that date), the fact over the plan.
      settle_date: settleDate(d['Дата расчетов план/факт']),
      currency: d['Валюта цены'] || d['Валюта расчетов'] || 'RUB',
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
  const held = [...closing].filter(([, q]) => Math.abs(q) > 1e-9).map(([isin]) => isin);
  const blockedAgreement = held.length > 0 && held.every(isin => Math.abs(netDeals.get(isin) ?? 0) < 1e-9);
  const heldTicker = (isin: string) => blockedAgreement && held.includes(isin) ? `BLOCKED:${tickerOf(isin)}` : tickerOf(isin);
  const adjustments = [];
  const staleAdjustIds: string[] = [];
  for (const [isin, close] of closing) {
    const diff = round(close - (opening.get(isin) ?? 0) - (netDeals.get(isin) ?? 0));
    if (Math.abs(diff) < 1e-9) continue;
    // Splits in the period that account for all of it: one row per split.
    const inPeriod = (splits.get(tickerOf(isin)) ?? [])
      .filter(x => x.day > periodStart && x.day <= periodEnd).sort((p, q) => p.day.localeCompare(q.day));
    if (inPeriod.length) {
      let added = 0;
      const rows = inPeriod.map(x => {
        const before = (opening.get(isin) ?? 0) + added
          + (dealLog.get(isin) ?? []).filter(d => d.date < x.day).reduce((a, d) => a + d.qty, 0);
        const qty = round(before * (x.ratio - 1));
        added = round(added + qty);
        const label = x.ratio >= 1 ? `${x.ratio}:1` : `1:${round(1 / x.ratio, 4)}`;
        return {
          ticker: heldTicker(isin), side: qty > 0 ? 'buy' : 'sell', quantity: Math.abs(qty), price: 0, trade_date: x.day,
          currency: 'RUB', fee_tax: null, fee_currency: null, nkd: null, exchange: null,
          note: `Stock split ${label}: ${round(before)} held -> ${round(before + qty)} (not listed in the report; its closing balance includes it)`,
          external_id: `${agr}:split:${isin}:${x.day}`,
        };
      }).filter(r => r.quantity > 0);
      if (Math.abs(added - diff) < 1e-6) {
        adjustments.push(...rows);
        staleAdjustIds.push(`${agr}:adjust:${isin}`);   // booked at the period end by an earlier upload
        continue;
      }
    }
  }
  // Every security of section 3.1 is brought to the report's closing balance
  // against what's stored (reconcileHoldings, after the deals are in).
  const nameOf = new Map(moves.map(m => [m['ISIN'], m['Наименование актива'] ?? '']));
  const reconcile = [...closing].map(([isin, close]) => ({
    isin, close: round(close), name: nameOf.get(isin) ?? '', primary: heldTicker(isin), tickers: [tickerOf(isin), isin],
  }));

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
  // booked_at: the report's row order, per currency (see header).
  const lastBooked: Record<string, number> = {};
  for (const b of bank as ((typeof bank)[number] & { booked_at?: string })[]) {
    const t = Math.max(Date.parse(b.tx_date), (lastBooked[b.currency] ?? -Infinity) + 1);
    lastBooked[b.currency] = t;
    b.booked_at = new Date(t).toISOString();
  }
  const cashCheck = Object.fromEntries(Object.entries(cashSummary).map(([c, s]) =>
    [c, { computed: balance[c] ?? s.open, reported: s.close, unlisted: snapshots.find(x => x.currency === c)?.amount ?? 0 }]));
  const holdings = Object.fromEntries([...closing].filter(([, q]) => q).map(([isin, q]) => [heldTicker(isin), q]));
  return { blocked: blockedAgreement, agreement: agr, periodStart, periodEnd, trades, adjustments, staleAdjustIds, reconcile, bank, cashCheck, holdings };
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

    const splits = new Map<string, Split[]>();
    const { data: splitRows } = await supabase.from('stock_splits').select('ticker, day, ratio');
    for (const r of splitRows ?? []) splits.set(r.ticker, [...(splits.get(r.ticker) ?? []), { day: r.day, ratio: Number(r.ratio) }]);
    const parsed = parse(new Uint8Array(await req.arrayBuffer()), splits);
    if (!parsed) return json({ error: 'Not a T-Bank broker report' }, 400);

    const all = [...parsed.trades, ...parsed.adjustments]
      .map(t => ({ ...t, user_id: user.id, account: ACCOUNT, external_source: SOURCE }));
    for (let i = 0; i < all.length; i += 500) {
      const { error } = await supabase.from('trades').upsert(all.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    if (parsed.staleAdjustIds.length) {
      const { error } = await supabase.from('trades').delete()
        .eq('user_id', user.id).eq('external_source', SOURCE).in('external_id', parsed.staleAdjustIds);
      if (error) return json({ error: error.message }, 500);
    }
    const reconciled = await reconcileHoldings(supabase, user.id, parsed.agreement, parsed.periodEnd, parsed.reconcile);
    // Every row carries every column: a bulk upsert takes the union of the
    // rows' keys, and a missing one would be sent as null (synthetic is NOT
    // NULL -- only the closing-gap rows set it).
    const bank = parsed.bank.map(b => ({
      synthetic: false, synthetic_kind: null, note: null,
      ...b, user_id: user.id, account: ACCOUNT, counterparty: null, category: null,
      external_source: `${SOURCE}:${parsed.agreement}`,
    }));
    for (let i = 0; i < bank.length; i += 500) {
      const { error } = await supabase.from('bank_transactions').upsert(bank.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) return json({ error: error.message }, 500);
    }
    const removedSnowball = await removeCoveredSnowball(supabase, user.id, parsed.trades);
    // rows taken from the app's history before this report (_shared/app_rows.ts)
    const removedApp = await removeAppRows(supabase, user.id, ACCOUNT, parsed.agreement, parsed.periodStart, parsed.periodEnd);

    return json({
      agreement: parsed.agreement, period_start: parsed.periodStart, period_end: parsed.periodEnd,
      deals: parsed.trades.filter(t => t.side === 'buy' || t.side === 'sell').length,
      payouts: parsed.trades.filter(t => !['buy', 'sell'].includes(t.side)).length,
      adjustments: parsed.adjustments.length + reconciled,
      splits: parsed.adjustments.filter(a => a.external_id.includes(':split:')).map(a => `${a.ticker} ${a.trade_date}: ${a.side} ${a.quantity}`),
      cash_rows: bank.length,
      removed_snowball_duplicates: removedSnowball, removed_app_rows: removedApp, holdings: parsed.holdings, cash: parsed.cashCheck,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
