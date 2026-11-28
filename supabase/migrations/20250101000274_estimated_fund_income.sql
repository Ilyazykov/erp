-- The Revolut money market funds' estimated daily return in the income tab (28.11.2026): the
-- tab took the funds' return only from the fund statement (revolut_fund_csv, migration ...155),
-- so it stopped at the statement's last day (20.11.2026) while the estimates of the days after it
-- (openbanking_revolut_fund, estimated, return less fee) counted in the capital only. Now each
-- such day is an income row too, from that source (the page marks it an estimate), until the
-- statement brings the day's own rows (a day the statement has is left out).

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_income(uuid)'::regprocedure);
  a text := $t$  group by t.trade_date, t.ticker, t.currency
  having sum(t.quantity) > 0;$t$;
  b text := $t$  group by t.trade_date, t.ticker, t.currency
  having sum(t.quantity) > 0
  -- the days after the statement: the estimate (migration ...274)
  union all
  select p_user, t.trade_date, '', 'openbanking_revolut_fund', 'return:' || t.ticker || ':' || t.trade_date,
         'Money market fund return less fee: ' || t.ticker, sum(t.quantity), upper(t.currency),
         sum(t.quantity) * usd_per_unit_on(t.currency, t.trade_date), 'Interest'
  from trades t
  where t.user_id = p_user and t.external_source = 'openbanking_revolut_fund' and t.side = 'dividend'
    and not exists (select 1 from trades c where c.user_id = p_user and c.external_source = 'revolut_fund_csv'
                    and c.side = 'dividend' and c.ticker = t.ticker and c.trade_date = t.trade_date)
  group by t.trade_date, t.ticker, t.currency
  having sum(t.quantity) > 0;$t$;
begin
  if position('migration ...274' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'refresh_income: the funds'' return not found'; end if;
  execute replace(d, a, b);
end $mig$;

select public.refresh_income(u.user_id)
from (select distinct user_id from public.trades where external_source = 'openbanking_revolut_fund') u;
