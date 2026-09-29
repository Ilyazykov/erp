-- A fourth kind of synthetic bank_transactions row (see
-- 20250101000011_bank_transactions_synthetic_kind.sql and ...023):
--
--   synthetic_kind = 'extrapolated' -- not a known transaction at all:
--                                      spending that certainly happened but
--                                      left no trace (e.g. food paid in cash
--                                      while travelling), filled in from a
--                                      per-day norm for the period minus
--                                      what is recorded; `note` has the
--                                      period and the norm
--
-- It moves the balance like any other row (capital history reads
-- balance_after), but, being synthetic, stays out of the internal-transfer
-- matching and of spending analytics (`where not synthetic`).

alter table public.bank_transactions drop constraint bank_transactions_synthetic_kind_check;
alter table public.bank_transactions
  add constraint bank_transactions_synthetic_kind_check
    check (synthetic_kind in ('data_gap', 'account_closed', 'balance_snapshot', 'extrapolated'));
