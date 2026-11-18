// Supabase Edge Function: update-crypto-indicators
//
// Refreshes crypto_indicators (migration ...172): BTC's AHR999 index per
// day, the crypto strategy's signal (the Crypto strategy tab, the salary
// plan's crypto step). Only new days are added, the 200 closes before them
// (for dca200) from the rows already stored; stored rows are never rewritten.
// Two sources side by side (13.11.2026, as price_history's 'market' / 'ibkr' /
// 'tbank'): Bybit's spot BTCUSDT and Yahoo's BTC-USD, asked at once, either
// may fail or lag; a day both have takes Bybit's close. The row keeps its
// source.
//
//   ahr999 = (price / dca200) * (price / fair)
//   dca200 = the geometric mean of the last 200 closes
//   fair   = 10 ^ (5.84 * log10(days since 2009-01-03) - 17.01)
//
// Checked (05.11.2026) against CoinGlass (coinglass.com/pro/i/ahr999):
// 0.485 on 05.11.2026 there and here; and its known lows: 0.27 on
// 22.11.2022, 0.30 on 14.03.2020.
//
// And, once a day, the fair price's line refitted on BTC's whole life
// (crypto_fair_fit, migration ...215; refreshFairFit below).
//
// Called by pg_cron every 10 minutes, 00:00-05:50 UTC (migration ...209), until today's row is in
// (deployed with --no-verify-jwt; it only
// ever writes public data, with the service role).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const GENESIS = Date.parse('2009-01-03T00:00:00Z');
const WINDOW = 200;

type Db = ReturnType<typeof createClient>;

// Dated as CoinGlass dates its AHR999: a day's value is at its 00:00 UTC,
// the close of the day before (its 05.11.2026 row: BTC $80,450 -- the close
// of 04.11). Today's candle, not closed yet, is left out.
const rowDay = (candleStartMs: number) => new Date(candleStartMs + 86400_000).toISOString().slice(0, 10);

// Bybit's spot BTCUSDT daily candles of the last `days` days, closed ones only.
async function bybitCloses(days: number): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=${Math.min(1000, days + 1)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Bybit kline: HTTP ${res.status}`);
  const j = await res.json();
  if (j?.retCode !== 0) throw new Error(`Bybit kline: ${j?.retMsg}`);
  const out = new Map<string, number>();
  for (const [start, , , , close] of (j.result?.list ?? []) as string[][]) {
    const t = Number(start), c = Number(close);
    if (new Date(t).toISOString().slice(0, 10) < today && c > 0) out.set(rowDay(t), c);
  }
  return out;
}

// Yahoo's BTC-USD daily candles of the last `days` days, closed ones only.
async function yahooCloses(days: number): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?period1=${now - (days + 2) * 86400}&period2=${now}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (erp-portfolio)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo BTC-USD: HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const close: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const out = new Map<string, number>();
  ts.forEach((t, i) => {
    if (close[i] && new Date(t * 1000).toISOString().slice(0, 10) < today) out.set(rowDay(t * 1000), close[i]!);
  });
  return out;
}

// The fair price's line refitted on BTC's whole life, once a day (migration
// ...215, the user 18.11.2026): least squares of log10(price) on log10(days
// since 2009-01-03) over CoinMetrics' daily PriceUSD from 18.07.2010; the red
// threshold -- the refit AHR999's level with the same share of the stored days
// below it as AHR999's own below 0.45. A failure leaves yesterday's row.
const CM_URL = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2010-07-01&page_size=10000';
const OWN_RED = 0.45;

async function refreshFairFit(db: Db): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: done } = await db.from('crypto_fair_fit').select('day').eq('day', today).maybeSingle();
  if (done) return { upToDate: today };
  const pts: [string, number][] = [];
  for (let url: string | null = CM_URL; url; ) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`CoinMetrics: HTTP ${res.status}`);
    const j = await res.json();
    for (const r of j.data ?? []) if (Number(r.PriceUSD) > 0) pts.push([String(r.time).slice(0, 10), Number(r.PriceUSD)]);
    url = j.next_page_url ?? null;
  }
  if (pts.length < 3000) throw new Error(`CoinMetrics: only ${pts.length} days`);
  // running sums: the fit over the first k days in O(1)
  const S = { x: [0], y: [0], xx: [0], xy: [0], yy: [0] };
  pts.forEach(([d, p], i) => {
    const x = Math.log10((Date.parse(`${d}T00:00:00Z`) - GENESIS) / 86400_000), y = Math.log10(p);
    S.x.push(S.x[i] + x); S.y.push(S.y[i] + y); S.xx.push(S.xx[i] + x * x); S.xy.push(S.xy[i] + x * y); S.yy.push(S.yy[i] + y * y);
  });
  const fitOf = (k: number) => {
    const vx = k * S.xx[k] - S.x[k] ** 2, cxy = k * S.xy[k] - S.x[k] * S.y[k], vy = k * S.yy[k] - S.y[k] ** 2;
    const slope = cxy / vx;
    return { slope, intercept: (S.y[k] - slope * S.x[k]) / k, r2: (cxy * cxy) / (vx * vy) };
  };
  const n = pts.length;
  const { slope, intercept, r2 } = fitOf(n);
  // the red threshold: every stored day's AHR999 on the new line, the same share below as AHR999's own below 0.45
  const ind: { day: string; btc_usd: number; dca200: number; ahr999: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('crypto_indicators').select('day, btc_usd, dca200, ahr999').order('day').range(from, from + 999);
    if (error) throw new Error(error.message);
    ind.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  let red: number | null = null;
  if (ind.length) {
    const share = ind.filter(r => Number(r.ahr999) < OWN_RED).length / ind.length;
    const refit = ind.map(r => {
      const age = (Date.parse(`${r.day}T00:00:00Z`) - GENESIS) / 86400_000;
      const fair = 10 ** (slope * Math.log10(age) + intercept);
      return (Number(r.btc_usd) / Number(r.dca200)) * (Number(r.btc_usd) / fair);
    }).sort((a, b) => a - b);
    const pos = share * (refit.length - 1), lo = Math.floor(pos);   // as percentile_cont
    red = refit[lo] + (refit[Math.min(lo + 1, refit.length - 1)] - refit[lo]) * (pos - lo);
  }
  // The "as it was then" variant (the user, 18.11.2026): a row for every stored day before
  // today, fitted only on the prices before that day -- filled once, the days missing;
  // every later morning's row is that by itself
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('crypto_fair_fit').select('day').order('day').range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) have.add(r.day);
    if ((data ?? []).length < 1000) break;
  }
  const past = [];
  let k = 0;
  for (const r of ind) {
    while (k < n && pts[k][0] < r.day) k++;
    if (r.day >= today || have.has(r.day) || k < 365) continue;
    const f = fitOf(k);
    past.push({ day: r.day, slope: f.slope, intercept: f.intercept, r2: f.r2, days_fitted: k,
      first_price_day: pts[0][0], last_price_day: pts[k - 1][0], red_threshold: null, updated_at: new Date().toISOString() });
  }
  for (let i = 0; i < past.length; i += 500) {
    const { error } = await db.from('crypto_fair_fit').upsert(past.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  const row = { day: today, slope, intercept, r2, days_fitted: n, first_price_day: pts[0][0], last_price_day: pts[pts.length - 1][0],
    red_threshold: red == null ? null : Math.round(red * 10000) / 10000, updated_at: new Date().toISOString() };
  const { error } = await db.from('crypto_fair_fit').upsert(row);
  if (error) throw new Error(error.message);
  return { ...row, backfilled: past.length };
}

// The last WINDOW stored closes, oldest first.
async function storedTail(db: Db): Promise<[string, number][]> {
  const { data, error } = await db.from('crypto_indicators').select('day, btc_usd').order('day', { ascending: false }).limit(WINDOW);
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => [r.day, Number(r.btc_usd)] as [string, number]).reverse();
}

Deno.serve(async (req) => {
  // Only the daily job, with the cron secret.
  if (!(await fromCron(req))) return notFromCron();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const tail = await storedTail(db);
    if (tail.length < WINDOW) throw new Error(`only ${tail.length} stored closes`);
    const lastStored = tail[tail.length - 1][0];
    // the cron wakes this every 10 minutes (migration ...209): once today's
    // row is in, the rest of the window's runs stop here, nothing asked of the sources
    // the fair price's refit (once a day; its failure doesn't stop the rest)
    const fit = () => refreshFairFit(db).catch(e => ({ error: String(e) }));
    if (lastStored >= new Date().toISOString().slice(0, 10)) return json({ rows: 0, upToDate: lastStored, fit: await fit() });
    const gapDays = Math.ceil((Date.now() - Date.parse(`${lastStored}T00:00:00Z`)) / 86400_000);
    const [bybit, yahoo] = await Promise.allSettled([bybitCloses(gapDays), yahooCloses(gapDays)]);
    const errors = [bybit, yahoo].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason));
    const fromBybit = bybit.status === 'fulfilled' ? bybit.value : new Map<string, number>();
    const fromYahoo = yahoo.status === 'fulfilled' ? yahoo.value : new Map<string, number>();
    // the days right after the last stored one, in a row: a day neither has
    // stops it there (a gap would never be filled -- only later days are asked)
    const fresh: [string, number, string][] = [];
    for (let d = new Date(`${lastStored}T00:00:00Z`); ; ) {
      d = new Date(d.getTime() + 86400_000);
      const day = d.toISOString().slice(0, 10);
      const price = fromBybit.get(day) ?? fromYahoo.get(day);
      if (price === undefined) break;
      fresh.push([day, price, fromBybit.has(day) ? 'bybit' : 'yahoo']);
    }
    if (!fresh.length && errors.length === 2) throw new Error(errors.join('; '));
    const closes: [string, number][] = [...tail, ...fresh.map(([d, c]) => [d, c] as [string, number])];
    const rows = [];
    for (let i = tail.length; i < closes.length; i++) {
      const [day, price] = closes[i];
      const win = closes.slice(i - WINDOW + 1, i + 1);
      const dca200 = Math.exp(win.reduce((s, [, c]) => s + Math.log(c), 0) / WINDOW);
      const age = (Date.parse(`${day}T00:00:00Z`) - GENESIS) / 86400_000;
      const fair = 10 ** (5.84 * Math.log10(age) - 17.01);
      rows.push({ day, btc_usd: price, dca200: Math.round(dca200 * 100) / 100, fair_usd: Math.round(fair * 100) / 100,
        ahr999: Math.round(price / dca200 * price / fair * 10000) / 10000, source: fresh[i - tail.length][2], updated_at: new Date().toISOString() });
    }
    // insert, not upsert: a stored day is never touched
    if (rows.length) {
      const { error } = await db.from('crypto_indicators').insert(rows);
      if (error) throw new Error(error.message);
    }
    const last = rows[rows.length - 1] ?? null;
    return json({ rows: rows.length, last, errors, fit: await fit() });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
