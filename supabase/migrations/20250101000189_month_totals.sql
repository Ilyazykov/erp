-- Monthly totals, precomputed: the "Over time" chart reads these instead of the
-- whole history of rows (the page was loading every row since 2019). One row per
-- user, month, category and the two flags the chart switches on -- counted (the
-- money is spending) and extrapolated (the spending that left no trace, filled in
-- from a per-day norm). The rows of expenses already hold rent spread over its
-- months (migration ...) and the extrapolated ones, so nothing is recomputed here.
-- Views, security_invoker: the rows of the user only, through the base tables' RLS.

create or replace view public.expense_months with (security_invoker = true) as
select user_id, date_trunc('month', day)::date as month, category, counted, extrapolated,
       sum(usd) as usd, count(*) as rows_n
from public.expenses
group by user_id, date_trunc('month', day)::date, category, counted, extrapolated;

create or replace view public.income_months with (security_invoker = true) as
select user_id, date_trunc('month', day)::date as month, category,
       sum(usd) as usd, count(*) as rows_n
from public.income
group by user_id, date_trunc('month', day)::date, category;

grant select on public.expense_months, public.income_months to authenticated;
