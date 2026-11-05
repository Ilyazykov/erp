-- update-capital-history prices some 40 tickers in a run (its 100 s budget)
-- out of some 240; run once a night it never got through them, and from
-- 26.10.2026 a hung call got it killed every night with nothing priced. It
-- runs every 10 minutes from 22:00 to 23:50 UTC now (12 runs); a run skips the
-- tickers an earlier one tried that day.
select cron.unschedule('update-capital-history');
select cron.schedule('update-capital-history', '*/10 22-23 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-capital-history',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
$$);
