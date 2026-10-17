-- A bond redeemed at maturity left the T-Bank holdings only at the end of the
-- report that showed it gone: import-tbank-broker's reconciling row
-- ('<agr>:adjust:<isin>', a sale at price 0) is dated the report's period
-- end, and a full report runs from 2020 to 2026. ОФЗ 26209 (redeemed
-- 21.07.2022) and НижгорОб10 (24.08.2020) stood in the capital history until
-- 23.09.2026 -- worth ~$90 and ~$46 for years, then -100% in "Earned by
-- asset". The importer now dates such a row on the redemption payout
-- ('<agr>:income:<date>:<isin>:...', side 'repayment'); the rows already
-- stored are moved the same way, and the capital history is rebuilt.
update public.trades a
set trade_date = r.day, settle_date = null,
    note = 'Redeemed at maturity (the report''s "Погашение в уст. срок" payout of ' || r.day || '), holding brought to the report''s closing 0'
from (
  select user_id, split_part(external_id, ':', 1) as agr, split_part(external_id, ':', 4) as isin, max(trade_date) as day
  from public.trades
  where external_source = 'tbank_broker_xlsx' and side = 'repayment' and external_id like '%:income:%'
  group by 1, 2, 3
) r
where a.external_source = 'tbank_broker_xlsx'
  and a.external_id = r.agr || ':adjust:' || r.isin
  and a.user_id = r.user_id
  and a.side = 'sell' and a.price = 0
  and a.trade_date > r.day;

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
