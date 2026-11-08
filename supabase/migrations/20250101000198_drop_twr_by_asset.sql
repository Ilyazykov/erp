-- twr_by_asset (...197) is not used any more: TWR leaves out when and how much money was put in, and
-- the Portfolio map and "Earned by asset" judge this portfolio with its top-ups (contribution, XIRR).
drop function if exists public.twr_by_asset(date, date, jsonb, text);
