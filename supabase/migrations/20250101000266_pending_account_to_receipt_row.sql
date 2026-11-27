-- The pending hold left out under a receipt-made row (migration ...265) took its account away: the
-- row showed "<unknown>" (25.11.2026, Cyprus Tax Department 89.10 EUR, "PENDING: Portal - Tax
-- Department" on Revolut). Now the receipt's row, its account unknown, takes the hold's account.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := $t$  -- 2b. a pending hold a receipt's own row already stands for (migration ...265)
  delete from expenses e
  using (
    select distinct c.external_source, c.external_id
    from receipts r
    cross join lateral receipt_match_candidates(r.id, 1, 5, p_user) c
    where r.user_id = p_user and r.tx_source = 'receipt_csv' and r.tx_external_id = r.receipt_key
      and (c.external_id like 'pending:%' or c.external_source like '%:pending')
  ) p
  where e.user_id = p_user and e.external_source = p.external_source and e.external_id = p.external_id;$t$;
  b text := $t$  -- 2b. a pending hold a receipt's own row already stands for (migration ...265); the
  --     receipt's row, its account unknown, takes the hold's (migration ...266)
  with p as (
    select r.tx_source, r.tx_external_id, c.external_source, c.external_id, c.account
    from receipts r
    cross join lateral receipt_match_candidates(r.id, 1, 5, p_user) c
    where r.user_id = p_user and r.tx_source = 'receipt_csv' and r.tx_external_id = r.receipt_key
      and (c.external_id like 'pending:%' or c.external_source like '%:pending')
  ), acc as (
    update expenses e set account = p.account
    from p
    where e.user_id = p_user and e.external_source = p.tx_source and e.external_id = p.tx_external_id
      and e.account = '<unknown>' and p.account is not null and p.account <> '<unknown>'
    returning e.id
  )
  delete from expenses e
  using p
  where e.user_id = p_user and e.external_source = p.external_source and e.external_id = p.external_id;$t$;
begin
  if position('migration ...266' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: step 2b (migration ...265) not found'; end if;
  execute replace(d, a, b);
end $mig$;
