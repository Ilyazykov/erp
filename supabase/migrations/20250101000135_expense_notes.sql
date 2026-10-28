-- A note of one's own on a row out (bank_transactions.expense_note), written on
-- the expenses tab -- apart from `note`, which the importers fill. Shown there
-- through expenses.note, copied by refresh_expenses.
alter table public.bank_transactions add column expense_note text;
alter table public.expenses add column note text;

-- refresh_expenses (...132, ...133) copies it after filling the table. Patched
-- in place: the rest of the function stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  select count(*) into n from expenses where user_id = p_user;';
begin
  if position(a in d) = 0 then
    raise exception 'refresh_expenses: the final count not where expected';
  end if;
  d := replace(d, a, E'  update expenses e set note = b.expense_note\n'
    || E'  from bank_transactions b\n'
    || E'  where e.user_id = p_user and b.user_id = p_user and b.expense_note is not null\n'
    || E'    and b.external_source = e.external_source and b.external_id = e.external_id;\n\n'
    || a);
  execute d;
end $$;

select refresh_expenses(u.user_id) from (select distinct user_id from expenses) u;
