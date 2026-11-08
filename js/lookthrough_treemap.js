// Look-through treemap: pure functions that turn the portfolio into tiles
// and price changes. No DOM, no Supabase -- the caller loads plain data
// (holdings, fund constituents, prices) and draws the result.
//
// fundHoldings mirrors the fund_holdings table with one difference: weight
// here is a fraction of the fund (0..1), the table stores % -- divide by
// 100 when loading. Constituent tickers should be the market_prices ticker
// of the security (securities.market_ticker) where it has one, so a fund's
// line meets the directly held instrument (Vanguard's "T" is AT&T, not
// T-Technologies). One level only, like the portfolio_look_through view:
// a fund inside a fund is not opened further.
// Test: node tests/lookthrough_treemap.test.mjs

export const PERIODS = ['1d', '7d', '1m', '3m', '6m', 'ytd', '1y', '5y', 'all'];

const parseDay = s => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const formatDay = dt => dt.toISOString().slice(0, 10);

// The same day of month `months` months back, clamped to that month's end
// (29.02.2024 one year back -> 28.02.2023).
function monthsBack(today, months) {
  const dt = parseDay(today);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() - months, d = dt.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return formatDay(new Date(Date.UTC(y, m, Math.min(d, lastDay))));
}

// The day a period's change is counted from; null for 'all' (each
// ticker's first price).
export function periodStart(period, today) {
  const daysBack = n => {
    const dt = parseDay(today);
    dt.setUTCDate(dt.getUTCDate() - n);
    return formatDay(dt);
  };
  switch (period) {
    case '1d': return daysBack(1);
    case '7d': return daysBack(7);
    case '1m': return monthsBack(today, 1);
    case '3m': return monthsBack(today, 3);
    case '6m': return monthsBack(today, 6);
    case '1y': return monthsBack(today, 12);
    case '5y': return monthsBack(today, 60);
    case 'ytd': return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case 'all': return null;
    default: throw new Error(`unknown period ${period}`);
  }
}

// A ticker's change over the period, as a fraction (0.05 = +5%): the
// current price against the last price on or before the period's start
// ('all': the first price). A missing price either side is 'nodata',
// never zero.
export function priceChange(ticker, period, prices, today) {
  const nodata = { state: 'nodata', change: null };
  const p = prices?.[ticker];
  if (!p || p.current == null || !p.byDate?.length) return nodata;
  const start = periodStart(period, today);
  let base = null;
  if (start === null) base = p.byDate[0].price;
  else for (const r of p.byDate) { if (r.day > start) break; base = r.price; }
  if (base == null || !(base > 0)) return nodata;
  const change = p.current / base - 1;
  return change === 0 ? { state: 'zero', change: 0 } : { state: 'known', change };
}

// Holdings -> treemap tiles, largest first.
// Every instrument is one tile with its whole exposure: held directly
// (value_usd) plus every fund's part of it (fund value x weight), each
// listed in `sources`. A fund is a tile of its own value; with
// expandFunds its constituents are also spread into the instrument tiles
// and listed as its `children` (that fund's part of each). share is of
// the money actually held -- direct holdings plus funds' own values -- so
// the top-level shares add up to 1 without expandFunds; with it the
// constituents are counted both in their fund and in their own tiles.
// Tiles (and children) of zero or negative value are dropped.
export function aggregate({ holdings, fundHoldings, expandFunds }) {
  const direct = new Map(), funds = new Map();
  for (const h of holdings) {
    const v = Number(h.value_usd) || 0;
    const into = h.kind === 'fund' ? funds : direct;
    into.set(h.ticker, (into.get(h.ticker) || 0) + v);
  }
  const total = [...direct.values(), ...funds.values()].reduce((s, v) => s + v, 0);
  const share = v => (total ? v / total : 0);

  const tiles = new Map();
  const addTo = (tile, from, v) => {
    tile.value_usd += v;
    const src = tile.sources.find(s => s.from === from);
    if (src) src.value_usd += v; else tile.sources.push({ from, value_usd: v });
  };
  const instrument = ticker => {
    if (!tiles.has(ticker)) tiles.set(ticker, { ticker, value_usd: 0, share: 0, sources: [], isFund: false });
    return tiles.get(ticker);
  };
  for (const [ticker, v] of direct) addTo(instrument(ticker), 'direct', v);
  // Fund tiles live under their own key, so a fund also held as a plain
  // instrument somewhere doesn't merge with it.
  const fundKey = t => `fund:${t}`;
  // A fund is expanded only when it has constituents: then it is replaced by
  // its constituents, which are merged by instrument (NVDA in two funds and held
  // directly is one tile). A fund without constituents stays one tile.
  const expanded = new Set(expandFunds ? [...funds.keys()].filter(f => (fundHoldings?.[f] || []).length) : []);
  for (const [ticker, v] of funds) {
    if (expanded.has(ticker)) {
      for (const c of fundHoldings[ticker]) {
        const cv = v * (Number(c.weight) || 0);
        if (cv > 0) addTo(instrument(c.ticker), ticker, cv);
      }
    } else {
      tiles.set(fundKey(ticker), { ticker, value_usd: 0, share: 0, sources: [], isFund: true });
      addTo(tiles.get(fundKey(ticker)), ticker, v);
    }
  }
  const out = [...tiles.values()].filter(t => t.value_usd > 0).sort((a, b) => b.value_usd - a.value_usd);
  for (const t of out) t.share = share(t.value_usd);
  return out;
}

// A tile's change: its own ticker's price change. A fund is judged by the
// fund's own price only -- never rebuilt from its constituents.
export function tileChange(tile, period, prices, today) {
  return priceChange(tile.ticker, period, prices, today);
}

// ---- Credit-card debt netting: ONE copy, used by the pies (index.html) and the treemap.
// Russian banks' card debt is netted against Russian liquid rows, other cards against
// the rest, in proportion to size. A negative non-credit row is taken as is.
export const RU_ACCOUNTS = new Set(['Sber', 'T-Bank', 'Alfa', 'Ozon Bank', 'Yandex Bank', 'Finuslugi']);
export function isRuInfra(r) {
  return RU_ACCOUNTS.has(r.account) || (r.account === '(unspecified)' && r.infra_region === 'ru');
}
export function netCreditIntoLiquid(rows) {
  const factor = {};
  for (const ru of [true, false]) {
    const group = rows.filter(r => isRuInfra(r) === ru);
    const credit = group.filter(r => r.instrument_type === 'credit').reduce((s, r) => s + r.value_usd, 0);
    const liquid = group.filter(r => r.instrument_type === 'liquid' && r.value_usd > 0).reduce((s, r) => s + r.value_usd, 0);
    factor[ru] = liquid > 0 ? Math.max(0, (liquid + credit) / liquid) : 1;
  }
  return rows.filter(r => r.instrument_type !== 'credit')
    .map(r => (r.instrument_type === 'liquid' && r.value_usd > 0 ? { ...r, value_usd: r.value_usd * factor[isRuInfra(r)] } : r));
}
