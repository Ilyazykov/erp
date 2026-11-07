-- The income, transfer-leg and unpaired-in rows carry the time their bank row
-- has (HH:MM, as the statement gives it; 00:00 is no time), so the expenses tab
-- shows it without a second lookup by key (a batch of thousands of requests).
-- Views over the rows the rebuilds write, not new columns in those rebuilds.
-- The bank row is read through the same RLS (security_invoker).

create or replace view public.income_timed with (security_invoker = true) as
select i.*, to_char(b.tx_date at time zone 'UTC', 'HH24:MI') as clock
from public.income i
left join public.bank_transactions b
  on b.user_id = i.user_id and b.external_source = i.external_source and b.external_id = i.external_id;

create or replace view public.transfer_pair_timed with (security_invoker = true) as
select p.*,
  (select to_char(b.tx_date at time zone 'UTC', 'HH24:MI') from public.bank_transactions b
    where b.user_id = p.user_id and b.external_source = p.out_source and b.external_id = p.out_id) as out_clock,
  (select to_char(b.tx_date at time zone 'UTC', 'HH24:MI') from public.bank_transactions b
    where b.user_id = p.user_id and b.external_source = p.in_source and b.external_id = p.in_id) as in_clock
from public.transfer_pair_rows p;

create or replace view public.unpaired_in_timed with (security_invoker = true) as
select u.*, to_char(b.tx_date at time zone 'UTC', 'HH24:MI') as clock
from public.unpaired_in_rows u
left join public.bank_transactions b
  on b.user_id = u.user_id and b.external_source = u.external_source and b.external_id = u.external_id;

grant select on public.income_timed, public.transfer_pair_timed, public.unpaired_in_timed to authenticated;
