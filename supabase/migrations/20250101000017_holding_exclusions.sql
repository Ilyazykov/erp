-- Temporary: individual trades kept as history (with their purchase prices)
-- but left out of current holdings, because the same coins are already
-- counted where they are now. The case today: BTC and ETH bought in Telegram
-- Wallet on 2025-08-30 (Snowball), moved to Trust Wallet on 2025-09-19 and,
-- for BTC, on to Bybit on 2025-09-22 (same transaction c246dc7530d0... in
-- Trust's on-chain history and in Bybit's deposit log). Trust (blockchain)
-- and Bybit (import-bybit) now hold them, so the Snowball buy + transfer-fee
-- rows would count them a second time. Meant to be replaced later by
-- deleting those duplicate rows outright.
--
-- Keyed by external_id, which import-trades-csv derives from the row's own
-- content (event:date:symbol:quantity:price:feeTax), so it stays the same
-- across Snowball re-uploads.

create table public.holding_exclusions (
  user_id uuid not null references auth.users(id) on delete cascade,
  external_source text not null,
  external_id text not null,
  reason text,
  primary key (user_id, external_source, external_id)
);
alter table public.holding_exclusions enable row level security;
create policy "own holding exclusions" on public.holding_exclusions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.holding_exclusions (user_id, external_source, external_id, reason)
select user_id, external_source, external_id,
  'Telegram -> Trust -> Bybit transfer chain; the coins are counted in Trust / Bybit'
from public.trades
where external_source = 'snowball_csv'
  and (
    (ticker = 'BTC' and trade_date = '2025-08-30' and side = 'buy' and note = 'telegram')
    or (ticker = 'BTC' and trade_date = '2025-09-19' and side = 'sell' and note = 'telegram -> trust')
    or (ticker = 'BTC' and trade_date = '2025-09-23' and side = 'sell' and note = 'trust -> bybit')
    or (ticker = 'ETH' and trade_date = '2025-08-30' and side = 'buy' and note = 'telegram')
    or (ticker = 'ETH' and trade_date = '2025-09-19' and side = 'sell' and note = 'telegram -> trust')
  )
on conflict do nothing;

create or replace view public.current_holdings
with (security_invoker = true) as
select user_id, ticker, sum(qty) as quantity
from (
  select t.user_id, t.ticker,
    case when t.side in ('buy', 'stock_as_dividend') then t.quantity
         when t.side = 'sell' then -t.quantity
         else 0 end as qty
  from public.trades t
  where not exists (
    select 1 from public.holding_exclusions e
    where e.user_id = t.user_id and e.external_source = t.external_source and e.external_id = t.external_id
  )
  union all
  select w.user_id, w.ticker, w.quantity
  from public.wallet_balances w
  where w.ticker is not null
) x
group by user_id, ticker
having sum(qty) <> 0;

create or replace view public.current_holdings_by_account
with (security_invoker = true) as
select user_id, ticker, account, sum(qty) as quantity
from (
  select t.user_id, t.ticker, coalesce(t.account, '(unspecified)') as account,
    case when t.side in ('buy', 'stock_as_dividend') then t.quantity
         when t.side = 'sell' then -t.quantity
         else 0 end as qty
  from public.trades t
  where not exists (
    select 1 from public.holding_exclusions e
    where e.user_id = t.user_id and e.external_source = t.external_source and e.external_id = t.external_id
  )
  union all
  select w.user_id, w.ticker, w.account, w.quantity
  from public.wallet_balances w
  where w.ticker is not null
) x
group by user_id, ticker, account
having sum(qty) <> 0;
