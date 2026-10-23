-- IBKR's Flex token (broker_credentials, ...096) out of plain text: it is
-- kept encrypted in Supabase Vault (as the cron jobs' publishable_key is),
-- the table holding only the Vault secret's id. A token stored in the clear
-- so far moves there and the plain column goes. sync-ibkr, with the service
-- role, gets the decrypted tokens from ibkr_flex_credentials, which nothing
-- else may call; the page still writes through set_ibkr_flex and reads back
-- only whether a token is set (ibkr_flex_status).
-- Also token_expires: the date IBKR showed when it made the token (its Flex
-- Web Service doesn't tell) -- the page counts the days left from it.

alter table public.broker_credentials add column token_secret_id uuid, add column token_expires date;

update public.broker_credentials c
set token_secret_id = vault.create_secret(c.token, 'ibkr_flex_token:' || c.user_id, 'IBKR Flex Web Service token (sync-ibkr)')
where c.token is not null and c.broker = 'ibkr';

alter table public.broker_credentials drop column token;

drop function public.set_ibkr_flex(text, text);
drop function public.ibkr_flex_status();

-- An empty token keeps the one stored (the form can change the Query ID or
-- the date alone); a new one replaces the Vault secret's value.
create function public.set_ibkr_flex(p_query_id text, p_token text, p_token_expires date default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  token text := nullif(trim(p_token), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'ibkr';
  if token is not null then
    if secret is null then
      secret := vault.create_secret(token, 'ibkr_flex_token:' || u, 'IBKR Flex Web Service token (sync-ibkr)');
    else
      perform vault.update_secret(secret, token);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, query_id, token_secret_id, token_expires, updated_at)
  values (u, 'ibkr', nullif(trim(p_query_id), ''), secret, p_token_expires, now())
  on conflict (user_id, broker) do update
    set query_id = excluded.query_id,
        token_secret_id = excluded.token_secret_id,
        token_expires = excluded.token_expires,
        updated_at = now();
end $$;

create function public.ibkr_flex_status()
returns table (query_id text, token_set boolean, token_expires date, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.query_id, c.token_secret_id is not null, c.token_expires, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'ibkr'
$$;

-- For sync-ibkr only (service role): every user's Query ID and decrypted token.
create function public.ibkr_flex_credentials()
returns table (user_id uuid, query_id text, token text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'ibkr' and c.query_id is not null
$$;

-- A user's Vault secret goes with their credentials.
create function public.broker_credentials_drop_secret() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.token_secret_id is not null then delete from vault.secrets where id = old.token_secret_id; end if;
  return old;
end $$;
create trigger broker_credentials_drop_secret after delete on public.broker_credentials
for each row execute function public.broker_credentials_drop_secret();

revoke all on function public.set_ibkr_flex(text, text, date) from public, anon;
revoke all on function public.ibkr_flex_status() from public, anon;
revoke all on function public.ibkr_flex_credentials() from public, anon, authenticated;
revoke all on function public.broker_credentials_drop_secret() from public, anon, authenticated;
grant execute on function public.set_ibkr_flex(text, text, date) to authenticated;
grant execute on function public.ibkr_flex_status() to authenticated;
grant execute on function public.ibkr_flex_credentials() to service_role;
