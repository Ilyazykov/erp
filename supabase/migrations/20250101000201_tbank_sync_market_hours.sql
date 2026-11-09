-- sync-tbank's daily job (...104, every 10 minutes 04:00-07:50 UTC, one run per user)
-- becomes three runs a day while MOEX is open: 11:10 and 15:00 Moscow (08:10 and
-- 12:00 UTC) take the prices only (body prices_only); 23:55 Moscow (20:55 UTC, after
-- the evening session's 23:50 end) takes the whole sync -- trades, payouts, cash
-- and prices. Each run takes the users whose last run is 3 hours or more old.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-tbank-daily';

select cron.schedule(
  'sync-tbank-market-morning',
  '10 8 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-tbank',
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
  'sync-tbank-market-noon',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-tbank',
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
  'sync-tbank-market-evening',
  '55 20 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-tbank',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
