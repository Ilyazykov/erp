-- Capital by bank / broker per day, for the "Capital by broker" tab's
-- stacked chart: one row a day with every account's total in a JSON object
-- ({"T-Bank": 1234.5, ...}) -- a few thousand rows to load rather than one
-- per account and day. An account's credit-card debt is already in its
-- total (netted within the bank); real estate is kept apart.

create view public.capital_daily_by_account
with (security_invoker = true) as
select user_id, day,
       jsonb_object_agg(account, v) filter (where account <> 'real estate') as accounts,
       coalesce(sum(v) filter (where account = 'real estate'), 0) as real_estate
from (
  select user_id, day, account, round(sum(value_usd), 2) as v
  from public.capital_daily
  group by user_id, day, account
) a
group by user_id, day;
