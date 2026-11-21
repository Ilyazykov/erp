// Checks js/app/common.js, the helpers that replaced code repeated across the
// page: paging past PostgREST's 1000-row cap (each caller's way of handling an
// error kept), the Edge Function call of the syncs, a sync's stored result,
// days to a date, the coins of a balance check and a setting kept in storage.
// Run: node tests/common.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let failed = 0;
const check = async (name, f) => {
  try { await f(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); }
};

const load = extra => {
  const ctx = { console, Date, JSON, Math, Number, Object, Array, Promise, Error, ...extra };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../js/app/common.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../js/app/automation.js', import.meta.url), 'utf8')
    .match(/\/\/ A balance check's coins[\s\S]*?\n}\n/)[0], ctx);
  return ctx;
};

// a query over n rows, failing on page `failAt` (0-based) when given
const table = (n, failAt = -1) => {
  const pages = [];
  const build = () => ({
    range(a, b) {
      pages.push([a, b]);
      const page = a / 1000;
      if (page === failAt) return Promise.resolve({ data: null, error: { message: `page ${page} failed` } });
      return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(n, b + 1) - a) }, (_, i) => ({ id: a + i })), error: null });
    },
  });
  return { build, pages };
};

// the loop every caller had before (the copy that threw the message)
async function oldLoop(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const c = load({});
for (const n of [0, 1, 999, 1000, 1001, 2500, 3000]) {
  await check(`mpFetchAll: ${n} rows, the same pages and rows as the old loop`, async () => {
    const a = table(n), b = table(n);
    const got = await c.mpFetchAll(a.build), want = await oldLoop(b.build);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), want);
    assert.deepEqual(a.pages, b.pages);
  });
}
for (const [n, failAt] of [[2500, 0], [2500, 1], [2500, 2]]) {
  await check(`mpFetchAll: ${n} rows, page ${failAt} fails -- the same error as the old loop`, async () => {
    const got = await c.mpFetchAll(table(n, failAt).build).then(() => 'no error', e => e.message);
    const want = await oldLoop(table(n, failAt).build).then(() => 'no error', e => e.message);
    assert.equal(got, want);
  });
  await check(`mpFetchAllRows: ${n} rows, page ${failAt} fails -- the pages before it and the error`, async () => {
    const { rows, error } = await c.mpFetchAllRows(table(n, failAt).build);
    assert.equal(rows.length, failAt * 1000);
    assert.equal(error.message, `page ${failAt} failed`);
  });
}

// ---- mpCallEdge: what the syncs' Save / Sync buttons send ----
const calls = [];
const edge = (session, reply) => load({
  SUPABASE_URL: 'https://x.supabase.co',
  sb: { auth: { getSession: async () => ({ data: { session } }) } },
  fetch: async (url, opts) => { calls.push([url, opts]); return { ok: reply.ok, statusText: 'Bad Request', json: async () => reply.body }; },
});
await check('mpCallEdge: POSTs the body as JSON with the user\'s token', async () => {
  calls.length = 0;
  const e = edge({ access_token: 'tok' }, { ok: true, body: { done: 1 } });
  const r = await e.mpCallEdge('sync-tbank', { check: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { done: 1 });
  assert.equal(calls[0][0], 'https://x.supabase.co/functions/v1/sync-tbank');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), {
    method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{"check":true}',
  });
});
await check('mpCallEdge: a region goes in x-region, after the other headers', async () => {
  calls.length = 0;
  await edge({ access_token: 'tok' }, { ok: true, body: {} }).mpCallEdge('sync-binance', {}, 'eu-west-1');
  assert.deepEqual(Object.entries(calls[0][1].headers), [['Authorization', 'Bearer tok'], ['Content-Type', 'application/json'], ['x-region', 'eu-west-1']]);
});
await check('mpCallEdge: the function\'s error, else the status text; signed out: "Sign in first."', async () => {
  const msg = p => p.then(() => 'no error', e => e.message);
  assert.equal(await msg(edge({ access_token: 't' }, { ok: false, body: { error: 'bad key' } }).mpCallEdge('f', {})), 'bad key');
  assert.equal(await msg(edge({ access_token: 't' }, { ok: false, body: {} }).mpCallEdge('f', {})), 'Bad Request');
  calls.length = 0;
  assert.equal(await msg(edge(null, { ok: true, body: {} }).mpCallEdge('f', {})), 'Sign in first.');
  assert.equal(calls.length, 0);
});

// ---- the small ones ----
await check('mpSyncResult: the stored JSON; {} when none or not JSON', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(c.mpSyncResult({ last_sync_result: '{"trades":3}' }))), { trades: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(c.mpSyncResult({ last_sync_result: null }))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(c.mpSyncResult({ last_sync_result: 'not json' }))), {});
});
await check('mpDaysUntil: whole days to the day\'s start, rounded up', () => {
  const now = Date.now;
  Date.now = () => Date.parse('2026-11-21T12:00:00Z');
  try {
    assert.equal(c.mpDaysUntil('2026-11-22'), 1);
    assert.equal(c.mpDaysUntil('2026-11-28'), 7);
    assert.ok(c.mpDaysUntil('2026-11-21') === 0);   // -0, as the old code gave: shown as 0
    assert.equal(c.mpDaysUntil('2026-11-20'), -1);
  } finally { Date.now = now; }
});
await check('mpCoinList: coins with up to 8 decimals; "nothing" when none', () => {
  assert.equal(c.mpCoinList({ BTC: 0.0123456789, USDT: 15 }), 'BTC 0.01234568, USDT 15');
  assert.equal(c.mpCoinList({}), 'nothing');
  assert.equal(c.mpCoinList(null), 'nothing');
});
await check('mpSave: kept; no storage (or a full one) is no error', () => {
  const kept = {};
  load({ localStorage: { setItem: (k, v) => { kept[k] = v; } } }).mpSave('mp_x', '1');
  assert.deepEqual(kept, { mp_x: '1' });
  load({ localStorage: { setItem: () => { throw new Error('QuotaExceededError'); } } }).mpSave('mp_x', '1');
  load({}).mpSave('mp_x', '1');
});

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
