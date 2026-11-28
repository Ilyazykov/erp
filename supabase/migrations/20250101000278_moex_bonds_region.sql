-- update-moex-bonds from Frankfurt (28.11.2026): its first runs landed in eu-west-1, where the
-- connection to iss.moex.com hangs (not even the fetch's timeout fired; 150 s, nothing done),
-- while from eu-central-1 (moex-iss, the second run) MOEX answers -- the job asks for that region.

select cron.unschedule(jobname) from cron.job where jobname = 'update-moex-bonds';
select cron.schedule('update-moex-bonds', '10 5,16 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-moex-bonds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-central-1',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$);
