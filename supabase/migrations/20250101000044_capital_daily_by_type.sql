-- Capital by asset type per day, for the Capital tab's stacked chart: one
-- row a day (a few thousand rows rather than one per position), the sums
-- split by infrastructure -- Russian (ru_*) or not (fx_*) -- because the
-- page nets credit-card debt within its own infrastructure, as the
-- My Portfolio tables do (mpNetCreditIntoLiquid: Russian debt only against
-- Russian holdings). The Russian accounts are index.html's MP_RU_ACCOUNTS.
-- Type: market_prices' instrument_type where it has one (so a wallet's
-- stablecoin counts as cash, XAUT as gold), else capital_daily's own.

create view public.capital_daily_by_type
with (security_invoker = true) as
with typed as (
  select c.user_id, c.day, c.value_usd,
         (c.account in ('Sber', 'T-Bank', 'Alfa', 'Ozon Bank', 'Yandex Bank', 'Finuslugi')
          or (c.account = '(unspecified)' and mp.infra_region = 'ru')) as ru,
         case
           when c.account = 'real estate' then 'real_estate'
           when c.instrument_type = 'credit' then 'credit'
           when coalesce(mp.instrument_type, c.instrument_type) in ('cash', 'liquid', 'deposit', 'gold', 'bond', 'stock', 'crypto')
             then coalesce(mp.instrument_type, c.instrument_type)
           else 'stock'
         end as t
  from public.capital_daily c
  left join public.market_prices mp on mp.ticker = c.ticker
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
