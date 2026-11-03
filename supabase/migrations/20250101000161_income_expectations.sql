-- Income one expects to come in: the expenses tab's chart frames an income bar
-- of a period not over yet with what it will likely come to -- the expected
-- salary for each month whose last day is still ahead (paid then) and none of
-- it came yet, the other kinds at the last whole period's pace. The rows are
-- personal (the amounts) and go in from the app's side, not here -- the
-- repository is public.
create table public.income_expectations (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text not null,   -- an income category: 'Salary'
  amount numeric not null,  -- a month, paid on its last day
  currency text not null,
  from_day date not null,
  to_day date,              -- null: no end known
  note text,
  created_at timestamptz not null default now()
);
alter table public.income_expectations enable row level security;
create policy "own income expectations" on public.income_expectations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
