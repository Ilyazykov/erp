// Supabase Edge Function: sync-bybit
//
// Pulls the Bybit account through its API, so no one has to download the
// Data Export transaction logs and upload them (import-bybit). A read-only
// API key (bybit.com -> API Management -> Create New Key -> System-generated,
// Read-Only) is entered on the page (My portfolio -> Bybit automatic sync)
// into broker_credentials (migration ...098): the key in the clear, its
// secret in Supabase Vault.
//
// The same two logs as the CSVs, over the last SYNC_DAYS days (Bybit gives
// at most 7 days a request, so week by week):
//   GET /v5/asset/fundinghistory     -- the Funding account (Earn interest,
//     subscriptions / redemptions, Bybit Card, deposits, transfers, ...)
//   GET /v5/account/transaction-log  -- the Unified Trading account (trades,
//     transfers, Earn moves, small-balance conversions)
// tagged by the rules import-bybit uses (_shared/bybit_rules.ts) into
// wallet_transactions of the account's crypto_wallets row ('UID <uid>',
// created if missing), then every coin's balance recomputed from all stored
// rows, as an upload does. The window's rows are replaced -- deleted, then
// written -- so the CSV rows of those days and the API's never sit side by
// side.
//
// Every run first asks Bybit about the key itself (GET /v5/user/query-api):
// it must be read-only (anything else is refused, nothing is pulled), and its
// end date goes to broker_credentials.token_expires for the page. The page's
// Save asks only that ({"check": true}), so a bad key shows at once.
//
// Bybit refuses US addresses: the page and the daily job ask for the
// project's own region (x-region: eu-west-1).
//
// Two ways in, as sync-ibkr: the page's "Sync now" (the user's JWT -> that
// user), or the daily pg_cron job (no JWT, deployed with --no-verify-jwt ->
// every user with a key, each in a slot of their own, at most RUN_USERS a
// run). Each run's result is kept in broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { dec, recomputeExchange, type ExchangeWallet } from '../_shared/exchange_balances.ts';
import { fundKind, RULES, utaKind } from '../_shared/bybit_rules.ts';

const BYBIT = 'https://api.bybit.com';
const SYNC_DAYS = 30;
const WEEK_MS = 7 * 86400000;
// The daily job's slots (migration ...098): 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// Bybit's answers that mean the key itself is no good -- not retried the same day.
const KEY_REFUSED = /Bybit (10003|10004|10005|33004)\b|not read-only/;

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// A signed GET: timestamp + key + recv window + query string, HMAC-SHA256.
// deno-lint-ignore no-explicit-any
async function bybitGet(key: string, secret: string, path: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const ts = String(Date.now()), recv = '10000';
  const res = await fetch(`${BYBIT}${path}${query ? '?' + query : ''}`, {
    headers: {
      'X-BAPI-API-KEY': key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': await hmac(secret, ts + key + recv + query),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Bybit ${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode} ${body.retMsg} (${path})`);
  return body.result;
}

// Every page of a cursor-paged list.
// deno-lint-ignore no-explicit-any
async function bybitAll(key: string, secret: string, path: string, params: Record<string, string>): Promise<any[]> {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 200; page++) {
    const r = await bybitGet(key, secret, path, cursor ? { ...params, cursor } : params);
    out.push(...(r.list ?? []));
    cursor = r.nextPageCursor || '';
    if (!cursor || !(r.list ?? []).length) break;
  }
  return out;
}

const signed = (amount: string, out: boolean) => {
  const a = dec(String(amount).replace(/^-/, ''));
  return out && a !== '0' ? `-${a}` : a;
};

// The key itself: read-only, its UID, until when (kept for the page).
// deno-lint-ignore no-explicit-any
async function checkKey(db: any, userId: string, key: string, secret: string) {
  const me = await bybitGet(key, secret, '/v5/user/query-api', {});
  const expires = me.expiredAt ? String(me.expiredAt).slice(0, 10) : null;
  await db.from('broker_credentials').update({ token_expires: expires }).eq('user_id', userId).eq('broker', 'bybit');
  if (Number(me.readOnly) !== 1) throw new Error('The API key is not read-only -- create a Read-Only one; nothing was pulled');
  return { uid: String(me.userID), expires };
}

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, key: string, secret: string) {
  const { uid, expires } = await checkKey(db, userId, key, secret);

  // Both logs, week by week back from now. Fetched in full before anything
  // is replaced.
  const now = Date.now(), from = now - SYNC_DAYS * 86400000;
  const rows: { tx_hash: string; seq: number; kind: string; tx_time: string; symbol: string; amount: string; status: string }[] = [];
  for (let end = now; end > from; end -= WEEK_MS) {
    const start = Math.max(from, end - WEEK_MS + 1);
    for (const f of await bybitAll(key, secret, '/v5/asset/fundinghistory',
      { createTimeFrom: String(Math.floor(start / 1000)), createTimeTo: String(Math.floor(end / 1000)), limit: '100' })) {
      const type = f.showBusiTypeEn || '', desc = f.descriptionEn || '';
      rows.push({
        tx_hash: `fund|api|${f.currcCursor}`, seq: 0, kind: fundKind(desc, type, f.currency),
        tx_time: new Date(Number(f.createTime) * 1000).toISOString(), symbol: f.currency,
        amount: signed(f.txnAmt, f.ioDirection === 'O'), status: `${type} | ${desc} | balance ${dec(String(f.afterAmt))}`,
      });
    }
    for (const u of await bybitAll(key, secret, '/v5/account/transaction-log',
      { accountType: 'UNIFIED', startTime: String(start), endTime: String(end), limit: '50' })) {
      rows.push({
        tx_hash: `uta|api|${u.id}`, seq: 0, kind: utaKind(u.type || ''),
        tx_time: new Date(Number(u.transactionTime)).toISOString(), symbol: u.currency,
        amount: dec(String(u.change)), status: `${u.type}${u.symbol ? ' ' + u.symbol : ''} | balance ${dec(String(u.cashBalance))}`,
      });
    }
  }

  // The account's crypto_wallets row, as an upload creates it.
  const address = `UID ${uid}`;
  let { data: wallet, error: wErr } = await db.from('crypto_wallets')
    .select('id, user_id, account, chain').eq('user_id', userId).eq('chain', 'bybit').eq('address', address).maybeSingle();
  if (wErr) throw new Error(wErr.message);
  if (!wallet) {
    const ins = await db.from('crypto_wallets').insert({ user_id: userId, chain: 'bybit', address, account: 'Bybit' })
      .select('id, user_id, account, chain').single();
    if (ins.error) throw new Error(ins.error.message);
    wallet = ins.data;
  }

  // The window's rows replaced: the CSVs' and the last run's.
  const fromIso = new Date(from).toISOString();
  for (const prefix of ['fund|%', 'uta|%']) {
    const { error } = await db.from('wallet_transactions').delete()
      .eq('wallet_id', wallet.id).gte('tx_time', fromIso).like('tx_hash', prefix);
    if (error) throw new Error(error.message);
  }
  // Lines sharing an id (pages overlapping at a week's edge, or one id for
  // two legs) numbered apart, as one upsert can't write a key twice.
  const seen = new Map<string, number>();
  const stored = rows.map(r => {
    const k = `${r.tx_hash}|${r.kind}|${r.symbol}|${r.amount}|${r.tx_time}`;
    return { ...r, seq: 0, key: k };
  }).filter(r => !seen.has(r.key) && seen.set(r.key, 0)).map(({ key: _k, ...r }) => {
    const id = `${r.tx_hash}|${r.kind}`, n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return { ...r, seq: n, wallet_id: wallet.id, user_id: userId, chain: 'bybit', contract: '', decimals: null, counterparty: null };
  });
  for (let i = 0; i < stored.length; i += 500) {
    const { error } = await db.from('wallet_transactions').upsert(stored.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq' });
    if (error) throw new Error(error.message);
  }
  const r = await recomputeExchange(db, wallet as ExchangeWallet, RULES);
  const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
  if (rq) throw new Error(rq.message);

  return {
    period: `${fromIso.slice(0, 10)}..${new Date(now).toISOString().slice(0, 10)}`, uid, key_expires: expires,
    funding_rows: rows.filter(x => x.tx_hash.startsWith('fund')).length,
    unified_rows: rows.filter(x => x.tx_hash.startsWith('uta')).length,
    balances: r.balances,
  };
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

    let q = db.rpc('bybit_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; api_key: string; api_secret: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Bybit API key: enter it on the page (My portfolio -> Bybit automatic sync)' }, 400);
    }
    // The page's Save: the key checked with Bybit, nothing pulled.
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        const { uid, expires } = await checkKey(db, userId, picked[0].api_key, picked[0].api_secret);
        return json({ uid, key_expires: expires });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't synced today; a
    // failed run is retried by the next, but not a key Bybit refuses.
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
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 2000) })
        .eq('user_id', c.user_id).eq('broker', 'bybit');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
