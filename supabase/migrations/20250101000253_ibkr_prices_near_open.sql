-- sync-ibkr's prices-only run near the US open: the function draws each user's minute in 14:40-15:09 UTC
-- (was 15:00-19:59: the day's IBKR price came as late as 19:59 UTC). The cron wakes it every 10 minutes
-- from 14:00 to 15:50 UTC on weekdays: the runs before the minute do nothing, those after it make up a
-- failed one.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-ibkr-prices-window';

select cron.schedule('sync-ibkr-prices-window', '*/10 14-15 * * 1-5', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-ibkr',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body := '{"prices_only": true}'::jsonb, timeout_milliseconds := 150000);
$$);
