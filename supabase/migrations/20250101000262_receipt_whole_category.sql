-- A receipt all of whose lines are of one category other than the purchase's: the purchase is
-- of that category (26.11.2026: Cyprus Tax Department's payment receipt, one line of Government
-- & taxes, whatever the bank names its row). Step 4b (migration ...256) splits off a share under
-- 1 only; a whole one (>= 0.995 of the purchase: rounding) now sets the purchase's category.
-- Both in refresh_expenses (new step 4c) and in the one purchase's split (migration ...260):
-- there the purchase's category is first put back to its transaction's (expense_category), so a
-- line's category taken off brings the purchase's own back.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  -- 5. refunds (migration ...155)';
  b text := $t$  -- 4c. a receipt all of whose lines are of one other category (a tax payment's receipt,
  -- migration ...262): the purchase is of that category
  update expenses e set category = s.cat
  from receipt_splits s
  where e.user_id = p_user and s.external_source = e.external_source and s.external_id = e.external_id
    and s.share >= 0.995 and e.category <> s.cat
    and e.counted and not e.receipt_split and e.category <> 'Fees' and not e.description like 'Refund: %';

  -- 5. refunds (migration ...155)$t$;
begin
  if position(a in d) = 0 then raise exception 'refresh_expenses: step 5 not found'; end if;
  execute replace(d, a, b);
end $mig$;

create or replace function public.expenses_resplit_purchase(p_user uuid, p_source text, p_xid text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_base public.expenses;
  v_n integer;
  v_share numeric;
  v_whole text;
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

  -- the rows split off before: back into the purchase's row, and its category its transaction's
  -- again (a whole receipt's category, step 4c, taken off with the line's)
  update expenses e set amount = e.amount + s.amount, usd = e.usd + s.usd,
                        category = coalesce(t.expense_category, e.category)
  from (select coalesce(sum(amount), 0) as amount, coalesce(sum(usd), 0) as usd from expenses
        where user_id = p_user and external_source = p_source and external_id = p_xid and receipt_split) s,
       (select (select expense_category from bank_transactions
                where user_id = p_user and external_source = p_source and external_id = p_xid) as expense_category) t
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

  -- the whole purchase of one other category (step 4c): its category
  select max(cat) into v_whole from resplit_lines where share >= 0.995;
  if v_whole is not null then
    update expenses set category = v_whole where id = v_base.id;
    return true;
  end if;

  select sum(share) into v_share from resplit_lines;
  -- none, or the whole purchase in several categories: step 4b leaves the row as it is
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
revoke execute on function public.expenses_resplit_purchase(uuid, text, text) from public, anon, authenticated;
