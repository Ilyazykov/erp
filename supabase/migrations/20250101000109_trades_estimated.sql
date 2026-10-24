-- A trade that stands in for one its statement will bring -- worked out, not
-- read from a statement: true. sync-openbanking writes them for Revolut's
-- Flexible Cash Funds / Instant Access Savings after their latest statement
-- (the account's transfers to / from them as buys / sells, the funds' daily
-- return and service fee estimated from the statement's last week). The
-- statement, once uploaded, replaces them for its period (its own rows,
-- estimated false); everything else is false.

alter table public.trades add column if not exists estimated boolean not null default false;
comment on column public.trades.estimated is
  'Worked out, not from a statement (sync-openbanking''s stand-ins for Revolut fund / savings operations); replaced by the statement''s rows when it comes.';
