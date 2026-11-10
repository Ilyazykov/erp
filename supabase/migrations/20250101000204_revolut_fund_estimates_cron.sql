-- Revolut's money-market funds earn every day, but their estimated return
-- ('est:...' rows of sync-openbanking) came only with the bank sync (04:00 UTC,
-- and only through the day before): the treemap's 1d / 2d showed the funds at
-- 0. sync-openbanking writes them through today now, and this job rewrites them
-- just after midnight UTC, without the bank, so the new day has its return
-- from its start.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-openbanking-estimates';
select cron.schedule(
  'sync-openbanking-estimates',
  '5 0 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-openbanking',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"action": "estimates"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
