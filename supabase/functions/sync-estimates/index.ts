// Supabase Edge Function: sync-estimates
//
// Rebuilds the income worked out between statements (_shared/estimates.ts):
// bond coupons / amortisations / redemptions at Sber and Alfa by the MOEX
// schedule, their shares' declared dividends (T-Invest), Russian banks'
// deposit and savings interest, Telegram Wallet's daily rewards. Two ways in: the page right after an upload (the user's
// JWT: that user), and the daily job (pg_cron with the cron secret, migration
// ...112: everyone who has uploaded statements). Each run removes the previous estimates and
// asks for the capital to be rebuilt.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { rebuildEstimates } from '../_shared/estimates.ts';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // The signed-in user (from the page), or -- the daily job -- everyone.
    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      userId = (await asUser.auth.getUser()).data.user?.id ?? null;
    }
    if (!userId && !(await fromCron(req))) return notFromCron();

    let users: string[] = userId ? [userId] : [];
    if (!userId) {
      const { data, error } = await db.from('statement_uploads').select('user_id');
      if (error) throw new Error(error.message);
      users = [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
    }
    const results = [];
    for (const u of users) {
      let result: Record<string, unknown>;
      try {
        result = await rebuildEstimates(db, u);
        const { error } = await db.rpc('request_capital_refresh', { p_user: u });
        if (error) throw new Error(error.message);
      } catch (err) { result = { error: String(err) }; }
      results.push({ user_id: u, ...result });
    }
    return json(userId ? results[0] : { users: results.length, results });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
