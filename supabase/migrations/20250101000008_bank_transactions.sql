-- Raw bank/broker cash-account statement lines (Revolut, Wise, IBKR cash
-- activity, etc.) -- everyday spending, P2P transfers, salary/rent income.
-- Deliberately NOT folded into `trades`: trades is shaped around asset
-- transactions (ticker + quantity + price), and a Wolt payment or a rent
-- transfer has no ticker or quantity -- it's just money moving in a
-- currency. Forcing it into trades would mean fake tickers like
-- 'EUR_CASH' with quantity=amount, price=1, which breaks every existing
-- consumer of trades (current_holdings, cash_flows, portfolio_value_usd)
-- that assumes a ticker is a priced, held asset.
--
-- An operation that actually IS an asset transaction -- buying into
-- Revolut's Flexible Cash Funds money-market fund, an FX conversion, a
-- transfer that funds an IBKR brokerage account -- still belongs in
-- `trades` (as its own ticker, e.g. the fund's ISIN, or a FX pair), not
-- here. This table is for the spending/transfer side of a statement only.
create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account text not null,  -- e.g. 'Revolut' -- matches trades.account for consistency; the
                           -- specific currency/product for a row lives in `currency` below,
                           -- not folded into this column (see import-revolut-statement/index.ts)
  tx_date timestamptz not null,  -- full timestamp (Revolut's own CSV export gives second-level
                                  -- precision via "Started Date"), not just a calendar date --
                                  -- this is what makes external_id below a reliable dedup key
  description text not null,  -- raw statement line description, e.g. "Wolt", "Transfer to IRINA MAKEEVA"
  counterparty text,  -- reserved for sources that separate payee from description; unused by the CSV importer
  amount numeric not null,  -- signed: negative = money out, positive = money in
  currency text not null,
  category text,  -- simple keyword-derived bucket, e.g. 'food_delivery', 'transport', 'internal_transfer' -- best-effort, not authoritative
  balance_after numeric,  -- running balance from the statement, when present -- useful for verifying import completeness
  note text,
  external_source text not null,  -- e.g. 'revolut_csv'
  external_id text,  -- row-level dedup key: (Started Date, description, amount, currency) for
                      -- the Revolut CSV importer -- reliable because Started Date carries
                      -- second-level precision, so genuinely distinct same-second
                      -- transactions with identical description+amount are the only
                      -- remaining edge case (not observed in practice). NULL is allowed for
                      -- future sources with no reliable per-row identifier, which would
                      -- instead dedupe some other way (e.g. delete-and-reinsert by range).
  created_at timestamptz not null default now(),
  unique (user_id, external_source, external_id)
);

alter table public.bank_transactions enable row level security;

create policy "own bank transactions" on public.bank_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index bank_transactions_user_date on public.bank_transactions (user_id, tx_date);
