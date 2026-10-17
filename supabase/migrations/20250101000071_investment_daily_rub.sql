-- "Invested vs earned" in roubles: the page turned each day's dollars into
-- roubles at that day's rate -- the value right, but "invested" was every
-- dollar ever put in at today's rate, so a rouble put in years ago at 60 to
-- the dollar counted at 85 and the rouble's fall looked like a loss. Now the
-- money is kept in roubles too, each put-in / paid-out at its own day's rate.
alter table public.investment_daily
  add column if not exists value_rub numeric not null default 0,
  add column if not exists invested_rub numeric not null default 0,
  add column if not exists income_rub numeric not null default 0;

create or replace function public.refresh_investment_daily(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  crypto_accounts text[] := array(select distinct account from crypto_wallets where user_id = p_user);
begin
  delete from investment_daily where user_id = p_user;
  insert into investment_daily (user_id, day, value_usd, invested_usd, income_usd, value_rub, invested_rub, income_rub)
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
          * quantity * (case when (asset_class in ('bond', 'moex_bond', 'moex_ofz') or ticker ~ '^(SU|RU)\d')
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
    select t.tx_time::date as day,
           case when upper(t.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(t.symbol) end as sym,   -- no price history of their own
           case when t.chain = 'cryptocom' and t.kind = 'trade' and t.status ~ '^(trading\.)?crypto_purchase'
                then 'purchase' else t.kind end as kind,   -- "Bought BTC" by card: one leg, the coins only
           t.amount as amt,
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
  ),
  -- roubles per dollar that day: each day's money in roubles at its own rate
  rub as (
    select d.day, 1 / (select f.usd_per_unit from fx_history f where f.currency = 'RUB' and f.day <= d.day
                       order by f.day desc limit 1) as k
    from days d where d.day is not null
  )
  select p_user, d.day,
         round(coalesce(v.value, 0)::numeric, 2),
         round(sum(coalesce(f.invested, 0)) over (order by d.day)::numeric, 2),
         round(sum(coalesce(f.income, 0)) over (order by d.day)::numeric, 2),
         round((coalesce(v.value, 0) * coalesce(r.k, 0))::numeric, 2),
         round(sum(coalesce(f.invested, 0) * coalesce(r.k, 0)) over (order by d.day)::numeric, 2),
         round(sum(coalesce(f.income, 0) * coalesce(r.k, 0)) over (order by d.day)::numeric, 2)
  from days d
  left join val v on v.day = d.day
  left join flow_days f on f.day = d.day
  left join rub r on r.day = d.day
  where d.day is not null;
end $$;
revoke all on function public.refresh_investment_daily(uuid) from public, anon, authenticated;

select public.refresh_investment_daily(user_id) from (select distinct user_id from public.capital_daily) u;
