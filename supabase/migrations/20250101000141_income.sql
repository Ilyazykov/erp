-- Income: one's own money coming in -- a salary, the rent of a flat -- not what
-- the investments earned (`income` in investment_daily is that). Each row in of
-- bank_transactions gets its kind in the row itself (income_category):
--   * by hand -- income_manual = true, and nothing below touches it;
--   * else by the first rule in income_rules (by priority) whose every given
--     condition holds. Personal as expense_rules: only in the database;
--   * else none: a row in that's no income (a transfer between one's own
--     accounts, a sale, a refund, ...).
-- A row in of a pair in internal_transfers is never income. The expenses tab
-- reads `income`: those rows at their day's rate in dollars, rebuilt with every
-- capital rebuild (refresh_income, run at the end of refresh_expenses).
--
-- income_rules conditions, all optional: description_re (case-insensitive),
-- source_re (external_source), account, currency, date_from / date_to,
-- amount_min / amount_max (in the row's currency), exclude_re (the description
-- must not match it).

alter table public.bank_transactions
  add column income_category text,
  add column income_manual boolean not null default false;

create table public.income_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  priority integer not null,
  category text not null,
  description_re text,
  source_re text,
  account text,
  currency text,
  date_from date,
  date_to date,
  amount_min numeric,
  amount_max numeric,
  exclude_re text,
  note text
);
alter table public.income_rules enable row level security;
create policy "own income rules" on public.income_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index income_rules_user_priority on public.income_rules (user_id, priority);

create table public.income (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  account text not null,
  external_source text not null,
  external_id text,
  description text not null,
  amount numeric not null,
  currency text not null,
  usd numeric,
  category text not null
);
alter table public.income enable row level security;
create policy "own income" on public.income for select using (auth.uid() = user_id);
create index income_user_day on public.income (user_id, day);

create or replace function public.refresh_income(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
  r record;
begin
  -- 1. the kind of each row in, but those set by hand -- rule by rule, as in
  -- refresh_expenses
  drop table if exists income_rows;
  create temp table income_rows on commit drop as
  select b.id, b.external_source, b.account, b.description, b.amount, upper(b.currency) as ccy,
         b.tx_date::date as day, null::text as cat
  from bank_transactions b
  where b.user_id = p_user and b.amount > 0 and not b.income_manual and not b.synthetic
    and not exists (select 1 from internal_transfers x where x.user_id = p_user and x.matched_by <> 'rejected'
                    and x.in_source = b.external_source and x.in_id = b.external_id);

  for r in select * from income_rules where user_id = p_user order by priority, id loop
    update income_rows e set cat = r.category
    where e.cat is null
      and (r.description_re is null or e.description ~* r.description_re)
      and (r.source_re is null or e.external_source ~* r.source_re)
      and (r.account is null or e.account = r.account)
      and (r.currency is null or e.ccy = upper(r.currency))
      and (r.date_from is null or e.day >= r.date_from)
      and (r.date_to is null or e.day <= r.date_to)
      and (r.amount_min is null or e.amount >= r.amount_min)
      and (r.amount_max is null or e.amount <= r.amount_max)
      and (r.exclude_re is null or e.description !~* r.exclude_re);
  end loop;

  update bank_transactions b set income_category = null
  where b.user_id = p_user and not b.income_manual and b.income_category is not null
    and not exists (select 1 from income_rows e where e.id = b.id and e.cat is not null);
  update bank_transactions b set income_category = e.cat
  from income_rows e
  where b.id = e.id and e.cat is not null and b.income_category is distinct from e.cat;

  -- 2. the rows of the tab
  delete from income where user_id = p_user;
  insert into income (user_id, day, account, external_source, external_id, description, amount, currency, usd, category)
  select p_user, b.tx_date::date, b.account, b.external_source, b.external_id, b.description, b.amount,
         upper(b.currency), b.amount * usd_per_unit_on(b.currency, b.tx_date::date), b.income_category
  from bank_transactions b
  where b.user_id = p_user and b.amount > 0 and b.income_category is not null;

  select count(*) into n from income where user_id = p_user;
  return n;
end $$;
revoke all on function public.refresh_income(uuid) from public, anon, authenticated;

-- run at the end of refresh_expenses (...132): patched in place, the rest of
-- the function stays as it is
do $$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  select count(*) into n from expenses where user_id = p_user;';
begin
  if position(a in d) = 0 then
    raise exception 'refresh_expenses: the final count not where expected';
  end if;
  d := replace(d, a, E'  perform refresh_income(p_user);\n\n' || a);
  execute d;
end $$;
