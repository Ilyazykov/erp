-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- 1. User's portfolio holdings (ticker + weight/quantity)
create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  quantity numeric,
  weight numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);

-- 2. User's personal target-weight scenarios (independent from the base repo calc)
create table public.target_weights_custom (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_name text not null default 'default',
  ticker text not null,
  target_weight numeric not null,
  created_at timestamptz not null default now(),
  unique (user_id, scenario_name, ticker)
);

-- 3. Trade / broker-event history (buy/sell/dividend/amortisation/repayment/stock_as_dividend)
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  side text not null check (side in ('buy', 'sell', 'dividend', 'amortisation', 'repayment', 'stock_as_dividend')),
  quantity numeric not null,
  price numeric not null,
  trade_date date not null,
  currency text,
  fee_tax numeric,
  fee_currency text,
  exchange text,
  nkd numeric,
  note text,
  external_source text,  -- e.g. 'snowball_csv', for de-duplicating repeated imports
  external_id text,
  created_at timestamptz not null default now()
);
create unique index trades_external_unique
  on public.trades (user_id, external_source, external_id)
  where external_id is not null;

-- Row Level Security: every user can only see/modify their own rows
alter table public.portfolios enable row level security;
alter table public.target_weights_custom enable row level security;
alter table public.trades enable row level security;

create policy "own portfolios" on public.portfolios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own target weights" on public.target_weights_custom
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own trades" on public.trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep updated_at fresh on edits to portfolios
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger portfolios_set_updated_at
  before update on public.portfolios
  for each row execute function public.set_updated_at();
