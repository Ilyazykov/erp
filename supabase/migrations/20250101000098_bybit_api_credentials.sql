-- Bybit's read-only API key for its automatic sync (supabase/functions/
-- sync-bybit), kept as IBKR's Flex token is (broker_credentials, ...096,
-- ...097), broker 'bybit': query_id holds the API key -- an identifier,
-- useless without its secret, shown on the page by its last characters --
-- and the secret is in Supabase Vault (token_secret_id). token_expires is
-- the key's own end date, which sync-bybit reads from Bybit with every run
-- (Bybit gives it, unlike IBKR). The page writes through set_bybit_api and
-- reads back bybit_api_status; sync-bybit, with the service role, gets the
-- decrypted secrets from bybit_api_credentials, which nothing else may call.

-- An empty key or secret keeps the one stored.
create function public.set_bybit_api(p_key text, p_secret text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_secret), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'bybit';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'bybit_api_secret:' || u, 'Bybit read-only API secret (sync-bybit)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'bybit', nullif(trim(p_key), ''), secret, now())
  on conflict (user_id, broker) do update
    set query_id = coalesce(excluded.query_id, broker_credentials.query_id),
        token_secret_id = excluded.token_secret_id,
        -- a new key: its end date comes with the next sync
        token_expires = case when coalesce(excluded.query_id, broker_credentials.query_id) is distinct from broker_credentials.query_id
                               or s is not null
                             then null else broker_credentials.token_expires end,
        updated_at = now();
end $$;

create function public.bybit_api_status()
returns table (key_tail text, secret_set boolean, key_expires date, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select right(c.query_id, 4), c.token_secret_id is not null, c.token_expires, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'bybit'
$$;

-- For sync-bybit only (service role): every user's key and decrypted secret.
create function public.bybit_api_credentials()
returns table (user_id uuid, api_key text, api_secret text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'bybit' and c.query_id is not null
$$;

revoke all on function public.set_bybit_api(text, text) from public, anon;
revoke all on function public.bybit_api_status() from public, anon;
revoke all on function public.bybit_api_credentials() from public, anon, authenticated;
grant execute on function public.set_bybit_api(text, text) to authenticated;
grant execute on function public.bybit_api_status() to authenticated;
grant execute on function public.bybit_api_credentials() to service_role;

-- Daily, spread like sync-ibkr's: every 10 minutes from 04:00 to 07:50 UTC,
-- each user in a slot of their own, at most two a run (the function picks).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-bybit-daily';
select cron.schedule(
  'sync-bybit-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-bybit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Bybit refuses US addresses: the function runs in the project's own region
      'x-region', 'eu-west-1',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
