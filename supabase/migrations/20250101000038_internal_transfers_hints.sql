-- More wording that marks a row as a transfer between one's own accounts
-- (match_internal_transfers, 037): Sber's side of a top-up of a T-Bank card
-- reads "Tinkoff Bank. Operation on card ****0329", T-Bank's "Replenishment
-- by phone number SBP..." -- neither had a word the matcher knew, so the
-- pair (150 000 RUB on 01.08.2022) stayed unmatched; 2018 T-Bank rows are
-- transliterated ("Popolnenie. Bankovskii perevod").

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
