-- refresh_expenses step 4 (a card payment in another currency, migration ...151) took 35 s of the
-- refresh for 11 payments: the planner put the lateral's filter usd_per_unit_on(c, day) > 0 under
-- the DISTINCT over fx_history, so the rate was looked up for each of its 97 000 rows, not for its
-- 40 currencies -- a million calls. refresh_expenses runs twice in a refresh step: over a minute of
-- the 1.5-4 minutes (measured 26.11.2026). The currencies are listed once now (a materialized CTE):
-- 0.16 s, the same 11 fees to the cent.
do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a1 text := E'  create temp table fx_fees on commit drop as\n  select b.external_source';
  b1 text := E'  create temp table fx_fees on commit drop as\n'
          || E'  -- the currencies once (migration ...261): not each fx_history row through usd_per_unit_on\n'
          || E'  with ccys as materialized (select distinct currency as c from fx_history union select ''USD'')\n'
          || E'  select b.external_source';
  a2 text := $t$from (select distinct currency as c from fx_history union select 'USD') cc$t$;
  b2 text := 'from ccys cc';
begin
  if position(a1 in d) = 0 then raise exception 'refresh_expenses: fx_fees not found'; end if;
  if position(a2 in d) = 0 then raise exception 'refresh_expenses: the currencies of fx_fees not found'; end if;
  execute replace(replace(d, a1, b1), a2, b2);
end $mig$;
