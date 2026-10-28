-- A currency exchange inside TBC Bank (Georgia) is one operation: the EUR
-- account's row out ("Currency exchange (კროს-კურსი: 1 EUR = 2.8560 GEL)",
-- -350.14 EUR) and the GEL account's row in (+1000 GEL), worded the same, the
-- same day. Different currencies, so match_internal_transfers never paired
-- them; now it does: same account, same description, same day, opposite
-- signs, different currencies -- several exchanges at one rate on one day
-- (both worded alike) go by the closest value in dollars. The amount is what
-- arrived (as in ...127). The expenses tab then shows what the exchange lost.
-- Only TBC for now: other banks' exchanges stay as they were.

create or replace function public.match_internal_transfers(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  k integer;
begin
  delete from internal_transfers it
  where it.user_id = p_user and it.matched_by = 'auto'
    and (not (exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.out_source and b.external_id = it.out_id)
           or exists (select 1 from trades t where t.user_id = p_user and t.external_source = it.out_source and t.external_id = it.out_id))
      or not (exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.in_source and b.external_id = it.in_id)
           or exists (select 1 from trades t where t.user_id = p_user and t.external_source = it.in_source and t.external_id = it.in_id)));
  -- TBC currency exchanges (see the header) -- first, so neither leg is taken by a
  -- same-currency transfer below
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
    with legs as (
      select b.external_source as src, b.external_id as id, b.account, b.description, upper(b.currency) as ccy, b.amount,
             b.tx_date as t, abs(b.amount) * usd_per_unit_on(b.currency, b.tx_date::date) as usd
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0
        and b.account = 'TBC Bank' and b.description ~* '^currency exchange'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, i.src as isrc, i.id as iid, i.amount, i.ccy, o.t as ot, i.t as it,
             abs(ln(o.usd / nullif(i.usd, 0))) as gap
      from legs o
      join legs i on i.account = o.account and i.description = o.description and i.ccy <> o.ccy
       and i.amount > 0 and i.t::date = o.t::date
      where o.amount < 0 and o.usd > 0 and i.usd > 0
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by gap) as ro,
                row_number() over (partition by isrc, iid order by gap) as ri
      from cand
    )
    select p_user, os, oid, isrc, iid, amount, ccy, ot, it, 'auto' from ranked where ro = 1 and ri = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
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
      union all
      -- savings accounts and deposits are kept as positions (trades SAVINGS: /
      -- DEPOSIT: / ВКЛАД:, 1 unit of their currency): a top-up is a buy, a
      -- withdrawal a sell; interest is no transfer and stays out
      select t.external_source, t.external_id, coalesce(t.account, '(unspecified)'), upper(t.currency),
             case when t.side = 'buy' then t.quantity * t.price else -t.quantity * t.price end,
             t.trade_date::timestamptz,
             true
      from trades t
      where t.user_id = p_user and t.ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' and t.side in ('buy', 'sell')
        and t.external_id is not null and t.external_source <> 'snowball_csv' and t.quantity * t.price <> 0
        and coalesce(t.note, '') !~* 'interest|процент|капитализац|проценты'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = t.external_source and x.out_id = t.external_id)
            or (x.in_source = t.external_source and x.in_id = t.external_id)))
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

select request_capital_refresh(u.user_id)
from (select distinct user_id from bank_transactions where account = 'TBC Bank') u;
