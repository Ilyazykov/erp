// Rows this project takes from a bank's app (screenshots of the history) give
// way to the broker's own report: a report of the agreement (or the ЦФА
// wallet) is the record of its period. The app rows are
//   - payouts / deals in this project's broker CSV (import-broker-csv):
//     broker 'Sber' or 'T-Bank', account_number '<agreement or wallet>' --
//     trades 'broker_csv', external_id '<agreement>:...';
//   - their money in this project's bank CSV (import-bank-csv): bank 'Sber' or
//     'T-Bank', account_number '<agreement or wallet>-app', a running balance
//     from 0 on top of the report's -- bank_transactions
//     '<sber|t_bank>_csv:<agreement>-app'.
// Which days a report holds:
//   - Sber (import-sber-broker): one balance_snapshot per currency noted
//     "period <from>..<to>" in 'sber_broker_html:<agreement>';
//   - T-Bank broker reports (import-tbank-broker, 'tbank_broker_xlsx:<agreement>')
//     and Atomyze ЦФА reports (import-atomyze, 'atomyze_xlsx:<wallet>'): the
//     span of the report's own money rows.
// Either side may come first: a report drops the app rows of its period
// (removeAppRows); app rows uploaded after a report leave out the days it
// holds (reportPeriods).

const APP_SOURCE: Record<string, string> = { Sber: 'sber_csv', 'T-Bank': 't_bank_csv' };

// deno-lint-ignore no-explicit-any
export async function reportPeriods(db: any, userId: string, account: string, key: string): Promise<[string, string][]> {
  if (account === 'Sber') {
    const { data, error } = await db.from('bank_transactions').select('note')
      .eq('user_id', userId).eq('external_source', `sber_broker_html:${key}`).eq('synthetic_kind', 'balance_snapshot');
    if (error) throw new Error(error.message);
    const out: [string, string][] = [];
    for (const r of data ?? []) {
      const m = String(r.note ?? '').match(/^period (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
      if (m) out.push([m[1], m[2]]);
    }
    return out;
  }
  if (account === 'T-Bank') {
    const out: [string, string][] = [];
    for (const src of [`tbank_broker_xlsx:${key}`, `atomyze_xlsx:${key}`]) {
      const first = await db.from('bank_transactions').select('tx_date').eq('user_id', userId).eq('external_source', src)
        .order('tx_date', { ascending: true }).limit(1);
      const last = await db.from('bank_transactions').select('tx_date').eq('user_id', userId).eq('external_source', src)
        .order('tx_date', { ascending: false }).limit(1);
      if (first.error) throw new Error(first.error.message);
      if (last.error) throw new Error(last.error.message);
      if (first.data?.length && last.data?.length) out.push([first.data[0].tx_date.slice(0, 10), last.data[0].tx_date.slice(0, 10)]);
    }
    return out;
  }
  return [];
}

// A report of `key` (agreement / wallet) for periodStart..periodEnd is in:
// the app payouts inside its period go (it lists them; ones outside stay), the
// app money up to its end goes (its closing balance holds it), and the app
// money left is counted again from 0.
// deno-lint-ignore no-explicit-any
export async function removeAppRows(db: any, userId: string, account: string, key: string, periodStart: string, periodEnd: string): Promise<number> {
  const { count: t, error: e1 } = await db.from('trades').delete({ count: 'exact' })
    .eq('user_id', userId).eq('external_source', 'broker_csv').eq('account', account)
    .like('external_id', `${key}:%`).gte('trade_date', periodStart).lte('trade_date', periodEnd);
  if (e1) throw new Error(e1.message);
  const src = `${APP_SOURCE[account]}:${key}-app`;
  const { count: b, error: e2 } = await db.from('bank_transactions').delete({ count: 'exact' })
    .eq('user_id', userId).eq('external_source', src).lte('tx_date', `${periodEnd}T23:59:59.999Z`);
  if (e2) throw new Error(e2.message);
  if (b) {
    const { data: rest, error: e3 } = await db.from('bank_transactions').select('id, currency, amount')
      .eq('user_id', userId).eq('external_source', src).order('tx_date');
    if (e3) throw new Error(e3.message);
    const bal: Record<string, number> = {};
    for (const r of rest ?? []) {
      bal[r.currency] = Math.round(((bal[r.currency] ?? 0) + Number(r.amount)) * 100) / 100;
      const { error } = await db.from('bank_transactions').update({ balance_after: bal[r.currency] }).eq('id', r.id);
      if (error) throw new Error(error.message);
    }
  }
  return (t ?? 0) + (b ?? 0);
}
