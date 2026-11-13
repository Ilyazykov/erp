-- A receipt's category from its items (migration 205) never worked for a new receipt:
-- it read receipt_lines, which shows only receipts already linked (receipts_active), and
-- the receipt is marked linked further down this same function -- so the items were
-- never seen and the purchase fell to 'Other'. Now it reads receipt_items directly
-- (with product_root, as receipt_lines does, so a merged product counts as its root).
--
-- receipt_make_transaction replaced whole (migration 205 with this change).

create or replace function public.receipt_make_transaction(p_receipt_id bigint, p_user uuid) returns void
language plpgsql as $$
declare
  r public.receipts;
  v_desc text;
  v_cat text;
  v_name_cat text;
  v_item_cat text;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = p_user;
  if not found then return; end if;

  select d.description into v_desc from public.receipt_descriptions d
  where d.user_id = p_user and d.chain_norm = public.receipt_norm(coalesce(r.chain, ''));
  v_desc := coalesce(v_desc, nullif(r.chain, ''), r.store_printed, 'receipt');

  -- the first text rule that matches this name alone (rules with any other
  -- condition are left to the rebuild, which applies them in full)
  select x.category into v_name_cat from public.expense_rules x
  where x.user_id = p_user and x.text_re is not null and v_desc ~* x.text_re
    and x.description_re is null and x.category_re is null and x.source_re is null
    and x.account is null and x.account_not is null and x.currency is null
    and x.date_from is null and x.date_to is null and x.amount_min is null and x.amount_max is null
    and x.exclude_re is null and not x.not_bought
  order by x.priority, x.id
  limit 1;

  -- no shop rule: the category most of the receipt's items have (by their product)
  select p.category into v_item_cat from public.receipt_items l
  join public.products p on p.id = public.product_root(l.product_id)
  where l.receipt_id = r.id and p.category is not null
  group by p.category
  order by count(*) desc, sum(l.line_total) desc, p.category
  limit 1;

  v_cat := coalesce(v_name_cat, v_item_cat, 'Other');

  insert into public.bank_transactions (user_id, account, tx_date, description, amount, currency, external_source, external_id, expense_category, expense_manual)
  values (p_user, '<unknown>', coalesce(r.purchased_at, r.purchased_on::timestamptz),
          v_desc, -r.total, r.currency, 'receipt_csv', r.receipt_key, v_cat, v_name_cat is null and v_item_cat is not null)
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
end;
$$;
