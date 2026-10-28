-- An iPhone bought in Dubai for someone else (Revolut, 29.11.2025, 4699 AED):
-- the money for it came to Revolut beforehand (25.11, 1111 EUR = its price in
-- dollars). Paired as 'returned', as in ...130, so neither is spending nor income.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by, kind)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual', 'returned'
from bank_transactions o
join bank_transactions i on i.user_id = o.user_id and i.account = 'Revolut' and i.currency = 'EUR'
  and i.tx_date::date = '2025-11-25' and i.amount = 1111 and i.description ~ '^Transfer from '
where o.account = 'Revolut' and o.currency = 'AED' and o.tx_date::date = '2025-11-29' and o.amount = -4699
  and not exists (select 1 from internal_transfers x where x.in_source = i.external_source and x.in_id = i.external_id)
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where account = 'Revolut') u;
