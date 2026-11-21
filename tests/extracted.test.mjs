// Checks the pure functions taken out of the tabs' big renders: a deal's
// yield (mpIrr, the Bonds & deposits tab), the day arithmetic (mpDayShift,
// mpWorkDays), the expected salary's pay days and the bars' periods (the
// Expenses tab).
// Run: node tests/extracted.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let failed = 0;
const check = (name, f) => {
  try { f(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); }
};
// the named top-level declarations of a page script, alone (not the code it runs on load)
const pick = (file, names) => {
  const src = readFileSync(new URL(`../js/app/${file}`, import.meta.url), 'utf8');
  return names.map(n => {
    const m = src.match(new RegExp(`^(?:async )?function ${n}\\([^]*?\\n}\\n|^const ${n} = .*\\n`, 'm'));
    if (!m) throw new Error(`${n} not in ${file}`);
    return m[0];
  }).join('\n');
};
const ctx = { Date, Math, Number, String, Map, Set, Array, Object, Infinity, mpExpRollingDays: new Map() };
vm.createContext(ctx);
vm.runInContext([
  pick('common.js', ['mpDayShift']),
  pick('maturities.js', ['mpIrr']),
  pick('expenses-render.js', ['mpMonthEnd', 'mpNextMonth', 'mpWorkDays', 'mpExpExpectedPays', 'mpExpBarBuckets']),
].join('\n') + '\n;Object.assign(globalThis, { mpDayShift, mpIrr, mpMonthEnd, mpNextMonth, mpWorkDays, mpExpExpectedPays, mpExpBarBuckets });', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

check('mpDayShift: forward, back, over a month and a year', () => {
  assert.equal(ctx.mpDayShift('2026-11-21', 1), '2026-11-22');
  assert.equal(ctx.mpDayShift('2026-03-01', -1), '2026-02-28');
  assert.equal(ctx.mpDayShift('2026-12-31', 1), '2027-01-01');
  assert.equal(ctx.mpDayShift('2026-11-21', 0), '2026-11-21');
});
check('mpIrr: one year +10% is 10%; no sign change is null', () => {
  assert.ok(Math.abs(ctx.mpIrr([[0, -100], [1, 110]]) - 10) < 1e-6);
  assert.ok(Math.abs(ctx.mpIrr([[0, -1000], [0.5, 60], [1, 1060]]) - 12.36) < 0.01);
  assert.equal(ctx.mpIrr([[0, 100], [1, 110]]), null);
});
check('mpWorkDays: Mon-Fri only', () => {
  assert.equal(ctx.mpWorkDays('2026-11-16', '2026-11-22'), 5);   // Mon..Sun
  assert.equal(ctx.mpWorkDays('2026-10-01', '2026-10-31'), 22);
  assert.equal(ctx.mpWorkDays('2026-10-20', '2026-10-31'), 9);
});
check('mpExpExpectedPays: a job from 20.10: 9/22 of October with November, then a month a month', () => {
  const pays = plain(ctx.mpExpExpectedPays({ from_day: '2026-10-20', to_day: null }, '2026-12-31'));
  assert.deepEqual(pays, [['2026-11-30', 9 / 22], ['2026-11-30', 1], ['2026-12-31', 1]]);
  assert.deepEqual(plain(ctx.mpExpExpectedPays({ from_day: '2026-01-01', to_day: '2026-02-15' }, '2026-12-31')),
    [['2026-01-31', 1], ['2026-02-28', 10 / 20]]);
});
check('mpExpBarBuckets: by month, 12 months with this one', () => {
  const b = ctx.mpExpBarBuckets(false, 'month', '12', '2026-11-21', '2024-01-01');
  assert.equal(b.buckets.length, 12);
  assert.equal(b.buckets[0], '2025-12'); assert.equal(b.buckets[11], '2026-11');
  assert.equal(b.startDay, '2025-12-01');
  assert.equal(b.bucket('2026-02-14'), '2026-02');
});
check('mpExpBarBuckets: by quarter and year', () => {
  const q = ctx.mpExpBarBuckets(false, 'quarter', '12', '2026-11-21', '2024-01-01');
  assert.deepEqual(plain(q.buckets), ['2025 Q4', '2026 Q1', '2026 Q2', '2026 Q3', '2026 Q4']);
  assert.equal(q.bucket('2026-05-03'), '2026 Q2');
  const y = ctx.mpExpBarBuckets(false, 'year', 'all', '2026-11-21', '2024-03-05');
  assert.deepEqual(plain(y.buckets), ['2024', '2025', '2026']);
  assert.equal(y.startDay, '2024-03-01');
});
check('mpExpBarBuckets: rolling months end today, stop at the first day', () => {
  ctx.mpExpRollingDays.clear();
  const r = ctx.mpExpBarBuckets(true, 'month_td', '12', '2026-11-21', '2026-08-10');
  assert.deepEqual(plain(r.buckets), ['-3 months', '-2 months', '-1 month', 'this month']);
  assert.deepEqual(plain(ctx.mpExpRollingDays.get('this month')), ['2026-10-22', '2026-11-21']);
  assert.equal(r.startDay, '2026-07-22');
  assert.equal(r.bucket('2026-10-21'), '-1 month');
  assert.equal(r.bucket('2026-10-22'), 'this month');
});
check('mpExpBarBuckets: a month too short takes its last day (31.03 back one month: 28.02)', () => {
  ctx.mpExpRollingDays.clear();
  ctx.mpExpBarBuckets(true, 'month_td', '12', '2026-03-31', '2026-01-01');
  assert.deepEqual(plain(ctx.mpExpRollingDays.get('-1 month')), ['2026-02-01', '2026-02-28']);
});

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
