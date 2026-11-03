-- T-Bank's exchange step (...158) took a leg by "intrabank|internal|
-- внутрибанков" only: the dollar account writes "Внутренний перевод на
-- договор 5040156423" as well (-543.84 USD -> +38 877.82 RUB, 07.11.2021),
-- the rouble leg left unpaired and counted as income (03.11.2026).

do $mig$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := $s$b.description ~* 'intrabank|internal|внутрибанков'$s$;
  b text := $s$b.description ~* 'intrabank|internal|внутрибанков|внутренн'$s$;
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'match_internal_transfers: the T-Bank exchange step not found'; end if;
  execute replace(d, a, b);
end $mig$;

select request_capital_refresh(u.user_id) from (select distinct user_id from public.bank_transactions) u;
