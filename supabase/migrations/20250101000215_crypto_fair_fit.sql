-- BTC's fair price refitted every day on its whole life (the user, 18.11.2026):
-- AHR999's own fair = 10 ^ (5.84 * log10(days since 2009-01-03) - 17.01) was
-- fitted by its author long ago. update-crypto-indicators now refits the same
-- line -- least squares of log10(price) on log10(age) -- each morning over every
-- daily price since 18.07.2010 (CoinMetrics' PriceUSD) and keeps a row a day.
-- The Crypto strategy tab's "the whole history" box takes the latest row: its
-- fair price, AHR999 on it for every day (the latest coefficients for the whole
-- history, the user's choice), and its red threshold -- the level with the same
-- share of days below it as AHR999's own below 0.45 (crypto_indicators). The
-- green threshold stays 1.2 (the user). Public data, readable by anyone.
create table public.crypto_fair_fit (
  day date primary key,
  slope numeric not null,
  intercept numeric not null,
  r2 numeric not null,
  days_fitted integer not null,
  first_price_day date not null,
  last_price_day date not null,
  red_threshold numeric,
  updated_at timestamptz not null default now()
);
alter table public.crypto_fair_fit enable row level security;
create policy "anyone can read the crypto fair fit" on public.crypto_fair_fit for select using (true);
