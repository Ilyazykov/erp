-- Migration ...255 went to the database in its first form (pushed while it was still being
-- written): the expenses rows weren't marked, the receipt's dialog had no category, nothing asked
-- for the expenses again when a line's category changed, and step 4b went through receipt_lines --
-- 0.27 s for 500 receipts, growing as their square. Here the rest of it: the mark, the view's
-- column, the trigger, and step 4b again -- the purchase's total straight from its transaction
-- (0.03 s), the split row named by its items ("... -- Papia Classic toilet paper"), and its table
-- not called `r` -- the function's loop variable is: "column reference r.id is ambiguous" stopped
-- every refresh step from 24.11.2026 20:13 UTC.

-- the row step 4b split off a purchase: its category is its lines', set on the receipt (the
-- category click opens the receipt for it, not the purchase's category)
alter table public.expenses add column receipt_split boolean not null default false;

-- the line's own category in the receipt's dialog (receipt_lines as in migration ...179, the
-- column added at the end)
create or replace view public.receipt_lines with (security_invoker = true) as
with target as (
  select ra.id as receipt_id, ra.user_id,
         coalesce(case when b.currency = ra.currency then -b.amount
                       when b.fx_rate is not null then round(-b.amount * b.fx_rate, 2) end, ra.total) as purchase_total
  from public.receipts_active ra
  left join public.bank_transactions b on b.user_id = ra.user_id and b.external_source = ra.tx_source and b.external_id = ra.tx_external_id
)
select i.receipt_id, i.user_id, i.line_no, i.name_printed, i.name_en, public.product_root(i.product_id) as product_id,
       i.qty, i.unit, i.unit_price_list, i.unit_price_paid, i.line_total, i.note, false as is_other, i.category
from public.receipt_items i
join target t on t.receipt_id = i.receipt_id
union all
select t.receipt_id, t.user_id, 10000, 'Other', 'Other', null::bigint, 1, 'other', null::numeric, null::numeric,
       t.purchase_total - coalesce(sum(i.line_total), 0), null::text, true, null::text
from target t
left join public.receipt_items i on i.receipt_id = t.receipt_id
group by t.receipt_id, t.user_id, t.purchase_total
having abs(t.purchase_total - coalesce(sum(i.line_total), 0)) >= 0.005;

-- a line's category set on the site: the expenses rebuilt within a minute (the refresh step's
-- expenses go first, migration ...149; the capital only from a week back, nothing marked dirty)
create or replace function public.receipt_items_category_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform request_capital_refresh(u) from (
    select distinct n.user_id as u from new_rows n join old_rows o on o.id = n.id
    where n.category is distinct from o.category) x;
  return null;
end $$;
create trigger receipt_items_category_changed after update on public.receipt_items
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.receipt_items_category_changed();

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  i0 int := position(E'  -- 4b. a receipt''s lines of another category' in d);
  i1 int := position(E'  -- 5. refunds (migration ...155)' in d);
  a2 text := $t$  -- 4b. a receipt's lines of another category (socks on a grocery receipt, migration ...255):
  -- their share of the purchase is a row of that category, the purchase's row keeps the rest
  drop table if exists receipt_splits;
  create temp table receipt_splits on commit drop as
  -- (the purchase's total as receipt_lines has it -- the transaction's amount in the receipt's
  -- currency, else the receipt's total -- but not through that view: it rebuilds receipts_active
  -- for every receipt asked, 0.27 s for 500 receipts and growing as their square; this, 0.03 s)
  select ra.tx_source as external_source, ra.tx_external_id as external_id, l.cat, sum(l.line_total) / t.total as share,
         string_agg(l.name, ', ' order by l.line_no) as items
  from (
    select i.receipt_id, i.line_no, coalesce(i.name_en, i.name_printed) as name, coalesce(i.category, p.category) as cat, i.line_total
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

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted, extrapolated, note, paid_at, receipt_split)
  select p_user, e.day, e.paid_day, e.account, e.external_source, e.external_id,
         e.description || ' -- ' || s.items, round(e.amount * s.share, 2), e.currency, e.usd * s.share, s.cat, true,
         e.extrapolated, e.note, e.paid_at, true
  from receipt_split_rows sr
  join expenses e on e.id = sr.id
  join receipt_splits s on s.external_source = e.external_source and s.external_id = e.external_id
    and s.cat <> e.category;

  update expenses e set amount = e.amount - round(e.amount * sr.share, 2), usd = e.usd * (1 - sr.share)
  from receipt_split_rows sr
  where e.id = sr.id;

$t$;
begin
  if i0 = 0 or i1 <= i0 then raise exception 'refresh_expenses: step 4b not found'; end if;
  execute substr(d, 1, i0 - 1) || a2 || substr(d, i1);
end $mig$;

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
