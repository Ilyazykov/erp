// Supabase Edge Function: update-capital-history
//
// Keeps the capital-history tables (migrations/20250101000031_capital_history.sql)
// up to date and rebuilds every user's capital_daily:
//   1. fx_history: USD per unit of every currency seen in trades / bank
//      statements, daily -- RUB from the Bank of Russia (CBR XML_dynamic),
//      the rest from Yahoo's <CCY>USD=X;
//   2. price_history: the daily close in USD of every ticker ever held --
//      (not deposits / savings / money-market funds: 1 unit of their currency)
//      MOEX ISS history (shares / funds; bonds as face x price% + accrued),
//      Yahoo chart history (US stocks, UCITS ETFs, crypto / gold);
//      stablecoins and ЦФА at a constant; deposits / savings / blocked need
//      none (refresh_capital_daily prices them by currency / at 0);
//   3. refresh_capital_daily(user, from, to) for every user, in slices of
//      SLICE_DAYS from their first transaction to today.
// Each ticker's source is resolved once (market_prices' classification when
// it's held, else by trying MOEX, then Yahoo) and cached in price_sources.
// Only what's missing is fetched: from the day after the last stored close
// (a few days' overlap for late corrections), back to the ticker's first
// trade on the first run. A run stops fetching after TIME_BUDGET_MS and
// picks up where it left off next time (pg_cron daily; call again to finish
// a first backfill).
// Deployed with --no-verify-jwt: it only writes public data and the users'
// own history, with the service role.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Price fetching stops here; the rebuild (step 3) gets the rest of the run.
const TIME_BUDGET_MS = 80_000;
const SLICE_DAYS = 120;
const OVERLAP_DAYS = 5;
const UA = { 'User-Agent': 'Mozilla/5.0 (erp-portfolio capital history)' };
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ISS = 'https://iss.moex.com/iss';
// Same Yahoo symbols as update-market-prices uses for these.
const CRYPTO_YAHOO: Record<string, string> = {
  XAU: 'PAXG-USD', XAUT: 'PAXG-USD', TAO: 'TAO22974-USD', ADI: 'ADI38185-USD', MON: 'MON30495-USD', MEW: 'MEW30126-USD',
};
const ETF_SUFFIXES = ['.L', '.DE', '.AS', '.SW', '.MI', '.PA'];
const ETF_OVERRIDE: Record<string, string> = { XSX6: '.DE' };
const NO_PRICE = /^(DEPOSIT|ВКЛАД|SAVINGS|BLOCKED):/i;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const today = () => iso(new Date());
const started = Date.now();
const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function getJson(url: string) {
  try {
    const res = await fetch(url, { headers: UA });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ---- Yahoo daily closes: [[day, close]], quote currency (minor units folded in) ----
async function yahooHistory(symbol: string, from: string): Promise<{ closes: [string, number][]; currency: string } | null> {
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const j = await getJson(`${YAHOO}/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) return null;
  let currency = String(r.meta?.currency || 'USD');
  let scale = 1;
  if (currency === 'GBp' || currency === 'GBX') { currency = 'GBP'; scale = 0.01; }
  if (currency === 'ILA') { currency = 'ILS'; scale = 0.01; }
  if (currency === 'ZAc') { currency = 'ZAR'; scale = 0.01; }
  const close = r.indicators?.quote?.[0]?.close ?? [];
  const closes: [string, number][] = [];
  r.timestamp.forEach((t: number, i: number) => {
    if (close[i] !== null && close[i] !== undefined) closes.push([iso(new Date(t * 1000)), close[i] * scale]);
  });
  return { closes, currency: currency.toUpperCase() };
}

// ---- MOEX ISS history: per trading day the most-traded board's close ----
async function moexHistory(secid: string, market: 'shares' | 'bonds', from: string) {
  const best = new Map<string, { vol: number; price: number; currency: string }>();
  for (let start = 0; start < 20000 && timeLeft() > 5000; start += 100) {
    const j = await getJson(`${ISS}/history/engines/stock/markets/${market}/securities/${encodeURIComponent(secid)}.json`
      + `?from=${from}&start=${start}&iss.meta=off`);
    const cols: string[] = j?.history?.columns ?? [];
    const rows: unknown[][] = j?.history?.data ?? [];
    if (!rows.length) break;
    const c = (n: string) => cols.indexOf(n);
    for (const row of rows) {
      const day = String(row[c('TRADEDATE')]);
      const close = (row[c('CLOSE')] ?? row[c('LEGALCLOSEPRICE')] ?? row[c('WAPRICE')]) as number | null;
      if (close === null || close === undefined) continue;
      const vol = Number(row[c('VOLUME')] ?? 0);
      let price = Number(close);
      let currency = String(row[c('CURRENCYID')] ?? row[c('FACEUNIT')] ?? 'RUB');
      if (market === 'bonds') {
        const face = Number(row[c('FACEVALUE')] ?? 0);
        if (!face) continue;
        price = face * price / 100 + Number(row[c('ACCINT')] ?? 0);
        currency = String(row[c('FACEUNIT')] ?? row[c('CURRENCYID')] ?? 'RUB');
      }
      if (currency === 'SUR') currency = 'RUB';
      const cur = best.get(day);
      if (!cur || vol > cur.vol) best.set(day, { vol, price, currency });
    }
    if (rows.length < 100) break;
    await sleep(80);
  }
  return [...best].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, price: v.price, currency: v.currency }));
}

// ---- FX: USD per unit ----
async function cbrRubHistory(from: string): Promise<[string, number][]> {
  const dm = (day: string) => day.split('-').reverse().join('/');
  const res = await fetch(`https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${dm(from)}&date_req2=${dm(addDays(today(), 1))}&VAL_NM_RQ=R01235`, { headers: UA });
  if (!res.ok) return [];
  const text = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  return [...text.matchAll(/<Record Date="(\d{2})\.(\d{2})\.(\d{4})"[^>]*>[\s\S]*?<Value>([\d,]+)<\/Value>/g)]
    .map(m => [`${m[3]}-${m[2]}-${m[1]}`, 1 / parseFloat(m[4].replace(',', '.'))] as [string, number]);
}

// deno-lint-ignore no-explicit-any
async function selectAll(q: () => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

Deno.serve(async () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const report: Record<string, unknown> = {};
  try {
    // What's needed, and from when.
    const trades = await selectAll(() => db.from('trades').select('user_id, ticker, trade_date, currency'));
    const banks = await selectAll(() => db.from('bank_transactions').select('currency, tx_date').order('tx_date').limit(1));
    const walletBal = await selectAll(() => db.from('wallet_balances').select('ticker').not('ticker', 'is', null));
    const firstTx = await selectAll(() => db.from('wallet_transactions').select('tx_time').order('tx_time').limit(1));
    const since = new Map<string, string>();   // ticker -> first day needed
    const note = (t: string, day: string) => { if (!since.has(t) || day < since.get(t)!) since.set(t, day); };
    for (const t of trades) if (!NO_PRICE.test(t.ticker)) note(t.ticker, t.trade_date);
    const walletStart = firstTx[0] ? String(firstTx[0].tx_time).slice(0, 10) : today();
    for (const w of walletBal) note(w.ticker, walletStart);
    const allDays = [...trades.map(t => t.trade_date), banks[0] ? String(banks[0].tx_date).slice(0, 10) : today(), walletStart].sort();
    const start = allDays[0] || today();

    // 1. FX
    const bankCcy = await db.rpc('distinct_bank_currencies').then(r => (r.data ?? []) as { currency: string }[], () => []);
    const ccys = new Set<string>(['RUB', 'EUR', 'GBP', 'CNY', ...trades.map(t => (t.currency || '').toUpperCase()), ...bankCcy.map(r => r.currency)]);
    ccys.delete(''); ccys.delete('USD');
    for (const x of ['XAU', 'XAG', 'XPT', 'XPD']) ccys.delete(x);
    const fxDone: string[] = [];
    for (const ccy of ccys) {
      if (timeLeft() < 20000) break;
      const { data: last } = await db.from('fx_history').select('day').eq('currency', ccy).order('day', { ascending: false }).limit(1);
      const from = last?.[0] ? addDays(last[0].day, -OVERLAP_DAYS) : addDays(start, -7);
      let rows: [string, number][] = [];
      if (ccy === 'RUB') rows = await cbrRubHistory(from);
      else {
        const h = await yahooHistory(`${ccy}USD=X`, from);
        rows = h ? h.closes : [];
      }
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await db.from('fx_history').upsert(rows.slice(i, i + 1000).map(([day, v]) => ({ currency: ccy, day, usd_per_unit: v })));
        if (error) throw new Error(error.message);
      }
      if (rows.length) fxDone.push(`${ccy}:${rows.length}`);
    }
    report.fx = fxDone;
    // FX in memory for converting prices (LOCF).
    const fx = new Map<string, [string, number][]>();
    const fxOn = async (ccy: string, day: string) => {
      if (ccy === 'USD') return 1;
      if (!fx.has(ccy)) {
        const rows = await selectAll(() => db.from('fx_history').select('day, usd_per_unit').eq('currency', ccy).order('day'));
        fx.set(ccy, rows.map(r => [r.day, Number(r.usd_per_unit)]));
      }
      const rows = fx.get(ccy)!;
      let lo = 0, hi = rows.length - 1, ans: number | null = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= day) { ans = rows[mid][1]; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };

    // 2. Prices
    const { data: mpRows } = await db.from('market_prices').select('ticker, source, asset_class, currency, price_usd');
    const mp = new Map((mpRows ?? []).map(r => [r.ticker, r]));
    const { data: srcRows } = await db.from('price_sources').select('*');
    const sources = new Map((srcRows ?? []).map(r => [r.ticker, r]));
    // Priced by currency / at 0 in refresh_capital_daily: no history needed.
    for (const [t, r] of mp) if (['deposit', 'savings_account', 'money_market_fund', 'blocked'].includes(r.asset_class)) since.delete(t);
    const done: string[] = [], failed: string[] = [];
    // Least recently fetched first, so a partial run moves on next time.
    const lastDay = new Map<string, string>();
    for (const t of since.keys()) {
      const { data } = await db.from('price_history').select('day').eq('ticker', t).order('day', { ascending: false }).limit(1);
      if (data?.[0]) lastDay.set(t, data[0].day);
    }
    const queue = [...since.keys()].sort((a, b) => (lastDay.get(a) ?? '') .localeCompare(lastDay.get(b) ?? ''));
    for (const ticker of queue) {
      if (timeLeft() < 8000) break;
      const from = lastDay.has(ticker) ? addDays(lastDay.get(ticker)!, -OVERLAP_DAYS) : addDays(since.get(ticker)!, -7);
      if (lastDay.get(ticker) === today()) continue;
      // Found nowhere: try again once a week, not every run.
      const cached = sources.get(ticker);
      if (cached?.source === 'none' && Date.now() - Date.parse(cached.updated_at) < 7 * 86400_000) { failed.push(ticker); continue; }
      let src = sources.get(ticker);
      const m = mp.get(ticker);
      let points: { day: string; price: number; currency: string }[] = [];
      const tryYahoo = async (symbol: string) => {
        const h = await yahooHistory(symbol, from);
        if (h && h.closes.length) { points = h.closes.map(([day, price]) => ({ day, price, currency: h.currency })); return true; }
        return false;
      };
      if (src?.source === 'constant' || (!src && m && ['usd_peg', 'cfa_nominal'].includes(m.source))) {
        src = { ticker, source: 'constant', symbol: null, currency: 'USD' };
        points = [{ day: since.get(ticker)!, price: Number(m?.price_usd ?? 1), currency: 'USD' }];
      } else if (src?.source === 'moex_shares' || src?.source === 'moex_bonds') {
        points = await moexHistory(src.symbol, src.source === 'moex_bonds' ? 'bonds' : 'shares', from);
      } else if (src?.source === 'yahoo') {
        await tryYahoo(src.symbol);
      } else if (!src || src.source === 'none') {
        // Resolve: market_prices' own classification first, then guesses.
        const cls = m ? `${m.source}:${m.asset_class}` : '';
        const moexBond = /moex_iss:moex_(ofz|bond)$/.test(cls) || (!m && /^(RU|SU)[0-9A-Z]{10}$/.test(ticker) && /^(SU|RU000A)/.test(ticker));
        const candidates: (() => Promise<boolean>)[] = [];
        const viaMoex = (market: 'shares' | 'bonds') => async () => {
          points = await moexHistory(ticker, market, from);
          if (points.length) { src = { ticker, source: market === 'bonds' ? 'moex_bonds' : 'moex_shares', symbol: ticker, currency: points[0].currency }; return true; }
          return false;
        };
        const viaYahoo = (symbol: string) => async () => {
          if (await tryYahoo(symbol)) { src = { ticker, source: 'yahoo', symbol, currency: points[0].currency }; return true; }
          return false;
        };
        const crypto = CRYPTO_YAHOO[ticker.toUpperCase()] ?? `${ticker.toUpperCase()}-USD`;
        if (moexBond) candidates.push(viaMoex('bonds'));
        else if (m?.source === 'moex_iss') candidates.push(viaMoex('shares'));
        else if (m && /crypto|gold/.test(m.asset_class)) candidates.push(viaYahoo(crypto));
        else if (m?.asset_class === 'western_etf') {
          const o = ETF_OVERRIDE[ticker.toUpperCase()];
          for (const s of o ? [o] : ETF_SUFFIXES) candidates.push(viaYahoo(`${ticker}${s}`));
        } else if (m?.asset_class === 'us_stock') candidates.push(viaYahoo(ticker));
        else {
          candidates.push(viaMoex('shares'), viaYahoo(ticker), viaYahoo(crypto));
          for (const s of ETF_SUFFIXES) candidates.push(viaYahoo(`${ticker}${s}`));
        }
        for (const c of candidates) { if (await c()) break; await sleep(100); }
        if (!src) src = { ticker, source: 'none', symbol: null, currency: null };
        await db.from('price_sources').upsert({ ...src, updated_at: new Date().toISOString() });
      }
      if (!points.length) { failed.push(ticker); continue; }
      const rows = [];
      for (const p of points) {
        const rate = await fxOn(p.currency, p.day);
        if (rate) rows.push({ ticker, day: p.day, price_usd: Math.round(p.price * rate * 1e6) / 1e6 });
      }
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await db.from('price_history').upsert(rows.slice(i, i + 1000));
        if (error) throw new Error(error.message);
      }
      done.push(`${ticker}:${rows.length}`);
      await sleep(80);
    }
    report.prices = done;
    report.no_price = failed;
    report.tickers_left = queue.length - done.length - failed.length;

    // 3. Rebuild every user's history, a slice of days per call (one call
    // for the whole history runs past the API's statement timeout).
    const users = [...new Set(trades.map(t => t.user_id))];
    const rebuilt: Record<string, unknown> = {};
    for (const u of users) {
      const { data: first, error: e1 } = await db.rpc('capital_first_day', { p_user: u });
      if (e1 || !first) { rebuilt[u.slice(0, 8)] = e1 ? `error: ${e1.message}` : 0; continue; }
      let rows = 0, err: string | null = null;
      for (let from = String(first).slice(0, 10); from <= today() && !err; from = addDays(from, SLICE_DAYS)) {
        const to = addDays(from, SLICE_DAYS - 1);
        const { data, error } = await db.rpc('refresh_capital_daily', { p_user: u, p_from: from, p_to: to < today() ? to : today() });
        if (error) err = `error at ${from}: ${error.message}`; else rows += Number(data ?? 0);
      }
      const { data: last } = await db.from('capital_daily').select('day, value_usd').eq('user_id', u)
        .eq('day', today()).neq('account', 'real estate');
      const total = (last ?? []).reduce((a, r) => a + Number(r.value_usd), 0);
      rebuilt[u.slice(0, 8)] = err ?? { rows, today_usd: Math.round(total * 100) / 100 };
    }
    report.capital_rows = rebuilt;
    report.seconds = Math.round((Date.now() - started) / 1000);
    return json(report);
  } catch (err) {
    return json({ ...report, error: String(err) }, 500);
  }
});
