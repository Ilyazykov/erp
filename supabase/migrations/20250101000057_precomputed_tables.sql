-- What the site's tables used to work out in the browser on every load
-- (slow: a DISTINCT over the whole capital history, every wallet movement,
-- one request per statement source), worked out in the database instead:
--
-- capital_ever_held_cache: every (account, ticker) that ever held a value --
--   the capital history, plus every coin that ever moved in a wallet / on an
--   exchange (the history leaves out a coin with a movement of unknown size,
--   Telegram Wallet's USDT). Rebuilt by refresh_capital_ever_held at the end
--   of each capital rebuild (run_capital_refresh_step, 040, redefined);
--   capital_ever_held (054/055) now reads it.
-- latest_data_per_account(): one row per account with the dates the
--   "Latest data per account" table needs.

create table public.capital_ever_held_cache (
  user_id uuid not null references auth.users(id) on delete cascade,
  account text not null,
  ticker text not null,
  currency text,
  instrument_type text,
  primary key (user_id, account, ticker)
);
alter table public.capital_ever_held_cache enable row level security;
create policy "own ever-held" on public.capital_ever_held_cache for select using (auth.uid() = user_id);

create or replace function public.refresh_capital_ever_held(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from capital_ever_held_cache where user_id = p_user;
  insert into capital_ever_held_cache (user_id, account, ticker, currency, instrument_type)
  select p_user, account, ticker, max(currency), max(instrument_type)
  from (
    select account, ticker, currency, instrument_type from capital_daily
    where user_id = p_user and abs(value_usd) >= 0.01
    union all
    select w.account, t.symbol, null, 'crypto' from wallet_transactions t join crypto_wallets w on w.id = t.wallet_id
    where t.user_id = p_user and t.symbol is not null
  ) x
  group by account, ticker;
end $$;
revoke all on function public.refresh_capital_ever_held(uuid) from public, anon, authenticated;

create or replace view public.capital_ever_held
with (security_invoker = true) as
select user_id, account, currency, instrument_type, ticker from public.capital_ever_held_cache;

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

-- One row per account: newest real bank row (synthetic ones -- extrapolated,
-- data gaps, snapshots -- left out), newest broker trade / payout (Snowball is
-- no statement), newest exchange movement, last sync of an on-chain wallet,
-- real bank rows in the 90 days before the newest one (how actively the
-- account is used), and the end of the latest statement uploaded for it.
create or replace function public.latest_data_per_account()
returns table (account text, bank_day date, trade_day date, exchange_day date, synced_day date, bank_rows_90d integer, uploaded_to date)
language sql stable security invoker set search_path = public as $$
  with bank as (
    select b.account, max(b.tx_date)::date as d from bank_transactions b
    where b.user_id = auth.uid() and b.synthetic_kind is null group by b.account
  ),
  act as (
    select b.account, count(*)::integer as n from bank_transactions b join bank on bank.account = b.account
    where b.user_id = auth.uid() and b.synthetic_kind is null and b.tx_date::date between bank.d - 90 and bank.d
    group by b.account
  ),
  trd as (
    select t.account, max(t.trade_date) as d from trades t
    where t.user_id = auth.uid() and t.account is not null and coalesce(t.external_source, '') <> 'snowball_csv'
    group by t.account
  ),
  exch as (
    select w.account, max(t.tx_time)::date as d from crypto_wallets w join wallet_transactions t on t.wallet_id = w.id
    where w.user_id = auth.uid() and w.chain in ('binance', 'bybit', 'cryptocom', 'telegram') group by w.account
  ),
  onchain as (
    select w.account, max(w.last_synced_at)::date as d from crypto_wallets w
    where w.user_id = auth.uid() and w.chain not in ('binance', 'bybit', 'cryptocom', 'telegram') group by w.account
  ),
  upl as (
    select u.account, max(coalesce(u.period_to, u.uploaded_at::date)) as d from statement_uploads u
    where u.user_id = auth.uid() group by u.account
  ),
  accounts as (
    select account from bank union select account from trd union select account from exch union select account from onchain
  )
  select a.account, bank.d, trd.d, exch.d, onchain.d, coalesce(act.n, 0), upl.d
  from accounts a
  left join bank on bank.account = a.account left join act on act.account = a.account
  left join trd on trd.account = a.account left join exch on exch.account = a.account
  left join onchain on onchain.account = a.account left join upl on upl.account = a.account;
$$;
grant execute on function public.latest_data_per_account() to authenticated;

-- fill the cache now for everyone the capital history has
select public.refresh_capital_ever_held(user_id) from (select distinct user_id from public.capital_daily) u;
