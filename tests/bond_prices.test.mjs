// What a bond's deal came to (the chart's average and the hover of its mark), and which MOEX board its history is from.
// The numbers are made up, the shapes are the brokers' and MOEX's.
// Run: node tests/bond_prices.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const chart = readFileSync(new URL('../js/app/price-chart.js', import.meta.url), 'utf8');
const history = readFileSync(new URL('../supabase/functions/update-capital-history/index.ts', import.meta.url), 'utf8');
const pick = (src, n) => src.match(new RegExp(`^(?:async )?function ${n}\\([^]*?\\n}\\n`, 'm'))[0];

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${chart.match(/^const MP_NKD_PER_DEAL.*$/m)[0]}
${pick(chart, 'mpMergeDayDeals')}
${pick(chart, 'mpBondUnitMoney')}
this.unit = mpBondUnitMoney; this.merge = mpMergeDayDeals;`, ctx);

// moexHistory without its TypeScript types, over rows given here instead of the network
const moexJs = pick(history, 'moexHistory')
  .replace("secid: string, market: 'shares' | 'bonds', from: string", 'secid, market, from')
  .replace(/new Map<[^(]*>\(\)/, 'new Map()')
  .replace('(x: unknown)', '(x)')
  .replace('(n: string)', '(n)')
  .replace('cols: string[]', 'cols')
  .replace('rows: unknown[][]', 'rows')
  .replace(' as number | null', '');
const moex = async (rows, market = 'bonds') => {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const data = rows.map(r => columns.map(k => r[k] ?? null));
  const env = { ISS: '', getJson: async u => ({ history: { columns, data: Number(u.match(/start=(\d+)/)[1]) ? [] : data } }), sleep: async () => {}, timeLeft: () => 1e6 };
  vm.createContext(env);
  const got = await vm.runInContext(`${moexJs}; moexHistory('X', ${JSON.stringify(market)}, '2026-01-01')`, env);
  return JSON.parse(JSON.stringify(got));
};

let failed = 0;
const check = async (name, f) => {
  try { await f(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); }
};
const near = (got, want) => assert.ok(got != null && Math.abs(got - want) < 0.005, `${got} instead of ${want}`);
const deal = o => ({ ticker: 'RU000A100001', trade_date: '2026-05-05', side: 'buy', account: 'T-Bank', quantity: 1, nkd: null, fee_tax: 0,
  currency: 'RUB', fee_currency: 'RUB', external_source: 'tbank_broker_xlsx', ...o });
const row = o => ({ TRADEDATE: '2026-05-05', BOARDID: 'TQCB', CURRENCYID: 'SUR', FACEUNIT: 'SUR', FACEVALUE: 1000, CLOSE: 100, ACCINT: 0, VOLUME: 10, ...o });

// ---- a unit's money ----
await check('% of the face with the fee of the whole deal: the fee is not added to the percent', () => {
  near(ctx.unit(deal({ quantity: 20, price: 100, fee_tax: 30 }), 998), 1001.5);
});
await check('a false spike on the day of the buy does not change the face', () => {
  near(ctx.unit(deal({ price: 100.25, nkd: 20, fee_tax: 5, currency: 'CNY', fee_currency: 'CNY' }), 1240), 1027.5);
});
await check("T-Bank's accrued is for the whole deal", () => {
  near(ctx.unit(deal({ quantity: 10, price: 100, nkd: 50, fee_tax: 10 }), 1005), 1006);
});
await check("Sber's price is in % and its accrued for the whole deal", () => {
  near(ctx.unit(deal({ quantity: 2, price: 80, nkd: 20, external_source: 'sber_broker_html' }), 810), 810);
});
await check('a price in money with the accrued of one bond', () => {
  near(ctx.unit(deal({ price: 998, nkd: 9.5, external_source: 'broker_csv' }), 1008), 1007.5);
});
await check('a small price in money stays money', () => {
  near(ctx.unit(deal({ price: 150, nkd: 2, external_source: 'broker_csv' }), 152), 152);
});
await check('an amortised bond: % of what is left of the face', () => {
  near(ctx.unit(deal({ price: 63, external_source: 'sber_broker_html' }), 422), 422);
});
await check('a face of 10 000', () => {
  near(ctx.unit(deal({ price: 101, external_source: 'sber_broker_html' }), 10100), 10100);
});
await check('no chart price that day: % of a face of 1000', () => {
  near(ctx.unit(deal({ price: 99, fee_tax: 2 }), null), 992);
});
await check('a sale: the fee comes off', () => {
  near(ctx.unit(deal({ side: 'sell', price: 100, nkd: 10, fee_tax: 3 }), 1010), 1007);
});
await check('a fee in another currency is not added', () => {
  near(ctx.unit(deal({ price: 100, fee_tax: 5, fee_currency: 'USD' }), 1000), 1000);
});
await check('not a bond: null', () => {
  assert.equal(ctx.unit(deal({ ticker: 'VWRA', price: 190, currency: 'USD' }), 190), null);
});

// ---- the mark's hover: a day's trades as one ----
await check('parts of a deal in %: the accrued and the fees add up', () => {
  const [m] = ctx.merge([deal({ quantity: 1, price: 96, nkd: 5, fee_tax: 4 }), deal({ quantity: 3, price: 98, nkd: 15, fee_tax: 8 })]);
  near(m.quantity * ctx.unit(m, 985), 3932);
});
await check('parts of a deal in money: the accrued stays that of one bond', () => {
  const part = { price: 1000, nkd: 10, external_source: 'broker_csv' };
  const [m] = ctx.merge([deal(part), deal({ ...part, quantity: 3 })]);
  near(m.nkd, 10);
  near(m.quantity * ctx.unit(m, 1010), 4040);
});

// ---- MOEX's boards ----
const yuan = { FACEUNIT: 'CNY' };
await check("a yuan bond: the yuan board, though the rouble board traded more", async () => {
  const got = await moex([row({ ...yuan, CLOSE: 101, ACCINT: 230, VOLUME: 900 }), row({ ...yuan, BOARDID: 'TQOY', CURRENCYID: 'CNY', CLOSE: 100, ACCINT: 21, VOLUME: 5 })]);
  assert.deepEqual(got, [{ day: '2026-05-05', price: 1021, currency: 'CNY' }]);
});
await check('the dollar board does not win either', async () => {
  const got = await moex([row({ ...yuan, BOARDID: 'TQOD', CURRENCYID: 'USD', ACCINT: 3, VOLUME: 900 }), row({ ...yuan, BOARDID: 'TQOY', CURRENCYID: 'CNY', ACCINT: 21, VOLUME: 5 })]);
  assert.deepEqual(got, [{ day: '2026-05-05', price: 1021, currency: 'CNY' }]);
});
await check('only the rouble board that day: no roubles of accrued in a yuan price', async () => {
  const got = await moex([row({ ...yuan, CLOSE: 99, ACCINT: 230 })]);
  assert.deepEqual(got, [{ day: '2026-05-05', price: 990, currency: 'CNY' }]);
});
await check('a rouble bond keeps its accrued', async () => {
  const got = await moex([row({ CLOSE: 99, ACCINT: 12 })]);
  assert.deepEqual(got, [{ day: '2026-05-05', price: 1002, currency: 'RUB' }]);
});
await check('of two boards in the same currency, the more traded', async () => {
  const got = await moex([row({ CLOSE: 99, VOLUME: 5 }), row({ BOARDID: 'TQIR', CLOSE: 98, VOLUME: 50 })]);
  assert.equal(got[0].price, 980);
});
await check('a share: its close, no face', async () => {
  const got = await moex([{ TRADEDATE: '2026-05-05', BOARDID: 'TQBR', CURRENCYID: 'SUR', CLOSE: 300, VOLUME: 5 }], 'shares');
  assert.deepEqual(got, [{ day: '2026-05-05', price: 300, currency: 'RUB' }]);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
