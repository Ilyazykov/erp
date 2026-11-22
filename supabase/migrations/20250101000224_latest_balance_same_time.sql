-- An account's last balance when its last rows share one time (22.11.2026: T-Bank's debit card,
-- 12.11 00:54 -- 50 000 in from the credit card, balance 50 000, and 50 000 out, balance 0; the
-- statement gives the minute only). The view picked either of them, and the charts showed
-- 50 000 RUB of cash that had left. Of the rows at that time, the last is the one no other row of
-- them follows: no row whose balance before it (balance_after - amount) is this row's balance
-- after. Then the newest row (id) as before.
create or replace view public.bank_latest_balances
with (security_invoker = true) as
select distinct on (b.user_id, b.account, b.currency, b.external_source)
  b.user_id, b.account, b.currency, b.external_source, b.product, b.balance_after, b.tx_date
from public.bank_transactions b
where b.balance_after is not null
order by b.user_id, b.account, b.currency, b.external_source, coalesce(b.booked_at, b.tx_date) desc, b.tx_date desc,
  exists (
    select 1 from public.bank_transactions n
    where n.user_id = b.user_id and n.account = b.account and n.currency = b.currency
      and n.external_source = b.external_source and n.id <> b.id and n.balance_after is not null
      and coalesce(n.booked_at, n.tx_date) = coalesce(b.booked_at, b.tx_date) and n.tx_date = b.tx_date
      and round(n.balance_after - n.amount, 2) = round(b.balance_after, 2)
  ),
  b.id desc;
