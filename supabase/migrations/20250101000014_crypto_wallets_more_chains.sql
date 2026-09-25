-- Bitcoin and Solana wallets too (Trust Wallet holds an address on each),
-- synced by sync-crypto-wallets like Ethereum / TRON: Bitcoin via
-- mempool.space, Solana via the public mainnet RPC. The page now detects the
-- chain from the address itself, so there's no chain picker to get wrong.

alter table public.crypto_wallets drop constraint crypto_wallets_chain_check;
alter table public.crypto_wallets
  add constraint crypto_wallets_chain_check
    check (chain in ('ethereum', 'tron', 'bitcoin', 'solana'));
