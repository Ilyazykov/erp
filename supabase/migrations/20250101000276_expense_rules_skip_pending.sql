-- The expense rules look past Open Banking's "PENDING: " (28.11.2026): a row the bank hasn't
-- booked yet comes as "PENDING: <its description>" (sync-openbanking), so a rule anchored at
-- the start missed it -- Revolut's gold purchase of 27.11.2026 ("PENDING: Exchanged to XAU",
-- 300.80 EUR) failed '^Exchanged ' (Currency exchange), fell to Other and was counted as
-- spending (the daily spending budget $329 short) until the bank booked it. The same with
-- '^(BUY|SELL) - ' (a share bought) and the rest of the anchored rules. Now the rules see the
-- description without it; the row itself keeps it.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := $t$  select b.id, b.external_source, b.external_id, b.account, b.description, b.category,$t$;
  b text := $t$  select b.id, b.external_source, b.external_id, b.account,
         regexp_replace(b.description, '^PENDING: ', '') as description,  -- migration ...276
         b.category,$t$;
begin
  if position('migration ...276' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: the rows'' select not found'; end if;
  execute replace(d, a, b);
end $mig$;

select public.refresh_expenses(u.user_id)
from (select distinct user_id from public.expense_rules) u;
