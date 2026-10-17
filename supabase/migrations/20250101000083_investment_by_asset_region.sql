-- investment_by_asset: also where each asset sits (region) -- Russian /
-- foreign shares and liquid assets, rouble / yuan bonds, an exchange's
-- dollars -- for "Earned by asset" grouped by type.
drop function if exists public.investment_by_asset(date, date, text);

create or replace function public.investment_by_asset(p_from date, p_to date, p_ccy text default 'USD')
returns table (asset text, accounts text, value_start numeric, value_end numeric,
               put_in numeric, taken_out numeric, income numeric, earned numeric, pct numeric, cash jsonb, kind text, region text)
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
           coalesce(t.fee_tax, 0) as fee,
           -- accrued interest paid on a bond's buy / got on its sale: the reports
           -- give it for the deal, this project's CSVs and Snowball per bond
           coalesce(case when t.external_source in ('sber_broker_html', 'tbank_broker_xlsx') then t.nkd
                         else t.nkd * t.quantity end, 0) as nkd,
           coalesce(t.note, '') as note, mp.asset_class
    from trades t left join market_prices mp on mp.ticker = t.ticker
    where t.user_id = u
      and not (t.ticker ~* '^SAVINGS:' and t.account = any(crypto_accounts))
  ),
  tr_money as (
    select day, account, case when ticker in ('TEUR2', 'TUSD2') then left(ticker, 4) else ticker end as asset, ccy,   -- a fund's blocked part is the fund
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
          + (case when side = 'buy' then 1 else -1 end) * nkd   -- the next coupon, paid in full, is not all earned
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
  -- the currency shown: every amount at its own day's rate (a rouble savings
  -- account earns its interest in roubles, not the rouble's fall in dollars)
  kx as (
    select d::date as day,
           case when p_ccy = 'RUB'
                then 1 / (select f.usd_per_unit from fx_history f where f.currency = 'RUB' and f.day <= d::date order by f.day desc limit 1)
                else 1 end as k
    from generate_series(p_from, d1, interval '1 day') d
  ),
  flows_usd as (
    select m.day, m.account, m.asset,
           ((m.invested - m.income) * r.rate)::numeric as own, (m.income * r.rate)::numeric as income
    from tr_money m
    cross join lateral (select coalesce(case when m.ccy = 'USD' then 1 end,
      (select f.usd_per_unit from fx_history f where f.currency = m.ccy and f.day <= m.day order by f.day desc limit 1), 0) as rate) r
    where m.invested <> 0 or m.income <> 0
    union all
    select w.day, w.account, w.asset,
           ((w.invested - w.income) * r.rate)::numeric, (w.income * r.rate)::numeric
    from wal_money w
    cross join lateral (select coalesce(case when w.sym in (select s from stable) then 1 end,
      (select p.price_usd from price_history p where p.ticker = w.sym and p.day <= w.day order by p.day desc limit 1), 0) as rate) r
    where w.invested <> 0 or w.income <> 0

    union all
    -- ...and is a cost of what the transfer was for: the coin it moved, or --
    -- dollars moved (USDT over TRON to an exchange) -- the first coin bought on
    -- an exchange after it (BTC on Bybit three days later)
    select x.tx_time::date, w.account, tg.asset,
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
    select x.tx_time::date, w.account, 'USD',
           -sum(b.amount * coalesce((select p.price_usd from price_history p
                                     where p.ticker = case when upper(b.symbol) in ('STETH', 'WSTETH', 'GG') then 'ETH' else upper(b.symbol) end
                                       and p.day <= b.tx_time::date order by p.day desc limit 1), 0))::numeric,
           0::numeric
    from wallet_transactions x
    join crypto_wallets w on w.id = x.wallet_id
    join wallet_transactions b on b.wallet_id = x.wallet_id and b.tx_hash = x.tx_hash and b.kind = 'trade' and b.amount > 0
    where x.user_id = u and x.kind = 'trade_out_unknown' and upper(x.symbol) in (select s from stable)
      and x.tx_time::date > p_from and x.tx_time::date <= d1
    group by x.tx_time::date, w.account
  ),
  flows as (
    select f.day, f.account, f.asset, (f.own * k.k)::numeric as own, (f.income * k.k)::numeric as income
    from flows_usd f join kx k on k.day = f.day
  ),
  val as (
    select c.account,
           case
             when c.account = any(crypto_accounts) and (upper(c.ticker) in (select s from stable) or c.ticker ~* '^SAVINGS:') then 'USD'
             when upper(c.ticker) in ('STETH', 'WSTETH', 'GG') then 'ETH'
             when upper(c.ticker) in ('TEUR2', 'TUSD2') then left(upper(c.ticker), 4)
             else upper(c.ticker)
           end as asset,
           sum(case when c.day = p_from then c.value_usd * (select k from kx where kx.day = p_from) else 0 end)::numeric as v0,
           sum(case when c.day = d1 then c.value_usd * (select k from kx where kx.day = d1) else 0 end)::numeric as v1
    from capital_daily c
    where c.user_id = u and c.day in (p_from, d1)
      and (c.account = any(crypto_accounts)
           or (c.ticker !~ '^(CASH|REAL_ESTATE):' and coalesce(c.instrument_type, '') not in ('cash', 'credit', 'real_estate')))
    group by 1, 2
  ),
  per0 as (
    select coalesce(v.asset, f.asset) as asset, coalesce(v.account, f.account) as account,
           coalesce(v.v0, 0) as v0, coalesce(v.v1, 0) as v1,
           coalesce(f.put_in, 0) as put_in, coalesce(f.taken_out, 0) as taken_out, coalesce(f.income, 0) as income,
           0::numeric as own_w
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
           count(*) as n,
           avg((d1 - x.tx_time::date)::numeric / greatest(d1 - p_from, 1)) as wt   -- rough: a few dollars
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
                          else k.n::numeric / sum(k.n) over (partition by k.account) end as spent,
           k.wt
    from unk k join usd_rest r on r.account = k.account
    where abs(r.rest) >= 0.005
  ),
  per as (
    select * from per0
    union all
    select a.asset, a.account, 0, 0, greatest(a.spent, 0), greatest(-a.spent, 0), 0, a.spent * a.wt from alloc a
    union all
    select 'USD', a.account, 0, 0, greatest(-a.spent, 0), greatest(a.spent, 0), 0, -a.spent * a.wt from alloc a
  ),
  -- Each asset over its own time: from the period start if it was held then,
  -- else from its first put-in; to the period end if still held, else to its
  -- last move (bought yesterday: its own day, not a sliver of the year).
  bounds as (
    select a.asset,
           case when a.v0 > 0 then p_from else coalesce(fl.first, p_from) end as s,
           -- a blocked one (price_freezes) is still held, worth 0: to the period end
           case when a.v1 > 0 or exists (select 1 from price_freezes fz where upper(fz.ticker) = a.asset) then d1
                else coalesce(fl.last, d1) end as e
    from (select asset, sum(v0) as v0, sum(v1) as v1 from per0 group by asset) a
    left join (select asset, min(day) as first, max(day) as last from flows group by asset) fl on fl.asset = a.asset
  ),
  -- the capital at work: the value at the start plus the money put in less
  -- taken out so far, averaged over the days it was held -- days with nothing
  -- in it (sold, bought again a year later) don't count
  fd as (select asset, day, sum(own) as own from flows group by 1, 2),
  a0 as (select asset, sum(v0) as v0 from per0 group by asset),
  segs as (
    -- from the period start to the first move, if held at the start
    select b.asset, a0.v0 as cap, greatest(coalesce((select min(day) from fd where fd.asset = b.asset), b.e), b.s) - b.s as len
    from bounds b join a0 on a0.asset = b.asset
    where a0.v0 > 0
    union all
    -- from each day money moved to the next one (or the end)
    select fd.asset,
           coalesce(a0.v0, 0) + sum(fd.own) over (partition by fd.asset order by fd.day),
           greatest(coalesce(lead(fd.day) over (partition by fd.asset order by fd.day), b.e) - fd.day, 0)
    from fd join bounds b on b.asset = fd.asset left join a0 on a0.asset = fd.asset
    where fd.day < b.e
  ),
  weighted as (
    -- the average -- but never less than what's in it at the end (money in
    -- less money out): a loss can't be more than that, so no % below -100
    -- (bought 100, a year later 1000 more the day before a halving: the
    -- average says ~100, the loss is 550 -- of the 1100 in it)
    select a0.asset,
           -- (held not a single night -- bought and sold the same day: what went in)
           greatest(coalesce((select sum(cap * len) / nullif(sum(len), 0) from segs sg
                              where sg.asset = a0.asset and sg.cap > 0 and sg.len > 0),
                             a0.v0 + coalesce((select sum(greatest(own, 0)) from fd where fd.asset = a0.asset), 0)),
                    a0.v0 + coalesce((select sum(own) from fd where fd.asset = a0.asset), 0)) as avg_cap
    from a0
  )
  select p.asset, string_agg(distinct p.account, ', ' order by p.account),
         round(sum(p.v0), 2), round(sum(p.v1), 2), round(sum(p.put_in), 2), round(sum(p.taken_out), 2), round(sum(p.income), 2),
         round(sum(p.v1 - p.v0 - p.put_in + p.taken_out), 2),
         -- over the capital that worked on average: the value at the start plus
         -- each put-in / taken-out weighted by the share of the period after it
         case when coalesce(max(w.avg_cap), sum(p.v0 + p.put_in)) > 0
              then round(sum(p.v1 - p.v0 - p.put_in + p.taken_out)
                         / coalesce(max(w.avg_cap), sum(p.v0 + p.put_in)) * 100, 2) end,
         -- the money in (+) and out (-) by day, for the page's XIRR
         (select jsonb_agg(jsonb_build_array(z.day, round(z.own, 2)) order by z.day)
          from (select fl.day, sum(fl.own) as own from flows fl where fl.asset = p.asset group by fl.day) z
          where z.own <> 0),
         -- its type, as the capital tables have it (stock / bond / deposit /
         -- liquid / gold / crypto)
         coalesce((select mp.instrument_type from market_prices mp
                   where upper(mp.ticker) = p.asset and mp.instrument_type <> 'fx_rate' limit 1),
                  case when p.asset ~* '^(DEPOSIT|ВКЛАД):' then 'deposit'
                       when p.asset ~* '^SAVINGS:' then 'liquid'
                       when p.asset = 'USD' then 'liquid'   -- an exchange's dollars and their Earn: like a savings account
                       when bool_or(p.account = any(crypto_accounts)) then 'crypto'
                       else 'stock' end),
         -- where it sits: 'ru' (Russian infrastructure), 'foreign', 'cny' (a
         -- rouble-market bond / fund in yuan), 'crypto' (an exchange's dollars);
         -- a ticker the prices table doesn't know goes by its trades' currency
         case
           when p.asset = 'USD' then 'crypto'
           when p.asset ~* '^(DEPOSIT|ВКЛАД):' then 'ru'
           else coalesce(
             (select case when mp.underlying_currency = 'CNY' and mp.instrument_type = 'bond' then 'cny' else mp.infra_region end
              from market_prices mp where upper(mp.ticker) = p.asset and mp.instrument_type <> 'fx_rate' limit 1),
             (select case when bool_or(upper(t.currency) = 'CNY') then 'cny'
                          when bool_or(upper(t.currency) = 'RUB') then 'ru' else 'foreign' end
              from trades t where t.user_id = u and upper(t.ticker) = p.asset),
             case when p.asset ~* '^SAVINGS:.* RUB$' then 'ru' else 'foreign' end)
         end
  from per p
  left join weighted w on w.asset = p.asset
  group by p.asset
  having abs(sum(p.v1 - p.v0 - p.put_in + p.taken_out)) >= 0.5 or sum(p.v1) >= 0.5;
end $$;
revoke all on function public.investment_by_asset(date, date, text) from public, anon;
grant execute on function public.investment_by_asset(date, date, text) to authenticated;
