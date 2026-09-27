-- Each fund's split by the GICS sector of the securities it holds (% of
-- the fund) -- for the page's "stocks by sector" chart, which splits a
-- fund's value across sectors by these weights. Securities with no sector
-- (cash, bonds, derivatives) are left out; the page scales the rest up to
-- the whole fund. Same shape and reason as fund_country_weights (029).

create view public.fund_sector_weights
with (security_invoker = true) as
select fh.fund, s.sector, sum(fh.weight) as weight
from public.fund_holdings fh
join public.securities s on s.id = fh.security_id
where s.sector is not null
group by fh.fund, s.sector;
