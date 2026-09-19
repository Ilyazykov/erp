-- Run this in Supabase SQL Editor to extend `trades` for broker-export imports
-- (Snowball/CSV: BUY, SELL, DIVIDEND, AMORTISATION, REPAYMENT, STOCK_AS_DIVIDEND)

-- Widen the side/event check to cover all broker event types, not just buy/sell
alter table public.trades drop constraint if exists trades_side_check;
alter table public.trades add constraint trades_side_check
  check (side in ('buy', 'sell', 'dividend', 'amortisation', 'repayment', 'stock_as_dividend'));

-- New columns needed to round-trip a broker CSV export
alter table public.trades add column if not exists currency text;
alter table public.trades add column if not exists fee_tax numeric;
alter table public.trades add column if not exists fee_currency text;
alter table public.trades add column if not exists exchange text;
alter table public.trades add column if not exists nkd numeric;

-- Prevent re-importing the exact same broker row twice on repeated CSV imports
alter table public.trades add column if not exists external_source text;
alter table public.trades add column if not exists external_id text;
create unique index if not exists trades_external_unique
  on public.trades (user_id, external_source, external_id)
  where external_id is not null;
