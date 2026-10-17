-- 064 moved a T-Bank reconciling sale ('<agr>:adjust:<isin>', price 0) to
-- the redemption day only when the redemption payout was on the same
-- agreement. ОФЗ 26209 was bought on one, moved to a new one in May 2022 and
-- redeemed there on 21.07.2022: its sale stayed at 23.09.2026. Now the
-- payout of that ISIN on any agreement (as import-tbank-broker does too).
update public.trades a
set trade_date = r.day, settle_date = null,
    note = 'Redeemed at maturity (the report''s "Погашение в уст. срок" payout of ' || r.day || '), holding brought to the report''s closing 0'
from (
  select user_id, split_part(external_id, ':', 4) as isin, max(trade_date) as day
  from public.trades
  where external_source = 'tbank_broker_xlsx' and side = 'repayment' and external_id like '%:income:%'
  group by 1, 2
) r
where a.external_source = 'tbank_broker_xlsx'
  and a.external_id ~ (':adjust:' || r.isin || '$')
  and a.user_id = r.user_id
  and a.side = 'sell' and a.price = 0
  and a.trade_date > r.day;

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
