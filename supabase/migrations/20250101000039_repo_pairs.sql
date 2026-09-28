-- REPO legs (a T-Bank broker account: "РЕПО" +8 358.58 USD on 20.05.2022,
-- -8 358.58 on 23.05) are cash that came in against securities still held
-- and went back -- counted on top of the securities for those days. Paired
-- up like a transfer (internal_transfers.kind 'repo'), so both legs count
-- from the day the first one moved and cancel out; the repo interest (the
-- legs' difference) stays on the closing day. match_internal_transfers
-- (038) redefined; refresh_capital_daily needs no change.

alter table public.internal_transfers
  add column kind text not null default 'transfer' check (kind in ('transfer', 'repo'));

create or replace function public.match_internal_transfers(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  k integer;
begin
  delete from internal_transfers it
  where it.user_id = p_user and it.matched_by = 'auto'
    and (not exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.out_source and b.external_id = it.out_id)
      or not exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.in_source and b.external_id = it.in_id));
  -- REPO: the opening and closing legs on the same account (same source and
  -- currency), opposite signs, the closing one later within 31 days and
  -- within 2% of the opening (the repo rate), nearest first.
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by, kind)
    with legs as (
      select b.external_source as src, b.external_id as id, upper(b.currency) as ccy, b.amount,
             coalesce(b.booked_at, b.tx_date) as t
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0
        and b.description ~* '^\s*(РЕПО|REPO)\M'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, c.src as cs, c.id as cid, o.amount as oa, c.amount as ca, o.ccy, o.t as ot, c.t as ct
      from legs o
      join legs c on c.src = o.src and c.ccy = o.ccy and sign(c.amount) = -sign(o.amount)
       and c.t > o.t and c.t <= o.t + interval '31 days'
       and abs(abs(c.amount) - abs(o.amount)) <= 0.02 * abs(o.amount)
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by ct) as ro,
                row_number() over (partition by cs, cid order by ot desc) as rc
      from cand
    )
    select p_user,
           case when oa < 0 then os else cs end, case when oa < 0 then oid else cid end,
           case when oa < 0 then cs else os end, case when oa < 0 then cid else oid end,
           greatest(oa, ca), ccy,
           case when oa < 0 then ot else ct end, case when oa < 0 then ct else ot end, 'auto', 'repo'
    from ranked where ro = 1 and rc = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
    with legs as (
      select b.external_source as src, b.external_id as id, b.account, upper(b.currency) as ccy, b.amount,
             coalesce(b.authorized_on::timestamptz, b.tx_date) as t,
             b.description ~* ('revolut|top-?up|ibkr|interactive brokers|freedom|wise|bybit|binance|crypto\.com|'
               || 'transfer|intrabank|withdraw|deposit|replenish|card operation|operation on card|card2card|c2c|'
               || '\msbp\M|tinkoff|popolnen|perevod|zykov|'
               || 'перевод|вывод|пополнен|зачислен|списан|сбп|тинькофф|зыков') as hint
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, i.src as isrc, i.id as iid, i.amount, o.ccy, o.t as ot, i.t as it,
             (o.hint and i.hint) as both_hint, abs(extract(epoch from i.t - o.t)) as gap
      from legs o
      join legs i on i.ccy = o.ccy and i.amount = -o.amount
       and (i.src <> o.src or i.account <> o.account)
       and i.t between o.t - interval '1 day' and o.t + interval '5 days'
      where o.amount < 0 and (o.hint or i.hint)
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by both_hint desc, gap) as ro,
                row_number() over (partition by isrc, iid order by both_hint desc, gap) as ri
      from cand
    )
    select p_user, os, oid, isrc, iid, amount, ccy, ot, it, 'auto' from ranked where ro = 1 and ri = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
  return n;
end $$;
revoke all on function public.match_internal_transfers(uuid) from public, anon, authenticated;
