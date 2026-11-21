// Deterministic synthetic data for the page snapshot test (compare.mjs): the
// tables and RPCs the page reads, shaped like the real schema, with made-up
// numbers (a few real tickers and accounts, so the page's own lists apply).
let seed = 20261121;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const r2 = x => Math.round(x * 100) / 100;
const UID = 'd8905b70-2033-4755-9d1c-617a5d609e6f';
const day0 = Date.UTC(2026, 10, 21);
const iso = t => new Date(t).toISOString().slice(0, 10);
const daysBack = n => iso(day0 - n * 864e5);
const range = (from, to, step = 1) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += step * 864e5) out.push(iso(t)); return out; };

const H = [
  ['Alfa', 'RUB', 'YDEX', 'moex_share_or_etf', 'ru', 'stock', 'RUB'], ['Bybit', 'USD', 'BTC', 'crypto', 'foreign', 'crypto', 'USD'],
  ['Bybit', 'USD', 'SOL', 'crypto', 'foreign', 'crypto', 'USD'], ['Crypto.com', 'USD', 'BTC', 'crypto', 'foreign', 'crypto', 'USD'],
  ['Freedom24', 'EUR', 'VWCE', 'western_etf', 'foreign', 'stock', 'EUR'], ['Freedom24', 'USD', 'TSEM', 'us_stock', 'foreign', 'stock', 'USD'],
  ['Freedom24', 'USD', 'WMT', 'us_stock', 'foreign', 'stock', 'USD'], ['IBKR', 'USD', 'CSPX', 'western_etf', 'foreign', 'stock', 'USD'],
  ['IBKR', 'USD', 'GOOGL', 'us_stock', 'foreign', 'stock', 'USD'], ['IBKR', 'USD', 'META', 'us_stock', 'foreign', 'stock', 'USD'],
  ['IBKR', 'USD', 'MSFT', 'us_stock', 'foreign', 'stock', 'USD'], ['IBKR', 'USD', 'NVDA', 'us_stock', 'foreign', 'stock', 'USD'],
  ['IBKR', 'USD', 'VWRA', 'western_etf', 'foreign', 'stock', 'USD'], ['Revolut', 'EUR', 'IE000AZVL3K0', 'money_market_fund', 'foreign', 'liquid', 'EUR'],
  ['Revolut', 'EUR', 'XSX6', 'western_etf', 'foreign', 'stock', 'EUR'], ['Revolut', 'USD', 'XAU', 'gold', 'foreign', 'gold', 'USD'],
  ['Sber', 'CNY', 'RU000A10DT08', 'moex_bond', 'ru', 'bond', 'CNY'], ['Sber', 'RUB', 'OZON', 'moex_share_or_etf', 'ru', 'stock', 'RUB'],
  ['Sber', 'RUB', 'RU000A10C5L7', 'moex_bond', 'ru', 'bond', 'RUB'], ['Sber', 'RUB', 'SAFE', 'moex_bond_etf', 'ru', 'bond', 'RUB'],
  ['Sber', 'RUB', 'SAVINGS:Sber RUB', 'savings_account', 'ru', 'liquid', 'RUB'], ['Sber', 'RUB', 'SBBY', 'moex_bond_etf', 'ru', 'bond', 'CNY'],
  ['Sber', 'RUB', 'SBER', 'moex_share_or_etf', 'ru', 'stock', 'RUB'], ['Sber', 'RUB', 'SBMM', 'money_market_fund', 'ru', 'liquid', 'RUB'],
  ['Sber', 'RUB', 'SU29008RMFS8', 'moex_ofz', 'ru', 'bond', 'RUB'], ['T-Bank', 'CNY', 'RU000A105104', 'moex_bond', 'ru', 'bond', 'CNY'],
  ['T-Bank', 'RUB', 'DEPOSIT:T-Bank RUB 16% 31.10.2025', 'deposit', 'ru', 'deposit', 'RUB'], ['T-Bank', 'RUB', 'RU000A10D3S6', 'moex_bond', 'ru', 'bond', 'RUB'],
  ['T-Bank', 'RUB', 'T', 'moex_share_or_etf', 'ru', 'stock', 'RUB'], ['T-Bank', 'RUB', 'TBRU', 'moex_bond_etf', 'ru', 'bond', 'RUB'],
  ['T-Bank', 'RUB', 'TLCB', 'moex_bond_etf', 'ru', 'bond', 'CNY'], ['T-Bank', 'USD', 'XAU', 'gold', 'foreign', 'gold', 'USD'],
  ['TBC Bank', 'GEL', 'SAVINGS:TBC Bank GEL', 'savings_account', 'foreign', 'liquid', 'GEL'], ['Telegram', 'USD', 'TSTON', 'crypto', 'foreign', 'crypto', 'tsTON'],
  ['Telegram', 'USD', 'XAUT', 'gold', 'foreign', 'gold', 'USD'], ['Trust', 'USD', 'ETH', 'crypto', 'foreign', 'crypto', 'USD'],
];
const FX = { EUR: 1.08, RUB: 0.0115, GBP: 1.27, CNY: 0.138, GEL: 0.37, RSD: 0.0092, TRY: 0.029, AED: 0.272, HUF: 0.0027, ILS: 0.27, XAU: 2600 };
const basePrice = t => ({ BTC: 90000, ETH: 3200, SOL: 180, XAU: 2600, XAUT: 2600, TSTON: 5.5 }[t] || (t.startsWith('RU') || t.startsWith('SU') ? 9.8 : 20 + (t.charCodeAt(0) % 17) * 13));

const T = {};
const tickers = [...new Set(H.map(h => h[2]))];
const priceNow = {};
T.price_history = [];
for (const t of tickers) {
  if (t.includes(':')) continue;
  let p = basePrice(t) * 0.6;
  for (const d of range('2023-01-02', '2026-11-20', 2)) {
    p *= 1 + (rnd() - 0.48) * 0.03;
    T.price_history.push({ ticker: t, day: d, price_usd: r2(p * 1000) / 1000, source: 'yahoo' });
  }
  priceNow[t] = T.price_history[T.price_history.length - 1].price_usd;
}
T.fx_history = [];
for (const [c, v0] of Object.entries(FX)) {
  let v = v0;
  for (const d of range('2022-01-01', '2026-11-21')) { v *= 1 + (rnd() - 0.5) * 0.004; T.fx_history.push({ currency: c, day: d, usd_per_unit: Math.round(v * 1e6) / 1e6 }); }
}
const row = (h, i) => {
  const [account, currency, ticker, asset_class, infra_region, instrument_type, underlying_currency] = h;
  const price = priceNow[ticker] || 1;
  const value = r2(500 + rnd() * 15000);
  return { user_id: UID, ticker, account, quantity: r2(value / price), price_usd: price, currency, asset_class, source: 'test', as_of: daysBack(i % 3), value_usd: value, infra_region, instrument_type, underlying_currency };
};
T.portfolio_value_usd_by_account = H.map(row);
// a few cash lines
for (const [a, c] of [['Revolut', 'EUR'], ['Revolut', 'USD'], ['IBKR', 'USD'], ['Sber', 'RUB'], ['T-Bank', 'RUB'], ['Bank of Cyprus', 'EUR'], ['TBC Bank', 'GEL']])
  T.portfolio_value_usd_by_account.push({ user_id: UID, ticker: 'CASH:' + c, account: a, quantity: 1000, price_usd: FX[c] || 1, currency: c, asset_class: 'cash', source: 'test', as_of: daysBack(0), value_usd: r2(1000 * (FX[c] || 1)), infra_region: ['Sber', 'T-Bank'].includes(a) ? 'ru' : 'foreign', instrument_type: 'cash', underlying_currency: c });
{
  const by = {};
  for (const r of T.portfolio_value_usd_by_account) { const b = by[r.ticker] ||= { ...r, quantity: 0, value_usd: 0 }; b.quantity += r.quantity; b.value_usd = r2(b.value_usd + r.value_usd); delete b.account; }
  T.portfolio_value_usd = Object.values(by);
}
T.market_prices = T.portfolio_value_usd.map(r => ({ ticker: r.ticker, price_usd: r.price_usd, native_price: r.currency === 'RUB' ? r2(r.price_usd / FX.RUB) : r.price_usd, currency: r.currency, asset_class: r.asset_class, source: 'test', as_of: daysBack(0), updated_at: daysBack(0) + 'T10:00:00Z', infra_region: r.infra_region, instrument_type: r.instrument_type, underlying_currency: r.underlying_currency }));
const SECT = ['Technology', 'Financials', 'Energy', 'Health Care', 'Industrials', 'Consumer'];
const CTRY = [['United States', 'US'], ['Russia', 'RU'], ['Germany', 'DE'], ['Japan', 'JP'], ['China', 'CN']];
T.securities = tickers.filter(t => !t.includes(':')).map((t, i) => { const c = pick(CTRY); return { id: 'sec-' + i, isin: t.length === 12 ? t : 'XX' + String(i).padStart(10, '0'), ticker: t, market_ticker: t, name: t + ' Inc', sector: pick(SECT), country: c[0], country_code: c[1], currency: T.portfolio_value_usd.find(r => r.ticker === t).currency, asset_class: 'stock', updated_at: '2026-11-01T00:00:00Z' }; });
const consts = [];
for (let i = 0; i < 30; i++) { const c = pick(CTRY); consts.push({ id: 'con-' + i, isin: 'US' + String(1000000000 + i), ticker: 'C' + i, market_ticker: 'C' + i, name: 'Constituent ' + i, sector: pick(SECT), country: c[0], country_code: c[1], currency: c[1] === 'RU' ? 'RUB' : 'USD', asset_class: 'stock', updated_at: '2026-11-01T00:00:00Z' }); }
T.securities.push(...consts);
for (const c of consts) { let p = 50 + rnd() * 100; for (const d of range('2024-01-01', '2026-11-20', 7)) { p *= 1 + (rnd() - 0.48) * 0.04; T.price_history.push({ ticker: c.ticker, day: d, price_usd: r2(p), source: 'yahoo' }); } }
T.fund_holdings = [];
for (const f of ['VWRA', 'CSPX', 'VWCE', 'TLCB', 'TBRU', 'SBMM']) {
  const cs = consts.slice(0, 10 + Math.floor(rnd() * 15));
  for (const c of cs) T.fund_holdings.push({ fund: f, security_id: c.id, weight: r2(rnd() * 5) / 100, raw_name: c.name, as_of: '2026-11-01', source: 'test', updated_at: '2026-11-01T00:00:00Z' });
  T.fund_holdings.push({ fund: f, security_id: 'OTHER', weight: 0.02, raw_name: 'Cash', as_of: '2026-11-01', source: 'test', updated_at: '2026-11-01T00:00:00Z' });
}
T.fund_country_weights = []; T.fund_currency_weights = []; T.fund_sector_weights = [];
for (const f of ['VWRA', 'CSPX', 'VWCE', 'XSX6', 'TLCB', 'TBRU', 'SBMM', 'SAFE', 'SBBY']) {
  for (const [c, cc] of CTRY) T.fund_country_weights.push({ fund: f, country: c, country_code: cc, weight: 0.2 });
  for (const c of ['USD', 'EUR', 'RUB', 'CNY']) T.fund_currency_weights.push({ fund: f, currency: c, weight: 0.25 });
  for (const s of SECT) T.fund_sector_weights.push({ fund: f, sector: s, weight: r2(1 / SECT.length) });
}
T.portfolio_look_through_totals = consts.slice(0, 20).map(c => ({ user_id: UID, security_id: c.id, name: c.name, ticker: c.ticker, sector: c.sector, country: c.country, currency: c.currency, asset_class: 'stock', value_usd: r2(100 + rnd() * 3000), direct_usd: 0, via: [{ fund: 'VWRA', usd: 50 }] }));
T.portfolio_look_through_by_country = CTRY.map(([c]) => ({ user_id: UID, country: c, value_usd: r2(rnd() * 20000) }));
T.portfolio_look_through_by_currency = ['USD', 'EUR', 'RUB', 'CNY'].map(c => ({ user_id: UID, currency: c, value_usd: r2(rnd() * 20000) }));
T.portfolio_look_through_by_sector = SECT.map(s => ({ user_id: UID, sector: s, value_usd: r2(rnd() * 20000) }));

T.trades = []; let tid = 0;
for (const h of H) {
  const t = h[2]; if (t.includes(':') || h[5] === 'crypto') continue;
  const n = 3 + Math.floor(rnd() * 6);
  for (let k = 0; k < n; k++) {
    const d = daysBack(Math.floor(rnd() * 900) + 1);
    const ph = T.price_history.find(p => p.ticker === t && p.day >= d);
    const pu = ph ? ph.price_usd : priceNow[t];
    const price = h[1] === 'RUB' ? r2(pu / FX.RUB) : h[1] === 'CNY' ? r2(pu / FX.CNY) : h[1] === 'EUR' ? r2(pu / FX.EUR) : pu;
    const side = k === n - 1 && rnd() < 0.3 ? 'sell' : rnd() < 0.15 ? 'dividend' : 'buy';
    T.trades.push({ id: 'tr-' + (tid++), user_id: UID, ticker: t, side, quantity: side === 'dividend' ? 1 : r2(1 + rnd() * 20), price: side === 'dividend' ? r2(rnd() * 50) : price, trade_date: d, note: rnd() < 0.2 ? 'Покупка (сделка 1)' : null, created_at: d + 'T12:00:00Z', currency: h[1], fee_tax: r2(rnd() * 2), fee_currency: h[1], exchange: h[1] === 'RUB' ? 'MOEX' : 'NASDAQ', nkd: h[5] === 'bond' ? r2(rnd() * 10) : null, external_source: 'test', external_id: 'x' + tid, account: h[0], settle_date: d, estimated: false });
  }
}
T.trades.sort((a, b) => a.trade_date.localeCompare(b.trade_date));

const ACC = ['Alfa|RUB', 'Bank of Cyprus|EUR', 'cash|EUR', 'cash|RUB', 'Freedom24|USD', 'IBKR|USD', 'Revolut|EUR', 'Revolut|USD', 'Revolut|GBP', 'Sber|RUB', 'Sber|CNY', 'T-Bank|RUB', 'TBC Bank|GEL', 'TBC Bank|USD', 'Wise|EUR', 'Raiffeisen|RSD'];
const ECAT = ['Groceries', 'Restaurants & cafés', 'Taxi', 'Rent & housing', 'Subscriptions & services', 'Clothes', 'Flights', 'Hotels', 'Health & sport', 'Phone & internet', 'Public transport', 'Food delivery', 'Gifts', 'Other', 'Electronics', 'Bills & utilities'];
const DESC = ['SPAR', 'Wolt', 'Bolt', 'Netflix', 'Zara', 'Lidl', 'Carrefour', 'Apple', 'Uber', 'Glovo', 'Pharmacy', 'Kafe'];
T.bank_transactions = []; T.expenses = []; T.income = []; T.income_timed = [];
const bal = {};
for (let i = 0; i < 900; i++) {
  const [account, currency] = pick(ACC).split('|');
  const d = daysBack(Math.floor(rnd() * 700));
  const isIn = rnd() < 0.12;
  const amount = r2((isIn ? 1 : -1) * (5 + rnd() * (isIn ? 3000 : 120)) / (currency === 'RUB' ? FX.RUB / 0.01 * 0.01 : 1) * (currency === 'RUB' ? 1 : 1));
  const amt = currency === 'RUB' ? r2(amount * 90) : currency === 'GEL' ? r2(amount * 2.7) : currency === 'RSD' ? r2(amount * 108) : amount;
  const key = account + currency; bal[key] = r2((bal[key] || 5000) + amt);
  const ts = d + 'T' + String(8 + Math.floor(rnd() * 12)).padStart(2, '0') + ':' + String(Math.floor(rnd() * 60)).padStart(2, '0') + ':00+00:00';
  const desc = isIn ? pick(['Salary', 'Interest', 'Cashback', 'Transfer from Ilya']) : pick(DESC);
  const cat = isIn ? null : pick(ECAT);
  const id = 'bt-' + i;
  T.bank_transactions.push({ id, user_id: UID, account, tx_date: ts, description: desc, counterparty: null, amount: amt, currency, category: cat, balance_after: bal[key], note: null, external_source: 'test', external_id: 'e' + i, created_at: ts, synthetic: false, synthetic_kind: null, data_gap_until: null, product: null, booked_at: ts, authorized_on: d, amount_approximate: false, expense_category: cat, expense_manual: false, expense_spread_months: null, expense_spread_from: null, expense_note: rnd() < 0.05 ? 'заметка' : null, income_category: isIn ? pick(['Salary', 'Interest', 'Cashback']) : null, income_manual: false, fx_rate: null, refund_of: null, refund_manual: false, place_id: rnd() < 0.2 ? 1 + Math.floor(rnd() * 5) : null, delivery_place_id: null, authorized_at: ts, authorized_approx: false });
  const usd = r2(Math.abs(amt) * (FX[currency] || 1));
  if (isIn) {
    const inc = { id: i, user_id: UID, day: d, account, external_source: 'test', external_id: id, description: desc, amount: Math.abs(amt), currency, usd, category: pick(['Salary', 'Interest', 'Cashback', 'Coupons', 'Flat rent']) };
    T.income.push(inc); T.income_timed.push({ ...inc, clock: ts.slice(11, 16) });
  } else {
    T.expenses.push({ id: i, user_id: UID, day: d, paid_day: d, account, external_source: 'test', external_id: id, description: desc, amount: Math.abs(amt), currency, usd, category: cat, counted: true, extrapolated: false, note: null, paid_at: ts });
  }
}
T.bank_transactions.sort((a, b) => a.tx_date.localeCompare(b.tx_date));
T.bank_latest_balances = Object.entries(bal).map(([k, v]) => { const a = ACC.find(x => x.replace('|', '') === k).split('|'); return { user_id: UID, account: a[0], currency: a[1], external_source: 'test', product: null, balance_after: v, tx_date: daysBack(1) + 'T10:00:00+00:00' }; });

const days = range('2024-01-01', '2026-11-20');
T.capital_daily_total = []; T.capital_daily_by_type = []; T.capital_daily_by_account = []; T.investment_daily = [];
let cap = 150000, inv = 120000;
for (const d of days) {
  cap *= 1 + (rnd() - 0.47) * 0.01; inv += rnd() < 0.05 ? 2000 : 0;
  T.capital_daily_total.push({ user_id: UID, day: d, capital_usd: r2(cap), real_estate_usd: 120000 });
  const p = k => r2(cap * k);
  T.capital_daily_by_type.push({ user_id: UID, day: d, ru_cash: p(0.03), ru_liquid: p(0.05), ru_deposit: p(0.04), ru_gold: p(0.01), ru_bond: p(0.12), ru_stock: p(0.06), ru_crypto: 0, ru_credit: 0, fx_cash: p(0.06), fx_liquid: p(0.08), fx_deposit: 0, fx_gold: p(0.04), fx_bond: 0, fx_stock: p(0.36), fx_crypto: p(0.09), fx_credit: p(-0.01), real_estate: 120000 });
  T.capital_daily_by_account.push({ user_id: UID, day: d, accounts: { IBKR: p(0.3), Sber: p(0.2), 'T-Bank': p(0.15), Revolut: p(0.15), Bybit: p(0.1), 'Crypto.com': p(0.1) }, real_estate: 120000 });
  T.investment_daily.push({ user_id: UID, day: d, value_usd: r2(cap * 0.9), invested_usd: r2(inv), income_usd: r2(inv * 0.05), value_rub: r2(cap * 0.9 * 90), invested_rub: r2(inv * 90), income_rub: r2(inv * 4.5) });
}
T.capital_daily = [];
for (const d of range('2025-01-01', '2026-11-20', 30)) for (const r of T.portfolio_value_usd_by_account) T.capital_daily.push({ user_id: UID, day: d, account: r.account, ticker: r.ticker, instrument_type: r.instrument_type, currency: r.currency, value_usd: r2(r.value_usd * (0.7 + rnd() * 0.4)) });
T.capital_ever_held = T.portfolio_value_usd_by_account.map(r => ({ user_id: UID, account: r.account, currency: r.currency, instrument_type: r.instrument_type, ticker: r.ticker }));

T.crypto_wallets = [
  { id: 'w1', user_id: UID, chain: 'bitcoin', address: 'bc1qtest0000000000000000000000000000000', account: 'Trust', created_at: '2025-01-01T00:00:00Z', last_synced_at: daysBack(0) + 'T08:00:00Z', last_sync_error: null },
  { id: 'w2', user_id: UID, chain: 'ethereum', address: '0x0000000000000000000000000000000000000001', account: 'Trust', created_at: '2025-01-01T00:00:00Z', last_synced_at: daysBack(0) + 'T08:00:00Z', last_sync_error: null },
  { id: 'w3', user_id: UID, chain: 'bybit', address: 'bybit', account: 'Bybit', created_at: '2025-01-01T00:00:00Z', last_synced_at: daysBack(0) + 'T08:00:00Z', last_sync_error: null },
  { id: 'w4', user_id: UID, chain: 'cryptocom', address: 'cryptocom', account: 'Crypto.com', created_at: '2025-01-01T00:00:00Z', last_synced_at: daysBack(0) + 'T08:00:00Z', last_sync_error: null },
];
T.wallet_balances = [
  { wallet_id: 'w1', user_id: UID, account: 'Trust', chain: 'bitcoin', contract: null, symbol: 'BTC', name: 'Bitcoin', decimals: 8, quantity: 0.05, price_usd: priceNow.BTC, ticker: 'BTC', as_of: daysBack(0) + 'T08:00:00Z' },
  { wallet_id: 'w2', user_id: UID, account: 'Trust', chain: 'ethereum', contract: null, symbol: 'ETH', name: 'Ether', decimals: 18, quantity: 1.2, price_usd: priceNow.ETH, ticker: 'ETH', as_of: daysBack(0) + 'T08:00:00Z' },
  { wallet_id: 'w3', user_id: UID, account: 'Bybit', chain: 'bybit', contract: null, symbol: 'BTC', name: 'Bitcoin', decimals: 8, quantity: 0.1, price_usd: priceNow.BTC, ticker: 'BTC', as_of: daysBack(0) + 'T08:00:00Z' },
];
T.wallet_transactions = []; T.card_crypto_purchases = [];
for (let i = 0; i < 40; i++) {
  const w = pick(T.crypto_wallets), sym = w.chain === 'ethereum' ? 'ETH' : 'BTC';
  const d = daysBack(Math.floor(rnd() * 600));
  const kind = pick(['deposit', 'trade', 'purchase', 'withdrawal', 'card']);
  T.wallet_transactions.push({ wallet_id: w.id, user_id: UID, chain: w.chain, tx_hash: 'h' + i, seq: 0, kind, tx_time: d + 'T10:00:00Z', contract: null, symbol: sym, decimals: 8, amount: r2((kind === 'withdrawal' ? -1 : 1) * rnd()) / 10, counterparty: null, status: 'ok', estimated: false });
  if (kind === 'purchase') T.card_crypto_purchases.push({ id: i, user_id: UID, bank_source: 'test', bank_id: 'bt-1', wallet_id: w.id, tx_hash: 'h' + i, kind: 'buy', seq: 0, paid: r2(100 + rnd() * 500), currency: 'EUR', coin: sym, coins: r2(rnd()) / 10, paid_on: d, received_at: d + 'T10:00:00Z', matched_by: 'test', created_at: d + 'T10:00:00Z' });
}
T.crypto_indicators = range('2024-01-01', '2026-11-20').map((d, i) => ({ day: d, btc_usd: r2(40000 + i * 50 + rnd() * 3000), dca200: r2(40000 + i * 45), fair_usd: r2(42000 + i * 48), ahr999: Math.round((0.5 + rnd()) * 1000) / 1000, updated_at: d + 'T00:00:00Z', source: 'test' }));
T.crypto_fair_fit = [{ day: '2026-11-20', slope: 5.8, intercept: -17, r2: 0.95, days_fitted: 5000, first_price_day: '2010-07-18', last_price_day: '2026-11-20', red_threshold: 1.2, updated_at: '2026-11-20T00:00:00Z' }];
T.key_rates = range('2022-01-01', '2026-11-01', 30).map((d, i) => ({ day: d, rate: 7.5 + (i % 20) * 0.5 }));
T.cb_rates_monthly = [];
for (const c of ['RU', 'US']) for (const d of range('2022-01-01', '2026-11-01', 30)) T.cb_rates_monthly.push({ country: c, month: d.slice(0, 8) + '01', rate: c === 'RU' ? 16.5 : 4.5 });
T.key_rate_odds = [{ rate_from: 15, rate_to: 17, rate: 16.5, days: 365, up_raw: 0.2, down_raw: 0.6, same_raw: 0.2, up: 0.2, down: 0.6, floaters_pct: 30, computed_at: '2026-11-20T00:00:00Z' }];
T.key_rate_trend_odds = [{ trend_from: -1, trend_to: 0, n: 30, obs_up: 5, exp_up: 8, odds_ratio: 0.6, computed_at: '2026-11-20T00:00:00Z', position: 1 }];
T.key_rate_horizon_odds = [1, 2, 3].map(h => ({ horizon: h, rate: 16.5, months: h * 12, down: 0.6, up: 0.2, computed_at: '2026-11-20T00:00:00Z', country: 'RU' }));
T.real_estate = [{ id: 're1', user_id: UID, name: 'Flat', city: 'Nizhny Novgorod', purchase_price: 6000000, currency: 'RUB', purchase_month: '2019-06-01', created_at: '2025-01-01T00:00:00Z' }];
T.real_estate_value = [{ ...T.real_estate[0], purchase_price_per_m2: 100000, latest_month: '2026-10-01', latest_price_per_m2: 160000, current_value: 9600000 }];
T.real_estate_index = range('2019-01-01', '2026-10-01', 30).map((d, i) => ({ city: 'Nizhny Novgorod', month: d.slice(0, 8) + '01', price_per_m2: 90000 + i * 800, currency: 'RUB', source: 'test', updated_at: '2026-11-01T00:00:00Z' }));
T.life_periods = [{ id: 1, user_id: UID, start_day: '2023-01-01', end_day: '2026-10-18', place: 'Cyprus', company: 'Co', note: null, created_at: '2025-01-01T00:00:00Z' }, { id: 2, user_id: UID, start_day: '2026-10-19', end_day: null, place: 'Georgia', company: 'New', note: null, created_at: '2026-10-19T00:00:00Z' }];
T.income_expectations = [{ id: 1, user_id: UID, category: 'Salary', amount: 5700, currency: 'USD', from_day: '2026-11-01', to_day: null, note: null, created_at: '2026-11-01T00:00:00Z' }];
T.credit_card_reminders = [{ id: 1, user_id: UID, account: 'T-Bank', currency: 'RUB', statement_day: 5, due_day: 25, remind_days: 5, updated_at: '2026-01-01T00:00:00Z', grace_months: 1 }];
T.deposit_terms = [{ user_id: UID, ticker: 'DEPOSIT:T-Bank RUB 16% 31.10.2025', end_day: '2027-01-31', updated_at: '2026-01-01T00:00:00Z' }];
T.statement_uploads = ['Alfa|bank_csv', 'IBKR|ibkr', 'Revolut|revolut_account', 'Sber|sber_broker', 'T-Bank|bank_csv', 'TBC Bank|bank_csv', 'Wise|wise', 'Freedom24|freedom24_json'].map((k, i) => ({ id: i, user_id: UID, account: k.split('|')[0], kind: k.split('|')[1], file_name: 'f' + i + '.csv', uploaded_at: daysBack(i * 3) + 'T10:00:00Z', period_from: daysBack(i * 3 + 30), period_to: daysBack(i * 3) }));
T.month_totals = [];
for (const m of range('2025-01-01', '2026-11-01', 31)) for (const c of ECAT.slice(0, 8)) T.month_totals.push({ user_id: UID, kind: 'expense', basis: 'day', month: m.slice(0, 8) + '01', category: c, account: 'Revolut', counted: true, extrapolated: false, usd: r2(rnd() * 500), eur: r2(rnd() * 460), rub: r2(rnd() * 45000), first_day: m.slice(0, 8) + '01' });
T.expense_forecasts = [];
T.places = [1, 2, 3, 4, 5].map(i => ({ id: i, user_id: UID, name: 'Place ' + i, lat: 41.7 + i / 100, lng: 44.8, url: null, google_id: null, created_at: '2025-01-01T00:00:00Z', city: 'Tbilisi', street: 'Street', house: String(i), country: 'GE', chain: i < 3 ? 'SPAR' : null }));
T.products = [1, 2, 3, 4].map(i => ({ id: i, name_en: 'Product ' + i, brand: null, size_value: 1, size_unit: 'kg', barcode: null, category: 'Groceries', merged_into: null, note: null, created_at: '2025-01-01T00:00:00Z' }));
T.receipts = [1, 2, 3].map(i => ({ id: i, user_id: UID, source: 'test', receipt_key: 'k' + i, tx_source: 'test', tx_external_id: 'e' + i, match_state: 'matched', purchased_at: daysBack(i * 5) + 'T12:00:00Z', purchased_on: daysBack(i * 5), store_printed: 'SPAR', chain: 'SPAR', city: 'Tbilisi', country: 'GE', place_id: 1, currency: 'GEL', total: 25.5, superseded_by: null, last_match_candidates: 1, last_matched_at: null, file_name: null, note: null, created_at: daysBack(i) + 'T12:00:00Z', updated_at: daysBack(i) + 'T12:00:00Z', venue: null }));
T.receipts_active = T.receipts;
T.receipt_items = []; T.receipt_lines = []; T.product_prices = [];
for (const rc of T.receipts) for (let l = 1; l <= 3; l++) {
  const it = { id: rc.id * 10 + l, user_id: UID, receipt_id: rc.id, line_no: l, name_printed: 'ITEM ' + l, name_en: 'Item ' + l, product_id: l, qty: 1, unit: 'pcs', unit_price_list: 8.5, unit_price_paid: 8.5, line_total: 8.5, barcode: null, note: null, created_at: rc.created_at };
  T.receipt_items.push(it); T.receipt_lines.push({ ...it, is_other: false });
  T.product_prices.push({ product_id: l, user_id: UID, day: rc.purchased_on, place_id: 1, chain: 'SPAR', currency: 'GEL', qty: 1, unit: 'pcs', unit_price_list: 8.5, unit_price_paid: 8.5, unit_price_usd: 3.1, item_id: it.id, receipt_id: rc.id, country: 'GE', city: 'Tbilisi', store: 'SPAR' });
}
T.apple_purchase_prices = [];
T.internal_transfers = [];
T.price_freezes = [];
T.price_sources = tickers.filter(t => !t.includes(':')).map(t => ({ ticker: t, source: 'yahoo', symbol: t, currency: 'USD', updated_at: '2026-11-20T00:00:00Z', splits_checked_at: null }));
for (const t of ['transfer_pair_rows', 'transfer_pair_timed', 'unpaired_in_rows', 'unpaired_in_timed', 'expense_chains', 'store_places', 'product_price_compare', 'product_aliases']) T[t] ||= [];
const RPC = {
  investment_by_asset: T.portfolio_value_usd.filter(r => !r.ticker.startsWith('CASH')).map(r => { const vs = r2(r.value_usd * 0.8), pi = r2(r.value_usd * 0.15), inc = r2(r.value_usd * 0.02); return { asset: r.ticker, accounts: T.portfolio_value_usd_by_account.filter(x => x.ticker === r.ticker).map(x => x.account).join(', '), value_start: vs, value_end: r.value_usd, put_in: pi, taken_out: 0, income: inc, earned: r2(r.value_usd - vs - pi + inc), pct: r2((r.value_usd - vs - pi + inc) / (vs + pi) * 100), cash: null, kind: r.instrument_type, region: r.infra_region }; }),
  latest_data_per_account: [...new Set(T.portfolio_value_usd_by_account.map(r => r.account))].map((a, i) => ({ account: a, bank_day: daysBack(i % 5), trade_day: daysBack(i % 7), exchange_day: null, synced_day: daysBack(i % 3), bank_rows_90d: 10 + i, uploaded_to: daysBack(i % 4) })),
  latest_data_per_part: [],
  ibkr_flex_status: [{ query_id: '123456', token_set: true, token_expires: '2026-11-25', last_sync_at: '2026-11-20T10:00:00Z', last_sync_result: JSON.stringify({ trades: 3, dividends: 1, cash_rows: 5, period: '2026-10-21..2026-11-20' }) }],
  bybit_api_status: [{ key_tail: 'abcd', secret_set: true, key_expires: '2027-02-01', last_sync_at: '2026-11-20T10:00:00Z', last_sync_result: JSON.stringify({ error: 'key expired' }) }],
  freedom24_api_status: [{ key_tail: 'f24k', secret_set: true, last_sync_at: '2026-11-19T10:00:00Z', last_sync_result: 'not json' }],
  tbank_api_status: [{ token_set: true, last_sync_at: '2026-11-20T09:00:00Z', last_sync_result: JSON.stringify({ synced: [{ agreement: 'A1', deals: 2, payouts: 1, cash_rows: 3, from: '2026-11-01', checked: { window: '01.11-15.11', deals: 2, payouts: 1 } }] }) }],
  binance_api_status: [{ key_tail: 'bnb1', secret_set: true, last_sync_at: '2026-11-20T08:00:00Z', last_sync_result: JSON.stringify({ balances: { BTC: 0.0123456789, USDT: 15 }, differences: ['BTC 0.01 vs 0.02'] }) }],
  revolutx_api_status: [{ key_tail: 'rx12', secret_set: false, last_sync_at: '2026-11-20T08:00:00Z', last_sync_result: JSON.stringify({ balances: { ETH: 1.5 } }) }],
  wise_api_status: [{ token_set: true, token_tail: 'w9' }],
  enablebanking_status: [{ broker: 'enablebanking', app_id: 'app-1', key_set: true },
    { broker: 'eb:revolut', session_set: true, valid_until: '2026-11-26', last_sync_at: '2026-11-20T07:00:00Z', last_sync_result: JSON.stringify({ written: 12, after_statement: '2026-11-15', pending: 2, checked: { window: '10.11-15.11', matched: 9 }, balances: { EUR: { bank: 1200 } } }) },
    { broker: 'eb:boc', session_set: true, valid_until: '2027-03-01', last_sync_at: null }],
};
// MOEX ISS (fake_moex.mjs): the bonds held, the OFZ on the main board, the yuan corporates
const bond = (secid, name, mat, extra = {}) => ({ secid, name, mat, unit: 'RUB', face: 1000, price: 97.5, accrued: 12.3, board: 'TQOB',
  rate: 12, floating: false, yield: 14.2, turnover: 5e6, duration: 700, ...extra });
const MOEX = {
  held: [
    bond('RU000A10DT08', 'ГазКап 1Р-12', '2028-06-15', { unit: 'CNY', face: 100, board: 'TQCB', rate: 6.5, yield: 7.1 }),
    bond('RU000A10C5L7', 'Медскан 1Р-01', '2027-09-10', { board: 'TQCB', rate: 18, yield: 19.5 }),
    bond('SU29008RMFS8', 'ОФЗ-ПК 29008', '2029-10-03', { floating: true, rate: 17.2, yield: 0, price: 99.1 }),
    bond('RU000A105104', 'РЖД 1Р-20R', '2030-03-01', { unit: 'CNY', face: 100, board: 'TQCB', rate: 5.9, offer: '2027-03-05', yield: 6.4 }),
    bond('RU000A10D3S6', 'МегаФон 2Р-05', '2028-11-20', { board: 'TQCB', floating: true, details: 'Ключевая ставка + 1,9%', rate: 18.4, yield: 0, amortised: true }),
  ],
  ofz: [
    ['SU25084RMFS3', '2027-10-06'], ['SU26236RMFS8', '2028-05-17'], ['SU26237RMFS6', '2029-03-14'], ['SU26228RMFS5', '2030-04-10'],
    ['SU26239RMFS2', '2031-07-23'], ['SU26241RMFS8', '2032-11-17'], ['SU26244RMFS2', '2034-03-15'], ['SU26238RMFS4', '2041-05-15'],
  ].map(([id, mat], i) => bond(id, 'ОФЗ ' + id.slice(2, 7), mat, { yield: 13 + i * 0.3, turnover: 2e6 + i * 1e6, rate: 7 + i }))
    .concat([['SU29014RMFS6', '2026-03-25'], ['SU29022RMFS9', '2028-09-06'], ['SU29024RMFS5', '2029-04-11'], ['SU29025RMFS2', '2037-08-12']]
      .map(([id, mat], i) => bond(id, 'ОФЗ-ПК ' + id.slice(2, 7), mat, { floating: true, rate: 16.5 + i * 0.4, yield: 0, turnover: 3e6 + i * 1e6, price: 98 + i * 0.5 }))),
  cny: [['RU000A10A3Z4', 'НорНик 1Р-10-CNY', '2027-12-01'], ['RU000A10B4B9', 'Полюс ПБО-07', '2028-05-20'], ['RU000A107KR6', 'Роснфт 2Р-12', '2029-08-30'], ['RU000A10C1P1', 'Сбер Sb CNY', '2028-01-01']]
    .map(([id, name, mat], i) => bond(id, name, mat, { unit: 'CNY', face: 100, board: 'TQCB', rate: 6 + i * 0.5, yield: 6.5 + i, turnover: 4e6 })),
};
export const FIXTURE = { T, RPC, MOEX };
