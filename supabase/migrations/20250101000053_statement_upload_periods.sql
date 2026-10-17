-- The period each uploaded statement covers (statement_uploads, 052), so the
-- "Latest data per account" table can show the holes between them. Filled by
-- the site: the period the importer reports (Sber, T-Bank broker reports),
-- else the dates in the file name (Revolut, Freedom24, T-Bank, Sber), else
-- the first and last date of the file's rows. Null where none is known.
alter table public.statement_uploads add column period_from date, add column period_to date;
