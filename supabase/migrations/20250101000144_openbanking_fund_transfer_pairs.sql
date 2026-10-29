-- The Flexible Cash Funds' stand-in trades from Open Banking
-- (openbanking_revolut_fund: "To EUR Flexible Cash Funds" seen on the account,
-- the fund's BUY written for the next day, as its statement has it) pair with
-- that transfer too, as the statement's do (...143) -- else the money was
-- gone from the capital for the day in between (29.10.2026: -$5 200, the
-- salary moved to the fund on the day it came).
--
-- match_internal_transfers (...143) patched in place: the rest stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := $q$t.external_source = 'revolut_fund_csv')$q$;
begin
  if position(a in d) = 0 then
    raise exception 'match_internal_transfers: the fund filter not where expected';
  end if;
  d := replace(d, a, $q$t.external_source in ('revolut_fund_csv', 'openbanking_revolut_fund'))$q$);
  execute d;
end $$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from trades where external_source = 'openbanking_revolut_fund') u;
