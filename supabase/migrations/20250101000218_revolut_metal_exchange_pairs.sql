-- Revolut's statement writes a purchase of gold as two rows: "Revolut Ltd"
-- -450 EUR on the account and "Exchanged to XAU" +0.120628 XAU on the metal
-- pocket, the same second (or an hour apart in the older ones -- the two
-- pockets' time zones). The user linked the earlier ones by hand (28.10.2026);
-- the one of 05.11.2026 came with the statement of 19.11 unlinked and went to
-- "Transfers to people" -- an inner move counted as spent (the user, 20.11.2026).
-- Paired by the matcher now: a revolut_csv "Revolut Ltd" out row and a metal
-- pocket's "Exchanged to XAU / XAG / XPT / XPD" row within 65 minutes, nearest
-- first. After every other step, so a row they have already paired keeps its pair.
-- Patched in place as ...158 does (the function's own text).
do $mig$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := E'  return n;\nend';
  b text := $blk$  -- Revolut metal purchases (migration ...218): the account's "Revolut Ltd"
  -- out and the metal pocket's "Exchanged to <metal>" in, within 65 minutes
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
    with free as (
      select b.external_source as src, b.external_id as id, upper(b.currency) as ccy, b.amount, b.tx_date as t, b.description as d
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0 and b.external_source = 'revolut_csv'
        and (b.description = 'Revolut Ltd' or b.description ~ '^Exchanged to (XAU|XAG|XPT|XPD)$')
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, i.src as isrc, i.id as iid, i.amount, i.ccy, o.t as ot, i.t as it,
             abs(extract(epoch from i.t - o.t)) as dt
      from free o
      join free i on i.amount > 0 and i.ccy in ('XAU', 'XAG', 'XPT', 'XPD') and i.d = 'Exchanged to ' || i.ccy
       and i.t between o.t - interval '65 minutes' and o.t + interval '65 minutes'
      where o.amount < 0 and o.d = 'Revolut Ltd' and o.ccy not in ('XAU', 'XAG', 'XPT', 'XPD')
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by dt) as ro,
                row_number() over (partition by isrc, iid order by dt) as ri
      from cand
    )
    select p_user, os, oid, isrc, iid, amount, ccy, ot, it, 'auto' from ranked where ro = 1 and ri = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
$blk$ || E'  return n;\nend';
begin
  if position('migration ...218' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'match_internal_transfers: its end not found'; end if;
  execute replace(d, a, b);
end $mig$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from public.bank_transactions where external_source = 'revolut_csv') u;
