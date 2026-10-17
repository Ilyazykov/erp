-- Gram (prev. Toncoin): Yahoo's GRAM-USD history before the rename (June
-- 2026) is another coin at ~$0.003 against Toncoin's ~$1.5-7, so everything
-- held / bought before then came out ~0 (Earned by asset: GRAM +50918%).
-- update-capital-history now takes it from Bybit's GRAMUSDT (Toncoin's whole
-- history); the stored closes and the cached source go, and its next run
-- fetches them again and rebuilds the capital history.
delete from public.price_history where ticker = 'GRAM';
delete from public.price_sources where ticker = 'GRAM';
