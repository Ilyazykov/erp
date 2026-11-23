-- A returned payment's two rows stay on their own days in the capital history (23.11.2026). The history
-- counts both rows of an internal transfer from the day the first one moved: right for money going between
-- one's own accounts, wrong for a 'returned' pair, whose rows are separate events days apart. A purchase of
-- 4 699 AED on 29.11.2025, paired with the 1 111 EUR that came for it on 25.11, took the AED balance below zero
-- and the capital about 1 280 USD down for four days. The pair still keeps both rows out of the expenses.
do $mig$
declare
  d text := pg_get_functiondef('public.refresh_capital_daily(uuid, date, date)'::regprocedure);
  a text := $t$from internal_transfers where user_id = p_user and matched_by in ('auto', 'manual')$t$;
  b text := $t$from internal_transfers where user_id = p_user and matched_by in ('auto', 'manual') and kind is distinct from 'returned'$t$;
begin
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 2 then
    raise exception 'refresh_capital_daily: pair_legs not as expected';
  end if;
  execute replace(d, a, b);
end $mig$;

-- recount from the first day such a pair moved
do $mig$
declare r record;
begin
  for r in
    select user_id, min(least(out_at, in_at))::date as first_day
    from public.internal_transfers
    where kind = 'returned' and matched_by in ('auto', 'manual') and out_at::date <> in_at::date
    group by user_id
  loop
    perform public.capital_mark_dirty(r.user_id, r.first_day);
    update public.capital_refresh_queue set requested_at = now() where user_id = r.user_id;
  end loop;
end $mig$;
