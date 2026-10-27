-- Roubles sent abroad to oneself, 2022-2023: KoronaPay (T-Bank's "Cash
-- withdrawal in KORONAPAY.COM/ONLINE"), QIWI P2P and phone transfers to an
-- exchanger, the lira arriving in Ziraat from HIZLIPARA (a Turkish payment
-- institution) the same day or within two, 2-12% under the day's rate.
-- Different currencies, so match_internal_transfers never pairs them: paired
-- by hand here (matched_by 'manual'), the amount being what arrived. The
-- expenses tab then leaves them out, and capital counts both legs from the
-- day the roubles left.

insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual'
from (values
  -- roubles out: day, amount, description; lira in: day, amount, which of equal ones
  ('2022-11-25'::date, 40560::numeric,   'KORONAPAY',                          '2022-11-25'::date, 12000::numeric, 0),
  ('2022-12-05',       41558.4,          'KORONAPAY',                          '2022-12-06',       12000,          0),
  ('2022-12-21',       86567.4,          'KORONAPAY',                          '2022-12-23',       23000,          0),
  ('2022-12-27',       87975,            'KORONAPAY',                          '2022-12-27',       23000,          0),
  ('2023-01-20',       107967,           'KORONAPAY',                          '2023-01-20',       29000,          0),
  ('2023-02-03',       286110,           'KORONAPAY',                          '2023-02-03',       75000,          0),
  ('2023-02-25',       67958.55,         'KORONAPAY',                          '2023-02-25',       16500,          0),
  ('2023-03-25',       45000,            'QIWI P2P',                           '2023-03-25',       11000,          0),
  ('2023-03-25',       50000,            '^External transfer by phone number', '2023-03-25',       11000,          1),
  ('2023-03-27',       59000,            '^External transfer by phone number', '2023-03-28',       14000,          0)
) v(out_day, rub, pattern, in_day, lira, nth)
join lateral (
  select * from bank_transactions b
  where b.account = 'T-Bank' and b.currency = 'RUB' and b.tx_date::date = v.out_day
    and b.amount = -v.rub and b.description ~ v.pattern
  order by b.tx_date limit 1
) o on true
join lateral (
  select * from bank_transactions b
  where b.user_id = o.user_id and b.account = 'Ziraat Bank' and b.currency = 'TRY'
    and b.tx_date::date = v.in_day and b.amount = v.lira and b.description ~ 'HIZLIPARA'
  order by b.external_id offset v.nth limit 1
) i on true
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where description ~ 'HIZLIPARA') u;
