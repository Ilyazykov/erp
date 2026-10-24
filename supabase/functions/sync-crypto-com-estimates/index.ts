// Daily projection of Crypto.com App Earn / DPoS rewards.  Actual transactions
// still only arrive from the user's CSV export (import-crypto-com).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { recomputeExchange, type ExchangeWallet } from '../_shared/exchange_balances.ts';
import { CRYPTOCOM_RULES, rebuildCryptoComEstimates } from '../_shared/cryptocom_estimates.ts';

Deno.serve(async (req) => {
  if (!(await fromCron(req))) return notFromCron();
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const { data: wallets, error } = await db.from('crypto_wallets').select('id, user_id, account, chain').eq('chain', 'cryptocom');
    if (error) throw new Error(error.message);
    const results = [];
    for (const wallet of wallets ?? []) {
      const estimated = await rebuildCryptoComEstimates(db, wallet);
      const balances = await recomputeExchange(db, wallet as ExchangeWallet, CRYPTOCOM_RULES);
      const { error: refresh } = await db.rpc('request_capital_refresh', { p_user: wallet.user_id });
      if (refresh) throw new Error(refresh.message);
      results.push({ user_id: wallet.user_id, ...estimated, balances: balances.balances });
    }
    return new Response(JSON.stringify({ accounts: results.length, results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
