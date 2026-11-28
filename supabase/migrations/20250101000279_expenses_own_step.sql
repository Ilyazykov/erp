-- The expenses rebuilt in a run of their own (28.11.2026): run_capital_refresh_step rebuilt them
-- (refresh_expenses: every row of the tab deleted and written again, ~23 s) inside the same
-- transaction as the capital history -- first for an upload, and again at the end of the history,
-- after up to 40 s of it -- so the tab's rows stayed locked until that whole run committed (a minute
-- and more). A category set on the page meanwhile waited on them and timed out ("canceling
-- statement due to statement timeout"; a place's row update dropped by the gateway, "Failed to
-- fetch"). Now:
--   * the expenses step ends the run: it commits by itself, the history goes on from the next
--     minute's run;
--   * the end of the history asks for the expenses again (expenses_at cleared) instead of
--     rebuilding them there, so the next run does it on its own;
--   * a user is picked up for that too (expenses_at null), the history done or not.
-- The page tries a write again while the rows are held (mpWriteRetry).

do $mig$
declare
  d text := pg_get_functiondef('public.run_capital_refresh_step()'::regprocedure);
  a1 text := $t$    where next_from is not null or finished_at is null or finished_at < requested_at$t$;
  b1 text := $t$    where next_from is not null or finished_at is null or finished_at < requested_at
       or expenses_at is null or expenses_at < requested_at  -- migration ...279$t$;
  a2 text := $t$      update capital_refresh_queue set expenses_at = now() where user_id = q.user_id;
    end if;$t$;
  b2 text := $t$      update capital_refresh_queue set expenses_at = now() where user_id = q.user_id;
      -- committed by itself: the rest from the next run (migration ...279)
      return done;
    end if;$t$;
  a3 text := $t$      perform refresh_investment_daily(q.user_id);
      perform refresh_expenses(q.user_id);$t$;
  b3 text := $t$      perform refresh_investment_daily(q.user_id);
      -- the expenses by the next run, a transaction of their own (migration ...279)
      update capital_refresh_queue set expenses_at = null where user_id = q.user_id;$t$;
begin
  if position('migration ...279' in d) > 0 then return; end if;
  if position(a1 in d) = 0 then raise exception 'run_capital_refresh_step: the queue''s filter not found'; end if;
  if position(a2 in d) = 0 then raise exception 'run_capital_refresh_step: the expenses step not found'; end if;
  if position(a3 in d) = 0 then raise exception 'run_capital_refresh_step: the history''s end not found'; end if;
  execute replace(replace(replace(d, a1, b1), a2, b2), a3, b3);
end $mig$;
