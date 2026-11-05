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
// 6. The trend over it (asked 05.11.2026): the rate's change over the last
//    year (365 days -- a walk-forward test had it beat 1-9 months), in buckets (<= -3, -3..-1, -1..-0.25, about 0, 0.25..1, 1..3,
//    >= 3 pp). Per bucket, the days' horizons as in 2-3 (not counting the
//    same): how often the rate went up, against what the level's odds (5)
//    expected for them -- the odds ratio, the trend over the level; the tab
//    multiplies the level's odds by it. Not made monotone: the history has a
//    move mostly go on, but not a sharp cut after a spike (2015, 2022).
//    Clamped to 0.2-5 -- a bucket of one episode.
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
    // 6. the trend
    const level = (x: number) => { const u = upFit(x), d = downFit(x); return u + d > 0 ? u / (u + d) : 0.5; };
    const LAG = 365;
    const TREND = [[-99, -3], [-3, -1], [-1, -0.25], [-0.25, 0.25], [0.25, 1], [1, 3], [3, 99]];
    const tb = TREND.map(([from, to]) => ({ trend_from: from, trend_to: to, n: 0, w: 0, obs: 0, exp: 0 }));
    daily.forEach((r, i) => {
      if (i < LAG) return;
      const tr = r - daily[i - LAG];
      const b = tb.find(t => tr > t.trend_from && tr <= t.trend_to) ?? tb[0];
      for (const h of HORIZONS) {
        const later = daily[i + Math.round(h * 365.25)];
        if (later === undefined || later === r) continue;
        b.n++; b.w += weight(h); b.obs += weight(h) * (later > r ? 1 : 0); b.exp += weight(h) * level(r);
      }
    });
    const odds = (p: number) => p / (1 - p);
    const trendRows = tb.filter(t => t.n).map(t => {
      const obs = t.obs / t.w, exp = t.exp / t.w;
      const ratio = Math.min(5, Math.max(0.2, obs >= 1 ? 5 : obs <= 0 ? 0.2 : odds(obs) / odds(exp)));
      return { trend_from: t.trend_from, trend_to: t.trend_to, n: t.n, obs_up: Math.round(obs * 10000) / 10000,
        exp_up: Math.round(exp * 10000) / 10000, odds_ratio: Math.round(ratio * 1000) / 1000, computed_at };
    });
    const { error: delTrend } = await db.from('key_rate_trend_odds').delete().gte('trend_from', -1000);
    if (delTrend) throw new Error(delTrend.message);
    const { error: trendErr } = await db.from('key_rate_trend_odds').insert(trendRows);
    if (trendErr) throw new Error(trendErr.message);
    return json({ key_rate: now, buckets: out.length, odds: out.map(r => `${r.rate_from}-${r.rate_to}%: ${r.floaters_pct}%`),
      trend: trendRows.map(t => `${t.trend_from}..${t.trend_to} pp: x${t.odds_ratio}`) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
