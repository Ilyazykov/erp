-- The "Over time" chart's monthly totals, precomputed into a table: the page
-- reads it on opening the Expenses tab and draws the whole history at once,
-- not after every row since 2017 has come in (17 000 expense rows).
--
-- kind 'expense': the rows of expenses summed by month, category and the two
--   flags the chart switches on -- counted (the money is spending: the chart
--   shows these) and extrapolated (worked out, not recorded). basis 'day': by
--   the bank day (expenses.day; rent paid ahead in each month it pays for),
--   'paid': by paid_day ("spread prepaid rent" off). Summed here, in SQL.
-- kind 'income': each payment over the days it was earned in (mpExpIncomeDays
--   of index.html, run by the edge function month_totals from
--   supabase/functions/_shared/income_days.js -- the same code), summed by
--   month per source: account (the source is account + category; one changed
--   source is recomputed alone). basis 'day', counted, not extrapolated.
--   Expenses: account ''.
-- usd, eur, rub: the sum in each currency, every row (a payment) at its own
--   day's rate -- as the chart converted row by row (a month's 1st's rate was
--   4% off: March 2025, 4 166 EUR for 4 006); the rate as usd_per_unit_on
--   gives it, the page's usdPer: the last on or before the day, else the first.
--   null: no row of the group has a usd.
-- first_day: the group's first day (by its basis), the rows with no usd too:
--   the records' first day, the chart's "only from ..." and its first month.
--
-- Written only by the service role (the edge function, every 5 minutes by
-- pg_cron, when something changed); the user reads their own rows.
-- The views of migration 189 (expense_months, income_months) are dropped:
-- nothing reads them any more.

create table public.month_totals (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('expense', 'income')),
  basis text not null check (basis in ('day', 'paid')),
  month date not null,
  category text not null,
  account text not null default '',
  counted boolean not null,
  extrapolated boolean not null,
  usd numeric,
  eur numeric,
  rub numeric,
  first_day date,
  primary key (user_id, kind, basis, month, category, account, counted, extrapolated)
);
alter table public.month_totals enable row level security;
create policy "own month totals" on public.month_totals for select using (auth.uid() = user_id);
grant select on public.month_totals to authenticated;

-- The last run per user: when, what the data was then (month_totals_fingerprint)
-- and each income source's own fingerprint -- a run recomputes a source only
-- when its fingerprint moved. The service role only (no policy).
create table public.month_totals_runs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  run_at timestamptz not null,
  fingerprint text not null,
  income_fp jsonb not null default '{}'::jsonb
);
alter table public.month_totals_runs enable row level security;

drop view if exists public.expense_months;
drop view if exists public.income_months;

-- What a user's totals are made of, in a few numbers: refresh_expenses (and
-- refresh_income) delete and insert the rows anew, so the ids move with every
-- rebuild; the sums with a change by hand; the rates' last day with a new rate
-- (the days after the last rate take it).
create function public.month_totals_fingerprint(p_user uuid) returns text
language sql stable set search_path = public as $$
  select md5(concat_ws('|',
    (select concat_ws(',', count(*), max(id), sum(usd)) from expenses where user_id = p_user),
    (select concat_ws(',', count(*), max(id), sum(usd)) from income where user_id = p_user),
    (select max(day) from fx_history where currency = 'EUR'),
    (select max(day) from fx_history where currency = 'RUB')))
$$;

-- The users whose totals are to be recomputed: no run yet, an expenses rebuild
-- after the last run (capital_refresh_queue.expenses_at, migration 149), or
-- the data's fingerprint moved (a rebuild that didn't stamp expenses_at, a new rate).
create function public.month_totals_due() returns table (user_id uuid, fingerprint text)
language sql stable set search_path = public as $$
  select u.user_id, f.fp
  from (select distinct e.user_id from expenses e union select distinct i.user_id from income i) u
  left join month_totals_runs r on r.user_id = u.user_id
  left join capital_refresh_queue q on q.user_id = u.user_id
  cross join lateral (select month_totals_fingerprint(u.user_id) as fp) f
  where r.user_id is null or q.expenses_at > r.run_at or r.fingerprint is distinct from f.fp
$$;

-- A user's income sources (account, category) with their fingerprint now --
-- every row's day and sum in each currency -- and the one stored at the last
-- run; a source gone since: fp null.
create function public.month_totals_income_sources(p_user uuid)
returns table (account text, category text, fp text, stored_fp text)
language sql stable set search_path = public as $$
  with now_fp as (
    select i.account, i.category,
           md5(string_agg(concat_ws(':', i.day, i.usd, i.usd / usd_per_unit_on('EUR', i.day), i.usd / usd_per_unit_on('RUB', i.day)),
                          ',' order by i.day, i.usd)) as fp
    from income i where i.user_id = p_user
    group by i.account, i.category
  ), stored as (
    select split_part(s.key, chr(1), 1) as account, split_part(s.key, chr(1), 2) as category, s.value #>> '{}' as fp
    from month_totals_runs r, jsonb_each(r.income_fp) s
    where r.user_id = p_user
  )
  select coalesce(n.account, s.account), coalesce(n.category, s.category), n.fp, s.fp
  from now_fp n full join stored s on s.account = n.account and s.category = n.category
$$;

-- The income rows of some sources (p_sources: [{account, category}]), in the
-- page's order (day, id), each in the three currencies at its day's rate.
create function public.month_totals_income_rows(p_user uuid, p_sources jsonb)
returns table (id bigint, day date, account text, category text, usd numeric, eur numeric, rub numeric)
language sql stable set search_path = public as $$
  select i.id, i.day, i.account, i.category, i.usd,
         i.usd / usd_per_unit_on('EUR', i.day), i.usd / usd_per_unit_on('RUB', i.day)
  from income i
  join jsonb_to_recordset(p_sources) s(account text, category text) on s.account = i.account and s.category = i.category
  where i.user_id = p_user
  order by i.day, i.id
$$;

-- One user's run, in one transaction: the expenses' totals summed here and
-- set against the stored ones -- only the rows whose sums differ are written,
-- the rows gone deleted; the income's of the changed sources (p_sources:
-- [{account, category}], p_income: their monthly rows from the edge function)
-- the same way; then the run's stamp. -> the rows and months written.
create function public.month_totals_write(p_user uuid, p_fingerprint text, p_sources jsonb, p_income jsonb, p_income_fp jsonb)
returns jsonb
language plpgsql set search_path = public as $$
declare
  touched date[];
  n_up int;
  n_del int;
  i_up int;
  i_del int;
begin
  create temp table mt_want on commit drop as
  with days as (
    select d, usd_per_unit_on('EUR', d) as eur_rate, usd_per_unit_on('RUB', d) as rub_rate
    from (select day as d from expenses where user_id = p_user union select paid_day from expenses where user_id = p_user) x
  ), b as (
    select 'day' as basis, e.day as d, e.category, e.counted, e.extrapolated, e.usd from expenses e where e.user_id = p_user
    union all
    select 'paid', e.paid_day, e.category, e.counted, e.extrapolated, e.usd from expenses e where e.user_id = p_user
  )
  select b.basis, date_trunc('month', b.d)::date as month, b.category, b.counted, b.extrapolated,
         sum(b.usd) as usd, sum(b.usd / r.eur_rate) as eur, sum(b.usd / r.rub_rate) as rub, min(b.d) as first_day
  from b join days r on r.d = b.d
  group by 1, 2, 3, 4, 5;

  with del as (
    delete from month_totals t
    where t.user_id = p_user and t.kind = 'expense'
      and not exists (select 1 from mt_want w where w.basis = t.basis and w.month = t.month and w.category = t.category
                        and w.counted = t.counted and w.extrapolated = t.extrapolated)
    returning t.month
  ), up as (
    insert into month_totals (user_id, kind, basis, month, category, account, counted, extrapolated, usd, eur, rub, first_day)
    select p_user, 'expense', w.basis, w.month, w.category, '', w.counted, w.extrapolated, w.usd, w.eur, w.rub, w.first_day
    from mt_want w
    where not exists (select 1 from month_totals t
                      where t.user_id = p_user and t.kind = 'expense' and t.basis = w.basis and t.month = w.month
                        and t.category = w.category and t.account = '' and t.counted = w.counted and t.extrapolated = w.extrapolated
                        and t.usd is not distinct from w.usd and t.eur is not distinct from w.eur
                        and t.rub is not distinct from w.rub and t.first_day is not distinct from w.first_day)
    on conflict (user_id, kind, basis, month, category, account, counted, extrapolated)
    do update set usd = excluded.usd, eur = excluded.eur, rub = excluded.rub, first_day = excluded.first_day
    returning month
  )
  select (select count(*) from up), (select count(*) from del),
         array(select month from up union select month from del)
  into n_up, n_del, touched;

  -- the income of the changed sources: their rows as the edge function summed them
  create temp table mt_income on commit drop as
  select w.month, w.category, w.account, w.usd, w.eur, w.rub
  from jsonb_to_recordset(coalesce(p_income, '[]'::jsonb)) w(month date, category text, account text, usd numeric, eur numeric, rub numeric);

  with src as (
    select s.account, s.category from jsonb_to_recordset(coalesce(p_sources, '[]'::jsonb)) s(account text, category text)
  ), del as (
    delete from month_totals t
    using src
    where t.user_id = p_user and t.kind = 'income' and t.account = src.account and t.category = src.category
      and not exists (select 1 from mt_income w where w.month = t.month and w.category = t.category and w.account = t.account)
    returning t.month
  ), up as (
    insert into month_totals (user_id, kind, basis, month, category, account, counted, extrapolated, usd, eur, rub, first_day)
    select p_user, 'income', 'day', w.month, w.category, w.account, true, false, w.usd, w.eur, w.rub, null
    from mt_income w
    where not exists (select 1 from month_totals t
                      where t.user_id = p_user and t.kind = 'income' and t.basis = 'day' and t.month = w.month
                        and t.category = w.category and t.account = w.account and t.counted and not t.extrapolated
                        and t.usd is not distinct from w.usd and t.eur is not distinct from w.eur and t.rub is not distinct from w.rub)
    on conflict (user_id, kind, basis, month, category, account, counted, extrapolated)
    do update set usd = excluded.usd, eur = excluded.eur, rub = excluded.rub
    returning month
  )
  select (select count(*) from up), (select count(*) from del),
         array(select unnest(touched) union select month from up union select month from del)
  into i_up, i_del, touched;

  insert into month_totals_runs (user_id, run_at, fingerprint, income_fp)
  values (p_user, now(), p_fingerprint, coalesce(p_income_fp, '{}'::jsonb))
  on conflict (user_id) do update set run_at = excluded.run_at, fingerprint = excluded.fingerprint, income_fp = excluded.income_fp;

  return jsonb_build_object('expense_rows', n_up, 'expense_deleted', n_del, 'income_rows', i_up, 'income_deleted', i_del,
                            'months', coalesce(array_length(touched, 1), 0));
end $$;

revoke all on function public.month_totals_fingerprint(uuid), public.month_totals_due(),
  public.month_totals_income_sources(uuid), public.month_totals_income_rows(uuid, jsonb),
  public.month_totals_write(uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.month_totals_fingerprint(uuid), public.month_totals_due(),
  public.month_totals_income_sources(uuid), public.month_totals_income_rows(uuid, jsonb),
  public.month_totals_write(uuid, text, jsonb, jsonb, jsonb) to service_role;

-- Every 5 minutes; the edge function is called only when a user is due (a
-- few aggregates of each user's rows, milliseconds), so a quiet hour costs no
-- function calls at all.
select cron.schedule('month-totals', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/month_totals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  where exists (select 1 from public.month_totals_due());
$$);
