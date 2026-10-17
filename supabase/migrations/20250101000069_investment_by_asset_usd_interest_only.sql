-- investment_by_asset (062-068): a dollar can't gain or lose against the
-- dollar, yet "USD" showed -$76: dollars spent in Telegram Wallet's exchanges,
-- whose amount the history doesn't give, were taken out at what the coins
-- bought were worth -- and GRAM had no price yet. Now USD earns only its
-- interest; the rest on an account goes to the coins those exchanges bought.
-- A network fee goes only to a coin with a price, not to a token without
-- one riding on the same transaction. And GG -- Golden Goose Vault (Lido /
-- Veda, 0xef417fce...): ETH deposited into it (0.01 ETH -> 0.00996 GG,
-- 19.09.2025), queued out 07.10.2025 -- is ETH like stETH / wstETH (it had no
-- price: -100%), here and in "Invested vs earned" (refresh_investment_daily).

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
           case when upper(t.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(t.symbol) end as sym,
           t.kind, t.amount as amt,
           t.chain in ('binance', 'bybit', 'cryptocom', 'telegram') as exchange
    from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = u and t.symbol is not null and t.tx_time::date > p_from and t.tx_time::date <= d1
  ),
  wal_money as (
    -- every movement of the coin's balance (as refresh_capital_daily sums it)
    -- is money in / out of that coin, but interest / rewards, which are earned
    select day, account, case when sym in (select s from stable) then 'USD' else sym end as asset, sym, kind,
      case
        when kind in ('interest', 'reward') then amt
        when exchange and kind not in ('transfer_internal', 'earn_internal', 'card_usd', 'staking_internal') then amt
        when not exchange and kind in ('native', 'token', 'internal', 'fee') then amt   -- a fee leaves the coin...
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

    union all
    -- ...and is a cost of what the transfer was for: the coin it moved, or --
    -- dollars moved (USDT over TRON to an exchange) -- the first coin bought on
    -- an exchange after it (BTC on Bybit three days later)
    select w.account, tg.asset,
           (-x.amount * coalesce((select p.price_usd from price_history p where p.ticker = upper(x.symbol)
                                  and p.day <= x.tx_time::date order by p.day desc limit 1), 0))::numeric,
           0::numeric
    from wallet_transactions x
    join crypto_wallets w on w.id = x.wallet_id
    cross join lateral (
      select (select case when upper(o.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(o.symbol) end
              from wallet_transactions o
              where o.wallet_id = x.wallet_id and o.tx_hash = x.tx_hash and o.kind in ('native', 'token', 'internal')
                and o.amount < 0 and o.symbol is not null
                -- a coin with a price: not a spam token riding on the same tx (GG)
                and (upper(o.symbol) in (select s from stable)
                     or exists (select 1 from price_history ph
                                where ph.ticker = case when upper(o.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(o.symbol) end))
              order by (o.kind = 'token') desc limit 1) as moved
    ) mv
    cross join lateral (
      select case
        when mv.moved is null then upper(x.symbol)
        when mv.moved in (select s from stable) then coalesce(
          (select case when upper(b.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(b.symbol) end
           from wallet_transactions b
           where b.user_id = u and b.chain in ('binance', 'bybit', 'cryptocom', 'telegram') and b.kind = 'trade'
             and b.amount > 0 and upper(b.symbol) not in (select s from stable) and b.tx_time >= x.tx_time
           order by b.tx_time limit 1),
          'USD')
        else mv.moved
      end as asset
    ) tg
    where x.user_id = u and x.kind = 'fee' and x.amount <> 0
      and x.tx_time::date > p_from and x.tx_time::date <= d1
    union all
    -- Telegram Wallet doesn't say how many dollars an exchange took
    -- ('trade_out_unknown', amount 0): as many as the coins it bought were worth
    select w.account, 'USD',
           -sum(b.amount * coalesce((select p.price_usd from price_history p
                                     where p.ticker = case when upper(b.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(b.symbol) end
                                       and p.day <= b.tx_time::date order by p.day desc limit 1), 0))::numeric,
           0::numeric
    from wallet_transactions x
    join crypto_wallets w on w.id = x.wallet_id
    join wallet_transactions b on b.wallet_id = x.wallet_id and b.tx_hash = x.tx_hash and b.kind = 'trade' and b.amount > 0
    where x.user_id = u and x.kind = 'trade_out_unknown' and upper(x.symbol) in (select s from stable)
      and x.tx_time::date > p_from and x.tx_time::date <= d1
    group by w.account
  ),
  val as (
    select c.account,
           case
             when c.account = any(crypto_accounts) and (upper(c.ticker) in (select s from stable) or c.ticker ~* '^SAVINGS:') then 'USD'
             when upper(c.ticker) in ('STETH', 'WSTETH', 'GG') then 'ETH'
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
  per0 as (
    select coalesce(v.asset, f.asset) as asset, coalesce(v.account, f.account) as account,
           coalesce(v.v0, 0) as v0, coalesce(v.v1, 0) as v1,
           coalesce(f.put_in, 0) as put_in, coalesce(f.taken_out, 0) as taken_out, coalesce(f.income, 0) as income
    from val v
    full join (select account, asset, sum(greatest(own, 0)) as put_in, sum(greatest(-own, 0)) as taken_out, sum(income) as income
               from flows group by 1, 2) f on f.account = v.account and f.asset = v.asset
  ),
  -- Dollars earn only their interest. What else they seem to have lost or
  -- gained on an account is dollars spent where the history doesn't say how
  -- many (Telegram Wallet's exchanges, 'trade_out_unknown'): it goes to the
  -- coins those exchanges bought, by what each was worth (equally if none
  -- has a price yet).
  usd_rest as (
    select account, sum(v1 - v0 - put_in + taken_out) - sum(income) as rest
    from per0 where asset = 'USD' group by account
  ),
  unk as (
    select w.account,
           case when upper(b.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(b.symbol) end as asset,
           sum(b.amount * coalesce((select p.price_usd from price_history p where p.ticker = upper(b.symbol)
                                    and p.day <= b.tx_time::date order by p.day desc limit 1), 0)) as worth,
           count(*) as n
    from wallet_transactions x
    join crypto_wallets w on w.id = x.wallet_id
    join wallet_transactions b on b.wallet_id = x.wallet_id and b.tx_hash = x.tx_hash and b.kind = 'trade' and b.amount > 0
    where x.user_id = u and x.kind = 'trade_out_unknown' and upper(x.symbol) in (select s from stable)
      and x.tx_time::date > p_from and x.tx_time::date <= d1
    group by 1, 2
  ),
  alloc as (
    select k.account, k.asset,
           -r.rest * case when sum(k.worth) over (partition by k.account) > 0
                          then k.worth / sum(k.worth) over (partition by k.account)
                          else k.n::numeric / sum(k.n) over (partition by k.account) end as spent
    from unk k join usd_rest r on r.account = k.account
    where abs(r.rest) >= 0.005
  ),
  per as (
    select * from per0
    union all
    select a.asset, a.account, 0, 0, greatest(a.spent, 0), greatest(-a.spent, 0), 0 from alloc a
    union all
    select 'USD', a.account, 0, 0, greatest(-a.spent, 0), greatest(a.spent, 0), 0 from alloc a
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
