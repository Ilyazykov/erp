-- The flat in the capital: a month's price per m2 counts from the day it's
-- published -- the 1st of the next month (gipernn.ru puts October's out on 1
-- November) -- not from the month's own 1st. Taken for the month it describes,
-- every rebuild rewrote that month's days after the fact: October's figure,
-- fetched on 01.11.2026, changed 1-31 October and left November as it was.
-- Now a day takes the latest month that ended before it: October's from 1
-- November to 30 November. refresh_capital_daily is patched in place (as in
-- ...130), only its real estate part; then the whole history is rebuilt.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_capital_daily(uuid, date, date)'::regprocedure);
  a text := 'where i.city = r.city and i.month <= d.day order by i.month desc limit 1';
  b text := 'where i.city = r.city and (i.month + interval ''1 month'')::date <= d.day order by i.month desc limit 1';
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_capital_daily: the real estate index lookup not found'; end if;
  execute replace(d, a, b);
end $mig$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from real_estate) u;
