-- Which (account, currency) and (account, instrument type) pairs ever held a
-- value, from the capital history: the broker x currency / asset-class tables
-- draw a zero cell in the normal colour where the account once held something
-- there (Ziraat's EUR, spent down to 0) and greyed only where it never did.
create or replace view public.capital_ever_held
with (security_invoker = true) as
select distinct user_id, account, currency, instrument_type
from public.capital_daily
where abs(value_usd) >= 0.01;
