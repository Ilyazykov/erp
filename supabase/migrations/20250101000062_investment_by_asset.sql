-- What each asset earned over a period -- the "Invested vs earned" tab's
-- per-asset bars (like Snowball's "Прибыльность активов"). Same perimeter and
-- money as refresh_investment_daily (058-061), split by asset:
--   earned = value at p_to - value at p_from - own money put in between
--            (buys less sells / redemptions, top-ups less withdrawals; a
--            dividend, coupon or interest is earned, not put in)
--   pct    = earned / (value at p_from + what was put in)
-- An asset is its ticker, across accounts (VWCE at Freedom24 and Revolut is
-- one). Crypto goes coin by coin: a trade on an exchange moves money from one
-- coin to another, so its legs count as put in / taken out of each (their
-- small difference, the exchange's spread, makes the coins' sum differ from
-- the chart's by that much); stablecoins and an exchange's USD Earn are one
-- asset, "USD stablecoins"; stETH / wstETH are ETH.
create or replace function public.investment_by_asset(p_from date, p_to date)
returns table (asset text, accounts text, value_start numeric, value_end numeric,
               put_in numeric, taken_out numeric, income numeric, earned numeric, pct numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  u uuid := auth.uid();
  crypto_accounts text[];
  d1 date;
begin
  if u is null then return; end if;
  crypto_accounts := array(select distinct account from crypto_wallets where user_id = u);
  d1 := least(p_to, (select max(day) from capital_daily where user_id = u));
  return query
  with
  stable as (select unnest(array['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD']) as s),
  tr as (
    select least(coalesce(t.settle_date, t.trade_date),
                 coalesce((select min(least(x.out_at, x.in_at))::date from internal_transfers x
                           where x.user_id = u and x.matched_by in ('auto', 'manual')
                             and ((x.out_source = t.external_source and x.out_id = t.external_id)
                               or (x.in_source = t.external_source and x.in_id = t.external_id))),
                          'infinity'::date)) as day,
           t.account, t.side, upper(t.ticker) as ticker, upper(coalesce(t.currency, 'RUB')) as ccy, t.quantity, t.price,
           coalesce(t.fee_tax, 0) as fee, coalesce(t.note, '') as note, mp.asset_class
    from trades t left join market_prices mp on mp.ticker = t.ticker
    where t.user_id = u
      and not (t.ticker ~* '^SAVINGS:' and t.account = any(crypto_accounts))
  ),
  tr_money as (
    select day, account, ticker as asset, ccy,
      case
        when side = 'dividend' then 0
        when ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' then
          case when side = 'buy' then quantity * price when side = 'sell' then -quantity * price else 0 end
        when side in ('repayment', 'amortisation') then -quantity
        when side in ('buy', 'sell') then
          (case when side = 'buy' then 1 else -1 end)
          * quantity * (case when (asset_class in ('bond', 'moex_bond', 'moex_ofz') or ticker ~ '^(SU|RU)\d')
                                   and price < 300 and ccy in ('RUB', 'CNY') then price * 10 else price end)
          + fee
        else 0
      end as invested,
      case
        when side = 'dividend' then quantity
        when ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' and side = 'buy' and note ~* 'interest|процент|капитализац' then quantity * price
        else 0
      end as income
    from tr
    where day > p_from and day <= d1
  ),
  wal as (
    select t.tx_time::date as day, w.account,
           case when upper(t.symbol) in ('STETH', 'WSTETH') then 'ETH' else upper(t.symbol) end as sym,
           t.kind, t.amount as amt,
           t.chain in ('binance', 'bybit', 'cryptocom', 'telegram') as exchange
    from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = u and t.symbol is not null and t.tx_time::date > p_from and t.tx_time::date <= d1
  ),
  wal_money as (
    -- every movement of the coin's balance (as refresh_capital_daily sums it)
    -- is money in / out of that coin, but interest / rewards, which are earned
    select day, account, case when sym in (select s from stable) then 'USD stablecoins' else sym end as asset, sym,
      case
        when kind in ('interest', 'reward') then amt
        when exchange and kind not in ('transfer_internal', 'earn_internal', 'card_usd', 'staking_internal') then amt
        when not exchange and kind in ('native', 'token', 'internal') then amt
        else 0
      end as invested,
      case when kind in ('interest', 'reward') then amt else 0 end as income
    from wal
  ),
  flows as (
    select m.account, m.asset,
           ((m.invested - m.income) * r.rate)::numeric as own, (m.income * r.rate)::numeric as income
    from tr_money m
    cross join lateral (select coalesce(case when m.ccy = 'USD' then 1 end,
      (select f.usd_per_unit from fx_history f where f.currency = m.ccy and f.day <= m.day order by f.day desc limit 1), 0) as rate) r
    where m.invested <> 0 or m.income <> 0
    union all
    select w.account, w.asset,
           ((w.invested - w.income) * r.rate)::numeric, (w.income * r.rate)::numeric
    from wal_money w
    cross join lateral (select coalesce(case when w.sym in (select s from stable) then 1 end,
      (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1), 0) as rate) r
    where w.invested <> 0 or w.income <> 0
  ),
  val as (
    select c.account,
           case
             when c.account = any(crypto_accounts) and (upper(c.ticker) in (select s from stable) or c.ticker ~* '^SAVINGS:') then 'USD stablecoins'
             when upper(c.ticker) in ('STETH', 'WSTETH') then 'ETH'
             else upper(c.ticker)
           end as asset,
           sum(case when c.day = p_from then c.value_usd else 0 end)::numeric as v0,
           sum(case when c.day = d1 then c.value_usd else 0 end)::numeric as v1
    from capital_daily c
    where c.user_id = u and c.day in (p_from, d1)
      and (c.account = any(crypto_accounts)
           or (c.ticker !~ '^(CASH|REAL_ESTATE):' and coalesce(c.instrument_type, '') not in ('cash', 'credit', 'real_estate')))
    group by 1, 2
  ),
  per as (
    select coalesce(v.asset, f.asset) as asset, coalesce(v.account, f.account) as account,
           coalesce(v.v0, 0) as v0, coalesce(v.v1, 0) as v1,
           coalesce(f.put_in, 0) as put_in, coalesce(f.taken_out, 0) as taken_out, coalesce(f.income, 0) as income
    from val v
    full join (select account, asset, sum(greatest(own, 0)) as put_in, sum(greatest(-own, 0)) as taken_out, sum(income) as income
               from flows group by 1, 2) f on f.account = v.account and f.asset = v.asset
  )
  select p.asset, string_agg(distinct p.account, ', ' order by p.account),
         round(sum(p.v0), 2), round(sum(p.v1), 2), round(sum(p.put_in), 2), round(sum(p.taken_out), 2), round(sum(p.income), 2),
         round(sum(p.v1 - p.v0 - p.put_in + p.taken_out), 2),
         case when sum(p.v0 + p.put_in) > 0
              then round(sum(p.v1 - p.v0 - p.put_in + p.taken_out) / sum(p.v0 + p.put_in) * 100, 2) end
  from per p
  group by p.asset
  having abs(sum(p.v1 - p.v0 - p.put_in + p.taken_out)) >= 0.5 or sum(p.v1) >= 0.5;
end $$;
revoke all on function public.investment_by_asset(date, date) from public, anon;
grant execute on function public.investment_by_asset(date, date) to authenticated;
