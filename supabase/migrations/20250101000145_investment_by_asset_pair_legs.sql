-- investment_by_asset looked up each trade's transfer pair (the day the pair
-- counts from) with a subquery per trade -- an OR over both legs, a scan of
-- internal_transfers each time, and tr inlined into several places: ~24 000
-- scans, 11 s, past the page's 8 s statement timeout ("Earned by asset":
-- "canceling statement due to statement timeout", 30.10.2026, after the fund
-- transfer pairs of ...143 / ...144). The pairs' legs are now gathered once
-- (as refresh_capital_daily has them) and joined.
--
-- investment_by_asset patched in place: the rest stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.investment_by_asset(date,date,text)'::regprocedure);
  n text;
begin
  n := regexp_replace(d,
    'coalesce\(\(select min\(least\(x\.out_at, x\.in_at\)\)::date from internal_transfers x\s+where x\.user_id = u and x\.matched_by in \(''auto'', ''manual''\)\s+and \(\(x\.out_source = t\.external_source and x\.out_id = t\.external_id\)\s+or \(x\.in_source = t\.external_source and x\.in_id = t\.external_id\)\)\),\s+''infinity''::date\)\) as day,',
    'coalesce(pl.eff, ''infinity''::date)) as day,');
  if n = d then raise exception 'investment_by_asset: the pair subquery not where expected'; end if;
  d := n;
  n := regexp_replace(d,
    'from trades t left join market_prices mp on mp\.ticker = t\.ticker(\s+where t\.user_id = u\s+and not \(t\.ticker)',
    'from trades t left join market_prices mp on mp.ticker = t.ticker
    left join pair_legs pl on pl.src = t.external_source and pl.id = t.external_id\1');
  if n = d then raise exception 'investment_by_asset: the trades of tr not where expected'; end if;
  d := n;
  n := regexp_replace(d, '\n  tr as \(\n',
    E'\n  -- an internal transfer''s two legs count from the day the first of them moved\n'
    || E'  pair_legs as (\n'
    || E'    select src, id, min(eff) as eff from (\n'
    || E'      select out_source as src, out_id as id, least(out_at, in_at)::date as eff\n'
    || E'      from internal_transfers where user_id = u and matched_by in (''auto'', ''manual'')\n'
    || E'      union all\n'
    || E'      select in_source, in_id, least(out_at, in_at)::date\n'
    || E'      from internal_transfers where user_id = u and matched_by in (''auto'', ''manual'')\n'
    || E'    ) l group by src, id\n'
    || E'  ),\n'
    || E'  tr as materialized (\n');
  if n = d then raise exception 'investment_by_asset: tr not where expected'; end if;
  execute n;
end $$;
