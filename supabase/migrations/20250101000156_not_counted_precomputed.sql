-- The expenses tab's "Not counted" took long to open (03.11.2026): transfer_pairs
-- (...155) looked each leg up by an "exists (... or ...)" -- 6 s a call, and the
-- page called it page by page. Now refresh_expenses keeps both lists as rows,
-- after refresh_income (the money in that's no income depends on it), the legs
-- found by plain joins; the page reads the two tables.

create table if not exists public.transfer_pair_rows (
  user_id uuid not null references auth.users (id) on delete cascade,
  pair_id bigint not null,
  kind text, category text,
  out_source text, out_id text, out_day date, out_account text, out_description text, out_amount numeric, out_currency text, out_usd numeric,
  in_source text, in_id text, in_day date, in_account text, in_description text, in_amount numeric, in_currency text, in_usd numeric,
  primary key (user_id, pair_id)
);
create table if not exists public.unpaired_in_rows (
  user_id uuid not null references auth.users (id) on delete cascade,
  external_source text not null, external_id text not null,
  day date, account text, description text, amount numeric, currency text, usd numeric, bank_category text,
  primary key (user_id, external_source, external_id)
);
alter table public.transfer_pair_rows enable row level security;
alter table public.unpaired_in_rows enable row level security;
drop policy if exists transfer_pair_rows_own on public.transfer_pair_rows;
create policy transfer_pair_rows_own on public.transfer_pair_rows for select to authenticated using (user_id = auth.uid());
drop policy if exists unpaired_in_rows_own on public.unpaired_in_rows;
create policy unpaired_in_rows_own on public.unpaired_in_rows for select to authenticated using (user_id = auth.uid());

create or replace function public.refresh_not_counted(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from transfer_pair_rows where user_id = p_user;
  insert into transfer_pair_rows
  select p_user, l.id, l.kind, coalesce(l.o_cat, 'Own accounts'),
         l.out_source, l.out_id, l.o_day, l.o_acc, l.o_desc, l.o_amt, l.o_ccy, l.o_amt * usd_per_unit_on(l.o_ccy, l.o_day),
         l.in_source, l.in_id, l.i_day, l.i_acc, l.i_desc, l.i_amt, l.i_ccy, l.i_amt * usd_per_unit_on(l.i_ccy, l.i_day)
  from (
    select x.id, x.kind, x.out_source, x.out_id, x.in_source, x.in_id,
      coalesce(bo.authorized_on, bo.tx_date::date, tor.trade_date) as o_day, coalesce(bo.account, tor.account, '') as o_acc,
      coalesce(bo.description, tor.note, tor.ticker) as o_desc,
      coalesce(bo.amount, case when tor.side = 'buy' then tor.quantity * tor.price else -tor.quantity * tor.price end) as o_amt,
      upper(coalesce(bo.currency, tor.currency)) as o_ccy, bo.expense_category as o_cat,
      coalesce(bi.authorized_on, bi.tx_date::date, ti.trade_date) as i_day, coalesce(bi.account, ti.account, '') as i_acc,
      coalesce(bi.description, ti.note, ti.ticker) as i_desc,
      coalesce(bi.amount, case when ti.side = 'buy' then ti.quantity * ti.price else -ti.quantity * ti.price end) as i_amt,
      upper(coalesce(bi.currency, ti.currency)) as i_ccy
    from internal_transfers x
    left join bank_transactions bo on bo.user_id = p_user and bo.external_source = x.out_source and bo.external_id = x.out_id
    left join trades tor on bo.id is null and tor.user_id = p_user and tor.external_source = x.out_source and tor.external_id = x.out_id
    left join bank_transactions bi on bi.user_id = p_user and bi.external_source = x.in_source and bi.external_id = x.in_id
    left join trades ti on bi.id is null and ti.user_id = p_user and ti.external_source = x.in_source and ti.external_id = x.in_id
    where x.user_id = p_user and x.matched_by <> 'rejected'
  ) l
  where l.o_day is not null and l.i_day is not null;

  delete from unpaired_in_rows where user_id = p_user;
  insert into unpaired_in_rows
  select p_user, b.external_source, b.external_id, coalesce(b.authorized_on, b.tx_date::date), b.account, b.description, b.amount,
         upper(b.currency), b.amount * usd_per_unit_on(b.currency, coalesce(b.authorized_on, b.tx_date::date)), b.category
  from bank_transactions b
  where b.user_id = p_user and b.amount > 0 and not b.synthetic and b.income_category is null and b.refund_of is null
    and not exists (select 1 from internal_transfers x where x.user_id = p_user and x.matched_by <> 'rejected'
                    and x.in_source = b.external_source and x.in_id = b.external_id)
  on conflict do nothing;
end $$;
revoke execute on function public.refresh_not_counted(uuid) from public, anon, authenticated;

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_expenses(uuid)'::regprocedure);
  a text := E'  perform refresh_income(p_user);';
  b text := E'  perform refresh_income(p_user);\n  perform refresh_not_counted(p_user);  -- migration ...156';
begin
  if position('refresh_not_counted' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_expenses: refresh_income call not found'; end if;
  execute replace(d, a, b);
end $mig$;

drop function if exists public.transfer_pairs(date, date);
drop function if exists public.unpaired_in(date, date);

select refresh_not_counted(u.user_id) from (select distinct user_id from public.bank_transactions) u;
