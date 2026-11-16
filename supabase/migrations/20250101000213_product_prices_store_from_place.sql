-- A receipt entered by hand has no chain: product_prices named its store by
-- the place the payment is tied to ("Spar", "HURMA"), while the receipts read
-- from a CSV of the same shop say "SPAR" / "Hurma" -- one shop, two names in
-- the products table (16.11.2026). Now such a receipt takes the chain the
-- other receipts of its place have (the most frequent), then its printed
-- store, then the place's name, as before.
create or replace view public.product_prices with (security_invoker = true) as
select public.product_root(i.product_id) as product_id,
       i.user_id,
       r.purchased_on as day,
       coalesce(r.place_id, b.place_id) as place_id,
       r.chain,
       r.currency,
       i.qty,
       i.unit,
       i.unit_price_list,
       coalesce(i.unit_price_paid, i.line_total / i.qty) as unit_price_paid,
       coalesce(i.unit_price_paid, i.line_total / i.qty) * public.usd_per_unit_on(r.currency, r.purchased_on) as unit_price_usd,
       i.id as item_id,
       r.id as receipt_id,
       coalesce(pl.country, r.country) as country,
       coalesce(pl.city, r.city) as city,
       coalesce(nullif(r.chain, ''),
                (select r2.chain from public.receipts r2
                 left join public.bank_transactions b2 on b2.user_id = r2.user_id and b2.external_source = r2.tx_source and b2.external_id = r2.tx_external_id
                 where r2.user_id = r.user_id and r2.superseded_by is null and nullif(r2.chain, '') is not null
                   and coalesce(r2.place_id, b2.place_id) = coalesce(r.place_id, b.place_id)
                 group by r2.chain order by count(*) desc, r2.chain limit 1),
                nullif(r.store_printed, ''), pl.name) as store
from public.receipt_items i
join public.receipts r on r.id = i.receipt_id and r.superseded_by is null
left join public.bank_transactions b on b.user_id = r.user_id and b.external_source = r.tx_source and b.external_id = r.tx_external_id
left join public.places pl on pl.id = coalesce(r.place_id, b.place_id)
where i.product_id is not null;
