-- The latest balance row per (account, currency, external_source) -- what
-- the broker pivot tables count as each account's cash. index.html used to
-- read every bank_transactions row newest-first and keep the first per key
-- itself, but the API caps a response at 1000 rows: with several thousand
-- rows, accounts without recent activity fell off the end (cash on hand
-- showed 0 -- only its newest row, 2026-07-03, made it in). Picking the row
-- here returns one row per account and currency instead.

create view public.bank_latest_balances
with (security_invoker = true) as
select distinct on (user_id, account, currency, external_source)
  user_id, account, currency, external_source, product, balance_after, tx_date
from public.bank_transactions
where balance_after is not null
order by user_id, account, currency, external_source, tx_date desc;
