-- Current portfolio holdings, computed from trade history (not stored/entered
-- manually). BUY/STOCK_AS_DIVIDEND add quantity, SELL removes it. DIVIDEND,
-- AMORTISATION and REPAYMENT are cash events (bond coupon/principal payments,
-- dividend payouts) -- they don't change how many units of a ticker you hold,
-- so they're tracked separately as accumulated cash, not folded into quantity.
--
-- RLS on the view follows the security_invoker setting: with it on, the
-- view runs with the querying user's own permissions, so the RLS policy on
-- `trades` (auth.uid() = user_id) applies here too -- each user only ever
-- sees their own holdings, same guarantee as the underlying table.

create view public.current_holdings
with (security_invoker = true) as
select
  user_id,
  ticker,
  sum(case when side in ('buy', 'stock_as_dividend') then quantity
           when side = 'sell' then -quantity
           else 0 end) as quantity
from public.trades
group by user_id, ticker
having sum(case when side in ('buy', 'stock_as_dividend') then quantity
                when side = 'sell' then -quantity
                else 0 end) <> 0;

create view public.cash_flows
with (security_invoker = true) as
select
  user_id,
  ticker,
  currency,
  side,
  sum(quantity) as total_amount
from public.trades
where side in ('dividend', 'amortisation', 'repayment')
group by user_id, ticker, currency, side;
