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
// 'openbanking_revolut_fund' / 'openbanking_revolut_savings'. A fund or
// savings statement takes its period back.
export const OPENBANKING_TRADE_SOURCE = { fund: 'openbanking_revolut_fund', savings: 'openbanking_revolut_savings' };

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
  if (!src || !periodEnd) return 0;
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
