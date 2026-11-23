-- Who is behind a phone number, card, IBAN or wallet in the statements (23.11.2026): one place to look a
-- counterparty up instead of guessing from a transfer's description. The numbers themselves are personal
-- data and are not in this repo: they are filled in on the database. confident = false: inferred, not
-- printed on a document naming the person.
create table if not exists public.people (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  relation text,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.people enable row level security;
drop policy if exists "own people" on public.people;
create policy "own people" on public.people
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.person_identifiers (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id bigint not null references public.people(id) on delete cascade,
  kind text not null check (kind in ('phone', 'card', 'iban', 'wallet')),
  value text not null,            -- phone in +digits, a card as *last4, an IBAN without spaces
  bank text,
  confident boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, kind, value)
);
create index if not exists person_identifiers_person on public.person_identifiers (person_id);
alter table public.person_identifiers enable row level security;
drop policy if exists "own person identifiers" on public.person_identifiers;
create policy "own person identifiers" on public.person_identifiers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
