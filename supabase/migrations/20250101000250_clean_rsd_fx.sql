-- The dinar's rate. Yahoo's RSDUSD=X has bad quotes, mostly on Sundays and
-- Mondays (113.5-114 RSD per euro against the real ~117), and its live price
-- comes rounded to 0.0094, about 1% off. The National Bank of Serbia keeps
-- RSD/EUR in a narrow band, so a day more than 0.5% from the median of the 10
-- days around it is a bad quote: it's set to that median at the day's euro rate.
-- What was replaced stays in fx_rate_fixes.
create table if not exists public.fx_rate_fixes (
  currency text not null,
  day date not null,
  original numeric not null,
  fixed numeric not null,
  fixed_at timestamptz not null default now(),
  primary key (currency, day)
);
alter table public.fx_rate_fixes enable row level security;

-- p_from: only the days from it (their medians still see the days before it).
create or replace function public.clean_rsd_fx(p_from date default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  with y as (
    select r.day, r.usd_per_unit as rsd, e.eur, e.eur / r.usd_per_unit as v
    from fx_history r
    cross join lateral (select x.usd_per_unit as eur from fx_history x
                        where x.currency = 'EUR' and x.day <= r.day order by x.day desc limit 1) e
    where r.currency = 'RSD' and r.usd_per_unit > 0 and (p_from is null or r.day >= p_from - 15)
  ), w as (
    select *, array_agg(v) over (order by day range between interval '10 days' preceding and interval '10 days' following) as around
    from y
  ), m as (
    select day, rsd, eur, v, (select percentile_disc(0.5) within group (order by u) from unnest(around) u) as med
    from w
  ), bad as (
    select day, rsd, eur / med as fixed from m
    where (p_from is null or day >= p_from) and abs(v / med - 1) > 0.005
  ), logged as (
    insert into fx_rate_fixes (currency, day, original, fixed)
    select 'RSD', day, rsd, fixed from bad
    on conflict (currency, day) do update set original = excluded.original, fixed = excluded.fixed, fixed_at = now()
  )
  update fx_history f set usd_per_unit = bad.fixed
  from bad where f.currency = 'RSD' and f.day = bad.day;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- RSD per euro now: the median of the last 30 days, for the live rate.
create or replace function public.rsd_per_eur()
returns numeric
language sql stable security definer set search_path = public as $$
  select percentile_disc(0.5) within group (order by e.usd_per_unit / r.usd_per_unit)
  from fx_history r
  join fx_history e on e.currency = 'EUR' and e.day = r.day
  where r.currency = 'RSD' and r.usd_per_unit > 0
    and r.day >= (select max(day) from fx_history where currency = 'RSD') - 30
$$;

revoke all on function public.clean_rsd_fx(date) from public, anon, authenticated;
revoke all on function public.rsd_per_eur() from public, anon, authenticated;
grant execute on function public.clean_rsd_fx(date) to service_role;
grant execute on function public.rsd_per_eur() to service_role;

-- The history once, and capital recounted from the first day that changed.
do $$
declare
  v_first date;
begin
  perform public.clean_rsd_fx();
  select min(day) into v_first from public.fx_rate_fixes where currency = 'RSD';
  if v_first is not null then
    update public.capital_refresh_queue
    set dirty_from = least(coalesce(dirty_from, v_first), v_first), requested_at = now();
  end if;
end $$;
