-- The product catalog is shared between users (a Dardanel tuna salad is the
-- same product whoever buys it, and in whatever shop). Prices stay personal:
-- they come from receipt_items, which keep their own per-user RLS, so the
-- product_prices view still shows each user only their own purchases.
--
-- The catalog has no owner: products and confirmed printed names are open to
-- every signed-in user (one user now; friends later, who may change or delete
-- anything -- accepted). So user_id goes from products and product_aliases.
--
-- A merge is one level only: a product merged into another (merged_into)
-- points straight at a product that is not merged itself, and a product with
-- products merged into it can't be merged. So there are no chains and no
-- cycles, and product_root is one lookup. Undoing a merge (merged_into back to
-- null) restores the history exactly, nothing moves. The guard is a trigger, so
-- the database refuses it whatever the page does.
--
-- Barcodes and printed names are global: one barcode, one product; one
-- printed name per shop chain, pointing at one product.

-- user_id goes: its policies and constraints first, then the column
drop policy if exists "products read" on public.products;
drop policy if exists "products create" on public.products;
drop policy if exists "products update" on public.products;
drop policy if exists "products delete" on public.products;
drop policy if exists "own products" on public.products;
drop policy if exists "product aliases read" on public.product_aliases;
drop policy if exists "product aliases create" on public.product_aliases;
drop policy if exists "product aliases update" on public.product_aliases;
drop policy if exists "product aliases delete" on public.product_aliases;
drop policy if exists "own product aliases" on public.product_aliases;
alter table public.product_aliases drop constraint if exists product_aliases_user_id_name_norm_chain_key;
alter table public.products drop column if exists user_id;
alter table public.product_aliases drop column if exists user_id;

create policy "products open" on public.products
  for all to authenticated using (true) with check (true);
create policy "product aliases open" on public.product_aliases
  for all to authenticated using (true) with check (true);

drop index if exists public.products_barcode;
create unique index products_barcode on public.products (barcode)
  where barcode is not null and merged_into is null;

alter table public.product_aliases add constraint product_aliases_name_norm_chain_key unique (name_norm, chain);

-- suggest_products: no per-user filter any more; RLS (read to all) does the rest
create or replace function public.suggest_products(p_name text, p_name_en text, p_chain text default null)
returns table (product_id bigint, name_en text, score real, via text)
language sql stable as $$
  select a.product_id, p.name_en, extensions.similarity(a.name_norm, public.receipt_norm(p_name)) as score, 'alias'::text as via
  from public.product_aliases a join public.products p on p.id = a.product_id
  where p.merged_into is null
    and (a.chain = '' or a.chain = coalesce(p_chain, ''))
    and extensions.similarity(a.name_norm, public.receipt_norm(p_name)) > 0.3
  union all
  select p.id, p.name_en, extensions.similarity(p.name_en, coalesce(p_name_en, p_name)) as score, 'name_en'::text as via
  from public.products p
  where p.merged_into is null
    and extensions.similarity(p.name_en, coalesce(p_name_en, p_name)) > 0.3
  order by score desc
  limit 8
$$;

-- The purchase time comes from the receipt when it's printed (it's exact, so
-- not approximate). Set only where the transaction has no time yet: a time
-- set by hand, or one the statement gives, is never overwritten. Done here
-- because receipt_resolve_place runs on every link -- from match_receipts
-- and from the page's manual pick -- and this is what a link means for the
-- transaction. The receipt's wall-clock time is stored labelled as UTC, the
-- same convention the statements' own times use (import-bank-csv, tx_date).
create or replace function public.receipt_resolve_place(p_receipt_id bigint, p_account text, p_user uuid default null) returns void
language plpgsql as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  r public.receipts;
  v_key text;
  v_place_id bigint;
  v_match_count integer;
  v_tx_place bigint;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = v_user;
  if not found then return; end if;

  -- the time first: it doesn't depend on the place, and it applies even when
  -- the receipt already has one
  if r.purchased_at is not null and r.tx_source is not null then
    update public.bank_transactions
    set authorized_at = r.purchased_at, authorized_approx = false
    where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id
      and authorized_at is null;
  end if;

  if r.place_id is not null then return; end if;

  v_key := coalesce(nullif(public.receipt_norm(r.chain), ''), public.receipt_norm(regexp_replace(coalesce(r.store_printed, ''), '[0-9]+', '', 'g')));
  if v_key = '' then return; end if;

  select place_id into v_place_id from public.store_places where user_id = v_user and store_key = v_key;

  if v_place_id is null then
    select count(*), max(p.id) into v_match_count, v_place_id
    from public.places p
    where p.user_id = v_user
      and extensions.similarity(public.receipt_norm(p.name), v_key) > 0.35
      and (r.city is null or p.city is null or public.receipt_norm(p.city) = public.receipt_norm(r.city));
    if v_match_count <> 1 then v_place_id := null; end if;

    if v_place_id is null then
      insert into public.places (user_id, name, city) values (v_user, coalesce(nullif(r.chain, ''), r.store_printed), r.city)
        returning id into v_place_id;
    end if;
    insert into public.store_places (user_id, store_key, place_id) values (v_user, v_key, v_place_id)
      on conflict (user_id, store_key) do update set place_id = excluded.place_id, chosen_at = now();
  end if;

  update public.receipts set place_id = v_place_id where id = p_receipt_id;

  select place_id into v_tx_place from public.bank_transactions where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  if v_tx_place is null then
    update public.bank_transactions set place_id = v_place_id where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  end if;
end $$;

-- Where a price was paid: country and city of the place (the place's own
-- country, else the receipt's), and the shop. A place with coordinates gets
-- its country once, from the same reverse geocoding the page already uses for
-- its address (mpAddressAt); a place made from a receipt takes the receipt's
-- country. The pair (country, city) is what makes a city unambiguous, so it's
-- what prices are compared by.
alter table public.places add column if not exists country text;

-- the receipt's place above: a place made from a receipt takes its country too
create or replace function public.receipt_resolve_place(p_receipt_id bigint, p_account text, p_user uuid default null) returns void
language plpgsql as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  r public.receipts;
  v_key text;
  v_place_id bigint;
  v_match_count integer;
  v_tx_place bigint;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = v_user;
  if not found then return; end if;

  if r.purchased_at is not null and r.tx_source is not null then
    update public.bank_transactions
    set authorized_at = r.purchased_at, authorized_approx = false
    where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id
      and authorized_at is null;
  end if;

  if r.place_id is not null then return; end if;

  v_key := coalesce(nullif(public.receipt_norm(r.chain), ''), public.receipt_norm(regexp_replace(coalesce(r.store_printed, ''), '[0-9]+', '', 'g')));
  if v_key = '' then return; end if;

  select place_id into v_place_id from public.store_places where user_id = v_user and store_key = v_key;

  if v_place_id is null then
    select count(*), max(p.id) into v_match_count, v_place_id
    from public.places p
    where p.user_id = v_user
      and extensions.similarity(public.receipt_norm(p.name), v_key) > 0.35
      and (r.city is null or p.city is null or public.receipt_norm(p.city) = public.receipt_norm(r.city))
      and (r.country is null or p.country is null or p.country = r.country);
    if v_match_count <> 1 then v_place_id := null; end if;

    if v_place_id is null then
      insert into public.places (user_id, name, city, country)
        values (v_user, coalesce(nullif(r.chain, ''), r.store_printed), r.city, r.country)
        returning id into v_place_id;
    end if;
    insert into public.store_places (user_id, store_key, place_id) values (v_user, v_key, v_place_id)
      on conflict (user_id, store_key) do update set place_id = excluded.place_id, chosen_at = now();
  end if;

  update public.receipts set place_id = v_place_id where id = p_receipt_id;

  select place_id into v_tx_place from public.bank_transactions where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  if v_tx_place is null then
    update public.bank_transactions set place_id = v_place_id where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  end if;
end $$;

-- product_prices with where it was paid, appended after the existing columns
-- (create or replace keeps the old column order, so the existing readers are fine)
create or replace view public.product_prices with (security_invoker = true) as
select public.product_root(i.product_id) as product_id, i.user_id, r.purchased_on as day,
       coalesce(r.place_id, b.place_id) as place_id, r.chain, r.currency,
       i.qty, i.unit, i.unit_price_list,
       coalesce(i.unit_price_paid, i.line_total / i.qty) as unit_price_paid,
       coalesce(i.unit_price_paid, i.line_total / i.qty) * public.usd_per_unit_on(r.currency, r.purchased_on) as unit_price_usd,
       i.id as item_id, r.id as receipt_id,
       coalesce(pl.country, r.country) as country,
       coalesce(pl.city, r.city) as city,
       coalesce(r.chain, r.store_printed) as store
from public.receipt_items i
join public.receipts r on r.id = i.receipt_id and r.superseded_by is null
left join public.bank_transactions b
  on b.user_id = r.user_id and b.external_source = r.tx_source and b.external_id = r.tx_external_id
left join public.places pl on pl.id = coalesce(r.place_id, b.place_id)
where i.product_id is not null;

-- Comparison: per product, country, city and shop, the last price paid and
-- the lowest and highest, all in dollars at each day's rate. The user's own
-- purchases only (product_prices reads receipt_items under RLS).
create view public.product_price_compare with (security_invoker = true) as
select product_id, user_id, country, city, store,
       count(*) as purchases,
       min(unit_price_usd) as min_usd,
       max(unit_price_usd) as max_usd,
       (array_agg(unit_price_usd order by day desc, item_id desc))[1] as last_usd,
       max(day) as last_day
from public.product_prices
group by product_id, user_id, country, city, store;

-- Merges are one level (see the header): a merged product's target must not
-- itself be merged, and a product with products merged into it can't be
-- merged. Enforced here, so no page or script can build a chain or a loop.
create or replace function public.products_merge_guard() returns trigger
language plpgsql as $$
begin
  if new.merged_into is null then return new; end if;
  if exists (select 1 from public.products t where t.id = new.merged_into and t.merged_into is not null) then
    raise exception 'That product is already merged into another one -- merge into that one instead.';
  end if;
  if exists (select 1 from public.products c where c.merged_into = new.id) then
    raise exception 'Other products are merged into this one -- undo those merges first.';
  end if;
  return new;
end $$;

drop trigger if exists products_merge_guard on public.products;
create trigger products_merge_guard before insert or update of merged_into on public.products
  for each row execute function public.products_merge_guard();

-- one lookup now: a merged product's target is never merged itself
create or replace function public.product_root(p_id bigint) returns bigint
language sql stable as $$
  select coalesce((select p.merged_into from public.products p where p.id = p_id), p_id)
$$;
