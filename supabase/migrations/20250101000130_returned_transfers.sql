-- Money lent and given back: internal_transfers.kind 'returned'. Not a
-- transfer between one's own accounts, but the same for capital and the
-- expenses tab -- the money came back, it wasn't spent. Given back in parts,
-- so one row out may pair with several back: the "each out row once" rule
-- holds for the other kinds only (each row in is still paired once).
alter table public.internal_transfers drop constraint internal_transfers_kind_check;
alter table public.internal_transfers add constraint internal_transfers_kind_check
  check (kind in ('transfer', 'repo', 'returned'));
alter table public.internal_transfers drop constraint internal_transfers_user_id_out_source_out_id_key;
create unique index internal_transfers_user_out_once on public.internal_transfers (user_id, out_source, out_id)
  where kind <> 'returned';

-- refresh_capital_daily joins each bank row to its pair to date it (pair_legs):
-- with a row out in two pairs it would be counted twice. One date per row --
-- the earliest. Patched in place: the rest of the function stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.refresh_capital_daily(uuid, date, date)'::regprocedure);
  a text := E'pair_legs as (\n    select out_source as src';
  b text := E'  ),\n  bank_eff as (';
begin
  if position(a in d) = 0 or position(b in d) = 0 then
    raise exception 'refresh_capital_daily: pair_legs not where expected';
  end if;
  d := replace(d, a, E'pair_legs as (\n    select src, id, min(eff) as eff from (\n    select out_source as src');
  d := replace(d, b, E'    ) l group by src, id\n  ),\n  bank_eff as (');
  execute d;
end $$;

-- 01.08.2022: 320 000 RUB out of T-Bank by phone, back the same day --
-- 150 000 into T-Bank by SBP from a Sber card that isn't one's own, and
-- 165 000 into Sber from the same person's card. 5 000 not given back.
insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by, kind)
select o.user_id, o.external_source, o.external_id, i.external_source, i.external_id, i.amount, i.currency, o.tx_date, i.tx_date, 'manual', 'returned'
from bank_transactions o
join bank_transactions i on i.user_id = o.user_id and i.currency = 'RUB' and i.tx_date::date = '2022-08-01'
  and ((i.account = 'T-Bank' and i.amount = 150000 and i.description ~ '^Replenishment by phone number'
        and not exists (select 1 from internal_transfers x where x.in_source = i.external_source and x.in_id = i.external_id))
    or (i.account = 'Sber' and i.amount = 165000 and i.description ~ '^SBOL transfer from card'))
where o.account = 'T-Bank' and o.currency = 'RUB' and o.amount = -320000 and o.tx_date::date = '2022-08-01'
  and o.description ~ '^External transfer by phone number'
on conflict do nothing;

select request_capital_refresh(u.user_id)
from (select distinct user_id from internal_transfers where kind = 'returned') u;
