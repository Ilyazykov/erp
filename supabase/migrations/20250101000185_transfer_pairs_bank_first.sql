-- A transfer to a savings account or deposit is paired with the bank row it
-- came from, and the order of the candidates decided wrongly once (12.10 and
-- 13.10.2026): the T-Bank -80 000 of 12.10 12:39 ("Transfer") was paired with
-- the savings credit of 13.10, because its words ("Transfer") match the hint on
-- both sides. The Sber row it really reached (+80 000 on card 12.10 12:46,
-- 7 minutes later) and the card's own -80 000 of 13.10 (to the savings account)
-- were left without a pair. Now a bank row on the incoming side is preferred
-- over a savings position (a trade), then the hint, then the gap. The bank-to-bank
-- pair is the transfer itself; the savings credit then pairs with the card's
-- outflow, which is the only one left.
--
-- The wrong pair (created by the upload of 07.11.2026) goes; the next refresh
-- pairs the rest. Patched in place as ...158 does (the function's own text).

do $mig$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := E'abs(extract(epoch from i.t - o.t)) as gap';
  b text := E'abs(extract(epoch from i.t - o.t)) as gap,\n             exists (select 1 from bank_transactions bk where bk.user_id = p_user\n               and bk.external_source = i.src and bk.external_id = i.id) as in_bank';
  c text := 'order by both_hint desc, gap)';
  e text := 'order by in_bank desc, both_hint desc, gap)';
begin
  if position(a in d) = 0 then raise exception 'match_internal_transfers: the gap column not found'; end if;
  if position(c in d) = 0 then raise exception 'match_internal_transfers: the ranking not found'; end if;
  execute replace(replace(d, a, b), c, e);
end $mig$;

delete from internal_transfers
where matched_by = 'auto'
  and out_source = 't_bank_csv:40817810800003347848' and out_id = '40817810800003347848:2026-10-12:12:39:Transfer:-80000'
  and in_source = 'sber_deposit_csv:40817810042590060866' and in_id = '40817810042590060866:2026-10-13::Credit (Savings account):80000';
