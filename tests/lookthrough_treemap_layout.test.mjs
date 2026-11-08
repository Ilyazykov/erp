// Checks the treemap's squarified layout (js/lookthrough_treemap.js): the tiles'
// areas add up to the container's, none is negative, none overlaps another,
// and each area is proportional to its value. Also: the savings links.
// Run: node tests/lookthrough_treemap_layout.test.mjs
import assert from 'node:assert/strict';
import { squarify, buildSavingsLinks, aggregate } from '../js/lookthrough_treemap.js';

const EPS = 1e-6;
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const cases = [
  [[5, 3, 2, 1], 400, 300],
  [[1], 100, 50],
  [Array.from({ length: 60 }, () => 0.001 + rnd() ** 3), 1000, 560],
  [Array.from({ length: 25 }, () => 1 + rnd()), 320, 900],
  [[100, 1, 1, 1, 0.01], 640, 320],
];
for (const [values, W, H] of cases) {
  const rects = squarify(values.map((value, i) => ({ value, i })), 0, 0, W, H);
  assert.equal(rects.length, values.length);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - W * H) < 1e-6 * W * H, `areas sum ${area} vs ${W * H}`);
  const total = values.reduce((a, b) => a + b, 0);
  for (const r of rects) {
    assert.ok(r.w >= 0 && r.h >= 0, 'negative size');
    assert.ok(r.x >= -EPS && r.y >= -EPS && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, 'outside the container');
    assert.ok(Math.abs(r.w * r.h - values[r.item.i] / total * W * H) < 1e-6 * W * H, 'area not proportional');
  }
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const p = rects[a], q = rects[b];
    const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
    assert.ok(ox <= 1e-6 || oy <= 1e-6, `tiles ${a} and ${b} overlap`);
  }
}
// zero / negative values and an empty container draw nothing
assert.deepEqual(squarify([{ value: 0 }, { value: -1 }], 0, 0, 100, 100), []);
assert.deepEqual(squarify([{ value: 1 }], 0, 0, 0, 100), []);

// savings links: a sell then a buy of the same amount the same / next day, through the card or not
const T = (ticker, side, amount, trade_date, note = '') => ({ ticker, side, quantity: amount, price: 1, trade_date, currency: 'RUB', note });
const { links, periods } = buildSavingsLinks([
  T('SAVINGS:A', 'buy', 1000, '2026-01-01'), T('SAVINGS:A', 'sell', 1000, '2026-02-01'), T('SAVINGS:B', 'buy', 1000, '2026-02-02'),
  T('SAVINGS:B', 'buy', 30, '2026-03-01', 'Interest on the balance'), T('SAVINGS:C', 'sell', 500, '2026-03-01'), T('SAVINGS:D', 'buy', 500, '2026-03-05'),
]);
assert.deepEqual(links, [{ from: 'SAVINGS:A', to: 'SAVINGS:B', day: '2026-02-02' }]);
assert.deepEqual(periods['SAVINGS:A'], { first: '2026-01-01', last: '2026-02-01' });

// the tiles' total is the rows' total (credit netted, cushion off)
const rows = [
  { ticker: 'AAA', value_usd: 600, instrument_type: 'stock', account: 'IBKR' },
  { ticker: 'XAU', value_usd: 300, instrument_type: 'gold', account: 'Revolut' },
  { ticker: 'CASH', value_usd: 100, instrument_type: 'cash', account: 'Wise' },
  { ticker: 'LIQ', value_usd: 200, instrument_type: 'liquid', account: 'Revolut' },
  { ticker: 'CARD', value_usd: -50, instrument_type: 'credit', account: 'Wise' },
];
const tiles = aggregate({ rows, fundHoldings: {} });
assert.ok(Math.abs(tiles.reduce((s, t) => s + t.value_usd, 0) - 1150) < 1e-9);

console.log('all passed');
