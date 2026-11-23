-- Which person a transaction was with (23.11.2026). A table of its own, keyed by the row's external key like
-- internal_transfers, so that uploading a statement again keeps the link. The user's own transfers are not
-- linked: those are internal_transfers.
create table if not exists public.person_transactions (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id bigint not null references public.people(id) on delete cascade,
  external_source text not null,
  external_id text not null,
  how text not null check (how in ('statement', 'receipt', 'note', 'manual')),
  created_at timestamptz not null default now(),
  primary key (user_id, external_source, external_id, person_id)
);
create index if not exists person_transactions_person on public.person_transactions (user_id, person_id);
alter table public.person_transactions enable row level security;
drop policy if exists "own person transactions" on public.person_transactions;
create policy "own person transactions" on public.person_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
