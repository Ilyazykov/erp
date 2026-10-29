-- Revolut's Flexible Cash Funds (money-market funds, revolut_fund_csv: units at
-- 1 EUR / GBP / USD) are a pocket of the account: "To EUR Flexible Cash Funds"
-- leaves the account, the fund's BUY of the same amount arrives -- often the
-- next day in the fund's statement (a move near midnight UTC), so the capital
-- lost the money for a day (28.06.2026: -$4 000), and a "From ..." before the
-- fund's SELL counted it twice. match_internal_transfers pairs them now, as it
-- does savings and deposits; a paired trade counts from the day the first of
-- the two moved (refresh_capital_daily, tr_eff).
--
-- match_internal_transfers (...139) patched in place: the rest stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.match_internal_transfers(uuid)'::regprocedure);
  a text := $q$t.ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):'$q$;
begin
  if position(a in d) = 0 then
    raise exception 'match_internal_transfers: the savings filter not where expected';
  end if;
  d := replace(d, a, $q$(t.ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' or t.external_source = 'revolut_fund_csv')$q$);
  execute d;
end $$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from trades where external_source = 'revolut_fund_csv') u;
