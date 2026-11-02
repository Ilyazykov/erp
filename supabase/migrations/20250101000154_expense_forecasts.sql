-- The expenses tab's forecast of a period not over yet (index.html: a part-only
-- bar's dotted frame, "≈ $1,400 for all of it"), kept day by day: once the
-- period is over, the forecasts are set against what it came to, and the
-- forecast's rules corrected (asked for 03.11.2026). The page writes it as it
-- draws the bars -- one row a day per period shown (step: month / quarter /
-- year / month_td ..., the period's label, the currency shown), the last
-- drawing of the day the one kept. parts: per category what was spent so far,
-- the estimate and how it was made (the pace and its days, the last whole
-- period's payments, as it is).

create table if not exists public.expense_forecasts (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  made_on date not null,
  step text not null,
  period text not null,
  period_from date not null,
  period_to date not null,
  currency text not null,
  actual numeric not null,
  projected numeric not null,
  parts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, made_on, step, period, currency)
);
alter table public.expense_forecasts enable row level security;
drop policy if exists expense_forecasts_own on public.expense_forecasts;
create policy expense_forecasts_own on public.expense_forecasts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
