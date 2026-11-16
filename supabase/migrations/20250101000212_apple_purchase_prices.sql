-- Apple's purchases with their price in dollars (16.11.2026): each line of an
-- Apple receipt (migration ...211) with its day, the price in the currency
-- Apple charged and in dollars at that day's rate (usd_per_unit_on, as
-- product_prices does for products) -- for the price history charts
-- (index.html, mpOpenAppleHistory), switched between the two.
create or replace view public.apple_purchase_prices with (security_invoker = true) as
select i.user_id, r.id as receipt_id, r.receipt_key as order_id, r.purchased_on as day, r.currency,
       i.line_no, i.name_printed, i.name_en, i.note, i.line_total as price,
       round(i.line_total * public.usd_per_unit_on(r.currency, r.purchased_on), 2) as price_usd
from public.receipt_items i
join public.receipts r on r.id = i.receipt_id
where r.source = 'apple';
grant select on public.apple_purchase_prices to authenticated;
