-- Replace the partial unique index with a real unique constraint, since
-- PostgREST upsert(onConflict=...) requires a constraint it can target --
-- a partial index (WHERE external_id IS NOT NULL) doesn't qualify.
-- external_id is always populated by the CSV importer, so NULLs are moot here.

drop index if exists trades_external_unique;

alter table public.trades
  add constraint trades_external_unique unique (user_id, external_source, external_id);
