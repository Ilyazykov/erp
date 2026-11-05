-- The yuan bonds' ladder by the PBoC's rate (asked 06.11.2026), as the
-- rouble one by the CBR's: key_rate_horizon_odds per country ('RU', 'CN';
-- China's rate in 0.5 pp buckets), and the two rates by month from the BIS
-- (cb_rates_monthly) -- the tab's China rate now. update-key-rate-odds fills
-- both, monthly.
delete from public.key_rate_horizon_odds;
alter table public.key_rate_horizon_odds drop constraint key_rate_horizon_odds_pkey;
alter table public.key_rate_horizon_odds add column country text not null default 'RU';
alter table public.key_rate_horizon_odds alter column rate type numeric;
alter table public.key_rate_horizon_odds add primary key (country, horizon, rate);
comment on column public.key_rate_horizon_odds.rate is 'the bucket: rate <= the central bank rate < rate + 1 (RU) or + 0.5 (CN)';

create table public.cb_rates_monthly (
  country text not null,        -- 'RU': the CBR (the refinancing rate before 13.09.2013), 'CN': the PBoC
  month date not null,          -- the month's first day; the rate at its end
  rate numeric not null,
  primary key (country, month)
);
alter table public.cb_rates_monthly enable row level security;
create policy "anyone can read central bank rates" on public.cb_rates_monthly for select using (true);
