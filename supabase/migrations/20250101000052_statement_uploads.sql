-- One row per account each time a statement / report for it is uploaded
-- (written by the site after a successful import). The "Latest data per
-- account" table dates an account by the later of its newest record and its
-- latest upload, so an account with no movements still shows a fresh
-- statement as fresh.
create table public.statement_uploads (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account text not null,
  kind text not null,          -- the site's detected file type (freedom24_xlsx, bank_csv, ...)
  file_name text,
  uploaded_at timestamptz not null default now()
);
create index statement_uploads_user_account on public.statement_uploads (user_id, account, uploaded_at desc);
alter table public.statement_uploads enable row level security;
create policy "own statement uploads" on public.statement_uploads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
