-- Where a payment was made, kept apart from the note (asked 05.11.2026): the
-- places in a table of their own, a row out points at one (place_id) -- the
-- same café paid at again is the same place. Set from a Google Maps link
-- written into a note on the expenses tab (the page takes the link out of
-- the note), or by hand. A statement uploaded again doesn't touch it.
create table public.places (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  lat double precision,
  lng double precision,
  url text,            -- the map link it came from
  google_id text,      -- Google Maps' own id of the place (the link's "!1s0x...:0x..."): one row per place
  created_at timestamptz not null default now(),
  unique (user_id, google_id)
);
alter table public.places enable row level security;
create policy "own places" on public.places
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.bank_transactions
  add column place_id bigint references public.places(id) on delete set null;
