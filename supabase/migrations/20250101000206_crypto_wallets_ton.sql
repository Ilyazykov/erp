-- TON (Gram) non-custodial wallets: the chain 'ton', read by sync-crypto-wallets (toncenter).
alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana', 'binance', 'bybit', 'cryptocom', 'telegram', 'ton'));
