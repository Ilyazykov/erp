-- One-off reminders over the tabs (27.11.2026): a text and a day, shown as a banner from
-- remind_days before it until marked done on the page. The first: Crypto.com's Level Up Plus,
-- taken on its 30-day free trial on 27.11.2026 (monthly, 3.99 EUR from 27.12) -- cancel before.
create table if not exists public.reminders (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null,
  due_day date not null,
  remind_days int not null default 3,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.reminders enable row level security;
drop policy if exists "own reminders" on public.reminders;
create policy "own reminders" on public.reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.reminders to authenticated;
grant usage on sequence public.reminders_id_seq to authenticated;

insert into public.reminders (user_id, text, due_day, remind_days)
select u.user_id, 'Crypto.com Level Up Plus: отменить подписку до конца пробного месяца (с 27.12 — 3,99 EUR в месяц)', '2026-12-26', 5
from (select distinct user_id from public.capital_refresh_queue) u
where not exists (select 1 from public.reminders r where r.user_id = u.user_id and r.text like 'Crypto.com Level Up Plus:%');
