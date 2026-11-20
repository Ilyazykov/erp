-- ...219 dated a Revolut Flexible Cash Funds SELL by the money leaving the
-- fund in refresh_capital_daily only; refresh_investment_daily dates the
-- trades with a copy of its own, so "Invested" still had the day twice
-- (05.11.2026: +$4 900 -- VWRA bought at IBKR on the 5th, the fund's SELL
-- taken off on the 6th). The same rule here.
do $$
declare
  d text := pg_get_functiondef('public.refresh_investment_daily(uuid)'::regprocedure);
  a text := $q$'infinity'::date)) as day,$q$;
begin
  if position(a in d) = 0 or position(a in substr(d, position(a in d) + 1)) > 0 then
    raise exception 'refresh_investment_daily: tr''s day not where expected';
  end if;
  d := replace(d, a, $q$'infinity'::date),
                 coalesce(case when t.external_source = 'revolut_fund_csv' and t.side = 'sell' then
                   (select min(b.tx_date::date) from bank_transactions b
                    where b.user_id = p_user and b.account = t.account and not b.synthetic and b.amount > 0
                      and b.tx_date::date > coalesce((select max(p.trade_date) from trades p
                                                      where p.user_id = p_user and p.account = t.account
                                                        and p.ticker = t.ticker and p.external_source = t.external_source
                                                        and p.side in ('buy', 'sell') and p.trade_date < t.trade_date),
                                                     t.trade_date - 5)
                      and b.tx_date::date <= t.trade_date
                      and (b.description in ('From ' || upper(t.currency) || ' Flexible Cash Funds', 'From Flexible Cash Funds')
                           or (b.description ilike 'Exchanged to %'
                               and not exists (select 1 from bank_transactions o
                                               where o.user_id = p_user and o.account = b.account and o.amount < 0
                                                 and upper(o.currency) <> upper(b.currency)
                                                 and abs(extract(epoch from o.tx_date - b.tx_date)) <= 10))))
                 end, 'infinity'::date)) as day,$q$);
  execute d;
end $$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from trades where external_source = 'revolut_fund_csv' and side = 'sell') u;
