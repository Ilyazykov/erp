-- Each fund's split by the trading currency of what it holds (% of the
-- fund, summing to ~100) -- e.g. VWRA ~63% USD, then JPY, EUR, GBP, ...
-- The page splits a fund's value across the broker x currency table's
-- currency columns by these weights. The 'OTHER' line (cash, derivatives,
-- no ISIN) has currency 'Various'; the page books it in the fund's own
-- currency. Aggregated here because a fund's holdings run to thousands of
-- rows, past what one API read returns.

create view public.fund_currency_weights
with (security_invoker = true) as
select fh.fund, s.currency, sum(fh.weight) as weight
from public.fund_holdings fh
join public.securities s on s.id = fh.security_id
group by fh.fund, s.currency;
