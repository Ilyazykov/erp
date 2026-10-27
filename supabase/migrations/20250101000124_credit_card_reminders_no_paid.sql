-- The reminder (...123) goes once the statements show the grace period's
-- payment made; there is no marking it paid by hand any more.
alter table public.credit_card_reminders drop column if exists paid_for;
