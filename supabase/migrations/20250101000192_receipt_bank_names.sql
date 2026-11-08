-- A receipt-made transaction gets the name the bank would print for its shop
-- and the category the rules give that name, straight away, not only after
-- the background rebuild. The shop name comes from receipt_descriptions (a
-- chain -> bank name table, set by the user); a chain without one keeps its
-- own name. The category is the first text rule (expense_rules) that matches
-- that name, same as the rebuild would give it; 'Other' when none does.

create table public.receipt_descriptions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chain_norm text not null,  -- receipt_norm(chain), e.g. 'hurma'
  description text not null,  -- the name as the bank prints it
  primary key (user_id, chain_norm)
);

alter table public.receipt_descriptions enable row level security;

create policy "own receipt descriptions" on public.receipt_descriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Hurma's bank name (it prints the operator's, as 1 Nov 2026 shows)
insert into public.receipt_descriptions (user_id, chain_norm, description)
values ('d8905b70-2033-4755-9d1c-617a5d609e6f', public.receipt_norm('Hurma'), 'LTD TAMARIND>TBILISI GE');

create or replace function public.receipt_make_transaction(p_receipt_id bigint, p_user uuid) returns void
language plpgsql as $$
declare
  r public.receipts;
  v_desc text;
  v_cat text;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = p_user;
  if not found then return; end if;

  select d.description into v_desc from public.receipt_descriptions d
  where d.user_id = p_user and d.chain_norm = public.receipt_norm(coalesce(r.chain, ''));
  v_desc := coalesce(v_desc, nullif(r.chain, ''), r.store_printed, 'receipt');

  -- the first text rule that matches this name alone (rules with any other
  -- condition are left to the rebuild, which applies them in full)
  select x.category into v_cat from public.expense_rules x
  where x.user_id = p_user and x.text_re is not null and v_desc ~* x.text_re
    and x.description_re is null and x.category_re is null and x.source_re is null
    and x.account is null and x.account_not is null and x.currency is null
    and x.date_from is null and x.date_to is null and x.amount_min is null and x.amount_max is null
    and x.exclude_re is null and not x.not_bought
  order by x.priority, x.id
  limit 1;
  v_cat := coalesce(v_cat, 'Other');

  insert into public.bank_transactions (user_id, account, tx_date, description, amount, currency, external_source, external_id, expense_category)
  values (p_user, '<unknown>', coalesce(r.purchased_at, r.purchased_on::timestamptz),
          v_desc, -r.total, r.currency, 'receipt_csv', r.receipt_key, v_cat)
  on conflict (user_id, external_source, external_id) do nothing;

  update public.receipts set match_state = 'linked', tx_source = 'receipt_csv', tx_external_id = r.receipt_key, updated_at = now()
  where id = p_receipt_id;

  perform public.receipt_resolve_place(p_receipt_id, '<unknown>', p_user);

  -- the expenses tab shows the purchase at once; the background rebuild
  -- (refresh_expenses) then applies the full rules
  begin
    delete from public.expenses where user_id = p_user and external_source = 'receipt_csv' and external_id = r.receipt_key;
    insert into public.expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
    values (p_user, r.purchased_on, r.purchased_on, '<unknown>', 'receipt_csv', r.receipt_key,
            v_desc, r.total, upper(r.currency),
            r.total * public.usd_per_unit_on(r.currency, r.purchased_on), v_cat, not public.expense_not_spending(v_cat));
  exception when others then
    raise warning 'receipt_make_transaction: receipt % not shown in expenses yet: %', p_receipt_id, sqlerrm;
  end;
end $$;
