-- A statement row a receipt's row took over (receipt_absorb_statement_rows) kept the receipt-made
-- rows' running minus as its balance, not the statement's: the first update, the row still
-- 'receipt_csv', fires receipt_rows_rebalance (migration ...216), which sums the receipt-made rows
-- again -- this one with them -- over the statement's balance just set. TBC's GEL account on
-- 22-25.11.2026 read -139.73 ... -80.18 GEL against the statement's 235.73 ... 353.55 (27.11.2026).
-- Now the statement's balance is set once more after the row has left 'receipt_csv'; and the rows
-- taken over so far get theirs back: the balance before them plus their amount, in the order of
-- their source's rows of their currency and product (only the taken-over rows changed: the rest
-- are the statement's own).

do $mig$
declare
  d text := pg_get_functiondef('public.receipt_absorb_statement_rows(uuid)'::regprocedure);
  a text := $t$      update public.bank_transactions set external_source = s.external_source, external_id = s.external_id
      where user_id = p_user and external_source = 'receipt_csv' and external_id = rc.receipt_key;$t$;
  b text := $t$      -- (the statement's balance again: the update above, the row still a receipt's, had the
      -- receipt-made rows' minus written over it -- migration ...271)
      update public.bank_transactions set external_source = s.external_source, external_id = s.external_id,
        balance_after = s.balance_after
      where user_id = p_user and external_source = 'receipt_csv' and external_id = rc.receipt_key;$t$;
begin
  if position('migration ...271' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'receipt_absorb_statement_rows: the key handover not found'; end if;
  execute replace(d, a, b);
end $mig$;

do $fix$
declare
  src record;
  r record;
  prev numeric;
begin
  for src in
    select distinct b.user_id, b.external_source, upper(b.currency) as currency, coalesce(b.product, '') as product
    from public.bank_transactions b
    join public.receipts rc on rc.user_id = b.user_id and rc.source = 'receipt_csv'
      and rc.tx_source = b.external_source and rc.tx_external_id = b.external_id
    where b.external_source <> 'receipt_csv' and b.external_source not like '%:pending' and b.balance_after is not null
  loop
    prev := null;
    for r in
      select b.id, b.amount, b.balance_after,
             exists (select 1 from public.receipts rc where rc.user_id = b.user_id and rc.source = 'receipt_csv'
                       and rc.tx_source = b.external_source and rc.tx_external_id = b.external_id) as taken
      from public.bank_transactions b
      where b.user_id = src.user_id and b.external_source = src.external_source
        and upper(b.currency) = src.currency and coalesce(b.product, '') = src.product and b.balance_after is not null
      order by b.tx_date, b.id
    loop
      if r.taken and prev is not null and r.balance_after is distinct from round(prev + r.amount, 2) then
        update public.bank_transactions set balance_after = round(prev + r.amount, 2) where id = r.id;
        prev := round(prev + r.amount, 2);
      else
        prev := r.balance_after;
      end if;
    end loop;
  end loop;
end $fix$;
