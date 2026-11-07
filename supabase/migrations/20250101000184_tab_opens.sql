-- Every tab opening, per user, with its time: tab_visits. Written by
-- record_tab_open on each tab switch (showTab in index.html) and once per page
-- load for the tab shown first. Counts, averages and any period or hour-of-day
-- view are queries over this table. tab_opens_weekly is the average per week
-- since the first visit of each tab (at least one week, so a new tab isn't
-- inflated). Only the user's own rows are visible (RLS).

create table public.tab_visits (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tab text not null,
  opened_at timestamptz not null default now()
);
create index tab_visits_user_time on public.tab_visits (user_id, opened_at);
alter table public.tab_visits enable row level security;
create policy "own tab visits" on public.tab_visits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.record_tab_open(p_tab text) returns void
language sql as $$
  insert into public.tab_visits (user_id, tab) values (auth.uid(), p_tab);
$$;

create view public.tab_opens_weekly with (security_invoker = true) as
select user_id, tab,
       count(*) as opens,
       min(opened_at) as first_opened,
       max(opened_at) as last_opened,
       count(*) / greatest(extract(epoch from (now() - min(opened_at))) / 604800.0, 1) as per_week
from public.tab_visits
group by user_id, tab;
