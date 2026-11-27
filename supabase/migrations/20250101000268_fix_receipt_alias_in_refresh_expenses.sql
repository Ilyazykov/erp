-- Step 2b of refresh_expenses (migration ...266) named receipts "r", as the function's own record
-- variable r is named: "column reference r.id is ambiguous", every capital refresh failed from
-- 27.11.2026 ~01:00 (the receipts loaded after it never reached the expenses). The alias is "rc" now.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := $t$    select r.tx_source, r.tx_external_id, c.external_source, c.external_id, c.account
    from receipts r
    cross join lateral receipt_match_candidates(r.id, 1, 5, p_user) c
    where r.user_id = p_user and r.tx_source = 'receipt_csv' and r.tx_external_id = r.receipt_key$t$;
  b text := $t$    -- receipts as "rc": the function's record r would shadow "r" (migration ...268)
    select rc.tx_source, rc.tx_external_id, c.external_source, c.external_id, c.account
    from receipts rc
    cross join lateral receipt_match_candidates(rc.id, 1, 5, p_user) c
    where rc.user_id = p_user and rc.tx_source = 'receipt_csv' and rc.tx_external_id = rc.receipt_key$t$;
begin
  if position('migration ...268' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: step 2b (migration ...266) not found'; end if;
  execute replace(d, a, b);
end $mig$;
