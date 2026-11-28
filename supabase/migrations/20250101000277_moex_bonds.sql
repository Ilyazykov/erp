-- What the Bonds & deposits tab needs from MOEX, worked out ahead (28.11.2026): the tab asked
-- iss.moex.com itself on every opening (two requests a bond held, the OFZ and yuan lists, the
-- figures) -- slow, and since 23.11.2026 failing in the browser (the Russian root's certificate),
-- the bonds gone from the tab. Now update-moex-bonds fills these daily and the page reads them;
-- MOEX's data, nobody's own -- anyone signed in reads, only the function (service role) writes.

create table if not exists public.moex_bonds (
  secid text primary key,
  info jsonb,       -- name, mat, offer, unit, coupons, face, floating, rate, allC, allA, at (the day worked out)
  market jsonb,     -- the main board's coupon, period, price, wap, yield, dur
  updated_at timestamptz not null default now()
);
alter table public.moex_bonds enable row level security;
drop policy if exists moex_bonds_read on public.moex_bonds;
create policy moex_bonds_read on public.moex_bonds for select to authenticated using (true);
grant select on public.moex_bonds to authenticated;

create table if not exists public.moex_bond_lists (
  name text primary key,   -- 'ofz', 'cny'
  list jsonb not null,
  at date not null,
  updated_at timestamptz not null default now()
);
alter table public.moex_bond_lists enable row level security;
drop policy if exists moex_bond_lists_read on public.moex_bond_lists;
create policy moex_bond_lists_read on public.moex_bond_lists for select to authenticated using (true);
grant select on public.moex_bond_lists to authenticated;

-- daily, MOEX's day before closed (05:10 UTC), and once more after its day (16:10 UTC)
select cron.unschedule(jobname) from cron.job where jobname = 'update-moex-bonds';
select cron.schedule('update-moex-bonds', '10 5,16 * * *', $$
  select net.http_post(
    url := 'https://xdltomehejjtgzdxbiyx.supabase.co/functions/v1/update-moex-bonds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$);
