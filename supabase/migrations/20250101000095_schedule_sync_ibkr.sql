-- Daily pull of the Interactive Brokers accounts through the Flex Web Service
-- (supabase/functions/sync-ibkr): IBKR's statements for a day are ready by
-- its next morning. Not everyone at once: the job runs every 10 minutes from
-- 04:00 to 07:50 UTC, each user has a slot of their own among those 24, and
-- a run takes at most two users whose slot has come and who aren't synced
-- today (the function picks them). Same pattern as
-- 20250101000013_crypto_wallets.sql; users enter the Flex Query ID and token
-- on the page (broker_credentials, ...096).
select cron.unschedule(jobid)
from cron.job
where jobname = 'sync-ibkr-daily';

select cron.schedule(
  'sync-ibkr-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-ibkr',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
