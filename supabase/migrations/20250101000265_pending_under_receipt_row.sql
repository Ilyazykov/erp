-- A receipt loaded before its bank's row makes a row of its own (migration ...191); a pending
-- hold the sync writes after it isn't folded into that row (receipt_absorb_statement_rows waits
-- for the settled one), and the payment counted twice till the bank booked it (25.11.2026,
-- Cyprus Tax Department 89.10 EUR: the receipt's row and "PENDING: Portal - Tax Department").
-- Now refresh_expenses leaves out a pending row that is a candidate of a receipt-made row; the
-- settled row is folded in as before.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  -- 3. what a pair from one currency into another lost on the way';
  b text := $t$  -- 2b. a pending hold a receipt's own row already stands for (migration ...265)
  delete from expenses e
  using (
    select distinct c.external_source, c.external_id
    from receipts r
    cross join lateral receipt_match_candidates(r.id, 1, 5, p_user) c
    where r.user_id = p_user and r.tx_source = 'receipt_csv' and r.tx_external_id = r.receipt_key
      and (c.external_id like 'pending:%' or c.external_source like '%:pending')
  ) p
  where e.user_id = p_user and e.external_source = p.external_source and e.external_id = p.external_id;

  -- 3. what a pair from one currency into another lost on the way$t$;
begin
  if position('migration ...265' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: step 3 not found'; end if;
  execute replace(d, a, b);
end $mig$;
