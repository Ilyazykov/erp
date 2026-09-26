-- Snowball's month-end ETH interest (STOCK_AS_DIVIDEND, no note,
-- 2025-09-30 .. 2026-08-31, 0.00386361 ETH in total) is Lido staking reward
-- entered by hand. That ETH is Trust Wallet's stETH, whose balance
-- sync-crypto-wallets reads straight from the Lido contract -- the rewards
-- are already in it (stETH rebases daily, no transfers involved). Removed;
-- import-trades-csv skips ETH STOCK_AS_DIVIDEND rows from now on so a
-- Snowball re-upload doesn't bring them back.

delete from public.trades
where external_source = 'snowball_csv' and ticker = 'ETH' and side = 'stock_as_dividend';
