-- The emergency fund's sources set on the page (23.11.2026), not in the code: the money it takes
-- whole -- an account's cash or its liquid assets (TBC's savings account). The rest up to its
-- $10,000 still comes from Revolut's money-market funds (euro, dollar, pound). Seeded with what
-- the code had, less Raiffeisen (its card expired: the money isn't at hand quickly).
create table if not exists public.cushion_sources (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account text not null,
  instrument_type text not null check (instrument_type in ('cash', 'liquid')),
  created_at timestamptz not null default now(),
  primary key (user_id, account, instrument_type)
);
alter table public.cushion_sources enable row level security;
drop policy if exists "own cushion sources" on public.cushion_sources;
create policy "own cushion sources" on public.cushion_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.cushion_sources (user_id, account, instrument_type)
select u.user_id, v.account, v.instrument_type
from (select distinct user_id from public.capital_refresh_queue) u
cross join (values ('Bank of Cyprus', 'cash'), ('Ziraat Bank', 'cash'), ('Wise', 'cash'), ('TBC Bank', 'liquid')) v(account, instrument_type)
on conflict do nothing;
