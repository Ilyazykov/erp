// Supabase Edge Function: sync-wise
//
// Pulls the Wise account through Wise's own API -- taking precedence over
// Enable Banking (decided 25.10.2026: with it set up, sync-openbanking leaves
// Wise alone, and this removes Enable Banking's Wise rows). A personal API
// token (Wise -> Settings -> API tokens, read only) and an RSA key pair (made
// by the page: the public key uploaded in Wise -> API tokens -> Manage public
// keys, the private key in Supabase Vault -- migration ...120).
//
// Every run, for each currency balance of the personal profile
// (/v4/profiles/{id}/balances): its balance statement
// (/v1/profiles/{id}/balance-statements/{balance}/statement.json) from a
// month before the latest uploaded Wise statement to now. In the EEA the
// statement asks for Strong Customer Authentication: a 403 with a one-time
// token in x-2fa-approval, signed with the private key (SHA256withRSA,
// Base64) and sent back with the same request (X-2FA-Approval, X-Signature).
// Before anything is written, two checks:
//   - the month before the statement's end: every stored statement row
//     (wise_csv, keyed by Wise's own id -- the API's referenceNumber) is in
//     the API with the same amount, and every API transaction up to 3 days
//     before the statement's end is stored;
//   - the balance: the statement's last balance plus what's written is
//     Wise's balance now.
// Else nothing is replaced and the differences come back. What's after the
// statement goes to bank_transactions 'wise_api' (a running balance per
// currency from 0 on top of the statement's, as the other API rows; a Wise
// statement uploaded later takes its period back: import-wise-statement).
//
// Two ways in, as the other syncs: the page's Save ({"check": true}: the
// token and the key, nothing written) / "Sync now" (the user's JWT), or the
// daily pg_cron job with the cron secret (_shared/cron_auth.ts). Each run's
// result is kept in broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { OPENBANKING_SOURCE, WISE_API_SOURCE } from '../_shared/openbanking_rows.ts';

const WISE = 'https://api.wise.com';
const CHECK_DAYS = 30, EDGE_DAYS = 3;
// The daily job's slots: 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// Wise's answers that mean the token or the key is no good -- not retried the same day.
const KEY_REFUSED = /Wise 401\b|private key|SCA refused/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const round2 = (x: number) => Math.round(x * 100) / 100;

async function signer(pem: string) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (err) {
    throw new Error(`The saved private key doesn't load (${err}) -- make a new key pair on the page`);
  }
}

// A GET, answering Wise's SCA challenge with the signed one-time token.
// deno-lint-ignore no-explicit-any
async function wise(token: string, key: CryptoKey | null, path: string): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let res = await fetch(WISE + path, { headers });
  const ott = res.headers.get('x-2fa-approval');
  if (res.status === 403 && ott) {
    if (!key) throw new Error('Wise asks for SCA and no private key is saved -- make a key pair on the page');
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(ott));
    res = await fetch(WISE + path, { headers: { ...headers, 'X-2FA-Approval': ott, 'X-Signature': btoa(String.fromCharCode(...new Uint8Array(sig))) } });
    if (res.status === 403) throw new Error('Wise SCA refused the signature -- is the public key uploaded (API tokens -> Manage public keys)?');
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) throw new Error(`Wise ${res.status} ${body?.errors?.[0]?.message ?? body?.message ?? body?.error ?? text.slice(0, 200)} (${path.split('?')[0]})`);
  return body;
}

type Tx = { id: string; at: string; day: string; amount: number; currency: string; desc: string; fee: number };

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, token: string, pem: string | null, checkOnly: boolean) {
  const key = pem ? await signer(pem) : null;
  // deno-lint-ignore no-explicit-any
  const profile = ((await wise(token, key, '/v2/profiles')) ?? []).find((p: any) => String(p.type).toUpperCase() === 'PERSONAL');
  if (!profile) throw new Error('No personal profile on this Wise token');
  // deno-lint-ignore no-explicit-any
  const balances: any[] = (await wise(token, key, `/v4/profiles/${profile.id}/balances?types=STANDARD`)) ?? [];

  const { data: ups, error: uErr } = await db.from('statement_uploads').select('period_to')
    .eq('user_id', userId).eq('account', 'Wise').eq('kind', 'wise').order('period_to', { ascending: false }).limit(1);
  if (uErr) throw new Error(uErr.message);
  const lastEnd: string | null = ups?.[0]?.period_to ?? null;
  if (!lastEnd) throw new Error('No Wise statement uploaded yet -- the API\'s rows go on top of one');
  const checkFrom = addDays(lastEnd, -CHECK_DAYS), edge = addDays(lastEnd, -EDGE_DAYS);

  const write: Tx[] = [];
  const diffs: string[] = [];
  const result: Record<string, unknown> = {};
  let matched = 0;
  for (const b of balances) {
    const ccy = String(b.currency ?? b.amount?.currency ?? '').toUpperCase();
    const now = new Date().toISOString();
    const st = await wise(token, key, `/v1/profiles/${profile.id}/balance-statements/${b.id}/statement.json?currency=${ccy}`
      + `&intervalStart=${checkFrom}T00:00:00.000Z&intervalEnd=${now}&type=COMPACT`);
    if (checkOnly) { result[ccy] = { statement_rows: (st.transactions ?? []).length }; continue; }
    // deno-lint-ignore no-explicit-any
    const api: Tx[] = (st.transactions ?? []).map((t: any) => {
      const v = Number(t.amount?.value ?? 0);
      const at = new Date(t.date).toISOString();
      return { id: String(t.referenceNumber ?? ''), at, day: at.slice(0, 10), currency: ccy,
        amount: round2(String(t.type).toUpperCase() === 'DEBIT' ? -Math.abs(v) : v),
        desc: String(t.details?.description ?? t.details?.type ?? '').slice(0, 500), fee: Number(t.totalFees?.value ?? 0) };
    });
    const { data: stored, error: sErr } = await db.from('bank_transactions').select('external_id, amount, tx_date')
      .eq('user_id', userId).eq('external_source', 'wise_csv').eq('currency', ccy).gte('tx_date', `${checkFrom}T00:00:00Z`);
    if (sErr) throw new Error(sErr.message);
    const { data: lastRow, error: lErr } = await db.from('bank_transactions').select('balance_after')
      .eq('user_id', userId).eq('external_source', 'wise_csv').eq('currency', ccy).order('tx_date', { ascending: false }).limit(1);
    if (lErr) throw new Error(lErr.message);
    const storedBalance = Number(lastRow?.[0]?.balance_after ?? 0);

    const byId = new Map(api.map(t => [t.id, t]));
    const storedIds = new Set<string>();
    for (const r of stored ?? []) {
      storedIds.add(r.external_id);
      const t = byId.get(r.external_id);
      if (t && Math.abs(t.amount - Number(r.amount)) < 0.005) { matched++; continue; }
      diffs.push(t ? `${ccy} ${r.external_id}: statement ${r.amount}, API ${t.amount}` : `${ccy} statement ${String(r.tx_date).slice(0, 10)} ${r.amount} ${r.external_id} not in the API`);
    }
    for (const t of api) {
      if (storedIds.has(t.id) || t.amount === 0) continue;
      if (t.day <= edge) diffs.push(`${ccy} API ${t.day} ${t.amount} "${t.desc.slice(0, 30)}" (${t.id}) not in the statement`);
      else write.push(t);   // after the statement, or at its very end and not in it
    }
    const added = round2(write.filter(t => t.currency === ccy).reduce((a, t) => a + t.amount, 0));
    const expected = round2(storedBalance + added);
    const actual = round2(Number(b.amount?.value ?? b.cashAmount?.value ?? 0));
    result[ccy] = { statement: storedBalance, added, expected, wise: actual };
    if (Math.abs(expected - actual) > 0.011) diffs.push(`${ccy} balance: statement ${storedBalance} + API ${added} = ${expected}, Wise says ${actual}`);
  }
  if (checkOnly) return { profile: profile.id, balances: result };
  if (diffs.length) throw new Error(`Not understood -- nothing replaced. ${diffs.length} differences (after the statement of ${lastEnd}): ${diffs.slice(0, 8).join('; ')}`);

  // Replace: this API's rows (and Enable Banking's Wise rows, which it supersedes).
  for (const src of [WISE_API_SOURCE, OPENBANKING_SOURCE.Wise]) {
    const { error } = await db.from('bank_transactions').delete().eq('user_id', userId).eq('external_source', src);
    if (error) throw new Error(error.message);
  }
  const bal: Record<string, number> = {};
  const rows = write.sort((p, q) => p.at.localeCompare(q.at)).map(t => {
    bal[t.currency] = round2((bal[t.currency] ?? 0) + t.amount);
    return { user_id: userId, account: 'Wise', tx_date: t.at, booked_at: t.at, description: t.desc || '(no description)', counterparty: null,
      amount: t.amount, currency: t.currency, category: null, balance_after: bal[t.currency], synthetic: false, synthetic_kind: null,
      note: t.fee ? `Total fees ${t.fee}` : null, external_source: WISE_API_SOURCE, external_id: t.id || `${t.at}:${t.amount}` };
  });
  if (rows.length) {
    const { error } = await db.from('bank_transactions').upsert(rows, { onConflict: 'user_id,external_source,external_id' });
    if (error) throw new Error(error.message);
  }
  const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
  if (rq) throw new Error(rq.message);
  return { after_statement: lastEnd, written: rows.length, checked: { window: `${checkFrom}..${lastEnd}`, matched }, balances: result,
    period_to: new Date().toISOString().slice(0, 10) };
}

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
    // Without a user: only the daily job, with the cron secret.
    if (!userId && !(await fromCron(req))) return notFromCron();

    let q = db.rpc('wise_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; token: string; private_key: string | null; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Wise API token: enter it on the page (My portfolio -> Wise automatic sync)' }, 400);
    }
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        return json(await syncUser(db, userId, picked[0].token, picked[0].private_key, true));
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't synced today; a
    // failed run is retried by the next, but not a token Wise refuses.
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
        result = await syncUser(db, c.user_id, c.token, c.private_key, false);
      } catch (err) {
        result = { error: String(err) };
      }
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 4000) })
        .eq('user_id', c.user_id).eq('broker', 'wise');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
