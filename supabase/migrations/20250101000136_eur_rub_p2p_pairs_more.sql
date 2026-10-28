-- More euros sold to people for roubles (P2P), as in ...134: a transfer out of
-- Bank of Cyprus, Revolut or Wise, the roubles in Ozon Bank, T-Bank or Alfa the
-- same day or the next (one BoC transfer is booked a day after the roubles
-- came), 83-98 RUB/EUR. One to one by day and amount; whichever of two equal
-- candidates is paired, the pair is the same.

-- The BoC transfer of 29.12.2025 (200) was paired by match_internal_transfers
-- with Revolut's "From Flexible Cash Funds" +200 of 31.12 -- the money of one's
-- own fund, not this transfer; the auto pair goes.
delete from internal_transfers it
using bank_transactions o
where it.matched_by = 'auto' and o.external_source = it.out_source and o.external_id = it.out_id
  and o.account = 'Bank of Cyprus' and o.tx_date::date = '2025-12-29' and o.amount = -200
  and it.in_id ~ 'From Flexible Cash Funds';

insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from (values
  -- out: account, day, euros; in: account, day, roubles
  ('Bank of Cyprus', '2025-08-11'::date, 753::numeric,  'T-Bank',    '2025-08-11'::date, 70000::numeric),
  ('Wise',           '2025-08-29',       45.98,         'T-Bank',    '2025-08-29',       4320),
  ('Wise',           '2025-09-05',       533.64,        'T-Bank',    '2025-09-05',       50000),
  ('Revolut',        '2025-11-17',       290,           'Ozon Bank', '2025-11-17',       28300),
  ('Wise',           '2025-12-24',       64.08,         'Ozon Bank', '2025-12-24',       6054),
  ('Bank of Cyprus', '2025-12-29',       200,           'Ozon Bank', '2025-12-29',       18477),
  ('Bank of Cyprus', '2025-12-30',       201,           'Ozon Bank', '2025-12-30',       18536),
  ('Bank of Cyprus', '2025-12-31',       250,           'Ozon Bank', '2025-12-31',       23208),
  ('Revolut',        '2026-01-03',       320,           'Ozon Bank', '2026-01-03',       30000),
  ('Bank of Cyprus', '2026-01-12',       250,           'Ozon Bank', '2026-01-11',       23065),
  ('Revolut',        '2026-01-12',       258,           'Ozon Bank', '2026-01-11',       23800),
  ('Revolut',        '2026-05-25',       240.5,         'Ozon Bank', '2026-05-25',       20000),
  ('Revolut',        '2026-06-22',       117.87,        'Alfa',      '2026-06-22',       10000),
  ('Wise',           '2026-06-25',       48.22,         'Alfa',      '2026-06-25',       4200)
) v(out_account, out_day, euros, in_account, in_day, roubles)
join lateral (
  select * from bank_transactions b
  where b.account = v.out_account and b.currency = 'EUR' and b.tx_date::date = v.out_day and b.amount = -v.euros
    and b.description ~ '^(Transfer|Transfer to |Sent money to )'
    and not exists (select 1 from internal_transfers x where x.out_source = b.external_source and x.out_id = b.external_id)
  order by b.external_id limit 1
) o on true
join lateral (
  select * from bank_transactions b
  where b.user_id = o.user_id and b.account = v.in_account and b.currency = 'RUB'
    and b.tx_date::date = v.in_day and b.amount = v.roubles
    and not exists (select 1 from internal_transfers x where x.in_source = b.external_source and x.in_id = b.external_id)
  order by b.external_id limit 1
) i on true
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where account = 'Revolut') u;
