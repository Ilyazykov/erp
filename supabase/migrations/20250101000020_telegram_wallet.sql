-- Telegram Wallet (@wallet), imported from its scraped history
-- (import-telegram-wallet), stored like the exchanges
-- (20250101000018_crypto_com.sql): a crypto_wallets row with chain
-- 'telegram', its rows in wallet_transactions, balances in wallet_balances.
-- Custodial, so sync-crypto-wallets skips it.

alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana', 'bybit', 'cryptocom', 'telegram'));

-- Wallet's own history replaces the Snowball trades that recorded it:
--   * rows noted "telegram" / "telegram -> trust": the 2025-08-30 BTC and ETH
--     buys, their 2025-09-19 move to Trust, and the 2025-11-03 / 11-06 BTC
--     buys (sold for USDT in Wallet on 2025-11-15 -- Snowball never had that
--     sale, so it still counted ~0.0045 BTC);
--   * every XAUT row (no note): all XAUT was bought and held in Wallet --
--     Snowball's total, 0.459574, is exactly Wallet's balance. Its month-end
--     rewards (STOCK_AS_DIVIDEND) moved into the Telegram Wallet CSV as the
--     XAUT Earn history, which the app no longer shows.
-- import-trades-csv skips them from now on.
delete from public.trades
where external_source = 'snowball_csv'
  and (note in ('telegram', 'telegram -> trust') or ticker = 'XAUT');

-- Exclusions left pointing at rows that no longer exist (the Telegram part
-- of 20250101000017_holding_exclusions.sql).
delete from public.holding_exclusions e
where not exists (
  select 1 from public.trades t
  where t.user_id = e.user_id and t.external_source = e.external_source and t.external_id = e.external_id
);
