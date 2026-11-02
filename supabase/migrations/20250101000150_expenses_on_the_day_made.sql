-- An expense is on the day it was made, not the day the bank booked it: TBC
-- books a card payment 1-3 days later (ASIATASI, made on 1 November, booked on
-- the 2nd), Bank of Cyprus 1-4 days later. Both rows carry the day it was made
-- in authorized_on (import-bank-csv for TBC, sync-openbanking for BoC); the
-- capital counted from it already, the expenses tab now too. refresh_expenses
-- is patched in place (as in ...130), its day and a spread's first month.
-- The TBC rows in so far get their authorized_on from the description here.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
begin
  if position('coalesce(b.authorized_on, b.tx_date::date) as d,' in d) > 0 then return; end if;
  if position('b.tx_date::date as d,' in d) = 0 or position('b.tx_date::date) as first_day' in d) = 0 then
    raise exception 'refresh_expenses: the expense day not found';
  end if;
  d := replace(d, 'b.tx_date::date as d,', 'coalesce(b.authorized_on, b.tx_date::date) as d,');
  d := replace(d, 'b.tx_date::date) as first_day', 'coalesce(b.authorized_on, b.tx_date::date)) as first_day');
  execute d;
end $mig$;

update public.bank_transactions b
set authorized_on = m.made
from (
  select id, to_date(r[3] || ' ' || r[1] || ' ' || r[2], 'YYYY Mon DD') as made
  from (
    select id, regexp_match(description, ', (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{4}) \d{1,2}:\d{2}[AP]M,') as r
    from public.bank_transactions
    where account = 'TBC Bank' and authorized_on is null
  ) x where r is not null
) m
where b.id = m.id and m.made < b.tx_date::date;

select request_capital_refresh(u.user_id)
from (select distinct user_id from public.bank_transactions where account = 'TBC Bank') u;
