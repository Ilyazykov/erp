-- A bank's regular charges (a package fee, an insurance), for sync-estimates
-- (_shared/estimates.ts) to take off the account between statements, as
-- bank_transactions 'estimate_fee:<account>' (a running balance per currency
-- from 0 on top of the statement's; estimate_archive keeps what a statement
-- takes back). day_of_month: null = the month's last day. A charge that
-- changes is several rows, each valid from its valid_from (to valid_to).
-- E.g. Raiffeisen Serbia: the package 350 RSD a month (taken at the month's
-- end and, what that leaves unpaid, on the 1st-2nd after the bank sells some
-- EUR) and its insurance 40 RSD on the 14th.
create table if not exists public.recurring_charges (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  account text not null,
  currency text not null,
  amount numeric not null check (amount > 0),   -- taken off
  day_of_month smallint check (day_of_month between 1 and 31),
  description text not null,
  valid_from date not null default '2000-01-01',
  valid_to date,
  updated_at timestamptz not null default now()
);

alter table public.recurring_charges enable row level security;
create policy recurring_charges_own on public.recurring_charges
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
