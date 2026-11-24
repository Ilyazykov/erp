-- A receipt's lines of another category, apart in the expenses (asked 25.11.2026): a SPAR receipt
-- is 'Groceries' as a whole, but socks (AlterSocks, 11.35 GEL: Clothes), toilet paper (Papia, 7.99 GEL),
-- toothbrushes or shampoo (Personal care), detergents or scissors (Household) bought with the food
-- are no groceries. Now a receipt line has
-- its own category: receipt_items.category (the receipt CSV's optional `category` column), else its
-- product's (products.category, the per-item breakdown planned in docs/items-design.md, TODO 27).
-- refresh_expenses (new step 4b) moves the lines' share of the purchase to their category; the
-- food keeps the purchase's own. A line with no category, or the purchase's own, stays where it is.
--
-- The share is of the purchase as the receipt sees it (as in receipt_lines: the transaction's amount
-- in the receipt's currency), so a purchase in another currency or with an fx fee splits by the same
-- fraction.

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
  -- (the purchase's total as receipt_lines has it -- the transaction's amount in the receipt's
  -- currency, else the receipt's total -- but not through that view: it rebuilds receipts_active
  -- for every receipt asked, 0.27 s for 500 receipts and growing as their square; this, 0.03 s)
  select ra.tx_source as external_source, ra.tx_external_id as external_id, l.cat, sum(l.line_total) / t.total as share
  from (
    select i.receipt_id, coalesce(i.category, p.category) as cat, i.line_total
    from receipt_items i
    left join products p on p.id = product_root(i.product_id)
    where i.user_id = p_user
  ) l
  join receipts_active ra on ra.id = l.receipt_id
  left join bank_transactions b on b.user_id = ra.user_id and b.external_source = ra.tx_source and b.external_id = ra.tx_external_id
  cross join lateral (
    select coalesce(case when b.currency = ra.currency then -b.amount
                         when b.fx_rate is not null then round(-b.amount * b.fx_rate, 2) end, ra.total) as total
  ) t
  where l.cat is not null and not expense_not_spending(l.cat) and t.total > 0
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
