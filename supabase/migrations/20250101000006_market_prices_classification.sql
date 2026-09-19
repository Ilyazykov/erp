-- Explicit classification columns for `market_prices`, replacing scattered
-- string-matching/ticker-list special cases in the frontend (e.g. "is this
-- ticker SBBY or TLCB" checks) with structured data set once, at write
-- time, by the update-market-prices Edge Function -- see
-- CURRENCY_OVERRIDE_BY_TICKER / MOEX_BOND_ETF_TICKERS there for the
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
alter table public.market_prices add column if not exists infra_region text;
alter table public.market_prices add column if not exists instrument_type text;

-- Update the portfolio_value_usd view to also expose these two columns,
-- so the frontend can filter/group the My Portfolio pie charts by them
-- directly instead of re-deriving asset_class/currency special cases.
create or replace view public.portfolio_value_usd
with (security_invoker = true) as
select
  h.user_id,
  h.ticker,
  h.quantity,
  p.price_usd,
  p.currency,
  p.asset_class,
  p.infra_region,
  p.instrument_type,
  p.source,
  p.as_of,
  case when p.price_usd is not null then h.quantity * p.price_usd else null end as value_usd
from public.current_holdings h
left join public.market_prices p on p.ticker = h.ticker;
