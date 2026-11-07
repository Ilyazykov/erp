// Supabase Edge Function: import-bank-csv
//
// Parses this project's own flat bank-transaction CSV -- the shape PDF-only
// banks' statements get extracted into, out of band (Yandex Bank, T-Bank:
// neither offers a CSV export) -- and inserts the rows into
// `bank_transactions`, same destination table and shape as
// import-raiffeisen-statement / import-boc-statement. Unlike those, one
// importer serves several banks: the bank's display name travels in the
// CSV's own `bank` column instead of being hardcoded here.
//
// CSV shape (this project's own, not a bank export):
//   bank,account_number,product,currency,date,time,card,description,amount,
//   balance[,amount_orig_value,amount_orig_currency],source_file
// Dates are ISO (YYYY-MM-DD); time is Moscow wall-clock HH:MM (or HH:MM:SS,
// e.g. Ozon -- two rows can share a minute) where the
// statement gives one (Yandex's Save deposit statement doesn't). amount is
// already signed in the account currency (positive = credit, negative =
// debit), matching `bank_transactions.amount`'s convention. balance is the
// per-account running balance after that row -- negative for a credit
// card's outstanding debt, so the card correctly counts against the
// bank's total in the broker pivot tables. Extra columns (e.g. the
// original foreign-currency amount) are ignored, except an optional
// `category_bank` (the bank's own category label, e.g. Sber's "Transfer via
// FPS" / "Супермаркеты"), which is fed to the keyword categorizer alongside
// the description, and optional `synthetic_kind` / `data_gap_until` / `note`
// for bookkeeping rows that aren't real transactions: synthetic_kind
// 'data_gap' (statements run out -- the row zeroes the balance, nothing is
// known until data_gap_until), 'account_closed' (closure mark, amount 0) or
// 'balance_snapshot' (a counted balance with no statement behind it -- cash
// on hand, bank 'cash': balance = the count, amount = change since the
// previous count) or 'extrapolated' (spending that left no trace, filled in
// from a per-day norm). Stored as bank_transactions.synthetic / synthetic_kind /
// data_gap_until (see migrations ...010, ...011, ...023 and ...050), explanation in
// `note`. An optional `amount_approximate` column (true/yes/1) marks a real
// transaction whose amount is only an estimate -- stored as
// bank_transactions.amount_approximate (migration ...049).
//
// `bank` becomes the `account` label, so every account at one bank
// collapses into a single row in the broker pivot tables (same idea as
// Raiffeisen's two accounts sharing "Raiffeisen"). balance_after is the
// per-account CSV balance, and external_source is per account
// ('t_bank_csv:<account_number>') -- that's what lets the cash-balance view
// (mpFetchCashRows in index.html) take the latest balance per
// (account, currency, external_source) and sum those, so two same-currency
// accounts at one bank (T-Bank debit + credit card, Yandex current + Save)
// can be uploaded as separate CSVs and still both count.
//
// tx_date carries the Moscow wall-clock time labelled as UTC (same "keep
// the calendar date intact" choice as the other importers' T00:00:00Z).
// Untimed rows get 00:00:SS with SS = row order within the day -- that
// keeps them ordered among themselves and ahead of every timed row that
// day, so the day's last row really is the latest by tx_date.
//
// The dedup key is (account_number, date, time, description, amount) with
// the same occurrence-counter tie-breaker as the other importers for
// legitimate same-minute duplicates.
//
// Savings accounts and term deposits (product 'savings_account' -- T-Bank's
// накопительный счёт, Yandex's "Сейв", Alfa's "Альфа-Счёт на ежедневный
// остаток"; 'term_deposit' -- Sber's вклады) are not cash
// and don't go to `bank_transactions` at all. They're written to `trades`
// the way import-revolut-deposit-statement writes Revolut Instant Access
// Savings: synthetic ticker "SAVINGS:<bank> <currency>" for a savings
// account (withdrawable any time without loss) or "DEPOSIT:<bank>
// <currency>" for a term deposit, deposit or interest -> buy, withdrawal ->
// sell, quantity = the amount itself, price 1 -- so they show up as asset
// class 'savings' / 'deposit' (priced via FX by update-market-prices)
// instead of in the cash column.
//
// An optional `deposit_name` column (e.g. "16% 31.10.2025" -- rate and
// opening date) is appended to that ticker, so each deposit is a holding of
// its own ("DEPOSIT:T-Bank RUB 16% 31.10.2025") and deposits at one bank
// don't merge into one line -- their rates stay comparable.
//
// A deposit Snowball used to track by hand under its own ticker (e.g.
// "DEPOSIT:Т16%13") names that ticker in the optional `replaces_snowball`
// column: the statement has priority (first-hand source), so those Snowball
// rows are deleted, and the deposit trades carry "[replaces Snowball
// <ticker>]" in their note, which import-trades-csv reads to leave that
// ticker out of later Snowball uploads.
//
// Every other row keeps its CSV `product` in bank_transactions.product, so
// the cash view can put a credit card's balance in its own 'credit' column.

import { reportPeriods } from '../_shared/app_rows.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

interface BankRow {
  bank: string;
  accountNumber: string;
  product: string;
  categoryBank: string;
  syntheticKind: string | null;
  dataGapUntil: string | null;
  note: string;
  amountApproximate: boolean;
  replacesSnowball: string;
  depositName: string;
  date: string;
  time: string;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
}

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

function parseNumber(s: string): number | null {
  const t = (s || '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

function parseRows(text: string): BankRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);

  let idx: {
    bank: number; accountNumber: number; product: number; categoryBank: number;
    syntheticKind: number; dataGapUntil: number; note: number; amountApproximate: number; replacesSnowball: number; depositName: number; date: number; time: number; description: number;
    amount: number; currency: number; balance: number;
  } | null = null;
  const rows: BankRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (!idx) {
      const header = cells.map(h => h.trim());
      if (header[0] === 'bank' && header[1] === 'account_number' && header[2] === 'product') {
        const col = (name: string) => header.indexOf(name);
        idx = {
          bank: col('bank'), accountNumber: col('account_number'), product: col('product'),
          categoryBank: col('category_bank'), syntheticKind: col('synthetic_kind'),
          dataGapUntil: col('data_gap_until'), note: col('note'), amountApproximate: col('amount_approximate'), replacesSnowball: col('replaces_snowball'), depositName: col('deposit_name'),
          date: col('date'), time: col('time'),
          description: col('description'), amount: col('amount'), currency: col('currency'),
          balance: col('balance'),
        };
      }
      continue;
    }

    const date = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    const amount = parseNumber(cells[idx.amount] || '');
    const bank = (cells[idx.bank] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || amount === null || !bank) continue;

    const time = (cells[idx.time] || '').trim();
    rows.push({
      bank,
      product: (cells[idx.product] || '').trim(),
      categoryBank: idx.categoryBank >= 0 ? (cells[idx.categoryBank] || '').trim() : '',
      syntheticKind: idx.syntheticKind >= 0 ? (cells[idx.syntheticKind] || '').trim() || null : null,
      dataGapUntil: idx.dataGapUntil >= 0 ? (cells[idx.dataGapUntil] || '').trim() || null : null,
      note: idx.note >= 0 ? (cells[idx.note] || '').trim() : '',
      amountApproximate: idx.amountApproximate >= 0 && /^(true|yes|1)$/i.test((cells[idx.amountApproximate] || '').trim()),
      replacesSnowball: idx.replacesSnowball >= 0 ? (cells[idx.replacesSnowball] || '').trim() : '',
      depositName: idx.depositName >= 0 ? (cells[idx.depositName] || '').trim() : '',
      accountNumber: (cells[idx.accountNumber] || '').trim(),
      date,
      time: /^\d{2}:\d{2}(:\d{2})?$/.test(time) ? time : '',
      description,
      amount,
      currency: (cells[idx.currency] || '').trim(),
      balance: parseNumber(cells[idx.balance] || ''),
    });
  }
  return rows;
}

// Best-effort keyword categorization, same style/purpose as the other
// importers' CATEGORY_RULES.
const CATEGORY_RULES: [RegExp, string][] = [
  [/^currency exchange\b/i, 'fx_conversion'],
  [/капитализация процентов|выплата процентов|interest on the balance/i, 'interest'],
  [/перевод между счетами одного клиента|внутрибанковский перевод между счетами|intrabank transfer from contract|internal transfer to contract|transfer between (your|own) accounts/i, 'internal_transfer'],
  [/перевод сбп|систем\S* быстрых платежей|external bank transfer|via fps|перевод (на|с) карт|(inbound|outbound) card transfer/i, 'transfer'],
  [/transfer fee/i, 'bank_fee'],
  [/taxi|siticard|metro|aeroexpress|rzd|russian\s+railways|^транспорт$|\btransport\b/i, 'transport'],
  [/delivery club|lavka|samokat|eda\.yandex|wolt/i, 'food_delivery'],
  [/pyaterochka|perekrestok|magnit|vkusvill|lenta|супермаркет|supermarket/i, 'groceries'],
  [/yandex\*\d+\*plus/i, 'utilities_or_shopping'],
];

const DEPOSIT_PRODUCTS = new Set(['savings_account', 'term_deposit']);
// TBC dates a card payment by the day it's booked, 1-3 days after it was made;
// the day it was made is in the description ("POS - SPAR, 29.78 GEL, Oct 30
// 2026 12:00AM, ...") -- kept as authorized_on, which the capital and the
// expenses count it from (as sync-openbanking does for Bank of Cyprus).
const TBC_MADE_RE = /, (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{4}) \d{1,2}:\d{2}[AP]M,/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function madeOn(bank: string, description: string, date: string): string | null {
  if (bank !== 'TBC Bank') return null;
  const m = description.match(TBC_MADE_RE);
  if (!m) return null;
  const day = `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return day < date ? day : null;
}
// A card payment still held in the bank's app, not in its statement yet,
// goes in by hand as account_number 'pending' (source '<bank>_csv:pending',
// its own running balance: the holds' sum, below zero). Once a statement
// brings the payment -- same amount and currency, made the day the hold is
// dated -- the statement's row takes the hold's note, places, time and hand-set category
// and the hold goes (05.11.2026). What's left is re-totalled.
// A receipt (migration ...179) that matched the hold follows it onto the
// statement's own row -- its key (tx_source/tx_external_id), not a uuid, is
// what receipts are keyed by, so it's re-pointed here rather than left
// stale (docs/items-design.md section 3, point 8).
// deno-lint-ignore no-explicit-any
async function settlePending(db: any, userId: string, bank: string, bankSlug: string): Promise<number> {
  const pendingSource = `${bankSlug}_csv:pending`;
  const { data: holds, error: hErr } = await db.from('bank_transactions')
    .select('id, external_id, tx_date, amount, currency, expense_note, expense_category, expense_manual, place_id, delivery_place_id, authorized_at, authorized_approx')
    .eq('user_id', userId).eq('external_source', pendingSource).order('tx_date');
  if (hErr) throw new Error(hErr.message);
  if (!holds?.length) return 0;
  const from = holds[0].tx_date.slice(0, 10);
  const { data: real, error: rErr } = await db.from('bank_transactions')
    .select('id, external_source, external_id, tx_date, authorized_on, amount, currency, expense_note, expense_manual, place_id, delivery_place_id, authorized_at')
    .eq('user_id', userId).eq('account', bank).neq('external_source', pendingSource).lt('amount', 0)
    .gte('tx_date', `${from}T00:00:00Z`).order('tx_date');
  if (rErr) throw new Error(rErr.message);
  const taken = new Set<string>();
  const settled: string[] = [];
  for (const h of holds) {
    const day = h.tx_date.slice(0, 10);
    const m = (real ?? []).find((r: { id: string; tx_date: string; authorized_on: string | null; amount: number; currency: string }) =>
      !taken.has(r.id) && Number(r.amount) === Number(h.amount) && r.currency === h.currency
      && (r.authorized_on ?? r.tx_date.slice(0, 10)) === day);
    if (!m) continue;
    taken.add(m.id);
    const patch: Record<string, unknown> = {};
    if (h.expense_note && !m.expense_note) patch.expense_note = h.expense_note;
    if (h.expense_manual && !m.expense_manual) { patch.expense_category = h.expense_category; patch.expense_manual = true; }
    if (h.place_id && !m.place_id) patch.place_id = h.place_id;
    if (h.delivery_place_id && !m.delivery_place_id) patch.delivery_place_id = h.delivery_place_id;
    if (h.authorized_at && !m.authorized_at) Object.assign(patch, { authorized_at: h.authorized_at, authorized_approx: h.authorized_approx });
    if (Object.keys(patch).length) {
      const { error } = await db.from('bank_transactions').update(patch).eq('id', m.id);
      if (error) throw new Error(error.message);
    }
    const { error: rcErr } = await db.from('receipts')
      .update({ tx_source: m.external_source, tx_external_id: m.external_id })
      .eq('user_id', userId).eq('tx_source', pendingSource).eq('tx_external_id', h.external_id);
    if (rcErr) throw new Error(rcErr.message);
    settled.push(h.id);
  }
  if (!settled.length) return 0;
  const { error: dErr } = await db.from('bank_transactions').delete().in('id', settled);
  if (dErr) throw new Error(dErr.message);
  let bal = 0;
  for (const h of holds.filter((h: { id: string }) => !settled.includes(h.id))) {
    bal = Math.round((bal + Number(h.amount)) * 100) / 100;
    const { error } = await db.from('bank_transactions').update({ balance_after: bal }).eq('id', h.id);
    if (error) throw new Error(error.message);
  }
  return settled.length;
}

// Cash paid into an account at the bank's counter -- the matching row out of
// the cash on hand is written with it (see the handler).
const CASH_DEPOSIT_RE = /ანგარიშზე თანხის შეტანა/;
const CASH_DEPOSIT_SOURCE = 'cash_auto:deposits';

// A transfer to oneself out of Sber another bank's statement already lists
// (T-Bank, 30.10.2026: "External bank transfer PAO Sberbank" +70 000) while
// the Sber statements don't reach that day yet -- the capital had the money
// twice. Until they do, a stand-in takes it out of the Sber account that had
// enough for it that day: the debit card if its balance covers it, else the
// savings account holding the most (a sell of SAVINGS:Sber ...), else the
// card anyway. Keyed by the incoming row; every upload rewrites them, so one
// goes once a Sber statement brings its own row (the amount out of a Sber
// card or savings account, from 2 days before to 3 days after). Only from
// the first day Sber's card statements cover on -- older ones never had a
// Sber side. They count as estimates (source 'estimate_standin:sber',
// trades.estimated): a deleted one lands in estimate_archive, to check which
// account the statement really took it from.
const SBER_IN_RE = /sberbank|сбербанк/i;
const SBER_SELF_RE = /^external bank transfer\b|^top-up from\b|Илья (Михайлович )?З\./i;
const SBER_STANDIN_SOURCE = 'estimate_standin:sber';
// deno-lint-ignore no-explicit-any
async function sberStandIns(db: any, userId: string): Promise<number> {
  const { data: first, error: fErr } = await db.from('bank_transactions').select('tx_date')
    .eq('user_id', userId).eq('account', 'Sber').eq('product', 'debit_card').order('tx_date').limit(1);
  if (fErr) throw new Error(fErr.message);
  if (!first?.length) return 0;
  const { data: ins, error: iErr } = await db.from('bank_transactions').select('external_source, external_id, tx_date, amount, currency, description, account')
    .eq('user_id', userId).neq('account', 'Sber').gt('amount', 0).eq('synthetic', false)
    .gte('tx_date', first[0].tx_date).or('description.ilike.%sberbank%,description.ilike.%сбербанк%').order('tx_date');
  if (iErr) throw new Error(iErr.message);
  const incoming = (ins ?? []).filter((t: { description: string }) => SBER_IN_RE.test(t.description) && SBER_SELF_RE.test(t.description));
  const bankRows = [];
  const tradeRows = [];
  if (incoming.length) {
    const from = new Date(Date.parse(incoming[0].tx_date) - 3 * 86400000).toISOString();
    // the card's rows from the window on, and before them the last one per currency (its balance)
    const cardQuery = () => db.from('bank_transactions').select('tx_date, amount, currency, balance_after')
      .eq('user_id', userId).eq('account', 'Sber').eq('product', 'debit_card').neq('external_source', SBER_STANDIN_SOURCE);
    const { data: recent, error: cErr } = await cardQuery().gte('tx_date', from).order('tx_date');
    if (cErr) throw new Error(cErr.message);
    const card = [];
    for (const ccy of new Set(incoming.map((t: { currency: string }) => t.currency))) {
      const { data: before, error } = await cardQuery().eq('currency', ccy).lt('tx_date', from).order('tx_date', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      card.push(...(before ?? []));
    }
    card.push(...(recent ?? []));
    const { data: savings, error: sErr } = await db.from('trades').select('ticker, side, trade_date, quantity, price, currency')
      .eq('user_id', userId).eq('account', 'Sber').in('side', ['buy', 'sell']).neq('external_source', SBER_STANDIN_SOURCE)
      .or('ticker.like.SAVINGS:%,ticker.like.DEPOSIT:%').order('trade_date');
    if (sErr) throw new Error(sErr.message);
    type Out = { at: number; amount: number; currency: string };
    const sber: Out[] = [
      ...card.filter((o: { amount: number; tx_date: string }) => Number(o.amount) < 0 && o.tx_date >= from)
        .map((o: { tx_date: string; amount: number; currency: string }) => ({ at: Date.parse(o.tx_date.slice(0, 10)), amount: -Number(o.amount), currency: o.currency })),
      ...(savings ?? []).filter((s: { side: string; trade_date: string }) => s.side === 'sell' && s.trade_date >= from.slice(0, 10))
        .map((s: { trade_date: string; quantity: number; price: number; currency: string }) => ({ at: Date.parse(s.trade_date), amount: Number(s.quantity) * Number(s.price), currency: s.currency })),
    ];
    const used = new Set<number>();
    // what the stand-ins already took, per card currency / savings ticker
    const taken: Record<string, number> = {};
    const cardBal: Record<string, number> = {};
    for (const t of incoming) {
      const day = Date.parse(String(t.tx_date).slice(0, 10));
      const i = sber.findIndex((s, n) => !used.has(n) && s.currency === t.currency && Math.abs(s.amount - Number(t.amount)) < 0.005
        && s.at >= day - 2 * 86400000 && s.at <= day + 3 * 86400000);
      if (i >= 0) { used.add(i); continue; }
      const amount = Number(t.amount);
      const lastCard = card.filter((c: { tx_date: string; currency: string }) => c.currency === t.currency && c.tx_date <= t.tx_date).pop();
      const cardHas = Number(lastCard?.balance_after ?? 0) - (taken[`card:${t.currency}`] ?? 0);
      const held: Record<string, number> = {};
      for (const s of savings ?? []) {
        if (!String(s.ticker).startsWith('SAVINGS:') || s.currency !== t.currency || s.trade_date > String(t.tx_date).slice(0, 10)) continue;
        held[s.ticker] = (held[s.ticker] ?? 0) + (s.side === 'buy' ? 1 : -1) * Number(s.quantity) * Number(s.price);
      }
      const best = Object.entries(held).map(([k, v]) => [k, v - (taken[k] ?? 0)] as [string, number]).sort((x, y) => y[1] - x[1])[0];
      const note = `stand-in for ${t.account} ${t.external_source.split(':')[1] ?? ''}: "${String(t.description).slice(0, 120)}" +${amount} ${t.currency}`;
      const externalId = `${t.external_source}:${t.external_id}`;
      if (cardHas < amount - 0.005 && best && best[1] >= amount - 0.005) {
        taken[best[0]] = (taken[best[0]] ?? 0) + amount;
        tradeRows.push({
          user_id: userId, ticker: best[0], side: 'sell', quantity: amount, price: 1, trade_date: String(t.tx_date).slice(0, 10),
          currency: t.currency, account: 'Sber', note: `PENDING: transfer to ${t.account} the Sber statements don't have yet; ${note}`,
          external_source: SBER_STANDIN_SOURCE, external_id: externalId, estimated: true,
          fee_tax: null, fee_currency: null, nkd: null, exchange: null,
        });
        continue;
      }
      taken[`card:${t.currency}`] = (taken[`card:${t.currency}`] ?? 0) + amount;
      cardBal[t.currency] = Math.round(((cardBal[t.currency] ?? 0) - amount) * 100) / 100;
      bankRows.push({
        user_id: userId, account: 'Sber', tx_date: t.tx_date, description: `PENDING: transfer to ${t.account} the Sber statements don't have yet`,
        counterparty: null, amount: -amount, currency: t.currency, category: 'internal_transfer', balance_after: cardBal[t.currency],
        product: 'debit_card', synthetic: false, synthetic_kind: null, data_gap_until: null, amount_approximate: false,
        note, external_source: SBER_STANDIN_SOURCE, external_id: externalId,
      });
    }
  }
  for (const table of ['bank_transactions', 'trades']) {
    const { error } = await db.from(table).delete().eq('user_id', userId).eq('external_source', SBER_STANDIN_SOURCE);
    if (error) throw new Error(error.message);
  }
  if (bankRows.length) {
    const { error } = await db.from('bank_transactions').insert(bankRows);
    if (error) throw new Error(error.message);
  }
  if (tradeRows.length) {
    const { error } = await db.from('trades').insert(tradeRows);
    if (error) throw new Error(error.message);
  }
  return bankRows.length + tradeRows.length;
}

// This project's CSV is the record of each of its accounts over the days it
// spans: a stored row of that account dated within them that the file no
// longer has -- one taken from an app screenshot and since replaced by the
// statement's own row, say -- goes. A file cut to a few dates
// (tbank_debit_card_since_2026-09-01.csv) touches only those dates.
// deno-lint-ignore no-explicit-any
async function dropStale(db: any, userId: string, table: 'bank_transactions' | 'trades', dateCol: 'tx_date' | 'trade_date',
  rows: { external_source: string; external_id: string; day: string }[]): Promise<number> {
  const bySource = new Map<string, { ids: Set<string>; from: string; to: string }>();
  for (const r of rows) {
    const g = bySource.get(r.external_source) ?? { ids: new Set<string>(), from: r.day, to: r.day };
    g.ids.add(r.external_id);
    if (r.day < g.from) g.from = r.day;
    if (r.day > g.to) g.to = r.day;
    bySource.set(r.external_source, g);
  }
  let dropped = 0;
  for (const [src, g] of bySource) {
    const from = dateCol === 'tx_date' ? `${g.from}T00:00:00Z` : g.from;
    const to = dateCol === 'tx_date' ? `${g.to}T23:59:59.999Z` : g.to;
    const stale: string[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await db.from(table).select('id, external_id')
        .eq('user_id', userId).eq('external_source', src).gte(dateCol, from).lte(dateCol, to)
        .order('id').range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) if (!g.ids.has(r.external_id)) stale.push(r.id);
      if (!data || data.length < 1000) break;
    }
    for (let i = 0; i < stale.length; i += 200) {
      const { error } = await db.from(table).delete().in('id', stale.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }
    dropped += stale.length;
  }
  return dropped;
}

// A label (note, hand-set category, place, time set by hand) sits on its row,
// and a row whose key changed -- the description or the time differs in the
// new report -- is one dropStale deletes, label and all. So before that, each
// labelled row the file replaces hands its labels to the file's row for the
// same account, day, amount and currency (the same description first). The
// report's own time wins: a time set by hand goes over only to a row the
// report gave no time.
// deno-lint-ignore no-explicit-any
async function carryLabels(db: any, userId: string, rows: { external_source: string; external_id: string; tx_date: string;
  amount: number; currency: string; description: string }[], timed: Set<string>): Promise<number> {
  const SELECT = 'id, external_source, external_id, tx_date, amount, currency, description, expense_note, expense_manual, ' +
    'expense_category, expense_spread_months, expense_spread_from, place_id, delivery_place_id, fx_rate, authorized_at, authorized_approx';
  // deno-lint-ignore no-explicit-any
  const hasLabel = (t: any) => t.expense_note || t.expense_manual || t.place_id || t.delivery_place_id || t.fx_rate != null
    || t.expense_spread_months != null || t.authorized_at;
  const bySource = new Map<string, { from: string; to: string }>();
  for (const r of rows) {
    const day = r.tx_date.slice(0, 10);
    const g = bySource.get(r.external_source) ?? { from: day, to: day };
    if (day < g.from) g.from = day;
    if (day > g.to) g.to = day;
    bySource.set(r.external_source, g);
  }
  let carried = 0;
  for (const [src, g] of bySource) {
    // deno-lint-ignore no-explicit-any
    const all: any[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await db.from('bank_transactions').select(SELECT)
        .eq('user_id', userId).eq('external_source', src)
        .gte('tx_date', `${g.from}T00:00:00Z`).lte('tx_date', `${g.to}T23:59:59.999Z`)
        .order('id').range(off, off + 999);
      if (error) throw new Error(error.message);
      all.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const fileIds = new Set(rows.filter(r => r.external_source === src).map(r => r.external_id));
    const target = new Map(all.filter(t => fileIds.has(t.external_id)).map(t => [t.external_id, t]));
    const stale = all.filter(t => !fileIds.has(t.external_id) && hasLabel(t))
      .sort((a, b) => (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : 0));
    const taken = new Set<string>();
    for (const s of stale) {
      const day = s.tx_date.slice(0, 10);
      const candidates = rows.filter(r => r.external_source === src && !taken.has(r.external_id)
        && r.tx_date.slice(0, 10) === day && Number(r.amount) === Number(s.amount) && r.currency === s.currency);
      const pick = candidates.find(r => r.description === s.description) ?? candidates[0];
      const t = pick && target.get(pick.external_id);
      if (!t) continue;
      taken.add(pick.external_id);
      const patch: Record<string, unknown> = {};
      if (s.expense_note && !t.expense_note) patch.expense_note = s.expense_note;
      if (s.expense_manual && !t.expense_manual) { patch.expense_category = s.expense_category; patch.expense_manual = true; }
      if (s.expense_spread_months != null && t.expense_spread_months == null) {
        patch.expense_spread_months = s.expense_spread_months; patch.expense_spread_from = s.expense_spread_from;
      }
      if (s.place_id && !t.place_id) patch.place_id = s.place_id;
      if (s.delivery_place_id && !t.delivery_place_id) patch.delivery_place_id = s.delivery_place_id;
      if (s.fx_rate != null && t.fx_rate == null) patch.fx_rate = s.fx_rate;
      if (s.authorized_at && !t.authorized_at && !timed.has(pick.external_id)) {
        Object.assign(patch, { authorized_at: s.authorized_at, authorized_approx: s.authorized_approx });
      }
      if (!Object.keys(patch).length) continue;
      const { error } = await db.from('bank_transactions').update(patch).eq('user_id', userId).eq('id', t.id);
      if (error) throw new Error(error.message);
      carried++;
    }
  }
  return carried;
}

function categorize(description: string): string | null {
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(description)) return cat;
  }
  return null;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: corsHeaders });
    }

    const csvText = await req.text();
    let csvRows = parseRows(csvText);
    if (!csvRows.length) {
      return new Response(JSON.stringify({ error: 'No parseable rows found (unrecognized CSV header?)' }),
        { status: 400, headers: corsHeaders });
    }

    // Sber / T-Bank broker money taken from the app ('<agreement>-app') gives way to the
    // broker reports: the rows up to the latest report's end are left out (its
    // closing balance holds them), the rest counted again from 0
    // (_shared/app_rows.ts).
    let coveredByReport = 0;
    const appAccounts = [...new Set(csvRows.filter(r => (r.bank === 'Sber' || r.bank === 'T-Bank') && r.accountNumber.endsWith('-app'))
      .map(r => `${r.bank}|${r.accountNumber}`))].map(k => k.split('|'));
    for (const [bank, acc] of appAccounts) {
      const ends = (await reportPeriods(supabase, user.id, bank, acc.slice(0, -4))).map(([, t]) => t).sort();
      const lastEnd = ends[ends.length - 1];
      if (!lastEnd) continue;
      const before = csvRows.length;
      csvRows = csvRows.filter(r => r.accountNumber !== acc || r.date > lastEnd);
      coveredByReport += before - csvRows.length;
      const bal: Record<string, number> = {};
      for (const r of csvRows) {
        if (r.accountNumber !== acc) continue;
        bal[r.currency] = Math.round(((bal[r.currency] ?? 0) + r.amount) * 100) / 100;
        r.balance = bal[r.currency];
      }
    }

    // Untimed rows (Yandex Save) -> 00:00:SS by in-day order.
    const untimedSeq = new Map<string, number>();
    const rows = [];
    const depositRows = [];
    const dupSeen = new Map<string, number>();
    const timedIds = new Set<string>();
    for (const r of csvRows) {
      let clock: string;
      if (r.time) {
        clock = r.time.length === 5 ? `${r.time}:00` : r.time;
      } else {
        const key = `${r.bank}:${r.accountNumber}:${r.date}`;
        const seq = untimedSeq.get(key) ?? 0;
        untimedSeq.set(key, seq + 1);
        clock = `00:00:${String(Math.min(seq, 59)).padStart(2, '0')}`;
      }

      const bankSlug = r.bank.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const signature = `${r.accountNumber}:${r.date}:${r.time}:${r.description}:${r.amount}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);
      const externalId = occurrence === 0 ? signature : `${signature}:dup${occurrence}`;
      if (r.time) timedIds.add(externalId);

      if (DEPOSIT_PRODUCTS.has(r.product)) {
        if (r.amount === 0) continue;
        depositRows.push({
          user_id: user.id,
          ticker: `${r.product === 'savings_account' ? 'SAVINGS' : 'DEPOSIT'}:${r.bank} ${r.currency}${r.depositName ? ` ${r.depositName}` : ''}`,
          side: r.amount < 0 ? 'sell' : 'buy',
          quantity: Math.abs(r.amount),
          price: 1,
          trade_date: r.date,
          currency: r.currency,
          account: r.bank,
          note: r.replacesSnowball ? `${r.description} [replaces Snowball ${r.replacesSnowball}]` : r.description,
          external_source: `${bankSlug}_deposit_csv:${r.accountNumber}`,
          external_id: externalId,
        });
        continue;
      }

      const externalSource = `${bankSlug}_csv:${r.accountNumber}`;

      rows.push({
        user_id: user.id,
        account: r.bank,
        tx_date: `${r.date}T${clock}Z`,
        authorized_on: madeOn(r.bank, r.description, r.date),
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency: r.currency,
        category: r.syntheticKind ? null
          : categorize(r.categoryBank ? `${r.description} ${r.categoryBank}` : r.description),
        balance_after: r.balance,
        product: r.product || null,
        synthetic: r.syntheticKind !== null,
        synthetic_kind: r.syntheticKind,
        data_gap_until: r.dataGapUntil,
        note: r.note || null,
        amount_approximate: r.amountApproximate,
        external_source: externalSource,
        external_id: externalId,
      });
    }

    let imported = 0;
    if (rows.length) {
      const { error: upsertErr, count } = await supabase
        .from('bank_transactions')
        .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });
      if (upsertErr) {
        return new Response(JSON.stringify({ error: upsertErr.message }),
          { status: 500, headers: corsHeaders });
      }
      imported = count ?? rows.length;
    }

    const carriedLabels = await carryLabels(supabase, user.id, rows, timedIds);
    const droppedStale = await dropStale(supabase, user.id, 'bank_transactions', 'tx_date',
      rows.map(r => ({ external_source: r.external_source, external_id: r.external_id, day: r.tx_date.slice(0, 10) })));

    // a statement (not the holds' own file) settles the bank's holds
    let settledPending = 0;
    for (const [bank, slug] of new Map(rows.filter(r => !r.external_source.endsWith(':pending'))
      .map(r => [r.account, r.external_source.split(':')[0].replace(/_csv$/, '')]))) {
      settledPending += await settlePending(supabase, user.id, bank, slug);
    }

    // Cash paid in at the bank's counter (TBC: "ანგარიშზე თანხის შეტანა") came
    // out of the cash on hand: its row there is written here, not by hand
    // (31.10.2026) -- source CASH_DEPOSIT_SOURCE, keyed by the bank row (a
    // statement uploaded again writes the same rows), a running balance per
    // currency from 0 on top of the cash ledger's. The transfer matcher pairs
    // the two.
    const cashOut = rows.filter(r => !r.synthetic && r.amount > 0 && CASH_DEPOSIT_RE.test(r.description)).map(r => ({
      user_id: user.id, account: 'cash', tx_date: r.tx_date, description: `Cash deposited to ${r.account}`, counterparty: null,
      amount: -r.amount, currency: r.currency, category: null, balance_after: null, product: 'cash', synthetic: false,
      synthetic_kind: null, data_gap_until: null, amount_approximate: false,
      note: `${r.account} ${r.external_source.split(':')[1]}: "${r.description.slice(0, 120)}" +${r.amount} ${r.currency}`,
      external_source: CASH_DEPOSIT_SOURCE, external_id: `${r.external_source}:${r.external_id}`,
    }));
    if (cashOut.length) {
      const { error: cErr } = await supabase.from('bank_transactions')
        .upsert(cashOut, { onConflict: 'user_id,external_source,external_id' });
      if (cErr) return new Response(JSON.stringify({ error: cErr.message }), { status: 500, headers: corsHeaders });
      const { data: all, error: aErr } = await supabase.from('bank_transactions').select('id, currency, amount')
        .eq('user_id', user.id).eq('external_source', CASH_DEPOSIT_SOURCE).order('tx_date');
      if (aErr) return new Response(JSON.stringify({ error: aErr.message }), { status: 500, headers: corsHeaders });
      const bal: Record<string, number> = {};
      for (const r of all ?? []) {
        bal[r.currency] = Math.round(((bal[r.currency] ?? 0) + Number(r.amount)) * 100) / 100;
        const { error } = await supabase.from('bank_transactions').update({ balance_after: bal[r.currency] }).eq('id', r.id);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
      }
    }

    let importedDeposit = 0;
    let sberPending = 0;
    if (depositRows.length) {
      const { error: upsertErr, count } = await supabase
        .from('trades')
        .upsert(depositRows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });
      if (upsertErr) {
        return new Response(JSON.stringify({ error: upsertErr.message }),
          { status: 500, headers: corsHeaders });
      }
      importedDeposit = count ?? depositRows.length;
    }

    const droppedStaleDeposit = await dropStale(supabase, user.id, 'trades', 'trade_date',
      depositRows.map(r => ({ external_source: r.external_source, external_id: r.external_id, day: r.trade_date })));

    // after both the bank rows and the savings trades: either can bring Sber's own row
    sberPending = await sberStandIns(supabase, user.id);

    // Snowball rows of deposits this statement now covers (see header).
    let removedSnowball = 0;
    const replaced = [...new Set(csvRows.map(r => r.replacesSnowball).filter(Boolean))];
    if (replaced.length) {
      const { error: delErr, count } = await supabase.from('trades').delete({ count: 'exact' })
        .eq('user_id', user.id).eq('external_source', 'snowball_csv').in('ticker', replaced);
      if (delErr) {
        return new Response(JSON.stringify({ error: delErr.message }), { status: 500, headers: corsHeaders });
      }
      removedSnowball = count ?? 0;
    }

    // a waiting receipt (migration ...179) may now match one of the rows
    // just written -- re-run after every import, not only when a hold settles
    let matchedReceipts = 0;
    if (rows.length) {
      const { data: m, error: mErr } = await supabase.rpc('match_receipts');
      if (mErr) throw new Error(mErr.message);
      matchedReceipts = m ?? 0;
    }

    return new Response(JSON.stringify({
      imported,
      imported_deposit: importedDeposit,
      removed_snowball_duplicates: removedSnowball,
      covered_by_report: coveredByReport,
      dropped_stale: droppedStale + droppedStaleDeposit,
      cash_deposits: cashOut.length,
      matched_receipts: matchedReceipts,
      sber_pending: sberPending,
      settled_pending: settledPending,
      total_rows: csvRows.length,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
