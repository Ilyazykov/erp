-- Crypto.com App has no personal transaction API. Refresh its short-lived
-- Earn / DPoS projections each morning; the next CSV export replaces them.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-crypto-com-estimates-daily';
select cron.schedule(
  'sync-crypto-com-estimates-daily',
  '20 5 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-crypto-com-estimates',
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
