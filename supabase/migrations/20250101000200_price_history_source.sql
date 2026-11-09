-- Who wrote a price_history row: 'market' (update-market-prices, update-capital-history),
-- 'ibkr' (sync-ibkr), 'tbank' (sync-tbank). Every write overwrites the day's row, so
-- the last value received for a day is the one kept. Existing rows are 'market'.
alter table public.price_history add column if not exists source text not null default 'market';
