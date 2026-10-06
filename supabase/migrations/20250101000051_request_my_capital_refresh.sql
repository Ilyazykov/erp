-- Lets the site ask for a capital-history rebuild for the signed-in user
-- right after a statement upload, instead of waiting for the nightly
-- update-capital-history run. Only queues it (same row as
-- request_capital_refresh, which stays service-role only); the
-- capital-refresh-step cron job, every minute, does the work. A rebuild
-- already under way finishes and then starts over, since its finished_at
-- ends up before the new requested_at.
create or replace function public.request_my_capital_refresh() returns void
language sql security definer set search_path = public as $$
  insert into capital_refresh_queue (user_id, requested_at)
  select auth.uid(), now() where auth.uid() is not null
  on conflict (user_id) do update set requested_at = now()
$$;
revoke all on function public.request_my_capital_refresh() from public, anon;
grant execute on function public.request_my_capital_refresh() to authenticated;
