// A stand-in for supabase-js in the page snapshot test: every query is answered
// from window.__FIXTURE (table -> rows), filtered and ordered the way PostgREST
// would, roughly. Writes change nothing and succeed. Signed in from the start.
(function () {
  const FIX = window.__FIXTURE || {};
  // answers come after a network-like pause: the page's module script loads first, as it does for real
  const later = f => new Promise(res => setTimeout(() => res(f()), 40));
  const RPC = window.__FIXTURE_RPC || {};
  const like = (pat, ci) => {
    const re = '^' + String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$';
    return new RegExp(re, ci ? 'i' : '');
  };
  const cmp = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
  const val = (r, col) => {
    const c = col.split('->>')[0].split('->')[0];
    return r[c];
  };
  function test(r, col, op, v) {
    const x = val(r, col);
    switch (op) {
      case 'eq': return String(x) === String(v);
      case 'neq': return String(x) !== String(v);
      case 'gt': return x != null && x > v;
      case 'gte': return x != null && x >= v;
      case 'lt': return x != null && x < v;
      case 'lte': return x != null && x <= v;
      case 'like': return x != null && like(v).test(x);
      case 'ilike': return x != null && like(v, true).test(x);
      case 'is': return v === null || v === 'null' ? x == null : String(x) === String(v);
      case 'in': {
        const arr = Array.isArray(v) ? v : String(v).replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
        return arr.map(String).includes(String(x));
      }
      case 'cs': case 'ov': return true;
      default: return true;
    }
  }
  // 'a.eq.x,b.is.null,and(c.eq.1,d.ilike.*x*)' -> predicate
  function splitTop(s) {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function orPred(expr, isAnd) {
    const parts = splitTop(expr).map(p => {
      const m = p.match(/^(and|or)\((.*)\)$/);
      if (m) return orPred(m[2], m[1] === 'and');
      const [col, ...rest] = p.split('.');
      let neg = false;
      if (rest[0] === 'not') { neg = true; rest.shift(); }
      const op = rest.shift(), v = rest.join('.');
      return r => { const t = test(r, col, op, op === 'in' ? v : v === 'null' ? null : v); return neg ? !t : t; };
    });
    return r => (isAnd ? parts.every(f => f(r)) : parts.some(f => f(r)));
  }
  function builder(table) {
    const preds = []; let orders = [], lim = null, rng = null, mode = 'many', write = false, countOpt = null, head = false;
    const q = {
      select(_cols, opts) { if (opts && opts.count) countOpt = opts.count; if (opts && opts.head) head = true; return q; },
      insert() { write = true; return q; }, update() { write = true; return q; },
      upsert() { write = true; return q; }, delete() { write = true; return q; },
      eq(c, v) { preds.push(r => test(r, c, 'eq', v)); return q; },
      neq(c, v) { preds.push(r => test(r, c, 'neq', v)); return q; },
      gt(c, v) { preds.push(r => test(r, c, 'gt', v)); return q; },
      gte(c, v) { preds.push(r => test(r, c, 'gte', v)); return q; },
      lt(c, v) { preds.push(r => test(r, c, 'lt', v)); return q; },
      lte(c, v) { preds.push(r => test(r, c, 'lte', v)); return q; },
      like(c, v) { preds.push(r => test(r, c, 'like', v)); return q; },
      ilike(c, v) { preds.push(r => test(r, c, 'ilike', v)); return q; },
      is(c, v) { preds.push(r => test(r, c, 'is', v)); return q; },
      in(c, v) { preds.push(r => test(r, c, 'in', v)); return q; },
      contains() { return q; }, overlaps() { return q; }, textSearch() { return q; },
      not(c, op, v) { preds.push(r => !test(r, c, op, v)); return q; },
      filter(c, op, v) { preds.push(r => test(r, c, op, v)); return q; },
      match(o) { for (const [k, v] of Object.entries(o)) preds.push(r => test(r, k, 'eq', v)); return q; },
      or(expr) { preds.push(orPred(expr, false)); return q; },
      order(c, o) { orders.push([c, !(o && o.ascending === false), o && o.nullsFirst]); return q; },
      limit(n) { lim = n; return q; },
      range(a, b) { rng = [a, b]; return q; },
      single() { mode = 'single'; return q; },
      maybeSingle() { mode = 'maybe'; return q; },
      abortSignal() { return q; }, throwOnError() { return q; }, returns() { return q; },
      then(ok, bad) { return later(run).then(ok, bad); },
    };
    function run() {
      if (write) return { data: mode === 'many' ? [] : null, error: null, count: 0 };
      let rows = (FIX[table] || []).filter(r => preds.every(p => p(r)));
      if (orders.length) {
        rows = rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
          for (const [c, asc] of orders) { const d = cmp(val(a, c), val(b, c)); if (d) return asc ? d : -d; }
          return i - j;
        }).map(([r]) => r);
      }
      const count = rows.length;
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      rows = rows.map(r => ({ ...r }));
      if (head) return { data: null, error: null, count };
      if (mode === 'single') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (mode === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null, count: countOpt ? count : null };
    }
    return q;
  }
  const session = {
    access_token: 'test-token', token_type: 'bearer',
    user: { id: 'd8905b70-2033-4755-9d1c-617a5d609e6f', email: 'test@example.com', user_metadata: { full_name: 'Test' } },
  };
  window.supabase = {
    createClient: () => ({
      from: builder,
      rpc: (name) => {
        const d = Object.prototype.hasOwnProperty.call(RPC, name) ? RPC[name] : null;
        const p = later(() => ({ data: d, error: null }));
        const q = { then: (a, b) => p.then(a, b), select: () => q, single: () => q, maybeSingle: () => q, order: () => q, limit: () => q, eq: () => q };
        return q;
      },
      auth: {
        getSession: () => later(() => ({ data: { session }, error: null })),
        getUser: () => Promise.resolve({ data: { user: session.user }, error: null }),
        onAuthStateChange: (cb) => { setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        signInWithOAuth: () => Promise.resolve({ data: {}, error: null }),
        signOut: () => Promise.resolve({ error: null }),
      },
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      storage: { from: () => ({ upload: () => Promise.resolve({ data: null, error: null }) }) },
    }),
  };
})();
