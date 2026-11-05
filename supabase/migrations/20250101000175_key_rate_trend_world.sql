-- The trend's odds ratio from the world's central banks, not Russia's few
-- episodes (asked 05.11.2026): per bucket of the 12-month change -- now a
-- share of the rate's range over the last 10 years, not pp -- and per where
-- the rate stands against its last 10 years (a pause high up and one low
-- down tell the opposite). update-key-rate-odds fills it from the BIS policy
-- rates, monthly.
delete from public.key_rate_trend_odds;
alter table public.key_rate_trend_odds drop constraint key_rate_trend_odds_pkey;
alter table public.key_rate_trend_odds
  add column position smallint not null default 1;   -- 0: below its 10-year mean (by over half a standard deviation), 1: about it, 2: above
alter table public.key_rate_trend_odds add primary key (trend_from, position);
comment on column public.key_rate_trend_odds.trend_from is 'the bucket: trend_from < the 12-month change / the 10-year range (max - min) <= trend_to';
comment on column public.key_rate_trend_odds.exp_up is 'how often the rate went up at that position, whatever the change';
