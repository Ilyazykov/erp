-- Non-custodial crypto wallets (Trust Wallet, ...) synced straight from the
-- blockchain by the `sync-crypto-wallets` Edge Function -- see TODO.md
-- section 8 for the reasoning (public address in, balances + full history
-- out; exchange API keys are deliberately never stored).
--
-- The address is personal data (it links the owner to every transaction
-- the address ever made), so it only lives in `crypto_wallets`, readable by
-- its owner alone (RLS), and is only ever sent to the public explorer APIs
-- server-side, by the Edge Function -- never from the browser.

create table public.crypto_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'tron')),
  address text not null,
  account text not null default 'Trust',  -- broker-row label in the pivot tables
  created_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_sync_error text,
  unique (user_id, chain, address)
);

-- Current on-chain balance of every asset the address holds, spam and
-- unpriced tokens included (they're kept for the record, just never valued).
--   contract = '' for the chain's native coin (ETH / TRX)
--   ticker   = what the holdings views and market_prices key on:
--              'ETH' / 'TRX' for native coins, 'USDT' / 'USDC' for the
--              canonical stablecoin contracts (priced like any other crypto
--              by update-market-prices), 'TOKEN:<chain>:<contract>' for any
--              other token the explorer has a USD price for (priced by the
--              sync function itself), null for a token with no price at
--              all -- stored, but not part of the portfolio.
create table public.wallet_balances (
  wallet_id uuid not null references public.crypto_wallets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account text not null,
  chain text not null,
  contract text not null default '',
  symbol text,
  name text,
  decimals int,
  quantity numeric not null,
  price_usd numeric,          -- explorer's own USD price, when it has one
  ticker text,
  as_of timestamptz not null default now(),
  primary key (wallet_id, contract)
);

-- Every value movement seen on the address, from the wallet's point of view
-- (amount > 0 = received, < 0 = sent). Network fees paid by the wallet are
-- their own rows (kind 'fee'). Record-only: holdings come from
-- wallet_balances (the chain's own truth), not from summing this history.
create table public.wallet_transactions (
  wallet_id uuid not null references public.crypto_wallets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  chain text not null,
  tx_hash text not null,
  seq int not null,            -- position of this movement within the tx (log index etc.)
  kind text not null,          -- 'native' | 'internal' | 'token' | 'fee'
  tx_time timestamptz not null,
  contract text not null default '',
  symbol text,
  decimals int,
  amount numeric not null,
  counterparty text,
  status text,
  primary key (wallet_id, tx_hash, kind, seq)
);
create index wallet_transactions_user_time on public.wallet_transactions (user_id, tx_time desc);

-- Trades to leave out of current holdings, by (source, ticker) rather than
-- a flag on the rows themselves: import-trades-csv wipes and reinserts
-- every Snowball row on each upload, so a per-row flag wouldn't survive.
create table public.trade_exclusions (
  user_id uuid not null references auth.users(id) on delete cascade,
  external_source text not null,
  ticker text not null,
  reason text,
  primary key (user_id, external_source, ticker)
);

alter table public.crypto_wallets enable row level security;
alter table public.wallet_balances enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.trade_exclusions enable row level security;

create policy "own crypto wallets" on public.crypto_wallets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own wallet balances" on public.wallet_balances
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own wallet transactions" on public.wallet_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own trade exclusions" on public.trade_exclusions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The ETH in Snowball (no account recorded) is the same ETH that sits in
-- Trust Wallet; the blockchain is now the source of truth for it.
insert into public.trade_exclusions (user_id, external_source, ticker, reason)
select distinct user_id, 'snowball_csv', 'ETH',
  'Same ETH as in Trust Wallet, which is synced from the blockchain'
from public.trades
where external_source = 'snowball_csv' and ticker = 'ETH' and account is null
on conflict do nothing;

-- Holdings = trades (minus exclusions) + on-chain wallet balances.
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
    select 1 from public.trade_exclusions e
    where e.user_id = t.user_id and e.external_source = t.external_source and e.ticker = t.ticker
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
    select 1 from public.trade_exclusions e
    where e.user_id = t.user_id and e.external_source = t.external_source and e.ticker = t.ticker
  )
  union all
  select w.user_id, w.ticker, w.account, w.quantity
  from public.wallet_balances w
  where w.ticker is not null
) x
group by user_id, ticker, account
having sum(qty) <> 0;

-- Daily sync of every wallet, 15 minutes before update-market-prices (06:00
-- UTC) so newly seen tickers get priced the same morning. Same pattern as
-- 20250101000005_schedule_market_prices.sql.
select cron.unschedule(jobid)
from cron.job
where jobname = 'sync-crypto-wallets-daily';

select cron.schedule(
  'sync-crypto-wallets-daily',
  '45 5 * * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/sync-crypto-wallets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
