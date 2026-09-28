-- The capital-history rebuild moves out of the update-capital-history edge
-- function into the database: every day since 2017 in 30-day slices no
-- longer fits the function's ~150 s alongside the price fetching
-- (WORKER_RESOURCE_LIMIT), and each API call has its own few-second
-- statement timeout. The function now only asks for it
-- (request_capital_refresh); a pg_cron job, every minute, works through
-- what's asked for up to ~40 s at a time (run_capital_refresh_step), each
-- run carrying on from where the last one stopped (next_from). The queue
-- row is also the rebuild's status, which the function reports.

create table public.capital_refresh_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  next_from date,              -- set while a rebuild is under way
  finished_at timestamptz,
  rows_total integer,
  today_usd numeric
);
alter table public.capital_refresh_queue enable row level security;
create policy "own capital refresh status" on public.capital_refresh_queue for select using (auth.uid() = user_id);

create or replace function public.request_capital_refresh(p_user uuid) returns void
language sql security definer set search_path = public as $$
  insert into capital_refresh_queue (user_id, requested_at) values (p_user, now())
  on conflict (user_id) do update set requested_at = now()
$$;
revoke all on function public.request_capital_refresh(uuid) from public, anon, authenticated;

-- Rebuilds what's asked for, for up to ~40 s: first the internal-transfer
-- pairs (match_internal_transfers), then refresh_capital_daily slice by
-- slice from the first transaction to today.
create or replace function public.run_capital_refresh_step() returns integer
language plpgsql security definer set search_path = public as $$
declare
  t0 timestamptz := clock_timestamp();
  q record;
  d date;
  done integer := 0;
begin
  for q in
    select * from capital_refresh_queue
    where next_from is not null or finished_at is null or finished_at < requested_at
    order by requested_at
  loop
    if q.next_from is null then
      perform match_internal_transfers(q.user_id);
      d := capital_first_day(q.user_id);
      update capital_refresh_queue
      set started_at = now(), next_from = d, rows_total = 0, finished_at = null
      where user_id = q.user_id;
    else
      d := q.next_from;
    end if;
    while d is not null and d <= current_date and clock_timestamp() - t0 < interval '40 seconds' loop
      update capital_refresh_queue
      set rows_total = rows_total + refresh_capital_daily(q.user_id, d, least(d + 29, current_date))
      where user_id = q.user_id;
      d := d + 30;
      done := done + 1;
    end loop;
    if d is null or d > current_date then
      update capital_refresh_queue
      set next_from = null, finished_at = now(),
          today_usd = (select round(capital_usd, 2) from capital_daily_total where user_id = q.user_id and day = current_date)
      where user_id = q.user_id;
    else
      update capital_refresh_queue set next_from = d where user_id = q.user_id;
    end if;
    exit when clock_timestamp() - t0 >= interval '40 seconds';
  end loop;
  return done;
end $$;
revoke all on function public.run_capital_refresh_step() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'capital-refresh-step';
select cron.schedule('capital-refresh-step', '* * * * *', $$select public.run_capital_refresh_step()$$);
