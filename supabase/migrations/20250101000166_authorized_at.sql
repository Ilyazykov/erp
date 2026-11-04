-- The moment a payment was made, when the statement has only the day it was
-- booked (asked 05.11.2026: a Wolt order's time, from its order history).
-- TBC books a card payment 1-3 days later with no time; tx_date stays the
-- booking (the running balance goes by it), authorized_at is the purchase.
-- The expenses tab's time (expenses.paid_at) is it when set. Kept like the
-- note (...146) when a row is written again.

alter table public.bank_transactions add column authorized_at timestamptz;
alter table public.manual_categories add column if not exists authorized_at timestamptz;

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  update expenses e set paid_at = b.tx_date\n';
  b text := E'  update expenses e set paid_at = coalesce(b.authorized_at, b.tx_date)\n';
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: the paid_at step not found'; end if;
  execute replace(d, a, b);
end $mig$;

create or replace function public.save_manual_category() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into manual_categories (user_id, external_source, external_id, expense_category, expense_manual, expense_note,
                                 expense_spread_months, expense_spread_from, income_category, income_manual, fx_rate, place_id,
                                 delivery_place_id, authorized_at)
  values (old.user_id, old.external_source, regexp_replace(old.external_id, '^pending:', ''),
          old.expense_category, old.expense_manual, old.expense_note, old.expense_spread_months, old.expense_spread_from,
          old.income_category, old.income_manual, old.fx_rate, old.place_id, old.delivery_place_id, old.authorized_at)
  on conflict (user_id, external_source, external_id) do update set
    expense_category = excluded.expense_category, expense_manual = excluded.expense_manual, expense_note = excluded.expense_note,
    expense_spread_months = excluded.expense_spread_months, expense_spread_from = excluded.expense_spread_from,
    income_category = excluded.income_category, income_manual = excluded.income_manual, fx_rate = excluded.fx_rate,
    place_id = excluded.place_id, delivery_place_id = excluded.delivery_place_id,
    authorized_at = excluded.authorized_at, saved_at = now();
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
  new.authorized_at := coalesce(new.authorized_at, m.authorized_at);
  return new;
end $$;

drop trigger if exists bank_save_manual_category on public.bank_transactions;
create trigger bank_save_manual_category after delete on public.bank_transactions
  for each row when (old.external_source is not null and old.external_id is not null
                     and (old.expense_manual or old.income_manual or old.expense_note is not null or old.fx_rate is not null
                          or old.place_id is not null or old.delivery_place_id is not null
                          or old.authorized_at is not null))
  execute function public.save_manual_category();
