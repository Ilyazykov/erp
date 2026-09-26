-- Binance, imported from its own transaction export (import-binance), stored
-- like the other exchanges (20250101000018_crypto_com.sql): a crypto_wallets
-- row with chain 'binance', its rows in wallet_transactions, balances in
-- wallet_balances. Custodial, so sync-crypto-wallets skips it. Snowball never
-- had Binance, so nothing to remove there.

alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana', 'binance', 'bybit', 'cryptocom', 'telegram'));
