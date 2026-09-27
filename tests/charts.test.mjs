// Checks the Charts tab's target pies (index.html) on a synthetic portfolio:
//   1. with no salary, every target pie's targets add up to its own total;
//   2. "Russian infrastructure vs the rest": Russia's target is 5% of the total;
//   3. with a salary, the plan buys exactly the salary (plus spent excess cash),
//      sells nothing, and each target pie's targets add up to its total after it.
// Run: node tests/charts.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// A do-nothing DOM / library stand-in: any property is another stub, any call returns a stub.
const stub = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k in t ? t[k] : (t[k] = stub())),
  apply: () => stub(),
  construct: () => stub(),
});
// Supabase: every query resolves to the rows given for its table (none by default).
let tables = {};
const query = table => {
  const q = new Proxy({}, {
    get: (_, k) => (k === 'then' ? (res) => res({ data: tables[table] || [], error: null }) : () => q),
  });
  return q;
};
const ctx = {
  console, Math, JSON, Date, Intl, Object, Array, Number, String, Map, Set, Promise, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: () => new Promise(() => {}),
  document: stub(),
  Plotly: stub(),
  window: { supabase: { createClient: () => ({ from: query, auth: {
    getSession: () => new Promise(() => {}), onAuthStateChange: () => {}, getUser: () => new Promise(() => {}),
  } }) } },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(`${script}
;globalThis.__t = {
  build: (...a) => { a[3] = mpChartsRun; return mpBuildCharts(...a); }, plan: mpSalaryPlan, deltas: mpSalaryDeltas,
  setData: d => { DATA = d; }, setPie: f => { mpTargetPie = f; },
  RU_ACCOUNTS: MP_RU_ACCOUNTS,
};`, ctx);
const T = ctx.__t;

// ---- synthetic portfolio ----
const row = (account, ticker, value_usd, extra) => ({ account, ticker, value_usd, quantity: 1, price_usd: value_usd, ...extra });
const us = { asset_class: 'us_stock', instrument_type: 'stock', currency: 'USD', underlying_currency: 'USD', infra_region: 'foreign' };
const ruS = { asset_class: 'moex_share', instrument_type: 'stock', currency: 'RUB', underlying_currency: 'RUB', infra_region: 'ru' };
const data = [
  row('IBKR', 'VWRA', 20000, { ...us, asset_class: 'western_etf' }),
  row('IBKR', 'AAPL', 1500, us),
  row('Freedom24', 'VWCE', 4000, { ...us, asset_class: 'western_etf', currency: 'EUR', underlying_currency: 'EUR' }),
  row('T-Bank', 'SBER', 600, ruS),
  row('Sber', 'SU26', 1100, { ...ruS, asset_class: 'moex_bond', instrument_type: 'bond' }),
  row('Sber', 'SBBY', 1000, { ...ruS, asset_class: 'moex_bond_etf', instrument_type: 'bond', underlying_currency: 'CNY' }),
  row('T-Bank', 'DEPOSIT:T-Bank RUB 16%', 1080, { ...ruS, asset_class: 'deposit', instrument_type: 'deposit' }),
  row('Yandex Bank', 'SAVINGS:Yandex Bank RUB', 2300, { ...ruS, asset_class: 'savings_account', instrument_type: 'liquid' }),
  row('Revolut', 'FUND', 10000, { ...us, asset_class: 'money_market_fund', instrument_type: 'liquid' }),
  row('Revolut', 'BOND', 1000, { ...us, asset_class: 'bond', instrument_type: 'bond' }),
  row('Revolut', 'XAU', 3100, { ...us, asset_class: 'gold', instrument_type: 'gold' }),
  row('Bybit', 'BTC', 3300, { ...us, asset_class: 'crypto', instrument_type: 'crypto' }),
  row('Bybit', 'ETH', 900, { ...us, asset_class: 'crypto', instrument_type: 'crypto' }),
];
const cashRows = [
  { account: 'Revolut', currency: 'USD', instrument_type: 'cash', value_usd: 11200 },
  { account: 'Sber', currency: 'RUB', instrument_type: 'cash', value_usd: 8 },
  { account: 'T-Bank', currency: 'RUB', instrument_type: 'credit', value_usd: -2130 },
];
const base = { data, cashRows, realEstateRows: [], fxByCurrency: { USD: 1, EUR: 1.1, RUB: 0.012, CNY: 0.14 } };
// The other tabs' targets as the page hands them to the charts; the checks
// below read their expected values from here.
const INPUT = {
  currentWCny: 0.257, ruAllocTargetRaw: { target: { Stocks: 21.9, Bonds: 78.1 } }, usAllocTargetRaw: { Stocks: 77.6, Bonds: 22.4 },
  usTargetWeightsRaw: [{ ticker: 'AAPL', target: 50, z: 0 }, { ticker: 'MSFT', target: 50, z: 0 }],
  ruTargetWeightsRaw: [{ ticker: 'SBER', target: 100, z: 0 }],
};
T.setData(INPUT);

// Capture every target pie drawn.
let pies = [];
T.setPie((el, title, items, note, targetTotal, shareOfTarget, before, money, bought) => {
  const total = items.reduce((a, it) => a + Math.max(0, it.usd), 0);
  const whole = shareOfTarget && targetTotal ? targetTotal : total;
  const targetSum = items.reduce((a, it) => a + it.target / 100 * whole, 0);
  pies.push({ title, items, total, targetSum, before });
});

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

async function scenario(name, base, SALARY) {
  console.log(`\n== ${name}`);
  // 1 + 2: no salary
  pies = [];
  await T.build(base, [], true, 1, 0, null, null);
  check(pies.length >= 7, `target pies drawn without a salary: ${pies.length}`);
  for (const p of pies) check(near(p.targetSum, p.total), `no salary — ${p.title}: targets ${p.targetSum.toFixed(2)} = total ${p.total.toFixed(2)}`);
  const vs = pies.find(p => /vs the rest/.test(p.title));
  const ru = vs && vs.items.find(it => /Russia/.test(it.label));
  check(ru && near(ru.target, 5, 1e-9), `Russia vs the rest: Russia target ${ru && ru.target}% = 5%`);
  // 7. Chart 12: yuan bonds' target = the USD/RUB -> CNY Weight target (no yuan deposits here).
  const noStocks = pies.find(p => /without stocks/.test(p.title));
  const cny = noStocks && noStocks.items.find(it => it.label === 'bonds 🏛️ 🇨🇳');
  const wCny = INPUT.currentWCny * 100;
  check(cny && near(cny.target, wCny, 0.005), `Russia without stocks: yuan bonds target ${cny && cny.target.toFixed(3)}% = w_CNY ${wCny}%`);
  // 8. Chart 8: Russian stocks' target = the ERP & Stocks/Bonds Allocation stocks target.
  const ruInfra = pies.find(p => /^8\. Russian infrastructure/.test(p.title));
  const ruStock = ruInfra && ruInfra.items.find(it => it.label === 'stock 📈 🇷🇺');
  const ruA = INPUT.ruAllocTargetRaw.target;
  const stocksPct = ruA.Stocks / (ruA.Stocks + ruA.Bonds) * 100;
  check(ruStock && near(ruStock.target, stocksPct, 0.005), `Russian infrastructure: stocks target ${ruStock && ruStock.target.toFixed(3)}% = ${stocksPct}%`);
  // 9, 10. Chart 3: gold and crypto 5% each.
  const types3 = pies.find(p => /^3\. Asset types/.test(p.title));
  for (const [label, name] of [['gold 🥇', 'gold'], ['crypto ₿', 'crypto']]) {
    const it = types3 && types3.items.find(x => x.label === label);
    check(it && near(it.target, 5, 0.005), `Asset types: ${name} target ${it && it.target.toFixed(3)}% = 5%`);
  }
  // 11. Chart 5: US single stocks 5%.
  const c5 = pies.find(p => /US single stocks apart/.test(p.title));
  const singles = c5 && c5.items.find(x => /^US single stocks/.test(x.label));
  check(singles && near(singles.target, 5, 0.005), `Stocks by country: US single stocks target ${singles && singles.target.toFixed(3)}% = 5%`);
  // 12. Chart 9: stocks at the US ERP target.
  const c9 = pies.find(p => /^9\. Stocks, bonds/.test(p.title));
  const st9 = c9 && c9.items.find(x => x.label === 'stock 📈');
  const usA = INPUT.usAllocTargetRaw;
  const usPct = usA.Stocks / (usA.Stocks + usA.Bonds) * 100;
  check(st9 && near(st9.target, usPct, 0.005), `Stocks, bonds, deposits, liquid: stocks target ${st9 && st9.target.toFixed(3)}% = US ERP ${usPct}%`);

  // 3: with a salary

  const ctxM = await T.build(base, [], false, 2, 0, null, null);
  const plan = T.plan(ctxM, SALARY);
  const deltas = T.deltas(ctxM, plan);
  const spent = SALARY + plan.parts.cashFree;
  const bought = deltas.reduce((a, r) => a + r.value_usd, 0);
  check(near(bought, SALARY, 1), `salary plan adds ${bought.toFixed(2)} = salary ${SALARY}`);
  pies = [];
  await T.build(base, deltas, true, 3, SALARY, ctxM.before, plan);
  for (const p of pies) {
    check(near(p.targetSum, p.total, 1), `salary — ${p.title}: targets ${p.targetSum.toFixed(2)} = total after ${p.total.toFixed(2)}`);
    if (/vs the rest/.test(p.title)) continue;   // Russia is only ever not topped up there
    for (const it of p.items) {
      const was = (p.before || {})[it.label] || 0;
      if (it.label !== 'cash 💵' && !/liquid|bonds 🏛️ 🇨🇳|^bond /.test(it.label)) check(it.usd >= was - 0.01, `salary — ${p.title} / ${it.label}: nothing sold (${was.toFixed(2)} → ${it.usd.toFixed(2)})`);
    }
  }
}
await scenario('Russia above 5%, cash above $10,000', base, 5000);
// Russia well under 5%, little cash, crypto under 5%.
const small = { ...base,
  data: base.data.map(r => (r.account === 'Revolut' && r.ticker === 'FUND' ? { ...r, value_usd: 60000 } : r.ticker === 'BTC' ? { ...r, value_usd: 800 } : r)),
  cashRows: base.cashRows.map(r => (r.account === 'Revolut' ? { ...r, value_usd: 4000 } : r)),
};
await scenario('Russia under 5%, cash under $10,000', small, 20000);
await scenario('Russia above 5%, no salary money left for Russia', base, 300);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
