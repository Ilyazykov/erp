-- A third kind of synthetic bank_transactions row (see
-- 20250101000011_bank_transactions_synthetic_kind.sql):
--
--   synthetic_kind = 'balance_snapshot' -- a counted balance, not a
--                                          transaction: balance_after is what
--                                          was there on tx_date, amount the
--                                          change since the previous count;
--                                          the movements in between aren't
--                                          known
--
-- First use: cash on hand (account 'Cash'), from the monthly counts in the
-- user's tracking spreadsheet -- there's no statement for banknotes.

alter table public.bank_transactions drop constraint bank_transactions_synthetic_kind_check;
alter table public.bank_transactions
  add constraint bank_transactions_synthetic_kind_check
    check (synthetic_kind in ('data_gap', 'account_closed', 'balance_snapshot'));
