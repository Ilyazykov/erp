// Supabase Edge Function: update-crypto-indicators
//
// Refreshes crypto_indicators (migration ...172): BTC's AHR999 index per
// day, the crypto strategy's signal (the Crypto strategy tab, the salary
// plan's crypto step). From BTC's daily closes on Yahoo since 17.09.2014
// (BTC-USD); the whole series is rewritten every run -- some 4,400 rows, a
// few seconds -- so a revised close is picked up too.
//
//   ahr999 = (price / dca200) * (price / fair)
//   dca200 = the geometric mean of the last 200 closes
//   fair   = 10 ^ (5.84 * log10(days since 2009-01-03) - 17.01)
//
// Checked (05.11.2026) against CoinGlass (coinglass.com/pro/i/ahr999):
// 0.485 on 05.11.2026 there and here; and its known lows: 0.27 on
// 22.11.2022, 0.30 on 14.03.2020.
//
// Called by pg_cron every morning (deployed with --no-verify-jwt; it only
// ever writes public data, with the service role).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const GENESIS = Date.parse('2009-01-03T00:00:00Z');
const WINDOW = 200;

async function btcCloses(): Promise<[string, number][]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?period1=1410000000&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (erp-portfolio)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo BTC-USD: HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const close: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  // Dated as CoinGlass dates its AHR999: a day's value is at its 00:00 UTC,
  // the close of the day before (its 05.11.2026 row: BTC $80,450 -- Yahoo's
  // close of 04.11). Today's candle, not closed yet, is left out.
  const today = new Date().toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  ts.forEach((t, i) => {
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    if (close[i] && day < today) byDay.set(new Date(t * 1000 + 86400_000).toISOString().slice(0, 10), close[i]!);
  });
  return [...byDay].sort((a, b) => a[0].localeCompare(b[0]));
}

Deno.serve(async (req) => {
  // Only the daily job, with the cron secret.
  if (!(await fromCron(req))) return notFromCron();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const closes = await btcCloses();
    if (closes.length < WINDOW) throw new Error(`only ${closes.length} closes`);
    const rows = [];
    let logSum = 0;
    for (let i = 0; i < closes.length; i++) {
      logSum += Math.log(closes[i][1]);
      if (i >= WINDOW) logSum -= Math.log(closes[i - WINDOW][1]);
      if (i < WINDOW - 1) continue;
      const [day, price] = closes[i];
      const dca200 = Math.exp(logSum / WINDOW);
      const age = (Date.parse(`${day}T00:00:00Z`) - GENESIS) / 86400_000;
      const fair = 10 ** (5.84 * Math.log10(age) - 17.01);
      rows.push({ day, btc_usd: price, dca200: Math.round(dca200 * 100) / 100, fair_usd: Math.round(fair * 100) / 100,
        ahr999: Math.round(price / dca200 * price / fair * 10000) / 10000, updated_at: new Date().toISOString() });
    }
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await db.from('crypto_indicators').upsert(rows.slice(i, i + 1000));
      if (error) throw new Error(error.message);
    }
    const last = rows[rows.length - 1];
    return json({ rows: rows.length, last });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
