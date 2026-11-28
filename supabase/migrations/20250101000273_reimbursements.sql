-- A spending paid back as a part of a bigger payment in (28.11.2026): the 150 EUR Swissport took
-- at Larnaca airport on 19.10.2026, before the flight to Tbilisi, the employer gave back in the
-- RemotePass payment of 26.11.2026 (2 694.80 USD, "pay period 26 Nov - 26 Nov").
-- Not an internal transfer: a pair there takes the whole row in out of the income and counts it in
-- the capital from the day the first leg moved -- here only a part of the row in answers the
-- spending, and the money did come in on 26.11. So its own table, reimbursements: the row out,
-- the row in, how much of it (in the row out's currency).
-- - the row out: "Not counted" (expense_category "Own accounts" set by hand, as a link does);
-- - refresh_not_counted: the pair under it, the row in as the part of it ("+150 EUR");
-- - refresh_income: the row in less the part (2 694.80 USD less 150 EUR), the whole amount kept in
--   the bank row and named in the income row's description.

create table if not exists public.reimbursements (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  out_source text not null, out_id text not null,
  in_source text not null, in_id text not null,
  amount numeric not null check (amount > 0),
  currency text not null,
  created_at timestamptz not null default now(),
  unique (user_id, out_source, out_id)
);
alter table public.reimbursements enable row level security;
drop policy if exists reimbursements_own on public.reimbursements;
create policy reimbursements_own on public.reimbursements for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.reimbursements to authenticated;

-- the pair under "Not counted": pair_id the reimbursement's id, negative (the transfers' are positive)
do $mig$
declare
  d text := pg_get_functiondef('public.refresh_not_counted(uuid)'::regprocedure);
  a text := $t$  where l.o_day is not null and l.i_day is not null;$t$;
  b text := $t$  where l.o_day is not null and l.i_day is not null;

  -- a spending paid back as a part of a payment in (migration ...273): the row in as that part
  insert into transfer_pair_rows
  select p_user, -rm.id, 'reimbursement', coalesce(bo.expense_category, 'Own accounts'),
         rm.out_source, rm.out_id, coalesce(bo.authorized_on, bo.tx_date::date), bo.account, bo.description, bo.amount, upper(bo.currency),
         bo.amount * usd_per_unit_on(bo.currency, coalesce(bo.authorized_on, bo.tx_date::date)),
         rm.in_source, rm.in_id, coalesce(bi.authorized_on, bi.tx_date::date), bi.account,
         bi.description || ' (' || rm.amount || ' ' || upper(rm.currency) || ' of ' || bi.amount || ' ' || upper(bi.currency) || ')',
         rm.amount, upper(rm.currency), rm.amount * usd_per_unit_on(rm.currency, coalesce(bi.authorized_on, bi.tx_date::date))
  from reimbursements rm
  join bank_transactions bo on bo.user_id = p_user and bo.external_source = rm.out_source and bo.external_id = rm.out_id
  join bank_transactions bi on bi.user_id = p_user and bi.external_source = rm.in_source and bi.external_id = rm.in_id
  where rm.user_id = p_user;$t$;
begin
  if position('migration ...273' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_not_counted: the pairs'' filter not found'; end if;
  execute replace(d, a, b);
end $mig$;

-- the income: the row in less the parts that paid spending back
do $mig$
declare
  d text := pg_get_functiondef('public.refresh_income(uuid)'::regprocedure);
  a text := $t$  select p_user, b.tx_date::date, b.account, b.external_source, b.external_id, b.description, b.amount,
         upper(b.currency), b.amount * usd_per_unit_on(b.currency, b.tx_date::date), b.income_category
  from bank_transactions b
  where b.user_id = p_user and b.amount > 0 and b.income_category is not null$t$;
  b text := $t$  -- less what of it paid a spending back (migration ...273), the whole amount in the description
  select p_user, b.tx_date::date, b.account, b.external_source, b.external_id,
         b.description || coalesce(rb.what, ''),
         b.amount - coalesce(rb.usd, 0) / usd_per_unit_on(b.currency, b.tx_date::date),
         upper(b.currency), b.amount * usd_per_unit_on(b.currency, b.tx_date::date) - coalesce(rb.usd, 0), b.income_category
  from bank_transactions b
  left join lateral (
    select sum(rm.amount * usd_per_unit_on(rm.currency, b.tx_date::date)) as usd,
           ' (' || b.amount || ' ' || upper(b.currency) || ' less '
             || string_agg(rm.amount || ' ' || upper(rm.currency) || ' paid back: ' || coalesce(o.description, rm.out_id), ', ') || ')' as what
    from reimbursements rm
    left join bank_transactions o on o.user_id = rm.user_id and o.external_source = rm.out_source and o.external_id = rm.out_id
    where rm.user_id = p_user and rm.in_source = b.external_source and rm.in_id = b.external_id
    having count(*) > 0
  ) rb on true
  where b.user_id = p_user and b.amount > 0 and b.income_category is not null$t$;
begin
  if position('migration ...273' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_income: the income rows'' select not found'; end if;
  execute replace(d, a, b);
end $mig$;

-- Swissport LCA, 150 EUR, 19.10.2026 (Revolut) <- RemotePass, 26.11.2026, 2 694.80 USD
insert into public.reimbursements (user_id, out_source, out_id, in_source, in_id, amount, currency)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, 150, 'EUR'
from public.bank_transactions o
join public.bank_transactions i on i.user_id = o.user_id and i.external_source = 'remotepass_csv:usd'
  and i.description = 'Payment BT1352455, paid by BNPL - Fintech, pay period 26 Nov - 26 Nov 2026'
where o.account = 'Revolut' and o.description = 'Swissport Lca' and o.amount = -150 and upper(o.currency) = 'EUR'
  and o.tx_date::date = '2026-10-19'
on conflict do nothing;
update public.bank_transactions o set expense_category = 'Own accounts', expense_manual = true,
  expense_note = coalesce(o.expense_note, 'ту плату мне компенсировали из выплаты RemotePass 26.11')
from public.reimbursements rm
where rm.user_id = o.user_id and rm.out_source = o.external_source and rm.out_id = o.external_id;
update public.expenses e set category = 'Own accounts'
from public.reimbursements rm
where rm.user_id = e.user_id and rm.out_source = e.external_source and rm.out_id = e.external_id;

select public.refresh_income(u.user_id), public.refresh_not_counted(u.user_id)
from (select distinct user_id from public.reimbursements) u;
