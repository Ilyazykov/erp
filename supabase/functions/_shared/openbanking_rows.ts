// The rows sync-openbanking takes from a bank through Open Banking (Enable
// Banking) fill the days after the bank's latest statement:
// bank_transactions 'openbanking_<bank>', a running balance per currency from
// 0 on top of the statement's. A statement uploaded later is the record of
// its period: removeOpenBankingRows drops the API rows up to its end and
// counts the rest again from 0 (the next sync rebuilds them anyway).

export const OPENBANKING_SOURCE: Record<string, string> = {
  Revolut: 'openbanking_revolut',
  'Bank of Cyprus': 'openbanking_boc',
  Wise: 'openbanking_wise',
};

// Revolut's moves to / from its Flexible Cash Funds and Instant Access
// Savings, seen as transfers on its accounts, stand in as the fund's / the
// savings' trades until their own statement comes: trades
// 'openbanking_revolut_fund' / 'openbanking_revolut_savings'. Its purchases of
// metals ("Exchanged to XAU") stand in as the metal's buys, at the market
// price of the day: 'openbanking_revolut_metal'. A fund, savings or metal
// pocket statement takes its period back.
export const OPENBANKING_TRADE_SOURCE = { fund: 'openbanking_revolut_fund', savings: 'openbanking_revolut_savings', metal: 'openbanking_revolut_metal' };

// Its transfers to / from the brokerage (Invest) account stand in as that
// account's cash (bank_transactions, a running balance per currency from 0 on
// top of the Invest statement's) until the Invest statement comes.
export const OPENBANKING_INVEST_SOURCE = 'openbanking_revolut_invest';

// deno-lint-ignore no-explicit-any
export async function removeOpenBankingTrades(db: any, userId: string, source: string, periodEnd: string): Promise<number> {
  if (!periodEnd) return 0;
  const { count, error } = await db.from('trades').delete({ count: 'exact' })
    .eq('user_id', userId).eq('external_source', source).lte('trade_date', periodEnd.slice(0, 10));
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// deno-lint-ignore no-explicit-any
export async function removeOpenBankingRows(db: any, userId: string, account: string, periodEnd: string): Promise<number> {
  const src = OPENBANKING_SOURCE[account];
  return src ? await removeOpenBankingCash(db, userId, src, periodEnd) : 0;
}

// What one wrote on an API row -- a note, a category, a place, a time (the
// API gives the day only) -- goes over to the statement's own row of it
// before the API row goes (05.11.2026): same account, amount and currency,
// made within 3 days, the nearest; one the statement row has already stays.
const HAND_FIELDS = 'id, tx_date, authorized_on, amount, currency, expense_note, expense_category, expense_manual, income_category, income_manual, place_id, delivery_place_id, authorized_at, authorized_approx';
// deno-lint-ignore no-explicit-any
async function handOver(db: any, userId: string, src: string, periodEnd: string): Promise<number> {
  const account = Object.keys(OPENBANKING_SOURCE).find(a => OPENBANKING_SOURCE[a] === src);
  const { data: api, error } = await db.from('bank_transactions').select(HAND_FIELDS)
    .eq('user_id', userId).eq('external_source', src).lte('tx_date', `${periodEnd.slice(0, 10)}T23:59:59.999Z`)
    .or('expense_note.not.is.null,expense_manual.eq.true,income_manual.eq.true,place_id.not.is.null,delivery_place_id.not.is.null,authorized_at.not.is.null');
  if (error) throw new Error(error.message);
  if (!api?.length || !account) return 0;
  const dayOf = (r: { authorized_on: string | null; tx_date: string }) => r.authorized_on ?? r.tx_date.slice(0, 10);
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const days = api.map(dayOf).sort();
  const { data: own, error: e2 } = await db.from('bank_transactions').select(HAND_FIELDS)
    .eq('user_id', userId).eq('account', account).not('external_source', 'like', 'openbanking%')
    .gte('tx_date', `${shift(days[0], -3)}T00:00:00Z`).lte('tx_date', `${shift(days[days.length - 1], 3)}T23:59:59.999Z`);
  if (e2) throw new Error(e2.message);
  const taken = new Set<string>();
  let moved = 0;
  for (const a of api) {
    const gap = (o: typeof a) => Math.abs(Date.parse(dayOf(o)) - Date.parse(dayOf(a))) / 86400000;
    const o = (own ?? []).filter((o: typeof a) => !taken.has(o.id) && Number(o.amount) === Number(a.amount) && o.currency === a.currency && gap(o) <= 3)
      .sort((p: typeof a, q: typeof a) => gap(p) - gap(q))[0];
    if (!o) continue;
    taken.add(o.id);
    const patch: Record<string, unknown> = {};
    if (a.expense_note && !o.expense_note) patch.expense_note = a.expense_note;
    if (a.expense_manual && !o.expense_manual) Object.assign(patch, { expense_category: a.expense_category, expense_manual: true });
    if (a.income_manual && !o.income_manual) Object.assign(patch, { income_category: a.income_category, income_manual: true });
    if (a.place_id && !o.place_id) patch.place_id = a.place_id;
    if (a.delivery_place_id && !o.delivery_place_id) patch.delivery_place_id = a.delivery_place_id;
    // a statement with times has its own; one without gets the hand-set one
    if (a.authorized_at && !o.authorized_at && o.tx_date.slice(11, 16) === '00:00') Object.assign(patch, { authorized_at: a.authorized_at, authorized_approx: a.authorized_approx });
    if (!Object.keys(patch).length) continue;
    const { error: e3 } = await db.from('bank_transactions').update(patch).eq('id', o.id);
    if (e3) throw new Error(e3.message);
    moved++;
  }
  return moved;
}

// The rows of one Open Banking cash source up to a statement's end, the rest
// counted again from 0.
// deno-lint-ignore no-explicit-any
export async function removeOpenBankingCash(db: any, userId: string, src: string, periodEnd: string): Promise<number> {
  if (!periodEnd) return 0;
  await handOver(db, userId, src, periodEnd);
  const { count, error } = await db.from('bank_transactions').delete({ count: 'exact' })
    .eq('user_id', userId).eq('external_source', src).lte('tx_date', `${periodEnd.slice(0, 10)}T23:59:59.999Z`);
  if (error) throw new Error(error.message);
  if (!count) return 0;
  const { data: rest, error: e2 } = await db.from('bank_transactions').select('id, currency, amount')
    .eq('user_id', userId).eq('external_source', src).order('booked_at').order('tx_date');
  if (e2) throw new Error(e2.message);
  const bal: Record<string, number> = {};
  for (const r of rest ?? []) {
    bal[r.currency] = Math.round(((bal[r.currency] ?? 0) + Number(r.amount)) * 100) / 100;
    const { error } = await db.from('bank_transactions').update({ balance_after: bal[r.currency] }).eq('id', r.id);
    if (error) throw new Error(error.message);
  }
  return count;
}
