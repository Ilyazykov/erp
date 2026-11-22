-- A transfer's incoming leg can't come before its outgoing one (30.10.2026). The chain of the day:
-- Sber savings -70 000 -> Sber card +70 000 (10:53) -> Sber card -70 000 (11:04) -> T-Bank card
-- +70 000 (11:09) -> T-Bank card -70 000 (11:11, "to contract 8219282925") -> T-Bank savings
-- +70 000 (11:11). The T-Bank card's -70 000 was paired with the Sber card's +70 000 of 10:53 (a
-- bank row is preferred over a savings position, ...185), and the Sber savings' -70 000 with the
-- T-Bank savings' +70 000 -- two pairs crossed.
--
-- Now a candidate whose incoming leg is more than 2 minutes before the outgoing one goes last,
-- when both legs carry a time. A savings position's time is the one in its id (T-Bank's deposit
-- CSV: "<account>:<date>:<HH:MM>:..."), else it has none (the day only); a bank row with its time
-- at 00:00 or by its authorization date has none either.
--
-- The two crossed pairs go; the refresh queued below pairs their legs again. Patched in place as
-- ...185 does (the function's own text).

do $mig$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  -- the bank legs: timed
  a1 text := $t$as hint
      from bank_transactions b$t$;
  a2 text := $t$as hint,
             (b.authorized_on is null and (b.tx_date at time zone 'UTC')::time <> time '00:00') as timed
      from bank_transactions b$t$;
  -- the savings positions: the time in the id, timed when there is one
  b1 text := $t$             t.trade_date::timestamptz,
             true
      from trades t$t$;
  b2 text := $t$             coalesce(((regexp_match(t.external_id, '^[^:]*:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2}):'))[1] || ' '
               || (regexp_match(t.external_id, '^[^:]*:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2}):'))[2] || '+00')::timestamptz,
               t.trade_date::timestamptz),
             true,
             regexp_match(t.external_id, '^[^:]*:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2}):') is not null
      from trades t$t$;
  c1 text := '(o.hint and i.hint) as both_hint,';
  c2 text := $t$(o.hint and i.hint) as both_hint,
             not (o.timed and i.timed and i.t < o.t - interval '2 minutes') as causal,$t$;
  e1 text := 'order by in_bank desc, both_hint desc, gap)';
  e2 text := 'order by causal desc, in_bank desc, both_hint desc, gap)';
begin
  if position(a1 in d) = 0 then raise exception 'match_internal_transfers: the bank legs'' hint not found'; end if;
  if position(b1 in d) = 0 then raise exception 'match_internal_transfers: the savings legs'' time not found'; end if;
  if position(c1 in d) = 0 then raise exception 'match_internal_transfers: both_hint not found'; end if;
  if position(e1 in d) = 0 then raise exception 'match_internal_transfers: the ranking not found'; end if;
  execute replace(replace(replace(replace(d, a1, a2), b1, b2), c1, c2), e1, e2);
end $mig$;

delete from internal_transfers
where matched_by = 'auto'
  and ((out_source = 't_bank_csv:40817810800003347848'
        and out_id = '40817810800003347848:2026-10-30:11:11:Internal transfer to contract 8219282925:-70000'
        and in_source = 'sber_csv:40817810942004893373'
        and in_id = '40817810942004893373:2026-10-30:10:53:SBERBANK ONL@IN VKLAD-KARTA. Operation on account ****3373:70000')
    or (out_source = 'sber_deposit_csv:40817810042590060866'
        and out_id = '40817810042590060866:2026-10-30::Debit (Savings account):-70000'
        and in_source = 't_bank_deposit_csv:42301810200060138942'
        and in_id = '42301810200060138942:2026-10-30:11:11:Intrabank transfer from contract 5040156423:70000'));

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
