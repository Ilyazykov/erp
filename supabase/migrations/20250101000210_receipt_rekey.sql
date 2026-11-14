-- A receipt that grows (15.11.2026): a Wolt order comes as two receipts, the
-- venue's and Wolt's own (delivery, service fee), paid as one. Uploaded one by
-- one, the first is a receipt of its part; the second is put into it by
-- import-receipts, and the receipt's key and total change to the whole
-- order's. This moves the receipt to its new key and total, and with it the
-- row it made for itself (bank_transactions, its expenses row: external_id =
-- the receipt's key, the amount), the user's edits on that row kept -- so a
-- statement row of the whole payment folds into it (match_receipts). A
-- receipt linked to a statement row of its part's amount is linked again
-- (waiting): that row isn't this payment.

create or replace function public.receipt_rekey(p_receipt_id bigint, p_key text, p_total numeric) returns void
language plpgsql as $$
declare
  v_user uuid := auth.uid();
  r public.receipts;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = v_user;
  if not found or r.receipt_key = p_key then return; end if;

  if r.tx_source = 'receipt_csv' and r.tx_external_id = r.receipt_key then
    update public.bank_transactions set external_id = p_key, amount = -p_total
    where user_id = v_user and external_source = 'receipt_csv' and external_id = r.receipt_key;
    update public.expenses set external_id = p_key, amount = p_total,
           usd = p_total * public.usd_per_unit_on(currency, day)
    where user_id = v_user and external_source = 'receipt_csv' and external_id = r.receipt_key;
    update public.receipts set receipt_key = p_key, total = p_total, tx_external_id = p_key, updated_at = now()
    where id = p_receipt_id;
  elsif r.tx_source is not null then
    update public.receipts set receipt_key = p_key, total = p_total,
           match_state = 'waiting', tx_source = null, tx_external_id = null, updated_at = now()
    where id = p_receipt_id;
  else
    update public.receipts set receipt_key = p_key, total = p_total, updated_at = now()
    where id = p_receipt_id;
  end if;
end $$;

-- Where a delivery service brought an order from (15.11.2026): both of a Wolt
-- order's receipts are Wolt's -- the store and the chain as the bank names it,
-- "WOLT GEORGIA LTD" -- and the
-- restaurant (the food receipt's "Venue") is the receipt's venue. It's the place:
-- the statement rows of Wolt orders have the restaurant as their place, set by
-- hand ("Sushi Hut", "Sushi Town Vera"); by the chain every order's place was
-- "Wolt". receipt_resolve_place (migration ...199) as it was, but a Wolt
-- receipt's place is matched by its venue, and none is set while only the
-- delivery receipt is in (no venue on it) -- import-receipts asks again once the
-- food receipt joins it.
alter table public.receipts add column if not exists venue text;

create or replace function public.receipt_resolve_place(p_receipt_id bigint, p_account text, p_user uuid default null) returns void
language plpgsql as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  r public.receipts;
  v_chain text;
  v_addr text;     -- the printed address without the shop code and the city: "kostava 20"
  v_street text;   -- "kostava"
  v_house text;    -- "20"
  v_name text;     -- the name to match places by: the chain, else the printed store
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

  v_chain := public.receipt_norm(r.chain);
  -- "S146 Tbilisi Kostava 20" -> "kostava 20": the shop code, then the city, out;
  -- a Georgian address is transliterated first ("მელიქიშვილის N16" -> "melikishvilis n16");
  -- "50/50" is "50 50" here, the house as a whole
  v_addr := public.receipt_norm(public.receipt_translit(regexp_replace(coalesce(r.store_printed, ''), '^\S+\s*', '')));
  if r.city is not null and public.receipt_norm(r.city) <> '' then
    v_addr := trim(replace(' ' || v_addr || ' ', ' ' || public.receipt_norm(r.city) || ' ', ' '));
  end if;
  -- the Georgian "k" (ქ, the street) and "N" before the house number
  v_addr := trim(regexp_replace(v_addr, '\s+k\s+', ' ', 'g'));
  v_house := substring(v_addr from '(\d+(?: \d+)?)$');
  v_street := trim(regexp_replace(v_addr, '\s*\d+(?: \d+)?$', ''));
  v_street := trim(regexp_replace(v_street, '\s+n$', ''));
  if v_street = '' then v_street := null; end if;
  if v_house is null or v_street is null then v_house := null; v_street := null; end if;

  -- a Wolt receipt: the place is the restaurant (its venue), as on the statement rows
  -- set by hand ("Sushi Hut"), not Wolt; none while only the delivery receipt is in
  if v_chain like '%wolt%' then
    if public.receipt_norm(r.venue) = '' then return; end if;
    v_chain := '';
    v_street := null; v_house := null;
  end if;
  v_name := coalesce(nullif(v_chain, ''), public.receipt_norm(regexp_replace(coalesce(case when public.receipt_norm(r.chain) like '%wolt%' then r.venue else r.store_printed end, ''), '[0-9]+', '', 'g')));
  if v_name = '' then return; end if;

  v_key := case when v_street is not null then v_name || ' ' || v_street || ' ' || v_house else v_name end;

  select place_id into v_place_id from public.store_places where user_id = v_user and store_key = v_key;

  if v_place_id is null and v_street is not null then
    -- the address: the same house on a street of the same name; the street
    -- is matched on its stem, without the genitive ending ("melikishvilis" -> "melikishvil")
    select count(*), max(p.id) into v_match_count, v_place_id
    from public.places p
    where p.user_id = v_user
      and public.receipt_norm(p.house) = v_house
      and public.receipt_norm(p.street) like '%' || regexp_replace(v_street, 'is$|s$', '') || '%';
    if v_match_count <> 1 then v_place_id := null; end if;
  end if;

  if v_place_id is null then
    -- the name (and city)
    select count(*), max(p.id) into v_match_count, v_place_id
    from public.places p
    where p.user_id = v_user
      and extensions.similarity(public.receipt_norm(p.name), v_name) > 0.35
      and (r.city is null or p.city is null or public.receipt_norm(p.city) = public.receipt_norm(r.city))
      and (r.country is null or p.country is null or upper(p.country) = upper(r.country));

    -- several matches: the user picks by hand; nothing is made or remembered here
    if v_match_count > 1 then return; end if;

    -- none: a new place from the receipt
    if v_match_count = 0 then
      insert into public.places (user_id, name, city, country)
        values (v_user, case when public.receipt_norm(r.chain) like '%wolt%' then r.venue else coalesce(nullif(r.chain, ''), r.store_printed) end, r.city, r.country)
        returning id into v_place_id;
    end if;
  end if;

  insert into public.store_places (user_id, store_key, place_id) values (v_user, v_key, v_place_id)
    on conflict (user_id, store_key) do update set place_id = excluded.place_id, chosen_at = now();

  update public.receipts set place_id = v_place_id where id = p_receipt_id;

  select place_id into v_tx_place from public.bank_transactions where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  if v_tx_place is null then
    update public.bank_transactions set place_id = v_place_id where user_id = v_user and external_source = r.tx_source and external_id = r.tx_external_id;
  end if;
end $$;
