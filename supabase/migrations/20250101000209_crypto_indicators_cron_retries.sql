-- AHR999 was missing for 13.11.2026: the one daily run (06:15 UTC) got no 12.11
-- candle from Yahoo yet, so there was nothing to date 13.11 with, and the next
-- run was a day later. Now (as sync-ibkr's prices window, migration ...203) the
-- cron wakes update-crypto-indicators every 10 minutes from 00:00 to 05:50 UTC:
-- a run adds the days not stored yet (Bybit's candles, closed at 00:00 UTC) and
-- once today's row is in, the window's later runs stop at once -- a missed or
-- failed run is made up by the next. (cron.schedule with the same name replaces the job.)

select cron.schedule('update-crypto-indicators-daily', '*/10 0-5 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-crypto-indicators',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- Who gave a day's close (13.11.2026): 'bybit' or 'yahoo', asked side by side,
-- Bybit's taken when both have the day (as price_history.source, migration ...200).
-- The rows before are Yahoo's.
alter table public.crypto_indicators add column if not exists source text not null default 'yahoo';
