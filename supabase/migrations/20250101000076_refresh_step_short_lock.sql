-- run_capital_refresh_step (057/058) updated its capital_refresh_queue row
-- at the start of its ~40-second run: the row stayed locked until the run
-- committed, and request_my_capital_refresh -- the site, right after an
-- upload -- waited on it past the statement timeout ("Capital history not
-- queued for a rebuild: canceling statement due to statement timeout").
-- Now the step works from local variables and writes its row once, as the
-- very last thing; a request that came in meanwhile is kept (its
-- requested_at is newer than the started_at written, so the rebuild runs
-- again after this one).
create or replace function public.run_capital_refresh_step() returns integer
language plpgsql security definer set search_path = public as $$
declare
  t0 timestamptz := clock_timestamp();
  q record;
  d date;
  started timestamptz;
  total integer;
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
      started := now();
      total := 0;
    else
      d := q.next_from;
      started := q.started_at;
      total := coalesce(q.rows_total, 0);
    end if;
    while d is not null and d <= current_date and clock_timestamp() - t0 < interval '40 seconds' loop
      total := total + refresh_capital_daily(q.user_id, d, least(d + 29, current_date));
      d := d + 30;
      done := done + 1;
    end loop;
    if d is null or d > current_date then
      perform refresh_capital_ever_held(q.user_id);
      perform refresh_investment_daily(q.user_id);
      update capital_refresh_queue
      set started_at = started, rows_total = total, next_from = null,
          -- a request during the run is newer than its start: run again
          finished_at = case when requested_at > started then started else now() end,
          today_usd = (select round(capital_usd, 2) from capital_daily_total where user_id = q.user_id and day = current_date)
      where user_id = q.user_id;
    else
      update capital_refresh_queue
      set started_at = started, rows_total = total, next_from = d, finished_at = null
      where user_id = q.user_id;
    end if;
    exit when clock_timestamp() - t0 >= interval '40 seconds';
  end loop;
  return done;
end $$;
revoke all on function public.run_capital_refresh_step() from public, anon, authenticated;

-- the Finuslugi upload's own request was lost to that timeout
insert into public.capital_refresh_queue (user_id, requested_at)
select distinct user_id, now() from public.capital_daily
on conflict (user_id) do update set requested_at = now();
