// Supabase Edge Function: month_totals
//
// Keeps month_totals (migration ...190) -- the "Over time" chart's monthly
// sums -- in step with the rows, for each user that's due (month_totals_due:
// an expenses rebuild after the last run, or the data's fingerprint moved).
// Per user, in one transaction (month_totals_write):
//   - the expenses: summed by month in SQL, set against the stored months,
//     only the rows that differ written;
//   - the income: each changed source (account and category: its rows'
//     fingerprint moved) spread over the days it was earned in -- the page's
//     own mpExpIncomeDays (_shared/income_days.js) -- summed by month and
//     written the same way; the sources that didn't change aren't read.
//
// Called by pg_cron every 5 minutes when a user is due (deployed with
// --no-verify-jwt; only with the cron secret).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { incomeMonthTotals } from '../_shared/income_days.js';

const SEP = '\u0001';

Deno.serve(async (req) => {
  if (!(await fromCron(req))) return notFromCron();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const t0 = Date.now();
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: due, error } = await db.rpc('month_totals_due');
    if (error) throw new Error(error.message);
    const runs = [];
    for (const { user_id, fingerprint } of due ?? []) {
      const t1 = Date.now();
      const { data: sources, error: e1 } = await db.rpc('month_totals_income_sources', { p_user: user_id });
      if (e1) throw new Error(e1.message);
      // changed: a new fingerprint, or a source gone (fp null: its months deleted)
      const changed = (sources ?? []).filter((s: { fp: string | null; stored_fp: string | null }) => s.fp !== s.stored_fp)
        .map((s: { account: string; category: string }) => ({ account: s.account, category: s.category }));
      const rows = [];
      if (changed.length) {
        for (let from = 0; ; from += 1000) {
          const { data, error: e2 } = await db.rpc('month_totals_income_rows', { p_user: user_id, p_sources: changed })
            .order('day').order('id').range(from, from + 999);
          if (e2) throw new Error(e2.message);
          rows.push(...data);
          if (data.length < 1000) break;
        }
      }
      const income = incomeMonthTotals(rows.map(r => ({
        day: r.day, account: r.account, category: r.category,
        usd: r.usd == null ? null : Number(r.usd), eur: r.eur == null ? null : Number(r.eur), rub: r.rub == null ? null : Number(r.rub),
      })));
      const incomeFp = Object.fromEntries((sources ?? []).filter((s: { fp: string | null }) => s.fp)
        .map((s: { account: string; category: string; fp: string }) => [s.account + SEP + s.category, s.fp]));
      const { data: written, error: e3 } = await db.rpc('month_totals_write', {
        p_user: user_id, p_fingerprint: fingerprint, p_sources: changed, p_income: income, p_income_fp: incomeFp,
      });
      if (e3) throw new Error(e3.message);
      runs.push({ user_id, sources_changed: changed.length, income_rows_read: rows.length, ...written, ms: Date.now() - t1 });
    }
    const out = { users: runs.length, runs, ms: Date.now() - t0 };
    console.log(JSON.stringify(out));
    return json(out);
  } catch (e) {
    return json({ error: String(e), ms: Date.now() - t0 }, 500);
  }
});
