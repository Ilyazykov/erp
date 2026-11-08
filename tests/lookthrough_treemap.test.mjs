// Checks the look-through treemap's pure functions (js/lookthrough_treemap.js):
//   1. periodStart across month ends, leap days and the year start;
//   2. priceChange: known / zero / nodata, 'all' from the first price;
//   3. aggregate: one tile per instrument with every source, funds as tiles
//      with or without their constituents, shares, sorting, zero values;
//   4. tileChange: a fund only by its own price.
// Run: node tests/lookthrough_treemap.test.mjs
import assert from 'node:assert/strict';
import { periodStart, priceChange, aggregate, tileChange } from '../js/lookthrough_treemap.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// ---- 1. periodStart ----
assert.equal(periodStart('1d', '2026-03-01'), '2026-02-28');
assert.equal(periodStart('7d', '2026-03-03'), '2026-02-24');
assert.equal(periodStart('1m', '2026-03-31'), '2026-02-28');
assert.equal(periodStart('1m', '2026-01-15'), '2025-12-15');
assert.equal(periodStart('3m', '2026-05-31'), '2026-02-28');
assert.equal(periodStart('6m', '2026-08-31'), '2026-02-28');
assert.equal(periodStart('1y', '2024-02-29'), '2023-02-28');
assert.equal(periodStart('5y', '2026-11-08'), '2021-11-08');
assert.equal(periodStart('ytd', '2026-11-08'), '2025-12-31');
assert.equal(periodStart('ytd', '2026-01-01'), '2025-12-31');
assert.equal(periodStart('all', '2026-11-08'), null);

// ---- 2. priceChange ----
const today = '2026-11-08';
const prices = {
  AAA: { current: 110, byDate: [{ day: '2026-01-02', price: 50 }, { day: '2026-11-05', price: 100 }, { day: '2026-11-07', price: 105 }] },
  FLAT: { current: 100, byDate: [{ day: '2026-11-01', price: 100 }] },
  NOCUR: { current: null, byDate: [{ day: '2026-11-01', price: 100 }] },
  LATE: { current: 100, byDate: [{ day: '2026-11-06', price: 90 }] },
  FUND: { current: 22, byDate: [{ day: '2026-10-01', price: 20 }] },
};
let r = priceChange('AAA', '1d', prices, today);            // base 105 (07.11)
assert.equal(r.state, 'known'); near(r.change, 110 / 105 - 1, '1d');
r = priceChange('AAA', '7d', prices, today);                // start 01.11, base = 50 (02.01), not 100
assert.equal(r.state, 'known'); near(r.change, 110 / 50 - 1, '7d');
r = priceChange('AAA', 'all', prices, today);               // first price
near(r.change, 110 / 50 - 1, 'all');
assert.deepEqual(priceChange('FLAT', '1d', prices, today), { state: 'zero', change: 0 });
assert.deepEqual(priceChange('NOCUR', '1d', prices, today), { state: 'nodata', change: null });
assert.deepEqual(priceChange('LATE', '7d', prices, today), { state: 'nodata', change: null }); // history starts after the start
assert.equal(priceChange('LATE', 'all', prices, today).state, 'known');
assert.deepEqual(priceChange('MISSING', '1d', prices, today), { state: 'nodata', change: null });

// ---- 3. aggregate ----
const holdings = [
  { ticker: 'NVDA', value_usd: 1000, kind: 'direct' },
  { ticker: 'A', value_usd: 10000, kind: 'fund' },
  { ticker: 'B', value_usd: 5000, kind: 'fund' },
  { ticker: 'CASH', value_usd: 0, kind: 'direct' },
];
const fundHoldings = {
  A: [{ ticker: 'NVDA', weight: 0.05 }, { ticker: 'MSFT', weight: 0.95 }],
  B: [{ ticker: 'NVDA', weight: 0.04 }, { ticker: 'AAPL', weight: 0.96 }],
};
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const held = sum(holdings, h => h.value_usd);

// expandFunds false: funds are plain tiles, NVDA only its direct part.
let tiles = aggregate({ holdings, fundHoldings, expandFunds: false });
assert.deepEqual(tiles.map(t => t.ticker), ['A', 'B', 'NVDA']);    // sorted, CASH (0) dropped
assert.equal(tiles[0].isFund, true);
assert.deepEqual(tiles[0].sources, [{ from: 'A', value_usd: 10000 }]);
assert.equal(tiles[0].children, undefined);
assert.equal(tiles[2].value_usd, 1000);
assert.deepEqual(tiles[2].sources, [{ from: 'direct', value_usd: 1000 }]);
near(sum(tiles, t => t.share), 1, 'shares sum to 1');
near(sum(tiles, t => t.value_usd), held, 'tiles sum to direct + funds');

// expandFunds true: funds are replaced by their constituents, merged by instrument:
// NVDA is one tile of 1000 + 500 + 200 with three sources; no fund tile remains.
tiles = aggregate({ holdings, fundHoldings, expandFunds: true });
const byTicker = Object.fromEntries(tiles.map(t => [t.ticker, t]));
assert.equal(tiles.some(t => t.isFund), false);
assert.deepEqual(tiles.map(t => t.ticker).sort(), ['AAPL', 'MSFT', 'NVDA']);
const nvda = byTicker.NVDA;
near(nvda.value_usd, 1700, 'NVDA exposure');
assert.equal(nvda.sources.length, 3);
assert.deepEqual(nvda.sources.map(s => s.from), ['direct', 'A', 'B']);
near(nvda.sources[1].value_usd, 500, 'NVDA via A'); near(nvda.sources[2].value_usd, 200, 'NVDA via B');
near(byTicker.MSFT.value_usd, 9500, 'MSFT via A'); near(byTicker.AAPL.value_usd, 4800, 'AAPL via B');
near(sum(tiles, t => t.value_usd), held - 0, 'exposures add up to the held total');
near(sum(tiles, t => t.share), 1, 'shares sum to 1 (look-through weights sum to 1)');
for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i - 1].value_usd >= tiles[i].value_usd, 'sorted');

// A fund with no constituent list stays one tile even when expanded.
tiles = aggregate({ holdings: [{ ticker: 'TRND', value_usd: 300, kind: 'fund' }], fundHoldings: {}, expandFunds: true });
assert.equal(tiles.length, 1);
assert.equal(tiles[0].isFund, true); assert.equal(tiles[0].share, 1);

// Negative cash line inside a fund and zero / negative holdings are dropped.
tiles = aggregate({
  holdings: [{ ticker: 'F', value_usd: 100, kind: 'fund' }, { ticker: 'Z', value_usd: -5, kind: 'direct' }],
  fundHoldings: { F: [{ ticker: 'X', weight: 1.02 }, { ticker: 'OTHER', weight: -0.02 }] },
  expandFunds: true,
});
assert.deepEqual(tiles.map(t => t.ticker), ['X', 'Z'].filter(t => t !== 'Z'));

// ---- 4. tileChange ----
assert.equal(tileChange({ ticker: 'FUND', isFund: true }, 'all', prices, today).state, 'known');
assert.deepEqual(tileChange({ ticker: 'A', isFund: true }, '1d', prices, today), { state: 'nodata', change: null });
near(tileChange({ ticker: 'AAA', isFund: false }, '1d', prices, today).change, 110 / 105 - 1, 'instrument tile');

console.log('all passed');
