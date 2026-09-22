-- Account/broker-aware holdings, for the My Portfolio "broker x currency" /
-- "broker x asset class" summary tables. This is a separate parallel view
-- rather than adding `account` to the existing `current_holdings` /
-- `portfolio_value_usd` views, because those aggregate by (user_id, ticker)
-- only -- adding account to that grouping would silently split any
-- existing per-ticker row into multiple rows wherever a ticker spans more
-- than one account, changing behavior for code that already depends on
-- today's shape (mpRenderHoldings, mpRenderPortfolioPies).
--
-- account is coalesced to '(unspecified)' here rather than left null: most
-- existing trades (everything imported from Snowball) have no account
-- recorded (see 20250101000007_trades_account.sql), and a single
-- consistent bucket label reads better in a summary table than a blank row.
create view public.current_holdings_by_account
with (security_invoker = true) as
select
  user_id,
  ticker,
  coalesce(account, '(unspecified)') as account,
  sum(case when side in ('buy', 'stock_as_dividend') then quantity
           when side = 'sell' then -quantity
           else 0 end) as quantity
from public.trades
group by user_id, ticker, coalesce(account, '(unspecified)')
having sum(case when side in ('buy', 'stock_as_dividend') then quantity
                when side = 'sell' then -quantity
                else 0 end) <> 0;

create view public.portfolio_value_usd_by_account
with (security_invoker = true) as
select
  h.user_id,
  h.ticker,
  h.account,
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
from public.current_holdings_by_account h
left join public.market_prices p on p.ticker = h.ticker;
