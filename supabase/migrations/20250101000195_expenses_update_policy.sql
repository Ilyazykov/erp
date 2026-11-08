-- The expenses tab writes an account change (a receipt's row, see mpEditAccount)
-- to the expenses table too. The table had only a select policy, so that update
-- matched no rows and passed silently: the transaction changed, the tab didn't.
-- A row of one's own may be updated now. The rebuild (refresh_expenses) still
-- rewrites the whole table from bank_transactions, so this only keeps the copy
-- in step between rebuilds.

create policy "own expenses update" on public.expenses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
