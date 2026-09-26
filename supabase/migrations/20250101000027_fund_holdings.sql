-- Look-through of the funds held here: what each fund consists of, and
-- the securities themselves, matched across issuers.
--
-- securities: one row per security, keyed by ISIN (the one identifier
--   every issuer gives): a single name, GICS sector and country whatever
--   issuer lists it (iShares "NVIDIA", Vanguard "NVIDIA Corp" -> one row),
--   and always a country (of risk) and trading currency.
--   market_ticker links a security the user holds directly to its
--   market_prices row -- set by ISIN (MOEX ISS for Russian shares, the
--   issuers' own lists for US ones), not by ticker text: Vanguard's "T" is
--   AT&T, ours is T-Technologies. Every security has a ticker: the
--   issuer's, else MOEX's, else OpenFIGI's home-exchange one. Positions with no ISIN (cash, futures, FX
--   forwards, a fund's "other") share one row, id 'OTHER'.
-- fund_holdings: fund x security with the weight (% of the fund's net
--   assets; a short cash / FX line can be slightly negative); `fund` is
--   the fund's market_prices ticker (VWRA and VWCE are two listings of one
--   Vanguard fund, so they carry the same list). Several lines of one
--   security in an issuer's list (lots, listings) are summed.
-- Both public data (read by everyone, written only by update-fund-holdings
-- with the service role -- same pattern as market_prices); each run
-- replaces a fund's rows with its issuer's latest list.

create table public.securities (
  id text primary key,             -- ISIN; 'OTHER'; 'TICKER:<ticker>' for a directly held share in no fund's list
  isin text,
  ticker text not null,            -- exchange ticker (MOEX secid, US ticker, home-exchange ticker; the ISIN only if none is found)
  market_ticker text unique,       -- market_prices.ticker of a directly held security
  name text not null,
  sector text,                     -- GICS sector ('Information Technology', ...)
  country text not null,           -- 'United States', 'Russia', ... (country of risk)
  country_code text not null,      -- ISO 3166 alpha-2 ('US', 'RU'); 'XX' for OTHER
  currency text not null,          -- trading currency ('USD', 'RUB', 'EUR', ...)
  asset_class text,                -- 'Equity', 'Bond', 'Other'
  updated_at timestamptz not null default now()
);
alter table public.securities enable row level security;
create policy "anyone can read securities" on public.securities
  for select using (true);
insert into public.securities (id, ticker, name, country, country_code, currency, asset_class)
values ('OTHER', 'OTHER', 'Деньги, деривативы и прочее', 'Various', 'XX', 'Various', 'Other');

create table public.fund_holdings (
  fund text not null,              -- 'CSPX'
  security_id text not null references public.securities(id),
  weight numeric not null,         -- % of the fund
  raw_name text,                   -- the name as this issuer lists it
  as_of date not null,             -- the date the issuer's list is for
  source text not null,            -- 'ishares.com', 'vanguard.co.uk', ...
  updated_at timestamptz not null default now(),
  primary key (fund, security_id)
);
alter table public.fund_holdings enable row level security;
create policy "anyone can read fund holdings" on public.fund_holdings
  for select using (true);

-- The caller's portfolio seen through its funds: one row per (security,
-- how it's held) -- 'direct' for a share held outright, the fund's ticker
-- for the part held via that fund (fund value x weight). Sum by
-- security_id for the real exposure.
create view public.portfolio_look_through
with (security_invoker = true) as
with pv as (
  select user_id, ticker, value_usd from public.portfolio_value_usd
  where coalesce(value_usd, 0) <> 0
)
select pv.user_id, s.id as security_id, s.name, s.ticker, s.sector, s.country, s.currency, s.asset_class,
       'direct'::text as via, pv.value_usd
from pv join public.securities s on s.market_ticker = pv.ticker
union all
select pv.user_id, s.id, s.name, s.ticker, s.sector, s.country, s.currency, s.asset_class,
       pv.ticker, pv.value_usd * fh.weight / 100
from pv
join public.fund_holdings fh on fh.fund = pv.ticker
join public.securities s on s.id = fh.security_id;

-- Per security: the real exposure (direct + through every fund), largest
-- first; `via` = {how held: USD}.
create view public.portfolio_look_through_totals
with (security_invoker = true) as
select user_id, security_id, name, ticker, sector, country, currency, asset_class,
       sum(value_usd) as value_usd,
       sum(value_usd) filter (where via = 'direct') as direct_usd,
       jsonb_object_agg(via, round(value_usd::numeric, 2)) as via
from (
  select user_id, security_id, name, ticker, sector, country, currency, asset_class, via, sum(value_usd) as value_usd
  from public.portfolio_look_through
  group by user_id, security_id, name, ticker, sector, country, currency, asset_class, via
) t
group by user_id, security_id, name, ticker, sector, country, currency, asset_class;

-- The same exposure by sector, by country and by currency (a few rows
-- each -- the per-security list runs to thousands).
create view public.portfolio_look_through_by_sector
with (security_invoker = true) as
select user_id, coalesce(sector, case when security_id = 'OTHER' then 'Cash / other' else 'Unclassified' end) as sector,
       sum(value_usd) as value_usd
from public.portfolio_look_through group by 1, 2;

create view public.portfolio_look_through_by_country
with (security_invoker = true) as
select user_id, country,
       sum(value_usd) as value_usd
from public.portfolio_look_through group by 1, 2;

create view public.portfolio_look_through_by_currency
with (security_invoker = true) as
select user_id, currency, sum(value_usd) as value_usd
from public.portfolio_look_through group by 1, 2;

-- TRND (T-Capital "Трендовые акции") has no list the function can fetch
-- (tbank.ru is unreachable from outside Russia; T-Capital publishes only
-- monthly PDF reports), so it's seeded once from its net-asset report as
-- of 27.02.2026 ("Справка о стоимости чистых активов", positions valued
-- in RUB, weights = value / net assets 581 869 638,83; reverse repo, cash
-- and liabilities together as OTHER); the function doesn't touch TRND's
-- rows. Stale by design -- replace when a newer list is at hand.
insert into public.securities (id, isin, ticker, name, sector, country, country_code, currency, asset_class) values
  ('RU0007288411', 'RU0007288411', 'GMKN', 'Норильский никель', 'Materials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JP5V6', 'RU000A0JP5V6', 'VTBR', 'ВТБ', 'Financials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0009029540', 'RU0009029540', 'SBER', 'Сбербанк', 'Financials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A107T19', 'RU000A107T19', 'YDEX', 'Яндекс', 'Communication Services', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JNAA8', 'RU000A0JNAA8', 'PLZL', 'Полюс', 'Materials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A10CW95', 'RU000A10CW95', 'OZON', 'Озон', 'Consumer Discretionary', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A107UL4', 'RU000A107UL4', 'T', 'Т-Технологии', 'Financials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A102S15', 'RU000A102S15', 'LENT', 'Лента', 'Consumer Staples', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0007775219', 'RU0007775219', 'MTSS', 'МТС', 'Communication Services', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0DKVS5', 'RU000A0DKVS5', 'NVTK', 'НОВАТЭК', 'Energy', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0009091573', 'RU0009091573', 'TRNFP', 'Транснефть (прив.)', 'Energy', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A108KL3', 'RU000A108KL3', 'MDMG', 'МД Медикал Груп', 'Health Care', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JKQU8', 'RU000A0JKQU8', 'MGNT', 'Магнит', 'Consumer Staples', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JPPN4', 'RU000A0JPPN4', 'MRKV', 'Россети Волга', 'Utilities', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0ZZFU5', 'RU000A0ZZFU5', 'DOMRF', 'ДОМ.РФ', 'Financials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A1025V3', 'RU000A1025V3', 'RUAL', 'РУСАЛ', 'Materials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JPN96', 'RU000A0JPN96', 'MRKP', 'Россети Центр и Приволжье', 'Utilities', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0009084396', 'RU0009084396', 'MAGN', 'ММК', 'Materials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0009092134', 'RU0009092134', 'LSNGP', 'Россети Ленэнерго (прив.)', 'Utilities', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JPP37', 'RU000A0JPP37', 'UGLD', 'Южуралзолото', 'Materials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0007661625', 'RU0007661625', 'GAZP', 'Газпром', 'Energy', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JR4A1', 'RU000A0JR4A1', 'MOEX', 'Московская биржа', 'Financials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0008926258', 'RU0008926258', 'SNGS', 'Сургутнефтегаз', 'Energy', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0008943394', 'RU0008943394', 'RTKM', 'Ростелеком', 'Communication Services', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU0009062285', 'RU0009062285', 'AFLT', 'Аэрофлот', 'Industrials', 'Russia', 'RU', 'RUB', 'Equity'),
  ('RU000A0JPPL8', 'RU000A0JPPL8', 'MRKC', 'Россети Центр', 'Utilities', 'Russia', 'RU', 'RUB', 'Equity')
on conflict (id) do nothing;
insert into public.fund_holdings (fund, security_id, weight, raw_name, as_of, source) values
  ('TRND', 'OTHER', 11.3294, 'Деньги, РЕПО и обязательства', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0007288411', 9.5431, 'Норильский никель', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JP5V6', 8.1935, 'ВТБ', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0009029540', 7.706, 'Сбербанк', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A107T19', 7.4935, 'Яндекс', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JNAA8', 6.2974, 'Полюс', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A10CW95', 5.8317, 'Озон', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A107UL4', 4.9597, 'Т-Технологии', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A102S15', 4.1228, 'Лента', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0007775219', 3.5049, 'МТС', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0DKVS5', 3.4324, 'НОВАТЭК', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0009091573', 3.0372, 'Транснефть (прив.)', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A108KL3', 3.0104, 'МД Медикал Груп', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JKQU8', 2.5929, 'Магнит', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JPPN4', 2.5453, 'Россети Волга', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0ZZFU5', 2.545, 'ДОМ.РФ', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A1025V3', 2.056, 'РУСАЛ', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JPN96', 1.9934, 'Россети Центр и Приволжье', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0009084396', 1.9132, 'ММК', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0009092134', 1.7623, 'Россети Ленэнерго (прив.)', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JPP37', 1.4839, 'Южуралзолото', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0007661625', 1.2077, 'Газпром', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JR4A1', 1.1567, 'Московская биржа', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0008926258', 0.6706, 'Сургутнефтегаз', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0008943394', 0.5945, 'Ростелеком', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU0009062285', 0.519, 'Аэрофлот', '2026-02-27', 't-capital-funds.ru (PDF)'),
  ('TRND', 'RU000A0JPPL8', 0.4973, 'Россети Центр', '2026-02-27', 't-capital-funds.ru (PDF)');

-- Monthly refresh on the 2nd, 21:00 UTC: Vanguard publishes month-end
-- lists; iShares / DWS / Alfa-Capital lists are more recent anyway.
select cron.unschedule(jobid) from cron.job where jobname = 'update-fund-holdings';
select cron.schedule(
  'update-fund-holdings',
  '0 21 2 * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-fund-holdings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
