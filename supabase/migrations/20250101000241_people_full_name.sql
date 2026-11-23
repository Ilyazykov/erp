-- people (...240): last name, first name and patronymic in columns of their own instead of one "name".
-- The old value is kept in first_name until the real parts are written on the database (personal data,
-- not in this repo).
alter table public.people
  add column if not exists last_name text,
  add column if not exists first_name text,
  add column if not exists middle_name text;

update public.people set first_name = name where first_name is null;

alter table public.people alter column first_name set not null;
-- (the unique key on the old column goes with it)
alter table public.people drop column name;
alter table public.people add constraint people_full_name_key
  unique nulls not distinct (user_id, last_name, first_name, middle_name);
