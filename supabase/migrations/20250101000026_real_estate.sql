-- Real estate, valued by a city's average price per square metre:
--   current value = purchase price x (latest price per m2 / price per m2 in
--   the purchase month)
-- (user's formula -- e.g. 2 700 000 x 169 555 / 60 274 for a flat bought in
-- May 2017 in Nizhny Novgorod).
--
-- real_estate_index: the monthly price-per-m2 series per city, public data
-- (read by everyone, written only by the update-real-estate-index function
-- with the service role -- same pattern as market_prices). Filled for
-- Nizhny Novgorod from gipernn.ru's ready-housing analytics (the whole
-- series back to 1997, re-read on every run).
--
-- real_estate: the user's own properties (RLS: only the owner), entered on
-- the page -- name, city, purchase price and month.

create table public.real_estate_index (
  city text not null,             -- 'nizhny_novgorod'
  month date not null,            -- first day of the month
  price_per_m2 numeric not null,  -- in `currency`
  currency text not null default 'RUB',
  source text not null,           -- 'gipernn.ru'
  updated_at timestamptz not null default now(),
  primary key (city, month)
);
alter table public.real_estate_index enable row level security;
create policy "anyone can read real estate index" on public.real_estate_index
  for select using (true);

create table public.real_estate (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  city text not null,
  purchase_price numeric not null check (purchase_price > 0),
  currency text not null default 'RUB',
  purchase_month date not null,   -- first day of the month
  created_at timestamptz not null default now()
);
alter table public.real_estate enable row level security;
create policy "own real estate" on public.real_estate
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Current value of each property (security_invoker: the caller's own rows).
create view public.real_estate_value
with (security_invoker = true) as
select r.id, r.user_id, r.name, r.city, r.purchase_price, r.currency, r.purchase_month,
       p.price_per_m2 as purchase_price_per_m2,
       l.month as latest_month, l.price_per_m2 as latest_price_per_m2,
       round(r.purchase_price * l.price_per_m2 / nullif(p.price_per_m2, 0), 2) as current_value
from public.real_estate r
left join public.real_estate_index p on p.city = r.city and p.month = r.purchase_month
left join lateral (
  select month, price_per_m2 from public.real_estate_index i
  where i.city = r.city order by month desc limit 1
) l on true;

-- Monthly refresh on the 1st, at the end of the day in Moscow (20:00 UTC =
-- 23:00 MSK): by then gipernn has the month just ended (on September 1st
-- the August figure is there).
select cron.unschedule(jobid) from cron.job where jobname = 'update-real-estate-index';
select cron.schedule(
  'update-real-estate-index',
  '0 20 1 * *',
  $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-real-estate-index',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
