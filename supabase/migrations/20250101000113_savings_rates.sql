-- A savings account's or deposit's terms set by hand, for sync-estimates
-- (_shared/estimates.ts): until a savings account's statements show interest
-- paid -- a new account -- its rate can't be read off them; once they do, the
-- rate here still wins (a bank's rate changes: update it here). pay_day: the
-- day of the month the interest comes (null: the day the latest payment came,
-- or every day for a bank that pays daily; month's end for a new account).
-- ends: the day a deposit closes -- the last interest comes then, none after
-- (null: open-ended). A deposit's rate defaults to the one in its name.
-- A rate that changes (a promo rate for the first months) is several rows:
-- each holds from its valid_from on; pay_day and ends are the latest row's.
create table if not exists public.savings_rates (
  user_id uuid not null references auth.users (id) on delete cascade,
  account text not null,
  ticker text not null,            -- e.g. 'SAVINGS:Sber RUB'
  valid_from date not null default '2000-01-01',
  rate numeric,                    -- % a year, e.g. 16
  pay_day smallint check (pay_day between 1 and 31),
  ends date,
  note text,
  updated_at timestamptz not null default now(),
  primary key (user_id, account, ticker, valid_from)
);

alter table public.savings_rates enable row level security;
create policy savings_rates_own on public.savings_rates
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
