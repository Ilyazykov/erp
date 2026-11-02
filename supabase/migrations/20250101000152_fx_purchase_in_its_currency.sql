-- A card payment in another currency, split by ...151: the purchase now shows
-- in the currency it was made in (Spar 21.97 GEL, not 7.53 EUR), its dollars
-- at the market rate; the fee stays in the account's currency
-- ("Lost on the exchange", EUR). Asked for 03.11.2026.
-- And the rate outlives the row being written again: sync-openbanking
-- replaces Revolut's rows every run, so fx_rate -- taken from the app's
-- screenshots where the bank didn't send it -- is kept in manual_categories
-- with the hand-set fields (...146) and put back.
-- refresh_expenses is patched in place (as in ...130).

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := 'update expenses e set amount = e.amount - f.fee, usd = e.usd * (1 - f.fee / f.amt)';
  b text := 'update expenses e set amount = round(f.orig_amt, 2), currency = f.orig_ccy, usd = e.usd * (1 - f.fee / f.amt)';
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: the fx split (...151) not found'; end if;
  d := replace(d, a, b);
  -- the other currency: any the rates are kept for (MKD, ALL too), not a fixed list
  a := $q$from unnest(array['USD', 'EUR', 'GBP', 'GEL', 'TRY', 'RSD', 'RUB', 'AED', 'CNY', 'HUF', 'ILS']) c$q$;
  if position(a in d) = 0 then raise exception 'refresh_expenses: the fx currency list (...151) not found'; end if;
  d := replace(d, a, $q$from (select distinct currency as c from fx_history union select 'USD') cc$q$);
  execute d;
end $mig$;

alter table public.manual_categories add column if not exists fx_rate numeric;

create or replace function public.save_manual_category() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into manual_categories (user_id, external_source, external_id, expense_category, expense_manual, expense_note,
                                 expense_spread_months, expense_spread_from, income_category, income_manual, fx_rate)
  values (old.user_id, old.external_source, regexp_replace(old.external_id, '^pending:', ''),
          old.expense_category, old.expense_manual, old.expense_note, old.expense_spread_months, old.expense_spread_from,
          old.income_category, old.income_manual, old.fx_rate)
  on conflict (user_id, external_source, external_id) do update set
    expense_category = excluded.expense_category, expense_manual = excluded.expense_manual, expense_note = excluded.expense_note,
    expense_spread_months = excluded.expense_spread_months, expense_spread_from = excluded.expense_spread_from,
    income_category = excluded.income_category, income_manual = excluded.income_manual, fx_rate = excluded.fx_rate,
    saved_at = now();
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
  return new;
end $$;

drop trigger if exists bank_save_manual_category on public.bank_transactions;
create trigger bank_save_manual_category after delete on public.bank_transactions
  for each row when (old.external_source is not null and old.external_id is not null
                     and (old.expense_manual or old.income_manual or old.expense_note is not null or old.fx_rate is not null))
  execute function public.save_manual_category();

select request_capital_refresh(u.user_id)
from (select distinct user_id from public.bank_transactions where fx_rate is not null) u;
