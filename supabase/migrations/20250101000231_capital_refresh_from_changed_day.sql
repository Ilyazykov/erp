-- The capital history rebuilt from the earliest day that changed, not from the first day
-- (23.11.2026: an upload of Ziraat's November statements rebuilt everything from March 2019,
-- an hour a pass -- and a second pass, the upload's second request having come during the
-- first). Every table the history is built from (refresh_capital_daily) marks the earliest day
-- its changed rows touch in capital_refresh_queue.dirty_from -- a row re-upserted unchanged
-- doesn't count; one with no day (a wallet, a price freeze, an exclusion) marks the whole
-- history. A run starts a week before that day (the transfer pairs can move a day a few days
-- back), or a week back when nothing changed (today's prices). Once in 20 hours a run is a
-- whole one all the same -- for anything a trigger here doesn't see.

alter table public.capital_refresh_queue add column if not exists dirty_from date;
alter table public.capital_refresh_queue add column if not exists full_at timestamptz;

-- p_user null: every user's (the prices and rates are everyone's)
create or replace function public.capital_mark_dirty(p_user uuid, p_day date) returns void
language sql security definer set search_path = public as $$
  update capital_refresh_queue
  set dirty_from = least(coalesce(dirty_from, p_day), p_day)
  where p_day is not null and (p_user is null or user_id = p_user)
$$;
revoke all on function public.capital_mark_dirty(uuid, date) from public, anon, authenticated;

-- A statement's changed rows -> capital_mark_dirty. TG_ARGV[0]: the day of a row, an expression
-- over j (the row as jsonb); TG_ARGV[1]: the user -- 'user' (j's user_id) or 'all'. A row
-- counts when no row the same (but for the bookkeeping columns) stands on the other side.
create or replace function public.capital_dirty_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  skip text[] := array['created_at', 'updated_at', 'last_synced_at', 'last_sync_error'];
  who text := case when TG_ARGV[1] = 'user' then '(j->>''user_id'')::uuid' else 'null::uuid' end;
  changed text;
begin
  changed := case TG_OP
    when 'INSERT' then 'select to_jsonb(r) - $1 as j from new_rows r'
    when 'DELETE' then 'select to_jsonb(r) - $1 as j from old_rows r'
    else '(select to_jsonb(r) - $1 as j from new_rows r except select to_jsonb(r) - $1 from old_rows r)
          union all
          (select to_jsonb(r) - $1 from old_rows r except select to_jsonb(r) - $1 from new_rows r)'
  end;
  execute format('select public.capital_mark_dirty(u, d) from (select %s as u, min(%s) as d from (%s) c group by 1) x',
    who, TG_ARGV[0], changed) using skip;
  return null;
end $$;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('bank_transactions', $e$least((j->>'tx_date')::timestamptz::date, (j->>'booked_at')::timestamptz::date, (j->>'authorized_on')::date)$e$, 'user'),
      ('trades', $e$least((j->>'trade_date')::date, (j->>'settle_date')::date)$e$, 'user'),
      ('internal_transfers', $e$least((j->>'out_at')::timestamptz::date, (j->>'in_at')::timestamptz::date)$e$, 'user'),
      ('wallet_transactions', $e$(j->>'tx_time')::timestamptz::date$e$, 'user'),
      ('wallet_balances', $e$(j->>'as_of')::timestamptz::date$e$, 'user'),
      ('real_estate', $e$'-infinity'::date$e$, 'user'),
      ('crypto_wallets', $e$'-infinity'::date$e$, 'user'),
      ('holding_exclusions', $e$'-infinity'::date$e$, 'user'),
      ('fx_history', $e$(j->>'day')::date$e$, 'all'),
      ('price_history', $e$(j->>'day')::date$e$, 'all'),
      ('real_estate_index', $e$(j->>'month')::date$e$, 'all'),
      ('price_freezes', $e$'-infinity'::date$e$, 'all')
    ) v(tbl, day_expr, who)
  loop
    execute format('drop trigger if exists capital_dirty_ins on public.%I', t.tbl);
    execute format('drop trigger if exists capital_dirty_upd on public.%I', t.tbl);
    execute format('drop trigger if exists capital_dirty_del on public.%I', t.tbl);
    execute format('create trigger capital_dirty_ins after insert on public.%I referencing new table as new_rows
      for each statement execute function public.capital_dirty_trigger(%L, %L)', t.tbl, t.day_expr, t.who);
    execute format('create trigger capital_dirty_upd after update on public.%I referencing old table as old_rows new table as new_rows
      for each statement execute function public.capital_dirty_trigger(%L, %L)', t.tbl, t.day_expr, t.who);
    execute format('create trigger capital_dirty_del after delete on public.%I referencing old table as old_rows
      for each statement execute function public.capital_dirty_trigger(%L, %L)', t.tbl, t.day_expr, t.who);
  end loop;
end $$;

create or replace function public.run_capital_refresh_step() returns integer
language plpgsql security definer set search_path = public as $function$
declare
  t0 timestamptz := clock_timestamp();
  q record;
  d date;
  dirty date;
  whole boolean;
  started timestamptz;
  total integer;
  done integer := 0;
begin
  for q in
    select * from capital_refresh_queue
    where next_from is not null or finished_at is null or finished_at < requested_at
    order by requested_at
  loop
    -- the expenses first (migration ...149): what an upload brings shows at once
    if q.expenses_at is null or q.expenses_at < q.requested_at then
      perform match_internal_transfers(q.user_id);
      perform refresh_expenses(q.user_id);
      update capital_refresh_queue set expenses_at = now() where user_id = q.user_id;
    end if;
    if q.next_from is null then
      perform match_internal_transfers(q.user_id);
      -- from the earliest day changed (the pairs just matched marking theirs too), a week before
      -- it; the whole history once in 20 hours
      select dirty_from into dirty from capital_refresh_queue where user_id = q.user_id;
      whole := q.full_at is null or q.full_at < now() - interval '20 hours';
      d := capital_first_day(q.user_id);
      if not whole and d is not null then
        d := greatest(d, coalesce(dirty, current_date) - 7);
      end if;
      update capital_refresh_queue set dirty_from = null,
        full_at = case when whole then now() else full_at end
      where user_id = q.user_id;
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
      perform refresh_expenses(q.user_id);
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
end $function$;
