-- The portfolio map took long to open (27.11.2026): the page read ~50 pages one after another --
-- 9,300 fund constituents, 4,000 securities by 200, the currencies' whole rate history -- and asked
-- investment_by_asset for each period it was shown. Now the capital refresh (run when the prices
-- and the deals change) puts all of it into one row per user: the page reads that row and draws.
--   holdings  [fund, ticker, weight %, name] -- the constituents with a market ticker
--   savings   the savings products' buys and sells (the map's savings links)
--   fx        per currency, the rates in force on the periods' first days and today (fxChange)
--   earned    per period: its first day and investment_by_asset's rows from it to today
-- The periods' first days as the page's periodStart (js/lookthrough_treemap.js); 'all' from the
-- first buy. A row of another day's periods is used for what doesn't depend on the day only.

create table if not exists public.treemap_snapshots (
  user_id uuid primary key references auth.users (id) on delete cascade,
  built_at timestamptz not null default now(),
  built_on date not null,
  data jsonb not null
);
alter table public.treemap_snapshots enable row level security;
drop policy if exists "own treemap snapshot" on public.treemap_snapshots;
create policy "own treemap snapshot" on public.treemap_snapshots for select using (auth.uid() = user_id);
grant select on public.treemap_snapshots to authenticated;

create or replace function public.refresh_treemap_snapshot(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := current_date;
  first_day date;
  periods jsonb := '{}';
  earned jsonb := '{}';
  p record;
  rows jsonb;
  claims text := current_setting('request.jwt.claims', true);
begin
  select min(trade_date) into first_day from trades where user_id = p_user and side = 'buy';
  for p in
    select * from (values
      ('1d', today - 1), ('2d', today - 2), ('3d', today - 3), ('4d', today - 4), ('7d', today - 7),
      ('1m', (today - interval '1 month')::date), ('3m', (today - interval '3 months')::date),
      ('6m', (today - interval '6 months')::date), ('1y', (today - interval '12 months')::date),
      ('5y', (today - interval '60 months')::date), ('ytd', make_date(extract(year from today)::int - 1, 12, 31)),
      ('all', coalesce(first_day, '2000-01-01'::date)), ('snowball', '2025-08-28'::date)
    ) v(period, from_day)
  loop
    periods := periods || jsonb_build_object(p.period, p.from_day);
    -- investment_by_asset is the signed-in user's (auth.uid()): it runs as this one
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    select coalesce(jsonb_agg(to_jsonb(r)), '[]') into rows from investment_by_asset(p.from_day, today, 'USD') r;
    perform set_config('request.jwt.claims', coalesce(claims, ''), true);
    earned := earned || jsonb_build_object(p.period, jsonb_build_object('from', p.from_day, 'rows', rows));
  end loop;

  insert into treemap_snapshots (user_id, built_at, built_on, data)
  values (p_user, now(), today, jsonb_build_object(
    'first_day', first_day,
    'frozen', (select coalesce(jsonb_agg(ticker), '[]') from price_freezes),
    'holdings', (select coalesce(jsonb_agg(jsonb_build_array(h.fund, coalesce(s.market_ticker, s.ticker), h.weight, s.name)
                                 order by h.fund, h.security_id), '[]')
                 from fund_holdings h join securities s on s.id = h.security_id
                 where h.security_id <> 'OTHER' and coalesce(s.market_ticker, s.ticker) is not null),
    'savings', (select coalesce(jsonb_agg(jsonb_build_object('ticker', ticker, 'side', side, 'quantity', quantity, 'price', price,
                                 'trade_date', trade_date, 'currency', currency, 'note', note, 'id', id) order by trade_date, id), '[]')
                from trades where user_id = p_user and side in ('buy', 'sell')
                  and (ticker like 'SAVINGS:%' or ticker like 'DEPOSIT:%' or ticker like 'ВКЛАД:%')),
    're_index', (select coalesce(jsonb_agg(jsonb_build_object('month', month, 'price_per_m2', price_per_m2) order by month), '[]')
                 from real_estate_index where city = 'nizhny_novgorod'),
    -- the rate in force on each day wanted: the last one on or before it, at its own day
    'fx', (select coalesce(jsonb_object_agg(currency, pts), '{}') from (
             select currency, jsonb_agg(jsonb_build_array(day, usd_per_unit) order by day) as pts from (
               select distinct f.currency, f.day, f.usd_per_unit
               from (select distinct currency from fx_history) c
               cross join (select (value #>> '{}')::date as d from jsonb_each(periods) union select today) w
               cross join lateral (select * from fx_history x where x.currency = c.currency and x.day <= w.d
                                   order by x.day desc limit 1) f
             ) z group by currency) y),
    'earned', earned))
  on conflict (user_id) do update set built_at = excluded.built_at, built_on = excluded.built_on, data = excluded.data;
end $$;
revoke execute on function public.refresh_treemap_snapshot(uuid) from public, anon, authenticated;

-- the capital refresh, done, builds it (a failure leaves the old one: the refresh goes on)
do $mig$
declare
  d text := pg_get_functiondef('public.run_capital_refresh_step()'::regprocedure);
  a text := E'      perform refresh_expenses(q.user_id);\n      update capital_refresh_queue\n      set started_at = started, rows_total = total, next_from = null,';
  b text := E'      perform refresh_expenses(q.user_id);\n'
         || E'      -- the portfolio map\'s data (migration ...267)\n'
         || E'      begin perform refresh_treemap_snapshot(q.user_id);\n'
         || E'      exception when others then raise warning \'treemap snapshot: %\', sqlerrm; end;\n'
         || E'      update capital_refresh_queue\n      set started_at = started, rows_total = total, next_from = null,';
begin
  if position('migration ...267' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'run_capital_refresh_step: the finish not found'; end if;
  execute replace(d, a, b);
end $mig$;

-- the first one now
select public.refresh_treemap_snapshot(user_id) from public.capital_refresh_queue;
