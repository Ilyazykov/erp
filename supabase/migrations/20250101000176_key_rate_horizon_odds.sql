-- The bond ladder's weights by the key rate (asked 05.11.2026):
-- update-key-rate-odds, monthly, counts per horizon (1-15 years) x key rate
-- (4-21%, 1 pp buckets) how often the CBR's rate was lower that many years
-- later (down) and not higher (not_up), from its monthly history since 1992
-- (the refinancing rate before 13.09.2013), made strictly monotone both ways
-- -- rising with the rate and with the horizon. The tab weighs the ladder's
-- years by them at today's rate. Public data, readable by anyone.
create table public.key_rate_horizon_odds (
  horizon int not null,          -- years
  rate int not null,             -- the bucket: rate <= key rate < rate + 1
  months int not null,           -- months behind the cell; 0 -- filled from its neighbours
  down numeric not null,         -- lower then, the fitted share
  not_up numeric not null,       -- lower or the same
  computed_at timestamptz not null default now(),
  primary key (horizon, rate)
);
alter table public.key_rate_horizon_odds enable row level security;
create policy "anyone can read key rate horizon odds" on public.key_rate_horizon_odds for select using (true);
