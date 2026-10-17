-- How much of the investments was put in and how much they earned, per day
-- (the "Invested vs growth" chart, like Snowball's), worked out in the
-- database at the end of each capital rebuild (run_capital_refresh_step,
-- redefined) -- the site only loads the series.
--
-- value_usd: the day's value of what's invested -- every position of the
--   capital history (shares, bonds, funds, deposits, savings accounts, gold,
--   ЦФА) and everything on the crypto exchanges and wallets; money on cards,
--   cash, credit cards and real estate stay out.
-- invested_usd: what was put in, to that day, at each day's rate --
--   securities: buys less sells and redemptions (trades; a bond priced in %
--     of its nominal -- under 300 for a RUB / CNY bond -- at a nominal of
--     1 000; the commission is part of the cost, accrued interest left out --
--     importers give it per unit or per deal); a gift
--     of shares adds nothing;
--   deposits and savings accounts: top-ups less withdrawals (interest stays
--     out -- it is income);
--   crypto: money and coins brought onto the exchanges / into the wallets less
--     taken out (deposits, card purchases of coins, withdrawals, card
--     spending), each coin at its price that day.
-- income_usd: dividends, coupons, interest and exchange rewards, to that day.
--   Income that stays invested (interest capitalised, coins earned, a
--   dividend spent on a buy) is in invested_usd too.
-- What the investments earned = value - invested + income: price growth and
-- exchange rates, plus the income whether it was reinvested or left as cash.

create table public.investment_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  value_usd numeric not null,
  invested_usd numeric not null,
  income_usd numeric not null,
  primary key (user_id, day)
);
alter table public.investment_daily enable row level security;
create policy "own investment history" on public.investment_daily for select using (auth.uid() = user_id);

create or replace function public.refresh_investment_daily(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  crypto_accounts text[] := array(select distinct account from crypto_wallets where user_id = p_user);
begin
  delete from investment_daily where user_id = p_user;
  insert into investment_daily (user_id, day, value_usd, invested_usd, income_usd)
  with
  tr as (
    select t.trade_date as day, t.side, t.ticker, upper(coalesce(t.currency, 'RUB')) as ccy, t.quantity, t.price,
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

create or replace function public.run_capital_refresh_step() returns integer
language plpgsql security definer set search_path = public as $$
declare
  t0 timestamptz := clock_timestamp();
  q record;
  d date;
  done integer := 0;
begin
  for q in
    select * from capital_refresh_queue
    where next_from is not null or finished_at is null or finished_at < requested_at
    order by requested_at
  loop
    if q.next_from is null then
      perform match_internal_transfers(q.user_id);
      d := capital_first_day(q.user_id);
      update capital_refresh_queue
      set started_at = now(), next_from = d, rows_total = 0, finished_at = null
      where user_id = q.user_id;
    else
      d := q.next_from;
    end if;
    while d is not null and d <= current_date and clock_timestamp() - t0 < interval '40 seconds' loop
      update capital_refresh_queue
      set rows_total = rows_total + refresh_capital_daily(q.user_id, d, least(d + 29, current_date))
      where user_id = q.user_id;
      d := d + 30;
      done := done + 1;
    end loop;
    if d is null or d > current_date then
      perform refresh_capital_ever_held(q.user_id);
      perform refresh_investment_daily(q.user_id);
      update capital_refresh_queue
      set next_from = null, finished_at = now(),
          today_usd = (select round(capital_usd, 2) from capital_daily_total where user_id = q.user_id and day = current_date)
      where user_id = q.user_id;
    else
      update capital_refresh_queue set next_from = d where user_id = q.user_id;
    end if;
    exit when clock_timestamp() - t0 >= interval '40 seconds';
  end loop;
  return done;
end $$;
revoke all on function public.run_capital_refresh_step() from public, anon, authenticated;

select public.refresh_investment_daily(user_id) from (select distinct user_id from public.capital_daily) u;
