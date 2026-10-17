-- capital_ever_held (054) also gives the ticker: a crypto wallet's coin has no
-- currency in capital_daily (USDT in Telegram Wallet), and the broker x
-- currency table puts each holding in a column by its own rules (stablecoins
-- under USD, small coins under Altcoins, funds by what they hold) -- the site
-- applies the same rules to these rows.
create or replace view public.capital_ever_held
with (security_invoker = true) as
select distinct user_id, account, currency, instrument_type, ticker
from public.capital_daily
where abs(value_usd) >= 0.01;
