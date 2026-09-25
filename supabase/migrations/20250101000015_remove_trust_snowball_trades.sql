-- Trust Wallet's coins come from the blockchain now (sync-crypto-wallets),
-- so the Snowball trades that recorded them are removed outright instead of
-- being hidden by an exclusion rule (20250101000013_crypto_wallets.sql's
-- trade_exclusions, dropped here along with its filter in the holdings
-- views). They're the Snowball rows noted "trust" -- the 4 ETH buys into
-- Trust. Other Snowball ETH rows aren't Trust's and stay (user-confirmed):
--   * BUY 2025-08-30, note "telegram" -- bought in Telegram Wallet
--   * SELL 2025-09-19, note "telegram -> trust" -- the transfer fee, paid on
--     the Telegram (sending) side: Trust's on-chain history starts with that
--     incoming transfer and shows no fee paid by Trust
--   * STOCK_AS_DIVIDEND, monthly
-- import-trades-csv now skips "trust" rows too, so re-uploading a Snowball
-- export doesn't bring them back.

delete from public.trades
where external_source = 'snowball_csv' and note = 'trust';

-- Holdings = trades + on-chain wallet balances (no exclusions any more).
create or replace view public.current_holdings
with (security_invoker = true) as
select user_id, ticker, sum(qty) as quantity
from (
  select t.user_id, t.ticker,
    case when t.side in ('buy', 'stock_as_dividend') then t.quantity
         when t.side = 'sell' then -t.quantity
         else 0 end as qty
  from public.trades t
  union all
  select w.user_id, w.ticker, w.quantity
  from public.wallet_balances w
  where w.ticker is not null
) x
group by user_id, ticker
having sum(qty) <> 0;

create or replace view public.current_holdings_by_account
with (security_invoker = true) as
select user_id, ticker, account, sum(qty) as quantity
from (
  select t.user_id, t.ticker, coalesce(t.account, '(unspecified)') as account,
    case when t.side in ('buy', 'stock_as_dividend') then t.quantity
         when t.side = 'sell' then -t.quantity
         else 0 end as qty
  from public.trades t
  union all
  select w.user_id, w.ticker, w.account, w.quantity
  from public.wallet_balances w
  where w.ticker is not null
) x
group by user_id, ticker, account
having sum(qty) <> 0;

drop table public.trade_exclusions;
