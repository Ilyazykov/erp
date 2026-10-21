-- Revolut's savings (Flexible Cash Funds) statement has the same clock
-- problem as its account statement (...087): Date is in the timezone of the
-- device it was exported on. The export of 22.09.2026 was made on Cyprus
-- time, those of 06.10 and 17.10 an hour west, so every fund row of the
-- overlap (31.08 - 22.09.2026: buys, sells, the daily Return PAID / Service
-- Fee rows of IE000AZVL3K0, IE0002RUHW32, IE000H9J0QX4) came back an hour
-- earlier -- "Sep 9, 2026, 3:43:32 AM" and "2:43:32 AM" -- with a new
-- external_id ("<Date>:<description>:<quantity>"), and was added a second
-- time: the funds' holdings and interest twice over for those weeks, and
-- twice in the Snowball export.
--
-- A row and its copy: same ticker, side, quantity, price and currency, the
-- same external_id after its Date, the Dates a whole number of hours apart
-- (up to 14), uploaded at different times. The copy from the older upload
-- goes, as in ...087. internal_transfers rows pointing at it are moved over
-- to the row kept, or dropped when that one is already in a pair.
-- import-revolut-fund-statement now finds such a copy itself before
-- upserting.

create temporary table revolut_fund_tz_twins as
with rows as (
  select t.id, t.user_id, t.external_id, t.ticker, t.side, t.quantity, t.price, t.currency, t.created_at,
         m[8] as rest,
         make_timestamp(m[3]::int, extract(month from to_date(m[1], 'Mon'))::int, m[2]::int,
                        m[4]::int % 12 + case when m[7] = 'PM' then 12 else 0 end, m[5]::int, m[6]::double precision) as ts
  from trades t
  cross join lateral regexp_match(t.external_id,
    '^([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\D*?(AM|PM):(.*)$') m
  where t.external_source = 'revolut_fund_csv' and m is not null
),
cand as (
  select o.id as old_id, o.user_id, o.external_id as old_ext, n.id as new_id, n.external_id as new_ext,
         row_number() over (partition by o.id order by abs(extract(epoch from n.ts - o.ts)), n.id) as ro,
         row_number() over (partition by n.id order by abs(extract(epoch from n.ts - o.ts)), o.id) as rn
  from rows o
  join rows n on n.user_id = o.user_id and n.id <> o.id
   and n.created_at > o.created_at
   and n.ticker = o.ticker and n.side = o.side and n.rest = o.rest
   and n.quantity = o.quantity and n.price = o.price and n.currency is not distinct from o.currency
   and n.ts <> o.ts
   and abs(extract(epoch from n.ts - o.ts)) <= 14 * 3600
   and extract(epoch from n.ts - o.ts)::bigint % 3600 = 0
)
select old_id, user_id, old_ext, new_id, new_ext from cand where ro = 1 and rn = 1;

delete from internal_transfers it
using revolut_fund_tz_twins t
where it.user_id = t.user_id and it.out_source = 'revolut_fund_csv' and it.out_id = t.old_ext
  and exists (select 1 from internal_transfers x
              where x.user_id = t.user_id and x.out_source = 'revolut_fund_csv' and x.out_id = t.new_ext);
delete from internal_transfers it
using revolut_fund_tz_twins t
where it.user_id = t.user_id and it.in_source = 'revolut_fund_csv' and it.in_id = t.old_ext
  and exists (select 1 from internal_transfers x
              where x.user_id = t.user_id and x.in_source = 'revolut_fund_csv' and x.in_id = t.new_ext);

update internal_transfers it
set out_id = t.new_ext
from revolut_fund_tz_twins t
where it.user_id = t.user_id and it.out_source = 'revolut_fund_csv' and it.out_id = t.old_ext;
update internal_transfers it
set in_id = t.new_ext
from revolut_fund_tz_twins t
where it.user_id = t.user_id and it.in_source = 'revolut_fund_csv' and it.in_id = t.old_ext;

delete from trades tr
using revolut_fund_tz_twins t
where tr.id = t.old_id;

-- Capital (and with it investment_daily) rebuilt by the queue.
select request_capital_refresh(u.user_id) from (select distinct user_id from revolut_fund_tz_twins) u;

drop table revolut_fund_tz_twins;
