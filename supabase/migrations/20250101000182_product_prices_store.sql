-- The shop of a price: the receipt's chain or printed store, else the
-- transaction's place's name. A manual purchase has no receipt store, so its
-- price showed no shop; its place does name one. Only the store column changed.
create or replace view public.product_prices with (security_invoker = true) as
select public.product_root(i.product_id) as product_id, i.user_id, r.purchased_on as day,
       coalesce(r.place_id, b.place_id) as place_id, r.chain, r.currency,
       i.qty, i.unit, i.unit_price_list,
       coalesce(i.unit_price_paid, i.line_total / i.qty) as unit_price_paid,
       coalesce(i.unit_price_paid, i.line_total / i.qty) * public.usd_per_unit_on(r.currency, r.purchased_on) as unit_price_usd,
       i.id as item_id, r.id as receipt_id,
       coalesce(pl.country, r.country) as country,
       coalesce(pl.city, r.city) as city,
       coalesce(r.chain, r.store_printed, pl.name) as store
from public.receipt_items i
join public.receipts r on r.id = i.receipt_id and r.superseded_by is null
left join public.bank_transactions b
  on b.user_id = r.user_id and b.external_source = r.tx_source and b.external_id = r.tx_external_id
left join public.places pl on pl.id = coalesce(r.place_id, b.place_id)
where i.product_id is not null;
