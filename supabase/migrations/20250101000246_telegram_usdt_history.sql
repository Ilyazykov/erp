-- USDT in the Telegram Wallet's capital history (23.11.2026). Its export doesn't say how many dollars an exchange
-- took ('trade_out_unknown', amount 0), so the history left the coin out altogether, and the dollars that sat in
-- the wallet and in Earn were missing from the capital. Each such exchange is now worth what it bought at that
-- day's price, times one factor for the wallet's spread: the one that brings USDT to the zero the app shows
-- (about 1.6% over the 16 exchanges to date). The factor stays within 1-1.03, so dollars just topped up and not
-- spent yet don't get written off as a spread. A view: a new export is covered with no step of its own.
-- The stored rows and the wallet's balance don't change.
create or replace view public.telegram_usdt_swaps with (security_invoker = true) as
with swaps as (
  select u.user_id, u.wallet_id, u.tx_hash, u.seq,
         sum(b.amount * coalesce(
           (select h.price_usd from public.price_history h
            where h.ticker = upper(b.symbol) and h.day <= b.tx_time::date order by h.day desc limit 1),
           -- a coin with no price (FLR): the rate of its next sale for USDT
           (select s.amount / nullif(b.amount, 0) from public.wallet_transactions s
            where s.wallet_id = b.wallet_id and s.kind = 'trade' and upper(s.symbol) = 'USDT'
              and s.status like 'Exchanged ' || b.symbol || ' to USDT%' and s.tx_time >= b.tx_time
            order by s.tx_time limit 1),
           0)) as usd
  from public.wallet_transactions u
  join public.wallet_transactions b on b.wallet_id = u.wallet_id and b.tx_hash = u.tx_hash and b.kind = 'trade' and b.amount > 0
  where u.chain = 'telegram' and u.kind = 'trade_out_unknown' and upper(u.symbol) = 'USDT'
  group by 1, 2, 3, 4
),
known as (
  select wallet_id, sum(amount) as net
  from public.wallet_transactions
  where chain = 'telegram' and upper(symbol) = 'USDT' and kind not in ('earn_internal', 'trade_out_unknown')
  group by 1
),
factor as (
  select s.wallet_id, least(1.03, greatest(1, n.net / nullif(sum(s.usd), 0))) as k
  from swaps s join known n on n.wallet_id = s.wallet_id
  group by s.wallet_id, n.net
)
select s.user_id, s.wallet_id, s.tx_hash, s.seq, s.usd * f.k as usdt
from swaps s join factor f on f.wallet_id = s.wallet_id;

do $mig$
declare
  d text := pg_get_functiondef('public.refresh_capital_daily(uuid, date, date)'::regprocedure);
  a1 text := $t$select t.wallet_id, w.account, t.symbol as sym, t.tx_time::date as day, t.kind, t.amount
    from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = p_user and t.chain in ('binance', 'bybit', 'cryptocom', 'telegram')$t$;
  b1 text := $t$select t.wallet_id, w.account, t.symbol as sym, t.tx_time::date as day, t.kind, t.chain,
           case when t.kind = 'trade_out_unknown' and e.usdt is not null then -e.usdt else t.amount end as amount,
           (t.kind = 'trade_out_unknown' and e.usdt is null) as unresolved
    from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    left join telegram_usdt_swaps e on e.wallet_id = t.wallet_id and e.tx_hash = t.tx_hash and e.seq = t.seq
    where t.user_id = p_user and t.chain in ('binance', 'bybit', 'cryptocom', 'telegram')$t$;
  -- Telegram's Earn pays into Earn: its interest is part of what's there until it comes out
  a2 text := $t$coalesce(sum(-amount) filter (where kind = 'earn_internal'), 0) as earn$t$;
  b2 text := $t$coalesce(sum(case when kind = 'earn_internal' then -amount when kind = 'interest' and chain = 'telegram' then amount end), 0) as earn$t$;
  a3 text := $t$u.sym = r.sym and u.kind = 'trade_out_unknown')$t$;
  b3 text := $t$u.sym = r.sym and u.unresolved)$t$;
  -- the one factor can leave a dollar or two below zero between two exchanges: not drawn as a debt
  a4 text := $t$case when e.stable then e.qty - e.earn else e.qty * px.price end$t$;
  b4 text := $t$case when e.stable and e.account = 'Telegram' then greatest(e.qty - e.earn, 0) when e.stable then e.qty - e.earn else e.qty * px.price end$t$;
begin
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 or position(a4 in d) = 0 then
    raise exception 'refresh_capital_daily: exchange rows not as expected';
  end if;
  execute replace(replace(replace(replace(d, a1, b1), a2, b2), a3, b3), a4, b4);
end $mig$;

-- recount from the wallet's first such exchange
do $mig$
declare r record;
begin
  for r in
    select user_id, min(tx_time)::date as first_day from public.wallet_transactions
    where chain = 'telegram' and kind = 'trade_out_unknown' group by user_id
  loop
    perform public.capital_mark_dirty(r.user_id, r.first_day);
    update public.capital_refresh_queue set requested_at = now() where user_id = r.user_id;
  end loop;
end $mig$;
