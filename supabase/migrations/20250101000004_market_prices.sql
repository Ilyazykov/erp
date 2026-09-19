-- Daily market-price snapshot for every ticker that can appear in a user's
-- `trades` (MOEX shares/bonds, US stocks, crypto/metals, Western ETFs).
--
-- This table is NOT user data -- it's public market prices, the same for
-- everyone -- so it carries no user_id and needs no per-row RLS ownership
-- check, just a read-everyone / write-nobody-except-service-role policy.
-- It is populated once a day by the `update-market-prices` Edge Function
-- (see supabase/functions/update-market-prices/index.ts), triggered
-- entirely inside Supabase by pg_cron + pg_net (see
-- supabase/migrations/20250101000005_schedule_market_prices.sql) -- no
-- GitHub Actions involved in this refresh. The function writes to this
-- table using the Supabase service_role key -- the service role bypasses
-- RLS entirely, so the "no insert/update policy for anon/authenticated"
-- below is what actually keeps this table read-only from the browser.

create table public.market_prices (
  ticker text primary key,
  price_usd numeric not null,
  native_price numeric,
  currency text,
  asset_class text,        -- 'moex_share', 'moex_bond', 'us_stock', 'crypto', 'western_etf', ...
  source text,              -- 'moex_iss', 'yahoo_finance'
  as_of date,                -- trading/reference date the price corresponds to
  updated_at timestamptz not null default now()
);

alter table public.market_prices enable row level security;

-- Anyone (including anon, unauthenticated visitors) can read prices --
-- they're public market data, not tied to any individual user.
create policy "anyone can read market prices" on public.market_prices
  for select using (true);

-- Deliberately no insert/update/delete policy for anon/authenticated roles:
-- only the service_role key (used exclusively by the daily
-- update-market-prices Edge Function, invoked by pg_cron) can write here,
-- since service_role bypasses RLS by design.

-- Portfolio value in USD: joins each user's current_holdings quantity with
-- the latest market_prices snapshot for that ticker. A ticker with no
-- matching price row still shows up with its quantity, just with a null
-- price/value (left join), so one missing/unresolved ticker never breaks
-- the whole query or hides the rest of the portfolio.
--
-- security_invoker = true: this view still runs as the querying user for
-- the current_holdings side, so RLS on `trades` continues to restrict each
-- user to their own holdings. market_prices itself is world-readable, so
-- there is no extra restriction to inherit from that side.
create view public.portfolio_value_usd
with (security_invoker = true) as
select
  h.user_id,
  h.ticker,
  h.quantity,
  p.price_usd,
  p.currency,
  p.asset_class,
  p.source,
  p.as_of,
  case when p.price_usd is not null then h.quantity * p.price_usd else null end as value_usd
from public.current_holdings h
left join public.market_prices p on p.ticker = h.ticker;
