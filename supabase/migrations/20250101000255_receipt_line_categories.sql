-- A receipt's lines of another category, apart in the expenses (asked 25.11.2026): a SPAR receipt
-- is 'Groceries' as a whole, but socks (AlterSocks, 11.35 GEL: Clothes), toilet paper (Papia, 7.99 GEL),
-- toothbrushes or shampoo (Personal care), detergents or scissors (Household) bought with the food
-- are no groceries. Now a receipt line has
-- its own category: receipt_items.category (the receipt CSV's optional `category` column), else its
-- product's (products.category, the per-item breakdown planned in docs/items-design.md, TODO 27).
-- refresh_expenses (new step 4b) moves the lines' share of the purchase to their category; the
-- food keeps the purchase's own. A line with no category, or the purchase's own, stays where it is.
--
-- The share is of the purchase as the receipt sees it (receipt_lines: the lines plus the computed
-- "Other"), so a purchase in another currency or with an fx fee splits by the same fraction.

alter table public.receipt_items add column category text;
comment on column public.receipt_items.category is
  'The line''s expense category when it isn''t the purchase''s (on a grocery receipt: socks Clothes, toilet paper Personal care, detergent Household); null = the purchase''s own (or the product''s)';

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a1 text := E'  -- 5. refunds (migration ...155)';
  a2 text := $t$  -- 4b. a receipt's lines of another category (socks on a grocery receipt, migration ...255):
  -- their share of the purchase is a row of that category, the purchase's row keeps the rest
  drop table if exists receipt_splits;
  create temp table receipt_splits on commit drop as
  select ra.tx_source as external_source, ra.tx_external_id as external_id, l.cat, sum(l.line_total) / t.total as share
  from receipts_active ra
  cross join lateral (select sum(x.line_total) as total from receipt_lines x where x.receipt_id = ra.id) t
  cross join lateral (
    select coalesce(i.category, p.category) as cat, i.line_total
    from receipt_items i
    left join products p on p.id = product_root(i.product_id)
    where i.receipt_id = ra.id
  ) l
  where ra.user_id = p_user and t.total > 0 and l.cat is not null and not expense_not_spending(l.cat)
  group by ra.tx_source, ra.tx_external_id, l.cat, t.total;

  drop table if exists receipt_split_rows;
  create temp table receipt_split_rows on commit drop as
  select e.id, sum(s.share) as share
  from expenses e
  join receipt_splits s on s.external_source = e.external_source and s.external_id = e.external_id
    and s.cat <> e.category
  where e.user_id = p_user and e.counted and e.category <> 'Fees' and not e.description like 'Refund: %'
  group by e.id
  having sum(s.share) > 0 and sum(s.share) < 1;

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted, extrapolated, note, paid_at)
  select p_user, e.day, e.paid_day, e.account, e.external_source, e.external_id,
         e.description || ' -- ' || s.cat, round(e.amount * s.share, 2), e.currency, e.usd * s.share, s.cat, true,
         e.extrapolated, e.note, e.paid_at
  from receipt_split_rows r
  join expenses e on e.id = r.id
  join receipt_splits s on s.external_source = e.external_source and s.external_id = e.external_id
    and s.cat <> e.category;

  update expenses e set amount = e.amount - round(e.amount * r.share, 2), usd = e.usd * (1 - r.share)
  from receipt_split_rows r
  where e.id = r.id;

  -- 5. refunds (migration ...155)$t$;
begin
  if position(a1 in d) = 0 then raise exception 'refresh_expenses: step 5 not found'; end if;
  execute replace(d, a1, a2);
end $mig$;

-- the lines already uploaded that aren't food (SPAR, 08.11.2026)
update public.receipt_items set category = 'Personal care' where name_en = 'Papia Classic toilet paper';
update public.receipt_items set category = 'Clothes' where name_en = 'AlterSocks colorful socks (113)';

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
