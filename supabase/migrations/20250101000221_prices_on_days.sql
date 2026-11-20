-- The prices of many tickers on a few days at once, for the portfolio map's
-- expanded funds (js/lookthrough_treemap.js): each fund constituent's
-- position is built from the fund's buys and sales, at the constituent's
-- price on each such day. One row per ticker, its prices in the order of
-- p_days, each the last one on or before that day (null: none yet) -- ~1 200
-- rows rather than one per ticker and day.
create or replace function public.prices_on(p_tickers text[], p_days date[])
returns table (ticker text, prices numeric[])
language sql stable
set search_path = public
as $$
  select t,
         array(select (select ph.price_usd from price_history ph
                       where ph.ticker = t and ph.day <= u.d order by ph.day desc limit 1)
               from unnest(p_days) with ordinality as u(d, i) order by u.i)
  from unnest(p_tickers) as t;
$$;

grant execute on function public.prices_on(text[], date[]) to authenticated;
