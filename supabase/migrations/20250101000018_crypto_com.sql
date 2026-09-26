-- Crypto.com App, imported from its own transaction export (import-crypto-com),
-- stored like Bybit (20250101000016_bybit.sql): a crypto_wallets row with
-- chain 'cryptocom', its rows in wallet_transactions, balances in
-- wallet_balances. Custodial, so sync-crypto-wallets skips it.

alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana', 'bybit', 'cryptocom'));

-- Crypto.com's own export replaces the Snowball trades that recorded it (rows
-- noted "crypto.com": BTC buys and hand-entered month-end interest);
-- import-trades-csv skips them from now on.
delete from public.trades
where external_source = 'snowball_csv' and note = 'crypto.com';

-- Snowball's month-end BTC interest for June-August 2026 has no note: it's
-- Bybit's and Crypto.com's interest lumped together, estimated by hand. Both
-- exchanges' daily interest now comes from their own logs, so these three
-- rows stay as history but out of current holdings (see
-- 20250101000017_holding_exclusions.sql).
insert into public.holding_exclusions (user_id, external_source, external_id, reason)
select user_id, external_source, external_id,
  'Month-end BTC interest for Bybit + Crypto.com, replaced by their daily interest from the exchange logs'
from public.trades
where external_source = 'snowball_csv' and ticker = 'BTC' and side = 'stock_as_dividend'
  and (note is null or note = '')
  and trade_date in ('2026-06-30', '2026-07-31', '2026-08-31')
on conflict do nothing;
