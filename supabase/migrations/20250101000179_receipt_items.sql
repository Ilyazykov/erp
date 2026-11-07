-- Items within a purchase (design: docs/items-design.md, not tracked in
-- git). A card payment (bank_transactions) can be split into the products
-- on its receipt: receipts/receipt_items hold the lines, products/
-- product_aliases give each printed name a stable product across shops,
-- languages and countries, so its price can be followed over time
-- (product_prices). Items never change expense categories (TODO 27, later).
--
-- Priority when several sources cover one purchase: receipt_csv (checked by
-- hand against the paper) > statement (machine data from the bank, no
-- importer writes this yet) > marketplace (not built yet) > manual. Kept by
-- receipts_active (a plain rank, not by rewriting rows) and by
-- match_receipts's supersede step below, which only touches `superseded_by`
-- for display -- a receipt is never deleted by a better one arriving.
--
-- A receipt's total not adding up to its lines doesn't block saving: the
-- gap is a computed "Other" line (receipt_lines), not a stored row, so it
-- never goes stale when the transaction changes under it (a hold settling
-- at a different amount, a re-upload).

create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to authenticated, service_role;

-- Normalized printed name: lower case (Georgian/Cyrillic/Latin kept as is),
-- punctuation collapsed to a space, repeated spaces trimmed. Digits kept
-- ("160 გრ" stays) -- sizes are part of what makes two lines the same thing.
create function public.receipt_norm(p text) returns text
language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:][:space:]]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- A product as it really is, one row per thing bought (per user). Two
-- products found to be the same are merged by pointer (merged_into), never
-- by rewriting the lines that reference them -- product_root below follows
-- the pointer, and setting it back to null undoes the merge with the price
-- history exactly as it was.
create table public.products (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name_en text not null,
  brand text,
  size_value numeric,
  size_unit text check (size_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  barcode text,
  category text,   -- reserved for a later per-item expense breakdown (TODO 27); unused here
  merged_into bigint references public.products(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  check (merged_into is distinct from id)
);
create unique index products_barcode on public.products (user_id, barcode)
  where barcode is not null and merged_into is null;
create index products_name_trgm on public.products using gin (name_en extensions.gin_trgm_ops);
alter table public.products enable row level security;
create policy "own products" on public.products
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- A printed name the user has confirmed for a product (picked from
-- suggest_products' candidates, or typed when adding a new product). Only
-- confirmed names live here, so a line auto-links only to what's already
-- been checked once -- suggest_products never links anything by itself.
create table public.product_aliases (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  name_printed text not null,
  name_norm text not null,
  chain text not null default '',   -- '' = any shop
  country text,
  language text,
  created_at timestamptz not null default now(),
  unique (user_id, name_norm, chain)
);
create index product_aliases_trgm on public.product_aliases using gin (name_norm extensions.gin_trgm_ops);
alter table public.product_aliases enable row level security;
create policy "own product aliases" on public.product_aliases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- One receipt (a set of item lines) for one purchase, from one source.
-- Identified by the transaction's own key (tx_source/tx_external_id, the
-- same (external_source, external_id) bank_transactions is keyed by
-- everywhere else in the app) rather than its uuid, so it survives a bank
-- row being written again under the same key (sync-openbanking's
-- delete-and-insert, a re-uploaded statement) without losing its match.
-- tx_source/tx_external_id are null while it waits for its transaction
-- (match_receipts, below); its own total carries the lines until then.
create table public.receipts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null check (source in ('receipt_csv', 'statement', 'manual', 'marketplace')),
  receipt_key text not null,   -- idempotency key: receipt_csv "<date>|<printed number>|<total>"; manual a uuid
  tx_source text,
  tx_external_id text,
  match_state text not null default 'waiting'
    check (match_state in ('linked', 'waiting', 'ambiguous', 'manual_link')),
  purchased_at timestamptz,
  purchased_on date not null,
  store_printed text,
  chain text,
  city text,
  country text,
  place_id bigint references public.places(id) on delete set null,
  currency text not null,
  total numeric not null check (total > 0),
  superseded_by bigint references public.receipts(id) on delete set null,
  last_match_candidates integer,
  last_matched_at timestamptz,
  file_name text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, receipt_key),
  check ((tx_source is null) = (tx_external_id is null))
);
create index receipts_tx on public.receipts (user_id, tx_source, tx_external_id);
create index receipts_day on public.receipts (user_id, purchased_on);
alter table public.receipts enable row level security;
create policy "own receipts" on public.receipts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.receipt_items (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  receipt_id bigint not null references public.receipts(id) on delete cascade,
  line_no integer not null,
  name_printed text not null,
  name_en text,
  product_id bigint references public.products(id) on delete set null,
  qty numeric not null default 1 check (qty > 0),
  unit text not null default 'pcs' check (unit in ('pcs', 'kg', 'l', 'other')),
  unit_price_list numeric,
  unit_price_paid numeric,
  line_total numeric not null,
  barcode text,
  note text,
  created_at timestamptz not null default now(),
  unique (receipt_id, line_no)
);
create index receipt_items_product on public.receipt_items (user_id, product_id);
alter table public.receipt_items enable row level security;
create policy "own receipt items" on public.receipt_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The place the user picked for a store once (name/chain normalized),
-- remembered so the next receipt from the same store picks it by itself
-- (receipt_resolve_place, below). Wrong picks are reviewed by hand later --
-- update this row (or the transaction's place_id directly) to fix one.
create table public.store_places (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_key text not null,
  place_id bigint not null references public.places(id) on delete cascade,
  chosen_at timestamptz not null default now(),
  primary key (user_id, store_key)
);
alter table public.store_places enable row level security;
create policy "own store places" on public.store_places
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- A store search needs it too (receipt_resolve_place matches a receipt's
-- store against places.name by trigram similarity).
create index places_name_trgm on public.places using gin (name extensions.gin_trgm_ops);

-- The product a merged product now is (follows merged_into to the end --
-- a chain longer than a few hops shouldn't happen by hand, but the
-- recursion has no artificial depth limit beyond Postgres' own).
create function public.product_root(p_id bigint) returns bigint
language sql stable as $$
  with recursive r(id, next) as (
    select id, merged_into from public.products where id = p_id
    union all
    select p.id, p.merged_into from public.products p join r on p.id = r.next
  ) select id from r where next is null limit 1
$$;

-- The receipt in force for a transaction: the best-ranked one that's
-- linked and not superseded. The rank order alone would already pick the
-- right one even without superseded_by (every receipt of a tx key is
-- compared here by source); superseded_by exists only so the page can show
-- *why* a lower one is hidden and point at what replaced it.
create view public.receipts_active with (security_invoker = true) as
select distinct on (r.user_id, r.tx_source, r.tx_external_id) r.*
from public.receipts r
where r.tx_source is not null and r.match_state in ('linked', 'manual_link') and r.superseded_by is null
order by r.user_id, r.tx_source, r.tx_external_id,
         case r.source when 'receipt_csv' then 1 when 'statement' then 2 when 'marketplace' then 3 else 4 end,
         r.updated_at desc;

-- Every line of the receipt in force for a transaction, plus a computed
-- "Other" line for whatever the lines don't cover -- so the lines always
-- add up to the purchase, without a stored row that could go stale. The
-- purchase total is the linked transaction's amount (converted with its
-- fx_rate when its currency differs from the receipt's), or the receipt's
-- own total while it still waits for one.
create view public.receipt_lines with (security_invoker = true) as
with target as (
  select ra.id as receipt_id, ra.user_id,
         coalesce(
           case when b.currency = ra.currency then -b.amount
                when b.fx_rate is not null then round(-b.amount * b.fx_rate, 2) end,
           ra.total) as purchase_total
  from public.receipts_active ra
  left join public.bank_transactions b
    on b.user_id = ra.user_id and b.external_source = ra.tx_source and b.external_id = ra.tx_external_id
)
select i.receipt_id, i.user_id, i.line_no, i.name_printed, i.name_en, public.product_root(i.product_id) as product_id,
       i.qty, i.unit, i.unit_price_list, i.unit_price_paid, i.line_total, i.note, false as is_other
from public.receipt_items i
join target t on t.receipt_id = i.receipt_id
union all
select t.receipt_id, t.user_id, 10000, 'Other', 'Other', null, 1, 'other', null, null,
       t.purchase_total - coalesce(sum(i.line_total), 0), null, true
from target t left join public.receipt_items i on i.receipt_id = t.receipt_id
group by t.receipt_id, t.user_id, t.purchase_total
having abs(t.purchase_total - coalesce(sum(i.line_total), 0)) >= 0.005;

-- Price history: one row per purchase of a product, from the lines
-- themselves -- a separate history table would only duplicate them.
create view public.product_prices with (security_invoker = true) as
select public.product_root(i.product_id) as product_id, i.user_id, r.purchased_on as day,
       coalesce(r.place_id, b.place_id) as place_id, r.chain, r.currency,
       i.qty, i.unit, i.unit_price_list,
       coalesce(i.unit_price_paid, i.line_total / i.qty) as unit_price_paid,
       coalesce(i.unit_price_paid, i.line_total / i.qty) * public.usd_per_unit_on(r.currency, r.purchased_on) as unit_price_usd,
       i.id as item_id, r.id as receipt_id
from public.receipt_items i
join public.receipts r on r.id = i.receipt_id and r.superseded_by is null
left join public.bank_transactions b
  on b.user_id = r.user_id and b.external_source = r.tx_source and b.external_id = r.tx_external_id
where i.product_id is not null;

-- Candidate transactions for a waiting/ambiguous receipt: amount equal to
-- its total (to the cent) in its own currency, or converted at the row's
-- own fx_rate when it was paid in another one; dated from the day before
-- the purchase to five days after (TBC books a card payment one to three
-- days after it was made, keeping the purchase day in its description,
-- which import-bank-csv already reads into authorized_on); not already
-- another active receipt's transaction. chain_hit / date_dist are match_
-- receipts' two tie-breakers (prefer the receipt's own chain in the
-- description, then the nearest date). p_user defaults to auth.uid() so the
-- page can call this directly too (the ambiguous-receipts panel, to list
-- what to pick from) -- safe without security definer: RLS on receipts/
-- bank_transactions still scopes everything to auth.uid() regardless of
-- what p_user is given, same as any other RPC.
create function public.receipt_match_candidates(p_receipt_id bigint, p_before integer default 1, p_after integer default 5, p_user uuid default null)
returns table (external_source text, external_id text, account text, chain_hit boolean, date_dist integer)
language sql stable as $$
  select b.external_source, b.external_id, b.account,
         (r.chain is not null and r.chain <> '' and b.description ilike '%' || r.chain || '%') as chain_hit,
         abs(coalesce(b.authorized_on, b.tx_date::date) - r.purchased_on) as date_dist
  from public.receipts r, public.bank_transactions b
  where r.id = p_receipt_id and r.user_id = coalesce(p_user, auth.uid())
    and b.user_id = coalesce(p_user, auth.uid()) and b.amount < 0 and not b.synthetic
    and coalesce(b.authorized_on, b.tx_date::date) between r.purchased_on - p_before and r.purchased_on + p_after
    and (
      (b.currency = r.currency and round(-b.amount, 2) = round(r.total, 2))
      or (b.currency <> r.currency and b.fx_rate is not null and abs(round(-b.amount * b.fx_rate, 2) - r.total) <= 0.02)
    )
    and not exists (
      select 1 from public.receipts other
      where other.user_id = coalesce(p_user, auth.uid()) and other.source = r.source and other.id <> r.id
        and other.tx_source = b.external_source and other.tx_external_id = b.external_id
        and other.match_state in ('linked', 'manual_link')
    )
$$;

-- The place for a receipt's store, resolved in this order (06.11.2026,
-- asked and decided with the user): a store already chosen before
-- (store_places) -> exactly one existing place close enough by name (and
-- city, when both give one) -> a new place made from the receipt, left for
-- the user to fix by hand (name/city/street/house) same as any other place.
-- Several close matches are left unresolved (place_id null) rather than
-- guessed -- the existing per-transaction place picker (mpEditPlace,
-- index.html) already lets the user set it, and doing so there saves the
-- choice to store_places too (so the next receipt from that store doesn't
-- ask again). Never overwrites a transaction's place if it already has one.
-- p_user defaults to auth.uid() (as receipt_match_candidates does), so the
-- page can also call this directly after a manual pick in the ambiguous-
-- receipts panel (match_receipts' own loop only runs it for a receipt it
-- links itself, not one the user resolved by hand straight to manual_link).
create function public.receipt_resolve_place(p_receipt_id bigint, p_account text, p_user uuid default null) returns void
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
  if not found or r.place_id is not null then return; end if;

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

-- Links waiting/ambiguous receipts to transactions and keeps the supersede
-- pointers right. Called by import-receipts after an upload, by
-- import-bank-csv after a statement import, and by sync-openbanking after
-- a sync (that one runs as the service role across every user, so p_user is
-- required there; import-receipts/import-bank-csv run as the signed-in
-- user and can leave it out). Not security definer: every query here
-- filters by p_user itself, and under the signed-in user's own role RLS on
-- receipts/bank_transactions filters to auth.uid() as everywhere else
-- regardless -- a spoofed p_user just sees nothing, same as any other RPC.
-- Returns how many receipts it linked this run.
create function public.match_receipts(p_user uuid default null) returns integer
language plpgsql as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_before constant integer := 1;
  v_after constant integer := 5;
  r record;
  v_raw_count integer;
  v_narrow_count integer;
  v_pick_src text;
  v_pick_xid text;
  v_pick_acc text;
  v_linked integer := 0;
begin
  if v_user is null then raise exception 'match_receipts: no user'; end if;

  -- a 'linked' receipt whose transaction is gone (dropStale, a hold removed
  -- with no settlePending repoint) is matched again, not left pointing at nothing
  update public.receipts set match_state = 'waiting', tx_source = null, tx_external_id = null, updated_at = now()
  where user_id = v_user and match_state = 'linked'
    and not exists (
      select 1 from public.bank_transactions b
      where b.user_id = v_user and b.external_source = receipts.tx_source and b.external_id = receipts.tx_external_id
    );

  for r in select * from public.receipts where user_id = v_user and match_state in ('waiting', 'ambiguous') loop
    select count(*) into v_raw_count from public.receipt_match_candidates(r.id, v_before, v_after, v_user);
    update public.receipts set last_match_candidates = v_raw_count, last_matched_at = now() where id = r.id;
    raise notice 'match_receipts: user % receipt % (% % %) window %..% raw candidates %',
      v_user, r.id, r.purchased_on, r.currency, r.total, r.purchased_on - v_before, r.purchased_on + v_after, v_raw_count;

    if v_raw_count = 0 then
      if r.match_state <> 'waiting' then update public.receipts set match_state = 'waiting' where id = r.id; end if;
      continue;
    end if;

    with cand as (select * from public.receipt_match_candidates(r.id, v_before, v_after, v_user)),
         any_chain as (select bool_or(chain_hit) as v from cand),
         narrowed as (select cand.* from cand, any_chain where chain_hit = any_chain.v or not any_chain.v),
         best_date as (select min(date_dist) as d from narrowed),
         final as (select narrowed.* from narrowed, best_date where date_dist = best_date.d)
    select count(*), max(external_source), max(external_id), max(account)
      into v_narrow_count, v_pick_src, v_pick_xid, v_pick_acc
      from final;

    if v_narrow_count = 1 then
      update public.receipts set match_state = 'linked', tx_source = v_pick_src, tx_external_id = v_pick_xid, updated_at = now()
      where id = r.id;
      v_linked := v_linked + 1;
      perform public.receipt_resolve_place(r.id, v_pick_acc, v_user);
    elsif r.match_state <> 'ambiguous' then
      update public.receipts set match_state = 'ambiguous' where id = r.id;
    end if;
  end loop;

  -- supersede: for every transaction key with more than one linked receipt,
  -- the best-ranked one is the active one; the rest point at it (so the page
  -- can say "superseded by the receipt CSV of ..."), un-pointed if they
  -- become the best themselves again (the receipt CSV unlinked, say)
  with ranked as (
    select id,
           row_number() over (partition by tx_source, tx_external_id
             order by case source when 'receipt_csv' then 1 when 'statement' then 2 when 'marketplace' then 3 else 4 end,
                      updated_at desc) as rnk,
           first_value(id) over (partition by tx_source, tx_external_id
             order by case source when 'receipt_csv' then 1 when 'statement' then 2 when 'marketplace' then 3 else 4 end,
                      updated_at desc) as best_id
    from public.receipts
    where user_id = v_user and tx_source is not null and match_state in ('linked', 'manual_link')
  )
  update public.receipts rec set superseded_by = case when ranked.rnk = 1 then null else ranked.best_id end
  from ranked
  where rec.id = ranked.id
    and rec.superseded_by is distinct from (case when ranked.rnk = 1 then null else ranked.best_id end);

  return v_linked;
end $$;

-- Candidate products for a printed line (by its printed name and English
-- translation, against confirmed aliases and product names): never links
-- anything by itself, only offers choices the user confirms (the page's
-- "resolve" control on a line with no product).
create function public.suggest_products(p_name text, p_name_en text, p_chain text default null)
returns table (product_id bigint, name_en text, score real, via text)
language sql stable as $$
  select a.product_id, p.name_en, extensions.similarity(a.name_norm, public.receipt_norm(p_name)) as score, 'alias'::text as via
  from public.product_aliases a join public.products p on p.id = a.product_id
  where a.user_id = auth.uid() and p.merged_into is null
    and (a.chain = '' or a.chain = coalesce(p_chain, ''))
    and extensions.similarity(a.name_norm, public.receipt_norm(p_name)) > 0.3
  union all
  select p.id, p.name_en, extensions.similarity(p.name_en, coalesce(p_name_en, p_name)) as score, 'name_en'::text as via
  from public.products p
  where p.user_id = auth.uid() and p.merged_into is null
    and extensions.similarity(p.name_en, coalesce(p_name_en, p_name)) > 0.3
  order by score desc
  limit 8
$$;
