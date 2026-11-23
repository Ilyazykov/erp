-- The bank chart's series for the broker tables' Total too (23.11.2026): p_account '__all__' is every bank and
-- broker together, without real estate, a paper's value summed over the accounts holding it each day.
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
  from (
    select c.ticker, c.day, max(c.instrument_type) as instrument_type, max(c.currency) as currency, sum(c.value_usd) as value_usd
    from public.capital_daily c
    where c.user_id = auth.uid()
      and (c.account = p_account or (p_account = '__all__' and c.account <> 'real estate'))
    group by c.ticker, c.day
  ) d
  left join public.market_prices p on p.ticker = d.ticker
  group by d.ticker;
$$;

revoke all on function public.capital_account_series(text) from public, anon;
grant execute on function public.capital_account_series(text) to authenticated;
