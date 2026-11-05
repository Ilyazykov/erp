-- Rows entered by hand ahead of a statement (external_id 'manual:...', in the
-- statement's own source so its import replaces them -- IBKR's trades of
-- 05.11.2026 from the app's Orders & Trades) are estimates too: the money
-- ones land in estimate_archive when the statement takes them back, as the
-- trades already do (trades.estimated), to check them against what came.

drop trigger if exists bank_archive_estimate on public.bank_transactions;
create trigger bank_archive_estimate after delete on public.bank_transactions
  for each row when (old.external_source like 'estimate_broker:%' or old.external_source = 'openbanking_revolut_invest'
                     or old.external_id like 'manual:%')
  execute function public.archive_estimate();
drop trigger if exists bank_unarchive_estimate on public.bank_transactions;
create trigger bank_unarchive_estimate after insert on public.bank_transactions
  for each row when (new.external_source like 'estimate_broker:%' or new.external_source = 'openbanking_revolut_invest'
                     or new.external_id like 'manual:%')
  execute function public.unarchive_estimate();
