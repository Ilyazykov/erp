-- expenses.extrapolated: the row stands for spending worked out rather than
-- recorded (bank_transactions.synthetic_kind 'extrapolated': the cash spent
-- that left no trace, card payments of months with no statement) -- the
-- expenses tab can leave them out. What was recalled with an approximate price
-- ("Spent in cash: ...", cash_csv:estimated) is a real purchase and stays.
alter table public.expenses add column extrapolated boolean not null default false;

-- refresh_expenses (...132) marks them after filling the table. Patched in
-- place: the rest of the function stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  select count(*) into n from expenses where user_id = p_user;';
begin
  if position(a in d) = 0 then
    raise exception 'refresh_expenses: the final count not where expected';
  end if;
  d := replace(d, a, E'  update expenses e set extrapolated = true\n'
    || E'  from bank_transactions b\n'
    || E'  where e.user_id = p_user and b.user_id = p_user and b.synthetic_kind = ''extrapolated''\n'
    || E'    and b.external_source = e.external_source and b.external_id = e.external_id;\n\n'
    || a);
  execute d;
end $$;

select refresh_expenses(u.user_id) from (select distinct user_id from expenses) u;
