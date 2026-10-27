-- When a credit card wants paying, for the reminder on top of the page
-- (index.html, mpRenderCardReminders): the bank's statement comes on
-- statement_day, the grace period's payment is due on the next due_day after
-- it. What it wants paid: the debt at the statement (balance_after in
-- bank_transactions, product 'credit_card') less what came onto the card
-- since. paid_for: the due date already paid ("Paid" on the
-- reminder), so it stays quiet until the next statement.
-- E.g. T-Bank: the statement on the 12th, due on the 5th of the next month.
create table if not exists public.credit_card_reminders (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  account text not null,
  currency text not null default 'RUB',
  statement_day smallint not null check (statement_day between 1 and 31),
  due_day smallint not null check (due_day between 1 and 31),
  remind_days smallint not null default 10,   -- shown from this many days before the due date
  paid_for date,
  updated_at timestamptz not null default now(),
  unique (user_id, account)
);

alter table public.credit_card_reminders enable row level security;
create policy credit_card_reminders_own on public.credit_card_reminders
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into public.credit_card_reminders (user_id, account, currency, statement_day, due_day)
select distinct user_id, 'T-Bank', 'RUB', 12, 5
from public.bank_transactions where account = 'T-Bank' and product = 'credit_card'
on conflict (user_id, account) do nothing;
