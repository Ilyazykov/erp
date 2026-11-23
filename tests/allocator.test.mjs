// The Z-priority allocators with the sector as the second factor.
// Run: node tests/allocator.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../js/app/portfolio-pies.js', import.meta.url), 'utf8');
const pick = n => src.match(new RegExp(`^function ${n}\\([^]*?\\n}\\n`, 'm'))[0];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(['const MP_EXPENSIVE_FROM = 0.2, MP_EXPENSIVE_TO = 0.4, MP_EXPENSIVE_BUDGET = 0.5;\n'].join('') + ['mpSectorFactors', 'mpWeightedShares', 'mpAllocatePoolByZPriorityLegacy', 'mpAllocatePoolByZPriorityWithLots']
  .map(pick).join('\n') + '\nthis.legacy = mpAllocatePoolByZPriorityLegacy; this.lots = mpAllocatePoolByZPriorityWithLots;', ctx);

let failed = 0;
const check = (name, f) => {
  try { f(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); }
};
const item = (label, sector, target, current, z = 0, priceUsd = 10) => ({ label, sector, target, current, z, priceUsd });
const got = (res, it) => res.deltaUsdByItem.get(it);

check('same shortfall: the underweight sector gets more (fractional)', () => {
  const a = item('A', 'Hot', 40, 60), b = item('B', 'Hot', 10, 0), c = item('C', 'Cold', 10, 0), d = item('D', 'Cold', 40, 40);
  const r = ctx.legacy([a, b, c, d], 1000, 50);
  assert.ok(got(r, c) > got(r, b), `${got(r, c)} vs ${got(r, b)}`);
});
check('same shortfall: the underweight sector gets more (whole shares)', () => {
  const a = item('A', 'Hot', 40, 60), b = item('B', 'Hot', 10, 0), c = item('C', 'Cold', 10, 0), d = item('D', 'Cold', 40, 40);
  const r = ctx.lots([a, b, c, d], 1000, 50);
  assert.ok(got(r, c) > got(r, b), `${got(r, c)} vs ${got(r, b)}`);
});
check('Z stays first: a buy-signal stock of a heavy sector is filled before a neutral one', () => {
  const a = item('A', 'Hot', 40, 70, 2), b = item('B', 'Cold', 60, 30, 0);
  a.target = 80; b.target = 20; a.current = 70; b.current = 30;
  const c = item('C', 'Cold', 30, 0, 0);
  const r = ctx.lots([a, c], 1000, 50);
  assert.ok(got(r, a) > 0 && got(r, c) === 0, `${got(r, a)} / ${got(r, c)}`);
});
check('no item goes past its own shortfall in the fractional split', () => {
  const a = item('A', 'Hot', 50, 49.9), b = item('B', 'Cold', 50, 50.1);
  const small = item('S', 'Empty', 1, 0);
  const r = ctx.legacy([a, b, small], 1000, 5);
  const total = [a, b, small].reduce((s, it) => s + got(r, it), 0);
  assert.ok(Math.abs(total - 5) < 1e-6, String(total));
});
check('without sectors the split is by shortfall alone', () => {
  const a = item('A', undefined, 50, 30), b = item('B', undefined, 50, 70);
  const r = ctx.legacy([a, b], 1000, 100);
  assert.ok(Math.abs(got(r, a) - 100) < 1e-6);
});
check('prefer expensive: one share of a dear stock a plain split would skip', () => {
  const mk = () => [item('X', 'A', 10, 0, 0, 1500), item('Y', 'B', 90, 0, 0, 10)];
  const off = mk(), on = mk();
  assert.equal(got(ctx.lots(off, 0, 5000), off[0]), 0);
  assert.equal(got(ctx.lots(on, 0, 5000, { preferExpensive: true }), on[0]), 1500);
});
check('prefer expensive: never a Z < -1.5 stock, and within half the budget', () => {
  const its = [item('R', 'A', 30, 0, -2, 1500), item('P', 'B', 30, 0, 0, 1500), item('Q', 'C', 30, 0, 0, 1500), item('Z', 'D', 10, 0, 0, 10)];
  const r = ctx.lots(its, 0, 5000, { preferExpensive: true });
  assert.ok(got(r, its[1]) + got(r, its[2]) >= 1500);
  assert.ok(got(r, its[0]) <= 1500);
  assert.ok(its.reduce((s, it) => s + got(r, it), 0) <= 5000);
});
if (failed) process.exit(1);
console.log('\nall ok');
