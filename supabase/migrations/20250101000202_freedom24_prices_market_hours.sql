-- sync-freedom24's prices-only run (body prices_only): the held securities' current prices from
-- getPositionJson into price_history. Three runs a day in US market hours (the NYSE / Nasdaq session,
-- 14:30-21:00 UTC in winter, after the 1 Nov 2026 clock change): 14:45 UTC (15 min after the open),
-- 17:45 UTC (middle), 20:45 UTC (15 min before the close). Cron times are UTC, so in summer
-- (US daylight time) the same runs fall 1 hour earlier relative to the session -- still inside it.
-- The day written is the trading day of the price (tradingDay in sync-freedom24).
select cron.schedule(
  'sync-freedom24-prices-open',
  '45 14 * * 1-5',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-freedom24',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"prices_only": true}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'sync-freedom24-prices-middle',
  '45 17 * * 1-5',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-freedom24',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"prices_only": true}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'sync-freedom24-prices-close',
  '45 20 * * 1-5',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-freedom24',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"prices_only": true}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
