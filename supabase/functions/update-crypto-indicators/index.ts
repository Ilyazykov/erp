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
    if (lastStored >= new Date().toISOString().slice(0, 10)) return json({ rows: 0, upToDate: lastStored });
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
    return json({ rows: rows.length, last, errors });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
