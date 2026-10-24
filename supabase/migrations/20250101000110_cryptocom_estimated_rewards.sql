-- Crypto.com App has no personal API.  Between its CSV exports we project
-- Earn / DPoS rewards from the last actual payouts.  Keep those rows in the
-- same ledger as the actual export, but make their provenance explicit so a
-- later export can replace the projection rather than add to it.

alter table public.wallet_transactions
  add column if not exists estimated boolean not null default false;

comment on column public.wallet_transactions.estimated is
  'Worked out rather than read from a statement; currently Crypto.com Earn / DPoS rewards. Rebuilt from actual rows on every estimate run.';

create index if not exists wallet_transactions_estimated_wallet_time
  on public.wallet_transactions (wallet_id, estimated, tx_time);
