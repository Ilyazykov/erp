// Supabase Edge Function: update-key-rate-odds
//
// The CBR key rate's history and, from it, the odds that it goes up or down
// from each level of it (migration ...174) -- the floaters' share of the
// bonds (the Bonds & deposits tab, asked 05.11.2026): the odds it goes up are
// the floaters' share, the odds it goes down -- the fixed coupons'.
//
// 1. The key rate per day since 17.09.2013 (cbr.ru, its rate on a day
//    carried over to the days till the next change), every day of it kept in
//    key_rates -- the job runs daily for it; the odds (2-5) on {"odds": true},
//    the monthly job, or while key_rate_odds is empty.
// 2. Per 1 pp bucket of the rate (4-5%, 5-6%, ...): of its days, the share
//    whose rate a year later is higher / lower / the same; the same two and
//    three years later. A day counts in a horizon only if that later day has
//    come.
// 3. The three horizons in one: weighted 1 : 1/(1+r) : 1/(1+r)^2 (r -- the key
//    rate now), a later year discounted as a coupon is; a bucket without
//    some horizon (the rates of the last years) -- the weights of those it has.
// 4. Up strictly falls with the rate, down strictly rises: a weighted
//    isotonic fit (pool adjacent violators, by days), each pooled block a
//    point at its days' mean rate, linear between the points. The same stays
//    as it was.
// 5. Without the same: floaters = up / (up + down), fixed = the rest.
// 6. The trend over it (asked 05.11.2026), from the world's central banks --
//    Russia's own history has too few episodes of it: the BIS policy rates
//    (stats.bis.org, WS_CBPOL, monthly), every country, Russia too, since
//    1990, a rate of 40% and over (and a decade with 60%) left out. Per
//    country-month: the rate's change over the last 12 months as a share of
//    its range over the last 10 years (max - min; 1 pp is a lot in
//    Switzerland, little in Turkey -- asked 05.11.2026), in buckets (cut by
//    more than 30% of the range, 10-30%, 2-10%, about none, raised 2-10%,
//    10-30%, more than 30%), and where
//    it stands against its last 10 years (more than half a standard
//    deviation below the mean, about it, above) -- a pause high up and one
//    low down tell the opposite. Per bucket x position, 12, 24, 36 months
//    later (weighted as in 3, not counting the same): how often it went up,
//    against how often it did at that position whatever the change -- the
//    odds ratio k; the tab multiplies the level's odds (5) by it. Clamped to
//    0.2-5; a cell under 20 (weighted) observations -- 1.
//
// 7. The bond ladder's tables -- see horizonOdds.
//
// Called by pg_cron daily and once a month with the odds (deployed with
// --no-verify-jwt; it only ever writes public data, with the service role).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const START = '2013-09-17';   // the key rate's first day
const HORIZONS = [1, 2, 3];   // years
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

// cbr.ru/hd_base/KeyRate: a table of the days the rate was set, newest first
async function keyRates(): Promise<[string, number][]> {
  const ru = (d: string) => d.split('-').reverse().join('.');
  const url = `https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=${ru(START)}&UniDbQuery.To=${ru(iso(Date.now()))}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (erp-portfolio)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`cbr.ru: HTTP ${res.status}`);
  const html = await res.text();
  const rows = [...html.matchAll(/<td>(\d\d)\.(\d\d)\.(\d{4})<\/td>\s*<td>([\d,]+)<\/td>/g)]
    .map(m => [`${m[3]}-${m[2]}-${m[1]}`, Number(m[4].replace(',', '.'))] as [string, number]);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

// pool adjacent violators: the fit that never goes up (down = false: never down)
function isotonic(points: { x: number; y: number; w: number }[], falling: boolean) {
  const blocks: { y: number; w: number; xw: number }[] = [];
  for (const p of points) {
    blocks.push({ y: p.y, w: p.w, xw: p.x * p.w });
    // strictly: an equal neighbour pools too
    while (blocks.length > 1 && (falling ? blocks.at(-2)!.y <= blocks.at(-1)!.y : blocks.at(-2)!.y >= blocks.at(-1)!.y)) {
      const b = blocks.pop()!, a = blocks.pop()!;
      blocks.push({ y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w, xw: a.xw + b.xw });
    }
  }
  const knots = blocks.map(b => ({ x: b.xw / b.w, y: b.y }));
  return (x: number) => {
    if (x <= knots[0].x) return knots[0].y;
    if (x >= knots.at(-1)!.x) return knots.at(-1)!.y;
    const i = knots.findIndex(k => k.x >= x);
    const a = knots[i - 1], b = knots[i];
    return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  };
}

const TREND = [[-99, -0.3], [-0.3, -0.1], [-0.1, -0.02], [-0.02, 0.02], [0.02, 0.1], [0.1, 0.3], [0.3, 99]];
// the change over 12 months, a share of the range over the last 10 years
function relChange(v: number[], i: number) {
  const w = v.slice(i - 120, i + 1), range = Math.max(...w) - Math.min(...w);
  return range > 0 ? (v[i] - v[i - 12]) / range : 0;
}
const trendBucket = (x: number) => Math.max(0, TREND.findIndex(([a, b]) => x > a && x <= b));
// against the last 120 months: 0 -- more than half a standard deviation
// below their mean, 2 -- above, 1 -- about it
function position(v: number[], i: number) {
  const w = v.slice(i - 120, i), m = w.reduce((s, x) => s + x, 0) / 120;
  const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 120) || 1, rel = (v[i] - m) / sd;
  return rel < -0.5 ? 0 : rel > 0.5 ? 2 : 1;
}

// the BIS policy rates, monthly, per country: month -> rate
async function bisRates() {
  const url = 'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.?format=csv&detail=dataonly&c%5BTIME_PERIOD%5D=ge:1980-01';
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`BIS: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n');
  const head = lines[0].split(','), ci = head.indexOf('REF_AREA'), ti = head.indexOf('TIME_PERIOD'), vi = head.indexOf('OBS_VALUE');
  const byCountry = new Map<string, Map<string, number>>();
  for (const line of lines.slice(1)) {
    const f = line.split(','), v = Number(f[vi]);
    if (f[vi] === '' || !Number.isFinite(v)) continue;
    if (!byCountry.has(f[ci])) byCountry.set(f[ci], new Map());
    byCountry.get(f[ci])!.set(f[ti], v);
  }
  if (byCountry.size < 30) throw new Error(`BIS: ${byCountry.size} countries`);
  return byCountry;
}

function worldTrendOdds(byCountry: Map<string, Map<string, number>>, weight: (h: number) => number) {
  // [bucket][position]: [up (weighted), all (weighted)]; per position the same
  const cell = TREND.map(() => [0, 1, 2].map(() => [0, 0]));
  const pos = [0, 1, 2].map(() => [0, 0]);
  for (const [country, s] of byCountry) {
    const ms = [...s.keys()].sort(), v = ms.map(m => s.get(m)!);
    for (let i = 120; i < ms.length; i++) {
      if (ms[i] < '1990-01' || v[i] > 40 || Math.max(...v.slice(i - 120, i + 1)) > 60) continue;
      const t = trendBucket(relChange(v, i)), p = position(v, i);
      for (const h of HORIZONS) {
        const j = i + 12 * h;
        if (j >= ms.length || v[j] === v[i]) continue;
        const w = weight(h), up = v[j] > v[i] ? 1 : 0;
        cell[t][p][0] += w * up; cell[t][p][1] += w; pos[p][0] += w * up; pos[p][1] += w;
      }
    }
  }
  const odds = (q: number) => q / (1 - q);
  return TREND.flatMap(([from, to], t) => [0, 1, 2].map(p => {
    const [u, n] = cell[t][p], exp = pos[p][0] / pos[p][1];
    const obs = (u + 0.5) / (n + 1);
    const ratio = n < 20 ? 1 : Math.min(5, Math.max(0.2, odds(obs) / odds(exp)));
    return { trend_from: from, trend_to: to, position: p, n: Math.round(n), obs_up: Math.round(obs * 10000) / 10000,
      exp_up: Math.round(exp * 10000) / 10000, odds_ratio: Math.round(ratio * 1000) / 1000 };
  }));
}

// 7. The bond ladder's weights (asked 05.11.2026): per horizon 1-15 years x
//    key rate 4-21% (1 pp buckets) -- how often the rate was lower in that
//    many years (down) and higher (up; 06.11.2026 -- was "not higher"). Russia's
//    rate by the BIS's monthly series, month-ends since 1992 (the CBR's
//    refinancing rate before 13.09.2013, the key rate after; a month at 22%
//    and over not counted) -- the key rate alone, since 2013, has no 15
//    years yet. Both tables made monotone both ways -- down rises with the
//    rate and with the horizon, up falls (fitted as not-up, 1 - up, rising): a weighted least-squares fit
//    (Dykstra's alternating projections, rows and columns by pool-adjacent-
//    violators, a cell weighted by its months; a cell of no months takes
//    what its neighbours give) -- then strictly so: 95% the fit + 5% a grid
//    rising from 0 (4%, 1 year) to 1 (21%, 15 years).
const LADDER_RATES = Array.from({ length: 18 }, (_, i) => i + 4);
const LADDER_YEARS = Array.from({ length: 15 }, (_, i) => i + 1);

function pava(ys: number[], ws: number[]) {
  const bl: { y: number; w: number; n: number }[] = [];
  ys.forEach((y, i) => {
    bl.push({ y, w: ws[i], n: 1 });
    while (bl.length > 1 && bl.at(-2)!.y > bl.at(-1)!.y) {
      const b = bl.pop()!, a = bl.pop()!;
      bl.push({ y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  });
  return bl.flatMap(b => Array(b.n).fill(b.y) as number[]);
}

// non-decreasing along the rows and the columns, cells weighted
function isotonic2d(X0: number[][], W: number[][]) {
  let X = X0.map(r => [...r]);
  let P = X.map(r => r.map(() => 0)), Q = X.map(r => r.map(() => 0));
  for (let it = 0; it < 2000; it++) {
    const A = X.map((r, i) => r.map((x, j) => x + P[i][j]));
    const Ar = A.map((r, i) => pava(r, W[i]));
    P = A.map((r, i) => r.map((a, j) => a - Ar[i][j]));
    const B = Ar.map((r, i) => r.map((x, j) => x + Q[i][j]));
    const Bc = B.map(r => [...r]);
    for (let j = 0; j < X[0].length; j++) pava(B.map(r => r[j]), W.map(r => r[j])).forEach((x, i) => { Bc[i][j] = x; });
    Q = B.map((r, i) => r.map((b, j) => b - Bc[i][j]));
    X = Bc;
  }
  return X;
}

function horizonOdds(ru: Map<string, number>) {
  const ms = [...ru.keys()].sort(), v = ms.map(m => ru.get(m)!);
  const cells = LADDER_YEARS.map(h => LADDER_RATES.map(k => {
    let down = 0, notUp = 0, n = 0;
    for (let i = 0; i + 12 * h < v.length; i++) {
      if (Math.floor(v[i]) !== k || v[i] >= 22) continue;
      const later = v[i + 12 * h];
      n++; if (later < v[i]) down++; if (later <= v[i]) notUp++;
    }
    return { n, down: n ? down / n : 0.5, notUp: n ? notUp / n : 0.5 };
  }));
  const W = cells.map(r => r.map(c => c.n || 0.01));
  const fitD = isotonic2d(cells.map(r => r.map(c => c.down)), W);
  const fitN = isotonic2d(cells.map(r => r.map(c => c.notUp)), W);
  const L = 0.05, grid = (i: number, j: number) => (j / (LADDER_RATES.length - 1) + i / (LADDER_YEARS.length - 1)) / 2;
  return LADDER_YEARS.flatMap((h, i) => LADDER_RATES.map((k, j) => {
    let d = fitD[i][j], nu = fitN[i][j];
    nu = Math.max(nu, d);   // not up holds down
    return { horizon: h, rate: k, months: cells[i][j].n,
      down: Math.round(((1 - L) * d + L * grid(i, j)) * 10000) / 10000,
      up: Math.round((1 - ((1 - L) * nu + L * grid(i, j))) * 10000) / 10000 };
  }));
}

Deno.serve(async (req) => {
  // Only the daily and monthly jobs, with the cron secret.
  if (!(await fromCron(req))) return notFromCron();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const wantOdds = (await req.json().catch(() => ({})))?.odds === true;
    const set = await keyRates();
    if (set.length < 50 || set[0][0] !== START) throw new Error(`cbr.ru: ${set.length} rows from ${set[0]?.[0]}`);
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // 1. per day, every day kept
    const today = iso(Date.now());
    const days: { day: string; rate: number }[] = [];
    let k = 0;
    for (let t = Date.parse(START); iso(t) <= today; t += DAY) {
      while (k + 1 < set.length && set[k + 1][0] <= iso(t)) k++;
      days.push({ day: iso(t), rate: set[k][1] });
    }
    for (let i = 0; i < days.length; i += 1000) {
      const { error } = await db.from('key_rates').upsert(days.slice(i, i + 1000));
      if (error) throw new Error(error.message);
    }
    const daily = days.map(d => d.rate);
    const now = daily.at(-1)!;
    const { count } = await db.from('key_rate_odds').select('rate_from', { count: 'exact', head: true });
    if (!wantOdds && count) return json({ key_rate: now, days: days.length });
    // 2. per bucket and horizon: [up, down, same, days]
    const buckets = new Map<number, { counts: Map<number, number[]>; rateSum: number; days: number }>();
    daily.forEach((r, i) => {
      const from = Math.floor(r);
      const b = buckets.get(from) ?? { counts: new Map(), rateSum: 0, days: 0 };
      b.rateSum += r; b.days++;
      for (const h of HORIZONS) {
        const later = daily[i + Math.round(h * 365.25)];
        if (later === undefined) continue;
        const c = b.counts.get(h) ?? [0, 0, 0, 0];
        c[later > r ? 0 : later < r ? 1 : 2]++; c[3]++;
        b.counts.set(h, c);
      }
      buckets.set(from, b);
    });
    // 3. the horizons in one
    const weight = (h: number) => 1 / (1 + now / 100) ** (h - 1);
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).flatMap(([from, b]) => {
      const hs = HORIZONS.filter(h => b.counts.get(h)?.[3]);
      if (!hs.length) return [];
      const wsum = hs.reduce((s, h) => s + weight(h), 0);
      const mix = (j: number) => hs.reduce((s, h) => s + weight(h) * b.counts.get(h)![j] / b.counts.get(h)![3], 0) / wsum;
      const days = Math.max(...hs.map(h => b.counts.get(h)![3]));
      return [{ rate_from: from, rate_to: from + 1, rate: b.rateSum / b.days, days, up_raw: mix(0), down_raw: mix(1), same_raw: mix(2) }];
    });
    // 4. strictly monotone
    const upFit = isotonic(rows.map(r => ({ x: r.rate, y: r.up_raw, w: r.days })), true);
    const downFit = isotonic(rows.map(r => ({ x: r.rate, y: r.down_raw, w: r.days })), false);
    const computed_at = new Date().toISOString();
    const out = rows.map(r => {
      const up = upFit(r.rate), down = downFit(r.rate);
      // 5. without the same
      const floaters = up + down > 0 ? up / (up + down) : 0.5;
      const round = (v: number) => Math.round(v * 10000) / 10000;
      return { ...r, rate: round(r.rate), up_raw: round(r.up_raw), down_raw: round(r.down_raw), same_raw: round(r.same_raw),
        up: round(up), down: round(down), floaters_pct: Math.round(floaters * 1000) / 10, computed_at };
    });
    // the table anew: a bucket the history no longer gives goes
    const { error: delErr } = await db.from('key_rate_odds').delete().gte('rate_from', 0);
    if (delErr) throw new Error(delErr.message);
    const { error } = await db.from('key_rate_odds').insert(out);
    if (error) throw new Error(error.message);
    // 6. the trend, the world's
    const bis = await bisRates();
    const world = worldTrendOdds(bis, weight);
    const trendRows = world.map(r => ({ ...r, computed_at }));
    const { error: delTrend } = await db.from('key_rate_trend_odds').delete().gte('trend_from', -1000);
    if (delTrend) throw new Error(delTrend.message);
    const { error: trendErr } = await db.from('key_rate_trend_odds').insert(trendRows);
    if (trendErr) throw new Error(trendErr.message);
    // 7. the ladder's tables
    const ru = bis.get('RU');
    if (!ru || ru.size < 300) throw new Error(`BIS: Russia ${ru?.size} months`);
    const ladder = horizonOdds(ru).map(r => ({ ...r, computed_at }));
    const { error: delLadder } = await db.from('key_rate_horizon_odds').delete().gte('horizon', 0);
    if (delLadder) throw new Error(delLadder.message);
    const { error: ladderErr } = await db.from('key_rate_horizon_odds').insert(ladder);
    if (ladderErr) throw new Error(ladderErr.message);
    return json({ key_rate: now, buckets: out.length, odds: out.map(r => `${r.rate_from}-${r.rate_to}%: ${r.floaters_pct}%`),
      trend: trendRows.map(t => `${t.trend_from}..${t.trend_to} of range, position ${t.position}: x${t.odds_ratio}`) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
