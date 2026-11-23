-- The daily USD price of the currencies and coins on a bank's chart, one row per code with its days (counted from
-- 2000-01-01) and prices as arrays (23.11.2026): loaded once when the window opens, so its hover can show an amount
-- in the currency itself at once, with no request per day. Both tables are public data.
create or replace function public.capital_unit_prices(p_currencies text[], p_tickers text[])
returns table (code text, is_fiat boolean, days integer[], prices numeric[])
language sql stable security invoker set search_path = public as $$
  select f.currency, true, array_agg(f.day - date '2000-01-01' order by f.day), array_agg(f.usd_per_unit order by f.day)
  from public.fx_history f where f.currency = any(p_currencies)
  group by f.currency
  union all
  select p.ticker, false, array_agg(p.day - date '2000-01-01' order by p.day), array_agg(p.price_usd order by p.day)
  from public.price_history p where p.ticker = any(p_tickers)
  group by p.ticker;
$$;

revoke all on function public.capital_unit_prices(text[], text[]) from public, anon;
grant execute on function public.capital_unit_prices(text[], text[]) to authenticated;
