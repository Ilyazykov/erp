-- capital_daily_by_type as 046 describes it: migration 046 was pushed
-- first without the TUSD / TEUR split, and an applied migration isn't run
-- again when its file changes -- so the view is (re)defined here. Tinkoff's
-- permanent-portfolio funds TUSD / TEUR (also under their ISINs) split a
-- quarter each into stocks, bonds, gold and money market; FXGD counts as
-- gold, FXTB as a liquid asset, and positions no longer in market_prices
-- whose prices come from MOEX's bond market as bonds.

create or replace view public.capital_daily_by_type
with (security_invoker = true) as
with typed0 as (
  select c.user_id, c.day, c.ticker, c.value_usd,
         (c.account in ('Sber', 'T-Bank', 'Alfa', 'Ozon Bank', 'Yandex Bank', 'Finuslugi')
          or (c.account = '(unspecified)' and mp.infra_region = 'ru')) as ru,
         case
           when c.account = 'real estate' then 'real_estate'
           when c.instrument_type = 'credit' then 'credit'
           -- no longer in market_prices (sold / redeemed): the type from where
           -- its price history comes, or what the fund is
           when mp.ticker is null and ps.source = 'moex_bonds' then 'bond'
           when c.ticker = 'FXGD' then 'gold'
           when c.ticker = 'FXTB' then 'liquid'
           when coalesce(mp.instrument_type, c.instrument_type) in ('cash', 'liquid', 'deposit', 'gold', 'bond', 'stock', 'crypto')
             then coalesce(mp.instrument_type, c.instrument_type)
           else 'stock'
         end as t
  from public.capital_daily c
  left join public.market_prices mp on mp.ticker = c.ticker
  left join public.price_sources ps on ps.ticker = c.ticker
),
typed as (
  select user_id, day, value_usd, ru, t from typed0
  where ticker not in ('TUSD', 'TEUR', 'RU000A1011S9', 'RU000A1011T7')
  union all
  select user_id, day, value_usd * w.share, ru, w.t from typed0
  cross join (values ('stock', 0.25), ('bond', 0.25), ('gold', 0.25), ('liquid', 0.25)) as w(t, share)
  where ticker in ('TUSD', 'TEUR', 'RU000A1011S9', 'RU000A1011T7')
)
select user_id, day,
  round(coalesce(sum(value_usd) filter (where ru and t = 'cash'), 0), 2) as ru_cash,
  round(coalesce(sum(value_usd) filter (where ru and t = 'liquid'), 0), 2) as ru_liquid,
  round(coalesce(sum(value_usd) filter (where ru and t = 'deposit'), 0), 2) as ru_deposit,
  round(coalesce(sum(value_usd) filter (where ru and t = 'gold'), 0), 2) as ru_gold,
  round(coalesce(sum(value_usd) filter (where ru and t = 'bond'), 0), 2) as ru_bond,
  round(coalesce(sum(value_usd) filter (where ru and t = 'stock'), 0), 2) as ru_stock,
  round(coalesce(sum(value_usd) filter (where ru and t = 'crypto'), 0), 2) as ru_crypto,
  round(coalesce(sum(value_usd) filter (where ru and t = 'credit'), 0), 2) as ru_credit,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'cash'), 0), 2) as fx_cash,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'liquid'), 0), 2) as fx_liquid,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'deposit'), 0), 2) as fx_deposit,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'gold'), 0), 2) as fx_gold,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'bond'), 0), 2) as fx_bond,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'stock'), 0), 2) as fx_stock,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'crypto'), 0), 2) as fx_crypto,
  round(coalesce(sum(value_usd) filter (where not ru and t = 'credit'), 0), 2) as fx_credit,
  round(coalesce(sum(value_usd) filter (where t = 'real_estate'), 0), 2) as real_estate
from typed
group by user_id, day;
