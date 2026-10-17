-- Transfers to and from savings accounts and deposits are paired too. Those
-- are kept as positions (trades SAVINGS: / DEPOSIT: / ВКЛАД:), so
-- match_internal_transfers (039) never saw them: a move from Yandex's Save
-- account on 02.10 that reached T-Bank on 05.10 left a dip until it was paired
-- by hand. Now a top-up (buy) / withdrawal (sell) of such a position is a leg
-- like a bank row -- interest left out -- and refresh_capital_daily (045)
-- counts a paired position move from the day the first of the two moved, the
-- way it already does for bank rows.

create or replace function public.match_internal_transfers(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  k integer;
begin
  delete from internal_transfers it
  where it.user_id = p_user and it.matched_by = 'auto'
    and (not (exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.out_source and b.external_id = it.out_id)
           or exists (select 1 from trades t where t.user_id = p_user and t.external_source = it.out_source and t.external_id = it.out_id))
      or not (exists (select 1 from bank_transactions b where b.user_id = p_user and b.external_source = it.in_source and b.external_id = it.in_id)
           or exists (select 1 from trades t where t.user_id = p_user and t.external_source = it.in_source and t.external_id = it.in_id)));
  -- REPO: the opening and closing legs on the same account (same source and
  -- currency), opposite signs, the closing one later within 31 days and
  -- within 2% of the opening (the repo rate), nearest first.
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by, kind)
    with legs as (
      select b.external_source as src, b.external_id as id, upper(b.currency) as ccy, b.amount,
             coalesce(b.booked_at, b.tx_date) as t
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0
        and b.description ~* '^\s*(РЕПО|REPO)\M'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, c.src as cs, c.id as cid, o.amount as oa, c.amount as ca, o.ccy, o.t as ot, c.t as ct
      from legs o
      join legs c on c.src = o.src and c.ccy = o.ccy and sign(c.amount) = -sign(o.amount)
       and c.t > o.t and c.t <= o.t + interval '31 days'
       and abs(abs(c.amount) - abs(o.amount)) <= 0.02 * abs(o.amount)
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by ct) as ro,
                row_number() over (partition by cs, cid order by ot desc) as rc
      from cand
    )
    select p_user,
           case when oa < 0 then os else cs end, case when oa < 0 then oid else cid end,
           case when oa < 0 then cs else os end, case when oa < 0 then cid else oid end,
           greatest(oa, ca), ccy,
           case when oa < 0 then ot else ct end, case when oa < 0 then ct else ot end, 'auto', 'repo'
    from ranked where ro = 1 and rc = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
  loop
    insert into internal_transfers (user_id, out_source, out_id, in_source, in_id, amount, currency, out_at, in_at, matched_by)
    with legs as (
      select b.external_source as src, b.external_id as id, b.account, upper(b.currency) as ccy, b.amount,
             coalesce(b.authorized_on::timestamptz, b.tx_date) as t,
             b.description ~* ('revolut|top-?up|ibkr|interactive brokers|freedom|wise|bybit|binance|crypto\.com|'
               || 'transfer|intrabank|withdraw|deposit|replenish|card operation|operation on card|card2card|c2c|'
               || '\msbp\M|tinkoff|popolnen|perevod|zykov|'
               || 'перевод|вывод|пополнен|зачислен|списан|сбп|тинькофф|зыков') as hint
      from bank_transactions b
      where b.user_id = p_user and not b.synthetic and b.amount <> 0
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = b.external_source and x.out_id = b.external_id)
            or (x.in_source = b.external_source and x.in_id = b.external_id)))
      union all
      -- savings accounts and deposits are kept as positions (trades SAVINGS: /
      -- DEPOSIT: / ВКЛАД:, 1 unit of their currency): a top-up is a buy, a
      -- withdrawal a sell; interest is no transfer and stays out
      select t.external_source, t.external_id, coalesce(t.account, '(unspecified)'), upper(t.currency),
             case when t.side = 'buy' then t.quantity * t.price else -t.quantity * t.price end,
             t.trade_date::timestamptz,
             true
      from trades t
      where t.user_id = p_user and t.ticker ~* '^(SAVINGS|DEPOSIT|ВКЛАД):' and t.side in ('buy', 'sell')
        and t.external_id is not null and t.external_source <> 'snowball_csv' and t.quantity * t.price <> 0
        and coalesce(t.note, '') !~* 'interest|процент|капитализац|проценты'
        and not exists (select 1 from internal_transfers x where x.user_id = p_user
          and ((x.out_source = t.external_source and x.out_id = t.external_id)
            or (x.in_source = t.external_source and x.in_id = t.external_id)))
    ),
    cand as (
      select o.src as os, o.id as oid, i.src as isrc, i.id as iid, i.amount, o.ccy, o.t as ot, i.t as it,
             (o.hint and i.hint) as both_hint, abs(extract(epoch from i.t - o.t)) as gap
      from legs o
      join legs i on i.ccy = o.ccy and i.amount = -o.amount
       and (i.src <> o.src or i.account <> o.account)
       and i.t between o.t - interval '1 day' and o.t + interval '5 days'
      where o.amount < 0 and (o.hint or i.hint)
    ),
    ranked as (
      select *, row_number() over (partition by os, oid order by both_hint desc, gap) as ro,
                row_number() over (partition by isrc, iid order by both_hint desc, gap) as ri
      from cand
    )
    select p_user, os, oid, isrc, iid, amount, ccy, ot, it, 'auto' from ranked where ro = 1 and ri = 1
    on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
    exit when k = 0;
  end loop;
  return n;
end $$;
revoke all on function public.match_internal_transfers(uuid) from public, anon, authenticated;

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
  -- a savings / deposit move paired with a bank row (internal_transfers, 056)
  -- counts from the day the first of the two moved, like the bank rows do
  tr_eff as (
    select t.*,
           least(coalesce(t.settle_date, t.trade_date),
                 coalesce((select min(least(x.out_at, x.in_at))::date from internal_transfers x
                           where x.user_id = p_user and x.matched_by in ('auto', 'manual')
                             and ((x.out_source = t.external_source and x.out_id = t.external_id)
                               or (x.in_source = t.external_source and x.in_id = t.external_id))),
                          'infinity'::date)) as eff_date
    from trades t
    where t.user_id = p_user
  ),
  tr as (
    select coalesce(t.account, '(unspecified)') as account, t.ticker, t.eff_date as trade_date,
           max(t.currency) as currency,
           sum(case when t.side in ('buy', 'stock_as_dividend') then t.quantity
                    when t.side = 'sell' then -t.quantity else 0 end) as dq
    from tr_eff t
    where t.eff_date <= p_to
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
    union select distinct symbol from wallet_transactions where user_id = p_user and chain in ('binance', 'bybit', 'cryptocom', 'telegram') and symbol is not null
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
  -- made on one day, booked on a later one (a card top-up of Revolut from
  -- Bank of Cyprus: Revolut credits it at once, BoC books it 2-4 days
  -- later; a T-Bank broker withdrawal the card gets at once, listed after
  -- the next day's settlements): counted from the day it was made
  -- an internal transfer's two rows (internal_transfers) both count from
  -- the day the first of them moved
  pair_legs as (
    select out_source as src, out_id as id, least(out_at, in_at)::date as eff
    from internal_transfers where user_id = p_user and matched_by in ('auto', 'manual')
    union all
    select in_source, in_id, least(out_at, in_at)::date
    from internal_transfers where user_id = p_user and matched_by in ('auto', 'manual')
  ),
  bank_eff as (
    select b.account, upper(b.currency) as currency, b.product, b.amount,
           least(coalesce(b.authorized_on, b.tx_date::date), coalesce(pl.eff, 'infinity'::date)) as eff,
           coalesce(b.booked_at, b.tx_date)::date as booked
    from bank_transactions b
    left join pair_legs pl on pl.src = b.external_source and pl.id = b.external_id
    where b.user_id = p_user and b.balance_after is not null
      and upper(b.currency) not in ('XAU', 'XAG', 'XPT', 'XPD')
  ),
  -- made on one day, booked on a later one: counted from the day it was made
  bank_pending as (
    select e.account, e.currency, e.product, d.day, e.amount
    from bank_eff e
    join days d on d.day >= e.eff and d.day < e.booked
    where e.eff < e.booked
  ),
  bank_values as (
    select account, currency, product, day, sum(bal) as balance
    from (
      select account, currency, product, day,
             case when grp = 0 then seed else first_value(balance_after) over (partition by account, currency, external_source, grp order by day) end as bal
      from bank_raw
      union all
      select account, currency, product, day, amount from bank_pending
    ) x
    where bal is not null
    group by 1, 2, 3, 4
  ),
  -- ---- crypto wallets: today's balance less what moved after the day ----
  wal_now as (
    select wallet_id, contract, account, ticker, sum(quantity) as qty, max(as_of)::date as as_of
    from wallet_balances where user_id = p_user and ticker is not null
      and chain not in ('binance', 'bybit', 'cryptocom', 'telegram')
    group by 1, 2, 3, 4
  ),
  -- held from its first known movement on (or, with none, from the balance
  -- snapshot): a history that starts later doesn't mean it was always there
  wal_first as (
    select wallet_id, contract, min(tx_time)::date as first_day
    from wallet_transactions where user_id = p_user
    group by 1, 2
  ),
  wal_wallet_first as (
    select w.id as wallet_id,
           least(w.created_at::date, (select min(t.tx_time)::date from wallet_transactions t where t.wallet_id = w.id)) as first_day
    from crypto_wallets w where w.user_id = p_user
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
    left join wal_first f on f.wallet_id = n.wallet_id and f.contract = n.contract
    left join wal_wallet_first ww on ww.wallet_id = n.wallet_id
    join days d on d.day >= coalesce(f.first_day, ww.first_day, n.as_of)
    left join wal_after a on a.wallet_id = n.wallet_id and a.contract = n.contract
    left join wal_moves m on m.wallet_id = n.wallet_id and m.contract = n.contract and m.day = d.day
  ),
  -- ---- custodial exchanges: each coin's balance is the running sum of its
  -- rows (as _shared/exchange_balances.ts computes today's), so coins sold
  -- or moved out since show too. Not counted: moves between the exchange's
  -- own sub-accounts / into Earn or staking (the coins are still there); a
  -- coin with a movement of unknown size gets none (any sum would be
  -- wrong). Dollar stablecoins count at 1 USD, the part in Earn as the
  -- exchange's SAVINGS liquid asset; fiat left on an exchange isn't priced.
  exch_rows as (
    select t.wallet_id, w.account, t.symbol as sym, t.tx_time::date as day, t.kind, t.amount
    from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = p_user and t.chain in ('binance', 'bybit', 'cryptocom', 'telegram') and t.symbol is not null and t.tx_time::date <= p_to
  ),
  exch_day as (
    select wallet_id, account, sym, day,
           coalesce(sum(amount) filter (where kind not in ('transfer_internal', 'earn_internal', 'card_usd', 'staking_internal')), 0) as amt,
           coalesce(sum(-amount) filter (where kind = 'earn_internal'), 0) as earn
    from exch_rows r
    where not exists (select 1 from exch_rows u where u.wallet_id = r.wallet_id and u.sym = r.sym and u.kind = 'trade_out_unknown')
    group by 1, 2, 3, 4
  ),
  exch_keys as (
    select wallet_id, account, sym, min(day) as since,
           coalesce(sum(amt) filter (where day < p_from), 0) as base_amt,
           coalesce(sum(earn) filter (where day < p_from), 0) as base_earn
    from exch_day group by 1, 2, 3
  ),
  exch_values as (
    select k.account, k.sym, d.day,
           k.sym in ('USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP') as stable,
           k.base_amt + sum(coalesce(e.amt, 0)) over w as qty,
           k.base_earn + sum(coalesce(e.earn, 0)) over w as earn
    from exch_keys k
    join days d on d.day >= k.since
    left join exch_day e on e.wallet_id = k.wallet_id and e.sym = k.sym and e.day = d.day
    where k.sym not in ('EUR', 'USD', 'GBP', 'CHF', 'RUB', 'TRY', 'AUD', 'CAD', 'BRL', 'SGD')
    window w as (partition by k.wallet_id, k.sym order by d.day)
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
    select e.day, e.account, e.sym, case when e.stable then 'cash' else 'crypto' end, case when e.stable then 'USD' end,
           case when e.stable then e.qty - e.earn else e.qty * px.price end
    from exch_values e left join px on px.ticker = e.sym and px.day = e.day
    where abs(e.qty - case when e.stable then e.earn else 0 end) > 1e-12
    union all
    select e.day, e.account, 'SAVINGS:' || e.account || ' USD', 'liquid', 'USD', e.earn
    from exch_values e where e.stable and abs(e.earn) > 1e-9
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
