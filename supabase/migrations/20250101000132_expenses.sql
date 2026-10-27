-- Expenses: each row out of bank_transactions gets its category in the row
-- itself (expense_category) -- what it was spent on, or why it isn't spending
-- (money only moved between one's own accounts, an investment, an exchange,
-- ...). The expenses tab reads `expenses`: those rows at their day's rate in
-- dollars, rent paid ahead spread over its months, and what exchanges lost.
-- Both rebuilt with every capital rebuild (refresh_expenses, run by
-- run_capital_refresh_step) instead of in the page.
--
-- expense_category is set
--   * by hand -- expense_manual = true, and nothing below touches it;
--   * else from internal_transfers: a row out of a pair is 'Own accounts', or
--     'Returned' for money lent and given back (kind 'returned');
--   * else by the first rule in expense_rules (by priority) whose every given
--     condition holds, for the rows a statement brings in. The rules are
--     personal (contract numbers, dates, sums) and live only in the database,
--     not in the public page or this repository;
--   * else 'Shopping' for a cash purchase ("Spent in cash: ...") or a row the
--     importer called utilities_or_shopping, and 'Other' for the rest.
-- Not spending: the labels in expense_not_spending().
--
-- expense_rules conditions, all optional:
--   description_re  the description (case-insensitive, as all of them)
--   text_re         what the row is about: a cash purchase's item
--                   ("Spent in cash: Xiaomi scales (Antalya)" -> "Xiaomi
--                   scales"), else the description and the importer's category
--                   (but its catch-all utilities_or_shopping)
--   category_re     the importer's category;  source_re  external_source
--   account / account_not, currency, date_from / date_to, amount_min /
--   amount_max (out, in the row's currency)
--   exclude_re      the description must not match it
--   not_bought      not for a cash purchase (the 'Cash' category: a purchase
--                   goes by what it bought)
--
-- Rent paid for several months at once counts a share in each of them:
-- expense_spread_months from expense_spread_from on the row, or as the cash
-- ledger writes it, "Paid for the flat (6 months from 07.05.2022)".

alter table public.bank_transactions
  add column expense_category text,
  add column expense_manual boolean not null default false,
  add column expense_spread_months integer check (expense_spread_months > 1),
  add column expense_spread_from date,
  add constraint bank_transactions_expense_spread_check
    check ((expense_spread_months is null) = (expense_spread_from is null));

create or replace function public.expense_not_spending(p_label text) returns boolean
language sql immutable as $$
  select p_label = any (array['Own accounts', 'Returned', 'Investments', 'Funds & savings',
                              'Currency exchange', 'To cash', 'Crypto', 'Bought for others'])
$$;

create table public.expense_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  priority integer not null,
  category text not null,
  description_re text,
  text_re text,
  category_re text,
  source_re text,
  account text,
  account_not text,
  currency text,
  date_from date,
  date_to date,
  amount_min numeric,
  amount_max numeric,
  exclude_re text,
  not_bought boolean not null default false,
  note text
);
alter table public.expense_rules enable row level security;
create policy "own expense rules" on public.expense_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index expense_rules_user_priority on public.expense_rules (user_id, priority);

-- One row per row out (per month of a spread one), plus the exchange losses.
-- day: the month it counts in; paid_day: when the money left (the same unless
-- spread). amount: in the row's currency, out positive.
create table public.expenses (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  paid_day date not null,
  account text not null,
  external_source text not null,
  external_id text,
  description text not null,
  amount numeric not null,
  currency text not null,
  usd numeric,
  category text not null,
  counted boolean not null
);
alter table public.expenses enable row level security;
create policy "own expenses" on public.expenses for select using (auth.uid() = user_id);
create index expenses_user_day on public.expenses (user_id, day);

-- Dollars per unit on a day: the last rate on or before it (the first one
-- after, for a day before the history starts).
create or replace function public.usd_per_unit_on(p_currency text, p_day date) returns numeric
language sql stable set search_path = public as $$
  select case when upper(p_currency) = 'USD' then 1 else coalesce(
    (select usd_per_unit from fx_history where currency = upper(p_currency) and day <= p_day order by day desc limit 1),
    (select usd_per_unit from fx_history where currency = upper(p_currency) and day > p_day order by day limit 1)) end
$$;

create or replace function public.refresh_expenses(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
  r record;
begin
  -- 1. the category of each row out, but those set by hand. Rule by rule over
  -- all the rows still open (not each row through all the rules): Postgres
  -- keeps only 32 compiled regular expressions, and the rules have more.
  drop table if exists expense_rows;
  create temp table expense_rows on commit drop as
  select b.id, b.external_source, b.external_id, b.account, b.description, b.category,
         -b.amount as amt, upper(b.currency) as ccy, b.tx_date::date as day,
         substring(b.description from '^Spent in cash: (.*?)(?:\s*\([^)]*\))?$') as bought,
         null::text as txt, null::text as cat
  from bank_transactions b
  where b.user_id = p_user and b.amount < 0 and not b.expense_manual
    and coalesce(b.synthetic_kind, '') not in ('balance_snapshot', 'account_closed', 'data_gap');
  update expense_rows set txt = coalesce(bought, trim(description || ' ' ||
    case when category = 'utilities_or_shopping' then '' else coalesce(category, '') end));

  update expense_rows e set cat = case when p.kind = 'returned' then 'Returned' else 'Own accounts' end
  from (select distinct on (out_source, out_id) out_source, out_id, kind
        from internal_transfers
        where user_id = p_user and matched_by <> 'rejected'
        order by out_source, out_id, kind = 'returned') p
  where p.out_source = e.external_source and p.out_id = e.external_id;

  for r in select * from expense_rules where user_id = p_user order by priority, id loop
    update expense_rows e set cat = r.category
    where e.cat is null
      and (r.description_re is null or e.description ~* r.description_re)
      and (r.text_re is null or e.txt ~* r.text_re)
      and (r.category_re is null or coalesce(e.category, '') ~* r.category_re)
      and (r.source_re is null or e.external_source ~* r.source_re)
      and (r.account is null or e.account = r.account)
      and (r.account_not is null or e.account <> r.account_not)
      and (r.currency is null or e.ccy = upper(r.currency))
      and (r.date_from is null or e.day >= r.date_from)
      and (r.date_to is null or e.day <= r.date_to)
      and (r.amount_min is null or e.amt >= r.amount_min)
      and (r.amount_max is null or e.amt <= r.amount_max)
      and (r.exclude_re is null or e.description !~* r.exclude_re)
      and not (r.not_bought and e.bought is not null);
  end loop;

  update expense_rows set cat = case when bought is not null or category = 'utilities_or_shopping' then 'Shopping' else 'Other' end
  where cat is null;

  update bank_transactions b set expense_category = e.cat
  from expense_rows e
  where b.id = e.id and b.expense_category is distinct from e.cat;

  -- 2. the rows of the tab
  delete from expenses where user_id = p_user;

  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
  with outs as (
    select b.*, -b.amount as amt, upper(b.currency) as ccy, b.tx_date::date as d,
           usd_per_unit_on(b.currency, b.tx_date::date) as rate,
           not expense_not_spending(b.expense_category) as counted_row,
           coalesce(b.expense_spread_months, (regexp_match(b.description, '\((\d+) months from \d\d\.\d\d\.\d{4}\)'))[1]::int, 1) as parts,
           coalesce(b.expense_spread_from,
                    to_date((regexp_match(b.description, '\(\d+ months from (\d\d\.\d\d\.\d{4})\)'))[1], 'DD.MM.YYYY'),
                    b.tx_date::date) as first_day
    from bank_transactions b
    where b.user_id = p_user and b.amount < 0 and b.expense_category is not null
      and coalesce(b.synthetic_kind, '') not in ('balance_snapshot', 'account_closed', 'data_gap')
  )
  select p_user,
         case when o.parts > 1 and o.counted_row
           then (make_date(extract(year from o.first_day)::int, extract(month from o.first_day)::int,
                           least(extract(day from o.first_day)::int, 28)) + make_interval(months => k))::date
           else o.d end,
         o.d, o.account, o.external_source, o.external_id,
         case when o.parts > 1 and o.counted_row then o.description || ' -- ' || (k + 1) || '/' || o.parts || ', paid ' || o.d
              else o.description end,
         o.amt / case when o.counted_row then o.parts else 1 end, o.ccy,
         o.amt * o.rate / case when o.counted_row then o.parts else 1 end,
         o.expense_category, o.counted_row
  from outs o
  cross join lateral generate_series(0, case when o.counted_row then o.parts - 1 else 0 end) k;

  -- 3. what a pair from one currency into another lost on the way: what left
  -- less what arrived, at their days' rates -- not a gain, nor past a third (an
  -- estimate on one side)
  insert into expenses (user_id, day, paid_day, account, external_source, external_id, description, amount, currency, usd, category, counted)
  select p_user, x.day, x.day, x.account, x.external_source, x.external_id,
         'Lost on the exchange: ' || x.description || ' -> ' || x.in_amount || ' ' || x.in_ccy,
         x.loss / x.rate, x.ccy, x.loss, 'Fees', true
  from (
    select o.account, o.external_source, o.external_id, o.description, o.tx_date::date as day, upper(o.currency) as ccy,
           it.amount as in_amount, upper(it.currency) as in_ccy,
           usd_per_unit_on(o.currency, o.tx_date::date) as rate,
           -o.amount * usd_per_unit_on(o.currency, o.tx_date::date) as out_usd,
           -o.amount * usd_per_unit_on(o.currency, o.tx_date::date)
             - it.amount * usd_per_unit_on(it.currency, it.in_at::date) as loss
    from internal_transfers it
    join bank_transactions o on o.user_id = it.user_id and o.external_source = it.out_source and o.external_id = it.out_id
    where it.user_id = p_user and it.kind = 'transfer' and it.matched_by <> 'rejected'
      and o.amount < 0 and upper(o.currency) <> upper(it.currency)
  ) x
  where x.loss > 0 and x.loss <= x.out_usd / 3;

  select count(*) into n from expenses where user_id = p_user;
  return n;
end $$;

-- run with every capital rebuild, after investment_daily
create or replace function public.run_capital_refresh_step() returns integer
language plpgsql security definer set search_path = public as $function$
declare
  t0 timestamptz := clock_timestamp();
  q record;
  d date;
  started timestamptz;
  total integer;
  done integer := 0;
begin
  for q in
    select * from capital_refresh_queue
    where next_from is not null or finished_at is null or finished_at < requested_at
    order by requested_at
  loop
    if q.next_from is null then
      perform match_internal_transfers(q.user_id);
      d := capital_first_day(q.user_id);
      started := now();
      total := 0;
    else
      d := q.next_from;
      started := q.started_at;
      total := coalesce(q.rows_total, 0);
    end if;
    while d is not null and d <= current_date and clock_timestamp() - t0 < interval '40 seconds' loop
      total := total + refresh_capital_daily(q.user_id, d, least(d + 29, current_date));
      d := d + 30;
      done := done + 1;
    end loop;
    if d is null or d > current_date then
      perform refresh_capital_ever_held(q.user_id);
      perform refresh_investment_daily(q.user_id);
      perform refresh_expenses(q.user_id);
      update capital_refresh_queue
      set started_at = started, rows_total = total, next_from = null,
          -- a request during the run is newer than its start: run again
          finished_at = case when requested_at > started then started else now() end,
          today_usd = (select round(capital_usd, 2) from capital_daily_total where user_id = q.user_id and day = current_date)
      where user_id = q.user_id;
    else
      update capital_refresh_queue
      set started_at = started, rows_total = total, next_from = d, finished_at = null
      where user_id = q.user_id;
    end if;
    exit when clock_timestamp() - t0 >= interval '40 seconds';
  end loop;
  return done;
end $function$;
