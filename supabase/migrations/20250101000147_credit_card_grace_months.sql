-- Sber's credit card (СберКарта, "до 120 дней"): no statement-day / due-day pair
-- like T-Bank's. Its reporting period is the calendar month ("платёж
-- рассчитаем после 1 декабря, если на конец дня 30 ноября будет
-- задолженность", the app, 02.11.2026), and a month's purchases are interest
-- free until the end of the third month after it (November's: 28 February).
-- grace_months: that many months after the purchases' month the debt they
-- made is due (index.html, mpRenderCardReminders). due_day: the monthly
-- minimum payment's day, when known -- null until the first statement shows it.

alter table public.credit_card_reminders add column if not exists grace_months smallint
  check (grace_months between 1 and 12);
alter table public.credit_card_reminders alter column due_day drop not null;

insert into public.credit_card_reminders (user_id, account, currency, statement_day, due_day, remind_days, grace_months)
select distinct user_id, 'Sber', 'RUB', 1, null::smallint, 14, 3
from public.bank_transactions where account = 'Sber' and product = 'credit_card'
on conflict (user_id, account) do nothing;
