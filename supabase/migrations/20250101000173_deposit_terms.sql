-- A term deposit's end (asked 05.11.2026, for the Bonds & deposits tab's
-- maturities): no statement gives it, so it's set by hand on that tab -- a
-- click on the deposit's bar.
create table public.deposit_terms (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticker text not null,        -- the deposit's trades ticker: 'DEPOSIT:T-Bank RUB 16% 31.10.2025'
  end_day date not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, ticker)
);
alter table public.deposit_terms enable row level security;
create policy "own deposit terms" on public.deposit_terms
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
