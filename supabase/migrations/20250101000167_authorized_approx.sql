-- A time set by hand may be a guess (asked 05.11.2026: "about 16:10" -- the
-- day is known, the minute isn't): authorized_approx marks it, the expenses
-- tab shows it as "~16:10". Kept with the time (...166) when a row is written
-- again.

alter table public.bank_transactions add column authorized_approx boolean not null default false;
alter table public.manual_categories add column if not exists authorized_approx boolean not null default false;

create or replace function public.save_manual_category() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into manual_categories (user_id, external_source, external_id, expense_category, expense_manual, expense_note,
                                 expense_spread_months, expense_spread_from, income_category, income_manual, fx_rate, place_id,
                                 delivery_place_id, authorized_at, authorized_approx)
  values (old.user_id, old.external_source, regexp_replace(old.external_id, '^pending:', ''),
          old.expense_category, old.expense_manual, old.expense_note, old.expense_spread_months, old.expense_spread_from,
          old.income_category, old.income_manual, old.fx_rate, old.place_id, old.delivery_place_id, old.authorized_at, old.authorized_approx)
  on conflict (user_id, external_source, external_id) do update set
    expense_category = excluded.expense_category, expense_manual = excluded.expense_manual, expense_note = excluded.expense_note,
    expense_spread_months = excluded.expense_spread_months, expense_spread_from = excluded.expense_spread_from,
    income_category = excluded.income_category, income_manual = excluded.income_manual, fx_rate = excluded.fx_rate,
    place_id = excluded.place_id, delivery_place_id = excluded.delivery_place_id,
    authorized_at = excluded.authorized_at, authorized_approx = excluded.authorized_approx, saved_at = now();
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
  new.fx_rate := coalesce(new.fx_rate, m.fx_rate);
  new.place_id := coalesce(new.place_id, m.place_id);
  new.delivery_place_id := coalesce(new.delivery_place_id, m.delivery_place_id);
  if new.authorized_at is null and m.authorized_at is not null then
    new.authorized_at := m.authorized_at;
    new.authorized_approx := m.authorized_approx;
  end if;
  return new;
end $$;

drop trigger if exists bank_save_manual_category on public.bank_transactions;
create trigger bank_save_manual_category after delete on public.bank_transactions
  for each row when (old.external_source is not null and old.external_id is not null
                     and (old.expense_manual or old.income_manual or old.expense_note is not null or old.fx_rate is not null
                          or old.place_id is not null or old.delivery_place_id is not null
                          or old.authorized_at is not null))
  execute function public.save_manual_category();
