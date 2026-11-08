-- A receipt with no bank transaction to link to makes one itself, so the
-- purchase shows up at once instead of waiting for a statement that may not
-- have the day yet. Such a row has account '<unknown>' (the receipt doesn't
-- say which account paid; the user changes it by hand, like any account),
-- external_source 'receipt_csv', and external_id = the receipt's key.
--
-- When a settled statement row carries the same payment (the same match
-- receipt_match_candidates uses: amount and currency, or the statement's
-- fx_rate in another currency, within the window), its fields are written
-- onto the receipt's own row: account, date, amount, description, balance,
-- category, ... The user's edits on either row (note, place, manual
-- category, spread, ...) are kept, and the receipt's exact purchase time is
-- kept where it has one. The statement row is not kept as a second copy: it
-- is deleted and the receipt's row takes over its external_source and
-- external_id, so the next import of the same statement updates that row in
-- place (the upsert hits the same key). The receipt is repointed to it.

-- The row a receipt makes for itself when no transaction matched it.
create function public.receipt_make_transaction(p_receipt_id bigint, p_user uuid) returns void
language plpgsql as $$
declare
  r public.receipts;
begin
  select * into r from public.receipts where id = p_receipt_id and user_id = p_user;
  if not found then return; end if;

  insert into public.bank_transactions (user_id, account, tx_date, description, amount, currency, external_source, external_id)
  values (p_user, '<unknown>', coalesce(r.purchased_at, r.purchased_on::timestamptz),
          coalesce(nullif(r.chain, ''), r.store_printed, 'receipt'), -r.total, r.currency, 'receipt_csv', r.receipt_key)
  on conflict (user_id, external_source, external_id) do nothing;

  update public.receipts set match_state = 'linked', tx_source = 'receipt_csv', tx_external_id = r.receipt_key, updated_at = now()
  where id = p_receipt_id;

  perform public.receipt_resolve_place(p_receipt_id, '<unknown>', p_user);
end $$;

-- Folds settled statement rows into the receipt-made rows of the same
-- payments. Receipts are taken in date order. A receipt takes its nearest
-- settled candidate (receipt_match_candidates, by date_dist), but only when
-- no other receipt that is still open (waiting, ambiguous, or made from a
-- receipt) has that same statement row at an equal or nearer date: two
-- identical payments are paired by date, and a tie is left alone rather than
-- guessed. A merge that fails is logged as a warning and skipped, so one bad
-- row doesn't abort the whole import. Returns how many were merged.
create function public.receipt_absorb_statement_rows(p_user uuid) returns integer
language plpgsql as $$
declare
  rc record;
  s record;
  v_src text;
  v_xid text;
  v_dist integer;
  v_merged integer := 0;
begin
  for rc in
    select rec.id as receipt_id, rec.receipt_key
    from public.receipts rec
    where rec.user_id = p_user and rec.source = 'receipt_csv'
      and rec.tx_source = 'receipt_csv' and rec.tx_external_id = rec.receipt_key
    order by rec.purchased_on, rec.id
  loop
    -- the nearest settled statement row for this receipt's payment
    select c.external_source, c.external_id, c.date_dist into v_src, v_xid, v_dist
    from public.receipt_match_candidates(rc.receipt_id, 1, 5, p_user) c
    where c.external_source <> 'receipt_csv' and c.external_source not like '%:pending'
      and c.external_id is not null and c.external_id not like 'pending:%'
    order by c.date_dist, c.external_source, c.external_id
    limit 1;
    continue when v_src is null;

    -- ... unless another open receipt has that row as closely
    continue when exists (
      select 1
      from public.receipts other
      cross join lateral public.receipt_match_candidates(other.id, 1, 5, p_user) oc
      where other.user_id = p_user and other.id <> rc.receipt_id
        and (other.tx_source = 'receipt_csv' or other.match_state in ('waiting', 'ambiguous'))
        and oc.external_source = v_src and oc.external_id = v_xid and oc.date_dist <= v_dist
    );

    select * into s from public.bank_transactions
    where user_id = p_user and external_source = v_src and external_id = v_xid;
    continue when not found;

    begin
      -- the statement's fields onto the receipt's row; the user's own edits
      -- on either row are kept (the receipt's first, else the statement's)
      update public.bank_transactions t set
        account = s.account, tx_date = s.tx_date, amount = s.amount, currency = s.currency,
        authorized_on = s.authorized_on,
        authorized_at = coalesce(t.authorized_at, s.authorized_at),
        authorized_approx = case when t.authorized_at is not null then t.authorized_approx else s.authorized_approx end,
        booked_at = s.booked_at, description = s.description,
        counterparty = coalesce(t.counterparty, s.counterparty),
        category = coalesce(s.category, t.category), balance_after = s.balance_after, product = s.product,
        fx_rate = coalesce(s.fx_rate, t.fx_rate), amount_approximate = s.amount_approximate,
        note = coalesce(t.note, s.note),
        expense_note = coalesce(t.expense_note, s.expense_note),
        expense_category = coalesce(t.expense_category, s.expense_category),
        expense_manual = t.expense_manual or s.expense_manual,
        place_id = coalesce(t.place_id, s.place_id),
        delivery_place_id = coalesce(t.delivery_place_id, s.delivery_place_id),
        expense_spread_months = coalesce(t.expense_spread_months, s.expense_spread_months),
        expense_spread_from = coalesce(t.expense_spread_from, s.expense_spread_from),
        income_category = coalesce(t.income_category, s.income_category),
        income_manual = t.income_manual or s.income_manual,
        refund_of = coalesce(t.refund_of, s.refund_of),
        refund_manual = t.refund_manual or s.refund_manual
      where t.user_id = p_user and t.external_source = 'receipt_csv' and t.external_id = rc.receipt_key;

      -- the statement row goes first: its external key is what the receipt's row takes over
      delete from public.bank_transactions where id = s.id;

      update public.bank_transactions set external_source = s.external_source, external_id = s.external_id
      where user_id = p_user and external_source = 'receipt_csv' and external_id = rc.receipt_key;

      update public.receipts set tx_source = s.external_source, tx_external_id = s.external_id, updated_at = now()
      where id = rc.receipt_id;

      v_merged := v_merged + 1;
    exception when others then
      raise warning 'receipt_absorb_statement_rows: receipt % not merged: %', rc.receipt_id, sqlerrm;
    end;
  end loop;

  return v_merged;
end $$;

-- match_receipts (migration ...179) with two changes: it first folds in
-- statement rows that match receipt-made rows, and a waiting or ambiguous
-- receipt with no candidate left makes its own transaction (and so counts
-- as linked this run) instead of staying waiting.
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

  -- a statement row for a payment a receipt already made is folded into that
  -- receipt's row first, so the matching below sees one row, not two
  perform public.receipt_absorb_statement_rows(v_user);

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
      -- nothing to link to: the receipt makes the transaction itself
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
