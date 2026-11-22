-- TGLD (T-Capital's gold fund on MOEX, bought and sold on T-Bank's brokerage account in May-June 2026)
-- counts as gold everywhere (user's rule, 23.11.2026). update-market-prices classifies it as gold now,
-- but it prices only what's held, and TGLD isn't: its row here, at its last stored price, so the
-- capital history (refresh_capital_daily takes a ticker's instrument_type from market_prices -- it had
-- TGLD as a stock) and the reports see it as gold. Then a whole rebuild of the history.
insert into public.market_prices (ticker, price_usd, native_price, currency, asset_class, infra_region, instrument_type,
  underlying_currency, source, as_of, updated_at)
select 'TGLD', p.price_usd, null, 'RUB', 'gold', 'ru', 'gold', 'RUB', 'moex_iss', p.day, now()
from (select price_usd, day from public.price_history where ticker = 'TGLD' order by day desc limit 1) p
on conflict (ticker) do update set asset_class = 'gold', instrument_type = 'gold';

-- the whole history (a classification isn't a dated change the dirty marks of ...231 see)
update public.capital_refresh_queue set requested_at = now(), full_at = null;
