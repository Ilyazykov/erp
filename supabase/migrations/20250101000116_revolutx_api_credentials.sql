-- Revolut X's read-only API key for the check of Revolut's crypto balances
-- (supabase/functions/sync-revolutx), kept as Binance's is (...106), broker
-- 'revolutx': query_id holds the API key -- an identifier, useless without
-- the private key, shown on the page by its last characters -- and the
-- Ed25519 private key it signs with (PKCS#8 PEM; the page makes the pair and
-- shows the public half to register at Revolut X) is in Supabase Vault
-- (token_secret_id). The key doesn't end: token_expires stays empty.
-- The page writes through set_revolutx_api and reads back revolutx_api_status;
-- sync-revolutx, with the service role, gets the decrypted private key from
-- revolutx_api_credentials, which nothing else may call.

-- An empty key or private key keeps the one stored.
create function public.set_revolutx_api(p_key text, p_private_key text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_private_key), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'revolutx';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'revolutx_private_key:' || u, 'Revolut X API Ed25519 private key (sync-revolutx)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'revolutx', nullif(trim(p_key), ''), secret, now())
  on conflict (user_id, broker) do update
    set query_id = coalesce(excluded.query_id, broker_credentials.query_id),
        token_secret_id = excluded.token_secret_id,
        updated_at = now();
end $$;

create function public.revolutx_api_status()
returns table (key_tail text, secret_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select right(c.query_id, 4), c.token_secret_id is not null, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'revolutx'
$$;

-- For sync-revolutx only (service role): every user's key and decrypted private key.
create function public.revolutx_api_credentials()
returns table (user_id uuid, api_key text, private_key text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'revolutx' and c.query_id is not null
$$;

revoke all on function public.set_revolutx_api(text, text) from public, anon;
revoke all on function public.revolutx_api_status() from public, anon;
revoke all on function public.revolutx_api_credentials() from public, anon, authenticated;
grant execute on function public.set_revolutx_api(text, text) to authenticated;
grant execute on function public.revolutx_api_status() to authenticated;
grant execute on function public.revolutx_api_credentials() to service_role;

-- Daily, spread like the other syncs, with the cron secret (...100), in the
-- project's own region (as Binance's).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-revolutx-daily';
select cron.schedule(
  'sync-revolutx-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-revolutx',
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
