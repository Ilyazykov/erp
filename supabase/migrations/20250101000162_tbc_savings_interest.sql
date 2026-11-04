-- TBC's savings account pays its interest as "დარიცხული პროცენტის რეალიზაცია"
-- (Georgian); refresh_income's interest-from-trades step (...155) knew only
-- the English and Russian words, so it was never income. "პროცენტ" joins them.

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_income(uuid)'::regprocedure);
  a text := $$coalesce(t.note, '') ~* 'interest|процент|капитализац|пролонгац'$$;
  b text := $$coalesce(t.note, '') ~* 'interest|процент|პროცენტ|капитализац|пролонгац'$$;
begin
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_income: the interest note match not found'; end if;
  execute replace(d, a, b);
end $mig$;

select request_capital_refresh(u.user_id) from (select distinct user_id from public.bank_transactions) u;
