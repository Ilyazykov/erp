-- Alfa pays for investing ("До 10 000 рублей за инвестиции": 500, 600, ...
-- 1 600 a month; "Акция в подарок": a few roubles for a gifted share) onto
-- a current account, and each payout is moved on to the broker the same day
-- ("Выплата по поручению клиента ...") and spent on buys. Those buys counted
-- it as own money put in, so "Invested vs earned" had ~10 650 ₽ too much
-- invested and as much too little earned. The payouts are now income, the
-- way a reinvested dividend is. Alfa's loyalty-programme cashback stays out:
-- it's not for investing.

create or replace function public.refresh_investment_daily(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  crypto_accounts text[] := array(select distinct account from crypto_wallets where user_id = p_user);
begin
  perform match_card_crypto_purchases(p_user);
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
           coalesce(t.fee_tax, 0) as fee,
           -- accrued interest paid on a bond's buy / got on its sale: the reports
           -- give it for the deal, this project's CSVs and Snowball per bond
           coalesce(case when t.external_source in ('sber_broker_html', 'tbank_broker_xlsx') then t.nkd
                         else t.nkd * t.quantity end, 0) as nkd,
           coalesce(t.note, '') as note,
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
          + (case when side = 'buy' then 1 else -1 end) * nkd   -- the next coupon, paid in full, is not all earned
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
           t.chain in ('binance', 'bybit', 'cryptocom', 'telegram') as exchange,
           cp.paid, cp.currency as paid_ccy   -- bought by card: what was paid
    from wallet_transactions t
    left join card_crypto_purchases cp on cp.wallet_id = t.wallet_id and cp.tx_hash = t.tx_hash
      and cp.kind = t.kind and cp.seq = t.seq and cp.matched_by in ('auto', 'manual')
    where t.user_id = p_user and t.symbol is not null
  ),
  wal_money as (
    select day, sym, paid, paid_ccy,
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
           case when w.paid is not null and w.invested > 0
                then w.paid * coalesce(case when w.paid_ccy = 'USD' then 1 end, (select f.usd_per_unit from fx_history f where f.currency = w.paid_ccy and f.day <= w.day order by f.day desc limit 1), 0)
                else w.invested * coalesce(case when w.sym in ('USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD') then 1 end,
             (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1),
             (select fx.usd_per_unit from fx_history fx where fx.currency = w.sym and fx.day <= w.day order by fx.day desc limit 1), 0) end,
           w.income * coalesce(case when w.sym in ('USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP', 'USD') then 1 end,
             (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1),
             (select fx.usd_per_unit from fx_history fx where fx.currency = w.sym and fx.day <= w.day order by fx.day desc limit 1), 0)
    from wal_money w where w.invested <> 0 or w.income <> 0
    union all
    -- a bank's payout for investing (Alfa's "До 10 000 рублей за инвестиции",
    -- "Акция в подарок"): moved on to the broker the same day and spent on
    -- buys, which count it as put in -- it's earned, like a reinvested dividend
    select b.tx_date::date, 0,
           b.amount * coalesce(case when upper(b.currency) = 'USD' then 1 end,
             (select f.usd_per_unit from fx_history f where f.currency = upper(b.currency) and f.day <= b.tx_date::date order by f.day desc limit 1), 0)
    from bank_transactions b
    where b.user_id = p_user and b.account = 'Alfa' and b.amount > 0
      and b.description ~* '^Выплата в рамках .*Правилами проведения акции'
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
  -- what's owed on the credit cards that day (negative): money borrowed, much
  -- of it moved onto savings accounts -- off both the value and what was put
  -- in, so they're the own money, and the gap (what was earned) stays
  credit_debt as (
    select c.day, sum(c.value_usd) as debt
    from capital_daily c
    where c.user_id = p_user and c.instrument_type = 'credit'
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
         round((coalesce(v.value, 0) + coalesce(cd.debt, 0))::numeric, 2),
         round((sum(coalesce(f.invested, 0)) over (order by d.day) + coalesce(cd.debt, 0))::numeric, 2),
         round(sum(coalesce(f.income, 0)) over (order by d.day)::numeric, 2),
         round(((coalesce(v.value, 0) + coalesce(cd.debt, 0)) * coalesce(r.k, 0))::numeric, 2),
         round((sum(coalesce(f.invested, 0) * coalesce(r.k, 0)) over (order by d.day) + coalesce(cd.debt, 0) * coalesce(r.k, 0))::numeric, 2),
         round(sum(coalesce(f.income, 0) * coalesce(r.k, 0)) over (order by d.day)::numeric, 2)
  from days d
  left join val v on v.day = d.day
  left join flow_days f on f.day = d.day
  left join rub r on r.day = d.day
  left join credit_debt cd on cd.day = d.day
  where d.day is not null;
end $$;
revoke all on function public.refresh_investment_daily(uuid) from public, anon, authenticated;

select public.refresh_investment_daily(user_id) from (select distinct user_id from public.capital_daily) u;
