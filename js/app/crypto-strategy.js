// The Crypto strategy tab: the crypto share's target by BTC's AHR999 and the
// deals made against it.

// ---- Crypto strategy (05.11.2026): the crypto share's target by BTC's
// AHR999 (crypto_indicators, migration 172). Monthly, after the salary:
//   red (< 0.45): buy 1% of the portfolio, up to 5%;
//   neutral after red: the same until 5%, then keep 5% with new money;
//   green (> 1.2): sell 1% of the portfolio at a share of 1-10%, 2% at
//     10-20%, 3% at 20% and more; not below 1%;
//   neutral after green: nothing -- not bought, not topped up -- until red.
// It's the whole crypto's share (BTC moves the rest with it). ----
const MP_AHR = { red: 0.45, green: 1.2, target: 5, floor: 1 };
let mpCryptoInd = null;   // [{ day, btc, dca, fair, ahr }], oldest first
// The crypto bought and sold (wallet_transactions: the exchanges' and
// wallets' trades), oldest first: a buy is crypto got for money -- a
// stablecoin, fiat -- in one trade, a sale the other way round. Not a deal:
// crypto for crypto, and gold tokens (XAUT, PAXG: gold) or stablecoins
// (dollars) bought -- the money sent to crypto services (expenses 'Crypto')
// was no measure: September 2025's €300 bought XAUT. A month's step is one
// buy or one sale. [{ day, usd }] each, a day's deals summed.
const MP_NOT_CRYPTO = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'FDUSD', 'BUSD', 'TUSD', 'USDE', 'PYUSD', 'USD', 'EUR', 'GBP', 'XAUT', 'PAXG']);
const MP_MONEY = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'FDUSD', 'BUSD', 'TUSD', 'USDE', 'PYUSD', 'USD', 'EUR', 'GBP']);
// a deal under 0.1% of the portfolio that day is dust, not a deal
const MP_CRYPTO_DUST_PCT = 0.1;
let mpCryptoBuys = [], mpCryptoSells = [], mpCryptoDealsLoaded = false;
let mpCryptoBuyDays = [], mpCryptoSellDays = [];
async function mpLoadCryptoDeals() {
  const { rows, error } = await mpFetchAllRows(() => sb.from('wallet_transactions').select('wallet_id, tx_time, kind, symbol, amount')
    .in('kind', ['trade', 'purchase', 'convert', 'trade_out_unknown', 'native', 'token', 'deposit', 'withdrawal'])
    .eq('estimated', false).order('tx_time'));
  if (error) return false;
  const { data: eur } = await sb.from('fx_history').select('day, usd_per_unit').eq('currency', 'EUR').order('day', { ascending: false }).limit(1);
  const eurUsd = Number(eur?.[0]?.usd_per_unit) || 1.1;
  // one trade: its legs at the same moment in the same wallet
  const isTrade = r => ['trade', 'purchase', 'convert', 'trade_out_unknown'].includes(r.kind);
  const deals = new Map();
  for (const r of rows.filter(isTrade)) {
    const k = `${r.wallet_id}|${r.tx_time}`;
    deals.set(k, [...(deals.get(k) || []), r]);
  }
  // Coins arriving from outside: bought with a card through Mercuryo and the
  // like straight into a wallet (ETH 03.02.2026, 06.06.2026). Not one: what
  // left another of one's wallets / exchanges within 6 hours (a transfer), or
  // what the same transaction swapped for (ETH -> stETH).
  const moves = rows.filter(r => !isTrade(r));
  const isCoin = r => !MP_NOT_CRYPTO.has(String(r.symbol).toUpperCase());
  const at = r => Date.parse(r.tx_time);
  const external = moves.filter(r => isCoin(r) && Number(r.amount) > 0
    && !moves.some(o => o.wallet_id === r.wallet_id && o.tx_time === r.tx_time && Number(o.amount) < 0 && o.kind !== 'fee')
    && !moves.some(o => o.wallet_id !== r.wallet_id && String(o.symbol).toUpperCase() === String(r.symbol).toUpperCase()
      && Number(o.amount) < 0 && Math.abs(at(o) - at(r)) < 6 * 3600_000 && Math.abs(Number(o.amount)) >= Number(r.amount) * 0.95));
  // a day's deals: money amounts, or a card purchase's coin to price
  const buys = new Map(), sells = new Map();
  const add = (m, day, part) => m.set(day, [...(m.get(day) || []), part]);
  for (const legs of deals.values()) {
    const day = String(legs[0].tx_time).slice(0, 10);
    const coin = legs.filter(l => !MP_NOT_CRYPTO.has(String(l.symbol).toUpperCase()) && Number(l.amount) !== 0);
    const money = legs.filter(l => MP_MONEY.has(String(l.symbol).toUpperCase()) && Number(l.amount) !== 0);
    if (coin.length !== 1) continue;   // crypto for crypto, or no crypto
    const c = coin[0], amt = Number(c.amount);
    // a coin bought with a card on the exchange: the trade has no other leg (Crypto.com)
    if (legs.length === 1 && amt > 0) { add(buys, day, { coin: c.symbol, qty: amt }); continue; }
    if (money.length) {
      const usd = money.reduce((t, l) => t + Math.abs(Number(l.amount)) * (String(l.symbol).toUpperCase() === 'EUR' ? eurUsd : 1), 0);
      add(amt > 0 ? buys : sells, day, usd);
    // a card purchase, or a Telegram trade whose spent side the wallet's export
    // doesn't give (trade_out_unknown, amount 0): priced at the coin's close
    } else if (amt > 0 && (c.kind === 'purchase' || legs.some(l => l.kind === 'trade_out_unknown'))) add(buys, day, { coin: c.symbol, qty: amt });
  }
  for (const r of external) add(buys, String(r.tx_time).slice(0, 10), { coin: String(r.symbol).toUpperCase(), qty: Number(r.amount) });
  // a card purchase has no money leg: the coin's close that day (price_history)
  const value = async (day, x) => {
    if (typeof x === 'number') return x;
    const { data } = await sb.from('price_history').select('price_usd').eq('ticker', x.coin).lte('day', day).order('day', { ascending: false }).limit(1);
    return x.qty * (Number(data?.[0]?.price_usd) || 0);
  };
  const list = async m => (await Promise.all([...m].map(async ([day, parts]) =>
    ({ day, usd: (await Promise.all(parts.map(x => value(day, x)))).reduce((t, v) => t + v, 0) })))).sort((a, b) => a.day.localeCompare(b.day));
  // a day's buys and sales net out: CRO sold for $215 and BTC bought for $217
  // the same day (27.11.2025) is a swap, not two deals -- within 10% of the
  // day's turnover nothing, else the difference on its side
  const b = await list(buys), sl = await list(sells);
  const net = new Map();
  for (const x of b) net.set(x.day, { buy: x.usd, sell: 0 });
  for (const x of sl) net.set(x.day, { ...(net.get(x.day) || { buy: 0 }), sell: x.usd });
  // the portfolio on each day (capital_daily_total), for the dust threshold
  const first = [...net.keys()].sort()[0];
  const caps = first ? (await mpFetchAllRows(() => sb.from('capital_daily_total').select('day, capital_usd').gte('day', first).order('day'))).rows : [];
  const capOn = day => { let v = 0; for (const c of caps) { if (c.day > day) break; v = Number(c.capital_usd); } return v; };
  mpCryptoBuys = []; mpCryptoSells = [];
  for (const [day, { buy, sell }] of [...net].sort((p, q) => p[0].localeCompare(q[0]))) {
    const d = buy - sell;
    if (Math.abs(d) <= 0.1 * (buy + sell)) continue;
    // under 0.1% of the portfolio: dust (a few euros of TAO, a fee's change), not a deal
    if (Math.abs(d) < MP_CRYPTO_DUST_PCT / 100 * capOn(day)) continue;
    (d > 0 ? mpCryptoBuys : mpCryptoSells).push({ day, usd: Math.abs(d) });
  }
  mpCryptoBuyDays = mpCryptoBuys.map(b => b.day);
  mpCryptoSellDays = mpCryptoSells.map(b => b.day);
  return true;
}
async function mpLoadCryptoIndicators() {
  // the deals once signed in (the indicators are public, the deals aren't)
  if (mpIsSignedIn && !mpCryptoDealsLoaded) mpCryptoDealsLoaded = await mpLoadCryptoDeals().catch(() => false);
  if (mpCryptoInd?.length) return mpCryptoInd;   // an empty answer isn't kept: the table may fill later
  const { rows: out, error } = await mpFetchAllRows(() => sb.from('crypto_indicators').select('day, btc_usd, dca200, fair_usd, ahr999').order('day'));
  if (error) return [];   // no table yet: the plain 5%
  // the daily refits (crypto_fair_fit): one a day, each fitted on the prices before its day;
  // none yet or no table -- the constants below
  const { rows: fits } = await mpFetchAllRows(() => sb.from('crypto_fair_fit').select('day, slope, intercept, red_threshold, days_fitted').order('day'));
  mpFairFits = fits.map(f => ({ day: f.day, slope: Number(f.slope), icpt: Number(f.intercept) }));
  const fit = fits[fits.length - 1];
  if (fit) {
    Object.assign(MP_FAIR_REFIT, { slope: Number(fit.slope), icpt: Number(fit.intercept), day: fit.day, days: fit.days_fitted });
    if (fit.red_threshold != null) MP_AHR_ZONES.refit.red = Number(fit.red_threshold);
  }
  mpShowFairRefit();
  mpCryptoIndRaw = out.map(r => ({ day: r.day, btc: Number(r.btc_usd), dca: Number(r.dca200), fair: Number(r.fair_usd), ahr: Number(r.ahr999) }));
  mpCryptoInd = mpCryptoWithFair(mpCryptoIndRaw);
  return mpCryptoInd;
}
// The fair price refitted on BTC's whole life (the user, 18.11.2026): AHR999's own
// 5.84 / -17.01 were fitted by its author long ago; a least-squares line of
// log10(price) on log10(days since 03.01.2009) over every day from 18.07.2010
// (the first price) to 17.11.2026 -- 5967 days, CoinMetrics' PriceUSD -- gives
// these (R^2 0.962; today's fair $146k against $185k). The "refit" box (on by
// default) swaps the fair price and, with it, AHR999 everywhere on the page --
// the zones, the plan, the backtest; off -- the stored values, as CoinGlass's.
// Refitted every morning since (update-crypto-indicators -> crypto_fair_fit):
// the latest row replaces these, the whole history on its coefficients.
const MP_FAIR_REFIT = { slope: 5.633, icpt: -16.3235, day: '2026-11-18', days: 5967 };
function mpShowFairRefit() {
  const el = document.getElementById('cs_fair_refit_coef');
  if (el) el.textContent = `${MP_FAIR_REFIT.slope.toFixed(3)} / ${MP_FAIR_REFIT.icpt.toFixed(2)}, красная < ${MP_AHR_ZONES.refit.red.toFixed(3)}; подгонка ${MP_FAIR_REFIT.day} по ${MP_FAIR_REFIT.days} дням`;
}
const MP_GENESIS = Date.parse('2009-01-03T00:00:00Z');
let mpCryptoIndRaw = null;
// a: the latest coefficients for every day; b: each day its own, fitted on the prices
// before it (the user's choice, 18.11.2026 -- an honest backtest); the red threshold is
// the latest in both
let mpFairFits = [];
function mpFairMode() {
  try { return localStorage.getItem('mp_fair_mode') === 'a' ? 'a' : 'b'; } catch { return 'b'; }
}
function mpFairRefitOn() {
  try { return localStorage.getItem('mp_fair_refit') !== '0'; } catch { return true; }
}
// the zones' thresholds go with the fair price (the user, 18.11.2026): the refit index runs
// ~1.2-1.27x higher, and 0.45 left it in the red on 10.5% of the days since 2015 instead of
// 15.3% (September 2023's red was gone); 0.516 is the level with the same share of days as AHR999's own on its own
// formula (crypto_indicators, 2015-04-05..2026-11-18) -- the red one only: the green stays at
// 1.2, the wider green zones of the refit index (summer-autumn 2025, May-June 2024) suit the user
const MP_AHR_ZONES = { own: { red: 0.45, green: 1.2 }, refit: { red: 0.516, green: 1.2 } };
function mpApplyAhrZones() { Object.assign(MP_AHR, MP_AHR_ZONES[mpFairRefitOn() ? 'refit' : 'own']); }
// The zones' thresholds (the user, 18.11.2026), each day's on its row (r.red, r.green):
//   orig  -- AHR999's own, 0.45 / 1.2;
//   cur   -- 0.45 / 1.2, or with the whole-history fair price the red one moved to the
//            same share of red days (crypto_fair_fit's red_threshold), the green 1.2;
//   ter_a -- thirds: a third of the days red, a third neutral, a third green -- the index's
//            1/3 and 2/3 quantiles over every day there is (from 2015-04, crypto_indicators);
//   ter_b -- the same thirds on each day over the days before it only (as one would have
//            seen it then); its first year, under 365 days to count -- 0.45 / 1.2;
//   qrt_a / qrt_b -- quarters (the user, 18.11.2026): the red below the lowest quarter, the
//            green above the highest, so a quarter of the days each; the neutral half splits
//            by itself into after-red / after-green, ~27.5% / 22.5% (index b, from 2015-04).
function mpZoneMode() {
  try { const v = localStorage.getItem('mp_zone_mode'); return ['orig', 'cur', 'ter_a', 'ter_b', 'qrt_a', 'qrt_b', 'mix'].includes(v) ? v : 'mix'; } catch { return 'mix'; }
}
function mpQuantile(sorted, q) {
  const pos = q * (sorted.length - 1), lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}
//   mix   -- each day's thresholds the median of the honest ones -- orig, cur, ter_b,
//            qrt_b (the _a ones know the future): of four, the mean of the middle two
//            (the user, 18.11.2026: quarters missed the sale at $110k, thirds bought too
//            much in 2026, the original missed August 2023)
function mpWithZones(rows, mode = mpZoneMode()) {
  if (mode === 'mix') {
    const sets = ['orig', 'cur', 'ter_b', 'qrt_b'].map(m => mpWithZones(rows, m));
    const med = vs => { const s = [...vs].sort((a, b) => a - b); return (s[1] + s[2]) / 2; };
    return rows.map((r, i) => ({ ...r, red: med(sets.map(z => z[i].red)), green: med(sets.map(z => z[i].green)) }));
  }
  if (mode === 'orig') return rows.map(r => ({ ...r, red: 0.45, green: 1.2 }));
  if (mode === 'cur') return rows.map(r => ({ ...r, red: MP_AHR.red, green: MP_AHR.green }));
  const [qLo, qHi] = mode.startsWith('qrt') ? [1 / 4, 3 / 4] : [1 / 3, 2 / 3];
  if (mode.endsWith('_a')) {
    const s = rows.map(r => r.ahr).sort((a, b) => a - b);
    const red = mpQuantile(s, qLo), green = mpQuantile(s, qHi);
    return rows.map(r => ({ ...r, red, green }));
  }
  // _b: the days before, kept sorted as they come (a binary search and an insert a day)
  const s = [];
  return rows.map(r => {
    const out = s.length >= 365 ? { ...r, red: mpQuantile(s, qLo), green: mpQuantile(s, qHi) } : { ...r, red: 0.45, green: 1.2 };
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < r.ahr) lo = m + 1; else hi = m; }
    s.splice(lo, 0, r.ahr);
    return out;
  });
}
function mpCryptoWithFair(raw) {
  mpApplyAhrZones();
  if (!mpFairRefitOn()) return mpWithZones(raw);
  const perDay = mpFairMode() === 'b' && mpFairFits.length;
  let j = 0;
  return mpWithZones(raw.map(r => {
    const age = (Date.parse(r.day + 'T00:00:00Z') - MP_GENESIS) / 86400000;
    // b: that day's fit, or the last one before it (none before -- the first)
    while (perDay && j + 1 < mpFairFits.length && mpFairFits[j + 1].day <= r.day) j++;
    const c = perDay ? mpFairFits[j] : MP_FAIR_REFIT;
    const fair = 10 ** (c.slope * Math.log10(age) + c.icpt);
    return { ...r, fair, ahr: (r.btc / r.dca) * (r.btc / fair) };
  }));
}
// the zone of an index value -- on its row's thresholds when given (mpWithZones), else MP_AHR's
const mpAhrZone = (a, r) => (a < (r?.red ?? MP_AHR.red) ? 'red' : a > (r?.green ?? MP_AHR.green) ? 'green' : 'neutral');
const mpDaysBefore = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
// The strategy's target share on `day` for a share of `share` %, the zone that
// day and the last red / green before it; lastBuy / lastSell: the latest
// buy / sale before that day. A month's step is done once: after a buy the
// target rises back from the share to the share +1% over 30 days, linearly;
// a sale within the 30 days before keeps it at the share.
//   red, and neutral after red: +1% up to 5%, not below 1%; above 5% the share (nothing sold)
//   green: the share less 1% (1-10%), 2% (10-20%), 3% (20% and more), not below 1%;
//     never a buy, even under 1%
//   neutral after green: the share (nothing to do), but not below 1%
function mpCryptoTarget(day, share, zone, regime, lastBuy, lastSell) {
  const monthAgo = mpDaysBefore(day, 30);
  if (zone === 'green') {
    const step = share >= 20 ? 3 : share >= 10 ? 2 : 1;
    if (lastSell && lastSell > monthAgo) return { target: share, step, why: `зелёная зона: продажа этого месяца уже была (${lastSell})` };
    // never a buy in the green, even below 1%: at or under 1% the share stays
    if (share <= MP_AHR.floor) return { target: share, step, why: `зелёная зона: доля не выше ${MP_AHR.floor}% — не продавать и не покупать` };
    return { target: Math.max(MP_AHR.floor, share - step), step, why: `зелёная зона: продать ${step}% портфеля, не ниже ${MP_AHR.floor}%` };
  }
  if (zone === 'red' || regime !== 'green') {
    const head = zone === 'red' ? 'красная зона' : 'нейтральная после красной';
    if (share >= MP_AHR.target) return { target: share, step: 1, why: `${head}: доля уже не ниже ${MP_AHR.target}%, ничего не делать` };
    // after a buy the next 1% comes back gradually: from 0 on its day to the
    // whole 1% 30 days on
    if (lastBuy && lastBuy > monthAgo) {
      const part = (Date.parse(day + 'T00:00:00Z') - Date.parse(lastBuy + 'T00:00:00Z')) / 86400000 / 30;
      return { target: Math.max(MP_AHR.floor, Math.min(MP_AHR.target, share + part)), step: 1,
        why: `${head}: после покупки ${lastBuy} следующий шаг набирается — +${part.toFixed(2)} из 1 п.п.` };
    }
    return { target: Math.max(MP_AHR.floor, Math.min(MP_AHR.target, share + 1)), step: 1, why: `${head}: докупить на 1% портфеля, до ${MP_AHR.target}%` };
  }
  if (share < MP_AHR.floor) return { target: MP_AHR.floor, step: 0, why: `нейтральная после зелёной: доля ниже ${MP_AHR.floor}% — довести до ${MP_AHR.floor}%` };
  return { target: share, step: 0, why: 'нейтральная после зелёной: ничего не делать до красной зоны' };
}
const mpLastBefore = (days, day) => { let v = null; for (const d of days) { if (d >= day) break; v = d; } return v; };
// This month's move for a crypto share of `share` % (of chart 3's total):
// { day, ahr, zone, regime (the last red / green), target %, action, step, why } --
// null with no indicators (the plain 5% then).
function mpCryptoPlan(share, ind = mpCryptoInd) {
  if (!ind?.length) return null;
  const last = ind[ind.length - 1];
  const zone = mpAhrZone(last.ahr, last);
  let regime = null;
  for (let i = ind.length - 1; i >= 0 && !regime; i--) { const z = mpAhrZone(ind[i].ahr, ind[i]); if (z !== 'neutral') regime = z; }
  const today = new Date().toISOString().slice(0, 10);
  const t = mpCryptoTarget(today, share, zone, regime, mpLastBefore(mpCryptoBuyDays, today + 'z'), mpLastBefore(mpCryptoSellDays, today + 'z'));
  const action = t.target > share + 1e-9 ? 'buy' : t.target < share - 1e-9 ? 'sell' : 'hold';
  return { day: last.day, ahr: last.ahr, zone, regime, ...t, action };
}
const MP_ZONE_NAME = { red: '🔴 красная', green: '🟢 зелёная', neutral: '🟡 нейтральная' };
try { const v = localStorage.getItem('mp_cs_label'); if (v) document.getElementById('cs_label').value = v; } catch { /* no storage */ }
document.getElementById('cs_label').addEventListener('change', e => {
  mpSave('mp_cs_label', e.target.value);
  mpRenderCryptoStrategy();
});
// the fair price refitted on the whole history, or AHR999's own (MP_FAIR_REFIT)
document.getElementById('cs_fair_refit').checked = mpFairRefitOn();
document.getElementById('cs_fair_mode').value = mpFairMode();
document.getElementById('cs_zone_mode').value = mpZoneMode();
document.getElementById('cs_zone_mode').addEventListener('change', e => {
  mpSave('mp_zone_mode', e.target.value);
  if (mpCryptoIndRaw) mpCryptoInd = mpCryptoWithFair(mpCryptoIndRaw);
  mpRenderCryptoStrategy();
});
document.getElementById('cs_fair_mode').addEventListener('change', e => {
  mpSave('mp_fair_mode', e.target.value);
  if (mpCryptoIndRaw) mpCryptoInd = mpCryptoWithFair(mpCryptoIndRaw);
  mpRenderCryptoStrategy();
});
document.getElementById('cs_fair_refit').addEventListener('change', e => {
  mpSave('mp_fair_refit', e.target.checked ? '1' : '0');
  if (mpCryptoIndRaw) mpCryptoInd = mpCryptoWithFair(mpCryptoIndRaw);
  mpRenderCryptoStrategy();
});
async function mpRenderCryptoStrategy() {
  const status = document.getElementById('cs_status');
  status.textContent = 'Loading…';
  const ind = await mpLoadCryptoIndicators();
  if (!ind.length) { status.textContent = 'Нет данных AHR999 (update-crypto-indicators ещё не запускался).'; return; }
  // the crypto share by day (capital_daily_by_type: crypto of everything but real estate)
  // -- only from the move to Cyprus (life_periods), the chart's start: the whole
  // history, page after page, timed out half-way and the line was gone
  let shares = [], loadError = '';
  const { data: periods } = await sb.from('life_periods').select('start_day, place').order('start_day');
  const cyprus = (periods || []).find(p => /cyprus/i.test(p.place))?.start_day || '2025-01-01';
  if (mpIsSignedIn) {
    const { rows, error } = await mpFetchAllRows(() => sb.from('capital_daily_by_type').select('*').gte('day', cyprus).order('day'));
    if (error) loadError = error?.message || 'no data';
    shares = rows.map(r => {
      const total = Object.entries(r).filter(([k]) => /^(ru|fx)_/.test(k)).reduce((t, [, v]) => t + Number(v || 0), 0);
      return { day: r.day, total, pct: total > 0 ? (Number(r.ru_crypto || 0) + Number(r.fx_crypto || 0)) / total * 100 : 0 };
    });
  }
  status.textContent = loadError ? `Доля крипты не загрузилась: ${loadError}` : '';
  const share = shares.length ? shares[shares.length - 1].pct : null;
  const plan = share === null ? mpCryptoPlan(0) : mpCryptoPlan(share);
  const last = ind[ind.length - 1];
  const card = (label, value, sub = '') => `<div class="card-reminder faint" style="flex-direction:column;align-items:flex-start;gap:2px;min-width:150px">
    <span style="font-size:0.75rem">${label}</span><b style="font-size:1.15rem;color:#e6edf3">${value}</b>${sub ? `<span style="font-size:0.75rem">${sub}</span>` : ''}</div>`;
  const actionText = !plan || share === null ? '—'
    : plan.action === 'buy' ? `докупить до ${plan.target.toFixed(1)}%`
    : plan.action === 'sell' ? `продать до ${plan.target.toFixed(1)}%` : 'ничего не делать';
  document.getElementById('cs_cards').innerHTML = [
    card('AHR999', last.ahr.toFixed(3), last.day),
    card('Зона', MP_ZONE_NAME[plan.zone], plan.regime ? `последняя крайняя: ${MP_ZONE_NAME[plan.regime]}` : ''),
    card('BTC', mpFormatUsd(last.btc), `DCA 200: ${mpFormatUsd(last.dca)} · fair: ${mpFormatUsd(last.fair)}`),
    card('Доля крипты', share === null ? 'войдите' : `${share.toFixed(1)}%`, `цель стратегии: ${share === null ? '—' : plan.target.toFixed(1) + '%'}`),
    card('В этом месяце', actionText, plan.why),
  ].join('');
  // hover as on the other charts: anywhere over the day, one dark box for all lines
  const dark = { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#c9d1d9' }, margin: { t: 30, r: 20, b: 40, l: 60 },
    hovermode: 'x unified', hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } } };
  const days = ind.map(r => r.day);
  // zone bands as shapes: each run of red / green days
  const shapes = [];
  let runStart = null, runZone = null;
  ind.forEach((r, i) => {
    const z = mpAhrZone(r.ahr, r);
    if (z !== runZone) {
      if (runZone && runZone !== 'neutral') shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: runStart, x1: r.day, y0: 0, y1: 1,
        fillcolor: runZone === 'red' ? '#e05252' : '#3dd68c', opacity: 0.12, line: { width: 0 }, layer: 'below' });
      runStart = r.day; runZone = z;
    }
    if (i === ind.length - 1 && runZone !== 'neutral') shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: runStart, x1: r.day, y0: 0, y1: 1,
      fillcolor: runZone === 'red' ? '#e05252' : '#3dd68c', opacity: 0.12, line: { width: 0 }, layer: 'below' });
  });
  const hline = (y, color) => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1, dash: 'dash' } });
  // the thresholds as lines over the days: flat, or moving day by day (ter_b)
  const thr = (key, name, color) => ({ x: days, y: ind.map(r => r[key]), type: 'scatter', mode: 'lines', name,
    line: { color, width: 1, dash: 'dash', shape: 'hv' }, hovertemplate: '%{y:.3f}' });
  Plotly.newPlot('plot_cs_ahr', [{ x: days, y: ind.map(r => r.ahr), type: 'scatter', mode: 'lines', name: 'AHR999', line: { color: '#f5c542', width: 1.5 }, hovertemplate: '%{y:.3f}' },
    thr('red', 'порог красной', '#e05252'), thr('green', 'порог зелёной', '#3dd68c')],
    { ...dark, title: 'AHR999', yaxis: { type: 'log', gridcolor: '#1e2830' }, xaxis: { gridcolor: '#1e2830' }, showlegend: false,
      shapes }, { responsive: true, displaylogo: false });
  Plotly.newPlot('plot_cs_price', [
    { x: days, y: ind.map(r => r.btc), type: 'scatter', mode: 'lines', name: 'BTC', line: { color: '#58a6ff', width: 1.5 } },
    { x: days, y: ind.map(r => r.dca), type: 'scatter', mode: 'lines', name: 'DCA 200 дней', line: { color: '#8b949e', width: 1 } },
    { x: days, y: ind.map(r => r.fair), type: 'scatter', mode: 'lines', name: mpFairRefitOn() ? 'справедливая (по возрасту, вся история)' : 'справедливая (по возрасту, AHR999)', line: { color: '#f2452b', width: 1, dash: 'dot' } },
  ], { ...dark, title: 'BTC и его оценки, $', yaxis: { type: 'log', gridcolor: '#1e2830' }, xaxis: { gridcolor: '#1e2830' }, shapes,
    legend: { orientation: 'h', y: -0.15 } }, { responsive: true, displaylogo: false });
  if (shares.length) {
    // From the move to Cyprus (life_periods) -- the strategy's start: the
    // crypto at zero before its first buys there.
    // Buys ▲ and sales ▼ (mpLoadCryptoDeals: crypto for money and back),
    // a marker a day with its sum in euros.
    const buys = mpCryptoBuys, sells = mpCryptoSells;
    const { data: eur } = await sb.from('fx_history').select('day, usd_per_unit').eq('currency', 'EUR').gte('day', '2025-01-01').order('day');
    const start = shares[0].day;
    const shown = shares.filter(x => x.day >= start);
    // the share before a day: what the decision to buy was taken at
    const shareBefore = day => { let v = null; for (const x of shown) { if (x.day >= day) break; v = x.pct; } return v ?? shown[0]?.pct ?? 0; };
    const totalBefore = day => { let v = null; for (const x of shown) { if (x.day >= day) break; v = x.total; } return v ?? shown[0]?.total ?? 0; };
    const eurOn = day => { let v = null; for (const r of eur || []) { if (r.day > day) break; v = Number(r.usd_per_unit); } return v || 1.1; };
    // a marker a day of buys (▲) and of sales (▼), its sum in euros
    // deals within a week of the first of them make one marker (a buy every
    // couple of days in late October 2025 crowded the bottom), dated by that
    // first, its sum the week's; the days listed in its hover
    const toMarks = list => {
      const out = [];
      for (const b of list.filter(b => b.day >= start)) {
        const eur = b.usd / eurOn(b.day), last = out[out.length - 1];
        // what it moved the share by, in percentage points: its part of the
        // portfolio, less the crypto's own part (the money came out of the rest)
        const total = totalBefore(b.day), share = shareBefore(b.day);
        const pp = total > 0 ? b.usd / total * 100 * (1 - share / 100) : 0;
        if (last && b.day <= mpDaysBefore(last.day, -7)) { last.eur += eur; last.usd += b.usd; last.pp += pp; last.days.push(b.day.slice(5).split('-').reverse().join('.')); }
        else out.push({ day: b.day, eur, usd: b.usd, pp, days: [b.day.slice(5).split('-').reverse().join('.')] });
      }
      return out;
    };
    const marks = toMarks(buys), sellMarks = toMarks(sells);
    const inUsd = document.getElementById('cs_label').value === 'usd';
    const yMax = Math.max(MP_AHR.target, ...shown.map(x => x.pct)) * 1.12;
    // the red and green zones shaded (the neutral left blank)
    const zoneShapes = [];
    let zStart = null, zZone = null;
    const zoneColor = { red: '#e05252', green: '#3dd68c' };
    const span = ind.filter(r => r.day >= start);
    span.forEach((r, i) => {
      const z = mpAhrZone(r.ahr, r);
      const close = end => zZone !== 'neutral' && zoneShapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: zStart, x1: end, y0: 0, y1: 1,
        fillcolor: zoneColor[zZone], opacity: 0.15, line: { width: 0 }, layer: 'below' });
      if (z !== zZone) { if (zZone) close(r.day); zStart = r.day; zZone = z; }
      // the last zone runs on to the chart's last day: a day the indicator
      // isn't out for yet (today's, computed the next morning) keeps the last one
      if (i === span.length - 1) close(shown.length && shown[shown.length - 1].day > r.day ? shown[shown.length - 1].day : r.day);
    });
    // the strategy's target day by day (mpCryptoTarget, as the card has it)
    const ahrOn = new Map(ind.map(r => [r.day, r]));
    let regime = null;
    for (const r of ind) { if (r.day >= start) break; const z = mpAhrZone(r.ahr, r); if (z !== 'neutral') regime = z; }
    const targets = shown.map(x => {
      // (no value for the day yet -- today's: the last one there is)
      const a = ahrOn.get(x.day) ?? [...ind].reverse().find(r => r.day <= x.day);
      const z = a === undefined ? 'neutral' : mpAhrZone(a.ahr, a);
      if (z !== 'neutral') regime = z;
      return mpCryptoTarget(x.day, x.pct, z, regime, mpLastBefore(mpCryptoBuyDays, x.day), mpLastBefore(mpCryptoSellDays, x.day)).target;
    });
    Plotly.newPlot('plot_cs_share', [
      { x: shown.map(x => x.day), y: targets, type: 'scatter', mode: 'lines', name: 'цель стратегии', connectgaps: false, opacity: 0.45, line: { color: '#3dd68c', width: 3, shape: 'hv' },
        hovertemplate: '%{y:.2f}%' },
      { x: shown.map(x => x.day), y: shown.map(x => x.pct), type: 'scatter', mode: 'lines', name: 'доля крипты', line: { color: '#f5c542', width: 2 },
        hovertemplate: '%{y:.2f}%' },
      // along the bottom, each with a thin dotted line up to see the moment
      { x: marks.map(m => m.day), y: marks.map(() => 0.25), type: 'scatter', mode: 'markers', name: inUsd ? 'покупка, $' : 'покупка, сдвиг доли в п.п.',
        marker: { symbol: 'triangle-up', size: 12, color: '#58a6ff', line: { color: '#e6edf3', width: 1 } },
        text: marks.map(m => `+${m.pp.toFixed(2)} п.п. ($${Math.round(m.usd).toLocaleString('en-US')})`), textposition: 'top center', textfont: { color: '#58a6ff', size: 11 },
        customdata: marks.map(m => `${shareBefore(m.day).toFixed(1)}%${m.days.length > 1 ? ` (${m.days.join(', ')})` : ''}`),
        hovertemplate: '%{text} при доле %{customdata}' },
      { x: sellMarks.map(m => m.day), y: sellMarks.map(() => 0.25), type: 'scatter', mode: 'markers', name: inUsd ? 'продажа, $' : 'продажа, сдвиг доли в п.п.',
        marker: { symbol: 'triangle-down', size: 12, color: '#e05252', line: { color: '#e6edf3', width: 1 } },
        text: sellMarks.map(m => `−${m.pp.toFixed(2)} п.п. ($${Math.round(m.usd).toLocaleString('en-US')})`),
        customdata: sellMarks.map(m => `${shareBefore(m.day).toFixed(1)}%${m.days.length > 1 ? ` (${m.days.join(', ')})` : ''}`),
        hovertemplate: '%{text} при доле %{customdata}' },
    ], { ...dark, title: 'Доля крипты в портфеле, %', yaxis: { gridcolor: '#1e2830', ticksuffix: '%', range: [0, yMax], zeroline: true, zerolinecolor: '#8b949e' },
      xaxis: { gridcolor: '#1e2830' }, legend: { orientation: 'h', y: -0.15 },
      shapes: [...zoneShapes, hline(MP_AHR.target, '#8b949e'), hline(MP_AHR.floor, '#8b949e'),
        ...[[marks, '#58a6ff'], [sellMarks, '#e05252']].flatMap(([list, color]) =>
          list.map(m => ({ type: 'line', xref: 'x', yref: 'paper', x0: m.day, x1: m.day, y0: 0, y1: 1, line: { color, width: 1, dash: 'dot' }, opacity: 0.6 })))],
      annotations: [...[[MP_AHR.target, `цель ${MP_AHR.target}%`], [MP_AHR.floor, `минимум ${MP_AHR.floor}%`]].map(([y, text]) =>
        ({ xref: 'paper', x: 0, xanchor: 'left', y, yanchor: 'bottom', text, showarrow: false, font: { color: '#8b949e', size: 11 } })),
        // upright along their dotted lines, just right of them, small and
        // without a background: deals days apart don't run into each other,
        // and the share's line shows through
        ...[[marks, '#58a6ff'], [sellMarks, '#e05252']].flatMap(([list, color]) =>
          list.map(m => ({ x: m.day, y: 0.5, yanchor: 'bottom', xanchor: 'left', xshift: 2, textangle: -90, showarrow: false,
            text: `${color === '#e05252' ? '−' : '+'}${inUsd ? '$' + Math.round(m.usd).toLocaleString('en-US') : m.pp.toFixed(2)}`, font: { color, size: 10 } })))] },
      { responsive: true, displaylogo: false });
  } else document.getElementById('plot_cs_share').innerHTML = '<p class="empty-note">Войдите, чтобы увидеть долю крипты в портфеле.</p>';
}

