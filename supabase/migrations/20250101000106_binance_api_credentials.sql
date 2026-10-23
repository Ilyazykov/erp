-- Binance's read-only API key for its balance check (supabase/functions/
-- sync-binance), kept as Bybit's is (...098), broker 'binance': query_id
-- holds the API key -- an identifier, useless without its secret, shown on
-- the page by its last characters -- and the secret is in Supabase Vault
-- (token_secret_id). A read-only key doesn't end: token_expires stays empty.
-- The page writes through set_binance_api and reads back
-- binance_api_status; sync-binance, with the service role, gets the
-- decrypted secret from binance_api_credentials, which nothing else may call.

-- An empty key or secret keeps the one stored.
create function public.set_binance_api(p_key text, p_secret text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_secret), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'binance';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'binance_api_secret:' || u, 'Binance read-only API secret (sync-binance)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'binance', nullif(trim(p_key), ''), secret, now())
  on conflict (user_id, broker) do update
    set query_id = coalesce(excluded.query_id, broker_credentials.query_id),
        token_secret_id = excluded.token_secret_id,
        updated_at = now();
end $$;

create function public.binance_api_status()
returns table (key_tail text, secret_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select right(c.query_id, 4), c.token_secret_id is not null, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'binance'
$$;

-- For sync-binance only (service role): every user's key and decrypted secret.
create function public.binance_api_credentials()
returns table (user_id uuid, api_key text, api_secret text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'binance' and c.query_id is not null
$$;

revoke all on function public.set_binance_api(text, text) from public, anon;
revoke all on function public.binance_api_status() from public, anon;
revoke all on function public.binance_api_credentials() from public, anon, authenticated;
grant execute on function public.set_binance_api(text, text) to authenticated;
grant execute on function public.binance_api_status() to authenticated;
grant execute on function public.binance_api_credentials() to service_role;

-- Daily, spread like the other syncs, with the cron secret (...100); in the
-- project's own region -- Binance refuses US addresses, as Bybit does.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-binance-daily';
select cron.schedule(
  'sync-binance-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-binance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-west-1',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
