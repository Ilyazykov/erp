-- twr_by_asset: each asset's time-weighted return over the period, for the Portfolio map's "TWR".
-- The paper's own day-to-day changes chained, the money moved in and out not counting:
--   1 + r(day) = (value + money out that day) / (value the day before + money in that day)
-- -- money in at the start of the day (a buy is worth its cost before the day's move), money out at
-- its end (a sale, a dividend, a coupon: what the paper gave). TWR = the product - 1, in %.
--
-- The values: capital_daily in dollars, by investment_by_asset's asset (its val: a crypto account's
-- stablecoins and savings are 'USD', staked ETH is ETH, a fund's blocked part is the fund; cash,
-- credit and real estate left out). The money: investment_by_asset's own `cash` per asset, which
-- the page already has -- sent as p_flows [{ asset, cash: [[day, own], ...] }], not worked out
-- again (that rpc takes seconds). capital_daily and the rpc count a trade from the same day
-- (settle date, or the first leg of an internal transfer), so a buy's value and its money meet.
-- An element may name a `group` (the "Earned by asset" chart by type): its assets are then one --
-- their values and money summed by day -- returned under the group's name.
-- p_ccy 'RUB': the values each at its own day's rate, as investment_by_asset's (its `cash` is in
-- the currency asked already).
--
-- A day missing in capital_daily is nothing held (the rows stop when a position is sold out): a
-- day with money moved counts it as 0; a day with no row and no money is skipped, and the next
-- day's change runs from the last value seen. A day with nothing at work (under $0.50: before the
-- first buy, a dividend after the last sale) is skipped. A day the paper lost everything: -100%.
create or replace function public.twr_by_asset(p_from date, p_to date, p_flows jsonb, p_ccy text default 'USD')
returns table (asset text, twr numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  u uuid := auth.uid();
  crypto_accounts text[];
  d1 date;
begin
  if u is null then return; end if;
  crypto_accounts := array(select distinct account from crypto_wallets where user_id = u);
  d1 := least(p_to, (select max(day) from capital_daily where user_id = u));
  return query
  with
  stable as (select unnest(array['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD']) as s),
  wanted as (select distinct x->>'asset' as asset, coalesce(x->>'group', x->>'asset') as grp
             from jsonb_array_elements(coalesce(p_flows, '[]'::jsonb)) x),
  val as (
    select case
             when c.account = any(crypto_accounts) and (upper(c.ticker) in (select s from stable) or c.ticker ~* '^SAVINGS:') then 'USD'
             when upper(c.ticker) in ('STETH', 'WSTETH', 'GG') then 'ETH'
             when upper(c.ticker) in ('TEUR2', 'TUSD2') then left(upper(c.ticker), 4)
             else upper(c.ticker)
           end as asset,
           c.day, sum(c.value_usd)::numeric as v
    from capital_daily c
    where c.user_id = u and c.day between p_from and d1
      and (c.account = any(crypto_accounts)
           or (c.ticker !~ '^(CASH|REAL_ESTATE):' and coalesce(c.instrument_type, '') not in ('cash', 'credit', 'real_estate')))
    group by 1, 2
  ),
  fl as (
    select coalesce(x->>'group', x->>'asset') as grp, (e->>0)::date as day, sum((e->>1)::numeric) as own
    from jsonb_array_elements(coalesce(p_flows, '[]'::jsonb)) x
    cross join lateral jsonb_array_elements(coalesce(x->'cash', '[]'::jsonb)) e
    where (e->>0)::date > p_from and (e->>0)::date <= d1
    group by 1, 2
  ),
  kx as (
    select d.day, case when p_ccy = 'RUB'
                       then 1 / (select f.usd_per_unit from fx_history f where f.currency = 'RUB' and f.day <= d.day order by f.day desc limit 1)
                       else 1 end as k
    from (select distinct day from val) d
  ),
  gval as (select w.grp, v.day, sum(v.v * k.k) as v from val v join wanted w on w.asset = v.asset join kx k on k.day = v.day group by 1, 2),
  pts as (
    select coalesce(v.grp, f.grp) as asset, coalesce(v.day, f.day) as day, coalesce(v.v, 0) as v, coalesce(f.own, 0) as own
    from gval v full join fl f on f.grp = v.grp and f.day = v.day
  ),
  steps as (
    select p.asset, p.day, p.v, p.own, coalesce(lag(p.v) over (partition by p.asset order by p.day), 0) as v_prev
    from pts p
  ),
  growth as (
    select asset, (v + greatest(-own, 0)) / (v_prev + greatest(own, 0)) as g
    from steps
    where day > p_from and v_prev + greatest(own, 0) >= 0.5
  )
  select gr.asset, case when bool_or(gr.g <= 0) then -100::numeric
                        else round(((exp(sum(ln(greatest(gr.g, 1e-12)))) - 1) * 100)::numeric, 4) end
  from growth gr group by gr.asset;
end $$;
revoke all on function public.twr_by_asset(date, date, jsonb, text) from public, anon;
grant execute on function public.twr_by_asset(date, date, jsonb, text) to authenticated;
