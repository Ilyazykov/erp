-- The ladder's second table is "up" -- the rate higher N years later -- not
-- "not higher" (asked 06.11.2026: down - up is what weighs a year).
-- update-key-rate-odds fills it anew; till its next run the old rows are
-- dropped.
delete from public.key_rate_horizon_odds;
alter table public.key_rate_horizon_odds rename column not_up to up;
comment on column public.key_rate_horizon_odds.up is 'higher then, the fitted share; falls with the rate and the horizon';
