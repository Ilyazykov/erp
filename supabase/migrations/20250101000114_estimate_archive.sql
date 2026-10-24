-- The estimated rows a statement has taken back, kept to check the estimates
-- against what came (Claude compares and then deletes what it checked).
-- Every estimated row deleted lands here -- by a rebuild (sync-estimates,
-- sync-openbanking, the Crypto.com estimates) or by an import; a row the
-- rebuild writes again (same key) leaves it again, so what stays is only what
-- a statement covered, or what dropped out (a cancelled dividend).
-- Estimated rows: trades.estimated, wallet_transactions.estimated, and the
-- money the estimates put on or take off accounts, bank_transactions
-- 'estimate_<what>:<where>' (brokerage cash, bank charges) and
-- 'openbanking_revolut_invest'. Older than
-- 90 days is dropped every night.

create table if not exists public.estimate_archive (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  tbl text not null,              -- 'trades' | 'bank_transactions' | 'wallet_transactions'
  key text not null,              -- external_source|external_id, or wallet_id|tx_hash
  source text,                    -- external_source / chain
  account text,
  day date,
  kind text,                      -- side / kind / description
  ticker text,                    -- ticker / symbol
  quantity numeric,               -- quantity / amount
  price numeric,
  currency text,
  note text,
  archived_at timestamptz not null default now(),
  unique (tbl, key)
);
create index if not exists estimate_archive_user_day on public.estimate_archive (user_id, day);

alter table public.estimate_archive enable row level security;
create policy estimate_archive_own on public.estimate_archive
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.archive_estimate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'trades' then
    insert into estimate_archive (user_id, tbl, key, source, account, day, kind, ticker, quantity, price, currency, note)
    values (old.user_id, 'trades', coalesce(old.external_source, '') || '|' || coalesce(old.external_id, old.id::text),
            old.external_source, old.account, old.trade_date, old.side, old.ticker, old.quantity, old.price, old.currency, old.note)
    on conflict (tbl, key) do update set quantity = excluded.quantity, price = excluded.price, day = excluded.day,
      note = excluded.note, archived_at = now();
  elsif tg_table_name = 'bank_transactions' then
    insert into estimate_archive (user_id, tbl, key, source, account, day, kind, quantity, currency, note)
    values (old.user_id, 'bank_transactions', old.external_source || '|' || coalesce(old.external_id, old.id::text),
            old.external_source, old.account, old.tx_date::date, old.description, old.amount, old.currency, old.note)
    on conflict (tbl, key) do update set quantity = excluded.quantity, day = excluded.day, archived_at = now();
  else
    insert into estimate_archive (user_id, tbl, key, source, account, day, kind, ticker, quantity, note)
    values (old.user_id, 'wallet_transactions', old.wallet_id::text || '|' || old.tx_hash,
            old.chain, old.chain, old.tx_time::date, old.kind, old.symbol, old.amount, old.status)
    on conflict (tbl, key) do update set quantity = excluded.quantity, day = excluded.day, archived_at = now();
  end if;
  return old;
end $$;

create or replace function public.unarchive_estimate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from estimate_archive where tbl = tg_table_name and key = case tg_table_name
    when 'trades' then coalesce(new.external_source, '') || '|' || coalesce(new.external_id, new.id::text)
    when 'bank_transactions' then new.external_source || '|' || coalesce(new.external_id, new.id::text)
    else new.wallet_id::text || '|' || new.tx_hash end;
  return new;
end $$;

drop trigger if exists trades_archive_estimate on public.trades;
create trigger trades_archive_estimate after delete on public.trades
  for each row when (old.estimated) execute function public.archive_estimate();
drop trigger if exists trades_unarchive_estimate on public.trades;
create trigger trades_unarchive_estimate after insert on public.trades
  for each row when (new.estimated) execute function public.unarchive_estimate();

drop trigger if exists wallet_archive_estimate on public.wallet_transactions;
create trigger wallet_archive_estimate after delete on public.wallet_transactions
  for each row when (old.estimated) execute function public.archive_estimate();
drop trigger if exists wallet_unarchive_estimate on public.wallet_transactions;
create trigger wallet_unarchive_estimate after insert on public.wallet_transactions
  for each row when (new.estimated) execute function public.unarchive_estimate();

drop trigger if exists bank_archive_estimate on public.bank_transactions;
create trigger bank_archive_estimate after delete on public.bank_transactions
  for each row when (left(old.external_source, 9) = 'estimate_' or old.external_source = 'openbanking_revolut_invest')
  execute function public.archive_estimate();
drop trigger if exists bank_unarchive_estimate on public.bank_transactions;
create trigger bank_unarchive_estimate after insert on public.bank_transactions
  for each row when (left(new.external_source, 9) = 'estimate_' or new.external_source = 'openbanking_revolut_invest')
  execute function public.unarchive_estimate();

select cron.unschedule(jobid) from cron.job where jobname = 'estimate-archive-purge';
select cron.schedule('estimate-archive-purge', '40 3 * * *',
  $$ delete from public.estimate_archive where archived_at < now() - interval '90 days' $$);
