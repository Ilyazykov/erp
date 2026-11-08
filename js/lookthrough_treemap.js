// Look-through treemap: pure functions that turn the portfolio into tiles
// and their colour (earned over invested, tileEarned). No DOM, no Supabase
// -- the caller loads plain data (the pies' rows, fund constituents,
// investment_by_asset rows, prices) and draws the result.
//
// fundHoldings mirrors the fund_holdings table with one difference: weight
// here is a fraction of the fund (0..1), the table stores % -- divide by
// 100 when loading. Constituent tickers should be the market_prices ticker
// of the security (securities.market_ticker) where it has one, so a fund's
// line meets the directly held instrument (Vanguard's "T" is AT&T, not
// T-Technologies). One level only, like the portfolio_look_through view:
// a fund inside a fund is not opened further.
// Test: node tests/lookthrough_treemap.test.mjs

export const PERIODS = ['1d', '2d', '3d', '7d', '1m', '3m', '6m', 'ytd', '1y', '5y', 'all'];

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
    case '2d': return daysBack(2);
    case '3d': return daysBack(3);
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

// The tickers merged into one gold tile (mergeGold): the metal account and
// the token are two parts of one holding of gold.
export const GOLD_TICKERS = ['XAU', 'XAUT'];

// Savings chains: savings products linked by transfers between them (the
// money moved Finuslugi -> Ozon -> Alfa for the rate) are one group, found by
// union-find over the links. links: [{ from, to, day }] -- the two products'
// tickers (SAVINGS: / DEPOSIT: / ВКЛАД:) and the day the money moved. Returns
// the groups of two or more tickers.
export function savingsChains(links) {
  const parent = new Map();
  const find = t => {
    if (!parent.has(t)) parent.set(t, t);
    while (parent.get(t) !== t) { parent.set(t, parent.get(parent.get(t))); t = parent.get(t); }
    return t;
  };
  for (const l of links || []) {
    if (!l.from || !l.to || l.from === l.to) continue;
    const a = find(l.from), b = find(l.to);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map();
  for (const t of parent.keys()) {
    const root = find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

// Rows (or the older holdings) -> treemap tiles, largest first.
// rows: the capital pies' rows { ticker, value_usd, instrument_type, account,
// infra_region }, credit rows included: the card debt is netted into the
// liquid rows first (netCreditIntoLiquid, as the pies do) and is never a tile.
// A row is a fund when fundHoldings has its ticker. The cushion's rows are
// left out unless includeCushion. holdings: [{ ticker, value_usd, kind }]
// (kind 'direct' | 'fund'), taken as they are -- no netting, no cushion.
// Every instrument is one tile with its whole exposure: held directly (all
// its rows, in any account) plus every fund's part of it (fund value x
// weight), each listed in `sources`. A fund is a tile of its own value; with
// expandFunds a fund that has constituents is replaced by them, merged into
// the instrument tiles. share is of the money actually held -- the positive
// rows after netting, the cushion counted even when not drawn -- so the
// shares add up to 1 with the cushion shown.
// mergeGold: XAU and XAUT are one tile 'GOLD' (isGold, parts).
// mergeSavings: the products of a savings chain (savingsChains(savingsLinks))
// are one tile (isChain, members), named after its most recent member -- the
// latest savingsPeriods[ticker].last ({ first, last } days), else the
// product money last moved into. Closed members are listed too: their
// earnings belong to the chain.
// Tiles of zero or negative value are dropped.
// A cash or cushion row has no ticker: it gets one per currency ('CASH USD', 'CASH RUB', ...),
// so the bank balances in one currency are one tile and each has a label.
function unlistedTicker(r) {
  const kind = r.instrument_type === 'cushion' ? 'CUSHION' : r.instrument_type === 'cash' ? 'CASH' : String(r.instrument_type || 'OTHER').toUpperCase();
  return `${kind} ${r.currency || 'USD'}`;
}
export function aggregate({ rows, holdings, fundHoldings, expandFunds = false, includeCushion = false, includeRealEstate = false,
  mergeGold = true, mergeSavings = true, savingsLinks = [], savingsPeriods = {} }) {
  const isFundTicker = t => Object.prototype.hasOwnProperty.call(fundHoldings || {}, t);
  let entries, typeOf = new Map();
  if (rows) {
    // real estate is not on the map (it is not in the pies' totals either; it has no price history)
    const netted = netCreditIntoLiquid(rows.filter(r => Number.isFinite(Number(r.value_usd)))
      .filter(r => !r.excluded && (includeRealEstate || (r.account !== 'real estate' && r.instrument_type !== 'real_estate')))
      .map(r => ({ ...r, value_usd: Number(r.value_usd) })));
    entries = netted.filter(r => r.value_usd > 0)
      .map(r => ({ ticker: r.ticker || unlistedTicker(r), value_usd: r.value_usd, kind: isFundTicker(r.ticker) ? 'fund' : 'direct',
        cushion: r.instrument_type === 'cushion', instrument_type: r.instrument_type }));
    // a ticker's type: of its biggest non-cushion row
    for (const e of [...entries].sort((x, y) => x.value_usd - y.value_usd)) {
      if (!e.cushion || !typeOf.has(e.ticker)) typeOf.set(e.ticker, e.cushion ? 'cushion' : e.instrument_type);
    }
  } else {
    entries = (holdings || []).map(h => ({ ticker: h.ticker, value_usd: Number(h.value_usd) || 0, kind: h.kind }));
  }
  const total = entries.reduce((s, e) => s + (e.value_usd > 0 ? e.value_usd : 0), 0);
  const share = v => (total ? v / total : 0);

  const direct = new Map(), funds = new Map();
  for (const e of entries) {
    if (e.cushion && !includeCushion) continue;
    const into = e.kind === 'fund' ? funds : direct;
    into.set(e.ticker, (into.get(e.ticker) || 0) + e.value_usd);
  }

  const tiles = new Map();
  const addTo = (tile, from, v) => {
    tile.value_usd += v;
    const src = tile.sources.find(s => s.from === from);
    if (src) src.value_usd += v; else tile.sources.push({ from, value_usd: v });
  };
  const newTile = (ticker, isFund) => {
    const t = { ticker, value_usd: 0, share: 0, sources: [], isFund };
    if (typeOf.has(ticker)) t.instrument_type = typeOf.get(ticker);
    return t;
  };
  const instrument = ticker => {
    if (!tiles.has(ticker)) tiles.set(ticker, newTile(ticker, false));
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
      const parts = fundHoldings[ticker].map(c => ({ ticker: c.ticker, value_usd: v * (Number(c.weight) || 0) })).filter(p => p.value_usd > 0);
      // the listed weights need not add up to 1 (the cash / other line is not an instrument,
      // a list can run a little over): scale an overshoot down, and what the list does not
      // cover stays a tile of the fund itself, so expanding never changes the total
      const listed = parts.reduce((s, p) => s + p.value_usd, 0);
      const k = listed > v ? v / listed : 1;
      for (const p of parts) addTo(instrument(p.ticker), ticker, p.value_usd * k);
      const rest = v - listed * k;
      if (rest > v * 1e-6) {
        if (!tiles.has(fundKey(ticker))) tiles.set(fundKey(ticker), newTile(ticker, true));
        addTo(tiles.get(fundKey(ticker)), ticker, rest);
      }
    } else {
      tiles.set(fundKey(ticker), newTile(ticker, true));
      addTo(tiles.get(fundKey(ticker)), ticker, v);
    }
  }

  // Several instrument tiles -> one: each member's value is a source under its
  // own ticker (XAU 500, XAUT 300).
  const merge = (key, tickers, extra) => {
    const t = { ticker: key, value_usd: 0, share: 0, sources: [], isFund: false, ...extra };
    for (const m of tickers) {
      const mt = tiles.get(m);
      if (!mt) continue;
      addTo(t, m, mt.value_usd);
      if (!t.instrument_type && mt.instrument_type) t.instrument_type = mt.instrument_type;
      tiles.delete(m);
    }
    tiles.set(`merged:${key}`, t);
    return t;
  };
  if (mergeSavings) {
    for (const group of savingsChains(savingsLinks)) {
      const lastIn = new Map();
      for (const l of savingsLinks) if (group.includes(l.to) && (l.day || '') >= (lastIn.get(l.to) || '')) lastIn.set(l.to, l.day || '');
      const recency = m => savingsPeriods?.[m]?.last ?? lastIn.get(m) ?? '';
      const valueOf = m => tiles.get(m)?.value_usd || 0;
      const latest = [...group].sort((a, b) => (recency(b) > recency(a) ? 1 : recency(b) < recency(a) ? -1 : valueOf(b) - valueOf(a)))[0];
      const members = group.map(m => ({ ticker: m, value_usd: valueOf(m), first: savingsPeriods?.[m]?.first ?? null,
        last: savingsPeriods?.[m]?.last ?? null }));
      merge(latest, group, { isChain: true, members });
    }
  }
  if (mergeGold && GOLD_TICKERS.some(g => tiles.has(g))) {
    const parts = GOLD_TICKERS.filter(g => tiles.has(g)).map(g => ({ ticker: g, value_usd: tiles.get(g).value_usd }));
    merge('GOLD', GOLD_TICKERS, { isGold: true, parts });
  }

  const out = [...tiles.values()].filter(t => t.value_usd > 0).sort((a, b) => b.value_usd - a.value_usd);
  for (const t of out) t.share = share(t.value_usd);
  return out;
}

// The value-weighted change of a merged tile's parts: [{ value_usd, state,
// change }]. A 'nodata' part is left out; none known -> 'nodata'.
function weightedChange(parts) {
  const known = parts.filter(p => p.state !== 'nodata' && p.value_usd > 0);
  const den = known.reduce((s, p) => s + p.value_usd, 0);
  if (!known.length || !(den > 0)) return { state: 'nodata', change: null };
  const change = known.reduce((s, p) => s + p.value_usd * p.change, 0) / den;
  return change === 0 ? { state: 'zero', change: 0 } : { state: 'known', change };
}

// The merged gold tile's price change: its parts' ([{ ticker, value_usd }])
// changes weighted by their value now.
export function goldChange(parts, period, prices, today) {
  return weightedChange(parts.map(p => ({ value_usd: p.value_usd, ...priceChange(p.ticker, period, prices, today) })));
}

// A tile's price change: its own ticker's. A fund is judged by the fund's
// own price only -- never rebuilt from its constituents; the merged gold tile
// by goldChange. (The treemap's colour is tileEarned, not this.)
export function tileChange(tile, period, prices, today) {
  if (tile.isGold && tile.parts) return goldChange(tile.parts, period, prices, today);
  return priceChange(tile.ticker, period, prices, today);
}

// ---- Earned / invested: the colour ----
// From the "Invested vs earned" tab's per-asset numbers: the rows of the
// investment_by_asset(p_from, p_to, p_ccy) rpc for p_from = periodStart (for
// 'all': the first day anything was held), p_to = today -- { asset,
// value_start, value_end, put_in, taken_out, income, kind }. Own money in and
// out after the start is put_in / taken_out; a dividend, a coupon, Alfa's
// payout come out of the paper in cash, so the rpc counts them taken out
// (and income) -- they're earned, not own money back. A savings account's or
// deposit's interest and crypto's rewards stay in (income only).
// earned = value_end - value_start - put_in + taken_out (the rpc's earned);
// base = value_start + own money put in less taken out after the start;
// change = earned / base. A paper bought in the period starts at 0 and is
// judged by its own money in; a sale at a profit takes its proceeds off the
// base and keeps the profit in earned. base <= 0 (sold out, nothing put in):
// 'nodata', note 'no invested base'.
const INCOME_STAYS_IN = new Set(['liquid', 'deposit', 'crypto', 'cushion']);
export function earnedRatio(r) {
  if (!r) return { state: 'nodata', change: null, note: 'no value' };
  const n = k => Number(r[k]) || 0;
  const v0 = n('value_start'), v1 = n('value_end'), putIn = n('put_in'), takenOut = n('taken_out');
  if (!v0 && !v1 && !putIn && !takenOut) return { state: 'nodata', change: null, note: 'no value' };
  const paidOut = INCOME_STAYS_IN.has(r.kind) ? 0 : n('income');
  const earned = v1 - v0 - putIn + takenOut;
  const base = v0 + putIn - (takenOut - paidOut);
  if (!(base > 0)) return { state: 'nodata', change: null, note: 'no invested base', earned, base };
  const change = earned / base;
  return change === 0 ? { state: 'zero', change: 0, earned, base } : { state: 'known', change, earned, base };
}

// investment_by_asset's name for a ticker of the capital rows (a blocked
// fund's part is the fund; staked ETH is ETH).
export function assetKey(ticker) {
  const t = String(ticker).toUpperCase();
  if (t === 'TEUR2' || t === 'TUSD2') return t.slice(0, 4);
  if (t === 'STETH' || t === 'WSTETH' || t === 'GG') return 'ETH';
  return t;
}

// A tile's colour value: earnedRatio of its asset's investment_by_asset row.
// A savings chain: its members' rows summed -- the transfers between them
// cancel (the sell in one is the buy in the next) -- and judged as one. The
// merged gold tile: its parts' ratios weighted by their value now (as
// goldChange). assetOf maps a ticker to the rpc's asset where assetKey isn't
// enough (an exchange's stablecoins and Earn are 'USD' there).
export function tileEarned(tile, earnedRows, { assetOf = assetKey, realEstate = null } = {}) {
  // real estate has no purchase/sale history on this tab: its colour is the index change (see reEstateChange)
  if (String(tile.ticker).startsWith('REAL_ESTATE')) return realEstate || earnedRatio(null);
  // cash has no price: dollars are exactly zero; other currencies have no rate history here
  if (tile.ticker === 'CASH USD') return { state: 'zero', change: 0 };
  if (String(tile.ticker).startsWith('CASH ') || String(tile.ticker).startsWith('CUSHION ')) return earnedRatio(null);
  const byAsset = new Map((earnedRows || []).map(r => [String(r.asset).toUpperCase(), r]));
  const rowOf = t => byAsset.get(String(assetOf(t)).toUpperCase());
  if (tile.isChain && tile.members) {
    const got = tile.members.map(m => rowOf(m.ticker)).filter(Boolean);
    if (!got.length) return earnedRatio(null);
    const sum = k => got.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    // income stays in a savings product; a paid-out one is taken off per member
    const paidOut = got.reduce((s, r) => s + (INCOME_STAYS_IN.has(r.kind) ? 0 : Number(r.income) || 0), 0);
    return earnedRatio({ value_start: sum('value_start'), value_end: sum('value_end'), put_in: sum('put_in'),
      taken_out: sum('taken_out'), income: paidOut, kind: 'chain' });
  }
  if (tile.isGold && tile.parts) {
    return weightedChange(tile.parts.map(p => ({ value_usd: p.value_usd, ...earnedRatio(rowOf(p.ticker)) })));
  }
  return earnedRatio(rowOf(tile.ticker));
}

// Real estate colour: the change of the price per m2 in the city's index between the
// period's base month and the latest month. indexRows: [{ month: 'YYYY-MM-DD', price_per_m2 }].
export function reEstateChange(indexRows, period, today) {
  const rows = (indexRows || []).filter(r => Number(r.price_per_m2) > 0).sort((a, b) => (a.month < b.month ? -1 : 1));
  if (!rows.length) return { state: 'nodata', change: null };
  const cur = rows[rows.length - 1].price_per_m2;
  const start = periodStart(period, today);
  const base = start === null ? rows[0] : [...rows].reverse().find(r => r.month <= start);
  if (!base) return { state: 'nodata', change: null };
  const change = cur / base.price_per_m2 - 1;
  return change === 0 ? { state: 'zero', change: 0 } : { state: 'known', change };
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

// ---- Layout: squarified treemap (Bruls, Huizing, van Wijk) ----
// items: [{ value, ... }] -> [{ item, x, y, w, h }] filling the rectangle, each
// item's area proportional to its value (the values are rescaled to the area).
// Largest first; each row is laid along the shorter side while its worst
// aspect ratio doesn't get worse.
export function squarify(items, x, y, w, h) {
  const list = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, i) => s + i.value, 0);
  if (!(total > 0) || !(w > 0) || !(h > 0)) return [];
  const k = (w * h) / total;
  const rest = list.map(item => ({ item, area: item.value * k }));
  const out = [];
  const worst = (areas, side) => {
    const s = areas.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...areas)) / (s * s), (s * s) / (side * side * Math.min(...areas)));
  };
  let rx = x, ry = y, rw = w, rh = h;
  while (rest.length) {
    const side = Math.min(rw, rh);
    let n = 1, best = worst([rest[0].area], side);
    while (n < rest.length) {
      const r = worst(rest.slice(0, n + 1).map(t => t.area), side);
      if (r > best) break;
      best = r; n++;
    }
    const row = rest.splice(0, n);
    const thick = row.reduce((s, t) => s + t.area, 0) / side;
    if (rw >= rh) {
      let cy = ry;
      for (const t of row) { const hh = t.area / thick; out.push({ item: t.item, x: rx, y: cy, w: thick, h: hh }); cy += hh; }
      rx += thick; rw = Math.max(0, rw - thick);
    } else {
      let cx = rx;
      for (const t of row) { const ww = t.area / thick; out.push({ item: t.item, x: cx, y: ry, w: ww, h: thick }); cx += ww; }
      ry += thick; rh = Math.max(0, rh - thick);
    }
  }
  return out;
}

// ---- Colour ----
export const SATURATE_AT = 0.12;
const NEUTRAL = 'hsl(215, 8%, 34%)';        // exactly zero
const NODATA = 'repeating-linear-gradient(135deg, #1b1f24 0 6px, #14181c 6px 12px)';   // no data: darker, striped
// growth green / fall red, brighter the bigger the change, saturating at +/-12%
// scale: the change that is fully saturated (the largest change on the map now, see wireTreemap)
export function tileColor(state, change, scale = SATURATE_AT) {
  if (state === 'nodata' || change == null) return NODATA;
  if (state === 'zero' || change === 0) return NEUTRAL;
  const t = Math.min(Math.abs(change) / scale, 1);
  return `hsl(${change > 0 ? 135 : 4}, ${40 + 40 * t}%, ${24 + 20 * t}%)`;
}
export const LEGEND_STOPS = [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12];

export function formatChange(change) {
  const p = change * 100;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(Math.abs(p) < 0.1 && p !== 0 ? 2 : 1)}%`;
}

// ---- Savings links and periods from the savings trades ----
// trades: [{ ticker, side, quantity, price, trade_date, currency, note }] of the
// SAVINGS: / DEPOSIT: / ВКЛАД: tickers. A sell in one product and a buy of the
// same amount in another, the same day or the next, is the money moving on --
// directly or through the card (the card leg between two savings legs): a link.
// Interest bought into the balance is not a transfer. Each leg is used once.
export function buildSavingsLinks(trades) {
  const amount = t => (Number(t.quantity) || 0) * (Number(t.price) || 1);
  const isInterest = t => /interest|капитализац|процент/i.test(t.note || '');
  const dayNo = d => Date.parse(d) / 86400000;
  const sorted = [...trades].sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
  // a T-Bank deposit is never merged: it stays a tile of its own
  const alone = t => /^DEPOSIT:T-Bank/i.test(t.ticker || '');
  const sells = sorted.filter(t => t.side === 'sell' && !alone(t));
  const buys = sorted.filter(t => t.side === 'buy' && !isInterest(t) && !alone(t));
  const used = new Set(), links = [];
  for (const s of sells) {
    const b = buys.find(x => !used.has(x) && x.ticker !== s.ticker && (x.currency || 'RUB') === (s.currency || 'RUB')
      && Math.abs(amount(x) - amount(s)) < 0.005 && dayNo(x.trade_date) - dayNo(s.trade_date) >= 0
      && dayNo(x.trade_date) - dayNo(s.trade_date) <= 1);
    if (!b) continue;
    used.add(b);
    links.push({ from: s.ticker, to: b.ticker, day: b.trade_date });
  }
  const periods = {};
  for (const t of sorted) {
    const p = periods[t.ticker] || (periods[t.ticker] = { first: t.trade_date, last: t.trade_date });
    if (t.trade_date < p.first) p.first = t.trade_date;
    if (t.trade_date > p.last) p.last = t.trade_date;
  }
  return { links, periods };
}

// Revolut's Flexible Cash Funds are known by ISIN only: a short name for a tile
export const FUND_NAMES = {
  IE000H9J0QX4: 'Revolut USD', IE000AZVL3K0: 'Revolut EUR', IE0002RUHW32: 'Revolut GBP',
};

// ---- Drawing ----
const MIN_PAD = 5, LINE = 15;
let measureCtx;
function textWidth(text, bold) {
  try {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = `${bold ? 'bold ' : ''}12px system-ui, sans-serif`;
    return measureCtx.measureText(text).width;
  } catch { return text.length * (bold ? 8 : 7); }
}
const usd = v => `$${Math.round(v).toLocaleString('en-US')}`;

// The tooltip's lines of a tile: ticker, value, share, change, and how it is
// held. A tile with no data says only that.
function tooltipLines(tile, e, name = tile.ticker) {
  const head = name === tile.ticker ? [tile.ticker] : [name, tile.ticker];
  if (e.state === 'nodata') return [...head, 'no price history'];
  const lines = [...head, `value ${usd(tile.value_usd)}`, `share ${(tile.share * 100).toFixed(2)}%`,
    `change ${e.state === 'zero' ? '0.0%' : formatChange(e.change)}`];
  if (tile.isGold && tile.parts) lines.push(tile.parts.map(p => `${p.ticker} ${usd(p.value_usd)}`).join(', '));
  else if (tile.isChain && tile.members) lines.push('merged savings');
  else if (tile.sources.length > 1 || tile.sources.some(s => s.from !== 'direct')) {
    lines.push(tile.sources.map(s => `${s.from === 'direct' ? 'direct' : s.from} ${usd(s.value_usd)}`).join(', '));
  }
  return lines;
}

// Draws the tiles into `container`: tiles from aggregate(), earned(tile) -> the
// colour state { state, change } of tileEarned. Flat; no children.
export function drawTreemap(container, tiles, earned, opts = {}) {
  const { tip, group = false, depth = 0, scale = SATURATE_AT, names = {} } = opts;
  // values are cents: a tile under one cent is dust (e.g. a stablecoin fraction), not drawn
  tiles = tiles.map(t => ({ ...t, value_usd: Math.round(t.value_usd * 100) / 100 })).filter(t => t.value_usd >= 0.01);
  container.textContent = '';
  const W = container.clientWidth, H = container.clientHeight;
  if (!(W > 0) || !(H > 0)) return;
  // tiles under 0.2% of the portfolio are too thin to read: they go into one grey tile
  const SMALL = 0.002;
  const small = group ? tiles.filter(t => t.share < SMALL) : [], big = tiles.filter(t => !group || t.share >= SMALL);
  // every tile gets at least MIN_AREA px² in the layout, so a one-cent tile is visible; the floor
  // takes a fraction of a percent of the box, so the big tiles keep their size
  const MIN_AREA = 4, minShare = MIN_AREA / (W * H);
  const items = big.map(t => ({ value: Math.max(t.share, minShare), tile: t }));
  if (small.length) {
    const groupShare = small.reduce((s, t) => s + t.share, 0);
    items.push({ value: groupShare, tile: { ticker: `${small.length} small`, share: groupShare, value_usd: small.reduce((s, t) => s + t.value_usd, 0), isGroup: true, members: small } });
  }
  // the thin end of a layout can run a hair past the box: every tile is clipped to the box
  const rects = squarify(items, 0, 0, W, H).map(r => {
    const x0 = Math.max(0, Math.min(W, r.x)), y0 = Math.max(0, Math.min(H, r.y));
    const x1 = Math.max(0, Math.min(W, r.x + r.w)), y1 = Math.max(0, Math.min(H, r.y + r.h));
    return { ...r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }).filter(r => r.w > 0 && r.h > 0);
  const frag = document.createDocumentFragment();
  for (const r of rects) {
    const tile = r.item.tile, e = tile.isGroup ? { state: 'group' } : earned(tile);
    const name = names[tile.ticker] || tile.ticker;
    const el = document.createElement('div');
    el.className = 'lt-tile';
    // the outline is an inset shadow and the padding comes only with a label: a border or padding
    // would force a tile to at least 10px, so thin tiles stuck out of the box
    Object.assign(el.style, { position: 'absolute', boxSizing: 'border-box', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px #0d1117',
      // positions in percent of the box, so the tiles fill it whatever its size is when drawn
      left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%`,
      background: tile.isGroup ? '#2a2f36' : tileColor(e.state, e.change, scale),
      color: '#fff', padding: '0px', lineHeight: `${LINE}px`, fontSize: '12px', cursor: 'default' });
    if (tile.isGroup) {
      if (r.w >= textWidth(tile.ticker, true) + 2 * MIN_PAD + 2 && r.h >= LINE + 2 * MIN_PAD) {
        const a = document.createElement('div');
        a.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden';
        a.textContent = tile.ticker; el.append(a);
      }
    } else if (e.state === 'nodata') {
      // no price: no change to show, but a big tile still names its instrument
      const fitW = textWidth(name, true) + 2 * MIN_PAD + 2;
      if (r.w >= fitW && r.h >= LINE + 2 * MIN_PAD) {
        const a = document.createElement('div');
        a.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden';
        a.textContent = name; el.append(a);
      }
    } else {
      const change = e.state === 'zero' ? '0.0%' : formatChange(e.change);
      const fitW = Math.max(textWidth(name, true), textWidth(change, false)) + 2 * MIN_PAD + 2;
      if (r.w >= fitW && r.h >= 2 * LINE + 2 * MIN_PAD) {
        const a = document.createElement('div'), b = document.createElement('div');
        a.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden';
        b.style.cssText = 'white-space:nowrap;overflow:hidden';
        a.textContent = name; b.textContent = change;
        el.append(a, b);
      }
    }
    if (el.childNodes.length) el.style.padding = `${MIN_PAD - 1}px`;
    if (tip) {
      const lines = tile.isGroup ? [`${tile.members.length} small positions`, ...tile.members.map(m => `${m.ticker} ${(m.share * 100).toFixed(2)}%`)] : tooltipLines(tile, e, name);
      el.addEventListener('mousemove', ev => {
        tip.textContent = '';
        lines.forEach((l, i) => { const d = document.createElement('div'); if (i === 0) d.style.fontWeight = 'bold'; d.textContent = l; tip.append(d); });
        tip.style.display = 'block';
        const box = container.getBoundingClientRect();
        let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
        if (x + tip.offsetWidth > box.width) x = Math.max(0, ev.clientX - box.left - tip.offsetWidth - 14);
        if (y + tip.offsetHeight > box.height) y = Math.max(0, ev.clientY - box.top - tip.offsetHeight - 14);
        tip.style.left = `${x}px`; tip.style.top = `${y}px`;
      });
      el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    frag.append(el);
  }
  container.append(frag);
  // the page can change the box after the layout was measured (a scrollbar appearing): if the
  // box is not the size the tiles were laid out for, lay them out again for the real size
  if (depth < 3) {
    requestAnimationFrame(() => {
      if (container.clientWidth !== W || container.clientHeight !== H) drawTreemap(container, tiles, earned, { ...opts, depth: depth + 1 });
    });
  }
}

export function drawLegend(el, scale = SATURATE_AT) {
  el.textContent = '';
  // the scale's ticks: the same fractions of the saturation point as LEGEND_STOPS of 12%
  const ticks = LEGEND_STOPS.map(s => s * scale / SATURATE_AT);
  const stops = ticks.map((s, i) => `${tileColor(s === 0 ? 'zero' : 'known', s, scale)} ${(i / (ticks.length - 1) * 100).toFixed(1)}%`);
  const bar = document.createElement('div');
  bar.style.cssText = `height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops.join(', ')})`;
  const labels = document.createElement('div');
  labels.style.cssText = 'display:flex;justify-content:space-between;font-size:0.72rem;color:#6a7381;margin-top:2px';
  for (const s of ticks) {
    const sp = document.createElement('span');
    sp.textContent = s === 0 ? '0%' : formatChange(s);
    labels.append(sp);
  }
  const swatch = (bg, text) => {
    const s = document.createElement('span');
    s.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-right:12px';
    const i = document.createElement('i');
    i.style.cssText = `width:12px;height:12px;border-radius:2px;background:${bg};display:inline-block;border:1px solid #1e2830`;
    s.append(i, text);
    return s;
  };
  const extra = document.createElement('div');
  extra.style.cssText = 'font-size:0.72rem;color:#6a7381;margin-top:6px';
  extra.append(swatch(NEUTRAL, 'no change'), swatch(NODATA, 'no data'));
  el.append(bar, labels, extra);
}

// ---- Wiring (runs only in the page: the container is there) ----
// Reuses the page's own loaders (index.html's classic script globals): the pies'
// rows (mpLoadPortfolioBase, mpSplitFundsCash, mpWithCushion), snowballFetchAll,
// the Supabase client `sb`, and investment_by_asset for the colour. A period
// switch fetches that period's earned rows once (cached); the checkboxes only
// redraw from what is loaded.
// A currency's change against the dollar from one day to another: fx is a Map of currency ->
// [[day, usd_per_unit]] ascending (fx_history). Each day takes the last rate on or before it.
export function fxChange(fx, currency, from, to) {
  const series = fx?.get(currency);
  if (!series) return null;
  const on = d => { let v = null; for (const [day, k] of series) { if (day > d) break; v = k; } return v; };
  const a = on(from), b = on(to);
  return a && b ? b / a - 1 : null;
}

function wireTreemap() {
  const $ = id => document.getElementById(id);
  const box = $('lt_treemap');
  if (!box) return;
  const tip = $('lt_tip'), status = $('lt_status');
  const g = name => (typeof window[name] === 'function' ? window[name] : null);
  let data = null, loading = null, run = 0;
  const earnedCache = new Map();
  let period = '1d';
  const today = () => new Date().toISOString().slice(0, 10);

  async function loadData() {
    // eslint-disable-next-line no-undef
    const base = await mpLoadPortfolioBase();
    // eslint-disable-next-line no-undef
    const rows = [...await mpSplitFundsCash(base.data), ...base.cashRows, ...base.realEstateRows].filter(r => r.value_usd !== null);
    // fund constituents: weight as a fraction, the market_prices ticker where the security has one
    // eslint-disable-next-line no-undef
    const fh = await snowballFetchAll(() => sb.from('fund_holdings').select('fund, security_id, weight').order('fund').order('security_id'));
    const ids = [...new Set(fh.map(r => r.security_id))].filter(id => id !== 'OTHER');
    const sec = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      // eslint-disable-next-line no-undef
      const { data: s, error } = await sb.from('securities').select('id, ticker, market_ticker').in('id', ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const r of s) sec.set(r.id, r.market_ticker || r.ticker);
    }
    const fundHoldings = {};
    for (const r of fh) {
      const t = sec.get(r.security_id);
      if (!t) continue;
      (fundHoldings[r.fund] = fundHoldings[r.fund] || []).push({ ticker: t, weight: Number(r.weight) / 100 });
    }
    // eslint-disable-next-line no-undef
    const savings = await snowballFetchAll(() => sb.from('trades').select('ticker, side, quantity, price, trade_date, currency, note, id')
      .or('ticker.like.SAVINGS:%,ticker.like.DEPOSIT:%,ticker.like.ВКЛАД:%').in('side', ['buy', 'sell']).order('trade_date').order('id'));
    const { links, periods } = buildSavingsLinks(savings);
    // 'all': counted from the first purchase in the trades table
    // eslint-disable-next-line no-undef
    const { data: first } = await sb.from('trades').select('trade_date').eq('side', 'buy').order('trade_date').limit(1);
    // eslint-disable-next-line no-undef
    const { data: reIndex } = await sb.from('real_estate_index').select('month, price_per_m2').eq('city', 'nizhny_novgorod').order('month');
    // the rates of the currencies held in cash (fx_history, the page's rates): their change is the cash tile's colour
    const ccys = [...new Set(rows.map(r => r.currency).filter(c => c && c !== 'USD'))];
    const fx = new Map();
    if (ccys.length) {
      // eslint-disable-next-line no-undef
      const fxRows = await snowballFetchAll(() => sb.from('fx_history').select('currency, day, usd_per_unit').in('currency', ccys).order('day'));
      for (const r of fxRows) {
        if (!fx.has(r.currency)) fx.set(r.currency, []);
        fx.get(r.currency).push([r.day, Number(r.usd_per_unit)]);
      }
    }
    return { rows, fundHoldings, savingsLinks: links, savingsPeriods: periods, firstDay: first?.[0]?.trade_date || '2000-01-01', reIndex: reIndex || [], fx };
  }

  async function earnedFor(p) {
    if (!earnedCache.has(p)) {
      const from = periodStart(p, today()) ?? data.firstDay;
      // eslint-disable-next-line no-undef
      const { data: rows, error } = await sb.rpc('investment_by_asset', { p_from: from, p_to: today(), p_ccy: 'USD' });
      if (error) throw new Error(error.message);
      earnedCache.set(p, rows);
    }
    return earnedCache.get(p);
  }

  // stablecoins are dollars (the page's SNOWBALL_STABLECOINS); anything else by assetKey
  const stable = typeof SNOWBALL_STABLECOINS !== 'undefined' ? SNOWBALL_STABLECOINS : new Set();
  const assetOf = t => (stable.has(String(t).toUpperCase()) ? 'USD' : assetKey(t));

  // the last drawn tiles are redrawn whenever the box changes size (a page scrollbar appearing
  // changed its width after the layout was done: the tiles ran 10px past the box)
  let last = null;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { if (last) drawTreemap(box, ...last); }).observe(box);
  }
  async function redraw() {
    const my = ++run;
    status.textContent = 'Loading…';
    try {
      if (!data) data = await (loading = loading || loadData());
      const earnedRows = await earnedFor(period);
      if (my !== run) return;
      const cushion = $('lt_cushion').checked;
      let rows = data.rows;
      if (cushion && g('mpWithCushion')) rows = [...window.mpWithCushion(rows.filter(r => r.account !== 'real estate')), ...rows.filter(r => r.account === 'real estate')];
      const tiles = aggregate({ rows, fundHoldings: data.fundHoldings, expandFunds: $('lt_expand').checked, includeCushion: cushion,
        mergeGold: $('lt_gold').checked, mergeSavings: $('lt_savings').checked, savingsLinks: data.savingsLinks, savingsPeriods: data.savingsPeriods,
        includeRealEstate: $('lt_re').checked });
      // the box keeps its proportions in CSS (aspect-ratio), so the layout is always for its real size
      const realEstate = reEstateChange(data.reIndex, period, today());
      const from = periodStart(period, today()) ?? data.firstDay;
      // a cash tile in a currency: the currency's change against the dollar over the period
      const colour = tile => {
        if (/^CASH [A-Z]{3}$/.test(tile.ticker) && tile.ticker !== 'CASH USD') {
          const ch = fxChange(data.fx, tile.ticker.slice(5), from, today());
          return ch == null ? earnedRatio(null) : ch === 0 ? { state: 'zero', change: 0 } : { state: 'known', change: ch };
        }
        return tileEarned(tile, earnedRows, { assetOf, realEstate });
      };
      // the colour scale is this period's largest change on the map (so a one-day map is not all pale)
      const changes = tiles.filter(t => !t.isGroup).map(colour).filter(e => e.state === 'known' && e.change != null).map(e => Math.abs(e.change));
      const scale = Math.max(...changes, 0.001);
      // human names: Revolut's funds, and the bonds by MOEX's name (cached in the browser) instead of the ISIN
      let bondNames = {};
      try { bondNames = g('mpBondNames') ? await window.mpBondNames(tiles.map(t => t.ticker)) : {}; } catch { /* ISINs then */ }
      if (my !== run) return;
      last = [tiles, colour, { tip, group: $('lt_small').checked, scale, names: { ...bondNames, ...FUND_NAMES } }];
      drawTreemap(box, ...last);
      drawLegend($('lt_legend'), scale);
      status.textContent = `${tiles.length} tiles, total ${usd(tiles.reduce((s, t) => s + t.value_usd, 0))}`;
    } catch (e) {
      if (my === run) status.textContent = e.message || String(e);
      loading = null;
    }
  }

  for (const b of document.querySelectorAll('#lt_periods [data-period]')) {
    b.addEventListener('click', () => {
      period = b.dataset.period;
      document.querySelectorAll('#lt_periods [data-period]').forEach(x => x.classList.toggle('primary', x === b));
      redraw();
    });
  }
  for (const id of ['lt_expand', 'lt_cushion', 'lt_gold', 'lt_savings', 'lt_re', 'lt_small']) $(id).addEventListener('change', redraw);
  let width = 0;
  new ResizeObserver(() => { if (box.clientWidth && box.clientWidth !== width && data) { width = box.clientWidth; redraw(); } }).observe(box);

  // Load when the tab is shown while signed in; forget everything on sign-out.
  const signedIn = $('lookthrough_signed_in');
  const show = () => { if ($('lookthrough').classList.contains('active') && signedIn.style.display !== 'none') redraw(); };
  document.querySelector('.tab[data-tab="lookthrough"]')?.addEventListener('click', () => setTimeout(show, 0));
  new MutationObserver(() => {
    if (signedIn.style.display === 'none') { data = null; loading = null; earnedCache.clear(); box.textContent = ''; status.textContent = ''; }
    else show();
  }).observe(signedIn, { attributes: true, attributeFilter: ['style'] });
  show();
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireTreemap);
  else wireTreemap();
}
