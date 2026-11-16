-- Apple's purchases as receipts (16.11.2026). Apple's purchase history
-- (reportaproblem.apple.com, uploaded as its page's text, import-apple-purchases)
-- says what each App Store / iCloud charge on a card was: YouTube Premium,
-- Claude Pro, a game. Each order is a receipt of its own kind, source
-- 'apple', its key Apple's order ID, its lines the items -- never products:
-- no product is looked up or made for them, so they stay out of the products
-- catalog and its prices (both read lines with a product only) and never
-- show "resolve".
--
-- They are linked to the bank's charges here, not by match_receipts' own
-- rule: a card is charged on the order's day or a few days to three weeks
-- after it (Ziraat, 11.2026: Claude Pro ordered 29.10, charged 11.11), and
-- an order with no charge (2013's, before the statements; Turkey's first
-- months, paid otherwise) is never a transaction of its own -- it just waits.
alter table public.receipts drop constraint receipts_source_check;
alter table public.receipts add constraint receipts_source_check
  check (source in ('receipt_csv', 'statement', 'manual', 'marketplace', 'apple'));

-- Links the user's waiting Apple receipts, oldest first, each to the
-- nearest-dated Apple charge (description "APPLE.COM/BILL", "ITUNES.COM") of
-- its amount, from the day before the order to three weeks after it, not
-- linked to another Apple receipt yet. Pending holds are left for their
-- settled row. Returns how many it linked.
create or replace function public.match_apple_receipts(p_user uuid default null) returns integer
language plpgsql as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  r record;
  v_src text;
  v_xid text;
  v_linked integer := 0;
begin
  if v_user is null then raise exception 'match_apple_receipts: no user'; end if;

  -- a linked one whose charge is gone (a statement written again under other keys) waits again
  update public.receipts set match_state = 'waiting', tx_source = null, tx_external_id = null, updated_at = now()
  where user_id = v_user and source = 'apple' and match_state = 'linked'
    and not exists (
      select 1 from public.bank_transactions b
      where b.user_id = v_user and b.external_source = receipts.tx_source and b.external_id = receipts.tx_external_id
    );

  for r in select * from public.receipts where user_id = v_user and source = 'apple' and match_state = 'waiting'
           order by purchased_on, id loop
    v_src := null; v_xid := null;
    select b.external_source, b.external_id into v_src, v_xid
    from public.bank_transactions b
    where b.user_id = v_user and b.amount < 0 and not b.synthetic
      and (b.description ilike '%apple%' or b.description ilike '%itunes%')
      and coalesce(b.external_source, '') not in ('receipt_csv') and coalesce(b.external_source, '') not like '%:pending'
      and coalesce(b.external_id, '') not like 'pending:%'
      and coalesce(b.authorized_on, b.tx_date::date) between r.purchased_on - 1 and r.purchased_on + 21
      and (
        (b.currency = r.currency and round(-b.amount, 2) = round(r.total, 2))
        or (b.currency <> r.currency and b.fx_rate is not null and abs(round(-b.amount * b.fx_rate, 2) - r.total) <= 0.02)
      )
      and not exists (
        select 1 from public.receipts o
        where o.user_id = v_user and o.source = 'apple' and o.id <> r.id
          and o.tx_source = b.external_source and o.tx_external_id = b.external_id
          and o.match_state in ('linked', 'manual_link')
      )
    order by abs(coalesce(b.authorized_on, b.tx_date::date) - r.purchased_on), b.tx_date, b.id
    limit 1;
    continue when v_src is null;

    update public.receipts set match_state = 'linked', tx_source = v_src, tx_external_id = v_xid,
           last_matched_at = now(), updated_at = now()
    where id = r.id;
    v_linked := v_linked + 1;
  end loop;
  return v_linked;
end $$;
grant execute on function public.match_apple_receipts(uuid) to authenticated;

-- match_receipts (migration ...191) as it was, but Apple's receipts are not
-- its: left out of its loop (it would make a transaction for an order with
-- no charge) and linked by match_apple_receipts at the end -- so every
-- import that calls match_receipts links them too.
create or replace function public.match_receipts(p_user uuid default null) returns integer
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

  perform public.receipt_absorb_statement_rows(v_user);

  update public.receipts set match_state = 'waiting', tx_source = null, tx_external_id = null, updated_at = now()
  where user_id = v_user and match_state = 'linked' and source <> 'apple'
    and not exists (
      select 1 from public.bank_transactions b
      where b.user_id = v_user and b.external_source = receipts.tx_source and b.external_id = receipts.tx_external_id
    );

  for r in select * from public.receipts where user_id = v_user and match_state in ('waiting', 'ambiguous') and source <> 'apple' loop
    select count(*) into v_raw_count from public.receipt_match_candidates(r.id, v_before, v_after, v_user);
    update public.receipts set last_match_candidates = v_raw_count, last_matched_at = now() where id = r.id;
    raise notice 'match_receipts: user % receipt % (% % %) window %..% raw candidates %',
      v_user, r.id, r.purchased_on, r.currency, r.total, r.purchased_on - v_before, r.purchased_on + v_after, v_raw_count;

    if v_raw_count = 0 then
      perform public.receipt_make_transaction(r.id, v_user);
      v_linked := v_linked + 1;
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

  v_linked := v_linked + public.match_apple_receipts(v_user);
  return v_linked;
end $$;
