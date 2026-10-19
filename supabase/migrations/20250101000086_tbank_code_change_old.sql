-- A T-Bank report keeps a security whose ISIN changed under "<code>old" (Momo
-- -> Hello Group: MOMOold US60879B1070 -> MOMO US4234031049) and lists no
-- operation for the change. import-tbank-broker stored the two as separate
-- tickers and brought each to the report's closing 0 on its own, at the period
-- end (23.09.2026): a "sale" of the 2 MOMOold still held at price 0 and a
-- "purchase" of 2 MOMO at price 0 -- though both were sold on 28.02.2022 as
-- MOMO. From 2025-08-28 MOMOOLD showed -100%. The importer now drops the
-- "old" suffix and reconciles both ISINs as one holding; here the stored rows
-- follow: the pairs of zero-price reconciling rows that cancel out once on
-- one ticker are deleted, the "old" tickers renamed, the capital history
-- rebuilt.
delete from public.trades t
using (
  select user_id, regexp_replace(ticker, '([A-Z0-9])old$', '\1') as base, trade_date
  from public.trades
  where external_source = 'tbank_broker_xlsx' and external_id like '%:adjust:%' and price = 0
  group by 1, 2, 3
  having bool_or(ticker ~ '[A-Z0-9]old$')
     and sum(case side when 'buy' then quantity when 'sell' then -quantity else 0 end) = 0
) z
where t.external_source = 'tbank_broker_xlsx' and t.external_id like '%:adjust:%' and t.price = 0
  and t.user_id = z.user_id and t.trade_date = z.trade_date
  and regexp_replace(t.ticker, '([A-Z0-9])old$', '\1') = z.base;

update public.trades
set ticker = regexp_replace(ticker, '([A-Z0-9])old$', '\1')
where external_source = 'tbank_broker_xlsx' and ticker ~ '[A-Z0-9]old$';

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
