-- Credentials of a broker's automatic sync, entered on the page: for IBKR the
-- Flex Query ID and the Flex Web Service token (supabase/functions/sync-ibkr).
-- The token is read-only on IBKR's side (it can fetch the Flex Query's
-- statement, nothing else) but still a secret: it is kept encrypted in
-- Supabase Vault (as the cron jobs' publishable_key is), the table holding
-- only the Vault secret's id. The table has no policy for the signed-in user
-- at all -- the page writes through set_ibkr_flex and reads back only whether
-- a token is set (ibkr_flex_status); sync-ibkr, with the service role, gets
-- the decrypted tokens from ibkr_flex_credentials, which nothing else may
-- call. last_sync_* record what the latest run did, for the page to show.
-- token_expires is the date IBKR showed when it made the token (its Flex
-- Web Service doesn't tell): the page counts the days left from it.

create table public.broker_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null,
  query_id text,
  token_secret_id uuid,
  token_expires date,
  updated_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_result text,
  primary key (user_id, broker)
);
alter table public.broker_credentials enable row level security;

-- An empty token keeps the one stored (the form can change the Query ID or
-- the date alone); a new one replaces the Vault secret's value.
create or replace function public.set_ibkr_flex(p_query_id text, p_token text, p_token_expires date default null)
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

create or replace function public.ibkr_flex_status()
returns table (query_id text, token_set boolean, token_expires date, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.query_id, c.token_secret_id is not null, c.token_expires, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'ibkr'
$$;

-- For sync-ibkr only (service role): every user's Query ID and decrypted token.
create or replace function public.ibkr_flex_credentials()
returns table (user_id uuid, query_id text, token text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.query_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'ibkr' and c.query_id is not null
$$;

-- A user's Vault secret goes with their credentials.
create or replace function public.broker_credentials_drop_secret() returns trigger
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
