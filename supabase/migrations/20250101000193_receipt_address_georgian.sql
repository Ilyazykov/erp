-- A receipt printed in Georgian ("ქ. თბილისი, მელიქიშვილის N16") is matched
-- to a place by its street and house like an English one ("Tbilisi Kostava
-- 20"): the address is transliterated to Latin first, and the street is
-- matched on its stem, so the Georgian genitive "melikishvilis" finds
-- "Petre Melikishvili Street". The rest of the matching is as in ...181.

-- Georgian (mkhedruli) to Latin, ISO 9984 style: the letters with two-letter
-- forms first, then the single letters.
create function public.receipt_translit(p text) returns text
language sql immutable as $$
  select translate(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p,
      'ჟ', 'zh'), 'შ', 'sh'), 'ჩ', 'ch'), 'ჭ', 'ch'), 'ც', 'ts'), 'წ', 'ts'), 'ძ', 'dz'), 'ხ', 'kh'), 'ღ', 'gh'), 'ყ', 'q'), 'ჯ', 'j'), 'ჰ', 'h'),
    'აბგდევზთიკლმნოპრსტუფქ', 'abgdevztiklmnoprstupk')
$$;

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
  -- a Georgian address is transliterated first ("მელიქიშვილის N16" -> "melikishvilis n16")
  v_addr := public.receipt_norm(public.receipt_translit(regexp_replace(coalesce(r.store_printed, ''), '^\S+\s*', '')));
  if r.city is not null and public.receipt_norm(r.city) <> '' then
    v_addr := trim(replace(' ' || v_addr || ' ', ' ' || public.receipt_norm(r.city) || ' ', ' '));
  end if;
  v_house := substring(v_addr from '(\d+)$');
  v_street := trim(regexp_replace(v_addr, '\s*\d+$', ''));
  -- the Georgian "N" before the house number
  v_street := trim(regexp_replace(v_street, '\s+n$', ''));
  if v_street = '' then v_street := null; end if;
  if v_house is null or v_street is null then v_house := null; v_street := null; end if;

  v_name := coalesce(nullif(v_chain, ''), public.receipt_norm(regexp_replace(coalesce(r.store_printed, ''), '[0-9]+', '', 'g')));
  if v_name = '' then return; end if;

  v_key := case when v_street is not null then v_name || ' ' || v_street || ' ' || v_house else v_name end;

  select place_id into v_place_id from public.store_places where user_id = v_user and store_key = v_key;

  if v_place_id is null and v_street is not null then
    -- the address: the same house on a street of the same name; the street
    -- is matched on its stem, without the genitive ending ("melikishvilis" -> "melikishvil")
    select count(*), max(p.id) into v_match_count, v_place_id
    from public.places p
    where p.user_id = v_user
      and p.house = v_house
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
        values (v_user, coalesce(nullif(r.chain, ''), r.store_printed), r.city, r.country)
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
