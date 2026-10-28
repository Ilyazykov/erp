-- expenses.paid_at: the moment the money left (bank_transactions.tx_date), for
-- the time next to the date in the expenses tab's tables -- `paid_day` is the
-- day only. A row with no time in its statement has 00:00 (or the importer's
-- 00:00:SS for the order within the day); the tab shows no time for those.
alter table public.expenses add column paid_at timestamptz;

-- refresh_expenses (...132) fills it after filling the table. Patched in
-- place: the rest of the function stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  select count(*) into n from expenses where user_id = p_user;';
begin
  if position(a in d) = 0 then
    raise exception 'refresh_expenses: the final count not where expected';
  end if;
  d := replace(d, a, E'  update expenses e set paid_at = b.tx_date\n'
    || E'  from bank_transactions b\n'
    || E'  where e.user_id = p_user and b.user_id = p_user\n'
    || E'    and b.external_source = e.external_source and b.external_id = e.external_id;\n\n'
    || a);
  execute d;
end $$;

select refresh_expenses(u.user_id) from (select distinct user_id from expenses) u;
