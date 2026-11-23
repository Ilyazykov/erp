// The Charts tab's salary plan and target charts, the look-through table and
// Russian infrastructure.

// ---- Salary plan (Charts tab): where a month's salary goes, step by step,
// against the charts' targets. Money is only ever added, except step 6. ----
let mpSalaryCtx = null;
// Freedom's target share of IBKR + Freedom (chart 10); 06.11.2026: 0.2 -> 0.12,
// by safety (Freedom 7% of everything against IBKR's ~53%, MP_BROKER_TARGETS)
const FREEDOM_SHARE = 0.12;
// Russian infrastructure's target, % of everything but real estate (charts 2, 8, 11)
const RU_TARGET_PCT = 5;
// Where the money's kept, by safety (06.11.2026): % of everything but real
// estate per bank / broker / wallet -- the odds of losing it and of a freeze
// (a Russian citizen whose Cyprus / Serbia / Turkey residence permits are
// gone): Georgia (where one lives, two banks under the 30 000 GEL insurance
// each), Revolut and the exchanges low (EU sanctions, re-KYC, hacks), the
// crypto in one's own wallet; Russia -- RU_TARGET_PCT, split Sber 3 : T-Bank
// 3 : Alfa 2; IBKR + Freedom -- the rest, Freedom FREEDOM_SHARE of it.
// Anything else (Ziraat, Raif, Telegram, cash) -- 0.
// one's own wallets 10% (21.11.2026: Telegram's wallet is now non-custodial -- its risks are Trust's, so the two
// share the own-wallet 10% evenly; "Где хранить деньги" in the knowledge base)
const MP_BROKER_TARGETS = { 'TBC Bank': 8, 'Credo Bank': 7, Revolut: 8, Trust: 5, Telegram: 5, Bybit: 1, 'Crypto.com': 1 };
const MP_RU_BANK_SPLIT = { Sber: 3, 'T-Bank': 3, Alfa: 2 };
function mpBrokerTargets() {
  const t = { ...MP_BROKER_TARGETS };
  const ruW = Object.values(MP_RU_BANK_SPLIT).reduce((a, v) => a + v, 0);
  for (const [a, w] of Object.entries(MP_RU_BANK_SPLIT)) t[a] = RU_TARGET_PCT * w / ruW;
  const rest = 100 - Object.values(t).reduce((a, v) => a + v, 0);
  t.Freedom24 = rest * FREEDOM_SHARE;
  t.IBKR = rest - t.Freedom24;
  return t;
}
// Target split of the crypto (chart 6, salary step 2); any other coin: 0.
const MP_CRYPTO_TARGETS = { BTC: 76, ETH: 18, SOL: 3, GRAM: 2, TAO: 1 };
const MP_SALARY_KEY = 'mp_salary_usd';
// The plan, from today's figures (ctx from mpBuildCharts' measuring pass):
// { rows: [[step, action, usd, detail]], parts } -- parts are the amounts
// mpSalaryDeltas turns into holdings.
// The salary plan's options (checkboxes above the charts, all off by default).
function mpSalaryFlags() {
  const on = id => !!document.getElementById(id).checked;
  return {
    liquid: on('mp_salary_revolut'), ruLiquid: on('mp_salary_ruliquid'), ruCash: on('mp_salary_rucash'),
    sellYuan: on('mp_salary_sellyuan'), sellStocks: on('mp_salary_sellstocks'), noFreedom: on('mp_salary_nofreedom'),
  };
}
function mpSalaryPlan(c, salary, flags = mpSalaryFlags()) {
  const rows = [];
  const parts = {};
  let left = salary;
  const take = need => { const a = Math.max(0, Math.min(left, need)); left -= a; return a; };
  const newTotal = c.total + salary;

  // 0. Rent, then a month's expenses into the liquidity fund -- amounts not set up yet.
  rows.push(['0', 'Rent; month’s expenses → liquidity fund', null, 'not set up yet']);
  // Option, joining the salary (30.10.2026): the liquidity funds outside
  // Russia above the liquid assets' target on chart 3 (the emergency fund's
  // part kept) and the cash on the brokerage accounts outside Russia. (The
  // banks' cash and the cash on hand are money to spend on things -- not
  // invested.)
  parts.liquidFree = flags.liquid ? c.liquidFree : 0;
  // "nothing to Freedom": its cash stays where it is (it could only buy there)
  parts.cashFreeRows = flags.noFreedom ? c.cashFreeRows.filter(r => r.account !== 'Freedom24') : c.cashFreeRows;
  parts.cashFree = flags.liquid ? parts.cashFreeRows.reduce((a, r) => a + r.value_usd, 0) : 0;
  left += parts.cashFree + parts.liquidFree;
  // (what to sell: Revolut's euro fund first, the next only once it's used
  // up -- in each fund's own currency)
  let toSell = parts.liquidFree;
  parts.liquidSell = c.liquidFreeRows.map(r => { const usd = Math.min(toSell, r.value_usd); toSell -= usd; return { row: r, usd }; })
    .filter(s => s.usd > 0.005);
  const sellText = parts.liquidSell.map(({ row: r, usd }) => {
    const ccy = r.underlying_currency || r.currency;
    return `${r.account} ${ccy} fund ${mpFormatCurrency(c.fx && c.fx[ccy] ? usd / c.fx[ccy] : usd, c.fx && c.fx[ccy] ? ccy : 'USD')}`;
  }).join(', ');
  if (parts.liquidFree) rows.push(['0', 'Liquidity funds above their target added to the salary', parts.liquidFree,
    `sell: ${sellText} (target ${mpFormatUsd(c.liquidTarget)}, the emergency fund’s part kept)`]);
  if (parts.cashFree) rows.push(['0', 'Brokerage accounts’ cash added to the salary', parts.cashFree,
    [...new Set(parts.cashFreeRows.map(r => r.account))].map(a =>
      `${a} ${mpFormatUsd(parts.cashFreeRows.filter(r => r.account === a).reduce((s, r) => s + r.value_usd, 0))}`).join(', ')]);
  // 1-3. Gold, crypto, Russian infrastructure up to 5% each of the new total.
  // (gold / crypto of chart 3's total, Russia of chart 10's -- as the charts measure them)
  const newTotal3 = c.total3 + salary;
  parts.gold = take(0.05 * newTotal3 - c.gold);
  rows.push(['1', 'Gold up to 5%', parts.gold, `now ${(c.gold / c.total * 100).toFixed(1)}%`]);
  // The crypto by the AHR999 strategy (mpCryptoPlan; the plain 5% without its data)
  const cplan = mpCryptoPlan(c.total3 > 0 ? c.crypto / c.total3 * 100 : 0);
  const cryptoPct = cplan ? cplan.target : 5;
  const crypto = cplan?.action === 'sell' ? 0 : take(cryptoPct / 100 * newTotal3 - c.crypto);
  // a sale in the green zone: the money joins the salary, taken from each coin by its size
  const cryptoSell = cplan?.action === 'sell' ? Math.max(0, c.crypto - cryptoPct / 100 * newTotal3) : 0;
  left += cryptoSell;
  // Split over the coins toward MP_CRYPTO_TARGETS: each short coin gets a share of its shortfall.
  const short = Object.entries(MP_CRYPTO_TARGETS)
    .map(([t, pct]) => [t, Math.max(0, pct / 100 * (c.crypto + crypto) - (c.coins[t] || 0))]).filter(([, v]) => v > 0);
  const shortSum = short.reduce((s, [, v]) => s + v, 0);
  parts.coins = crypto > 0 && shortSum > 0 ? Object.fromEntries(short.map(([t, v]) => [t, v / shortSum * crypto]))
    : cryptoSell > 0 && c.crypto > 0 ? Object.fromEntries(Object.entries(c.coins).map(([t, v]) => [t, -cryptoSell * v / c.crypto])) : {};
  const ahrNote = cplan ? `AHR999 ${cplan.ahr.toFixed(2)}, ${cplan.why}` : '';
  rows.push(['2', cryptoSell ? `Crypto: sell down to ${cryptoPct.toFixed(1)}%` : `Crypto up to ${cryptoPct.toFixed(1)}%`, cryptoSell ? -cryptoSell : crypto,
    [`now ${(c.crypto / c.total * 100).toFixed(1)}%`, ahrNote,
      Object.entries(parts.coins).map(([t, v]) => `${t} ${mpFormatUsd(v)}`).join(', ')].filter(Boolean).join(' — ')]);
  const ruAdd = take(0.05 * newTotal - c.ruTotal);
  rows.push(['3', 'Russian infrastructure up to 5%', ruAdd, `now ${(c.ruTotal / c.total * 100).toFixed(1)}%`]);

  // 4. The rest: stocks vs bonds at the US ERP target, over the whole
  // portfolio (chart 8) -- including step 3's money. Bonds: US Treasuries at IBKR.
  // (Steps 5-7 are worked out first -- their Russian stock purchases count
  // toward step 4's stock target -- and listed after step 4.)
  // 5-7. Inside Russian infrastructure. Its free money -- step 3's, the
  // yuan-bond sale (step 6) and the Russian liquid assets (step 7) -- first
  // buys stocks up to the ERP & Stocks/Bonds share of the new total, the
  // rest goes into rouble bonds.
  const cell = (t, ccy) => c.ruCells[`${MP_RU_INFRA_LABELS[t]} ${MP_RU_INFRA_CURRENCIES[ccy]}`] || 0;
  const ruNew = c.ruInfraTotal + ruAdd;   // chart 8's total
  const ruStockTarget = c.ruAlloc && (c.ruAlloc.Stocks + c.ruAlloc.Bonds) > 0
    ? c.ruAlloc.Stocks / (c.ruAlloc.Stocks + c.ruAlloc.Bonds) * ruNew : cell('stock', 'RUB');
  // Yuan bonds' target: w_CNY of the non-stock part, less yuan deposits --
  // the dollar between the buy / sell lines -- the yuan as held (wCnyTarget)
  const cnyNow = Object.entries(c.ruCells).filter(([l]) => !l.startsWith(MP_RU_INFRA_LABELS.stock) && l.includes(MP_RU_INFRA_CURRENCIES.CNY))
    .reduce((s, [, v]) => s + v, 0);
  const cnyTarget = c.wCny !== null ? Math.max(0, wCnyTarget(c.wCny, cnyNow, ruNew - ruStockTarget) - cell('deposit', 'CNY')) : null;
  parts.cnySold = flags.sellYuan && cnyTarget !== null && c.wCny < 0.3 ? Math.max(0, cell('bond', 'CNY') - cnyTarget) : 0;
  // (the Russian liquid assets are spent where they are, in step 8)
  parts.ruLiquid = flags.ruLiquid ? c.ruLiquidRaw : 0;
  const ruPool = ruAdd + parts.cnySold;
  const ruStockAdd = Math.max(0, Math.min(ruPool, ruStockTarget - cell('stock', 'RUB')));
  const ruStocksNow = RU_STOCK_TICKERS.reduce((s, t) => s + (c.valueByTicker[t] || 0), 0);
  parts.ruStocks = mpSalaryAllocate(DATA && DATA.ruTargetWeightsRaw, ruStocksNow, ruStockAdd, c, true, flags.sellStocks);
  const ruStocksSpent = parts.ruStocks.reduce((s, b) => s + b.usd, 0);
  // 7. What the stocks didn't take (lot sizes included) goes to bonds:
  // yuan bonds up to their target first, the rest rouble bonds.
  const bondMoney = ruPool - ruStocksSpent;
  parts.cnyBought = cnyTarget !== null ? Math.max(0, Math.min(bondMoney, cnyTarget - cell('bond', 'CNY'))) : 0;
  parts.rubBonds = bondMoney - parts.cnyBought;

  let stockAdd;
  if (c.usAlloc && (c.usAlloc.Stocks + c.usAlloc.Bonds) > 0) {
    const share = c.usAlloc.Stocks / (c.usAlloc.Stocks + c.usAlloc.Bonds);
    // The Russian stocks step 5 buys count toward the same target.
    // (the liquidity funds sold leave the group and come back through `left`:
    // counted once)
    stockAdd = take(share * (c.groupAll - parts.liquidFree + ruAdd + left) - c.stockAll - ruStocksSpent);
  } else stockAdd = take(left);
  rows.push(['4', 'Stocks (US ERP target)', stockAdd, '']);
  parts.usBonds = take(left);
  // US Treasuries split between the two brokers at their target shares.
  // "nothing to Freedom" (the box): all of it at IBKR
  const fShare = flags.noFreedom ? 0 : FREEDOM_SHARE;
  parts.usBondsFreedom = parts.usBonds * fShare;
  rows.push(['4', fShare ? `US Treasuries \u2014 IBKR ${Math.round((1 - fShare) * 100)}% / Freedom ${Math.round(fShare * 100)}%` : 'US Treasuries \u2014 IBKR', parts.usBonds,
    parts.usBonds ? `IBKR ${mpFormatUsd(parts.usBonds - parts.usBondsFreedom)}, Freedom ${mpFormatUsd(parts.usBondsFreedom)}` : '']);
  // 4.1 Individual companies up to 5% of the stocks (US Stocks tab allocator), the rest into the world fund.
  const usTotal = US_STOCK_TICKERS.reduce((s, t) => s + (c.valueByTicker[t] || 0), 0);
  const indAdd = Math.max(0, Math.min(stockAdd, 0.05 * (c.stockAll + stockAdd) - usTotal));
  parts.usStocks = mpSalaryAllocate(DATA && DATA.usTargetWeightsRaw, usTotal, indAdd, c, false, flags.sellStocks);
  rows.push(['4.1', 'Individual stocks up to 5% of stocks', indAdd, mpSalaryBuysText(parts.usStocks)]);
  // (what whole-share rounding left of the single-stock money goes to the fund too)
  const fundAdd = stockAdd - parts.usStocks.reduce((a, b) => a + b.usd, 0);
  // Freedom up to 20% of IBKR + Freedom after everything else step 4 puts
  // at IBKR (individual stocks, US Treasuries).
  parts.vwce = Math.max(0, Math.min(fundAdd,
    fShare * (c.ibkr + c.freedom + indAdd + parts.usBonds + fundAdd) - c.freedom - parts.usBondsFreedom));
  parts.vwra = fundAdd - parts.vwce;
  if (parts.vwce > 0) rows.push(['4.1', 'World fund — VWCE at Freedom (up to 20% of IBKR + Freedom)', parts.vwce, '']);
  if (parts.vwra > 0) rows.push(['4.1', 'World fund — VWRA at IBKR', parts.vwra, '']);
  // The money to move: what each broker abroad buys less the cash it has
  // (when that cash is in the plan), from the money freed / the salary.
  const cashAt = account => (parts.cashFree ? parts.cashFreeRows.filter(r => r.account === account).reduce((a, r) => a + r.value_usd, 0) : 0);
  const usStocksUsd = parts.usStocks.filter(b => b.usd > 0).reduce((a, b) => a + b.usd, 0);
  const moves = [
    ['Freedom24', parts.vwce + parts.usBondsFreedom, ['VWCE', parts.vwce], ['US Treasuries', parts.usBondsFreedom]],
    ['IBKR', parts.vwra + parts.usBonds - parts.usBondsFreedom + usStocksUsd,
      ['VWRA', parts.vwra], ['US Treasuries', parts.usBonds - parts.usBondsFreedom], ['stocks', usStocksUsd]],
  ];
  for (const [account, buys, ...what] of moves) {
    const move = buys - cashAt(account);
    if (move > 0.5) rows.push(['→', `Move to ${account}`, move, [what.filter(([, v]) => v > 0.5).map(([l, v]) => `${l} ${mpFormatUsd(v)}`).join(' + '),
      cashAt(account) > 0.005 ? `less its cash ${mpFormatUsd(cashAt(account))}` : ''].filter(Boolean).join(', ')]);
  }

  rows.push(['5', 'Russian stocks (ERP & Stocks/Bonds target)', ruStocksSpent, mpSalaryBuysText(parts.ruStocks)]);
  if (parts.cnySold) rows.push(['6', `Sell yuan bonds (w_CNY ${(c.wCny * 100).toFixed(1)}% < 30%)`, -parts.cnySold, '']);
  if (parts.cnyBought) rows.push(['7', 'Yuan bonds up to the w_CNY target', parts.cnyBought, '']);
  rows.push(['7', 'Rouble bonds (the rest of Russian free money)', parts.rubBonds, '']);

  // 8. The Russian brokers' cash and the Russian liquid assets' free part
  // (what the card debt netted against them leaves -- each holding its share
  // by size), each account's on that account, in its own currency. Yuan:
  // into the account's yuan bond fund -- or, with yuan bonds at / above their
  // w_CNY target (after steps 6-7), sold for roubles there. Roubles: Russian
  // stocks while they're under their target (whole lots, by the target
  // weights), then the account's yuan bond fund while yuan bonds are under
  // theirs, the rest the account's rouble bond fund.
  parts.brokerCash = [];
  if (flags.ruCash || parts.ruLiquid > 0) {
    const liqRows = c.holdings.filter(r => mpIsRuInfra(r) && r.instrument_type === 'liquid' && r.value_usd > 0);
    const liqGross = liqRows.reduce((a, r) => a + r.value_usd, 0);
    const liquidOf = account => liqGross > 0 ? liqRows.filter(r => r.account === account).map(r => ({
      ticker: r.ticker, ccy: r.underlying_currency || r.currency, usd: parts.ruLiquid * r.value_usd / liqGross,
      priceUsd: /^(SAVINGS|DEPOSIT):/.test(r.ticker) ? null : c.priceUsdByTicker[r.ticker] || null,
    })).filter(l => l.usd > 0) : [];
    const cashRows = flags.ruCash ? c.ruBrokerCashRows : [];
    const fx = c.fx || {};
    const native = (usd, ccy) => (fx[ccy] ? usd / fx[ccy] : 0);
    const yuanAbove = cnyTarget === null || cell('bond', 'CNY') - parts.cnySold + parts.cnyBought >= cnyTarget;
    // what the yuan bonds still lack of their target (the yuan cash's fund buys count)
    let cnyGap = cnyTarget === null ? 0 : Math.max(0, cnyTarget - (cell('bond', 'CNY') - parts.cnySold + parts.cnyBought));
    let stockGap = Math.max(0, ruStockTarget - cell('stock', 'RUB') - ruStocksSpent);
    let stocksHeld = ruStocksNow + ruStocksSpent;
    // The account's bond fund in that currency: the one it holds most of, else
    // the ones set for it (MP_RU_BROKER_FUNDS) in their order -- the first
    // that `usd` buys a whole unit of.
    const fundsAt = (account, ccy) => {
      const held = c.holdings.filter(r => r.account === account && r.asset_class === 'moex_bond_etf' && (r.underlying_currency || r.currency) === ccy && r.value_usd > 0)
        .sort((a, b) => b.value_usd - a.value_usd).map(r => r.ticker);
      return [...new Set([...held, ...((MP_RU_BROKER_FUNDS[account] || {})[ccy] || [])])]
        .filter(t => c.priceUsdByTicker[t]).map(t => ({ ticker: t, priceUsd: c.priceUsdByTicker[t] }));
    };
    const fundBuy = (account, ccy, usd) => {
      for (const f of fundsAt(account, ccy)) {
        const units = Math.floor(usd / f.priceUsd);
        if (units > 0) return { ticker: f.ticker, units, usd: units * f.priceUsd };
      }
      return null;
    };
    // Whole bonds first where the money reaches one: the bonds of that
    // currency already held (any account), the smallest position first --
    // a bond at a time, so the holdings even out; what's left under a bond's
    // price goes to the fund. (The price is the clean one: the accrued
    // interest comes on top -- 2% kept for it.)
    // TODO (TODO.md, section 22): the order to pick bonds in -- a stopgap.
    const bondHeld = {};
    for (const r of c.holdings) if (['moex_bond', 'moex_ofz'].includes(r.asset_class) && r.value_usd > 0) bondHeld[r.ticker] = (bondHeld[r.ticker] || 0) + r.value_usd;
    const bondCcy = Object.fromEntries(c.holdings.filter(r => r.ticker in bondHeld).map(r => [r.ticker, r.underlying_currency || r.currency]));
    // the Bonds & deposits tab's logic when it has run (06.11.2026): its ladder,
    // floaters and yuan corporates, whole bonds; what's left -- the fund
    const bondSession = mpBondCtx ? mpBondCtx.session() : null;
    const buyFund = (account, ccy, usd) => {
      if (bondSession) {
        const r = bondSession(ccy, usd);
        const fund = fundBuy(account, ccy, r.left);
        const spent = r.buys.reduce((a, b) => a + b.usd, 0) + (fund ? fund.usd : 0);
        return spent > 0 ? { bonds: r.buys, fund, usd: spent } : null;
      }
      const bonds = [];
      let left = usd;
      for (;;) {
        const can = Object.keys(bondHeld).filter(t => bondCcy[t] === ccy && c.priceUsdByTicker[t] && c.priceUsdByTicker[t] * 1.02 <= left);
        if (!can.length) break;
        const t = can.sort((a, b) => bondHeld[a] - bondHeld[b])[0];
        const price = c.priceUsdByTicker[t];
        const b = bonds.find(x => x.ticker === t) || (bonds.push({ ticker: t, units: 0, usd: 0 }), bonds[bonds.length - 1]);
        b.units++; b.usd += price; left -= price; bondHeld[t] += price;
      }
      const fund = fundBuy(account, ccy, left);
      const spent = bonds.reduce((a, b) => a + b.usd, 0) + (fund ? fund.usd : 0);
      return spent > 0 ? { bonds, fund, usd: spent } : null;
    };
    const accounts = [...new Set([...cashRows.map(r => r.account), ...liqRows.filter(() => parts.ruLiquid > 0).map(r => r.account)])].sort();
    for (const account of accounts) {
      const own = ccy => cashRows.filter(r => r.account === account && r.currency === ccy).reduce((a, r) => a + r.usd, 0);
      const liquid = liquidOf(account);
      const liq = ccy => liquid.filter(l => l.ccy === ccy).reduce((a, l) => a + l.usd, 0);
      const e = { account, rubCash: own('RUB'), cnyCash: own('CNY'), liquid, rub: own('RUB') + liq('RUB'), cny: own('CNY') + liq('CNY'),
        cnyFund: null, cnyToRub: 0, stocks: [], rubToCny: null, rubFund: null, leftRub: 0, leftCny: 0 };
      // yuan
      if (e.cny > 0) {
        if (yuanAbove || !fundsAt(account, 'CNY').length) e.cnyToRub = e.cny;
        else {
          e.cnyFund = buyFund(account, 'CNY', e.cny);
          e.leftCny = e.cny - (e.cnyFund ? e.cnyFund.usd : 0);
          cnyGap = Math.max(0, cnyGap - (e.cnyFund ? e.cnyFund.usd : 0));
        }
      }
      // roubles (with the yuan sold)
      let rub = e.rub + e.cnyToRub;
      if (rub > 0 && stockGap > 0) {
        e.stocks = mpSalaryAllocate(DATA && DATA.ruTargetWeightsRaw, stocksHeld, Math.min(rub, stockGap), c, false, false).filter(b => b.usd > 0);
        const spent = e.stocks.reduce((a, b) => a + b.usd, 0);
        rub -= spent; stockGap -= spent; stocksHeld += spent;
      }
      // then the yuan bonds while they're under their target: the account's yuan fund, for roubles
      if (rub > 0 && cnyGap > 0) {
        e.rubToCny = buyFund(account, 'CNY', Math.min(rub, cnyGap));
        if (e.rubToCny) { rub -= e.rubToCny.usd; cnyGap -= e.rubToCny.usd; }
      }
      if (rub > 0) {
        e.rubFund = buyFund(account, 'RUB', rub);
        if (e.rubFund) rub -= e.rubFund.usd;
      }
      e.leftRub = rub;
      parts.brokerCash.push(e);
      const rubTxt = v => `${Math.round(native(v, 'RUB')).toLocaleString('ru-RU')} ₽`;
      const cnyTxt = v => `${native(v, 'CNY').toFixed(2)} ¥`;
      const txt = (v, ccy) => (ccy === 'CNY' ? cnyTxt(v) : rubTxt(v));
      const what = [
        e.rubCash > 0 ? `${rubTxt(e.rubCash)} cash` : '', e.cnyCash > 0 ? `${cnyTxt(e.cnyCash)} cash` : '',
        // a savings account: the amount to move to the brokerage account; a money-market fund: the units to sell
        ...e.liquid.map(l => `${txt(l.usd, l.ccy)} from ${l.priceUsd ? `${l.ticker} (sell ${Math.round(l.usd / l.priceUsd)})` : l.ticker.replace(/^(SAVINGS|DEPOSIT):/, '')}`),
      ].filter(Boolean).join(' + ');
      // a purchase: whole bonds (by name) and / or fund units
      const buys = x => [...x.bonds.map(b => `${b.units} × ${b.name || (c.bondNames || {})[b.ticker] || b.ticker}`),
        x.fund ? `${x.fund.units} × ${x.fund.ticker}` : ''].filter(Boolean).join(', ');
      const does = [
        e.cnyFund ? `${cnyTxt(e.cnyFund.usd)} → ${buys(e.cnyFund)}` : '',
        e.cnyToRub ? `${cnyTxt(e.cnyToRub)} → sell for roubles${cnyTarget !== null ? ' (yuan bonds at their w_CNY target)' : ''}` : '',
        ...e.stocks.map(b => `${rubTxt(b.usd)} → ${b.shares ? `${b.shares} × ` : ''}${b.ticker}`),
        e.rubToCny ? `${rubTxt(e.rubToCny.usd)} → ${buys(e.rubToCny)} (yuan bonds under their w_CNY target)` : '',
        e.rubFund ? `${rubTxt(e.rubFund.usd)} → ${buys(e.rubFund)}` : '',
        e.leftRub > 0.005 ? `${rubTxt(e.leftRub)} left` : '', e.leftCny > 0.005 ? `${cnyTxt(e.leftCny)} left` : '',
      ].filter(Boolean).join('; ');
      rows.push(['8', `${account}: ${what}`, null, does]);
    }
  }
  return { rows, parts };
}

function mpRenderSalaryTable(plan) {
  const wrap = document.getElementById('mp_salary_plan');
  if (!plan) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div class="section-title">Salary plan</div><div style="overflow-x:auto"><table class="data-table" style="width:auto">
    <thead><tr><th>Step</th><th style="text-align:left">Action</th><th>USD</th><th></th></tr></thead>
    <tbody>${plan.rows.map(([step, what, usd, detail]) => `<tr>
      <td>${step}</td><td class="ticker" style="text-align:left">${mpEscapeHtml(what)}</td>
      <td class="${usd < 0 ? 'neg' : ''}">${usd === null ? '—' : (usd < 0 ? '−' : '') + mpFormatUsd(Math.abs(usd))}</td>
      <td class="muted" style="text-align:left">${mpEscapeHtml(detail || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

// The Z-score allocator (the US Stocks / RU Stocks tabs)
// on `usd`: [{ticker, usd (signed), shares}] (a sale if it trims an
// overweight Z < -1.5 name).
// exact: fractional amounts (no whole-share rounding) -- the Russian step,
// where stocks must land on their target for the Russian charts to agree.
function mpSalaryAllocate(weights, totalUsd, usd, c, exact = false, allowSells = false) {
  if (!weights || !weights.length || usd <= 0) return [];
  const items = weights.map(r => ({
    // (the allocator sells Z < -1.5 names above target; without allowSells none is below -1.5)
    label: r.ticker, target: r.target, z: allowSells || r.z === null || r.z === undefined ? r.z : Math.max(r.z, -1.5),
    priceUsd: c.priceUsdByTicker[r.ticker] || null,
    current: (c.valueByTicker[r.ticker] || 0) / (totalUsd || 1) * 100,
    sector: MP_US_SECTOR_OF[r.ticker],
  }));
  const { deltaUsdByItem } = (exact ? mpAllocatePoolByZPriorityLegacy : mpAllocatePoolByZPriorityWithLots)(items, totalUsd, usd);
  return items.map(it => ({ ticker: it.label, usd: deltaUsdByItem.get(it) || 0, price: it.priceUsd }))
    .filter(b => Math.abs(b.usd) > (exact ? 0.001 : 0.5)).sort((a, b) => b.usd - a.usd)
    .map(b => ({ ...b, shares: b.price ? Math.round(Math.abs(b.usd) / b.price) : null }));
}
const mpSalaryBuysText = buys => buys.map(b =>
  `${b.usd < 0 ? 'sell ' : ''}${b.shares ? `${b.shares} × ` : ''}${b.ticker}${b.shares ? '' : ` $${Math.round(Math.abs(b.usd))}`}`).join(', ');

// The plan as holding rows added to the portfolio (for the charts):
// gold spread like today's gold, each coin where that coin is held now,
// stocks / bonds where those tickers / kinds are held (US Treasuries and
// VWRA at IBKR, VWCE at Freedom), Russian steps over today's Russian rows.
function mpSalaryDeltas(c, plan) {
  const p = plan.parts;
  const out = [];
  const held = c.holdings.filter(r => r.value_usd > 0);
  // `usd` spread over `rows` by their value, or one row from `template` when there are none.
  const spread = (usd, rows, template) => {
    if (!usd) return;
    const total = rows.reduce((s, r) => s + r.value_usd, 0);
    if (total > 0) for (const r of rows) out.push({ ...r, quantity: null, price_usd: null, value_usd: usd * r.value_usd / total });
    else out.push({ quantity: null, price_usd: null, ...template, value_usd: usd });
  };
  const largest = rows => [...rows].sort((a, b) => b.value_usd - a.value_usd)[0];
  // Spent cash comes out of the cash balances, each by its size.
  // (from cash outside Russia: Russian money stays in Russian infrastructure)
  for (const s of p.liquidSell || []) spread(-s.usd, [s.row], {});
  spread(-p.cashFree, p.cashFreeRows || c.cashFreeRows, {});
  spread(p.gold, held.filter(r => r.asset_class === 'gold'), { account: 'Revolut', ticker: 'XAU', asset_class: 'gold', instrument_type: 'gold', currency: 'USD' });
  const cryptoRows = held.filter(r => r.asset_class === 'crypto');
  for (const [t, usd] of Object.entries(p.coins)) {
    const where = largest(cryptoRows);
    spread(usd, cryptoRows.filter(r => r.ticker === t),
      { account: where ? where.account : 'Bybit', ticker: t, asset_class: 'crypto', instrument_type: 'crypto', currency: 'USD' });
  }
  const usStock = { account: 'IBKR', asset_class: 'us_stock', instrument_type: 'stock', currency: 'USD', underlying_currency: 'USD', infra_region: 'foreign' };
  for (const b of p.usStocks) spread(b.usd, held.filter(r => r.ticker === b.ticker), { ...usStock, ticker: b.ticker });
  spread(p.usBondsFreedom, [], { account: 'Freedom24', ticker: 'US Treasuries', asset_class: 'bond', instrument_type: 'bond', currency: 'USD', underlying_currency: 'USD', infra_region: 'foreign' });
  spread(p.usBonds - p.usBondsFreedom, [], { account: 'IBKR', ticker: 'US Treasuries', asset_class: 'bond', instrument_type: 'bond', currency: 'USD', underlying_currency: 'USD', infra_region: 'foreign' });
  const etf = { asset_class: 'western_etf', instrument_type: 'stock', infra_region: 'foreign' };
  spread(p.vwce, held.filter(r => r.ticker === 'VWCE' && r.account === 'Freedom24'), { ...etf, account: 'Freedom24', ticker: 'VWCE', currency: 'EUR', underlying_currency: 'EUR' });
  spread(p.vwra, held.filter(r => r.ticker === 'VWRA' && r.account === 'IBKR'), { ...etf, account: 'IBKR', ticker: 'VWRA', currency: 'USD', underlying_currency: 'USD' });
  const ru = held.filter(r => mpIsRuInfra(r));
  const ruBroker = (largest(ru.filter(r => r.instrument_type === 'stock')) || largest(ru) || {}).account || 'T-Bank';
  const ruStock = { account: ruBroker, asset_class: 'moex_share', instrument_type: 'stock', currency: 'RUB', underlying_currency: 'RUB', infra_region: 'ru' };
  for (const b of p.ruStocks) spread(b.usd, ru.filter(r => r.ticker === b.ticker), { ...ruStock, ticker: b.ticker });
  const ccy = r => r.underlying_currency || r.currency;
  spread(-p.cnySold, ru.filter(r => r.instrument_type === 'bond' && ccy(r) === 'CNY'), {});
  spread(p.cnyBought, ru.filter(r => r.instrument_type === 'bond' && ccy(r) === 'CNY'),
    { ...ruStock, ticker: 'SBBY', asset_class: 'moex_bond_etf', instrument_type: 'bond', underlying_currency: 'CNY' });
  // Russian liquid assets: what's free of the card debt netted against them
  // (p.ruLiquid) moves into the rouble bonds; the part covering the debt stays.
  spread(-p.ruLiquid, ru.filter(r => r.instrument_type === 'liquid'), {});
  // 8. each brokerage account's cash into what it buys there
  for (const e of p.brokerCash || []) {
    const cashOut = (ccy, usd) => spread(-usd, c.cashRows.filter(r => r.account === e.account && r.currency === ccy && r.instrument_type === 'cash'),
      { account: e.account, currency: ccy, instrument_type: 'cash' });
    // (the liquid assets leave through the spread above; what isn't spent of
    // all of it -- less than a unit -- stays as the account's cash)
    cashOut('CNY', e.cnyCash - e.leftCny);
    cashOut('RUB', e.rubCash - e.leftRub);
    for (const b of e.stocks) spread(b.usd, ru.filter(r => r.ticker === b.ticker && r.account === e.account), { ...ruStock, account: e.account, ticker: b.ticker });
    for (const [x, ccy] of [[e.cnyFund, 'CNY'], [e.rubToCny, 'CNY'], [e.rubFund, 'RUB']]) {
      if (!x) continue;
      for (const b of x.bonds) spread(b.usd, ru.filter(r => r.ticker === b.ticker && r.account === e.account),
        { ...ruStock, account: e.account, ticker: b.ticker, asset_class: 'moex_bond', instrument_type: 'bond', underlying_currency: ccy });
      const f = x.fund;
      // (a money-market fund -- AKMC -- is liquid assets, as update-market-prices classes it)
      const mm = ['AKMC', 'AMNY', 'SBMM', 'AKMM'].includes(f && f.ticker);
      if (f) spread(f.usd, ru.filter(r => r.ticker === f.ticker && r.account === e.account),
        { ...ruStock, account: e.account, ticker: f.ticker, asset_class: mm ? 'money_market_fund' : 'moex_bond_etf', instrument_type: mm ? 'liquid' : 'bond', underlying_currency: ccy });
    }
  }
  spread(p.rubBonds, ru.filter(r => r.instrument_type === 'bond' && ccy(r) === 'RUB'),
    { ...ruStock, ticker: 'OFZ', asset_class: 'moex_bond', instrument_type: 'bond' });
  return out;
}

{
  const input = document.getElementById('mp_salary_amount');
  try { input.value = localStorage.getItem(MP_SALARY_KEY) || ''; } catch { /* no storage */ }
  let timer = null;
  input.addEventListener('input', () => {
    mpSave(MP_SALARY_KEY, input.value);
    clearTimeout(timer);
    timer = setTimeout(() => mpDrawCharts(), 400);
  });
  for (const id of ['mp_salary_revolut', 'mp_salary_ruliquid', 'mp_salary_rucash', 'mp_salary_sellyuan', 'mp_salary_sellstocks']) {
    document.getElementById(id).addEventListener('change', () => mpDrawCharts());
  }
  const noFreedom = document.getElementById('mp_salary_nofreedom');
  try { noFreedom.checked = localStorage.getItem('mp_salary_nofreedom') === '1'; } catch { /* no storage */ }
  noFreedom.addEventListener('change', () => {
    mpSave('mp_salary_nofreedom', noFreedom.checked ? '1' : '0');
    mpDrawCharts();
  });
  // chart 3's emergency fund switch, remembered in this browser
  const cushion = document.getElementById('mp_charts_cushion');
  try { cushion.checked = localStorage.getItem('mp_charts_cushion') === '1'; } catch { /* no storage */ }
  cushion.addEventListener('change', () => {
    mpSave('mp_charts_cushion', cushion.checked ? '1' : '0');
    mpDrawCharts();
  });
}

let mpChartsRun = 0;
let mpChartsPending = false;
async function mpRenderCharts() {
  // Drawn only while the tab is open (a hidden plot has no width to size
  // itself to); otherwise on the next switch to it.
  if (!document.getElementById('charts').classList.contains('active')) { mpChartsPending = true; return; }
  mpChartsPending = false;
  const status = document.getElementById('mp_charts_status');
  // Sign-in can fire this twice in a row: only the latest run draws.
  const run = ++mpChartsRun;
  status.textContent = 'Loading…';
  await mpLoadCryptoIndicators().catch(() => []);
  try { mpChartsBase = await mpLoadPortfolioBase(); }
  catch (error) { status.textContent = error.message; return; }
  await mpDrawCharts(run);
}

// The charts as the portfolio stands, or -- with a salary typed in -- as it
// will stand once the salary plan is carried out: the plan is worked out
// from today's figures (a measuring pass, nothing drawn), turned into
// holding rows (mpSalaryDeltas) and the charts drawn from base + those.
let mpChartsBase = null;
async function mpDrawCharts(run = ++mpChartsRun) {
  if (!mpChartsBase) return;
  if (!document.getElementById('charts').classList.contains('active')) { mpChartsPending = true; return; }
  const ctx = await mpBuildCharts(mpChartsBase, [], false, run);
  if (!ctx || run !== mpChartsRun) return;
  mpSalaryCtx = ctx;
  // step 8 buys bonds by the Bonds & deposits tab's logic: worked out once if that tab hasn't been opened
  const fl = mpSalaryFlags();
  if (!mpBondCtx && mpIsSignedIn && (fl.ruCash || fl.ruLiquid)) { try { await mpRenderMaturities(); } catch { /* the old way then */ } }
  const salary = Math.max(0, parseFloat(document.getElementById('mp_salary_amount').value) || 0);
  // (the plan runs with no salary too: it still moves the free money)
  const plan = mpSalaryPlan(ctx, salary);
  // (no table when nothing is moved)
  mpRenderSalaryTable(salary || plan.rows.some(r => r[2] && Math.abs(r[2]) >= 0.005) || plan.parts.brokerCash.length ? plan : null);
  await mpBuildCharts(mpChartsBase, mpSalaryDeltas(ctx, plan), true, run, salary, ctx.before, plan);
}

async function mpBuildCharts(baseIn, extra, draw, run, salary = 0, before = null, plan = null) {
  const nothingMoves = () => !salary && extra.every(r => Math.abs(r.value_usd) < 0.005);
  // Drawing with no plan given: the plan runs anyway (with this salary, 0
  // included) -- even without new money it moves the free money (cash above
  // $10,000, Russian liquid assets, yuan above target) to the targets, and
  // the charts show that.
  if (draw && !plan) {
    const ctx = await mpBuildCharts(baseIn, [], false, run);
    if (!ctx) return null;
    plan = mpSalaryPlan(ctx, salary);
    extra = mpSalaryDeltas(ctx, plan);
    before = ctx.before;
  }
  // With nothing to move (no salary, no option on) the charts are today's portfolio.
  if (draw && nothingMoves()) { extra = []; before = null; plan = null; }
  const grid = document.getElementById('mp_charts_grid');
  const status = document.getElementById('mp_charts_status');
  const base = { ...baseIn, data: [...baseIn.data, ...extra] };
  // In the measuring pass nothing is drawn; the target charts' slices are
  // recorded (ctx.before) so the drawn pass can show what the plan bought / sold.
  const recorded = {};
  const pie = draw ? mpPie : () => {};
  const tpie = draw
    ? (el, title, items, note = '', targetTotal = null, shareOfTarget = false, money = null, bought = null) =>
      mpTargetPie(el, title, items, note, targetTotal, shareOfTarget, before ? before[title] || {} : null, money, bought)
    : (el, title, items) => { recorded[title] = Object.fromEntries(items.map(it => [it.label, it.usd])); };
  const curRows = mpNetCreditIntoLiquid((await mpCurrencyRows(base)).filter(r => r.value_usd !== null));
  const assetRows = mpNetCreditIntoLiquid(
    [...await mpSplitFundsCash(base.data), ...base.cashRows, ...base.realEstateRows].filter(r => r.value_usd !== null));
  const isRealEstate = r => r.account === 'real estate';
  const brokerName = a => `${MP_BROKER_SHORT_NAMES[a] || a}${MP_BROKER_FLAGS[a] ? ` ${MP_BROKER_FLAGS[a]}` : ''}`;
  const isRu = mpIsRuInfra;

  // 1. Currencies -- the broker x currency table's total row.
  const currencyLabel = c => (c === MP_OTHER_CURRENCIES_COLUMN ? 'others 🌍' : `${c}${MP_CURRENCY_FLAGS[c] ? ` ${MP_CURRENCY_FLAGS[c]}` : ''}`);
  const byCurrency = {};
  // The "others" column split into its currencies (JPY, CAD, TWD, ... --
  // flagged by the country an ISO code starts with), Altcoins into coins.
  for (const r of curRows) if (!r.excluded) {
    const label = r.currency === MP_OTHER_CURRENCIES_COLUMN ? `${r.own_currency} ${mpFlagOf(r.own_currency.slice(0, 2))}`
      : r.currency === MP_ALTCOINS_COLUMN ? (MP_CHART_COIN_OF[r.ticker] ? currencyLabel(mpChartCoin(r.ticker)) : r.ticker)
      : currencyLabel(r.currency);
    mpAdd(byCurrency, label, r.value_usd);
  }
  // 2 / 8 / 9. Banks and brokers -- the table's per-broker totals (credit netted
  // into liquid assets instead), no real estate.
  const byBroker = {};
  for (const r of curRows) if (!isRealEstate(r)) mpAdd(byBroker, r.account, r.value_usd);
  // 3 / 7 / 11. Asset types -- the broker x asset-class table's total row.
  const types = mpAssetBuckets(assetRows.filter(r => !isRealEstate(r)));
  // 4. Stocks by country: shares by their own country, funds split by what they hold.
  const stockRows = assetRows.filter(r => r.instrument_type === 'stock' && r.value_usd > 0);
  const tickers = [...new Set(stockRows.map(r => r.ticker).filter(Boolean))];
  const [{ data: fundCountries }, { data: direct }, { data: fundSectors }] = await Promise.all([
    sb.from('fund_country_weights').select('*').in('fund', tickers),
    sb.from('securities').select('market_ticker, country, country_code, sector').in('market_ticker', tickers),
    sb.from('fund_sector_weights').select('*').in('fund', tickers),
  ]);
  // Stocks by sector: shares by their own sector, funds split by what they hold.
  const sectorW = {};
  for (const w of fundSectors || []) (sectorW[w.fund] ??= []).push(w);
  const directSector = Object.fromEntries((direct || []).map(d => [d.market_ticker, d.sector]));
  const bySector = {};
  const fundW = {};
  for (const w of fundCountries || []) (fundW[w.fund] ??= []).push(w);
  const directC = Object.fromEntries((direct || []).map(d => [d.market_ticker, d]));
  const byCountry = {};
  const codeOfLabel = {};
  // (DD / FX / UK are old codes for Germany / France / the UK some rows may still carry)
  const countryLabel = (name, code) => {
    code = { DD: 'DE', FX: 'FR', UK: 'GB' }[code] || code;
    const l = `${name} ${mpFlagOf(code)}`; codeOfLabel[l] = code; return l;
  };
  let usSingles = 0;   // US shares bought one by one (not through a fund)
  for (const r of stockRows) {
    const sw = sectorW[r.ticker];
    if (sw) {
      const t = sw.reduce((a, w) => a + Number(w.weight), 0);
      for (const w of sw) mpAdd(bySector, w.sector, r.value_usd * Number(w.weight) / t);
    } else mpAdd(bySector, directSector[r.ticker] || 'Unclassified', r.value_usd);
    if (!fundW[r.ticker] && US_STOCK_TICKERS.includes(r.ticker)) usSingles += r.value_usd;
    const ws = fundW[r.ticker];
    if (ws) {
      const total = ws.reduce((s, w) => s + Number(w.weight), 0);
      for (const w of ws) mpAdd(byCountry, countryLabel(w.country, w.country_code), r.value_usd * Number(w.weight) / total);
    } else if (directC[r.ticker]) {
      mpAdd(byCountry, countryLabel(directC[r.ticker].country, directC[r.ticker].country_code), r.value_usd);
    } else {
      mpAdd(byCountry, r.infra_region === 'ru' ? countryLabel('Russia', 'RU') : countryLabel('United States', 'US'), r.value_usd);
    }
  }
  // (countries under 1% go into mpPie's "other" slice, listed on hover and below)
  const countries = byCountry;
  // The same with the European Union's members as one slice.
  const countriesEu = {};
  const euMembers = {};
  for (const [k, v] of Object.entries(byCountry)) {
    const eu = MP_EU_MEMBERS.has(codeOfLabel[k]);
    mpAdd(countriesEu, eu ? 'EU 🇪🇺' : k, v);
    if (eu) mpAdd(euMembers, k, v);
  }
  // 5. Crypto by coin.
  const crypto = {};
  for (const r of base.data) if (r.asset_class === 'crypto' && r.value_usd > 0) mpAdd(crypto, mpChartCoin(r.ticker), r.value_usd);
  // 6 / 10. Russian infrastructure -- the Russian table's cells.
  const ruCells = {};
  for (const r of assetRows) {
    if (!isRu(r)) continue;
    const ccy = r.underlying_currency || r.currency;
    const type = r.instrument_type;
    if (!MP_RU_INFRA_TYPES.includes(type) || !(ccy in MP_RU_INFRA_CURRENCIES)) continue;
    mpAdd(ruCells, `${type} ${ccy}`, r.value_usd);
  }
  // Per currency, a sliver of cash (< 1% of the chart) folds into that
  // currency's liquid assets, and liquid assets still under 1% into its bonds.
  const ruBuckets = (skip = []) => {
    const cells = Object.fromEntries(Object.entries(ruCells).filter(([k, v]) => v > 0 && !skip.includes(k.split(' ')[0])));
    const total = Object.values(cells).reduce((s, v) => s + v, 0);
    for (const c of Object.keys(MP_RU_INFRA_CURRENCIES)) {
      for (const [from, into] of [['cash', 'liquid'], ['liquid', 'bond']]) {
        const v = cells[`${from} ${c}`];
        if (v && v / total < 0.01) { cells[`${into} ${c}`] = (cells[`${into} ${c}`] || 0) + v; delete cells[`${from} ${c}`]; }
      }
    }
    return Object.fromEntries(Object.entries(cells)
      .map(([k, v]) => { const [t, c] = k.split(' '); return [`${MP_RU_INFRA_LABELS[t]} ${MP_RU_INFRA_CURRENCIES[c]}`, v]; }));
  };
  // 9. Russian infrastructure vs the rest (no real estate).
  const ruTotal = curRows.filter(r => !isRealEstate(r) && isRu(r)).reduce((s, r) => s + r.value_usd, 0);
  const allTotal = curRows.filter(r => !isRealEstate(r)).reduce((s, r) => s + r.value_usd, 0);
  // 11. Asset types with real estate (every property, checked or not).
  const typesWithRealEstate = mpAssetBuckets(assetRows);

  if (run !== mpChartsRun) return null;
  if (draw) {
    grid.innerHTML = '';
    status.textContent = salary ? `After the salary plan (+${mpFormatUsd(salary)}) — the steps are below the charts.` : '';
  }
  // Slice order as in the user's own charts (clockwise from 12 o'clock).
  const currencyOrder = ['EUR', 'USD', 'RUB', 'GBP', 'CNY', 'JPY', 'TRY', 'RSD', 'GEL', MP_OTHER_CURRENCIES_COLUMN,
    'XAU', 'BTC', 'ETH', 'SOL', 'TAO', 'GRAM', MP_ALTCOINS_COLUMN]
    .map(c => (c === 'JPY' ? `JPY ${mpFlagOf('JP')}` : currencyLabel(c)));
  const brokerOrder = ['Freedom24', 'Bank of Cyprus', 'Revolut', 'Wise', 'Raiffeisen', 'UniCredit', 'Credo Bank', 'TBC Bank', 'Ziraat Bank', 'IBKR',
    'Sber', 'T-Bank', 'Ozon Bank', 'Alfa', 'Yandex Bank', 'Finuslugi', 'Telegram', 'Binance', 'Bybit', 'Crypto.com', 'Trust', 'cash',
    '(unspecified)'].map(brokerName);
  const typeOrder = ['bond', 'cash', 'cushion', 'deposit', 'liquid', 'gold', 'crypto', 'stock', 'real_estate'].map(t => MP_ASSET_CLASS_LABELS[t]);
  const cryptoOrder = ['TON', 'GRAM', 'TAO', 'ETH', 'BTC', 'SOL'];
  const ruOrder = [['stock', 'RUB'], ['bond', 'RUB'], ['deposit', 'RUB'], ['liquid', 'RUB'], ['cash', 'RUB'],
    ['bond', 'CNY'], ['deposit', 'CNY'], ['liquid', 'CNY'], ['cash', 'CNY'], ['stock', 'CNY']]
    .map(([t, c]) => `${MP_RU_INFRA_LABELS[t]} ${MP_RU_INFRA_CURRENCIES[c]}`);
  // Currencies carry a flag; crypto tickers don't.
  const isFiatLabel = l => /[\u{1F1E6}-\u{1F1FF}]|🌍/u.test(l);
  // Colours by what a label names (labels carry flags / emoji, so look the
  // key up from its first word, or from the maps the labels were built from).
  const key = l => l.split(' ')[0];
  const currencyColor = l => MP_COLORS.currency[key(l)] || null;
  const brokerByLabel = Object.fromEntries(Object.keys(MP_COLORS.broker).map(a => [brokerName(a), a]));
  const brokerColor = l => MP_COLORS.broker[brokerByLabel[l]] || null;
  const typeByLabel = Object.fromEntries(Object.keys(MP_COLORS.type).map(t => [MP_ASSET_CLASS_LABELS[t], t]));
  const typeColor = l => MP_COLORS.type[typeByLabel[l]] || null;
  const countryColor = l => (l === 'EU 🇪🇺' ? MP_COLORS.country.EU : MP_COLORS.country[codeOfLabel[l]] || null);
  // Russian infrastructure: roubles in muted greys tinted by the asset type
  // (chart 3), yuan in vivid shades of CNY's magenta (chart 1) -- so the two
  // currencies stand apart, and within each the types differ in hue and
  // lightness (stock dark plum vs bonds light blue, etc.).
  const ruColorByLabel = {};
  const RU_SHADES = {
    RUB: { stock: '#8a4a73', bond: '#7fa8d9', deposit: '#8e8e93', liquid: '#b4b4b9', cash: '#9fc98a' },
    CNY: { stock: '#a81d59', bond: '#e0307f', deposit: '#f06ba6', liquid: '#f59ac2', cash: '#ffc0da' },
  };
  for (const [c, shades] of Object.entries(RU_SHADES)) for (const [t, color] of Object.entries(shades)) {
    ruColorByLabel[`${MP_RU_INFRA_LABELS[t]} ${MP_RU_INFRA_CURRENCIES[c]}`] = color;
  }
  const ruColor = l => ruColorByLabel[l] || null;

  // Dollar targets for charts 3 and 8 (of the figures shown -- after the
  // salary plan when one is typed in).
  //   8: stocks at the US ERP tab's target share of chart 8's own total,
  //      bonds / deposits / liquid assets the rest in their current proportions;
  //   3: those four at chart 8's dollars, the emergency fund $10,000, gold 5%, crypto 5%.
  const GOLD_TARGET_PCT = 5;
  // crypto: the AHR999 strategy's target for this month (mpCryptoPlan), 5% without its data
  const cryptoNow = types[MP_ASSET_CLASS_LABELS.crypto] || 0, total3Now = Object.values(types).reduce((s, v) => s + v, 0);
  const CRYPTO_TARGET_PCT = mpCryptoPlan(total3Now > 0 ? cryptoNow / total3Now * 100 : 0)?.target ?? 5;
  const total3 = Object.values(types).reduce((s, v) => s + v, 0);
  // The emergency fund's money (30.10.2026) is out of chart 9 and the group
  // its targets are split over: Revolut's funds (euro, then dollar, then pound) and TBC's savings in it
  // aren't liquid assets to invest.
  await mpCushionEnsure().catch(() => {});   // what the fund takes whole (cushion_sources)
  const withCushion = mpWithCushion(assetRows.filter(r => !isRealEstate(r)));
  const L = MP_ASSET_CLASS_LABELS;
  const buckets3 = mpAssetBuckets(withCushion);
  const types8 = mpAssetBuckets(withCushion, ['stock', 'bond', 'deposit', 'liquid']);
  const total8 = Object.values(types8).reduce((s, v) => s + v, 0);
  // The cash outside the fund: money to spend on things, its target what it is.
  const cashOutside = buckets3[L.cash] || 0;
  const fundCash = (types[L.cash] || 0) - cashOutside;
  // The group's share of chart 3: its total less the emergency fund / that
  // cash / gold / crypto targets (gold and crypto 5% each) -- so chart 3's
  // targets add up to its total.
  const goldTarget = GOLD_TARGET_PCT / 100 * total3;
  const cryptoTarget = CRYPTO_TARGET_PCT / 100 * total3;
  const targetTotal8 = total3 - MP_CUSHION_USD - cashOutside - goldTarget - cryptoTarget;
  const usAlloc = DATA && DATA.usAllocTargetRaw;
  // Stocks at the US ERP share of `whole`, the other three the rest in
  // today's proportions (of `now`: chart 8's figures).
  const splitGroup = (whole, now = types8) => {
    const nowTotal = Object.values(now).reduce((s, v) => s + v, 0);
    if (!(usAlloc && (usAlloc.Stocks + usAlloc.Bonds) > 0 && nowTotal > 0 && whole > 0)) return null;
    const stockLabel = MP_ASSET_CLASS_LABELS.stock;
    const stockUsd = usAlloc.Stocks / (usAlloc.Stocks + usAlloc.Bonds) * whole;
    // Bonds and deposits at what they are, the liquid assets the rest -- so
    // spending the liquid assets above their target brings the stocks to
    // theirs, and selling them doesn't move the targets (13.11.2026: the rest
    // used to be split in today's proportions, so bonds / deposits took part
    // of the overweight and the stocks stayed short). When bonds and deposits
    // alone are over the rest, they share it in today's proportions.
    const liquidLabel = MP_ASSET_CLASS_LABELS.liquid;
    const rest = whole - stockUsd;
    const fixedNow = Object.entries(now).filter(([l]) => l !== stockLabel && l !== liquidLabel).reduce((s, [, v]) => s + v, 0);
    const liquidUsd = Math.max(0, rest - fixedNow);
    const scale = fixedNow > 0 ? (rest - liquidUsd) / fixedNow : 0;
    const out = Object.fromEntries(Object.entries(now).map(([l, v]) =>
      [l, l === stockLabel ? stockUsd : l === liquidLabel ? liquidUsd : v * scale]));
    if (!(liquidLabel in out)) out[liquidLabel] = liquidUsd;
    if (!(stockLabel in out)) out[stockLabel] = stockUsd;
    return out;
  };
  // Chart 9's target total is what chart 3's fund / cash / gold / crypto
  // targets leave of its total; chart 3 takes the same four targets.
  const target8 = splitGroup(targetTotal8);
  // Chart 3 (30.10.2026 -- the $10,000 used to be the cash's: the cash was
  // the emergency fund): the fund $10,000, the cash outside it at what it is,
  // the group as chart 9. With the switch above the charts on, the fund is a
  // slice of its own; off, its money stays in the cash / liquid assets
  // columns it sits in, and so does its $10,000 -- the cash its cash part, the
  // liquid assets the rest.
  const cushionOn = !!(document.getElementById('mp_charts_cushion') || {}).checked;
  const types3 = cushionOn ? buckets3 : types;
  const group3 = target8;
  const target3 = group3 && (cushionOn
    ? { ...group3, [L.cash]: cashOutside, [L.cushion]: MP_CUSHION_USD, [L.gold]: goldTarget, [L.crypto]: cryptoTarget }
    : { ...group3, [L.cash]: cashOutside + fundCash, [L.liquid]: (group3[L.liquid] || 0) + MP_CUSHION_USD - fundCash,
        [L.gold]: goldTarget, [L.crypto]: cryptoTarget });

  // Currencies first (the listed ones in order, then the rest largest first),
  // then gold and crypto (listed ones in order, then the rest).
  const currencyRank = l => {
    const i = currencyOrder.indexOf(l);
    return isFiatLabel(l) ? (i >= 0 ? i : 100) : 1000 + (i >= 0 ? i : 500);
  };
  // a click on a slice: a currency's rate to the dollar, a coin's or gold's price (not the dollar, not "other")
  pie(grid, '1. Currencies', byCurrency, '', currencyRank, true, l => (isFiatLabel(l) ? 0 : 1), currencyColor, {}, l => {
    const c = key(String(l || ''));
    if (!c || c === 'other' || c === 'others') return null;
    if (c === 'USD') return ['FX:USD', 'USD', { currency: 'USD' }];   // the Fed's rate
    if (isFiatLabel(l)) return [`FX:${c}`, c, { currency: c }];
    // gold as the portfolio map opens it: XAU's price, the deals of XAU (Revolut) and XAUT (the exchanges)
    if (c === 'XAU') return ['XAU', 'Gold', { also: ['XAUT'] }];
    return [c, c, { also: Object.keys(MP_CHART_COIN_OF).filter(k => MP_CHART_COIN_OF[k] === c) }];
  });
  {
    // the target by safety (MP_BROKER_TARGETS); what's held elsewhere -- 0
    const t = mpBrokerTargets();
    const rank = a => { const i = brokerOrder.indexOf(brokerName(a)); return i < 0 ? 99 : i; };
    const accts = [...new Set([...Object.keys(byBroker), ...Object.keys(t)])]
      .filter(a => (byBroker[a] || 0) > 0.5 || t[a] > 0).sort((a, b) => rank(a) - rank(b));
    tpie(grid, '2. Banks & brokers', accts.map(a => ({
      label: brokerName(a), usd: Math.max(0, byBroker[a] || 0), target: t[a] || 0, color: brokerColor(brokerName(a)) || MP_OTHER_COLOR,
    })), 'Target by safety: the odds of losing the money or of the account frozen (MP_BROKER_TARGETS).');
  }
  if (target3) {
    const labels = [...new Set([...Object.keys(types3), ...Object.keys(target3)])].sort((a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b));
    const sum3 = Object.values(target3).reduce((s, v) => s + v, 0);
    tpie(grid, '3. Asset types', labels.map(l => ({
      label: l, usd: types3[l] || 0, color: typeColor(l) || MP_OTHER_COLOR, target: (target3[l] || 0) / total3 * 100,
    })), '', sum3);
  } else {
    pie(grid, '3. Asset types', types3, '', typeOrder, true, () => 0, typeColor);
  }
  pie(grid, '4. Stocks by country', countries, 'Funds split by the countries of what they hold.', null, true, () => 0, countryColor);
  // (chart 5 is drawn further down, once the Russian targets are known; this keeps its place)
  const slot5 = document.createElement('div');
  slot5.style.display = 'contents';
  if (draw) grid.appendChild(slot5);
  pie(grid, '6. Stocks by sector', bySector, 'Funds split by the sectors of what they hold.', null, true, () => 0,
    l => MP_SECTOR_COLORS[l] || null);
  {
    // Coins with no target and under 1% of the crypto go into one "other"
    // slice (target 0), listed under the chart.
    const cryptoSum = Object.values(crypto).reduce((a, v) => a + v, 0);
    const small = Object.entries(crypto).filter(([t, v]) => !(t in MP_CRYPTO_TARGETS) && v / cryptoSum < 0.01)
      .sort((a, b) => b[1] - a[1]);
    const shown = Object.fromEntries(Object.entries(crypto).filter(([t]) => !small.some(([x]) => x === t)));
    if (small.length) shown.other = small.reduce((a, [, v]) => a + v, 0);
    const coins = [...new Set([...Object.keys(shown), ...Object.keys(MP_CRYPTO_TARGETS)])]
      .sort((a, b) => (a === 'other') - (b === 'other')
        || (cryptoOrder.includes(a) ? cryptoOrder.indexOf(a) : 99) - (cryptoOrder.includes(b) ? cryptoOrder.indexOf(b) : 99)
        || (shown[b] || 0) - (shown[a] || 0));
    tpie(grid, '7. Crypto', coins.map(t => ({
      label: t, usd: shown[t] || 0, target: MP_CRYPTO_TARGETS[t] || 0,
      color: t === 'other' ? MP_OTHER_COLOR : currencyColor(t) || mpSliceColor(t, () => null),
      // a click: the coin's price chart, its staked form's deals (tsTON is GRAM's) and old ticker marked too
      ...(t === 'other' ? {} : { chart: t, chartAlso: [...Object.keys(MP_CHART_COIN_OF).filter(k => MP_CHART_COIN_OF[k] === t), ...(t === 'GRAM' ? ['TON'] : [])] }),
    })), small.length ? `other: ${small.map(([t, v]) => `${t} ${(v / cryptoSum * 100).toFixed(2)}%`).join(', ')}` : '');
  }
  // Targets for the Russian-infrastructure charts (7 and 11), per slice in
  // dollars. Deposits can't be sold or topped up -- target = what's there;
  // liquid assets and cash -- 0 (they're what gets moved).
  //   11 (no stocks): yuan w_CNY (USD/RUB -> CNY Weight), roubles the rest;
  //      each currency's bonds take what its deposits leave.
  //   7 (with stocks): stocks at the RU ERP tab's target
  //      share, yuan at chart 11's dollars, rouble bonds whatever's left.
  const wCny = DATA && DATA.currentWCny !== undefined && DATA.currentWCny !== null ? DATA.currentWCny : null;
  const alloc = DATA && DATA.ruAllocTargetRaw && DATA.ruAllocTargetRaw.target;
  const ccyOf = l => (l.includes(MP_RU_INFRA_CURRENCIES.CNY) ? 'CNY' : 'RUB');
  const typeOf = l => MP_RU_INFRA_TYPES.find(t => l.startsWith(MP_RU_INFRA_LABELS[t]));
  const bondLabel = c => `${MP_RU_INFRA_LABELS.bond} ${MP_RU_INFRA_CURRENCIES[c]}`;
  const fixedTargets = cells => {
    const out = {};
    for (const [l, v] of Object.entries(cells)) {
      const t = typeOf(l);
      if (t === 'deposit') out[l] = v;
      else if (t === 'liquid' || t === 'cash') out[l] = 0;
    }
    return out;
  };
  const sumWhere = (obj, pred) => Object.entries(obj).filter(([l]) => pred(l)).reduce((s, [, v]) => s + v, 0);
  const ruNoStocks = ruBuckets(['stock']);
  let target11 = null;
  if (wCny !== null) {
    const total = Object.values(ruNoStocks).reduce((s, v) => s + v, 0);
    // the dollar between the buy / sell lines -- the yuan as held
    const cnyT = wCnyTarget(wCny, sumWhere(ruNoStocks, l => ccyOf(l) === 'CNY'), total);
    target11 = fixedTargets(ruNoStocks);
    for (const [c, sum] of [['RUB', total - cnyT], ['CNY', cnyT]]) {
      target11[bondLabel(c)] = Math.max(0, sum - sumWhere(target11, l => ccyOf(l) === c));
    }
  }
  // Chart 7's whole is chart 10's target: Russian infrastructure at
  // RU_TARGET_PCT of everything. Stocks take the allocation share of it,
  // deposits stay, liquid / cash go to 0, yuan bonds w_CNY of the non-stock
  // part minus yuan deposits (chart 11's rule), rouble bonds the rest.
  // Only ever grown toward the 5%: when Russia already holds more, today's
  // total is the target (nothing gets pulled out to shrink it).
  const ruAll = ruBuckets();
  // (chart 8's whole is what Russia holds -- after the salary plan when one is
  // typed in, which tops it up to 5%; its targets redistribute that)
  const ruTargetTotal = Object.values(ruAll).reduce((s, v) => s + v, 0);
  let target7 = null;
  if (wCny !== null && alloc && (alloc.Stocks + alloc.Bonds) > 0) {
    target7 = fixedTargets(ruAll);
    const stock = `${MP_RU_INFRA_LABELS.stock} ${MP_RU_INFRA_CURRENCIES.RUB}`;
    target7[stock] = alloc.Stocks / (alloc.Stocks + alloc.Bonds) * ruTargetTotal;
    const nonStock = ruTargetTotal - target7[stock];
    const cnyT = wCnyTarget(wCny, sumWhere(ruAll, l => l !== stock && ccyOf(l) === 'CNY'), nonStock);
    target7[bondLabel('CNY')] = Math.max(0, cnyT - sumWhere(target7, l => ccyOf(l) === 'CNY'));
    target7[bondLabel('RUB')] = Math.max(0, ruTargetTotal - sumWhere(target7, l => l !== bondLabel('RUB')));
  }
  // targetTotal given: the targets' own total (s2 for chart 12), which the
  // target shares are of.
  const drawRuTarget = (title, cells, targets, targetTotal = null) => {
    const whole = targetTotal ?? Object.values(cells).reduce((s, v) => s + v, 0);
    const labels = [...new Set([...Object.keys(cells), ...Object.keys(targets)])].sort((a, b) => ruOrder.indexOf(a) - ruOrder.indexOf(b));
    // Russian infrastructure is shown in roubles.
    const rub = base.fxByCurrency.RUB;
    const inRub = rub ? usd => mpFormatCurrency(usd / rub, 'RUB') : null;
    // (every slice the plan may have emptied -- liquid assets -- stays listed)
    const all = [...new Set([...labels, ...Object.keys((before && before[title]) || {})])]
      .sort((a, b) => ruOrder.indexOf(a) - ruOrder.indexOf(b));
    tpie(grid, title, all.map(l => ({
      label: l, usd: cells[l] || 0, color: ruColor(l) || MP_OTHER_COLOR, target: (targets[l] || 0) / whole * 100,
    })), '', targetTotal, targetTotal !== null, inRub);
  };

  // 5: stocks by country, EU as one, the single US stocks apart from the US
  // in funds. Targets: single US stocks 5% of the stocks; Russia at chart
  // 8's Russian stock target (5% Russia x its stock share); every other
  // country the rest in today's proportions.
  {
    const US = countryLabel('United States', 'US');
    const RU = countryLabel('Russia', 'RU');
    const SINGLES = 'US single stocks 🇺🇸';
    const withSingles = { ...countriesEu, [US]: (countriesEu[US] || 0) - usSingles, [SINGLES]: usSingles };
    const stockSum = Object.values(withSingles).reduce((a, v) => a + v, 0);
    const SINGLES_PCT = 5;
    const ruStockLabel = `${MP_RU_INFRA_LABELS.stock} ${MP_RU_INFRA_CURRENCIES.RUB}`;
    const ruTargetUsd = target7 ? target7[ruStockLabel] : (withSingles[RU] || 0);
    // Countries under 1% together -- with a salary, the same ones as before it
    // (so a country doesn't jump in or out of "other" and look bought / sold).
    const TITLE5 = '5. Stocks by country, US single stocks apart';
    const beforeKeys = draw && before && before[TITLE5] ? Object.keys(before[TITLE5]) : null;
    const grouped = {};
    for (const [k, v] of Object.entries(withSingles)) {
      const small = beforeKeys ? !beforeKeys.includes(k) : v / stockSum < 0.01;
      mpAdd(grouped, k !== SINGLES && k !== RU && small ? 'other 🌍' : k, v);
    }
    const restNow = stockSum - usSingles - (grouped[RU] || 0);
    // The whole the targets are shares of: chart 3's stock target (the same
    // stocks, split by country) -- but never below today's stocks, as nothing
    // is sold unless an option allows it.
    const stockWhole = Math.max((target3 && target3[MP_ASSET_CLASS_LABELS.stock]) || 0, stockSum);
    const restTargetPct = 100 - SINGLES_PCT - ruTargetUsd / stockWhole * 100;
    const order5 = [SINGLES, US];
    const labels5 = Object.keys(grouped).sort((a, b) =>
      (order5.includes(a) ? order5.indexOf(a) : a.startsWith('other') ? 1e9 : 10) - (order5.includes(b) ? order5.indexOf(b) : b.startsWith('other') ? 1e9 : 10)
      || grouped[b] - grouped[a]);
    // What the salary plan bought in stocks: the funds and each single stock.
    const bought5 = plan ? [
      ['VWRA (IBKR)', plan.parts.vwra], ['VWCE (Freedom)', plan.parts.vwce],
      ...plan.parts.usStocks.map(b => [`${b.ticker}${b.shares ? ` × ${b.shares}` : ''} (US single)`, b.usd]),
      ...plan.parts.ruStocks.map(b => [`${b.ticker}${b.shares ? ` × ${b.shares}` : ''} (Russia)`, b.usd]),
    ].filter(([, v]) => Math.abs(v) > 0.005) : [];
    tpie(slot5, TITLE5, labels5.map(l => ({
      label: l, usd: grouped[l],
      color: l === SINGLES ? '#1f8f3a' : l.startsWith('other') ? MP_OTHER_COLOR : countryColor(l) || mpSliceColor(l, () => null),
      target: l === SINGLES ? SINGLES_PCT : l === RU ? ruTargetUsd / stockWhole * 100
        : Math.max(0, restTargetPct) * (restNow ? grouped[l] / restNow : 0),
    })), '', stockWhole, true, null, bought5);
  }
  if (target7) drawRuTarget('8. Russian infrastructure', ruAll, target7, ruTargetTotal);
  else pie(grid, '8. Russian infrastructure', ruAll, '', ruOrder, false, () => 0, ruColor);
  // 8: stocks at the US ERP tab's target share; bonds, deposits and liquid
  // assets share the rest in today's proportions.
  if (target8) {
    const labels = Object.keys(types8).sort((a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b));
    tpie(grid, '9. Stocks, bonds, deposits, liquid assets', labels.map(l => ({
      label: l, usd: types8[l], color: typeColor(l) || MP_OTHER_COLOR, target: target8[l] / targetTotal8 * 100,
    })), '', targetTotal8, true);
  } else {
    pie(grid, '9. Stocks, bonds, deposits, liquid assets', types8, '', typeOrder, true, () => 0, typeColor);
  }
  // 9: target -- Freedom 20% of the two, IBKR the rest.
  const FREEDOM_TARGET_PCT = FREEDOM_SHARE * 100;
  tpie(grid, '10. IBKR vs Freedom', [
    { label: brokerName('Freedom24'), usd: byBroker.Freedom24 || 0, target: FREEDOM_TARGET_PCT, color: MP_COLORS.broker.Freedom24 },
    { label: brokerName('IBKR'), usd: byBroker.IBKR || 0, target: 100 - FREEDOM_TARGET_PCT, color: MP_COLORS.broker.IBKR },
  ]);
  // 10: target -- Russian infrastructure RU_TARGET_PCT of everything (no real estate).
  // Russia's target is 5% of everything (above it, the plan simply adds nothing there)
  const ruShare10 = RU_TARGET_PCT;
  tpie(grid, '11. Russian infrastructure vs the rest', [
    { label: 'Russia 🇷🇺', usd: ruTotal, target: ruShare10, color: MP_COLORS.country.RU },
    { label: 'rest of the world 🌍', usd: allTotal - ruTotal, target: 100 - ruShare10, color: '#4a9ff5' },
  ]);
  // 11 takes chart 7's dollar targets for everything but stocks, against
  // chart 7's target minus its stocks; only without chart 7's inputs does
  // it fall back to its own w_CNY split of today's total.
  // Chart 12 splits its own total: yuan bonds at w_CNY (USD/RUB -> CNY
  // Weight) less yuan deposits, deposits stay, liquid assets 0, rouble bonds
  // the rest (target11).
  // Chart 12 = chart 8 without its stocks: the same targets x2..x5 (yuan
  // bonds p2 x s2, deposits as they are, liquid assets 0, rouble bonds the
  // rest), against s2 = s1 - x1 (chart 8's total less its stocks' target).
  if (target7) {
    const stockL = `${MP_RU_INFRA_LABELS.stock} ${MP_RU_INFRA_CURRENCIES.RUB}`;
    const { [stockL]: x1, ...x2to5 } = target7;
    drawRuTarget('12. Russian infrastructure without stocks', ruNoStocks, x2to5, ruTargetTotal - x1);
  } else if (target11) drawRuTarget('12. Russian infrastructure without stocks', ruNoStocks, target11);
  else pie(grid, '12. Russian infrastructure without stocks', ruNoStocks, '', ruOrder, false, () => 0, ruColor);
  pie(grid, '13. Asset types with real estate', typesWithRealEstate, '', typeOrder, true, () => 0, typeColor);
  // What the salary plan (mpSalaryPlan / mpSalaryDeltas) works from.
  const valueByTicker = {}, priceUsdByTicker = {};
  for (const r of base.data) {
    if (r.value_usd) valueByTicker[r.ticker] = (valueByTicker[r.ticker] || 0) + r.value_usd;
    if (r.price_usd) priceUsdByTicker[r.ticker] = r.price_usd;
  }
  // the bonds' names for the salary plan (MOEX's, cached in this browser)
  let bondNames = {};
  try { bondNames = await mpBondNames(baseIn.data.filter(r => ['moex_bond', 'moex_ofz'].includes(r.asset_class)).map(r => r.ticker)); } catch { /* ISINs then */ }
  const brokerFunds = Object.values(MP_RU_BROKER_FUNDS).flatMap(byCcy => Object.values(byCcy).flat());
  const missingPrices = [...US_STOCK_TICKERS, ...RU_STOCK_TICKERS, ...brokerFunds].filter(t => !(t in priceUsdByTicker));
  if (missingPrices.length) {
    const { data: extra } = await sb.from('market_prices').select('ticker, price_usd').in('ticker', missingPrices);
    for (const r of extra || []) if (r.price_usd) priceUsdByTicker[r.ticker] = r.price_usd;
  }
  // The cash on the brokerage accounts outside Russia, and the liquidity
  // funds outside Russia above chart 3's liquid-assets target (the emergency
  // fund's part of them out) -- the salary plan's "spend liquidity funds".
  const cashFreeRows = baseIn.cashRows.filter(r => r.instrument_type === 'cash' && r.value_usd > 0 && MP_FOREIGN_BROKERS.has(r.account));
  const cashFree = cashFreeRows.reduce((a, r) => a + r.value_usd, 0);
  const liquidTarget = group3 ? group3[MP_ASSET_CLASS_LABELS.liquid] || 0 : null;
  const liquidRows = withCushion.filter(r => r.instrument_type === 'liquid' && r.value_usd > 0);
  // (Revolut's funds only -- not an exchange's dollars -- the euro one first,
  // then the others largest first)
  const liquidFreeRows = liquidRows.filter(r => r.account === 'Revolut')
    .sort((a, b) => ((b.underlying_currency || b.currency) === 'EUR') - ((a.underlying_currency || a.currency) === 'EUR') || b.value_usd - a.value_usd);
  const liquidFree = liquidTarget === null ? 0 : Math.max(0, Math.min(liquidFreeRows.reduce((a, r) => a + r.value_usd, 0),
    liquidRows.reduce((a, r) => a + r.value_usd, 0) - liquidTarget));
  const ctx = {
    total: allTotal, gold: types[MP_ASSET_CLASS_LABELS.gold] || 0, crypto: types[MP_ASSET_CLASS_LABELS.crypto] || 0,
    ruTotal, ruCells: ruAll, wCny, ruAlloc: alloc, usAlloc,
    ruInfraTotal: Object.values(ruAll).reduce((a, v) => a + v, 0),
    // the liquid assets themselves (the charts' cells fold small cash into them)
    ruLiquidRaw: Math.max(0, ruCells['liquid RUB'] || 0) + Math.max(0, ruCells['liquid CNY'] || 0),
    stockAll: types8[MP_ASSET_CLASS_LABELS.stock] || 0, groupAll: total8,   // chart 8: the whole portfolio
    ibkr: byBroker.IBKR || 0, freedom: byBroker.Freedom24 || 0, coins: crypto,
    valueByTicker, priceUsdByTicker, holdings: baseIn.data, before: recorded,
    cash: types[MP_ASSET_CLASS_LABELS.cash] || 0, cashRows: baseIn.cashRows,
    // the salary plan's "spend cash" / "spend liquidity funds" (see mpSalaryPlan)
    cashFree, cashFreeRows, liquidFree, liquidFreeRows, liquidTarget,
    // each Russian brokerage account's cash, by currency (the salary plan's step 8)
    ruBrokerCashRows: baseIn.cashRows.filter(r => r.instrument_type === 'cash' && r.broker_usd > 0 && mpIsRuInfra(r))
      .map(r => ({ account: r.account, currency: r.currency, usd: r.broker_usd })),
    fx: baseIn.fxByCurrency, bondNames,
    total3,   // chart 3's total (gold / crypto 5% are of it)
  };
  if (!draw) return ctx;

  // Size every plot to its card once the grid has laid out.
  requestAnimationFrame(() => grid.querySelectorAll('.pie-plot').forEach(el => { if (el.data) Plotly.Plots.resize(el); }));
}

// Funds whose cash part (fund_holdings' 'OTHER' line: money, reverse repo,
// liabilities) counts as liquid assets in the broker x asset-class table,
// the rest as the fund's own class -- TRND keeps ~11% in repo.
const MP_SPLIT_CASH_FUNDS = new Set(['TRND']);
async function mpSplitFundsCash(rows) {
  if (!rows.some(r => MP_SPLIT_CASH_FUNDS.has(r.ticker))) return rows;
  const { data, error } = await sb.from('fund_holdings').select('fund, weight')
    .in('fund', [...MP_SPLIT_CASH_FUNDS]).eq('security_id', 'OTHER');
  if (error || !data?.length) return rows;
  const cashPct = Object.fromEntries(data.map(d => [d.fund, Number(d.weight)]));
  return rows.flatMap(r => {
    const pct = MP_SPLIT_CASH_FUNDS.has(r.ticker) && r.value_usd !== null ? cashPct[r.ticker] : undefined;
    if (!pct) return [r];
    return [
      { ...r, value_usd: r.value_usd * (100 - pct) / 100 },
      { ...r, instrument_type: 'liquid', value_usd: r.value_usd * pct / 100 },
    ];
  });
}

// Look-through (portfolio_look_through_* views): the top securities by real
// exposure, and the whole exposure by sector, country and currency.
async function mpRenderLookThrough() {
  const wrap = document.getElementById('mp_lookthrough_wrap');
  const [top, bySector, byCountry, byCurrency] = await Promise.all([
    sb.from('portfolio_look_through_totals').select('*').order('value_usd', { ascending: false }).limit(150),
    sb.from('portfolio_look_through_by_sector').select('*').order('value_usd', { ascending: false }),
    sb.from('portfolio_look_through_by_country').select('*').order('value_usd', { ascending: false }),
    sb.from('portfolio_look_through_by_currency').select('*').order('value_usd', { ascending: false }),
  ]);
  const err = top.error || bySector.error || byCountry.error || byCurrency.error;
  if (err) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(err.message)}</p>`; return; }
  if (!top.data.length) { wrap.innerHTML = '<p class="empty-note">No fund holdings loaded yet.</p>'; return; }
  // One company's share classes as one row (Alphabet's GOOGL and GOOG): rows of the same name,
  // the money summed, the funds' parts too; the ticker the bigger one's. On by default, remembered.
  let mergeClasses = true;
  try { mergeClasses = localStorage.getItem('mp_lt_merge_classes') !== '0'; } catch { /* no storage */ }
  // the country as a flag (its name on hover): the securities' codes
  const flagOf = {};
  const secIds = [...new Set(top.data.map(r => r.security_id).filter(Boolean))];
  if (secIds.length) {
    const { data: codes } = await sb.from('securities').select('id, country_code').in('id', secIds);
    for (const c of codes || []) {
      const cc = String(c.country_code || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(cc) && cc !== 'XX') flagOf[c.id] = String.fromCodePoint(...[...cc].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
    }
  }
  let rows = top.data.map(r => ({ ...r, tickers: r.ticker ? [r.ticker] : [] }));
  if (mergeClasses) {
    const byName = new Map();
    for (const r of rows) {
      // one company: Alphabet's classes by name; France's loyalty shares ("L'OREAL SA - PF - 2028") its ordinary ones
      const key = String(r.name || r.ticker || '').trim().toLowerCase().replace(/\s-\spf\s-\s\d{4}$/, '').replace(/\s+eur[\d.]+.*$/, '')
        .replace(/\s*\(.*$/, '').replace(/\s+(sa|se|nv|ag|plc)$/, '').replace(/^rio tinto ltd$/, 'rio tinto');   // Rio Tinto plc and Ltd: one group
      const m = byName.get(key);
      if (!key || !m) { byName.set(key || `#${byName.size}`, r); continue; }
      m.value_usd = Number(m.value_usd) + Number(r.value_usd);
      m.direct_usd = Number(m.direct_usd || 0) + Number(r.direct_usd || 0);
      const via = { ...(m.via || {}) };
      for (const [k, v] of Object.entries(r.via || {})) via[k] = Number(via[k] || 0) + Number(v);
      m.via = via;
      m.tickers.push(...r.tickers);
    }
    rows = [...byName.values()].sort((a, b) => Number(b.value_usd) - Number(a.value_usd));
  }
  rows = rows.slice(0, 100);
  const total = bySector.data.reduce((s, r) => s + Number(r.value_usd), 0);
  const pct = v => `${(Number(v) / total * 100).toFixed(2)}%`;
  const via = r => Object.entries(r.via || {}).filter(([k]) => k !== 'direct')
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${mpEscapeHtml(k)} ${mpFormatUsd(Number(v))}`).join(', ');
  const small = (title, rows, key) => `<table class="data-table"><thead><tr>
      <th>${title}</th><th>Value (USD)</th><th>Share</th></tr></thead><tbody>${rows.map(r => `<tr>
      <td class="ticker">${mpEscapeHtml(r[key])}</td><td>${mpFormatUsd(Number(r.value_usd))}</td><td>${pct(r.value_usd)}</td></tr>`).join('')}
    <tr class="total-row"><td><b>Total</b></td><td><b>${mpFormatUsd(total)}</b></td><td></td></tr></tbody></table>`;
  wrap.innerHTML = `<label class="note" style="display:inline-block;margin-bottom:6px" title="One company's share classes (Alphabet's GOOGL and GOOG) as one row"><input type="checkbox" id="mp_lt_merge_classes"${mergeClasses ? ' checked' : ''}> merge share classes of one company</label>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr>
      <th>#</th><th>Security</th><th>Sector</th><th>Country</th><th>Currency</th><th>Value (USD)</th><th>Share</th><th>Direct</th><th>Via funds</th>
    </tr></thead><tbody>${rows.map((r, i) => `<tr${r.tickers.length ? ` data-ticker="${mpEscapeHtml(r.tickers[0])}" data-also="${mpEscapeHtml(r.tickers.slice(1).join(','))}" data-name="${mpEscapeHtml(r.name || r.tickers[0])}" style="cursor:pointer" title="Price chart"` : ''}>
      <td>${i + 1}</td>
      <td class="ticker">${mpEscapeHtml(r.name)}${r.tickers.some(t => !mpCodeLike(t)) ? ` <span class="note">${mpEscapeHtml(r.tickers.filter(t => !mpCodeLike(t)).join(' + '))}</span>` : ''}</td>
      <td>${mpEscapeHtml(r.sector || '')}</td><td${flagOf[r.security_id] ? ` title="${mpEscapeHtml(r.country || '')}" style="text-align:center;font-size:1.2em"` : ''}>${flagOf[r.security_id] || mpEscapeHtml(r.country || '')}</td><td>${mpEscapeHtml(r.currency || '')}</td>
      <td>${mpFormatUsd(Number(r.value_usd))}</td><td>${pct(r.value_usd)}</td>
      <td>${r.direct_usd ? mpFormatUsd(Number(r.direct_usd)) : ''}</td><td>${via(r)}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="note">Top 100 securities of the look-through total ${mpFormatUsd(total)}.</p>
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1 1 320px;overflow-x:auto">${small('Sector', bySector.data, 'sector')}</div>
      <div style="flex:1 1 320px;overflow-x:auto">${small('Country', byCountry.data, 'country')}</div>
      <div style="flex:1 1 240px;overflow-x:auto">${small('Currency', byCurrency.data, 'currency')}</div>
    </div>`;
  // a security's row: its price chart (a constituent without a price history of its own says so)
  wrap.onclick = ev => {
    const tr = ev.target.closest('tr[data-ticker]');
    if (tr) mpOpenPriceDialog(tr.dataset.ticker, tr.dataset.name, { also: tr.dataset.also ? tr.dataset.also.split(',') : [] });
  };
  document.getElementById('mp_lt_merge_classes').onchange = e => {
    mpSave('mp_lt_merge_classes', e.target.checked ? '1' : '0');
    mpRenderLookThrough();
  };
}

// What sits in Russian infrastructure -- Russian banks and brokers (and
// MOEX securities with no account recorded) -- by asset type, in roubles
// or yuan (CNY-denominated MOEX funds and bonds, yuan accounts). Other
// currencies there (T-Bank's few dollars / euros) and credit-card debt are
// left out. TRND's repo counts as liquid assets (mpSplitFundsCash).
// MP_RU_ACCOUNTS: js/lookthrough_treemap.js (one copy), set on window by the module script below.
const MP_RU_INFRA_TYPES = ['stock', 'deposit', 'bond', 'liquid', 'cash'];
// A Russian brokerage account's funds for its cash where it holds none of
// that currency yet (the salary plan's step 8), in the order to try: Alfa's
// own -- AKGP (Управляемые валютные облигации), else AKMC (Денежный рынок
// Юани), both counted as yuan (30.10.2026). Priced daily by
// update-market-prices (TARGET_UNIVERSE_TICKERS).
const MP_RU_BROKER_FUNDS = { Alfa: { CNY: ['AKGP', 'AKMC'] } };
const MP_RU_INFRA_LABELS = { stock: 'stock 📈', deposit: 'deposit 🏦', bond: 'bonds 🏛️', liquid: 'liquid assets 💧', cash: 'cash 💵' };
const MP_RU_INFRA_CURRENCIES = { RUB: '🇷🇺', CNY: '🇨🇳' };
async function mpRenderBondByType() {
  const wrap = document.getElementById('mp_bond_subtype_wrap');
  const { data, error } = await mpOnce('portfolio_value_usd_by_account', () => sb.from('portfolio_value_usd_by_account').select('*'));
  if (error) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(error.message)}</p>`; return; }
  const fx = await mpFetchFxByCurrency(['USD', 'RUB', 'CNY']);
  const cashRows = (await mpFetchCashRows(fx)).filter(r => r.instrument_type === 'cash');
  const rows = [...await mpSplitFundsCash(data), ...cashRows].filter(r =>
    MP_RU_ACCOUNTS.has(r.account) || (r.account === '(unspecified)' && r.infra_region === 'ru'));
  // asset type (rows) x currency (columns, in that currency) + share (of the USD-converted total).
  const ccys = Object.keys(MP_RU_INFRA_CURRENCIES);
  const usd = {};
  for (const r of rows) {
    const ccy = r.underlying_currency || r.currency;
    if (!MP_RU_INFRA_TYPES.includes(r.instrument_type) || !ccys.includes(ccy) || !r.value_usd) continue;
    usd[`${r.instrument_type} ${ccy}`] = (usd[`${r.instrument_type} ${ccy}`] || 0) + r.value_usd;
  }
  const types = MP_RU_INFRA_TYPES.filter(t => ccys.some(c => usd[`${t} ${c}`]));
  if (!types.length) { wrap.innerHTML = '<p class="empty-note">Nothing in Russian banks or brokers.</p>'; return; }
  const cols = ccys.filter(c => types.some(t => usd[`${t} ${c}`]));
  const rowUsd = t => cols.reduce((sum, c) => sum + (usd[`${t} ${c}`] || 0), 0);
  const colUsd = c => types.reduce((sum, t) => sum + (usd[`${t} ${c}`] || 0), 0);
  const total = types.reduce((sum, t) => sum + rowUsd(t), 0);
  const native = (v, c) => mpFormatCurrency(v / fx[c], c);
  const pct = v => `${(v / total * 100).toFixed(1)}%`;
  wrap.innerHTML = `<table class="data-table" style="width:auto;min-width:0">
    <thead><tr><th class="corner"></th>${cols.map(c => `<th>${c} ${MP_RU_INFRA_CURRENCIES[c]}</th>`).join('')}
      <th class="corner">Share</th></tr></thead>
    <tbody>${types.map(t => `<tr><td class="ticker">${MP_RU_INFRA_LABELS[t]}</td>
      ${cols.map(c => `<td>${native(usd[`${t} ${c}`] || 0, c)}</td>`).join('')}
      <td>${pct(rowUsd(t))}</td></tr>`).join('')}
    <tr class="total-row"><td class="ticker"><b>Total</b></td>
      ${cols.map(c => `<td><b>${native(colUsd(c), c)}</b></td>`).join('')}
      <td></td></tr>
    <tr class="total-row"><td class="ticker"><b>Total (%)</b></td>
      ${cols.map(c => `<td><b>${pct(colUsd(c))}</b></td>`).join('')}
      <td><b>100%</b></td></tr></tbody></table>`;
}

