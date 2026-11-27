-- The emergency fund as a queue (27.11.2026): up to $10,000, taken from its sources in their
-- order, each as far as the money left to $10,000 goes:
--   1 Ziraat's cash (not its term deposit)
--   2 Wise's cash
--   3 TBC's savings account
--   4 TBC's dollars (the salary from RemotePass; its lari are spent day to day, not the fund's)
--   5-7 Revolut's money-market funds: euro, dollar, pound
-- (Migration ...269 had gone out before this was settled: it only added the currency.)

alter table public.cushion_sources add column if not exists position int not null default 0;

delete from public.cushion_sources;
insert into public.cushion_sources (user_id, account, instrument_type, currency, position)
select u.user_id, v.account, v.instrument_type, v.currency, v.position
from (select distinct user_id from public.capital_refresh_queue) u
cross join (values
  ('Ziraat Bank', 'cash', '', 1),
  ('Wise', 'cash', '', 2),
  ('TBC Bank', 'liquid', '', 3),
  ('TBC Bank', 'cash', 'USD', 4),
  ('Revolut', 'liquid', 'EUR', 5), ('Revolut', 'liquid', 'USD', 6), ('Revolut', 'liquid', 'GBP', 7)
) v(account, instrument_type, currency, position);
