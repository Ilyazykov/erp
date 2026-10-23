-- Credentials of a broker's automatic sync, entered on the page: for IBKR the
-- Flex Query ID and the Flex Web Service token (supabase/functions/sync-ibkr).
-- The token is read-only on IBKR's side (it can fetch the Flex Query's
-- statement, nothing else) but still not something to hand back to a
-- browser: the table has no policy for the signed-in user at all -- the
-- page writes it through set_ibkr_flex and reads back only whether a token
-- is set (ibkr_flex_status); sync-ibkr reads it with the service role.
-- last_sync_* record what the latest run did, for the page to show.

create table public.broker_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null,
  query_id text,
  token text,
  updated_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_result text,
  primary key (user_id, broker)
);
alter table public.broker_credentials enable row level security;

-- An empty token keeps the one stored (the form can change the Query ID alone).
create or replace function public.set_ibkr_flex(p_query_id text, p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into broker_credentials (user_id, broker, query_id, token, updated_at)
  values (auth.uid(), 'ibkr', nullif(trim(p_query_id), ''), nullif(trim(p_token), ''), now())
  on conflict (user_id, broker) do update
    set query_id = excluded.query_id,
        token = coalesce(excluded.token, broker_credentials.token),
        updated_at = now();
end $$;

create or replace function public.ibkr_flex_status()
returns table (query_id text, token_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.query_id, c.token is not null, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'ibkr'
$$;

revoke all on function public.set_ibkr_flex(text, text) from public, anon;
revoke all on function public.ibkr_flex_status() from public, anon;
grant execute on function public.set_ibkr_flex(text, text) to authenticated;
grant execute on function public.ibkr_flex_status() to authenticated;
