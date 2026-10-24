-- Open Banking through Enable Banking (supabase/functions/sync-openbanking)
-- for the banks that have no API of their own: Revolut, Bank of Cyprus. In
-- broker_credentials, as the other syncs keep theirs:
--   broker 'enablebanking': query_id = the application's id (registered in
--     the Enable Banking Control Panel, restricted to the user's own linked
--     accounts), token_secret_id = its private RSA key (.pem) in Supabase
--     Vault -- it signs every API call;
--   broker 'eb:<bank>' ('eb:revolut', 'eb:boc'): query_id = the session the
--     user authorised at the bank (useless without the application's key),
--     token_expires = the day the bank's consent ends (180 days at most),
--     last_sync_* = its runs -- written by the function.
-- The page writes the application through set_enablebanking_app and reads
-- back enablebanking_status; sync-openbanking, with the service role, gets
-- the decrypted key from enablebanking_credentials, which nothing else may call.

-- An empty application id or key keeps the one stored.
create function public.set_enablebanking_app(p_app_id text, p_key text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_key), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'enablebanking';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'enablebanking_key:' || u, 'Enable Banking application private key (sync-openbanking)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'enablebanking', nullif(trim(p_app_id), ''), secret, now())
  on conflict (user_id, broker) do update
    set query_id = coalesce(excluded.query_id, broker_credentials.query_id),
        token_secret_id = excluded.token_secret_id,
        updated_at = now();
end $$;

-- The application (key only as "set") and each bank's session (its end, its runs).
create function public.enablebanking_status()
returns table (broker text, app_id text, key_set boolean, session_set boolean, valid_until date, updated_at timestamptz,
               last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.broker,
    case when c.broker = 'enablebanking' then c.query_id end,
    c.token_secret_id is not null,
    c.broker like 'eb:%' and c.query_id is not null,
    c.token_expires, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and (c.broker = 'enablebanking' or c.broker like 'eb:%')
$$;

-- For sync-openbanking only (service role): every user's application id and decrypted key.
create function public.enablebanking_credentials()
returns table (user_id uuid, app_id text, private_key text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'enablebanking' and c.query_id is not null
$$;

revoke all on function public.set_enablebanking_app(text, text) from public, anon;
revoke all on function public.enablebanking_status() from public, anon;
revoke all on function public.enablebanking_credentials() from public, anon, authenticated;
grant execute on function public.set_enablebanking_app(text, text) to authenticated;
grant execute on function public.enablebanking_status() to authenticated;
grant execute on function public.enablebanking_credentials() to service_role;

-- Daily, spread like the other syncs, with the cron secret (...100).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-openbanking-daily';
select cron.schedule(
  'sync-openbanking-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-openbanking',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
