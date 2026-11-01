-- A category set by hand (expense_manual / income_manual, or an expense_note)
-- outlives its row being written again. sync-openbanking replaces a bank's
-- API rows every run (delete, then insert), and the London flat's 85 GBP
-- "To Svetlana A" (Revolut, 19.10.2026), set to Hotels by hand, came back as
-- "Transfers to people" (01.11.2026). Now a deleted row's hand-set fields are
-- kept here, by (source, id -- a pending one's id without its 'pending:'), and
-- a row inserted under that key gets them back. Older than 180 days -- a row
-- that never came back -- is dropped every night.

create table if not exists public.manual_categories (
  user_id uuid not null references auth.users (id) on delete cascade,
  external_source text not null,
  external_id text not null,
  expense_category text,
  expense_manual boolean not null default false,
  expense_note text,
  expense_spread_months integer,
  expense_spread_from date,
  income_category text,
  income_manual boolean not null default false,
  saved_at timestamptz not null default now(),
  primary key (user_id, external_source, external_id)
);
alter table public.manual_categories enable row level security;
drop policy if exists manual_categories_own on public.manual_categories;
create policy manual_categories_own on public.manual_categories
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.save_manual_category() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into manual_categories (user_id, external_source, external_id, expense_category, expense_manual, expense_note,
                                 expense_spread_months, expense_spread_from, income_category, income_manual)
  values (old.user_id, old.external_source, regexp_replace(old.external_id, '^pending:', ''),
          old.expense_category, old.expense_manual, old.expense_note, old.expense_spread_months, old.expense_spread_from,
          old.income_category, old.income_manual)
  on conflict (user_id, external_source, external_id) do update set
    expense_category = excluded.expense_category, expense_manual = excluded.expense_manual, expense_note = excluded.expense_note,
    expense_spread_months = excluded.expense_spread_months, expense_spread_from = excluded.expense_spread_from,
    income_category = excluded.income_category, income_manual = excluded.income_manual, saved_at = now();
  return old;
end $$;

create or replace function public.restore_manual_category() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m manual_categories;
begin
  delete from manual_categories
  where user_id = new.user_id and external_source = new.external_source
    and external_id = regexp_replace(new.external_id, '^pending:', '')
  returning * into m;
  if m.user_id is null then return new; end if;
  if m.expense_manual and not new.expense_manual then
    new.expense_category := m.expense_category;
    new.expense_manual := true;
    new.expense_spread_months := coalesce(new.expense_spread_months, m.expense_spread_months);
    new.expense_spread_from := coalesce(new.expense_spread_from, m.expense_spread_from);
  end if;
  if m.income_manual and not new.income_manual then
    new.income_category := m.income_category;
    new.income_manual := true;
  end if;
  new.expense_note := coalesce(new.expense_note, m.expense_note);
  return new;
end $$;

drop trigger if exists bank_save_manual_category on public.bank_transactions;
create trigger bank_save_manual_category after delete on public.bank_transactions
  for each row when (old.external_source is not null and old.external_id is not null
                     and (old.expense_manual or old.income_manual or old.expense_note is not null))
  execute function public.save_manual_category();
drop trigger if exists bank_restore_manual_category on public.bank_transactions;
create trigger bank_restore_manual_category before insert on public.bank_transactions
  for each row when (new.external_source is not null and new.external_id is not null)
  execute function public.restore_manual_category();

select cron.unschedule(jobid) from cron.job where jobname = 'manual-categories-purge';
select cron.schedule('manual-categories-purge', '45 3 * * *',
  $$ delete from public.manual_categories where saved_at < now() - interval '180 days' $$);
