// The daily pg_cron jobs call the functions deployed with --no-verify-jwt
// (anyone could): each job sends the project's cron secret (Vault
// 'cron_secret', migration ...100) in x-cron-secret, and a request without a
// signed-in user is served only with it -- else 401, so nobody outside can
// set off a sync of every account or a price run.

import { createClient } from 'jsr:@supabase/supabase-js@2';

export async function fromCron(req: Request): Promise<boolean> {
  const secret = req.headers.get('x-cron-secret');
  if (!secret) return false;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db.rpc('cron_secret_ok', { p_secret: secret });
  return !error && data === true;
}

export const notFromCron = () =>
  new Response(JSON.stringify({ error: 'Sign in, or call with the cron secret' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
