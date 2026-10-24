// Supabase Edge Function: sync-tbank
//
// Pulls T-Bank's broker accounts through the T-Invest API, so no one has to
// download the broker report (import-tbank-broker) every week. A read-only
// token (T-Investments -> settings -> T-Invest API tokens -> "Только для
// чтения") is entered on the page (My portfolio -> T-Bank broker automatic
// sync) into broker_credentials (migration ...104), in Supabase Vault. Every
// account must answer ACCOUNT_ACCESS_LEVEL_READ_ONLY -- a token that can
// trade is refused, nothing is pulled.
//
// T-Bank's certificate chains to the Russian Trusted Root CA, which isn't in
// the usual trust stores: it's trusted by the one HTTP client made for the
// API (_shared/tinvest.ts, _shared/russian_root_ca.ts), nowhere else.
//
// The API takes the place of the rows taken from the app's screenshots
// (_shared/app_rows.ts): for each open account (= agreement) the days after
// its latest broker report -- or from its opening, without one:
//   - trades 'tbank_api', external_id '<agreement>:...' -- each exchange
//     deal of an executed order as the report has it ('<agreement>:deal:<num>',
//     a bond's price in % of its face, the broker's fee on the first fill),
//     payouts ('<agreement>:income:<day>:<isin>:<amount>': coupon / dividend
//     -> 'dividend', partial redemption -> 'amortisation', full ->
//     'repayment'); securities moved in / out (between agreements, to the
//     blocked-assets one) aren't written -- within T-Bank the two sides cancel
//     out, a blocked one is the report's to book -- just listed in the result;
//   - money 'tbank_api:<agreement>', one row per operation (a currency deal
//     also gets its other currency's leg), the running balance from 0 on top
//     of the report's -- as the app rows had it.
// The app rows of those days go; a report uploaded later takes its period
// back from these (removeAppRows). Every run rebuilds the account's rows.
// The ЦФА account ("Цифровой счет", type DFA) the same way, under the Atomyze
// wallet the ЦФА are already kept by (its reports, the app rows), "CFA:<code>"
// tickers; a redemption closes the holding (a sell at 0 next to the
// repayment), as the app rows did.
//
// Before anything is written the API is checked against the latest report:
// the month before its end, every deal of the report must come back by its
// number with the same quantity and price, every payout with its amount.
// Else nothing is replaced and the differences come back -- the API read
// differently from the report shows as an error, not as wrong rows.
//
// Two ways in, as the other syncs: the page's Save ({"check": true}: only
// the token and its accounts) / "Sync now" (the user's JWT), or the daily
// pg_cron job with the cron secret (_shared/cron_auth.ts). Each run's result
// is kept in broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';
import { removeAppRows, reportPeriods } from '../_shared/app_rows.ts';
import { money, tinvest } from '../_shared/tinvest.ts';

const ACCOUNT = 'T-Bank';
const SOURCE = 'tbank_api';
const CHECK_DAYS = 31;
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
// The daily job's slots: 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// T-Invest's answers that mean the token itself is no good -- not retried the same day.
const KEY_REFUSED = /T-Invest (16|40003)\b|not read-only/;

const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
// The API's UTC -> Moscow wall-clock labelled UTC, as the reports' times are kept.
const msk = (iso: string) => new Date(Date.parse(iso) + 3 * 3600000).toISOString();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const exchangeOf = (classCode: string) => /^(TQ|EQ|PS|SM)/.test(classCode) ? 'ММВБ' : /^SPB/.test(classCode) ? 'СПБ' : null;

type Inst = { ticker: string; isin: string; name: string; type: string; classCode: string; nominal: number; iso: string };
// deno-lint-ignore no-explicit-any
type Op = any;
type CashRow = { tx_date: string; currency: string; amount: number; description: string; external_id: string };
type TradeRow = {
  ticker: string; side: string; quantity: number; price: number; trade_date: string; settle_date: null;
  currency: string; fee_tax: number | null; fee_currency: string | null; nkd: number | null; exchange: string | null;
  note: string; external_id: string;
};

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, token: string, checkOnly: boolean) {
  const { accounts = [] } = await tinvest(token, 'UsersService/GetAccounts', {});
  // deno-lint-ignore no-explicit-any
  const full = accounts.filter((a: any) => a.accessLevel === 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS');
  if (full.length) throw new Error(`The token is not read-only (full access to ${full.map((a: { id: string }) => a.id).join(', ')}) -- create a read-only one; nothing was pulled`);
  // deno-lint-ignore no-explicit-any
  const list = accounts.map((a: any) => ({ id: a.id, type: String(a.type ?? '').replace('ACCOUNT_TYPE_', ''), name: a.name, status: String(a.status ?? '').replace('ACCOUNT_STATUS_', ''), access: String(a.accessLevel ?? '').replace('ACCOUNT_ACCESS_LEVEL_', '') }));
  if (checkOnly) return { accounts: list };

  // Instruments, once each.
  const insts = new Map<string, Inst>();
  const instOf = async (uid: string): Promise<Inst> => {
    if (insts.has(uid)) return insts.get(uid)!;
    const { instrument: i } = await tinvest(token, 'InstrumentsService/GetInstrumentBy', { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid });
    const inst: Inst = { ticker: i.ticker ?? '', isin: i.isin ?? '', name: i.name ?? '', type: i.instrumentType ?? '', classCode: i.classCode ?? '', nominal: 0, iso: '' };
    if (inst.type === 'bond') inst.nominal = money((await tinvest(token, 'InstrumentsService/BondBy', { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid })).instrument?.nominal);
    if (inst.type === 'currency') inst.iso = String((await tinvest(token, 'InstrumentsService/CurrencyBy', { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid })).instrument?.isoCurrencyName ?? '').toUpperCase();
    insts.set(uid, inst);
    return inst;
  };
  // the report's ticker: the exchange code without "@...", the ISIN where the code is one (bonds)
  // (a ЦФА: "CFA:" + its code, as the Atomyze reports have it)
  const tickerOf = (i: Inst) => {
    if (/dfa/i.test(i.type)) return `CFA:${i.ticker}`;
    const c = i.ticker.replace(/@.*$/, ''); return !c || ISIN.test(c) ? (i.isin || c) : c;
  };

  const results = [];
  const allTrades: TradeRow[] = [];
  // notes on accounts left out (a ЦФА account with more than one Atomyze wallet)
  const dfa: string[] = [];
  for (const acc of list) {
    const isDfa = acc.type === 'DFA';
    if (!(['TINKOFF', 'TINKOFF_IIS', 'INVEST_BOX'].includes(acc.type) || isDfa) || acc.status !== 'OPEN' || acc.access !== 'READ_ONLY') continue;
    // The key the rows go under: the agreement -- for the ЦФА account ("Цифровой
    // счет"), the Atomyze wallet the ЦФА are kept by (its reports, the app rows).
    let agr = acc.id;
    if (isDfa) {
      const { data: w, error: wErr } = await db.from('bank_transactions').select('external_source')
        .eq('user_id', userId).like('external_source', 'atomyze_xlsx:%').limit(5000);
      if (wErr) throw new Error(wErr.message);
      const wallets = [...new Set((w ?? []).map((r: { external_source: string }) => r.external_source.slice('atomyze_xlsx:'.length)))] as string[];
      if (wallets.length > 1) { dfa.push(`${acc.id}: ${wallets.length} Atomyze wallets -- which one it is isn't known, not synced`); continue; }
      if (wallets.length === 1) agr = wallets[0];
    }
    const lastEnd = (await reportPeriods(db, userId, ACCOUNT, agr)).map(([, t]) => t).sort().pop() ?? null;
    const opened = accounts.find((a: { id: string }) => a.id === acc.id)?.openedDate;
    const from = lastEnd ? addDays(lastEnd, 1) : msk(opened ?? new Date().toISOString()).slice(0, 10);
    const checkFrom = lastEnd ? addDays(lastEnd, -CHECK_DAYS) : null;
    // The name a security already goes by on this agreement: the report keeps a
    // fund bought from its manager off the exchange by its ISIN (TMON as
    // RU000A106DL2), so the API's rows stay on the same holding.
    const { data: usedRows, error: uErr } = await db.from('trades').select('ticker').eq('user_id', userId).eq('account', ACCOUNT)
      .in('external_source', ['tbank_broker_xlsx', 'broker_csv']).like('external_id', `${agr}:%`).limit(10000);
    if (uErr) throw new Error(uErr.message);
    const used = new Set((usedRows ?? []).map((r: { ticker: string }) => r.ticker));
    const tickerFor = (i: Inst) => { const d = tickerOf(i); return !used.has(d) && i.isin && used.has(i.isin) ? i.isin : d; };
    const pullFrom = checkFrom ?? from;

    // Every executed operation since then (Moscow midnight = 21:00 UTC the day before).
    const ops: Op[] = [];
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const r = await tinvest(token, 'OperationsService/GetOperationsByCursor', {
        accountId: acc.id, from: new Date(Date.parse(`${pullFrom}T00:00:00Z`) - 3 * 3600000).toISOString(), to: new Date().toISOString(),
        limit: 1000, state: 'OPERATION_STATE_EXECUTED', withoutCommissions: false, withoutTrades: false, withoutOvernights: false,
        ...(cursor ? { cursor } : {}),
      });
      ops.push(...(r.items ?? []));
      cursor = r.nextCursor ?? '';
      if (!r.hasNext || !cursor) break;
    }
    ops.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // The broker's fee of each order, by the order.
    const feeOf = new Map<string, { sum: number; ccy: string }>();
    for (const op of ops) if (op.type === 'OPERATION_TYPE_BROKER_FEE' && op.parentOperationId) {
      const f = feeOf.get(op.parentOperationId) ?? { sum: 0, ccy: String(op.payment?.currency ?? '').toUpperCase() };
      f.sum = round(f.sum + Math.abs(money(op.payment)), 2);
      feeOf.set(op.parentOperationId, f);
    }

    const cash: CashRow[] = [];
    const trades: TradeRow[] = [];
    // A security's holding on this agreement before a day -- the stored rows
    // (the reports', the app's) and this run's: a payout's amount per security
    // and a redemption's quantity, where the API leaves them out.
    const storedOf = new Map<string, { side: string; quantity: number; trade_date: string }[]>();
    const heldBefore = async (ticker: string, day: string) => {
      if (!storedOf.has(ticker)) {
        const { data, error } = await db.from('trades').select('external_source, external_id, side, quantity, trade_date')
          .eq('user_id', userId).eq('account', ACCOUNT).eq('ticker', ticker).in('external_source', ['tbank_broker_xlsx', 'broker_csv', 'atomyze_xlsx']);
        if (error) throw new Error(error.message);
        // (not the app rows these replace)
        storedOf.set(ticker, (data ?? []).filter((r: { external_source: string; external_id: string; trade_date: string }) =>
          (r.external_id.startsWith(`${agr}:`) || (isDfa && r.external_source === 'atomyze_xlsx'))
          && !(r.external_source === 'broker_csv' && r.trade_date >= from)));
      }
      let q = 0;
      for (const r of [...storedOf.get(ticker)!, ...trades.filter(x => x.ticker === ticker)]) {
        if (r.trade_date >= day) continue;
        q += r.side === 'buy' || r.side === 'stock_as_dividend' ? Number(r.quantity) : r.side === 'sell' ? -Number(r.quantity) : 0;
      }
      return round(q);
    };
    const odd: string[] = [];
    // securities moved in / out (between agreements, to the blocked-assets one):
    // no money moves -- the payment the API shows is the securities' value --
    // and no holding change written: within T-Bank the two sides cancel out,
    // and a move to the blocked-assets agreement is the report's to book
    // (BLOCKED:<ticker>); listed in the result
    const moves: string[] = [];
    const isMove = (op: Op, t: string) => /SECURITIES/.test(t) || /^Перевод \d+ (акци|лот|облигац|па[яиё]|бумаг|ценн)/i.test(String(op.description || op.name || ''));
    const seen = new Map<string, number>();
    const uniq = (s: string) => { const n = seen.get(s) ?? 0; seen.set(s, n + 1); return n ? `${s}:dup${n}` : s; };
    for (const op of ops) {
      const t = String(op.type ?? '');
      const at = msk(op.date);
      const day = at.slice(0, 10);
      const amount = round(money(op.payment), 2);
      const ccy = String(op.payment?.currency ?? '').toUpperCase();
      if (isMove(op, t)) { moves.push(`${day} ${op.description || op.name || t}`); continue; }
      if (amount && ccy) cash.push({ tx_date: at, currency: ccy, amount, external_id: uniq(`${agr}:op:${op.id}`),
        description: `${op.name || t}${op.description ? `: ${op.description}` : ''}`.slice(0, 500) });
      const uid = op.instrumentUid;
      const buy = /_BUY(_CARD|_MARGIN)?$|DELIVERY_BUY/.test(t), sell = /_SELL(_CARD|_MARGIN)?$|DELIVERY_SELL/.test(t);
      if ((buy || sell) && uid) {
        const inst = await instOf(uid);
        const qtyAll = Number(op.quantityDone || op.quantity || 0);
        if (inst.type === 'currency') {
          // the bought / sold currency's own leg (the payment is the other one)
          if (!/^[A-Z]{3}$/.test(inst.iso) || !qtyAll) { odd.push(`${day} ${t} ${inst.ticker} ${qtyAll}`); continue; }
          cash.push({ tx_date: at, currency: inst.iso, amount: buy ? qtyAll : -qtyAll, external_id: uniq(`${agr}:op:${op.id}:${inst.iso}`),
            description: `${op.name || t}: ${inst.name}` });
          continue;
        }
        const fills = op.tradesInfo?.trades?.length ? op.tradesInfo.trades : [{ num: op.id, date: op.date, quantity: qtyAll, price: op.price }];
        const fee = feeOf.get(op.id);
        fills.forEach((f: Op, i: number) => {
          const p = money(f.price);
          trades.push({
            ticker: tickerFor(inst), side: buy ? 'buy' : 'sell', quantity: Number(f.quantity), settle_date: null,
            price: round(inst.type === 'bond' && inst.nominal ? p / inst.nominal * 100 : p, 6), trade_date: msk(f.date ?? op.date).slice(0, 10),
            currency: ccy || 'RUB', fee_tax: i === 0 && fee ? fee.sum : null, fee_currency: i === 0 && fee ? fee.ccy : null,
            nkd: i === 0 ? (round(Math.abs(money(op.accruedInt)), 2) || null) : null, exchange: exchangeOf(inst.classCode || op.classCode || ''),
            note: `${inst.name} (сделка ${f.num})`, external_id: `${agr}:deal:${f.num}`,
          });
        });
        continue;
      }
      const payout = t === 'OPERATION_TYPE_DIVIDEND' || t === 'OPERATION_TYPE_COUPON' || t === 'OPERATION_TYPE_DIV_EXT' ? 'dividend'
        : t === 'OPERATION_TYPE_BOND_REPAYMENT' ? 'amortisation' : t === 'OPERATION_TYPE_BOND_REPAYMENT_FULL' ? 'repayment' : null;
      if (payout && uid && amount) {
        const inst = await instOf(uid);
        const ticker = tickerFor(inst);
        const q = Number(op.quantity || 0) || await heldBefore(ticker, addDays(day, 1));
        trades.push({
          ticker, side: payout, quantity: amount, price: q > 0 ? round(amount / q, 6) : amount, trade_date: day, settle_date: null,
          currency: ccy, fee_tax: null, fee_currency: null, nkd: null, exchange: null,
          note: `${op.name || t}: ${inst.name}${op.description ? ` -- ${op.description}` : ''}`.slice(0, 500),
          external_id: uniq(`${agr}:income:${day}:${inst.isin || ticker}:${amount}`),
        });
        // redeemed at maturity: the holding goes (the money is the repayment row)
        if (payout === 'repayment' && q > 0) trades.push({
          ticker, side: 'sell', quantity: q, price: 0, trade_date: day, settle_date: null,
          currency: ccy, fee_tax: null, fee_currency: null, nkd: null, exchange: null,
          note: `${inst.name} redeemed at maturity: position closed (the money is in the repayment row)`,
          external_id: uniq(`${agr}:redeemed:${day}:${inst.isin || ticker}`),
        });
        continue;
      }
    }

    // The check against the latest report (the month before its end).
    const checked: Record<string, unknown> = {};
    if (lastEnd && checkFrom) {
      // the agreement's broker report, or the ЦФА wallet's Atomyze report
      let sq = db.from('trades').select('external_id, ticker, side, quantity, price, trade_date')
        .eq('user_id', userId).eq('external_source', isDfa ? 'atomyze_xlsx' : 'tbank_broker_xlsx')
        .gte('trade_date', checkFrom).lte('trade_date', lastEnd);
      if (!isDfa) sq = sq.like('external_id', `${agr}:%`);
      const { data: stored, error } = await sq;
      if (error) throw new Error(error.message);
      const diffs: string[] = [];
      const inWindow = trades.filter(r => r.trade_date >= checkFrom && r.trade_date <= lastEnd);
      const apiDeals = new Map(inWindow.filter(r => r.external_id.includes(':deal:')).map(r => [r.external_id.split(':')[2], r]));
      const storedDeals = (stored ?? []).filter((s: { external_id: string; side: string; price: number }) =>
        (s.side === 'buy' || s.side === 'sell') && Number(s.price) > 0 && /(^|:)deal:/.test(s.external_id));
      // by the deal's number; a deal off the exchange (the report's number isn't
      // the API's) by its day, side, quantity and security
      const matchedNums = new Set<string>();
      for (const s of storedDeals) {
        let a = apiDeals.get(s.external_id.split(':')[2]);
        if (!a) {
          const hit = [...apiDeals].find(([num, x]) => !matchedNums.has(num) && !storedDeals.some((z: { external_id: string }) => z.external_id.split(':')[2] === num)
            && x.trade_date === s.trade_date && x.side === s.side && Math.abs(x.quantity - Number(s.quantity)) < 1e-9 && x.ticker === s.ticker);
          if (hit) { matchedNums.add(hit[0]); a = hit[1]; }
        }
        if (!a) { diffs.push(`deal ${s.external_id} (${s.ticker} ${s.side} ${s.quantity}) not in the API`); continue; }
        if (a.side !== s.side || Math.abs(a.quantity - Number(s.quantity)) > 1e-9 || Math.abs(a.price - Number(s.price)) > Math.max(0.011, Number(s.price) * 0.005))
          diffs.push(`deal ${s.external_id}: API ${a.ticker} ${a.side} ${a.quantity} @ ${a.price}, report ${s.ticker} ${s.side} ${s.quantity} @ ${s.price}`);
      }
      const storedNums = new Set(storedDeals.map((s: { external_id: string }) => s.external_id.split(':')[2]));
      for (const [num, a] of apiDeals) if (!storedNums.has(num) && !matchedNums.has(num)) diffs.push(`API deal ${num} (${a.trade_date} ${a.ticker} ${a.side} ${a.quantity}) not in the report`);
      const isPayout = (side: string) => side === 'dividend' || side === 'amortisation' || side === 'repayment';
      const storedIncome = (stored ?? []).filter((s: { side: string }) => isPayout(s.side));
      const apiIncome = inWindow.filter(r => isPayout(r.side));
      for (const s of storedIncome) {
        const ok = apiIncome.some(a => Math.abs(a.quantity - Number(s.quantity)) < 0.011
          && Math.abs(Date.parse(a.trade_date) - Date.parse(s.trade_date)) <= 4 * 86400000);
        if (!ok) diffs.push(`payout ${s.external_id} (${s.ticker} ${s.quantity}) not in the API`);
      }
      if (diffs.length) throw new Error(`Not understood on ${agr} -- nothing replaced. ${diffs.length} differences against the report ${checkFrom}..${lastEnd}: ${diffs.slice(0, 8).join('; ')}`);
      Object.assign(checked, { deals: storedDeals.length, payouts: storedIncome.length, window: `${checkFrom}..${lastEnd}` });
    }
    if (odd.length) throw new Error(`Not understood on ${agr} -- nothing replaced: ${odd.slice(0, 8).join('; ')}`);

    results.push({ agr, from, lastEnd, cash: cash.filter(c => c.tx_date.slice(0, 10) >= from), trades: trades.filter(r => r.trade_date >= from), checked,
      moves: moves.filter(m => m.slice(0, 10) >= from) });
  }

  // All accounts understood: replace.
  const summary = [];
  for (const r of results) {
    await removeAppRows(db, userId, ACCOUNT, r.agr, r.from, '9999-12-31');
    const { error: dT } = await db.from('trades').delete().eq('user_id', userId).eq('external_source', SOURCE).like('external_id', `${r.agr}:%`);
    if (dT) throw new Error(dT.message);
    const bal: Record<string, number> = {};
    const seq = new Map<string, number>();
    const bank = r.cash.sort((a, b) => a.tx_date.localeCompare(b.tx_date)).map(c => {
      bal[c.currency] = round((bal[c.currency] ?? 0) + c.amount, 2);
      const n = seq.get(c.tx_date) ?? 0; seq.set(c.tx_date, n + 1);
      return { ...c, tx_date: new Date(Date.parse(c.tx_date) + n).toISOString(), balance_after: bal[c.currency],
        user_id: userId, account: ACCOUNT, counterparty: null, category: null, synthetic: false, synthetic_kind: null, note: null,
        external_source: `${SOURCE}:${r.agr}` };
    });
    for (let i = 0; i < bank.length; i += 500) {
      const { error } = await db.from('bank_transactions').upsert(bank.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) throw new Error(error.message);
    }
    const rows = r.trades.map(t => ({ ...t, user_id: userId, account: ACCOUNT, external_source: SOURCE }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('trades').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
      if (error) throw new Error(error.message);
    }
    allTrades.push(...r.trades);
    summary.push({ agreement: r.agr, from: r.from, after_report: r.lastEnd, deals: r.trades.filter(t => t.external_id.includes(':deal:')).length,
      payouts: r.trades.filter(t => t.external_id.includes(':income:')).length, cash_rows: bank.length, cash_change: bal, checked: r.checked,
      ...(r.moves.length ? { securities_moved: r.moves } : {}) });
  }
  const removedSnowball = await removeCoveredSnowball(db, userId, allTrades);
  const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
  if (rq) throw new Error(rq.message);
  // the day of the run as the page counts days (UTC), not the Moscow one
  return { period_to: new Date().toISOString().slice(0, 10), accounts: list, synced: summary, removed_snowball_duplicates: removedSnowball, ...(dfa.length ? { dfa } : {}) };
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
    const url = Deno.env.get('SUPABASE_URL')!;
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // The signed-in user (from the page), or -- the daily job -- everyone.
    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      userId = (await asUser.auth.getUser()).data.user?.id ?? null;
    }
    // Without a user: only the daily job, with the cron secret.
    if (!userId && !(await fromCron(req))) return notFromCron();

    let q = db.rpc('tbank_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; token: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No T-Bank token: enter it on the page (My portfolio -> T-Bank broker automatic sync)' }, 400);
    }
    // The page's Save: the token and its accounts, nothing pulled.
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        return json(await syncUser(db, userId, picked[0].token, true));
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't synced today; a
    // failed run is retried by the next, but not a token T-Invest refuses.
    const nowSlot = Math.floor((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() - SLOT_START_MIN) / SLOT_MINUTES);
    if (!userId) {
      const today = new Date().toISOString().slice(0, 10);
      const syncedToday = (c: Cred) => !!c.last_sync_at && c.last_sync_at.slice(0, 10) >= today
        && (!(c.last_sync_result || '').startsWith('{"error"') || KEY_REFUSED.test(c.last_sync_result || ''));
      picked = picked.filter(c => slotOf(c.user_id) <= nowSlot && !syncedToday(c))
        .sort((a, b) => slotOf(a.user_id) - slotOf(b.user_id)).slice(0, RUN_USERS);
      if (!picked.length) return json({ users: 0, slot: nowSlot });
    }

    const results = [];
    for (const c of picked) {
      let result: Record<string, unknown>;
      try {
        result = await syncUser(db, c.user_id, c.token, false);
      } catch (err) {
        result = { error: String(err) };
      }
      // kept whole -- cut JSON wouldn't read back; the long lists go first
      let kept = JSON.stringify(result);
      if (kept.length > 4000) kept = JSON.stringify({ ...result, accounts: undefined, synced: (result.synced as unknown[] | undefined)?.length });
      if (kept.length > 4000) kept = JSON.stringify(result.error ? { error: String(result.error).slice(0, 3800) } : { period_to: result.period_to });
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: kept })
        .eq('user_id', c.user_id).eq('broker', 'tbank');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
