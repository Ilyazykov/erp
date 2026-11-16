-- A delivery order's receipt (Wolt, 14.11.2026) has the courier service as its
-- chain ("WOLT GEORGIA LTD" -- the bank's name for the payment, which
-- match_receipts needs) and the restaurant as its venue ("Fire Wok Saburtalo").
-- The products table showed Wolt as where the food was bought; the user: the
-- place of purchase is the restaurant (16.11.2026). Now the venue comes first;
-- the rest as in ...213.
--
-- And a place can belong to a chain (places.chain): its branches are one shop
-- in the products table -- Fire Wok Saburtalo (via Wolt) and Fire Wok Vake
-- (in person) are both "Fire Wok", as the user asked (16.11.2026). The
-- place's chain comes before everything else.
alter table public.places add column if not exists chain text;
update public.places set chain = 'Fire Wok' where name ilike 'fire wok%' and chain is null;

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
       coalesce(nullif(pl.chain, ''),
                nullif(r.venue, ''),
                nullif(r.chain, ''),
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
