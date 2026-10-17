// Rows this project takes from a bank's app (screenshots of the history) give
// way to the broker's own report: a report of the agreement is the record of
// its period. Sber's broker reports (import-sber-broker) leave one
// balance_snapshot per currency noted "period <from>..<to>" in
// bank_transactions 'sber_broker_html:<agreement>'; the app rows are
//   - payouts in this project's broker CSV (import-broker-csv): broker 'Sber',
//     account_number '<agreement>' -- left out where a report's period holds
//     their day;
//   - their money in this project's bank CSV (import-bank-csv): bank 'Sber',
//     account_number '<agreement>-app', a running balance from 0 on top of the
//     report's -- left out up to the latest report end (its closing balance
//     holds them), the rows kept counted again from 0.
// import-sber-broker drops the same rows when the report comes after them.

// deno-lint-ignore no-explicit-any
export async function sberReportPeriods(db: any, userId: string, agreement: string): Promise<[string, string][]> {
  const { data, error } = await db.from('bank_transactions').select('note')
    .eq('user_id', userId).eq('external_source', `sber_broker_html:${agreement}`).eq('synthetic_kind', 'balance_snapshot');
  if (error) throw new Error(error.message);
  const out: [string, string][] = [];
  for (const r of data ?? []) {
    const m = String(r.note ?? '').match(/^period (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}
