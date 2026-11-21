// Small helpers shared by the page's other scripts (js/app/*.js, one global
// scope, loaded in index.html's order -- this one first). Each replaces code
// that used to be repeated word for word in several places.

// Every row of a query, past PostgREST's 1000-row page cap: build() makes the
// query afresh for each page. { rows, error }: on an error, the rows of the
// pages before it and that error -- each caller keeps its own way of handling it.
async function mpFetchAllRows(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return { rows, error };
    rows.push(...data);
    if (data.length < 1000) return { rows, error: null };
  }
}

// The same, throwing the query's error message.
async function mpFetchAll(build) {
  const { rows, error } = await mpFetchAllRows(build);
  if (error) throw new Error(error.message);
  return rows;
}

// POSTs `body` as JSON to the Edge Function `fn` as the signed-in user: its
// answer, or an Error with the function's own message. `region`: the
// x-region the function is to run in (Binance, Bybit and Revolut X refuse US
// addresses: the project's own region).
async function mpCallEdge(fn, body, region) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Sign in first.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(region ? { 'x-region': region } : {}) },
    body: JSON.stringify(body),
  });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error || res.statusText);
  return r;
}

// A sync's last result as stored with its status (last_sync_result, JSON
// text): {} when there is none or it isn't JSON.
function mpSyncResult(s) {
  let r = {};
  try { r = JSON.parse(s.last_sync_result || '{}'); } catch { /* not JSON */ }
  return r;
}

// Whole days from now to the start (UTC) of day `day` (YYYY-MM-DD), rounded up.
function mpDaysUntil(day) {
  return Math.ceil((Date.parse(`${day}T00:00:00Z`) - Date.now()) / 86400000);
}

// A setting kept in the browser; nothing happens where storage is off.
function mpSave(key, value) {
  try { localStorage.setItem(key, value); } catch { /* no storage */ }
}
