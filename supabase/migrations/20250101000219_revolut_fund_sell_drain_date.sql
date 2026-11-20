-- Revolut's Flexible Cash Funds settle a SELL on the next working day's
-- batch, while the money leaves the fund at once: a "From EUR Flexible
-- Cash Funds" row, or a card payment in another currency paid straight from
-- the fund (an "Exchanged to USD" row with no leg of its own in another
-- currency). One SELL often covers several such rows, and their sum is not
-- the SELL's (Claude's $238 paid from the fund on 05.11.2026 came out as
-- EUR 212.82), so match_internal_transfers' one-to-one pairing leaves the
-- SELL unpaired and capital_daily counted the money twice until the batch:
-- 05.11.2026 +$4 800 for a day (EUR 4 250 to IBKR and gold, the fund's
-- SELL of EUR 4 462.82 on 06.11).
--
-- refresh_capital_daily (...077) patched in place: a fund SELL also counts
-- from the first such row after the fund's previous batch (its previous
-- BUY / SELL), as the paired ones already do; without one -- its own date.
do $$
declare
  d text := pg_get_functiondef('public.refresh_capital_daily(uuid,date,date)'::regprocedure);
  a text := $q$'infinity'::date)) as eff_date$q$;
begin
  if position(a in d) = 0 or position(a in substr(d, position(a in d) + 1)) > 0 then
    raise exception 'refresh_capital_daily: tr_eff''s eff_date not where expected';
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
                 end, 'infinity'::date)) as eff_date$q$);
  execute d;
end $$;

select request_capital_refresh(u.user_id)
from (select distinct user_id from trades where external_source = 'revolut_fund_csv' and side = 'sell') u;
