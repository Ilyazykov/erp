-- Freedom24's (Tradernet) API key pair for its automatic sync (supabase/
-- functions/sync-freedom24), kept as Bybit's is (...098), broker
-- 'freedom24': query_id holds the public key -- an identifier, useless
-- without its private half, shown on the page by its last characters -- and
-- the private key is in Supabase Vault (token_secret_id). Freedom24's keys
-- don't end unless given a lifetime: token_expires stays empty. The page
-- writes through set_freedom24_api and reads back freedom24_api_status;
-- sync-freedom24, with the service role, gets the decrypted keys from
-- freedom24_api_credentials, which nothing else may call.

-- An empty public or private key keeps the one stored.
create function public.set_freedom24_api(p_public text, p_private text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_private), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'freedom24';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'freedom24_api_private:' || u, 'Freedom24 (Tradernet) API private key (sync-freedom24)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'freedom24', nullif(trim(p_public), ''), secret, now())
  on conflict (user_id, broker) do update
    set query_id = coalesce(excluded.query_id, broker_credentials.query_id),
        token_secret_id = excluded.token_secret_id,
        updated_at = now();
end $$;

create function public.freedom24_api_status()
returns table (key_tail text, secret_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select right(c.query_id, 4), c.token_secret_id is not null, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'freedom24'
$$;

-- For sync-freedom24 only (service role): every user's keys, decrypted.
create function public.freedom24_api_credentials()
returns table (user_id uuid, public_key text, private_key text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'freedom24' and c.query_id is not null
$$;

revoke all on function public.set_freedom24_api(text, text) from public, anon;
revoke all on function public.freedom24_api_status() from public, anon;
revoke all on function public.freedom24_api_credentials() from public, anon, authenticated;
grant execute on function public.set_freedom24_api(text, text) to authenticated;
grant execute on function public.freedom24_api_status() to authenticated;
grant execute on function public.freedom24_api_credentials() to service_role;

-- Daily, spread like sync-ibkr's: every 10 minutes from 04:00 to 07:50 UTC,
-- each user in a slot of their own, at most two a run (the function picks).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-freedom24-daily';
select cron.schedule(
  'sync-freedom24-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-freedom24',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
