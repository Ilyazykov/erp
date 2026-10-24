-- sync-estimates (_shared/estimates.ts): the bond coupons / redemptions at
-- Sber and Alfa by the MOEX schedule, Russian banks' deposit and savings
-- interest and Telegram Wallet's daily rewards, for the days after each
-- account's latest statement -- rebuilt every morning (and by the page after
-- each upload), replaced by the statements when they come.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-estimates-daily';
select cron.schedule(
  'sync-estimates-daily',
  '25 5 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-estimates',
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
