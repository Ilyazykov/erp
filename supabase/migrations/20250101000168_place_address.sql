-- A place's address (asked 05.11.2026): two of the same name (two Spars) are
-- told apart by the city, else the street, else the house number -- the
-- expenses tab adds as much of it to the name as it takes.
alter table public.places
  add column city text,
  add column street text,
  add column house text;
