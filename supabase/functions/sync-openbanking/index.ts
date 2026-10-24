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
// Each run takes, for every account (one per currency) of each session, the
// booked transactions after the bank's latest statement (statement_uploads)
// into bank_transactions 'openbanking_<bank>' -- a running balance per
// currency from 0 on top of the statement's, as the app rows of other banks
// have it; a statement uploaded later takes its period back
// (_shared/openbanking_rows.ts). Pending ones (Revolut's PDNG) wait until
// they're booked. Before anything is written two checks, per bank:
//   - the month before the statement's end: every stored statement row and
//     every booked API transaction pair up (same currency and amount, at most
//     3 days apart); the statement's last 3 days are where an export can end
//     mid-day, so a transaction there found only in the API is written too;
//   - the balance: the statement's own last balance plus what the API adds
//     (and, for an available balance, the pending ones) is the bank's balance
//     now.
// Else nothing of that bank is replaced and the differences come back.
//
// Two ways in, as the other syncs: the page (the user's JWT: Save with
// {"check": true}, connect, session, "Sync now"), or the daily pg_cron job
// with the cron secret (_shared/cron_auth.ts).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { OPENBANKING_SOURCE } from '../_shared/openbanking_rows.ts';

const EB = 'https://api.enablebanking.com';
const REDIRECT = 'https://ilyazykov.github.io/erp/';
// name / country: the bank at Enable Banking; label: the account here; base /
// kind: its statement rows' source and statement_uploads kind
const BANKS: Record<string, { name: string; country: string; label: string; base: string; kind: string }> = {
  revolut: { name: 'Revolut', country: 'LT', label: 'Revolut', base: 'revolut_csv', kind: 'revolut_account' },
  boc: { name: 'Bank of Cyprus', country: 'CY', label: 'Bank of Cyprus', base: 'boc_csv', kind: 'boc_account' },
  // until Wise's own API is in -- it'll take precedence over this
  wise: { name: 'Wise', country: 'BE', label: 'Wise', base: 'wise_csv', kind: 'wise' },
};
const MAX_CONSENT_S = 180 * 86400;
const CHECK_DAYS = 30, EDGE_DAYS = 3;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const round2 = (x: number) => Math.round(x * 100) / 100;

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

type Tx = { day: string; amount: number; currency: string; ref: string; desc: string; status: string };

// One bank's session: checked against its statements, then its rows replaced.
// deno-lint-ignore no-explicit-any
async function syncBank(db: any, userId: string, jwt: string, bankKey: string, sessionId: string): Promise<Record<string, unknown>> {
  const bank = BANKS[bankKey];
  const src = OPENBANKING_SOURCE[bank.label];
  const s = await eb(jwt, 'GET', `/sessions/${sessionId}`);
  if (s.status !== 'AUTHORIZED') throw new Error(`The consent is ${s.status} -- connect ${bank.label} again`);

  // The latest statement's end.
  const { data: ups, error: uErr } = await db.from('statement_uploads').select('period_to')
    .eq('user_id', userId).eq('account', bank.label).eq('kind', bank.kind).order('period_to', { ascending: false }).limit(1);
  if (uErr) throw new Error(uErr.message);
  let lastEnd: string | null = ups?.[0]?.period_to ?? null;
  if (!lastEnd) {
    const { data: last } = await db.from('bank_transactions').select('tx_date').eq('user_id', userId)
      .eq('external_source', bank.base).order('tx_date', { ascending: false }).limit(1);
    lastEnd = last?.[0] ? String(last[0].tx_date).slice(0, 10) : null;
  }
  if (!lastEnd) throw new Error(`No ${bank.label} statement uploaded yet -- the API's rows go on top of one`);
  const checkFrom = addDays(lastEnd, -CHECK_DAYS), edge = addDays(lastEnd, -EDGE_DAYS);

  const write: Tx[] = [];
  const diffs: string[] = [];
  const balances: Record<string, unknown> = {};
  let matched = 0, pendingCount = 0;
  for (const uid of s.accounts ?? []) {
    const d = await eb(jwt, 'GET', `/accounts/${uid}/details`);
    const ccy = String(d.currency ?? '').toUpperCase();
    // every transaction since the check window, page by page
    const txs: Tx[] = [];
    let key = '';
    for (let page = 0; page < 50; page++) {
      const r = await eb(jwt, 'GET', `/accounts/${uid}/transactions?date_from=${checkFrom}${key ? `&continuation_key=${encodeURIComponent(key)}` : ''}`);
      // deno-lint-ignore no-explicit-any
      for (const x of r.transactions ?? [] as any[]) {
        const a = Number(x.transaction_amount?.amount);
        if (!Number.isFinite(a)) continue;
        txs.push({
          day: String(x.booking_date ?? x.value_date ?? x.transaction_date ?? '').slice(0, 10),
          amount: round2(x.credit_debit_indicator === 'DBIT' ? -Math.abs(a) : Math.abs(a)),
          currency: String(x.transaction_amount?.currency ?? ccy).toUpperCase(), ref: String(x.entry_reference ?? ''),
          desc: String((x.remittance_information ?? []).join(' ') || x.creditor?.name || x.debtor?.name || '').trim().slice(0, 500),
          status: String(x.status ?? 'BOOK'),
        });
      }
      key = r.continuation_key ?? '';
      if (!key) break;
    }
    const booked = txs.filter(x => x.status === 'BOOK' && x.day);
    const pending = txs.filter(x => x.status === 'PDNG');
    pendingCount += pending.length;

    // The statement's rows of the window, and its last balance.
    const { data: stored, error: sErr } = await db.from('bank_transactions').select('amount, tx_date, booked_at, description')
      .eq('user_id', userId).eq('external_source', bank.base).eq('currency', ccy).is('synthetic_kind', null)
      .gte('tx_date', `${checkFrom}T00:00:00Z`);
    if (sErr) throw new Error(sErr.message);
    const { data: lastRow, error: lErr } = await db.from('bank_transactions').select('balance_after')
      .eq('user_id', userId).eq('external_source', bank.base).eq('currency', ccy)
      .order('booked_at', { ascending: false, nullsFirst: false }).order('tx_date', { ascending: false }).limit(1);
    if (lErr) throw new Error(lErr.message);
    const storedBalance = Number(lastRow?.[0]?.balance_after ?? 0);

    // Pair the statement's rows with the API's (amount, at most 3 days apart).
    const used = new Set<number>();
    const dayOf = (r: { booked_at: string | null; tx_date: string }) => String(r.booked_at ?? r.tx_date).slice(0, 10);
    for (const r of (stored ?? []).sort((p: { tx_date: string }, q: { tx_date: string }) => p.tx_date.localeCompare(q.tx_date))) {
      const day = dayOf(r);
      const i = booked.findIndex((x, n) => !used.has(n) && Math.abs(x.amount - Number(r.amount)) < 0.005
        && Math.abs(Date.parse(x.day) - Date.parse(day)) <= EDGE_DAYS * 86400000);
      if (i >= 0) { used.add(i); matched++; continue; }
      if (day <= edge) diffs.push(`${ccy} statement ${day} ${r.amount} "${String(r.description ?? '').slice(0, 30)}" not in the API`);
    }
    booked.forEach((x, n) => {
      if (used.has(n) || x.day < checkFrom) return;
      if (x.day <= edge) diffs.push(`${ccy} API ${x.day} ${x.amount} "${x.desc.slice(0, 30)}" not in the statement`);
      else write.push(x);   // after the statement, or at its very end and not in it
    });

    // The balance: the statement's plus what's written now (plus the pending, for an available balance).
    const b = await eb(jwt, 'GET', `/accounts/${uid}/balances`);
    // deno-lint-ignore no-explicit-any
    const pick = (types: string[]) => (b.balances ?? []).find((x: any) => types.includes(x.balance_type));
    const bookedBal = pick(['CLBD', 'ITBD', 'OPBD']);
    const bal = bookedBal ?? pick(['ITAV', 'CLAV', 'XPCD', 'OTHR']);
    const added = round2(write.filter(x => x.currency === ccy).reduce((a, x) => a + x.amount, 0));
    const expected = round2(storedBalance + added + (bookedBal ? 0 : pending.reduce((a, x) => a + x.amount, 0)));
    const actual = bal ? round2(Number(bal.balance_amount?.amount)) : null;
    balances[ccy] = { statement: storedBalance, added, expected, bank: actual, type: bal?.balance_type ?? null };
    if (actual !== null && Math.abs(actual - expected) > 0.011)
      diffs.push(`${ccy} balance: statement ${storedBalance} + API ${added}${bookedBal ? '' : ' + pending'} = ${expected}, the bank says ${actual} (${bal.balance_type})`);
  }
  if (diffs.length) throw new Error(`Not understood -- nothing replaced. ${diffs.length} differences (after the statement of ${lastEnd}): ${diffs.slice(0, 8).join('; ')}`);

  // Replace: this bank's API rows, from 0 per currency, in booking order.
  const { error: dErr } = await db.from('bank_transactions').delete().eq('user_id', userId).eq('external_source', src);
  if (dErr) throw new Error(dErr.message);
  const bal: Record<string, number> = {};
  const seen = new Map<string, number>();
  const rows = write.sort((p, q) => p.day.localeCompare(q.day)).map((x, i) => {
    bal[x.currency] = round2((bal[x.currency] ?? 0) + x.amount);
    const id = x.ref ? `${bankKey}:${x.ref}` : `${bankKey}:${x.day}:${x.currency}:${x.amount}:${x.desc.slice(0, 60)}`;
    const n = seen.get(id) ?? 0; seen.set(id, n + 1);
    const at = new Date(Date.parse(`${x.day}T00:00:00Z`) + i).toISOString();
    return {
      user_id: userId, account: bank.label, tx_date: at, booked_at: at, description: x.desc || '(no description)', counterparty: null,
      amount: x.amount, currency: x.currency, category: null, balance_after: bal[x.currency], synthetic: false, synthetic_kind: null,
      note: null, external_source: src, external_id: n ? `${id}:dup${n}` : id,
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('bank_transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
    if (error) throw new Error(error.message);
  }
  if (rows.length) {
    const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
    if (rq) throw new Error(rq.message);
  }
  return { after_statement: lastEnd, written: rows.length, pending: pendingCount, checked: { window: `${checkFrom}..${lastEnd}`, matched },
    balances, period_to: new Date().toISOString().slice(0, 10), valid_until: s.access?.valid_until ?? null };
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

    // Every session (the page's "Sync now": the user's; the daily job: everyone's).
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
          result = await syncBank(db, app.user_id, jwt, s.broker.slice(3), s.query_id);
        } catch (err) { result = { error: String(err) }; }
        let kept = JSON.stringify(result);
        if (kept.length > 4000) kept = JSON.stringify({ ...result, balances: undefined });
        if (kept.length > 4000) kept = JSON.stringify(result.error ? { error: String(result.error).slice(0, 3800) } : { period_to: result.period_to });
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
