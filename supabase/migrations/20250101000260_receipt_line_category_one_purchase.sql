-- A line's category set in the receipt dialog asked for the whole refresh (migration ...256):
-- refresh_expenses over all the history and the capital after it, 1.5-2 minutes and more, for
-- one line of one receipt -- and while the refresh ran into its timeout, never (26.11.2026).
-- Now only that purchase's rows in expenses are split again, at once, in the same statement:
-- the split rows of step 4b (migration ...256) are put back into the purchase's row and split
-- off anew by the lines' categories now. The whole refresh is asked for only when the purchase's
-- rows aren't the simple case step 4b leaves (one row it splits).
-- A line's product changed (resolved on the site) splits it too: the product's category counts.

create or replace function public.expenses_resplit_purchase(p_user uuid, p_source text, p_xid text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_base public.expenses;
  v_n integer;
  v_total numeric;
  v_share numeric;
begin
  -- the purchase's row step 4b splits: counted, not a fee, not a refund; one of them
  select count(*) into v_n from expenses e
  where e.user_id = p_user and e.external_source = p_source and e.external_id = p_xid and not e.receipt_split
    and e.counted and e.category <> 'Fees' and not e.description like 'Refund: %';
  if v_n = 0 then return true; end if;           -- not spending (a transfer...): nothing to split
  if v_n > 1 then return false; end if;          -- a payment in parts: the whole refresh
  select * into v_base from expenses e
  where e.user_id = p_user and e.external_source = p_source and e.external_id = p_xid and not e.receipt_split
    and e.counted and e.category <> 'Fees' and not e.description like 'Refund: %';

  -- the rows split off before: back into the purchase's row
  update expenses e set amount = e.amount + s.amount, usd = e.usd + s.usd
  from (select coalesce(sum(amount), 0) as amount, coalesce(sum(usd), 0) as usd from expenses
        where user_id = p_user and external_source = p_source and external_id = p_xid and receipt_split) s
  where e.id = v_base.id
  returning e.* into v_base;
  delete from expenses where user_id = p_user and external_source = p_source and external_id = p_xid and receipt_split;

  -- the lines' shares now, as step 4b counts them
  drop table if exists resplit_lines;
  create temp table resplit_lines on commit drop as
  select l.cat, sum(l.line_total) / t.total as share, string_agg(l.name, ', ' order by l.line_no) as items
  from receipts_active ra
  join lateral (
    select i.line_no, coalesce(i.name_en, i.name_printed) as name, coalesce(i.category, p.category) as cat, i.line_total
    from receipt_items i
    left join products p on p.id = product_root(i.product_id)
    where i.receipt_id = ra.id
  ) l on true
  left join bank_transactions b on b.user_id = ra.user_id and b.external_source = ra.tx_source and b.external_id = ra.tx_external_id
  cross join lateral (
    select coalesce(case when b.currency = ra.currency then -b.amount
                         when b.fx_rate is not null then round(-b.amount * b.fx_rate, 2) end, ra.total) as total
  ) t
  where ra.user_id = p_user and ra.tx_source = p_source and ra.tx_external_id = p_xid
    and l.cat is not null and not expense_not_spending(l.cat) and t.total > 0
    and l.cat <> v_base.category
  group by l.cat, t.total;

  select sum(share) into v_share from resplit_lines;
  -- none, or the whole purchase: step 4b leaves the row as it is
  if v_share is null or v_share <= 0 or v_share >= 1 then return true; end if;

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd,
                        category, counted, extrapolated, note, paid_at, receipt_split)
  select p_user, v_base.day, v_base.paid_day, v_base.account, v_base.external_source, v_base.external_id,
         v_base.description || ' -- ' || s.items, round(v_base.amount * s.share, 2), v_base.currency, v_base.usd * s.share,
         s.cat, true, v_base.extrapolated, v_base.note, v_base.paid_at, true
  from resplit_lines s;

  update expenses set amount = v_base.amount - (select sum(round(v_base.amount * share, 2)) from resplit_lines),
                      usd = v_base.usd * (1 - v_share)
  where id = v_base.id;
  return true;
end $$;
-- called by the trigger below only: it takes any user's id
revoke execute on function public.expenses_resplit_purchase(uuid, text, text) from public, anon, authenticated;

create or replace function public.receipt_items_category_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t record;
begin
  for t in
    select distinct ra.user_id, ra.tx_source, ra.tx_external_id
    from new_rows n join old_rows o on o.id = n.id
    join receipts_active ra on ra.id = n.receipt_id
    where (n.category is distinct from o.category or n.product_id is distinct from o.product_id)
      and ra.tx_source is not null
  loop
    if not expenses_resplit_purchase(t.user_id, t.tx_source, t.tx_external_id) then
      perform request_capital_refresh(t.user_id);
    end if;
  end loop;
  return null;
end $$;

-- the lines set while the refresh couldn't finish (SPAR 25.11.2026, toilet paper): split now
select public.expenses_resplit_purchase(ra.user_id, ra.tx_source, ra.tx_external_id)
from public.receipts_active ra
where ra.tx_source is not null
  and exists (select 1 from public.receipt_items i where i.receipt_id = ra.id and i.category is not null);
