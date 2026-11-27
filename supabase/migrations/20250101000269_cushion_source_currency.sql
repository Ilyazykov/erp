-- The emergency fund as a queue (27.11.2026): up to $10,000, taken from its sources in their
-- order, each as far as the money left to $10,000 goes:
--   1 Ziraat's cash (not its term deposit)
--   2 TBC's savings account
--   3 TBC's dollars (the salary from RemotePass; its lari are spent day to day, not the fund's)
--   4-6 Revolut's money-market funds: euro, dollar, pound
-- A source: an account's cash or liquid assets, in one currency or ('') all of them.

alter table public.cushion_sources add column if not exists currency text not null default '';
alter table public.cushion_sources add column if not exists position int not null default 0;
alter table public.cushion_sources drop constraint if exists cushion_sources_pkey;
alter table public.cushion_sources add primary key (user_id, account, instrument_type, currency);

delete from public.cushion_sources;
insert into public.cushion_sources (user_id, account, instrument_type, currency, position)
select u.user_id, v.account, v.instrument_type, v.currency, v.position
from (select distinct user_id from public.capital_refresh_queue) u
cross join (values
  ('Ziraat Bank', 'cash', '', 1),
  ('TBC Bank', 'liquid', '', 2),
  ('TBC Bank', 'cash', 'USD', 3),
  ('Revolut', 'liquid', 'EUR', 4), ('Revolut', 'liquid', 'USD', 5), ('Revolut', 'liquid', 'GBP', 6)
) v(account, instrument_type, currency, position);
