-- Late August 2025 match_internal_transfers crossed the wires: the IBKR deposit
-- of 28.08 (600) went to Bank of Cyprus's card top-up of Revolut, so Revolut's
-- "To IBKR" 600 was left alone and counted as spending; the IBKR deposits of
-- 26.08 (100) and 29.08 (300) went to a Wise top-up and to Revolut's own
-- savings. The auto pairs go and each leg is paired with its own counterpart.
delete from internal_transfers
where matched_by = 'auto' and (
     (out_source = 'boc_csv' and out_id = '01/09/2025:Card 4***7924 2025-08-28 600.00 EUR Auth 365303 Trace 518490 PURCHASE IE Revolut 4722:Card Purchase - Foreign:-600')
  or (out_source = 'revolut_csv' and out_id in (
        '2025-08-26 21:20:59:To IBKR:-100:EUR',
        '2025-08-29 03:51:40:To IBKR:-300:EUR',
        '2025-08-29 17:30:23:To Instant Access Savings:-300:EUR')));

insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from (values
  ('boc_csv',     '01/09/2025:Card 4***7924 2025-08-28 600.00 EUR Auth 365303 Trace 518490 PURCHASE IE Revolut 4722:Card Purchase - Foreign:-600',
   'revolut_csv', '2025-08-28 07:36:49:Apple Pay top-up by *2749:600:EUR'),
  ('revolut_csv', '2025-08-28 07:39:02:To IBKR:-600:EUR',
   'ibkr_csv',    '2025-08-28T00:00:00:EUR:600:Electronic Fund Transfer'),
  ('revolut_csv', '2025-08-26 21:20:59:To IBKR:-100:EUR',
   'ibkr_csv',    '2025-08-26T00:00:00:EUR:100:Electronic Fund Transfer'),
  ('revolut_csv', '2025-08-29 03:51:40:To IBKR:-300:EUR',
   'ibkr_csv',    '2025-08-29T00:00:00:EUR:300:Electronic Fund Transfer'),
  ('revolut_csv', '2025-08-29 17:30:23:To Instant Access Savings:-300:EUR',
   'revolut_deposit_csv', 'Aug 29, 2025:Deposit to ''Instant Access Savings'':300:EUR')
) v(out_source, out_id, in_source, in_id)
join bank_transactions o on o.external_source = v.out_source and o.external_id = v.out_id
join bank_transactions i on i.user_id = o.user_id and i.external_source = v.in_source and i.external_id = v.in_id
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where account = 'Revolut') u;
