-- One account's daily history per paper, as arrays: one row a paper instead of one a day (T-Bank has
-- 78 000 daily rows), for the bank's chart window, which splits it by currency. Days are counted from
-- 2000-01-01. Runs as the caller, so RLS on capital_daily applies.
create or replace function public.capital_account_series(p_account text)
returns table (ticker text, instrument_type text, currency text, asset_class text, underlying_currency text,
               days integer[], amounts numeric[])
language sql stable security invoker set search_path = public as $$
  select d.ticker,
         max(d.instrument_type),
         max(d.currency),
         coalesce(max(p.asset_class), max(d.instrument_type)),
         max(p.underlying_currency),
         array_agg(d.day - date '2000-01-01' order by d.day),
         array_agg(round(d.value_usd, 2) order by d.day)
  from public.capital_daily d
  left join public.market_prices p on p.ticker = d.ticker
  where d.user_id = auth.uid() and d.account = p_account
  group by d.ticker;
$$;

revoke all on function public.capital_account_series(text) from public, anon;
grant execute on function public.capital_account_series(text) to authenticated;
