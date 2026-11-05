-- The floaters' share of the bonds by the odds the CBR key rate goes up or
-- down from its level now (asked 05.11.2026): update-key-rate-odds takes the
-- key rate's history from cbr.ru daily, the rate of every day kept; once a
-- month it also counts, per 1 pp of the
-- rate, how often it was higher / lower / the same a year, two and three
-- later; the three in one, made strictly monotone (up falls with the rate,
-- down rises); floaters = up / (up + down). Public data, readable by anyone.
create table public.key_rates (
  day date primary key,         -- every day since 17.09.2013
  rate numeric not null         -- the CBR's key rate that day
);
alter table public.key_rates enable row level security;
create policy "anyone can read key rates" on public.key_rates for select using (true);

create table public.key_rate_odds (
  rate_from numeric primary key,   -- the bucket: rate_from <= rate < rate_to
  rate_to numeric not null,
  rate numeric not null,           -- its days' mean rate: the point the tab interpolates between
  days int not null,
  up_raw numeric not null,         -- the three horizons mixed, as counted
  down_raw numeric not null,
  same_raw numeric not null,
  up numeric not null,             -- strictly monotone
  down numeric not null,
  floaters_pct numeric not null,   -- up / (up + down), %
  computed_at timestamptz not null default now()
);
alter table public.key_rate_odds enable row level security;
create policy "anyone can read key rate odds" on public.key_rate_odds for select using (true);

-- The trend over the level: the rate's change over the last year, per
-- bucket of it the odds ratio of a rise -- how often it went up against what
-- the level's odds expected; the tab multiplies the level's odds by it.
create table public.key_rate_trend_odds (
  trend_from numeric primary key,  -- the bucket: trend_from < change over 365 days <= trend_to, pp
  trend_to numeric not null,
  n int not null,                  -- day x horizon pairs
  obs_up numeric not null,         -- went up (of up + down)
  exp_up numeric not null,         -- the level's odds expected
  odds_ratio numeric not null,     -- odds(obs) / odds(exp), clamped to 0.2-5
  computed_at timestamptz not null default now()
);
alter table public.key_rate_trend_odds enable row level security;
create policy "anyone can read key rate trend odds" on public.key_rate_trend_odds for select using (true);

-- the key rate daily, the odds on the 1st
select cron.schedule('update-key-rate-daily', '20 6 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-key-rate-odds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
select cron.schedule('update-key-rate-odds-monthly', '30 6 1 * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-key-rate-odds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"odds": true}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
