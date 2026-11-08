-- investment_by_asset took a dividend / coupon out of the capital at work (own = invested - income,
-- so a dividend is -income there), which shrank the base of the percentage: bought at 100, price
-- 100 -> 150 -> 100, a dividend of 50 on the 4th of 5 days and 150 at the end earned 100 on a base
-- averaging 87.5 -- 114%, where the same 100 on a stock that simply went 100 -> 200 is 100%. With the
-- dividend put into another buy (6 days, 200 at the end) it was 111%.
--
-- A dividend and a coupon are earned, not an outside flow (GIPS / Modified Dietz): the payout lies in
-- the account as idle cash, and idle cash is still part of the capital. So:
--  * a dividend does not shrink the capital at work;
--  * a buy first spends that cash -- per account and currency, dividends of this period not yet
--    spent -- and the part it covers is not new money: reinvesting is a move inside the capital.
--    Only the rest of the buy adds to it. (Just dropping the dividend from the base, and nothing
--    else, counted the reinvestment as fresh pocket money: 90.9% in the second case.)
-- Sales, repayments, amortisations still take money out; interest on savings / deposits and crypto
-- rewards stay as they were (own = 0, they are in the position already).
--
-- Only the capital at work (fd) changes. put_in / taken_out / income / earned and `cash` (the page's
-- XIRR) are NOT touched: a dividend is still taken_out and the reinvesting buy is still put_in, so
-- earned = v1 - v0 - put_in + taken_out keeps its value (100 in both cases), the money-weighted
-- return keeps the dividend as money coming back, and the table's columns add up as before. Netting
-- the spent part out of both columns would give the same earned but would have to be paired per
-- account across assets, and would hide real cash movements.
--
-- The pool starts empty at p_from (the position's value at the start has no cash in it), is paid
-- by the recorded dividend (whatever tax is withheld is already in or out of that amount, the
-- trades do not say) and is spent in the order of the days; a buy on the day of a dividend spends
-- it. Drained and filled again it works the same: the spent part is a running minimum, below.
-- A bond's coupon is a dividend row; its amortisation / redemption is principal, a repayment out of
-- the capital, and never goes to the pool. A buy's fee and accrued interest (NKD) are part of the
-- outlay the pool covers, as they are part of invested.
--
-- Known limits:
--  * A dividend spent on ANOTHER asset of the same account is allowed to be spent, but it stays in
--    the capital of the paper that paid it, and the paper bought has that much less money in its
--    base (its % is a bit high, the payer's a bit low). An explicit transfer between the two would
--    need the pool by paying asset; not done.
--  * A dividend taken out of the account (to a bank) is not seen in the trades: it stays idle
--    cash in the capital till the period end, and a later buy may spend it. Dividends spent on
--    something outside the trades (a bank card) are the same.
--
-- investment_by_asset patched in place: the rest stays as it is.
do $$
declare
  d text := pg_get_functiondef('public.investment_by_asset(date,date,text)'::regprocedure);
  n text;
begin
  n := replace(d,
    'fd as (select asset, day, sum(own) as own from flows group by 1, 2),',
    E'-- the dividends and what a buy takes of them, per account and currency, in the trade''s own money\n'
 || E'  pool_ev as (\n'
 || E'    select day, account, ccy, asset,\n'
 || E'           sum(case when invested = 0 and income > 0 then income else 0 end) as paid,   -- savings interest has both\n'
 || E'           sum(case when income = 0 and invested > 0 then invested else 0 end) as bought\n'
 || E'    from tr_money group by 1, 2, 3, 4\n'
 || E'  ),\n'
 || E'  pool_cum as (\n'
 || E'    select *,\n'
 || E'           sum(paid) over (partition by account, ccy order by day) as paid_cum,   -- the whole day\n'
 || E'           sum(bought) over (partition by account, ccy order by day, asset rows unbounded preceding) as bought_cum\n'
 || E'    from pool_ev\n'
 || E'  ),\n'
 || E'  -- spent so far = min(bought so far, the least over the past of paid + bought since): never more than\n'
 || E'  -- was in the pool at that buy, and what was spent before is not spent twice\n'
 || E'  pool_spent as (\n'
 || E'    select *, bought_cum + least(0, min(paid_cum - bought_cum) over (partition by account, ccy\n'
 || E'                                  order by day, asset rows unbounded preceding)) as spent_cum\n'
 || E'    from pool_cum\n'
 || E'  ),\n'
 || E'  pool_draw as (\n'
 || E'    select *, spent_cum - coalesce(lag(spent_cum) over (partition by account, ccy order by day, asset), 0) as spent\n'
 || E'    from pool_spent\n'
 || E'  ),\n'
 || E'  -- the change of the capital at work against own: a dividend does not leave it, the part of a buy\n'
 || E'  -- paid from the pool does not enter it\n'
 || E'  cap_adj as (\n'
 || E'    select p.asset, p.day,\n'
 || E'           ((p.paid - p.spent) * r.rate * k.k)::numeric as own\n'
 || E'    from pool_draw p\n'
 || E'    cross join lateral (select coalesce(case when p.ccy = ''USD'' then 1 end,\n'
 || E'      (select f.usd_per_unit from fx_history f where f.currency = p.ccy and f.day <= p.day order by f.day desc limit 1), 0) as rate) r\n'
 || E'    join kx k on k.day = p.day\n'
 || E'  ),\n'
 || E'  fd as (select asset, day, sum(own) as own from (select asset, day, own from flows union all select asset, day, own from cap_adj) z group by 1, 2),');
  if n = d then raise exception 'investment_by_asset: fd not where expected'; end if;
  execute n;
end $$;
