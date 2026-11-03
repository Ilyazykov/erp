-- T-Bank's exchanges between one's own accounts in different currencies (the
-- rouble card, contract 5040156423, and the dollar, euro, yuan accounts:
-- "Internal transfer to contract 5063173370" -40 000 RUB, "Внутрибанковский
-- перевод с договора 5040156423" +595.24 USD, 26.11.2018) were left unpaired:
-- the transfer step pairs the same amount in the same currency only. Their
-- money in went to the income as Other -- $11 852 of it (03.11.2026).
-- The two legs are booked the same minute: paired by time first (within 5
-- minutes), then by how near the two are in dollars (within 15% -- the bank's
-- rate against the day's one, wide in 2018 and 2022).

do $mig$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := E'  -- REPO: the opening and closing legs';
  b text := $blk$  -- T-Bank exchanges between own accounts (migration ...158): the same
  -- minute, different currencies
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
    with legs as (
      select b.external_source as src, b.external_id as id, upper(b.currency) as ccy, b.amount, b.tx_date as t,
             abs(b.amount) * usd_per_unit_on(b.currency, b.tx_date::date) as usd
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0 and b.external_source like 't_bank_csv:%'
        and b.description ~* '(contract|договор[а]?) [0-9]{9,10}' and b.description ~* 'intrabank|internal|внутрибанков'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, i.src as isrc, i.id as iid, i.amount, i.ccy, o.t as ot, i.t as it,
             abs(extract(epoch from i.t - o.t)) as dt, abs(ln(o.usd / i.usd)) as gap
      from legs o
      join legs i on i.src <> o.src and i.ccy <> o.ccy and i.amount > 0
       and i.t between o.t - interval '5 minutes' and o.t + interval '5 minutes'
      where o.amount < 0 and o.usd > 0 and i.usd > 0 and abs(ln(o.usd / i.usd)) < 0.15
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by dt, gap) as ro,
                row_number() over (partition by isrc, iid order by dt, gap) as ri
      from cand
    )
    select p_user, os, oid, isrc, iid, amount, ccy, ot, it, 'auto' from ranked where ro = 1 and ri = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
$blk$ || E'  -- REPO: the opening and closing legs';
begin
  if position('migration ...158' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'match_internal_transfers: the REPO step not found'; end if;
  execute replace(d, a, b);
end $mig$;

select request_capital_refresh(u.user_id) from (select distinct user_id from public.bank_transactions) u;
