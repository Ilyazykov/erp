// Supabase Edge Function: sync-binance
//
// Checks the Binance account through its API -- balances only. The account's
// history still comes from Binance's own export (import-binance): the API has
// no one history of it (deposits, withdrawals, trades per symbol, Convert,
// Earn, dust, P2P, Pay are each a method of their own), and the account is
// hardly used. So every morning the coins on it -- Spot, Funding, Simple
// Earn (flexible and locked) -- are set against the balances stored from the
// export (wallet_balances): if they agree, the stored history is up to date;
// if not, the account was used since the last export, and the page says so
// (orange, with the coins that differ). Nothing is written but the result.
//
// A read-only key (API Management -> Create API -> System generated, only
// "Enable Reading") is entered on the page (My portfolio -> Binance automatic
// check) into broker_credentials (migration ...106): the key in the clear,
// its secret in Supabase Vault. A key allowed anything but reading (trading,
// withdrawals, transfers, margin, futures, options) is refused.
//
// Binance refuses US addresses: the page and the daily job ask for the
// project's own region (x-region: eu-west-1).
//
// Two ways in, as the other syncs: the page's Save ({"check": true}: the key
// only) / "Sync now" (the user's JWT), or the daily pg_cron job with the cron
// secret (_shared/cron_auth.ts). Each run's result is kept in
// broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const BINANCE = 'https://api.binance.com';
// The daily job's slots: 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// Binance's answers that mean the key itself is no good -- not retried the same day.
const KEY_REFUSED = /Binance -(2008|2014|2015)\b|not read-only/;

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// A signed request: the query with timestamp and recvWindow, its HMAC-SHA256 appended.
// deno-lint-ignore no-explicit-any
async function binance(key: string, secret: string, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<any> {
  const query = new URLSearchParams({ ...params, recvWindow: '10000', timestamp: String(Date.now()) }).toString();
  const res = await fetch(`${BINANCE}${path}?${query}&signature=${await hmac(secret, query)}`, { method, headers: { 'X-MBX-APIKEY': key } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Binance ${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || (body && typeof body.code === 'number' && body.code < 0)) throw new Error(`Binance ${body?.code ?? res.status} ${body?.msg ?? ''} (${path})`);
  return body;
}

const round = (x: number) => Math.round(x * 1e8) / 1e8;

async function checkKey(key: string, secret: string) {
  const r = await binance(key, secret, 'GET', '/sapi/v1/account/apiRestrictions');
  const allowed = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableSpotAndMarginTrading',
    'enableMargin', 'enableFutures', 'enableVanillaOptions', 'enablePortfolioMarginTrading', 'enableFixApiTrade'].filter(k => r[k] === true);
  if (allowed.length) throw new Error(`The API key is not read-only (allowed: ${allowed.join(', ')}) -- create one with only "Enable Reading"; nothing was checked`);
  if (r.enableReading !== true) throw new Error('The API key cannot read -- tick "Enable Reading"');
}

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, key: string, secret: string) {
  await checkKey(key, secret);
  // The coins on the account, every wallet summed.
  const api: Record<string, number> = {};
  const add = (asset: string, q: number) => { if (asset && q) api[asset] = round((api[asset] ?? 0) + q); };
  const spot = await binance(key, secret, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
  // (LD<coin> on Spot is the coin in Simple Earn, counted from Earn below)
  for (const b of spot.balances ?? []) if (!/^LD/.test(b.asset)) add(b.asset, Number(b.free) + Number(b.locked));
  for (const b of await binance(key, secret, 'POST', '/sapi/v1/asset/get-funding-asset')) add(b.asset, Number(b.free) + Number(b.locked) + Number(b.freeze ?? 0) + Number(b.withdrawing ?? 0));
  for (const b of (await binance(key, secret, 'GET', '/sapi/v1/simple-earn/flexible/position', { size: '100' })).rows ?? []) add(b.asset, Number(b.totalAmount));
  for (const b of (await binance(key, secret, 'GET', '/sapi/v1/simple-earn/locked/position', { size: '100' })).rows ?? []) add(b.asset, Number(b.amount));
  const uid = String(spot.uid ?? '');

  // What the stored export says (wallet_balances of the account's crypto_wallets row).
  let wq = db.from('crypto_wallets').select('id, address').eq('user_id', userId).eq('chain', 'binance');
  if (uid) wq = wq.eq('address', `UID ${uid}`);
  const { data: wallets, error: wErr } = await wq;
  if (wErr) throw new Error(wErr.message);
  const stored: Record<string, number> = {};
  if (wallets?.length) {
    const { data: bal, error } = await db.from('wallet_balances').select('symbol, quantity::text').in('wallet_id', wallets.map((w: { id: string }) => w.id));
    if (error) throw new Error(error.message);
    for (const b of bal ?? []) {
      const coin = String(b.symbol).replace(/ \(Earn\)$/, '');
      stored[coin] = round((stored[coin] ?? 0) + Number(b.quantity));
    }
  }
  const differences: string[] = [];
  for (const coin of [...new Set([...Object.keys(api), ...Object.keys(stored)])].sort()) {
    const a = api[coin] ?? 0, s = stored[coin] ?? 0;
    if (Math.abs(a - s) > 1e-8) differences.push(`${coin}: Binance ${a}, stored ${s}`);
  }
  return { uid: uid || null, wallet_found: !!wallets?.length, balances: api, differences, checked_at: new Date().toISOString().slice(0, 10) };
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
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
    // Without a user: only the daily job, with the cron secret.
    if (!userId && !(await fromCron(req))) return notFromCron();

    let q = db.rpc('binance_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; api_key: string; api_secret: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Binance API key: enter it on the page (My portfolio -> Binance automatic check)' }, 400);
    }
    // The page's Save: the key only.
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        await checkKey(picked[0].api_key, picked[0].api_secret);
        return json({ read_only: true });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't checked today; a
    // failed run is retried by the next, but not a key Binance refuses.
    const nowSlot = Math.floor((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() - SLOT_START_MIN) / SLOT_MINUTES);
    if (!userId) {
      const today = new Date().toISOString().slice(0, 10);
      const syncedToday = (c: Cred) => !!c.last_sync_at && c.last_sync_at.slice(0, 10) >= today
        && (!(c.last_sync_result || '').startsWith('{"error"') || KEY_REFUSED.test(c.last_sync_result || ''));
      picked = picked.filter(c => slotOf(c.user_id) <= nowSlot && !syncedToday(c))
        .sort((a, b) => slotOf(a.user_id) - slotOf(b.user_id)).slice(0, RUN_USERS);
      if (!picked.length) return json({ users: 0, slot: nowSlot });
    }

    const results = [];
    for (const c of picked) {
      let result: Record<string, unknown>;
      try {
        result = await syncUser(db, c.user_id, c.api_key, c.api_secret);
      } catch (err) {
        result = { error: String(err) };
      }
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 4000) })
        .eq('user_id', c.user_id).eq('broker', 'binance');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
