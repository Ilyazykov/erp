-- An emergency-fund source can be one currency of an account (27.11.2026): TBC's dollars (the
-- salary from RemotePass) are the fund's, its lari -- the money spent day to day -- are not.
-- currency '' -- every currency of the account's cash / liquid assets, as before.

alter table public.cushion_sources add column if not exists currency text not null default '';
alter table public.cushion_sources drop constraint if exists cushion_sources_pkey;
alter table public.cushion_sources add primary key (user_id, account, instrument_type, currency);

insert into public.cushion_sources (user_id, account, instrument_type, currency)
select user_id, 'TBC Bank', 'cash', 'USD' from (select distinct user_id from public.capital_refresh_queue) u
on conflict do nothing;
