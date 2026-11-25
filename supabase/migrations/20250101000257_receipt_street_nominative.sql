-- receipt_resolve_place matched the street on its stem without the genitive ending
-- ("melikishvilis" -> "melikishvil") only: a nominative street name ("S452 Tbilisi
-- Barnovi 56") kept its "i" and wasn't found in "Vasil Barnov Street", the place was
-- then looked up by the chain's name, six SPARs, none chosen (26.11.2026).
-- The nominative "i" goes too: "barnovi" -> "barnov", "rustaveli" -> "rustavel".
do $mig$
declare
  d text := pg_get_functiondef('public.receipt_resolve_place(bigint,text,uuid)'::regprocedure);
  a text := $t$regexp_replace(v_street, 'is$|s$', '')$t$;
  b text := $t$regexp_replace(v_street, 'is$|s$|i$', '')$t$;
begin
  if position(a in d) = 0 then raise exception 'receipt_resolve_place: street stem not found'; end if;
  execute replace(d, a, b);
end $mig$;
