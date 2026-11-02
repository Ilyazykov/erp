-- What an upload brings shows on the expenses tab within a minute. The
-- expenses (and income, refresh_expenses runs refresh_income) were rebuilt
-- only at the end of the capital rebuild -- some 10 minutes, twice that when
-- the upload came in the middle of a running one: TBC's statement of
-- 03.11.2026 was in, its rows nowhere on the page (02.11.2026). Now the
-- refresh step pairs the transfers and rebuilds the expenses first, every
-- time a request is newer than the last expenses rebuild (expenses_at), a
-- request in the middle of a run too; the capital goes on as before.
-- run_capital_refresh_step is patched in place (as in ...130).

alter table public.capital_refresh_queue add column if not exists expenses_at timestamptz;

do $mig$
declare
  d text := pg_get_functiondef('public.run_capital_refresh_step()'::regprocedure);
  a text := E'  loop\n    if q.next_from is null then\n      perform match_internal_transfers(q.user_id);';
  b text := E'  loop\n    -- the expenses first (migration ...149): what an upload brings shows at once\n'
    || E'    if q.expenses_at is null or q.expenses_at < q.requested_at then\n'
    || E'      perform match_internal_transfers(q.user_id);\n'
    || E'      perform refresh_expenses(q.user_id);\n'
    || E'      update capital_refresh_queue set expenses_at = now() where user_id = q.user_id;\n'
    || E'    end if;\n'
    || E'    if q.next_from is null then\n      perform match_internal_transfers(q.user_id);';
begin
  if position('the expenses first (migration ...149)' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'run_capital_refresh_step: the start of the loop not found'; end if;
  execute replace(d, a, b);
end $mig$;
