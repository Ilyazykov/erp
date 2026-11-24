// A price written into price_history only marks the capital history dirty
// (capital_mark_dirty, migration ...231): the rebuild (run_capital_refresh_step)
// runs only once someone asks for it. The price jobs ask for every user, since
// a price is everyone's -- without it the day's prices sat in price_history
// while capital_daily kept yesterday's values and the 1-day map showed 0%
// (24.11.2026).
// deno-lint-ignore no-explicit-any
export async function requestCapitalRefreshAll(db: any): Promise<void> {
  const { data, error } = await db.from('capital_refresh_queue').select('user_id');
  if (error) { console.warn(`capital refresh not requested: ${error.message}`); return; }
  for (const { user_id } of (data ?? []) as { user_id: string }[]) {
    const { error: rq } = await db.rpc('request_capital_refresh', { p_user: user_id });
    if (rq) console.warn(`capital refresh not requested for ${user_id.slice(0, 8)}: ${rq.message}`);
  }
}
