-- Euros sent from Revolut to a person in exchange for roubles in a Russian
-- account the same day (a P2P exchange), and 10 EUR lent and given back (12)
-- the same evening. Different currencies, so match_internal_transfers never
-- pairs them; by hand, as in ...127.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by, kind)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual', v.kind
from (values
  -- euros out: day, amount; in: account, currency, day, amount, description
  ('2026-07-01'::date, 300::numeric, 'T-Bank', 'RUB', '2026-07-01'::date, 26607::numeric, '^Intrabank transfer from contract', 'transfer'),
  ('2026-07-20', 223, 'Alfa', 'RUB', '2026-07-20', 20000, 'быстрых платежей', 'transfer'),
  ('2026-07-10', 10, 'Revolut', 'EUR', '2026-07-10', 12, '^Transfer from ', 'returned')
) v(out_day, out_amt, in_account, in_ccy, in_day, in_amt, in_re, kind)
join bank_transactions o on o.account = 'Revolut' and o.currency = 'EUR' and o.tx_date::date = v.out_day
  and o.amount = -v.out_amt and o.description ~ '^Transfer to '
join bank_transactions i on i.user_id = o.user_id and i.account = v.in_account and i.currency = v.in_ccy
  and i.tx_date::date = v.in_day and i.amount = v.in_amt and i.description ~ v.in_re
where not exists (select 1 from internal_transfers x where x.in_source = i.external_source and x.in_id = i.external_id)
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where account = 'Revolut') u;
