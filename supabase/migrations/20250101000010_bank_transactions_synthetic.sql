-- Marks rows that aren't real bank transactions but bookkeeping rows added
-- by hand where the statements run out -- e.g. UniCredit: statements stop
-- at 12.2023, the account was closed on 19.03.2025 with balance 0, and
-- nothing in between is known. Two such rows are imported:
--   * one on the last known transaction's date, zeroing the balance --
--     "no data from here until closing"
--   * one on the closing date with amount 0 -- "account closed, balance 0"
-- Both keep the running balance (balance_after) consistent for the
-- cash-balance view, but anything that sums real money movement
-- (spending, cash flows) should filter `where not synthetic`.
-- `note` (already on the table) carries the human-readable explanation.

alter table public.bank_transactions
  add column synthetic boolean not null default false;
