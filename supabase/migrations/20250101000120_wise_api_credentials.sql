-- Wise's own API for the Wise account (supabase/functions/sync-wise): a
-- personal API token (read only) and the RSA private key that signs the
-- one-time tokens of Strong Customer Authentication (the balance statement
-- needs it in the EEA; its public half is uploaded in Wise -> API tokens ->
-- Manage public keys). Both are secrets: one Vault secret holding
-- {"token": ..., "private_key": ...} (token_secret_id); broker 'wise',
-- query_id = the token's last characters (shown on the page). The token
-- doesn't end. Decided 25.10.2026: Wise's own API takes precedence over Enable
-- Banking -- with it set, sync-openbanking leaves Wise alone.
-- The page writes through set_wise_api (an empty token or key keeps the one
-- stored) and reads back wise_api_status; sync-wise, with the service role,
-- reads wise_api_credentials, which nothing else may call.

create function public.set_wise_api(p_token text, p_private_key text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  cur jsonb := '{}';
  val jsonb;
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'wise';
  if secret is not null then
    select s.decrypted_secret::jsonb into cur from vault.decrypted_secrets s where s.id = secret;
  end if;
  val := coalesce(cur, '{}') || jsonb_strip_nulls(jsonb_build_object(
    'token', nullif(trim(p_token), ''), 'private_key', nullif(trim(p_private_key), '')));
  if secret is null then
    secret := vault.create_secret(val::text, 'wise_api:' || u, 'Wise personal API token and SCA private key (sync-wise)');
  else
    perform vault.update_secret(secret, val::text);
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, updated_at)
  values (u, 'wise', right(val->>'token', 4), secret, now())
  on conflict (user_id, broker) do update
    set query_id = excluded.query_id, token_secret_id = excluded.token_secret_id, updated_at = now();
end $$;

create function public.wise_api_status()
returns table (token_tail text, token_set boolean, key_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.query_id, (s.decrypted_secret::jsonb ? 'token'), (s.decrypted_secret::jsonb ? 'private_key'),
    c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  left join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.user_id = auth.uid() and c.broker = 'wise'
$$;

-- For sync-wise (and sync-openbanking, to stand aside) only: service role.
create function public.wise_api_credentials()
returns table (user_id uuid, token text, private_key text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, s.decrypted_secret::jsonb->>'token', s.decrypted_secret::jsonb->>'private_key', c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'wise' and s.decrypted_secret::jsonb ? 'token'
$$;

revoke all on function public.set_wise_api(text, text) from public, anon;
revoke all on function public.wise_api_status() from public, anon;
revoke all on function public.wise_api_credentials() from public, anon, authenticated;
grant execute on function public.set_wise_api(text, text) to authenticated;
grant execute on function public.wise_api_status() to authenticated;
grant execute on function public.wise_api_credentials() to service_role;

-- Daily, spread like the other syncs, with the cron secret (...100).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-wise-daily';
select cron.schedule(
  'sync-wise-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-wise',
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
