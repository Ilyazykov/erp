-- Stock splits (Yahoo's split events), for two things that need the real,
-- unadjusted picture:
--   * update-capital-history: Yahoo's daily closes are split-adjusted back
--     in time (AAPL on 28.08.2020, the day before its 4:1 split: 124.81,
--     not ~499), while trades hold the quantities actually traded -- so
--     each close is multiplied back by the ratios of the splits after it;
--   * import-tbank-broker: T-Bank's report doesn't list a split, so the
--     position's gap to the closing balance was booked at the period end;
--     when splits explain it, it's booked on the split days instead.
-- ratio = new shares per old share (4 for 4:1, 0.1 for a 1:10 reverse).

create table public.stock_splits (
  ticker text not null,
  day date not null,          -- first day traded split-adjusted
  ratio numeric not null check (ratio > 0),
  primary key (ticker, day)
);
alter table public.stock_splits enable row level security;
create policy "anyone can read stock splits" on public.stock_splits for select using (true);

-- When the function last asked Yahoo for a ticker's splits (weekly).
alter table public.price_sources add column splits_checked_at timestamptz;
