-- Where one lived or travelled and with whom, by dates: the expenses tab
-- lists them to pick a period by and shades them on its chart over time.
-- The rows are personal (names, places) and go in from the app's side, not
-- here -- the repository is public.
create table public.life_periods (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_day date not null,
  end_day date,            -- null: still there
  place text not null,     -- 'Antalya', 'Georgia', 'Novi Sad'
  company text,            -- who with; null: alone
  note text,
  created_at timestamptz not null default now(),
  check (end_day is null or end_day >= start_day)
);
alter table public.life_periods enable row level security;
create policy "own life periods" on public.life_periods
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index life_periods_user_day on public.life_periods (user_id, start_day);
