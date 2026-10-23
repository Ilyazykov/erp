-- The functions the daily jobs call are deployed with --no-verify-jwt, so
-- anyone who knows their URLs could call them: set off a sync of every
-- account (hammering IBKR / Bybit / Freedom24 with the users' keys) or a
-- price run. A random secret in Vault ('cron_secret', made here, never
-- leaving the database but in the jobs' requests) now goes with every job
-- (x-cron-secret); the functions (_shared/cron_auth.ts) serve a request
-- without a signed-in user only with it, checking it through
-- cron_secret_ok, which only the service role may call.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
      'Sent by the pg_cron jobs to the edge functions (x-cron-secret)');
  end if;
end $$;

create function public.cron_secret_ok(p_secret text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p_secret)
$$;
revoke all on function public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.cron_secret_ok(text) to service_role;

-- Every job calling a function: the secret next to the apikey.
select cron.alter_job(jobid, command := replace(command, '''apikey'',',
  '''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret''), ''apikey'','))
from cron.job
where command like '%functions/v1/%' and command not like '%x-cron-secret%';
