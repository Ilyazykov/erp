-- Frozen securities count as 0 from the day they were frozen: FinEx's
-- Irish funds (FX*) stopped trading on MOEX after 25.02.2022 (the exchange
-- closed on 28.02, FinEx suspended the funds on 03.03) and never resumed
-- for Russian holders, but their last close would otherwise carry forward.
-- refresh_capital_daily (032) redefined to apply it.

create table public.price_freezes (
  ticker text primary key,
  frozen_from date not null,
  note text
);
alter table public.price_freezes enable row level security;
create policy "anyone can read price freezes" on public.price_freezes for select using (true);

insert into public.price_freezes (ticker, frozen_from, note)
select t, date '2022-02-28', 'FinEx fund frozen (MOEX closed 28.02.2022, suspended 03.03.2022)'
from unnest(array['FXUS', 'FXIT', 'FXCN', 'FXGD', 'FXTB', 'FXWO', 'FXDE', 'FXRL', 'FXRB', 'FXRU', 'FXRD',
                  'FXKZ', 'FXEM', 'FXRW', 'FXIM', 'FXDM', 'FXES', 'FXCH', 'FXMM', 'FXTP', 'FXBC', 'FXIP', 'FXFA', 'FXRE']) t;

create or replace function public.refresh_capital_daily(p_user uuid, p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  first_day date := capital_first_day(p_user);
  n integer;
begin
  delete from capital_daily where user_id = p_user and day between p_from and p_to;
  if first_day is null then return 0; end if;
  p_from := greatest(p_from, first_day);
  if p_from > p_to then return 0; end if;

  insert into capital_daily (user_id, day, account, ticker, instrument_type, currency, value_usd)
  with days as (select generate_series(p_from, p_to, interval '1 day')::date as day),
  -- ---- rates and prices, carried forward over the slice ----
  fx_cur as (
    select c.currency,
           (select usd_per_unit from fx_history s where s.currency = c.currency and s.day < p_from order by s.day desc limit 1) as seed
    from (select distinct currency from fx_history) c
  ),
  fx_raw as (
    select c.currency, c.seed, d.day, f.usd_per_unit,
           count(f.usd_per_unit) over (partition by c.currency order by d.day) as grp
    from fx_cur c
    cross join days d
    left join fx_history f on f.currency = c.currency and f.day = d.day
  ),
  fx_days as (
    select currency, day,
           case when grp = 0 then seed else first_value(usd_per_unit) over (partition by currency, grp order by day) end as rate
    from fx_raw
  ),
  fx as (select currency, day, rate from fx_days union all select 'USD', day, 1 from days),
  -- ---- trades: quantity held at the end of each day ----
  tr as (
    select coalesce(t.account, '(unspecified)') as account, t.ticker, t.trade_date,
           max(t.currency) as currency,
           sum(case when t.side in ('buy', 'stock_as_dividend') then t.quantity
                    when t.side = 'sell' then -t.quantity else 0 end) as dq
    from trades t
    where t.user_id = p_user and t.trade_date <= p_to
      and not exists (select 1 from holding_exclusions e
        where e.user_id = t.user_id and e.external_source = t.external_source and e.external_id = t.external_id)
    group by 1, 2, 3
  ),
  keys as (
    select account, ticker, max(currency) as currency, min(trade_date) as since,
           coalesce(sum(dq) filter (where trade_date < p_from), 0) as base
    from tr group by 1, 2
  ),
  held as (
    select k.account, k.ticker, k.currency, d.day,
           k.base + sum(coalesce(tr.dq, 0)) over (partition by k.account, k.ticker order by d.day) as qty
    from keys k
    join days d on d.day >= k.since
    left join tr on tr.account = k.account and tr.ticker = k.ticker and tr.trade_date = d.day
  ),
  price_tickers as (
    select distinct ticker from held
    union select distinct ticker from wallet_balances where user_id = p_user and ticker is not null
  ),
  px_raw as (
    select t.ticker, d.day, p.price_usd,
           (select s.price_usd from price_history s where s.ticker = t.ticker and s.day < p_from order by s.day desc limit 1) as seed,
           count(p.price_usd) over (partition by t.ticker order by d.day) as grp
    from price_tickers t
    cross join days d
    left join price_history p on p.ticker = t.ticker and p.day = d.day
  ),
  px as (
    select r.ticker, r.day,
           case when fz.frozen_from <= r.day then 0
                when r.grp = 0 then r.seed
                else first_value(r.price_usd) over (partition by r.ticker, r.grp order by r.day) end as price
    from px_raw r
    left join price_freezes fz on fz.ticker = r.ticker
  ),
  trade_values as (
    select h.account, h.ticker, h.day, h.qty, h.currency,
      coalesce(mp.instrument_type,
        case when h.ticker ~* '^(DEPOSIT|ВКЛАД):' then 'deposit' when h.ticker ~* '^SAVINGS:' then 'liquid' else 'stock' end) as instrument_type,
      -- deposits, savings and money-market funds are 1 unit of their currency
      case
        when h.ticker ~* '^BLOCKED:' or mp.asset_class = 'blocked' then 0
        when h.ticker ~* '^(DEPOSIT|ВКЛАД|SAVINGS):' or mp.asset_class in ('deposit', 'savings_account', 'money_market_fund')
          then fx.rate
        else px.price
      end as price
    from held h
    left join market_prices mp on mp.ticker = h.ticker
    left join fx on fx.currency = upper(coalesce(mp.currency, h.currency, 'RUB')) and fx.day = h.day
    left join px on px.ticker = h.ticker and px.day = h.day
    where abs(h.qty) > 1e-12
  ),
  -- ---- bank balances: the day's last balance_after per account / currency / source ----
  bank_rows as (
    select account, currency, external_source, product, day, balance_after
    from (
      select account, upper(currency) as currency, external_source, product,
             coalesce(booked_at, tx_date)::date as day, balance_after,
             row_number() over (partition by account, currency, external_source, coalesce(booked_at, tx_date)::date
                                order by coalesce(booked_at, tx_date) desc, tx_date desc) as rn
      from bank_transactions
      where user_id = p_user and balance_after is not null and coalesce(booked_at, tx_date)::date <= p_to
        and upper(currency) not in ('XAU', 'XAG', 'XPT', 'XPD')
    ) r where rn = 1
  ),
  bank_keys as (
    select account, currency, external_source, max(product) as product, min(day) as since,
           (array_agg(balance_after order by day desc) filter (where day < p_from))[1] as seed
    from bank_rows group by 1, 2, 3
  ),
  bank_raw as (
    select k.account, k.currency, k.external_source, k.product, k.seed, d.day, b.balance_after,
           count(b.balance_after) over (partition by k.account, k.currency, k.external_source order by d.day) as grp
    from bank_keys k
    join days d on d.day >= k.since
    left join bank_rows b on b.account = k.account and b.currency = k.currency
      and b.external_source = k.external_source and b.day = d.day
  ),
  bank_values as (
    select account, currency, product, day, sum(bal) as balance
    from (
      select account, currency, product, day,
             case when grp = 0 then seed else first_value(balance_after) over (partition by account, currency, external_source, grp order by day) end as bal
      from bank_raw
    ) x
    where bal is not null
    group by 1, 2, 3, 4
  ),
  -- ---- crypto wallets: today's balance less what moved after the day ----
  wal_now as (
    select wallet_id, contract, account, ticker, sum(quantity) as qty
    from wallet_balances where user_id = p_user and ticker is not null
    group by 1, 2, 3, 4
  ),
  wal_moves as (
    select wallet_id, contract, tx_time::date as day,
           sum(case when decimals is not null and chain in ('ethereum', 'tron', 'bitcoin', 'solana')
                    then amount / power(10::numeric, decimals) else amount end) as amt
    from wallet_transactions where user_id = p_user and tx_time::date > p_from
    group by 1, 2, 3
  ),
  wal_after as (
    -- moved after p_to, and over the slice's days (after p_from)
    select wallet_id, contract,
           coalesce(sum(amt) filter (where day > p_to), 0) as after_to,
           coalesce(sum(amt) filter (where day <= p_to), 0) as in_slice
    from wal_moves group by 1, 2
  ),
  wal_values as (
    -- qty(day) = now - moved after p_to - moved in (day, p_to]
    select n.account, n.ticker, d.day,
           n.qty - coalesce(a.after_to, 0) - coalesce(a.in_slice, 0)
             + sum(coalesce(m.amt, 0)) over (partition by n.wallet_id, n.contract order by d.day) as qty
    from wal_now n
    cross join days d
    left join wal_after a on a.wallet_id = n.wallet_id and a.contract = n.contract
    left join wal_moves m on m.wallet_id = n.wallet_id and m.contract = n.contract and m.day = d.day
  ),
  -- ---- real estate: purchase price x index(month) / index(purchase month) ----
  re_values as (
    select r.name, d.day, upper(r.currency) as currency,
           r.purchase_price * (select i.price_per_m2 from real_estate_index i where i.city = r.city and i.month <= d.day order by i.month desc limit 1)
             / nullif((select i.price_per_m2 from real_estate_index i where i.city = r.city and i.month = r.purchase_month), 0) as value
    from real_estate r join days d on d.day >= r.purchase_month
    where r.user_id = p_user
  )
  select p_user, day, account, ticker, max(instrument_type), max(currency), round(sum(v)::numeric, 2)
  from (
    select day, account, ticker, instrument_type, currency, qty * price as v
    from trade_values
    union all
    select b.day, b.account, 'CASH:' || b.currency || ':' || coalesce(b.product, ''),
           case when b.product = 'credit_card' and b.balance < 0 then 'credit' else 'cash' end, b.currency,
           b.balance * fx.rate
    from bank_values b left join fx on fx.currency = b.currency and fx.day = b.day
    union all
    select w.day, w.account, w.ticker, 'crypto', null, w.qty * px.price
    from wal_values w left join px on px.ticker = w.ticker and px.day = w.day
    where abs(w.qty) > 1e-12
    union all
    select r.day, 'real estate', 'REAL_ESTATE:' || r.name, 'real_estate', r.currency, r.value * fx.rate
    from re_values r left join fx on fx.currency = r.currency and fx.day = r.day
  ) x
  where v is not null
  group by day, account, ticker;

  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.refresh_capital_daily(uuid, date, date) from public, anon, authenticated;
