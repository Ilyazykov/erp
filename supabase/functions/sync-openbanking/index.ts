// Supabase Edge Function: sync-openbanking
//
// Open Banking (PSD2) through Enable Banking for the banks without an API
// of their own -- Revolut, Bank of Cyprus; Wise too, until its own API (with
// precedence over this) is in. The user registers an application
// in the Enable Banking Control Panel (restricted mode: only the accounts the
// user links there, free for personal use), and enters its id and private
// key (.pem) on the page (My portfolio -> Revolut & Bank of Cyprus) into
// broker_credentials (migration ...107): the key in Supabase Vault. Every
// API call is signed with it (a JWT, RS256, an hour at most).
//
// A bank is connected from the page ({"action": "connect", "bank": ...}):
// Enable Banking gives the link to the bank's consent page, the page sends
// the user there, the bank sends them back to the page with a code, which
// becomes a session ({"action": "session", "code", "state"}) kept as
// broker_credentials 'eb:<bank>' ('eb:revolut', 'eb:boc', 'eb:wise') with the day the consent ends (the bank's
// maximum, 180 days at most) -- the page shows it, a week before in orange.
//
// For now a look only: each run reads every account of each session -- its
// details, balance and the last weeks' transactions -- and keeps a summary
// in last_sync_result; nothing is written to the money tables yet. What the
// banks give decides how their rows are written next to the statements.
//
// Two ways in, as the other syncs: the page (the user's JWT: Save with
// {"check": true}, connect, session, "Sync now"), or the daily pg_cron job
// with the cron secret (_shared/cron_auth.ts).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const EB = 'https://api.enablebanking.com';
const REDIRECT = 'https://ilyazykov.github.io/erp/';
const BANKS: Record<string, { name: string; country: string; label: string }> = {
  revolut: { name: 'Revolut', country: 'LT', label: 'Revolut' },
  boc: { name: 'Bank of Cyprus', country: 'CY', label: 'Bank of Cyprus' },
  // until Wise's own API is in -- it'll take precedence over this
  wise: { name: 'Wise', country: 'BE', label: 'Wise' },
};
const MAX_CONSENT_S = 180 * 86400;
const LOOK_DAYS = 35;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

// The application's JWT: RS256 with its private key (PKCS#8 PEM, as the Control Panel exports it).
async function jwtOf(appId: string, pem: string): Promise<string> {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) throw new Error('The key is PKCS#1 ("BEGIN RSA PRIVATE KEY"); convert it: openssl pkcs8 -topk8 -nocrypt -in key.pem');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const head = `${b64urlText(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }))}.${b64urlText(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head)));
  return `${head}.${b64url(sig)}`;
}

// deno-lint-ignore no-explicit-any
async function eb(jwt: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const res = await fetch(EB + path, {
    method, headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`Enable Banking ${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`Enable Banking ${res.status} ${out?.error ?? ''} ${out?.message ?? ''} ${out?.detail ? JSON.stringify(out.detail).slice(0, 200) : ''} (${path})`.trim());
  return out;
}

// A look at one session: each account's details, balance and recent transactions.
// deno-lint-ignore no-explicit-any
async function lookAt(jwt: string, sessionId: string): Promise<Record<string, unknown>> {
  const s = await eb(jwt, 'GET', `/sessions/${sessionId}`);
  const from = new Date(Date.now() - LOOK_DAYS * 86400000).toISOString().slice(0, 10);
  const accounts = [];
  for (const uid of s.accounts ?? []) {
    const a: Record<string, unknown> = { uid: String(uid).slice(0, 8) };
    try {
      const d = await eb(jwt, 'GET', `/accounts/${uid}/details`);
      Object.assign(a, { currency: d.currency, type: d.cash_account_type, product: d.product, name: d.name, iban_tail: String(d.account_id?.iban ?? '').slice(-6) });
    } catch (err) { a.details = String(err).slice(0, 120); }
    try {
      const b = await eb(jwt, 'GET', `/accounts/${uid}/balances`);
      a.balances = (b.balances ?? []).slice(0, 3).map((x: { balance_type: string; balance_amount: { amount: string; currency: string } }) =>
        `${x.balance_type} ${x.balance_amount?.amount} ${x.balance_amount?.currency}`);
    } catch (err) { a.balances = String(err).slice(0, 120); }
    try {
      const t = await eb(jwt, 'GET', `/accounts/${uid}/transactions?date_from=${from}`);
      const list = t.transactions ?? [];
      a.transactions = list.length + (t.continuation_key ? '+' : '');
      // deno-lint-ignore no-explicit-any
      a.samples = list.slice(0, 3).map((x: any) => [x.booking_date ?? x.transaction_date ?? x.value_date, x.status, x.credit_debit_indicator,
        x.transaction_amount?.amount, x.transaction_amount?.currency, x.entry_reference ? 'ref' : 'no-ref',
        x.balance_after_transaction ? `bal ${x.balance_after_transaction.amount}` : 'no-bal',
        String((x.remittance_information ?? []).join(' ') || x.creditor?.name || x.debtor?.name || '').slice(0, 40)].join(' | '));
    } catch (err) { a.transactions = String(err).slice(0, 160); }
    accounts.push(a);
  }
  return { status: s.status, valid_until: s.access?.valid_until ?? null, accounts };
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

    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      userId = (await asUser.auth.getUser()).data.user?.id ?? null;
    }
    // Without a user: only the daily job, with the cron secret.
    if (!userId && !(await fromCron(req))) return notFromCron();

    let q = db.rpc('enablebanking_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    const apps = (creds ?? []) as { user_id: string; app_id: string; private_key: string }[];
    if (!apps.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Enable Banking application: enter its id and key on the page (My portfolio -> Revolut & Bank of Cyprus)' }, 400);
    }
    const body = await req.json().catch(() => ({}));

    if (userId) {
      const app = apps[0];
      let jwt: string;
      try { jwt = await jwtOf(app.app_id, app.private_key); } catch (err) { return json({ error: `The key doesn't load: ${String(err)}` }, 400); }
      // Save: the application, as Enable Banking sees it.
      if (body.check) {
        try {
          const a = await eb(jwt, 'GET', '/application');
          return json({ name: a.name, active: a.active, environment: a.environment, countries: a.countries });
        } catch (err) { return json({ error: String(err) }, 400); }
      }
      // Connect a bank: the link to its consent page.
      if (body.action === 'connect') {
        const bank = BANKS[body.bank];
        if (!bank) return json({ error: `Unknown bank ${body.bank}` }, 400);
        try {
          const { aspsps = [] } = await eb(jwt, 'GET', `/aspsps?country=${bank.country}&psu_type=personal&service=AIS`);
          // deno-lint-ignore no-explicit-any
          const a = aspsps.find((x: any) => x.name.toLowerCase() === bank.name.toLowerCase()) ?? aspsps.find((x: any) => x.name.toLowerCase().includes(bank.name.toLowerCase()));
          if (!a) return json({ error: `${bank.name} isn't in Enable Banking's list for ${bank.country}` }, 400);
          const seconds = Math.min(Number(a.maximum_consent_validity) || MAX_CONSENT_S, MAX_CONSENT_S) - 600;
          const r = await eb(jwt, 'POST', '/auth', {
            access: { valid_until: new Date(Date.now() + seconds * 1000).toISOString(), balances: true, transactions: true },
            aspsp: { name: a.name, country: bank.country }, state: body.bank, redirect_url: REDIRECT, psu_type: 'personal',
          });
          return json({ url: r.url });
        } catch (err) { return json({ error: String(err) }, 400); }
      }
      // Back from the bank: the code becomes the bank's session.
      if (body.action === 'session') {
        const bank = BANKS[body.state];
        if (!bank || !body.code) return json({ error: 'Unknown return from the bank' }, 400);
        try {
          const s = await eb(jwt, 'POST', '/sessions', { code: body.code });
          const until = String(s.access?.valid_until ?? '').slice(0, 10) || null;
          const { error } = await db.from('broker_credentials').upsert({
            user_id: userId, broker: `eb:${body.state}`, query_id: s.session_id, token_expires: until, updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,broker' });
          if (error) throw new Error(error.message);
          return json({ bank: bank.label, accounts: (s.accounts ?? []).length, valid_until: until });
        } catch (err) { return json({ error: String(err) }, 400); }
      }
    }

    // A look at every session (the page's "Sync now": the user's; the daily job: everyone's).
    const results = [];
    for (const app of apps) {
      const { data: sessions, error } = await db.from('broker_credentials').select('broker, query_id')
        .eq('user_id', app.user_id).like('broker', 'eb:%');
      if (error) throw new Error(error.message);
      let jwt = '';
      try { jwt = await jwtOf(app.app_id, app.private_key); } catch { /* reported per session below */ }
      for (const s of sessions ?? []) {
        let result: Record<string, unknown>;
        try {
          if (!jwt) throw new Error("The application's key doesn't load");
          result = await lookAt(jwt, s.query_id);
        } catch (err) { result = { error: String(err) }; }
        let kept = JSON.stringify(result);
        if (kept.length > 4000) kept = JSON.stringify({ ...result, accounts: (result.accounts as unknown[] | undefined)?.length });
        await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: kept })
          .eq('user_id', app.user_id).eq('broker', s.broker);
        results.push({ bank: s.broker.slice(3), ...result });
      }
    }
    if (userId) return json({ sessions: results });
    return json({ users: apps.length, sessions: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
