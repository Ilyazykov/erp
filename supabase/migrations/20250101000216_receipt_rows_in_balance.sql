-- A purchase known from its receipt but not yet in a statement (a receipt-made
-- row, external_source 'receipt_csv') didn't touch the account's balance: TBC
-- showed 229.92 GEL, its last statement's, after ~233 GEL spent on receipts
-- since -- the money was in fact gone (the user topped it up from savings).
-- The user (18.11.2026): let it go into the minus until the statements are in.
--
-- Such a row, once its account is set (not '<unknown>'), now carries a running
-- balance: the sum of that account's / currency's receipt-made rows up to it.
-- refresh_capital_daily and bank_latest_balances take balances per account /
-- currency / source, so 'receipt_csv' adds that (negative) sum to the
-- statement's balance. A statement that brings a payment folds the receipt's
-- row into its own (receipt_absorb_statement_rows: the row takes the
-- statement's source and balance), and the receipt-made rows left are summed
-- again -- so the minus shrinks as the statements come, and is gone with the
-- last of them.
create or replace function public.receipt_rows_rebalance(p_user uuid) returns void
language sql as $$
  with r as (
    select id, sum(-amount) over (partition by account, upper(currency) order by tx_date, id) as spent
    from public.bank_transactions
    where user_id = p_user and external_source = 'receipt_csv' and account <> '<unknown>'
  )
  update public.bank_transactions b
  set balance_after = -r.spent,
      -- the account's own product for the currency (TBC's GEL: current_account), so the
      -- capital puts it where the statement's balance is
      product = coalesce(b.product, (select l.product from public.bank_latest_balances l
                                     where l.user_id = b.user_id and l.account = b.account and upper(l.currency) = upper(b.currency)
                                       and l.external_source <> 'receipt_csv' order by l.tx_date desc limit 1))
  from r where b.id = r.id and b.balance_after is distinct from -r.spent;

  -- back to '<unknown>': no account to take it from
  update public.bank_transactions set balance_after = null
  where user_id = p_user and external_source = 'receipt_csv' and account = '<unknown>' and balance_after is not null;
$$;

-- On any change of a receipt-made row's account / amount / date, or one coming
-- or going (made, folded into a statement row, deleted): the user's rows again.
-- (balance_after and product aren't in the list, so the update above doesn't fire it.)
create or replace function public.receipt_rows_rebalance_trg() returns trigger
language plpgsql as $$
begin
  if (tg_op <> 'INSERT' and old.external_source = 'receipt_csv') or (tg_op <> 'DELETE' and new.external_source = 'receipt_csv') then
    perform public.receipt_rows_rebalance(coalesce(new.user_id, old.user_id));
  end if;
  return null;
end $$;

drop trigger if exists receipt_rows_rebalance on public.bank_transactions;
create trigger receipt_rows_rebalance
  after insert or delete or update of account, amount, tx_date, external_source, currency on public.bank_transactions
  for each row execute function public.receipt_rows_rebalance_trg();

-- the rows there are now
select public.receipt_rows_rebalance(u.user_id)
from (select distinct user_id from public.bank_transactions where external_source = 'receipt_csv') u;
