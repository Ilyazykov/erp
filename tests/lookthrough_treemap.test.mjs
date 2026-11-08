// Checks the look-through treemap's pure functions (js/lookthrough_treemap.js):
//   1. periodStart across month ends, leap days and the year start;
//   2. priceChange: known / zero / nodata, 'all' from the first price;
//   3. aggregate: one tile per instrument with every source, funds as tiles
//      with or without their constituents, shares, sorting, zero values;
//   4. tileChange: a fund only by its own price;
//   5. isRuInfra / netCreditIntoLiquid: card debt netted into liquid rows by infrastructure;
//   6. aggregate over the pies' rows: every asset type, cushion, netting across banks;
//   7. mergeGold and goldChange;
//   8. earnedRatio / tileEarned: earned over invested, the colour;
//   9. savingsChains and mergeSavings;
//  10. the colour's methods: contribution, XIRR over the time held, TWR from twr_by_asset.
// Run: node tests/lookthrough_treemap.test.mjs
import assert from 'node:assert/strict';
import { periodStart, priceChange, aggregate, tileChange, isRuInfra, netCreditIntoLiquid,
  goldChange, earnedRatio, tileEarned, savingsChains, assetKey, periodCapital, portfolioCapital, periodIrr, tileMetric,
  mergeRows, changeAsContribution, formatChange } from '../js/lookthrough_treemap.js';

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
near(sum(tiles, t => t.value_usd), 100, 'an overshooting weight list is scaled to the fund value');

// Weights that add up to less than 1: the uncovered part stays a tile of the fund, so the total holds.
tiles = aggregate({ holdings: [{ ticker: 'F', value_usd: 1000, kind: 'fund' }, { ticker: 'D', value_usd: 500, kind: 'direct' }],
  fundHoldings: { F: [{ ticker: 'X', weight: 0.6 }, { ticker: 'Y', weight: 0.39 }] }, expandFunds: true });
near(sum(tiles, t => t.value_usd), 1500, 'expanding funds keeps the total');
near(tiles.find(t => t.isFund).value_usd, 10, 'the uncovered 1% stays the fund');
near(sum(tiles, t => t.share), 1, 'shares sum to 1');

// ---- 4. tileChange ----
assert.equal(tileChange({ ticker: 'FUND', isFund: true }, 'all', prices, today).state, 'known');
assert.deepEqual(tileChange({ ticker: 'A', isFund: true }, '1d', prices, today), { state: 'nodata', change: null });
near(tileChange({ ticker: 'AAA', isFund: false }, '1d', prices, today).change, 110 / 105 - 1, 'instrument tile');

// ---- 5. isRuInfra / netCreditIntoLiquid ----
assert.equal(isRuInfra({ account: 'Sber' }), true);
assert.equal(isRuInfra({ account: 'IBKR' }), false);
assert.equal(isRuInfra({ account: '(unspecified)', infra_region: 'ru' }), true);
assert.equal(isRuInfra({ account: '(unspecified)', infra_region: 'foreign' }), false);
const L = (account, ticker, value_usd, instrument_type = 'liquid') => ({ account, ticker, value_usd, instrument_type });
// a Russian card against Russian liquid rows only: 300 + 100 liquid, -200 debt -> factor 0.5
let net = netCreditIntoLiquid([L('T-Bank', 'CARD', -200, 'credit'), L('Sber', 'S1', 300), L('Alfa', 'A1', 100),
  L('IBKR', 'MMF', 1000), L('Sber', 'SBER', 50, 'stock')]);
assert.deepEqual(net.map(r => [r.ticker, r.value_usd]), [['S1', 150], ['A1', 50], ['MMF', 1000], ['SBER', 50]]);
// a foreign card against foreign liquid rows only
net = netCreditIntoLiquid([L('Revolut', 'CARD', -250, 'credit'), L('Revolut', 'RF', 1000), L('Sber', 'S1', 300)]);
assert.deepEqual(net.map(r => [r.ticker, r.value_usd]), [['RF', 750], ['S1', 300]]);
// credit bigger than liquid -> factor 0; no liquid -> factor 1 (nothing to scale); a negative non-credit row as is
net = netCreditIntoLiquid([L('T-Bank', 'CARD', -500, 'credit'), L('Sber', 'S1', 300), L('IBKR', 'CASH', -5, 'cash')]);
assert.deepEqual(net.map(r => [r.ticker, r.value_usd]), [['S1', 0], ['CASH', -5]]);
net = netCreditIntoLiquid([L('T-Bank', 'CARD', -500, 'credit'), L('Sber', 'SBER', 300, 'stock')]);
assert.deepEqual(net.map(r => [r.ticker, r.value_usd]), [['SBER', 300]]);

// ---- 6. aggregate over the pies' rows ----
const capRows = [
  L('Sber', 'SBER', 1000, 'stock'),
  L('Alfa', 'SU26238RMFS4', 800, 'bond'),
  L('Alfa', 'DEPOSIT:Alfa RUB 18% 10.05.2026', 700, 'deposit'),
  L('Sber', 'SAVINGS:Sber RUB', 600),
  L('Alfa', 'SAVINGS:Alfa RUB', 200),
  L('T-Bank', 'CARD:T-Bank', -400, 'credit'),       // netted against Sber's and Alfa's liquid rows, not drawn
  L('Revolut', 'CARD:Revolut', -100, 'credit'),     // only the foreign liquid row
  L('Revolut', 'MMF', 500),
  L('IBKR', 'MMF', 300),                            // the same fund in two accounts: one tile
  L('IBKR', 'CASH:USD', 250, 'cash'),
  L('Alfa', 'XAU', 500, 'gold'),
  L('Bybit', 'XAUT', 300, 'crypto'),
  L('Bybit', 'BTC', 900, 'crypto'),
  L('(unspecified)', 'REAL_ESTATE:Flat', 5000, 'real_estate'),
  L('Sber', 'SAVINGS:Sber RUB', 400, 'cushion'),
];
const nettedTotal = sum(netCreditIntoLiquid(capRows.filter(r => r.instrument_type !== 'real_estate')).filter(r => r.value_usd > 0), r => r.value_usd);
tiles = aggregate({ rows: capRows, fundHoldings: {}, mergeGold: false });
const tileOf = t => tiles.find(x => x.ticker === t);
for (const t of ['SU26238RMFS4', 'DEPOSIT:Alfa RUB 18% 10.05.2026', 'XAU', 'XAUT', 'BTC', 'CASH:USD'])
  assert.ok(tileOf(t), `${t} is a tile`);
assert.equal(tileOf('SU26238RMFS4').instrument_type, 'bond');
assert.equal(tileOf('REAL_ESTATE:Flat'), undefined, 'real estate is not on the map (as in the pies)');
assert.equal(tiles.some(t => t.ticker.startsWith('CARD:')), false, 'credit is no tile');
// T-Bank's -400 over Sber 600 + Alfa 200 liquid: factor 0.5, both halve; T-Bank has no liquid tile
near(tileOf('SAVINGS:Sber RUB').value_usd, 300, 'Sber liquid netted'); near(tileOf('SAVINGS:Alfa RUB').value_usd, 100, 'Alfa liquid netted');
// Revolut's -100 over the foreign liquid 800: factor 7/8, the fund's two accounts one tile
near(tileOf('MMF').value_usd, 700, 'foreign liquid netted, one tile');
assert.equal(tileOf('MMF').sources.length, 1);
assert.ok(tiles.every(t => t.value_usd > 0), 'no negative tile');
// cushion off: not drawn, still in the total of the shares
near(sum(tiles, t => t.value_usd), nettedTotal - 400, 'tiles = netted rows less the cushion');
near(sum(tiles, t => t.share), (nettedTotal - 400) / nettedTotal, 'shares of the netted total');
tiles = aggregate({ rows: capRows, fundHoldings: {}, mergeGold: false, includeCushion: true });
near(sum(tiles, t => t.value_usd), nettedTotal, 'tiles = netted rows with the cushion');
near(sum(tiles, t => t.share), 1, 'shares sum to 1 with the cushion');
assert.equal(tiles.find(t => t.ticker === 'SAVINGS:Sber RUB').value_usd, 700, 'the cushion part joins its ticker');
// a row whose ticker fundHoldings has is a fund
tiles = aggregate({ rows: [L('IBKR', 'VT', 1000, 'stock'), L('IBKR', 'NVDA', 100, 'stock')],
  fundHoldings: { VT: [{ ticker: 'NVDA', weight: 0.1 }, { ticker: 'AAPL', weight: 0.9 }] } });
assert.equal(tiles[0].isFund, true);
tiles = aggregate({ rows: [L('IBKR', 'VT', 1000, 'stock'), L('IBKR', 'NVDA', 100, 'stock')],
  fundHoldings: { VT: [{ ticker: 'NVDA', weight: 0.1 }, { ticker: 'AAPL', weight: 0.9 }] }, expandFunds: true });
assert.deepEqual(tiles.map(t => [t.ticker, t.value_usd]), [['AAPL', 900], ['NVDA', 200]]);

// ---- 7. mergeGold / goldChange ----
tiles = aggregate({ rows: capRows, fundHoldings: {} });
const gold = tiles.find(t => t.ticker === 'GOLD');
assert.equal(gold.isGold, true); assert.equal(gold.value_usd, 800);
assert.deepEqual(gold.sources, [{ from: 'XAU', value_usd: 500 }, { from: 'XAUT', value_usd: 300 }]);
assert.ok(!tiles.some(t => t.ticker === 'XAU' || t.ticker === 'XAUT'));
near(sum(tiles, t => t.value_usd), sum(aggregate({ rows: capRows, fundHoldings: {}, mergeGold: false }), t => t.value_usd), 'merge keeps the sum');
const goldPrices = {
  XAU: { current: 110, byDate: [{ day: '2026-11-01', price: 100 }] },    // +10%
  XAUT: { current: 98, byDate: [{ day: '2026-11-01', price: 100 }] },    // -2%
};
r = goldChange(gold.parts, '7d', goldPrices, today);
near(r.change, (500 * 0.10 + 300 * -0.02) / 800, 'weighted gold change'); assert.equal(r.state, 'known');
assert.deepEqual(tileChange(gold, '7d', goldPrices, today), r);
r = goldChange(gold.parts, '7d', { XAU: goldPrices.XAU }, today);                  // XAUT nodata: XAU alone
near(r.change, 0.10, 'one part nodata');
assert.deepEqual(goldChange(gold.parts, '7d', {}, today), { state: 'nodata', change: null });
assert.deepEqual(goldChange(gold.parts, '7d', { XAU: { current: 100, byDate: [{ day: '2026-11-01', price: 100 }] } }, today),
  { state: 'zero', change: 0 });

// ---- 8. earnedRatio / tileEarned ----
// bought 1000 in the period, worth 1100 now: +10% on its own money
r = earnedRatio({ value_start: 0, value_end: 1100, put_in: 1000, taken_out: 0, income: 0, kind: 'stock' });
near(r.change, 0.1, 'bought inside the period'); assert.equal(r.state, 'known');
// held 1000 at the start, 500 more bought, worth 1800: earned 300 on 1500
near(earnedRatio({ value_start: 1000, value_end: 1800, put_in: 500, taken_out: 0, income: 0, kind: 'stock' }).change, 300 / 1500, 'buy then a rise');
// bought 1000, doubled, a quarter sold for 500: worth 1500, earned 1000 (500 of it realised) on 1000 - 500
r = earnedRatio({ value_start: 0, value_end: 1500, put_in: 1000, taken_out: 500, income: 0, kind: 'stock' });
near(r.earned, 1000, 'realised profit stays in earned'); near(r.change, 1000 / 500, 'partial sale');
// a dividend of 50 paid out, the price flat: earned 50 on the 1000 -- the payout is no own money back
r = earnedRatio({ value_start: 1000, value_end: 1000, put_in: 0, taken_out: 50, income: 50, kind: 'stock' });
near(r.change, 0.05, 'dividend raises earned');
// a price fall by exactly the dividend: total 0
assert.equal(earnedRatio({ value_start: 1000, value_end: 950, put_in: 0, taken_out: 50, income: 50, kind: 'stock' }).state, 'zero');
// savings interest stays in: not taken off the base
near(earnedRatio({ value_start: 1000, value_end: 1010, put_in: 0, taken_out: 0, income: 10, kind: 'liquid' }).change, 0.01, 'interest in');
// sold out at a profit / nothing at all -> nodata
assert.deepEqual(earnedRatio({ value_start: 0, value_end: 0, put_in: 1000, taken_out: 1200, income: 0, kind: 'stock' }),
  { state: 'nodata', change: null, note: 'no invested base', earned: 200, base: -200 });
assert.equal(earnedRatio(null).state, 'nodata');
// a row with the rpc's pct (the capital at work averaged over time): the colour is that pct
r = earnedRatio({ value_start: 1000, value_end: 1000, put_in: 0, taken_out: 80, income: 80, earned: 80, pct: 8.3, kind: 'bond' });
near(r.change, 0.083, 'the rpc pct is the colour'); near(r.earned, 80, 'earned stays');
assert.equal(earnedRatio({ value_start: 1000, value_end: 1000, put_in: 0, taken_out: 0, income: 0, earned: 0, pct: 0, kind: 'bond' }).state, 'zero');
// no capital (pct null): the static base as before
near(earnedRatio({ value_start: 1000, value_end: 1100, put_in: 0, taken_out: 0, income: 0, earned: 100, pct: null, kind: 'stock' }).change, 0.1, 'no pct: static base');
assert.equal(earnedRatio({ value_start: 0, value_end: 0, put_in: 0, taken_out: 0, income: 0 }).note, 'no value');
const earnedRows = [
  { asset: 'SBER', value_start: 1000, value_end: 1100, put_in: 0, taken_out: 0, income: 0, kind: 'stock' },
  { asset: 'XAU', value_start: 400, value_end: 500, put_in: 0, taken_out: 0, income: 0, kind: 'gold' },     // +25%
  { asset: 'ETH', value_start: 100, value_end: 90, put_in: 0, taken_out: 0, income: 0, kind: 'crypto' },
];
near(tileEarned({ ticker: 'SBER' }, earnedRows).change, 0.1, 'instrument tile');
assert.equal(assetKey('stETH'), 'ETH'); assert.equal(assetKey('TEUR2'), 'TEUR');
near(tileEarned({ ticker: 'STETH' }, earnedRows).change, -0.1, 'stETH is ETH');
assert.equal(tileEarned({ ticker: 'NONE' }, earnedRows).state, 'nodata');
near(tileEarned(gold, earnedRows).change, 0.25, 'gold: XAUT has no row, XAU alone');

// ---- 9. savingsChains / mergeSavings ----
const sv = n => `SAVINGS:${n} RUB`;
assert.deepEqual(savingsChains([{ from: sv('Fin'), to: sv('Ozon') }, { from: sv('Ozon'), to: sv('Alfa') }, { from: sv('X'), to: sv('Y') }])
  .map(g => g.slice().sort()), [[sv('Alfa'), sv('Fin'), sv('Ozon')], [sv('X'), sv('Y')]]);
const svRows = [L('Ozon Bank', sv('Ozon'), 0), L('Alfa', sv('Alfa'), 1050), L('Sber', sv('Sber'), 300), L('Sber', 'SBER', 2000, 'stock')];
const twoLinks = [{ from: sv('Ozon'), to: sv('Alfa'), day: '2026-06-01' }];
const svPeriods = { [sv('Ozon')]: { first: '2026-01-10', last: '2026-06-01' }, [sv('Alfa')]: { first: '2026-06-01', last: '2026-11-08' } };
tiles = aggregate({ rows: svRows, fundHoldings: {}, savingsLinks: twoLinks, savingsPeriods: svPeriods });
let chain = tiles.find(t => t.isChain);
assert.equal(chain.ticker, sv('Alfa'), 'named after the most recent member');
assert.equal(chain.value_usd, 1050);
assert.deepEqual(chain.members.map(m => m.ticker).sort(), [sv('Alfa'), sv('Ozon')]);
assert.deepEqual(chain.members.find(m => m.ticker === sv('Ozon')), { ticker: sv('Ozon'), value_usd: 0, first: '2026-01-10', last: '2026-06-01' });
assert.ok(tiles.find(t => t.ticker === sv('Sber') && !t.isChain), 'an unlinked product stays separate');
// 1000 put into Ozon, moved to Alfa (taken out of one, put into the other), 1050 now: invested 1000, earned 50
const svEarned = [
  { asset: sv('Ozon'), value_start: 0, value_end: 0, put_in: 1000, taken_out: 1020, income: 20, kind: 'liquid' },
  { asset: sv('Alfa'), value_start: 0, value_end: 1050, put_in: 1020, taken_out: 0, income: 30, kind: 'liquid' },
];
r = tileEarned(chain, svEarned);
near(r.base, 1000, 'chain invested net of the transfer'); near(r.earned, 50, 'chain earned'); near(r.change, 0.05, 'chain ratio');
assert.equal(tileEarned({ ticker: sv('Ozon') }, svEarned).state, 'nodata');    // alone: sold out, no base
// off: separate tiles; the total is the same
const off = aggregate({ rows: svRows, fundHoldings: {}, savingsLinks: twoLinks, mergeSavings: false });
assert.equal(off.some(t => t.isChain), false);
assert.ok(off.find(t => t.ticker === sv('Alfa')));
near(sum(off, t => t.value_usd), sum(tiles, t => t.value_usd), 'merge keeps the total');
// a chain of three, still holding two of them; without periods named by the last move
const threeRows = [L('Finuslugi', sv('Fin'), 100), L('Ozon Bank', sv('Ozon'), 0), L('Alfa', sv('Alfa'), 500)];
tiles = aggregate({ rows: threeRows, fundHoldings: {},
  savingsLinks: [{ from: sv('Fin'), to: sv('Ozon'), day: '2026-02-01' }, { from: sv('Ozon'), to: sv('Alfa'), day: '2026-05-01' }] });
assert.equal(tiles.length, 1);
assert.equal(tiles[0].ticker, sv('Alfa')); assert.equal(tiles[0].value_usd, 600); assert.equal(tiles[0].members.length, 3);
assert.deepEqual(tiles[0].sources, [{ from: sv('Fin'), value_usd: 100 }, { from: sv('Alfa'), value_usd: 500 }]);

// ---- 10. the methods ----
// Example 1: SBER 100 -> 150 -> 100 (ex-dividend) + 50 dividend -> 150; GOOGL 100 -> 200. Days 0..4.
const ex1 = [
  { asset: 'SBER', value_start: 100, value_end: 150, put_in: 0, taken_out: 50, income: 50, kind: 'stock', cash: [['2026-01-04', -50]] },
  { asset: 'GOOGL', value_start: 100, value_end: 200, put_in: 0, taken_out: 0, income: 0, kind: 'stock', cash: [] },
];
const F = '2026-01-01', T = '2026-01-05';
near(periodCapital(ex1[0], F, T), 100 - 50 * 0.25, 'dividend leaves the capital for the last quarter');
near(portfolioCapital(ex1, F, T), 187.5, 'the portfolio capital');
r = tileMetric('contrib', { ticker: 'SBER' }, { earnedRows: ex1, cap: 187.5, from: F, to: T });
near(r.change, 100 / 187.5, 'SBER contributes its 100 earned'); assert.equal(r.unit, 'pp'); near(r.earned, 100, 'earned');
near(tileMetric('contrib', { ticker: 'GOOGL' }, { earnedRows: ex1, cap: 187.5, from: F, to: T }).change, 100 / 187.5, 'GOOGL the same');
// XIRR over the period: GOOGL simply doubled; SBER gave 50 back early, so more than 100%
near(periodIrr(ex1[1], F, T), 1, 'GOOGL +100%');
const g = periodIrr(ex1[0], F, T);
near(-100 + 50 / Math.pow(1 + g, 0.75) + 150 / (1 + g), 0, 'SBER: the NPV at its rate is 0');
assert.ok(g > 1 && g < 1.25, `SBER between 100% and TWR's 125%: ${g}`);
// TWR: the rpc's %, chained over a savings chain, weighted for gold
const twr = new Map([['SBER', 125], ['GOOGL', 100]]);
near(tileMetric('twr', { ticker: 'SBER' }, { twr }).change, 1.25, 'TWR');
assert.equal(tileMetric('twr', { ticker: 'NONE' }, { twr }).state, 'nodata');
near(tileMetric('twr', { ticker: 'X', isChain: true, members: [{ ticker: 'SBER' }, { ticker: 'GOOGL' }] }, { twr }).change, 2.25 * 2 - 1, 'chain chained');
// Example 2: the dividend bought SBER again the next day -- the flows cancel, both +100%
const ex2 = [{ asset: 'SBER', value_start: 100, value_end: 200, put_in: 50, taken_out: 50, income: 50, kind: 'stock',
  cash: [['2026-01-04', -50], ['2026-01-05', 50]] }];
near(tileMetric('contrib', { ticker: 'SBER' }, { earnedRows: ex2, cap: 100, from: F, to: '2026-01-06' }).change, 1, 'reinvested: 100 on 100');
// XIRR: about +100%, not exactly -- the 50 went out one day and came back in the next
assert.ok(Math.abs(periodIrr(ex2[0], F, '2026-01-06') - 1) < 0.1, 'reinvested: XIRR about +100%');
// a savings chain merged: the transfer cancels
const m = mergeRows([{ value_start: 1000, value_end: 0, put_in: 0, taken_out: 1020, cash: [['2026-03-01', -1020]] },
  { value_start: 0, value_end: 1050, put_in: 1020, taken_out: 0, cash: [['2026-03-01', 1020]] }]);
assert.deepEqual(m.cash, []); near(periodIrr(m, F, '2027-01-01'), 0.05, 'chain +5%');
// bought in the period: over its own time, not the whole period's
near(periodIrr({ value_start: 0, value_end: 110, cash: [['2026-06-01', 100]] }, F, '2026-12-01'), 0.1, 'from its buy');
assert.equal(periodIrr({ value_start: 0, value_end: 0, cash: [['2026-06-01', 100]] }, F, T), -1, 'nothing back');
assert.equal(periodIrr({ value_start: 0, value_end: 0, cash: [] }, F, T), null, 'nothing at all');
// gold: contribution summed over the parts
const goldRows = [{ asset: 'XAU', value_start: 100, value_end: 110, cash: [] }, { asset: 'XAUT', value_start: 100, value_end: 130, cash: [] }];
near(tileMetric('contrib', { ticker: 'GOLD', isGold: true, parts: [{ ticker: 'XAU', value_usd: 110 }, { ticker: 'XAUT', value_usd: 130 }] },
  { earnedRows: goldRows, cap: 400, from: F, to: T }).change, 40 / 400, 'gold contribution');
// a bare change as a contribution: 110 now after +10% gained 10
near(changeAsContribution({ state: 'known', change: 0.1 }, 110, 200).change, 0.05, 'cash contribution');
assert.equal(formatChange(0.0123, 'pp'), '+1.2 pp');

console.log('all passed');
