-- When a row's amount hit the balance, if the statement says so separately
-- from tx_date. Revolut's CSV has both a Started Date (tx_date: when the
-- card was used) and a Completed Date, and its running Balance follows the
-- Completed order: on 2025-12-28 two card payments started at 15:05 / 16:06
-- but completed the next day, after an exchange started at 17:50 -- so the
-- row latest by tx_date (balance 1128 TRY) wasn't the account's balance (0).
-- Null for sources without such a date; date-only statements order their
-- same-day rows through tx_date's clock instead (see
-- supabase/functions/_shared/day_order.ts).

alter table public.bank_transactions add column booked_at timestamptz;

create or replace view public.bank_latest_balances
with (security_invoker = true) as
select distinct on (user_id, account, currency, external_source)
  user_id, account, currency, external_source, product, balance_after, tx_date
from public.bank_transactions
where balance_after is not null
order by user_id, account, currency, external_source, coalesce(booked_at, tx_date) desc, tx_date desc;
