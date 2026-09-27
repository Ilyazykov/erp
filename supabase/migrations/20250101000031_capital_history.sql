-- Capital history: what the portfolio was worth on every day since the
-- first transaction.
--
--   price_history / fx_history: daily closing prices (USD) of every ticker
--     ever held and USD rates of every currency, filled by the
--     update-capital-history function (public data, read by everyone,
--     written with the service role -- same pattern as market_prices).
--   price_sources: where each ticker's history comes from (the function's
--     own cache of how it resolved it).
--   capital_daily: per user, day and position -- account x ticker (a bank
--     balance: its currency as the ticker, instrument_type 'cash' /
--     'credit') -- the value in USD. Recomputed by refresh_capital_daily();
--     kept per position so breakdowns (by currency / broker / asset type)
--     come later without recomputing.
--
-- Holdings on a day: trades up to that day (the same sides as
-- current_holdings), bank balances as of that day (the last row's
-- balance_after), crypto wallets' current balances less what moved after
-- that day, real estate by the city index month (account 'real estate').
-- Prices: the last close on or before the day (weekends, holidays).

create table public.price_history (
  ticker text not null,
  day date not null,
  price_usd numeric not null,
  primary key (ticker, day)
);
alter table public.price_history enable row level security;
create policy "anyone can read price history" on public.price_history for select using (true);

create table public.fx_history (
  currency text not null,
  day date not null,
  usd_per_unit numeric not null,
  primary key (currency, day)
);
alter table public.fx_history enable row level security;
create policy "anyone can read fx history" on public.fx_history for select using (true);

create table public.price_sources (
  ticker text primary key,
  source text not null,       -- 'yahoo' | 'moex_shares' | 'moex_bonds' | 'currency' | 'constant' | 'none'
  symbol text,                -- Yahoo symbol / MOEX secid / the currency
  currency text,              -- quote currency of `symbol`
  updated_at timestamptz not null default now()
);
alter table public.price_sources enable row level security;
create policy "anyone can read price sources" on public.price_sources for select using (true);

create table public.capital_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  account text not null,
  ticker text not null,
  instrument_type text,
  currency text,
  value_usd numeric not null,
  primary key (user_id, day, account, ticker)
);
alter table public.capital_daily enable row level security;
create policy "own capital history" on public.capital_daily for select using (auth.uid() = user_id);

-- Per day: the total without real estate, and real estate apart.
create view public.capital_daily_total
with (security_invoker = true) as
select user_id, day,
       sum(value_usd) filter (where account <> 'real estate') as capital_usd,
       coalesce(sum(value_usd) filter (where account = 'real estate'), 0) as real_estate_usd
from public.capital_daily
group by user_id, day;

-- The last value on or before a day.
create or replace function public.price_on(p_ticker text, p_day date) returns numeric
language sql stable as $$
  select price_usd from public.price_history where ticker = p_ticker and day <= p_day order by day desc limit 1
$$;
create or replace function public.fx_on(p_currency text, p_day date) returns numeric
language sql stable as $$
  select case when upper(p_currency) = 'USD' then 1 else
    (select usd_per_unit from public.fx_history where currency = upper(p_currency) and day <= p_day order by day desc limit 1) end
$$;

-- Currencies the function needs FX history for (bank statements run to
-- tens of thousands of rows -- past one API read).
create or replace function public.distinct_bank_currencies() returns table (currency text)
language sql stable security definer set search_path = public as $$
  select distinct upper(currency) from bank_transactions where currency is not null
$$;
revoke all on function public.distinct_bank_currencies() from public, anon, authenticated;

-- Rebuilds one user's capital_daily from their first transaction to today.
create or replace function public.refresh_capital_daily(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  first_day date;
  n integer;
begin
  select least(
    (select min(trade_date) from trades where user_id = p_user),
    (select min(tx_date)::date from bank_transactions where user_id = p_user),
    (select min(tx_time)::date from wallet_transactions where user_id = p_user)
  ) into first_day;
  delete from capital_daily where user_id = p_user;
  if first_day is null then return 0; end if;

  insert into capital_daily (user_id, day, account, ticker, instrument_type, currency, value_usd)
  with days as (select generate_series(first_day, current_date, interval '1 day')::date as day),
  -- trades: quantity held at the end of each day
  tr as (
    select coalesce(t.account, '(unspecified)') as account, t.ticker, t.trade_date,
           max(t.currency) as currency,
           sum(case when t.side in ('buy', 'stock_as_dividend') then t.quantity
                    when t.side = 'sell' then -t.quantity else 0 end) as dq
    from trades t
    where t.user_id = p_user
      and not exists (select 1 from holding_exclusions e
        where e.user_id = t.user_id and e.external_source = t.external_source and e.external_id = t.external_id)
    group by 1, 2, 3
  ),
  keys as (select account, ticker, max(currency) as currency, min(trade_date) as since from tr group by 1, 2),
  held as (
    select k.account, k.ticker, k.currency, d.day,
           sum(coalesce(tr.dq, 0)) over (partition by k.account, k.ticker order by d.day) as qty
    from keys k
    join days d on d.day >= k.since
    left join tr on tr.account = k.account and tr.ticker = k.ticker and tr.trade_date = d.day
  ),
  trade_values as (
    select h.account, h.ticker, h.day, h.qty, h.currency,
      coalesce(mp.instrument_type,
        case when h.ticker ~* '^(DEPOSIT|ВКЛАД):' then 'deposit' when h.ticker ~* '^SAVINGS:' then 'liquid' else 'stock' end) as instrument_type,
      -- deposits, savings and money-market funds are 1 unit of their currency
      case
        when h.ticker ~* '^BLOCKED:' or mp.asset_class = 'blocked' then 0
        when h.ticker ~* '^(DEPOSIT|ВКЛАД|SAVINGS):' or mp.asset_class in ('deposit', 'savings_account', 'money_market_fund')
          then fx_on(coalesce(mp.currency, h.currency, 'RUB'), h.day)
        else price_on(h.ticker, h.day)
      end as price
    from held h
    left join market_prices mp on mp.ticker = h.ticker
    where abs(h.qty) > 1e-12
  ),
  -- bank balances: the day's last balance_after per account / currency / source
  bank_rows as (
    select account, currency, external_source, product,
           coalesce(booked_at, tx_date)::date as day, balance_after,
           row_number() over (partition by account, currency, external_source, coalesce(booked_at, tx_date)::date
                              order by coalesce(booked_at, tx_date) desc, tx_date desc) as rn
    from bank_transactions
    where user_id = p_user and balance_after is not null
      and currency not in ('XAU', 'XAG', 'XPT', 'XPD')
  ),
  bank_keys as (select account, currency, external_source, max(product) as product, min(day) as since
                from bank_rows where rn = 1 group by 1, 2, 3),
  bank_days as (
    select k.account, k.currency, k.external_source, k.product, d.day,
           count(b.balance_after) over w as grp, b.balance_after
    from bank_keys k
    join days d on d.day >= k.since
    left join bank_rows b on b.rn = 1 and b.account = k.account and b.currency = k.currency
      and b.external_source = k.external_source and b.day = d.day
    window w as (partition by k.account, k.currency, k.external_source order by d.day)
  ),
  bank_values as (
    select account, currency, product, day,
           sum(bal) as balance
    from (
      select account, currency, external_source, product, day,
             first_value(balance_after) over (partition by account, currency, external_source, grp order by day) as bal
      from bank_days
    ) x
    group by account, currency, product, day
  ),
  -- crypto wallets: today's balance less what moved after the day
  wal_now as (
    select wb.wallet_id, wb.account, wb.ticker, upper(coalesce(wb.symbol, wb.ticker)) as sym, sum(wb.quantity) as qty
    from wallet_balances wb where wb.user_id = p_user and wb.ticker is not null
    group by 1, 2, 3, 4
  ),
  wal_moves as (
    select wt.wallet_id, upper(wt.symbol) as sym, wt.tx_time::date as day,
           sum(case when wt.decimals is not null and wt.chain in ('ethereum', 'tron', 'bitcoin', 'solana')
                    then wt.amount / power(10::numeric, wt.decimals) else wt.amount end) as amt
    from wallet_transactions wt where wt.user_id = p_user
    group by 1, 2, 3
  ),
  wal_values as (
    select n.account, n.ticker, d.day,
           n.qty - coalesce((select sum(m.amt) from wal_moves m
                             where m.wallet_id = n.wallet_id and m.sym = n.sym and m.day > d.day), 0) as qty
    from wal_now n cross join days d
  ),
  -- real estate: purchase price x index(month) / index(purchase month), RUB
  re_values as (
    select r.name, d.day, r.currency,
           r.purchase_price * (select i.price_per_m2 from real_estate_index i where i.city = r.city and i.month <= d.day order by i.month desc limit 1)
             / nullif((select i.price_per_m2 from real_estate_index i where i.city = r.city and i.month = r.purchase_month), 0) as value
    from real_estate r join days d on d.day >= r.purchase_month
    where r.user_id = p_user
  )
  select p_user, day, account, ticker, max(instrument_type), max(currency), round(sum(v)::numeric, 2)
  from (
    select day, account, ticker, instrument_type, currency, qty * price as v
    from trade_values where price is not null
    union all
    select day, account, 'CASH:' || currency || ':' || coalesce(product, ''),
           case when product = 'credit_card' and balance < 0 then 'credit' else 'cash' end, currency,
           balance * fx_on(currency, day)
    from bank_values
    union all
    select day, account, ticker, 'crypto', null, qty * price_on(ticker, day)
    from wal_values where abs(qty) > 1e-12
    union all
    select day, 'real estate', 'REAL_ESTATE:' || name, 'real_estate', currency, value * fx_on(currency, day)
    from re_values
  ) x
  where v is not null
  group by day, account, ticker;

  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.refresh_capital_daily(uuid) from public, anon, authenticated;

-- Daily at 22:30 UTC (after the day's market prices, 01:30 MSK).
select cron.unschedule(jobid) from cron.job where jobname = 'update-capital-history';
select cron.schedule(
  'update-capital-history',
  '30 22 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-capital-history',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
