-- Schedules the `update-market-prices` Edge Function to run once a day,
-- entirely inside Supabase -- no GitHub Actions, no external scheduler.
--
-- This replaces the old .github/workflows/market_prices_update.yml +
-- erp_valuation/fetch_portfolio_prices.py combo, which has been deleted.
-- The equivalent logic now lives in
-- supabase/functions/update-market-prices/index.ts, and pg_cron (running
-- inside this Postgres instance) calls it daily via pg_net's async HTTP
-- client, the same pattern Supabase's own docs describe under
-- "Scheduling Edge Functions".
--
-- ---------------------------------------------------------------------
-- MANUAL SETUP REQUIRED (this migration cannot do this part for you)
-- ---------------------------------------------------------------------
-- The HTTP call below is just the "is anyone allowed to even reach this
-- URL at all" check that every Supabase Edge Function requires -- it has
-- nothing to do with what the function is ALLOWED TO DO once invoked.
-- That's why the publishable/anon key is enough here (the same public key
-- already embedded in index.html) -- it never grants access to `trades`
-- or write access to `market_prices` by itself. The function's own code
-- separately uses its auto-injected SUPABASE_SERVICE_ROLE_KEY (a Supabase
-- platform env var, never transmitted over HTTP, never stored in Vault or
-- this file) to actually read/write data once it's running -- see
-- supabase/functions/update-market-prices/index.ts. So this key only
-- needs to be "public-safe", not secret:
--
--   1. In the Supabase dashboard: Project Settings -> Vault
--      -> "Add new secret".
--        name:  publishable_key
--        value: Project Settings -> API -> "anon" / "publishable" key
--      (Same key already used in index.html's supabase-js client --
--      Vault here is just a convenient place for SQL to read it from, not
--      because the value itself is sensitive.)
--
--   2. The URL below is already set to this project's ref
--      (xdltomehejjtgzdxbiyx) -- nothing to edit here unless the project
--      is ever recreated under a different ref.
--
--   3. The function must be deployed with `--no-verify-jwt` so Supabase's
--      platform-level JWT gate doesn't reject the cron caller (already
--      wired into .github/workflows/supabase_deploy.yml -- no action
--      needed here unless deploying manually, in which case run:
--        supabase functions deploy update-market-prices --project-ref xdltomehejjtgzdxbiyx --no-verify-jwt
--      The function itself always uses the service-role key it
--      authenticates with -- never a caller-supplied user JWT -- to read
--      trades / write market_prices, so --no-verify-jwt does not loosen
--      who can write price data; it only lets the platform accept the
--      request at all when there is no end-user session (there never is,
--      in a daily cron run).
--
-- Once both of those are done, this schedule is fully self-contained: no
-- GitHub Actions, secrets, or workflow file needed for daily price
-- refreshes ever again.
-- ---------------------------------------------------------------------

-- pg_cron: runs scheduled jobs inside Postgres itself.
-- pg_net: lets Postgres (and hence a pg_cron job) make outbound async HTTP
-- requests -- this is what actually calls the Edge Function's URL.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Remove any previous version of this job before (re-)scheduling, so
-- re-running this migration (or a future migration that edits it) doesn't
-- pile up duplicate schedules.
select cron.unschedule(jobid)
from cron.job
where jobname = 'update-market-prices-daily';

-- Runs daily at 06:00 UTC (after MOEX's ~18:45 MSK close and well after US
-- markets close, so the previous session's closing prices are available
-- everywhere this function looks).
select cron.schedule(
  'update-market-prices-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-market-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- Notes:
--   - The `apikey` header (not `Authorization: Bearer`) is the current
--     documented Supabase pattern for calling an Edge Function from
--     pg_cron/pg_net -- see https://supabase.com/docs/guides/functions/schedule-functions.
--     It's built from a subselect against vault.decrypted_secrets by name,
--     so this migration applies cleanly even before the Vault secret
--     exists -- until step 1 above is done, the header is just missing a
--     value. Because the function is deployed with --no-verify-jwt,
--     Supabase's platform won't reject the request outright either way --
--     but note the function itself doesn't inspect this header at all
--     (see index.ts): it always uses its own SUPABASE_SERVICE_ROLE_KEY env
--     var (auto-injected by Supabase into every Edge Function, never sent
--     over HTTP) to talk to Postgres, regardless of what's in this
--     request. The header here exists only so the platform's edge gateway
--     accepts the request as coming from a recognized project client --
--     it is not what grants the function its database permissions.
--   - timeout_milliseconds is generous (5 minutes): the function makes a
--     large number of sequential MOEX/Yahoo requests for an unbounded
--     ticker universe, and pg_net's default timeout is much shorter.
--   - To inspect run history later: select * from cron.job_run_details
--     order by start_time desc limit 20;
--   - To change the schedule: select cron.alter_job(job_id, schedule =>
--     '<new cron expression>') where job_id is from `select jobid from
--     cron.job where jobname = 'update-market-prices-daily'`.
