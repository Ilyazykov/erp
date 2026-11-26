-- A line's product or category saved while the refresh rebuilt the expenses failed on the statement
-- timeout (26.11.2026, Resolve on the Cyprus tax receipt): refresh_expenses deletes and inserts all
-- the user's expense rows and holds them till its step ends, 1-2 minutes; the one purchase's split
-- (migration ...260) waited to update its row. Now it waits a third of a second at most: the rows
-- held, it gives up and asks for the refresh -- which splits the purchase from the lines as they are.

create or replace function public.receipt_items_category_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t record;
  ok boolean;
  v_lock text := current_setting('lock_timeout');
begin
  for t in
    select distinct ra.user_id, ra.tx_source, ra.tx_external_id
    from new_rows n join old_rows o on o.id = n.id
    join receipts_active ra on ra.id = n.receipt_id
    where (n.category is distinct from o.category or n.product_id is distinct from o.product_id)
      and ra.tx_source is not null
  loop
    begin
      perform set_config('lock_timeout', '300ms', true);
      ok := expenses_resplit_purchase(t.user_id, t.tx_source, t.tx_external_id);
    exception when lock_not_available then
      ok := false;   -- the refresh holds the rows: it does this purchase too
    end;
    perform set_config('lock_timeout', v_lock, true);
    if not ok then perform request_capital_refresh(t.user_id); end if;
  end loop;
  return null;
end $$;
