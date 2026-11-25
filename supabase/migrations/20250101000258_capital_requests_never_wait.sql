-- A request for the capital refresh waited for the refresh itself: run_capital_refresh_step
-- writes the user's capital_refresh_queue row early (expenses_at, dirty_from, and the dirty
-- marks of the transfers it matches) and keeps it locked for its whole run, 70-110 s after an
-- upload. A line's category set in the receipt dialog in that time (receipt_items_category_changed
-- -> request_capital_refresh), an account set on a row (capital_dirty_trigger -> capital_mark_dirty)
-- waited for the row and failed on the statement timeout (26.11.2026).
-- Now a request or a dirty mark finding the row locked by another transaction doesn't wait:
-- it is put aside in capital_refresh_pending, and the next step folds it into the queue first.

create table if not exists public.capital_refresh_pending (
  user_id uuid not null,
  requested_at timestamptz,   -- a request: run again
  dirty_from date             -- a dirty mark: the earliest day changed
);
alter table public.capital_refresh_pending enable row level security;   -- written by the functions below only

create or replace function public.request_capital_refresh(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  perform 1 from capital_refresh_queue where user_id = p_user for update skip locked;
  if found then
    update capital_refresh_queue set requested_at = now() where user_id = p_user;
  elsif exists (select 1 from capital_refresh_queue where user_id = p_user) then
    -- a refresh running: its row is locked till it ends
    insert into capital_refresh_pending (user_id, requested_at) values (p_user, now());
  else
    insert into capital_refresh_queue (user_id, requested_at) values (p_user, now())
    on conflict (user_id) do update set requested_at = now();
  end if;
end $$;

create or replace function public.request_my_capital_refresh() returns void
language sql security definer set search_path = public as $$
  select public.request_capital_refresh(auth.uid())
$$;

create or replace function public.capital_mark_dirty(p_user uuid, p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare
  u uuid;
begin
  if p_day is null then return; end if;
  for u in select user_id from capital_refresh_queue where p_user is null or user_id = p_user loop
    perform 1 from capital_refresh_queue where user_id = u for update skip locked;
    if found then
      update capital_refresh_queue set dirty_from = least(coalesce(dirty_from, p_day), p_day) where user_id = u;
    else
      insert into capital_refresh_pending (user_id, dirty_from) values (u, p_day);
    end if;
  end loop;
end $$;

-- the step: the requests and marks put aside are folded into the queue before its rows are read
do $mig$
declare
  d text := pg_get_functiondef('public.run_capital_refresh_step()'::regprocedure);
  a text := E'begin\n  for q in\n    select * from capital_refresh_queue';
  b text := E'begin\n'
    || E'  -- the requests and dirty marks put aside while a run held the queue rows (migration ...258)\n'
    || E'  with p as (delete from capital_refresh_pending returning user_id, requested_at, dirty_from),\n'
    || E'  m as (select user_id, max(requested_at) as req, min(dirty_from) as dirty from p group by user_id)\n'
    || E'  update capital_refresh_queue c\n'
    || E'  set requested_at = greatest(c.requested_at, m.req), dirty_from = least(c.dirty_from, m.dirty)\n'
    || E'  from m where c.user_id = m.user_id;\n'
    || E'  for q in\n    select * from capital_refresh_queue';
begin
  if position(a in d) = 0 then raise exception 'run_capital_refresh_step: the loop not found'; end if;
  execute replace(d, a, b);
end $mig$;
