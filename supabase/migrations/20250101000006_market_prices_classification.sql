-- Explicit classification columns for `market_prices`, replacing scattered
-- string-matching/ticker-list special cases in the frontend (e.g. "is this
-- ticker SBBY or TLCB" checks) with structured data set once, at write
-- time, by the update-market-prices Edge Function -- see
-- UNDERLYING_CURRENCY_BY_TICKER / MOEX_BOND_ETF_TICKERS there for the
-- classification logic that now writes into these columns instead of the
-- frontend re-deriving it from asset_class/currency.
--
-- infra_region: which market infrastructure this trades on -- 'ru' (MOEX)
-- vs 'foreign' (everything else: US exchanges, LSE/Xetra UCITS ETFs,
-- crypto exchanges). Text, not boolean, so a third region (e.g. a future
-- Hong Kong/Kazakhstan listing) doesn't require a schema change.
--
-- instrument_type: what the asset fundamentally is, independent of where
-- it trades -- 'stock', 'bond' (includes bond/money-market ETFs like
-- TBRU/SBMM/AKMB, and RUB bank deposits), 'gold', 'crypto'.
--
-- underlying_currency: the currency the asset/fund's holdings are actually
-- denominated in -- distinct from `currency`, which is whatever currency
-- the exchange happens to quote the price in. E.g. MOEX quotes SBBY/TLCB's
-- per-unit price in RUB (so `currency` = 'RUB' for them, honestly
-- reflecting the quote), but both funds hold CNY-denominated bonds, so
-- `underlying_currency` = 'CNY' for them. For everything else the two
-- currently coincide (underlying_currency defaults to `currency`).
alter table public.market_prices add column if not exists infra_region text;
alter table public.market_prices add column if not exists instrument_type text;
alter table public.market_prices add column if not exists underlying_currency text;

-- Update the portfolio_value_usd view to also expose these two columns,
-- so the frontend can filter/group the My Portfolio pie charts by them
-- directly instead of re-deriving asset_class/currency special cases.
--
-- New columns are appended at the END of the select list -- Postgres'
-- `create or replace view` requires every pre-existing output column to
-- keep its name AND ordinal position; it errors ("cannot change name of
-- view column...") if a new column is inserted in the middle, since that
-- shifts every later column's position even though its name is unchanged.
create or replace view public.portfolio_value_usd
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
  case when p.price_usd is not null then h.quantity * p.price_usd else null end as value_usd,
  p.infra_region,
  p.instrument_type,
  p.underlying_currency
from public.current_holdings h
left join public.market_prices p on p.ticker = h.ticker;
