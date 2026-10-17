-- refresh_investment_daily (058) dated a trade by the day it was made, the
-- capital history by the day it settled (refresh_capital_daily: settle_date,
-- or for a savings / deposit move paired with a bank row the day the first of
-- the two moved -- 056). A MOEX buy of 29.12.2021 settled after the New Year
-- holidays, on 10.01.2022: "invested" rose twelve days before the value did.
-- Now both go by the same day.

create or replace function public.refresh_investment_daily(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  crypto_accounts text[] := array(select distinct account from crypto_wallets where user_id = p_user);
begin
  delete from investment_daily where user_id = p_user;
  insert into investment_daily (user_id, day, value_usd, invested_usd, income_usd)
  with
  tr as (
    select least(coalesce(t.settle_date, t.trade_date),
                 coalesce((select min(least(x.out_at, x.in_at))::date from internal_transfers x
                           where x.user_id = p_user and x.matched_by in ('auto', 'manual')
                             and ((x.out_source = t.external_source and x.out_id = t.external_id)
                               or (x.in_source = t.external_source and x.in_id = t.external_id))),
                          'infinity'::date)) as day,
           t.side, t.ticker, upper(coalesce(t.currency, 'RUB')) as ccy, t.quantity, t.price,
           coalesce(t.fee_tax, 0) as fee, coalesce(t.note, '') as note,
           mp.asset_class, mp.instrument_type
    from trades t left join market_prices mp on mp.ticker = t.ticker
    where t.user_id = p_user
      and not (t.ticker ~* '^SAVINGS:' and t.account = any(crypto_accounts))   -- an exchange's Earn: coins still there
  ),
  tr_money as (
    select day, ccy,
      case
        when side = 'dividend' then 0
        when ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' then
          -- interest credited is income and stays in like a reinvested dividend (so it's
          -- in both, as a dividend spent on a buy is); anything taken out leaves
          case when side = 'buy' then quantity * price when side = 'sell' then -quantity * price else 0 end
        when side in ('repayment', 'amortisation') then -quantity
        when side in ('buy', 'sell') then
          (case when side = 'buy' then 1 else -1 end)
          * quantity * (case when (asset_class = 'bond' or instrument_type = 'bond' or ticker ~ '^(SU|RU)\d')
                                   and price < 300 and ccy in ('RUB', 'CNY') then price * 10 else price end)
          + fee   -- commission: part of a buy's cost, taken off a sale's proceeds
        else 0
      end as invested,
      case
        when side = 'dividend' then quantity
        when ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' and side = 'buy' and note ~* 'interest|процент|капитализац' then quantity * price
        else 0
      end as income
    from tr
  ),
  wal as (
    select t.tx_time::date as day, upper(t.symbol) as sym, t.kind,
           case when t.decimals is not null and t.chain in ('ethereum', 'tron', 'bitcoin', 'solana')
                then t.amount / power(10::numeric, t.decimals) else t.amount end as amt,
           t.chain in ('binance', 'bybit', 'cryptocom', 'telegram') as exchange
    from wallet_transactions t
    where t.user_id = p_user and t.symbol is not null
  ),
  wal_money as (
    select day, sym,
      case
        when exchange and kind in ('deposit', 'withdrawal', 'purchase', 'card', 'card_usd', 'interest', 'reward') then amt
        when not exchange and kind in ('native', 'token', 'internal') then amt   -- on-chain: in and out of the wallet
        else 0
      end as invested,
      case when kind in ('interest', 'reward') then amt else 0 end as income
    from wal
  ),
  flows as (
    select m.day,
           m.invested * coalesce(case when m.ccy = 'USD' then 1 end,
             (select f.usd_per_unit from fx_history f where f.currency = m.ccy and f.day <= m.day order by f.day desc limit 1), 0) as invested,
           m.income * coalesce(case when m.ccy = 'USD' then 1 end,
             (select f.usd_per_unit from fx_history f where f.currency = m.ccy and f.day <= m.day order by f.day desc limit 1), 0) as income
    from tr_money m where m.invested <> 0 or m.income <> 0
    union all
    select w.day,
           w.invested * coalesce(case when w.sym in ('USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD') then 1 end,
             (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1), 0),
           w.income * coalesce(case when w.sym in ('USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD') then 1 end,
             (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1), 0)
    from wal_money w where w.invested <> 0 or w.income <> 0
  ),
  flow_days as (
    select day, sum(invested) as invested, sum(income) as income from flows group by day
  ),
  val as (
    select c.day, sum(c.value_usd) as value
    from capital_daily c
    where c.user_id = p_user
      and (c.account = any(crypto_accounts)
           or (c.ticker !~ '^(CASH|REAL_ESTATE):' and coalesce(c.instrument_type, '') not in ('cash', 'credit', 'real_estate')))
    group by c.day
  ),
  days as (
    select generate_series(least((select min(day) from flow_days), (select min(day) from val)), current_date, interval '1 day')::date as day
  )
  select p_user, d.day,
         round(coalesce(v.value, 0)::numeric, 2),
         round(sum(coalesce(f.invested, 0)) over (order by d.day)::numeric, 2),
         round(sum(coalesce(f.income, 0)) over (order by d.day)::numeric, 2)
  from days d
  left join val v on v.day = d.day
  left join flow_days f on f.day = d.day
  where d.day is not null;
end $$;
revoke all on function public.refresh_investment_daily(uuid) from public, anon, authenticated;

select public.refresh_investment_daily(user_id) from (select distinct user_id from public.capital_daily) u;
