-- The funds' timezone copies again (as ...093). The savings statement
-- uploaded 27.10.2026 (29.08.2025 - 27.10.2026) gives each row's Date with the
-- daylight saving of its own day: against the export of 22.09.2026 it was at
-- no offset on the winter-time days and an hour later on the summer-time ones
-- (to 26.10.2025, from 29.03.2026). import-revolut-fund-statement took one
-- offset for the whole file, no offset won, and the summer rows of 22.09
-- (104 buys/sells, 1206 daily Return PAID / Service Fee rows) went in a second
-- time: about EUR 4 209, GBP 1 840 and USD 2 678 too much in IE000AZVL3K0,
-- IE0002RUHW32 and IE000H9J0QX4, some $9.8k on the capital. The importer now
-- picks the offset per row. Same pairing and clean-up as ...093: the copy
-- from the older upload goes.
--
-- The same upload brought two more kinds of copies:
-- * Metals (account statement, import-revolut-statement, the same one-offset
--   vote): the gold buys of 13.10.2025 and 30.07.2026 an hour off the upload
--   of 26.09, in bank_transactions (revolut_csv) and in trades
--   (revolut_metal_csv): 0.411719 oz of XAU against the statement's 0.273294.
-- * Instant Access Savings (revolut_deposit_csv): its Date has no time, and
--   the export of 22.09 put six withdrawals a day before this one did (its
--   clock west of the day's turn), each with a new external_id: EUR 69.88 and
--   USD 561.87 taken out twice, the accounts below zero since. Both closed at
--   0.00 (01.11.2025, 02.02.2026). import-revolut-deposit-statement now drops
--   the stored rows of the file's span that the file no longer has.
-- internal_transfers pointing at a removed row are dropped by
-- match_internal_transfers on the refresh below, which pairs the kept ones.

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

-- Metals: same currency, amount, running balance and description, Dates a
-- whole number of hours apart; the older upload's row goes.
delete from bank_transactions o
using bank_transactions n
where n.user_id = o.user_id and n.id <> o.id
  and o.external_source = 'revolut_csv' and n.external_source = 'revolut_csv'
  and n.created_at > o.created_at
  and n.currency = o.currency and n.amount = o.amount and n.description = o.description
  and o.balance_after is not null and n.balance_after = o.balance_after
  and n.tx_date <> o.tx_date
  and abs(extract(epoch from n.tx_date - o.tx_date)) <= 14 * 3600
  and extract(epoch from n.tx_date - o.tx_date)::bigint % 3600 = 0;

-- external_id "2025-10-13 20:18:11:XAU:<gross>:<fee>": the rest after the Date.
delete from trades o
using trades n
where n.user_id = o.user_id and n.id <> o.id
  and o.external_source = 'revolut_metal_csv' and n.external_source = 'revolut_metal_csv'
  and n.created_at > o.created_at
  and n.ticker = o.ticker and n.side = o.side and n.quantity = o.quantity
  and substr(n.external_id, 20) = substr(o.external_id, 20)
  and left(n.external_id, 19) <> left(o.external_id, 19)
  and abs(extract(epoch from left(n.external_id, 19)::timestamp - left(o.external_id, 19)::timestamp)) <= 14 * 3600
  and extract(epoch from left(n.external_id, 19)::timestamp - left(o.external_id, 19)::timestamp)::bigint % 3600 = 0;

-- Savings: a row of an older upload with the same ticker, side, amount and
-- description a day off a row of a newer one, the newer upload having
-- nothing like it on the older row's own day.
delete from trades tr
using (
  select o.id as old_id,
         row_number() over (partition by o.id order by n.id) as ro,
         row_number() over (partition by n.id order by o.trade_date, o.id) as rn
  from trades o
  join trades n on n.user_id = o.user_id and n.id <> o.id
   and o.external_source = 'revolut_deposit_csv' and n.external_source = 'revolut_deposit_csv'
   and n.created_at > o.created_at
   and n.ticker = o.ticker and n.side = o.side and n.quantity = o.quantity and n.note = o.note
   and abs(n.trade_date - o.trade_date) = 1
  where not exists (
    select 1 from trades x
    where x.user_id = o.user_id and x.external_source = o.external_source and x.created_at = n.created_at
      and x.ticker = o.ticker and x.side = o.side and x.quantity = o.quantity
      and x.external_id like to_char(o.trade_date, 'Mon FMDD, YYYY') || ':%')
) t
where tr.id = t.old_id and t.ro = 1 and t.rn = 1;

-- Capital (and with it investment_daily) rebuilt by the queue.
select request_capital_refresh(u.user_id)
from (select distinct user_id from trades where external_source like 'revolut%') u;

drop table revolut_fund_tz_twins;
