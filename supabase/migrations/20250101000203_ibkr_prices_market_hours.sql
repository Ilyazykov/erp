-- sync-ibkr's prices-only run (body prices_only): the open positions' mark prices from the Flex report, into
-- price_history as source 'ibkr'. Once a day per user, at a random minute of the day inside US market hours:
-- the cron wakes the function every 10 minutes from 15:00 to 19:50 UTC on weekdays; the first wake of the day
-- draws today's minute (prices_due_at, random in 15:00-19:59), the run comes once that minute has passed and
-- today's prices aren't in yet (last_prices_at). Freedom24's runs are at 14:45, 17:45 and 20:45.
alter table public.broker_credentials add column if not exists last_prices_at timestamptz;
alter table public.broker_credentials add column if not exists prices_due_at timestamptz;

select cron.unschedule(jobid) from cron.job where jobname in ('sync-ibkr-prices-open', 'sync-ibkr-prices-middle', 'sync-ibkr-prices-close');

select cron.schedule('sync-ibkr-prices-window', '*/10 15-19 * * 1-5', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-ibkr',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body := '{"prices_only": true}'::jsonb, timeout_milliseconds := 150000);
$$);
