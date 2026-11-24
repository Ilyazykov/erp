-- sync-tbank stored a bond's last price as "% of face + accrued coupon" without
-- converting the % to money: 98.02 + 7.60 = 105.62 RUB for a bond worth 987.
-- The eight rows it wrote this way, at MOEX's close of the day (face x % + accrued;
-- a day without trading: the last trading day's), in the bond's own currency.
with fixed(ticker, day, price, currency) as (values
  ('RU000A105104', date '2026-11-10', 1023.26, 'CNY'),
  ('RU000A105104', date '2026-11-12', 1028.96, 'CNY'),
  ('RU000A105104', date '2026-11-21', 1029.07, 'CNY'),
  ('RU000A105104', date '2026-11-23', 1034.65, 'CNY'),
  ('RU000A1057D4', date '2026-11-13', 966.38, 'CNY'),
  ('RU000A1057D4', date '2026-11-21', 977.10, 'CNY'),
  ('RU000A1057D4', date '2026-11-23', 977.30, 'CNY'),
  ('RU000A10D3S6', date '2026-11-23', 987.30, 'RUB')
)
update public.price_history p
set price_usd = f.price * public.usd_per_unit_on(f.currency, f.day), source = 'moex_iss'
from fixed f
where p.ticker = f.ticker and p.day = f.day and p.source = 'tbank'
  and p.price_usd < 0.5 * f.price * public.usd_per_unit_on(f.currency, f.day);

-- capital recounted from the first of those days
update public.capital_refresh_queue
set dirty_from = least(coalesce(dirty_from, date '2026-11-10'), date '2026-11-10'), requested_at = now();
