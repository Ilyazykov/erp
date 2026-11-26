-- A shared bill (27.11.2026: Atlas, 397 GEL for the table, one tea of three mine, 15 GEL sent to the
-- one who paid): the receipt keeps every line at its price -- the prices go on being tracked -- and
-- what's mine. The receipt CSV's optional columns:
--   bill_total  the bill's printed total, the table's (the receipt's `total` stays what I paid);
--   my_qty      of a line's `qty`, how many were mine (0: none; empty: all) -- its line_total is
--               what I paid for them.
-- The expenses go by line_total and the receipt's total as before: nothing else changes for them.

alter table public.receipts add column if not exists bill_total numeric;
comment on column public.receipts.bill_total is
  'A shared bill: its printed total (the table''s); total is what I paid of it. Null: not shared';
alter table public.receipt_items add column if not exists my_qty numeric;
comment on column public.receipt_items.my_qty is
  'A shared bill: how many of qty were mine (0: none, line_total 0); null: all of them';

-- receipts_active (migration ...179) as it is, bill_total at the end
create or replace view public.receipts_active with (security_invoker = true) as
select distinct on (user_id, tx_source, tx_external_id) id, user_id, source, receipt_key, tx_source, tx_external_id,
       match_state, purchased_at, purchased_on, store_printed, chain, city, country, place_id, currency, total,
       superseded_by, last_match_candidates, last_matched_at, file_name, note, created_at, updated_at, bill_total
from public.receipts r
where tx_source is not null and match_state = any (array['linked', 'manual_link']) and superseded_by is null
order by user_id, tx_source, tx_external_id,
  case source when 'receipt_csv' then 1 when 'statement' then 2 when 'marketplace' then 3 else 4 end, updated_at desc;

-- receipt_lines (migration ...256) as it is, my_qty at the end
create or replace view public.receipt_lines with (security_invoker = true) as
with target as (
  select ra.id as receipt_id, ra.user_id,
         coalesce(case when b.currency = ra.currency then -b.amount
                       when b.fx_rate is not null then round(-b.amount * b.fx_rate, 2) end, ra.total) as purchase_total
  from public.receipts_active ra
  left join public.bank_transactions b on b.user_id = ra.user_id and b.external_source = ra.tx_source and b.external_id = ra.tx_external_id
)
select i.receipt_id, i.user_id, i.line_no, i.name_printed, i.name_en, public.product_root(i.product_id) as product_id,
       i.qty, i.unit, i.unit_price_list, i.unit_price_paid, i.line_total, i.note, false as is_other, i.category, i.my_qty
from public.receipt_items i
join target t on t.receipt_id = i.receipt_id
union all
select t.receipt_id, t.user_id, 10000, 'Other', 'Other', null::bigint, 1, 'other', null::numeric, null::numeric,
       t.purchase_total - coalesce(sum(i.line_total), 0), null::text, true, null::text, null::numeric
from target t
left join public.receipt_items i on i.receipt_id = t.receipt_id
group by t.receipt_id, t.user_id, t.purchase_total
having abs(t.purchase_total - coalesce(sum(i.line_total), 0)) >= 0.005;
