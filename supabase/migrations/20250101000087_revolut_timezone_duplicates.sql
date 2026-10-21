-- Revolut's account-statement CSV gives Started / Completed Date in the
-- timezone of the device it was exported on, with no marker. The export of
-- 22.09.2026 was made on Cyprus time (EET/EEST), those of 06.10 and 17.10 an
-- hour west (CET/CEST): every row of the overlap came back an hour earlier,
-- so with a new external_id ("<Started Date>:<description>:<amount>:<ccy>"),
-- and the upsert added it instead of matching it -- 1 912 rows, the whole
-- history from 19.08.2025 to 22.09.2026, were in twice (6 of them under a
-- merchant name Revolut has since changed: "Tst Paro" -> "Paro Indian").
--
-- A row and its copy: same amount, currency and running balance, both dates
-- moved by the same whole number of hours (up to 14). The copy from the
-- older upload goes; the newer export is the one kept (it covers the older
-- one completely, with today's merchant names). internal_transfers rows
-- that point at a deleted copy are moved over to the row kept -- the
-- manual and rejected pairs too, which match_internal_transfers never
-- rebuilds -- or dropped when the row kept is already in a pair of its own.
-- import-revolut-statement now finds such a copy itself before upserting.

create temporary table revolut_tz_twins as
with rows as (
  select b.id, b.user_id, b.external_id, b.amount, b.currency, b.balance_after, b.tx_date, b.created_at,
         date_trunc('second', b.booked_at) as booked
  from bank_transactions b
  where b.external_source = 'revolut_csv' and not b.synthetic and b.balance_after is not null
),
cand as (
  select o.id as old_id, o.user_id, o.external_id as old_ext, n.id as new_id, n.external_id as new_ext,
         n.tx_date - o.tx_date as shift,
         row_number() over (partition by o.id order by abs(extract(epoch from n.tx_date - o.tx_date)), n.id) as ro,
         row_number() over (partition by n.id order by abs(extract(epoch from n.tx_date - o.tx_date)), o.id) as rn
  from rows o
  join rows n on n.user_id = o.user_id and n.id <> o.id
   and n.created_at > o.created_at
   and n.amount = o.amount and n.currency = o.currency and n.balance_after = o.balance_after
   and n.tx_date <> o.tx_date
   and abs(extract(epoch from n.tx_date - o.tx_date)) <= 14 * 3600
   and extract(epoch from n.tx_date - o.tx_date)::bigint % 3600 = 0
   and n.booked is not distinct from o.booked + (n.tx_date - o.tx_date)
)
select old_id, user_id, old_ext, new_id, new_ext, shift from cand where ro = 1 and rn = 1;

-- Pairs whose row kept is already in a pair in the same role: the copy's goes.
delete from internal_transfers it
using revolut_tz_twins t
where it.user_id = t.user_id and it.out_source = 'revolut_csv' and it.out_id = t.old_ext
  and exists (select 1 from internal_transfers x
              where x.user_id = t.user_id and x.out_source = 'revolut_csv' and x.out_id = t.new_ext);
delete from internal_transfers it
using revolut_tz_twins t
where it.user_id = t.user_id and it.in_source = 'revolut_csv' and it.in_id = t.old_ext
  and exists (select 1 from internal_transfers x
              where x.user_id = t.user_id and x.in_source = 'revolut_csv' and x.in_id = t.new_ext);

update internal_transfers it
set out_id = t.new_ext, out_at = it.out_at + t.shift
from revolut_tz_twins t
where it.user_id = t.user_id and it.out_source = 'revolut_csv' and it.out_id = t.old_ext;
update internal_transfers it
set in_id = t.new_ext, in_at = it.in_at + t.shift
from revolut_tz_twins t
where it.user_id = t.user_id and it.in_source = 'revolut_csv' and it.in_id = t.old_ext;

delete from bank_transactions b
using revolut_tz_twins t
where b.id = t.old_id;

-- Pairs and capital rebuilt by the queue (match_internal_transfers first).
select request_capital_refresh(u.user_id) from (select distinct user_id from revolut_tz_twins) u;

drop table revolut_tz_twins;
