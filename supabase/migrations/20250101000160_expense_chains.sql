-- Rows that are one move of money in several steps -- cash put on a card, the
-- card to the broker, roubles bought into dollars, the dollars out to a
-- currency account: the expenses tab's "Not counted" shows each chain as one
-- block, its steps in time order, instead of scattered over the pairs and the
-- categories. Each row of a chain by its statement key; the rows go in from
-- the app's side, not here -- the repository is public.
create table public.expense_chains (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  external_source text not null,
  external_id text not null,
  chain text not null,     -- the chain's name, shown over its block
  created_at timestamptz not null default now(),
  primary key (user_id, external_source, external_id)
);
alter table public.expense_chains enable row level security;
create policy "own expense chains" on public.expense_chains
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
