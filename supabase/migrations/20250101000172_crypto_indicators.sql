-- The crypto target follows a strategy on the AHR999 index (asked
-- 05.11.2026): the crypto share of the portfolio is bought up toward 5% in
-- its red zone (< 0.45), sold down in its green zone (> 1.2). AHR999 per day,
-- from BTC's daily closes (update-crypto-indicators, every morning):
--   ahr999 = (price / dca200) * (price / fair)
--   dca200 = the geometric mean of the last 200 closes (the cost of buying daily)
--   fair   = 10 ^ (5.84 * log10(days since 2009-01-03) - 17.01)
-- Public data, readable by anyone.
create table public.crypto_indicators (
  day date primary key,
  btc_usd numeric not null,
  dca200 numeric not null,
  fair_usd numeric not null,
  ahr999 numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.crypto_indicators enable row level security;
create policy "anyone can read crypto indicators" on public.crypto_indicators for select using (true);

select cron.schedule('update-crypto-indicators-daily', '15 6 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-crypto-indicators',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
