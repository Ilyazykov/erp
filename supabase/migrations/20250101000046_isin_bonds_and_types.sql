-- 1) Bonds held by ISIN (OFZ 29012 is RU000A0JX0H6 in the T-Bank report,
--    SU29012RMFS0 on MOEX): update-capital-history now finds MOEX's code
--    by the ISIN; the "found nowhere" it cached for such tickers is
--    dropped so they're looked up again on the next run.
-- 2) capital_daily_by_type (044): a position no longer in market_prices
--    had no type but capital_daily's default 'stock' -- bonds redeemed or
--    sold since now count as bonds (their prices come from MOEX's bond
--    market), FinEx's FXGD as gold and FXTB (USD cash equivalent) as a
--    liquid asset; Tinkoff's permanent-portfolio funds TUSD / TEUR
--    (also under their ISINs, as T-Bank's report names them when sold)
--    split a quarter each into stocks, bonds, gold and money market (the
--    strategy's equal classes) -- approximately: the actual weights drift.
--    Every other fund held counts as stocks (FinEx FXUS / FXIT / FXCN /
--    FXWO / FXDE, ITI RUSE, Tinkoff TSPX / TIPO / TBIO / TECH / TGRN /
--    TSOX / TPAS (Pan-Asia) / TEUS (Eurostocks 50)).

delete from public.price_sources
where source = 'none' and ticker ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$';

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
