-- import-tbank-broker took a deal's currency from the report's "Валюта цены",
-- which for a bond is '%' (its price is in % of face). No rate for '%': every
-- T-Bank bond buy / sale counted as 0 money, so the bond's whole value looked
-- earned -- yuan bonds +110% a year, rouble ones +35%. The importer now takes
-- the settlement currency then; the rows already stored get the bond's own
-- currency from market_prices (RUB, or CNY for a yuan bond), and the capital
-- history is rebuilt (it ends with "Invested vs earned").
update public.trades t
set currency = coalesce((select upper(mp.currency) from public.market_prices mp
                         where mp.ticker = t.ticker and mp.currency is not null and mp.currency <> '%'), 'RUB')
where t.currency = '%';

insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
