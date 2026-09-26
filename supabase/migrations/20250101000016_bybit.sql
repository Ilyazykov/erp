-- Bybit, imported from its own Data Export CSVs (import-bybit): the account
-- is stored like a crypto wallet -- a crypto_wallets row (chain 'bybit',
-- address 'UID <uid>', account 'Bybit'), every line of its Funding and
-- Unified Trading transaction logs in wallet_transactions, and the per-coin
-- balance they add up to in wallet_balances, which the holdings views
-- already count. It's custodial, so sync-crypto-wallets (blockchain sync)
-- skips it.

alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana', 'bybit'));

-- Bybit's own logs replace the Snowball trades that recorded it (the rows
-- noted "bybit": BTC buys and hand-entered month-end interest); the logs
-- have every trade and every daily interest distribution. import-trades-csv
-- skips "bybit" rows from now on, so re-uploading Snowball doesn't bring
-- them back.
delete from public.trades
where external_source = 'snowball_csv' and note = 'bybit';
