-- T-Bank's T-Invest API token for the broker sync (supabase/functions/
-- sync-tbank), kept as Bybit's key is (...098), broker 'tbank': only the
-- token, in Supabase Vault (token_secret_id) -- there's no public half to
-- show. A token lives three months from its last use, so the daily sync
-- keeps it alive: token_expires stays empty. The page writes through
-- set_tbank_api and reads back tbank_api_status; sync-tbank, with the
-- service role, gets the decrypted token from tbank_api_credentials, which
-- nothing else may call.

-- An empty token keeps the one stored.
create function public.set_tbank_api(p_token text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  secret uuid;
  s text := nullif(trim(p_token), '');
begin
  if u is null then raise exception 'Not signed in'; end if;
  select c.token_secret_id into secret from broker_credentials c where c.user_id = u and c.broker = 'tbank';
  if s is not null then
    if secret is null then
      secret := vault.create_secret(s, 'tbank_api_token:' || u, 'T-Bank T-Invest API read-only token (sync-tbank)');
    else
      perform vault.update_secret(secret, s);
    end if;
  end if;
  insert into broker_credentials (user_id, broker, token_secret_id, updated_at)
  values (u, 'tbank', secret, now())
  on conflict (user_id, broker) do update
    set token_secret_id = excluded.token_secret_id, updated_at = now();
end $$;

create function public.tbank_api_status()
returns table (token_set boolean, updated_at timestamptz, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.token_secret_id is not null, c.updated_at, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  where c.user_id = auth.uid() and c.broker = 'tbank'
$$;

-- For sync-tbank only (service role): every user's token, decrypted.
create function public.tbank_api_credentials()
returns table (user_id uuid, token text, last_sync_at timestamptz, last_sync_result text)
language sql stable security definer set search_path = public as $$
  select c.user_id, s.decrypted_secret, c.last_sync_at, c.last_sync_result
  from broker_credentials c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.broker = 'tbank'
$$;

revoke all on function public.set_tbank_api(text) from public, anon;
revoke all on function public.tbank_api_status() from public, anon;
revoke all on function public.tbank_api_credentials() from public, anon, authenticated;
grant execute on function public.set_tbank_api(text) to authenticated;
grant execute on function public.tbank_api_status() to authenticated;
grant execute on function public.tbank_api_credentials() to service_role;

-- Daily, spread like the other syncs, with the cron secret (...100).
select cron.unschedule(jobid) from cron.job where jobname = 'sync-tbank-daily';
select cron.schedule(
  'sync-tbank-daily',
  '*/10 4-7 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-tbank',
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

-- latest_data_per_part (...101-...103): the API's money rows
-- ('tbank_api:<agreement>') are the broker's.
create or replace function public.latest_data_per_part()
returns table (account text, part text, label text, last_day date, row_count integer, contracts text[])
language sql stable set search_path = public as $$
  with rows as (
    select b.account, b.tx_date::date as d, b.external_source as src,
      case
        when b.external_source like 'atomyze%' then 'ЦФА (Atomyze)'
        when b.product = 'credit_card' then 'Credit card'
        when b.product = 'brokerage_cash' or b.external_source ~ 'broker|invest|tbank_api' then 'Broker'
        when b.product in ('savings', 'deposit') then 'Deposits & savings'
        else 'Cards & current accounts'
      end as part,
      case
        when split_part(b.external_source, ':', 2) = 'wallet' then 'wallet'
        when b.product = 'debit_card' then 'card'
        when b.product in ('current_account', 'current') then 'current'
      end as what
    from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null and b.account is not null
    union all
    select t.account, t.trade_date, t.external_source,
      case
        when t.external_source like 'atomyze%' then 'ЦФА (Atomyze)'
        when t.external_source like 'revolut_fund%' then 'Flexible Cash Funds'
        when t.external_source like '%crypto%' then 'Crypto'
        when t.external_source like '%metal%' then 'Metals'
        when t.external_source like '%deposit%' then 'Deposits & savings'
        else 'Broker'
      end,
      null
    from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv'
  ),
  kinds as (
    select r.account, r.what, count(distinct split_part(r.src, ':', 2)) as n
    from rows r where r.part = 'Cards & current accounts' and r.what is not null
    group by r.account, r.what
  ),
  names as (
    select k.account, string_agg(
      case k.what
        when 'wallet' then case when k.n > 1 then 'Wallets' else 'Wallet' end
        when 'card' then case when k.n > 1 then 'Debit cards' else 'Debit card' end
        else case when k.n > 1 then 'current accounts' else 'current account' end
      end, ' & ' order by case k.what when 'wallet' then 1 when 'card' then 2 else 3 end) as label
    from kinds k group by k.account
  )
  select r.account, r.part,
    case when r.part = 'Cards & current accounts'
      then coalesce(upper(left(n.label, 1)) || substr(n.label, 2), 'Account') else r.part end,
    max(r.d), count(*)::integer,
    array_agg(distinct regexp_replace(split_part(r.src, ':', 2), '-app$', '')) filter (where split_part(r.src, ':', 2) <> '')
  from rows r left join names n on n.account = r.account
  group by r.account, r.part, n.label
$$;
