// Supabase Edge Function: sync-revolutx
//
// Checks Revolut's crypto through the Revolut X API -- balances only. Revolut
// shows one crypto balance in its app and on Revolut X, so Revolut X's
// /balances is the app's crypto too. The history still comes from Revolut's
// crypto statement (import-revolut-crypto): every morning the coins Revolut X
// reports (total: available + staked + reserved) are set against the holdings
// stored from that statement (trades 'revolut_crypto_csv': buys and rewards
// less sells); if they agree, the stored history is up to date; if not,
// crypto was bought, sold or received since the last statement, and the page
// says so (orange, with the coins that differ). Revolut X's own fiat
// balances are left out (they're not the app's). Nothing is written but the
// result.
//
// The key: the page makes an Ed25519 pair, shows the public key to register
// in the Revolut X web app (Profile -> API keys -> read-only) and, with
// Save, sends the API key and the private key into broker_credentials
// (migration ...116): the key in the clear, the private key in Supabase
// Vault. Each request is signed: timestamp (ms) + method + path (+ query +
// body), Ed25519, Base64 -- X-Revx-API-Key / X-Revx-Timestamp /
// X-Revx-Signature.
//
// Two ways in, as the other syncs: the page's Save ({"check": true}: one
// signed request) / "Check now" (the user's JWT), or the daily pg_cron job
// with the cron secret (_shared/cron_auth.ts). Each run's result is kept in
// broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const REVX = 'https://revx.revolut.com';
// The daily job's slots: 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// Revolut X's answers that mean the key itself is no good -- not retried the same day.
const KEY_REFUSED = /Revolut X (401|403)\b|private key/;
const FIAT = new Set(['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'RON', 'CZK', 'HUF', 'SEK', 'NOK', 'DKK', 'BGN']);

async function signer(pem: string) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  } catch (err) {
    throw new Error(`The saved private key doesn't load (${err}) -- make a new key pair on the page`);
  }
}

// deno-lint-ignore no-explicit-any
async function revx(key: string, privateKey: CryptoKey, path: string): Promise<any> {
  const ts = String(Date.now());
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(`${ts}GET${path}`));
  const res = await fetch(REVX + path, { headers: {
    'X-Revx-API-Key': key, 'X-Revx-Timestamp': ts, 'X-Revx-Signature': btoa(String.fromCharCode(...new Uint8Array(sig))),
    'Accept': 'application/json',
  } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) throw new Error(`Revolut X ${res.status} ${body?.message ?? body?.error ?? text.slice(0, 200)} (${path})`);
  return body;
}

const round = (x: number) => Math.round(x * 1e8) / 1e8;

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, key: string, pem: string) {
  const privateKey = await signer(pem);
  const api: Record<string, number> = {};
  for (const b of await revx(key, privateKey, '/api/1.0/balances') ?? []) {
    const coin = String(b.currency ?? '').toUpperCase();
    const q = Number(b.total ?? (Number(b.available ?? 0) + Number(b.staked ?? 0) + Number(b.reserved ?? 0)));
    if (coin && !FIAT.has(coin) && q) api[coin] = round((api[coin] ?? 0) + q);
  }

  // What the stored statement says.
  const stored: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('trades').select('ticker, side, quantity::text').eq('user_id', userId)
      .eq('account', 'Revolut').eq('external_source', 'revolut_crypto_csv').range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const t of data ?? []) {
      const q = Number(t.quantity) * (t.side === 'sell' ? -1 : t.side === 'buy' || t.side === 'stock_as_dividend' ? 1 : 0);
      if (q) stored[t.ticker] = round((stored[t.ticker] ?? 0) + q);
    }
    if (!data || data.length < 1000) break;
  }
  const differences: string[] = [];
  for (const coin of [...new Set([...Object.keys(api), ...Object.keys(stored)])].sort()) {
    const a = api[coin] ?? 0, s = stored[coin] ?? 0;
    if (Math.abs(a - s) > 1e-8) differences.push(`${coin}: Revolut ${a}, stored ${s}`);
  }
  return { balances: api, differences, checked_at: new Date().toISOString().slice(0, 10) };
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

    let q = db.rpc('revolutx_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; api_key: string; private_key: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Revolut X API key: enter it on the page (My portfolio -> Revolut crypto automatic check)' }, 400);
    }
    // The page's Save: one signed request.
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        await revx(picked[0].api_key, await signer(picked[0].private_key), '/api/1.0/balances');
        return json({ ok: true });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't checked today; a
    // failed run is retried by the next, but not a key Revolut X refuses.
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
        result = await syncUser(db, c.user_id, c.api_key, c.private_key);
      } catch (err) {
        result = { error: String(err) };
      }
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 4000) })
        .eq('user_id', c.user_id).eq('broker', 'revolutx');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
