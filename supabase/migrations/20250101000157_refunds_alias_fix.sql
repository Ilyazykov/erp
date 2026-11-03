-- refresh_expenses failed every run since ...155: its refunds step called
-- refund_rows "r", and the function has a variable r (record) -- "column
-- reference r.account is ambiguous"; the capital refresh queue stood still.
-- The step's alias becomes rr (the fixed ...155 has it so already).

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  s integer := position('-- 5. refunds (migration ...155)' in d);
  e integer := position('perform refresh_income(p_user);' in d);
  blk text;
begin
  if s = 0 or e < s then raise exception 'refresh_expenses: the refunds step not found'; end if;
  blk := substr(d, s, e - s);
  if position('refund_rows rr' in blk) > 0 then return; end if;
  blk := regexp_replace(blk, '\mr\.', 'rr.', 'g');
  blk := replace(blk, 'refund_rows r' || chr(10), 'refund_rows rr' || chr(10));
  blk := replace(blk, 'refund_rows r where', 'refund_rows rr where');
  execute substr(d, 1, s - 1) || blk || substr(d, e);
end $mig$;

select request_capital_refresh(u.user_id) from (select distinct user_id from public.bank_transactions) u;
