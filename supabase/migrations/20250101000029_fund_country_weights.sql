-- Each fund's split by the country (of risk) of the securities it holds
-- (% of the fund) -- for the page's "stocks by country" chart, which
-- splits a fund's value across countries by these weights. The fund's
-- 'OTHER' line (cash, derivatives -- no country) is left out; the page
-- scales the rest up to the whole fund. Aggregated here for the same
-- reason as fund_currency_weights (028): thousands of rows per fund.

create view public.fund_country_weights
with (security_invoker = true) as
select fh.fund, s.country, s.country_code, sum(fh.weight) as weight
from public.fund_holdings fh
join public.securities s on s.id = fh.security_id
where s.id <> 'OTHER'
group by fh.fund, s.country, s.country_code;
