// My Portfolio's tables: number and currency formats, broker x currency and
// broker x asset class, real estate, cash rows, the safety cushion.

function mpEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function mpFormatUsd(n) {
  if (n === null || n === undefined) return '<span class="muted">—</span>';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', ...mpFractionDigits(n) });
}
// Amounts from a million up are shown without cents (₽7,595,290, not ₽7,595,289.84).
const mpFractionDigits = n => (Math.abs(n) >= 1000000 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { maximumFractionDigits: 2 });

// Single-glyph symbols for currencies that don't already get the exact
// glyph we want from Intl.NumberFormat -- it gives USD/EUR/GBP their
// symbols natively, spells RUB/TRY out as the bare code, and renders CNY
// as "CN¥" (we prefer the bare "¥") -- keeps the broker x currency
// table's body cells compact. RSD has no widely-recognized single glyph,
// so it's left to fall through to the bare-number path below.
const MP_CURRENCY_SYMBOLS = { RUB: '₽', TRY: '₺', CNY: '¥', GEL: '₾' };

// withCode=false (the default, used for the broker x currency table's own
// body cells, which already have a column header naming the unit) omits
// the currency/ticker code entirely -- just the symbol (if one exists) and
// the number -- so a wide row of many currency/crypto columns stays
// scannable instead of repeating "RUB"/"BTC"/... in every cell.
// withCode=true (used for that table's "Total (native)" row, which sums
// across brokers and so needs to restate which unit each column is) keeps
// the code prefix for anything without a recognized symbol.
//
// Precision: real currencies stay at 2 decimals; crypto/metal tickers
// (anything Intl.NumberFormat's style:'currency' doesn't reject, like
// BTC/ETH, plus ones it does reject, like XAUT) get up to 8 -- a holding
// of 0.04 BTC or 0.35 ETH is meaningless rounded to cents.
// unitPriceUsd (optional, crypto/metal columns): show only the decimals
// that still move the USD value by at least a tenth of a cent -- the last
// shown digit is worth >= $0.001 (SOL at ~$120 -> 5 decimals, BTC at ~$84k
// -> 7).
function mpFormatCurrency(n, currency, withCode = false, unitPriceUsd = null, keepZero = false) {
  if (n === null || n === undefined) return '<span class="muted">—</span>';
  // A zero balance carries no unit-specific information ("$0.00" and
  // "£0.00" say the same thing), so every column collapses to a single
  // dim, small "0" instead of repeating the symbol/code -- keeps the wide
  // broker x currency row from being cluttered with empty-currency noise.
  if (n === 0 && !keepZero) return '<span class="zero">0</span>';
  const isCrypto = MP_CURRENCY_COLUMN_ORDER.slice(MP_CURRENCY_COLUMN_ORDER.indexOf('Others') + 1).includes(currency) || !MP_ISO_CURRENCIES.has(currency);
  if (isCrypto) {
    const digits = unitPriceUsd > 0 ? Math.min(8, Math.max(0, Math.floor(Math.log10(unitPriceUsd * 1000)))) : 8;
    const amount = n.toLocaleString('en-US', { maximumFractionDigits: digits });
    return withCode ? `${currency} ${amount}` : amount;
  }
  try {
    const formatted = n.toLocaleString('en-US', { style: 'currency', currency, ...mpFractionDigits(n) });
    if (currency in MP_CURRENCY_SYMBOLS === false) return formatted;
    // Intl already spells RUB/TRY out as the bare code, but gives CNY its
    // own native "CN¥" prefix -- both get swapped for our preferred glyph,
    // in both body cells and the "Total (native)" row (withCode only
    // matters for currencies with no symbol -- see comment above).
    const isoPrefix = currency === 'CNY' ? 'CN¥' : currency;
    return formatted.replace(isoPrefix, MP_CURRENCY_SYMBOLS[currency]);
  } catch {
    // Unrecognized ISO code (shouldn't happen for the fiat currencies this
    // table deals with, but keeps the table from erroring if one shows up).
    const amount = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return withCode ? `${currency} ${amount}` : amount;
  }
}
const MP_ISO_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'RUB', 'TRY', 'RSD', 'GEL', 'CNY']);

// Builds a broker(row) x category(column) pivot table from an array of
// {account, [categoryField], value_usd} rows -- shared by
// mpRenderBrokerCurrency and mpRenderBrokerAssetClass, which differ only in
// which field supplies the column and how a column label is displayed.
//
// When fxByCurrency is given (only for the broker x currency table, where
// each column genuinely IS a currency), each cell is shown converted back
// to that column's own native currency (value_usd / fxByCurrency[currency])
// instead of USD, and an extra "Total (native)" row is inserted above the
// USD total row -- so e.g. the EUR column reads in euros, not USD-via-EUR.
// Cross-currency figures (the per-broker row total, and the grand total)
// have no single native currency to show, so those stay in USD always.
// Display order for the broker x currency table's columns (user's choice):
// USD, EUR, GBP, RUB, CNY, then the other currencies with columns of their
// own (TRY, RSD, GEL, ...) by how much they hold in USD, largest first, then
// "others", the metal and the coins in this order -- any coin not listed
// here falls back after these, alphabetically.
const MP_CURRENCY_COLUMN_ORDER = [
  'USD', 'EUR', 'GBP', 'RUB', 'CNY', 'Others',
  'XAU', 'BTC', 'ETH', 'SOL', 'GRAM', 'TAO', 'TRX', 'DOGE', 'Altcoins',
];

// Fixed display order for the broker x asset-class table's columns,
// matching the user's own tracking spreadsheet (Акции, Облигации,
// Вклады, Кэш, Золото, Крипта) rather than alphabetical.
const MP_ASSET_CLASS_COLUMN_ORDER = ['cushion', 'stock', 'bond', 'deposit', 'liquid', 'cash', 'credit', 'gold', 'crypto', 'real_estate'];
// Column headers for the broker x asset-class table (raw instrument_type
// value -> display label).
const MP_ASSET_CLASS_LABELS = {
  stock: 'stock 📈', bond: 'bond 🏛️', deposit: 'deposit 🏦', liquid: 'liquid assets 💧', cushion: 'emergency fund 🛟',
  cash: 'cash 💵', credit: 'credit 💳', gold: 'gold 🥇', crypto: 'crypto ₿', real_estate: 'real estate 🏠',
};

// The safety cushion -- $10,000 not to be touched (30.10.2026): the money it
// takes whole -- an account's cash or liquid assets, switched on and off on the
// page (table cushion_sources, 23.11.2026) -- and Revolut's liquid assets (its
// money-market funds) up to what that leaves of the $10,000: the euro ones
// first, then the dollar ones, then the pound ones. Not new money: those rows'
// amounts move from their column (cash / liquid assets) to 'cushion' -- the
// totals stay.
const MP_CUSHION_USD = 10000;
// "account|instrument_type" taken whole; loaded once signed in (mpCushionEnsure)
let mpCushionSources = new Set();
let mpCushionLoading = null;
function mpCushionEnsure() {
  return mpCushionLoading = mpCushionLoading || (async () => {
    const { data, error } = await sb.from('cushion_sources').select('account, instrument_type');
    if (error) { mpCushionLoading = null; throw error; }
    mpCushionSources = new Set((data || []).map(r => `${r.account}|${r.instrument_type}`));
  })();
}
window.mpCushionEnsure = mpCushionEnsure;
// The brokerage accounts outside Russia: their cash is invested with the
// liquidity funds (the salary plan), not spent on things.
const MP_FOREIGN_BROKERS = new Set(['IBKR', 'Freedom24']);
// (a row the fund takes whole -- its cell then shows a grey zero)
const mpCushionWhole = r => r.value_usd > 0 && (r.instrument_type === 'cash' || r.instrument_type === 'liquid')
  && mpCushionSources.has(`${r.account}|${r.instrument_type}`);
function mpWithCushion(rows) {
  const out = rows.map(r => (mpCushionWhole(r) ? { ...r, instrument_type: 'cushion' } : r));
  let need = MP_CUSHION_USD - out.filter(r => r.instrument_type === 'cushion').reduce((a, r) => a + r.value_usd, 0);
  const order = ['EUR', 'USD', 'GBP'];
  const funds = out.filter(r => r.account === 'Revolut' && r.instrument_type === 'liquid' && r.value_usd > 0
    && order.includes(r.underlying_currency || r.currency))
    .sort((a, b) => order.indexOf(a.underlying_currency || a.currency) - order.indexOf(b.underlying_currency || b.currency) || b.value_usd - a.value_usd);
  for (const r of funds) {
    if (need <= 0) break;
    const take = Math.min(need, r.value_usd);
    out.splice(out.indexOf(r), 1, { ...r, value_usd: r.value_usd - take }, { ...r, instrument_type: 'cushion', value_usd: take, quantity: null });
    need -= take;
  }
  return out;
}

// Country flag shown next to each ISO currency's column header in the
// broker x currency table, matching the user's own tracking spreadsheet.
// EUR has no single issuing country, so it gets the EU flag; crypto/metal
// tickers (BTC, XAU, ...) aren't tied to a country and are left unflagged.
const MP_CURRENCY_FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', RUB: '🇷🇺', TRY: '🇹🇷', RSD: '🇷🇸', GEL: '🇬🇪', CNY: '🇨🇳',
  AED: '🇦🇪', HUF: '🇭🇺', ILS: '🇮🇱',
};

// Fixed display order for broker rows, matching the user's own tracking
// spreadsheet -- '(unspecified)' first (mostly Snowball-imported trades
// with no account recorded), then brokers in the spreadsheet's own order.
// Any account not listed here falls back after these, alphabetically.
const MP_BROKER_ROW_ORDER = [
  '(unspecified)', 'Revolut', 'Wise', 'Bank of Cyprus', 'IBKR', 'Freedom24',
  'Ziraat Bank', 'Raiffeisen', 'UniCredit', 'Credo Bank', 'TBC Bank', 'Sber', 'T-Bank', 'Alfa', 'Ozon Bank', 'Yandex Bank', 'Finuslugi', 'Binance', 'Bybit', 'Crypto.com', 'Telegram', 'Trust',
  'cash', 'real estate',
];

// Flag/emoji shown next to each broker's row label, matching the user's
// own tracking spreadsheet -- one per broker's home country (or, for
// '(unspecified)', no flag since it names no actual broker).
const MP_BROKER_FLAGS = {
  Revolut: '🇪🇺', Wise: '🇪🇺', 'Bank of Cyprus': '🇨🇾', IBKR: '🇺🇸',
  Freedom24: '🇰🇿', 'Ziraat Bank': '🇹🇷', Raiffeisen: '🇷🇸', UniCredit: '🇷🇸', 'Credo Bank': '🇬🇪', 'TBC Bank': '🇬🇪',
  Sber: '🇷🇺', 'T-Bank': '🇷🇺', Finuslugi: '🇷🇺', Alfa: '🇷🇺', 'Ozon Bank': '🇷🇺', 'Yandex Bank': '🇷🇺',
  cash: '💵', 'real estate': '🏠',
};

// Shorter display names for broker rows (the account labels stored in the
// database stay as the importers write them).
const MP_BROKER_SHORT_NAMES = {
  'Bank of Cyprus': 'BoC', Freedom24: 'Freedom', 'Ziraat Bank': 'Ziraat', Raiffeisen: 'Raif',
  'Ozon Bank': 'Ozon', 'Yandex Bank': 'Yandex', 'Credo Bank': 'Credo', 'TBC Bank': 'TBC',
};

// "<account> <category>" pairs that ever held a value (capital_ever_held), for
// mpRenderBrokerPivot: a zero there is drawn in the normal colour.
// The currency column is worked out by the table's own rules
// (mpBrokerCurrencyUnit / mpCurrencyRows), from each ticker's market data --
// a wallet's USDT has no currency in the history but sits under USD.
let mpEverHeldRows = null;
async function mpEverHeld(field) {
  if (!mpEverHeldRows) {
    const { rows, error } = await mpFetchAllRows(() => sb.from('capital_ever_held').select('account, currency, instrument_type, ticker'));
    if (error) return new Set();
    // (wallet / exchange coins that ever moved are in the cache too -- 057)
    const tickers = [...new Set(rows.map(r => r.ticker).filter(t => t && !/^(CASH|REAL_ESTATE):/.test(t)))];
    const info = new Map();
    for (let i = 0; i < tickers.length; i += 200) {
      const { data } = await sb.from('market_prices').select('ticker, asset_class, underlying_currency, currency, instrument_type')
        .in('ticker', tickers.slice(i, i + 200));
      for (const m of data || []) info.set(m.ticker, m);
    }
    // US-dollar stablecoins count as dollars wherever they're held (as in
    // update-market-prices) -- also those no price row exists for (Bybit's
    // DAI, USDS); a wallet coin without one is a coin (Altcoins)
    const STABLE = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP']);
    mpEverHeldRows = rows.map(r => {
      const m = info.get(r.ticker) || (STABLE.has(r.ticker) ? { asset_class: 'stablecoin', underlying_currency: 'USD', instrument_type: 'cash' }
        : r.instrument_type === 'crypto' ? { asset_class: 'crypto', instrument_type: 'crypto' } : {});
      const cash = /^CASH:([^:]+):/.exec(r.ticker || '');
      const row = { ticker: r.ticker, asset_class: m.asset_class, underlying_currency: cash ? cash[1] : m.underlying_currency,
        currency: cash ? cash[1] : (r.currency || m.currency) };
      const unit = mpBrokerCurrencyUnit(row);
      const fiat = !MP_UNIT_QUOTED_ASSET_CLASSES.has(row.asset_class) && unit !== MP_ALTCOINS_COLUMN;
      const ccy = fiat && MP_EUROPEAN_AS_EUR.has(unit) ? 'EUR' : unit;
      return { account: r.account, currency: fiat && !MP_MAIN_CURRENCIES.has(ccy) ? MP_OTHER_CURRENCIES_COLUMN : ccy,
        instrument_type: m.instrument_type || r.instrument_type };
    });
  }
  return new Set(mpEverHeldRows.map(r => `${r.account} ${r[field]}`));
}

// money: how a USD amount is shown in the non-currency cells and the totals
// (the asset-class table can show them in roubles).
// A currency column's chart, as chart 1's slices open it: the dollar -- the Fed's rate; a currency -- its
// rate to the dollar; gold -- XAU with the XAUT deals; a coin -- its price; "others" / altcoins -- none
const MP_COIN_COLUMNS = new Set(['BTC', 'ETH', 'SOL', 'TON', 'GRAM', 'TAO']);
function mpCurrencyChart(c) {
  if (!c || c === 'Others' || c === 'Altcoins') return null;
  if (c === 'USD') return ['FX:USD', 'USD', { currency: 'USD' }];
  if (c === 'XAU') return ['XAU', 'Gold', { also: ['XAUT'] }];
  if (MP_COIN_COLUMNS.has(c)) return [c, c, { also: Object.keys(MP_CHART_COIN_OF).filter(k => MP_CHART_COIN_OF[k] === c) }];
  return /^[A-Z]{3}$/.test(c) ? [`FX:${c}`, c, { currency: c }] : null;
}
function mpRenderBrokerPivot(wrap, data, categoryField, emptyMessage, fxByCurrency, everHeld = new Set(), money = mpFormatUsd) {
  if (!data.length) { wrap.innerHTML = `<p class="empty-note">${emptyMessage}</p>`; return; }
  // Zero balances (a closed account like UniCredit, a spent-down currency)
  // are left out, so an account whose every balance is zero gets no row.
  const priced = data.filter(r => r.value_usd !== null && r.value_usd !== 0);
  const accounts = [...new Set(priced.map(r => r.account))].sort((a, b) => {
    const ia = MP_BROKER_ROW_ORDER.indexOf(a), ib = MP_BROKER_ROW_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const usdOf = {};
  for (const r of priced) usdOf[r[categoryField]] = (usdOf[r[categoryField]] || 0) + r.value_usd;
  // a currency not in the fixed order goes before "others" (by USD, largest first)
  const fiatRank = MP_CURRENCY_COLUMN_ORDER.indexOf('Others') - 0.5;
  const rank = c => (MP_CURRENCY_COLUMN_ORDER.includes(c) ? MP_CURRENCY_COLUMN_ORDER.indexOf(c)
    : MP_ISO_CURRENCIES.has(c) ? fiatRank : Infinity);
  const categories = fxByCurrency
    ? [...new Set(priced.map(r => r[categoryField]))].sort((a, b) =>
        rank(a) - rank(b) || (rank(a) === fiatRank ? usdOf[b] - usdOf[a] : 0) || (rank(a) === Infinity ? a.localeCompare(b) : 0))
    : [...new Set(priced.map(r => r[categoryField]))].sort((a, b) => {
        const ia = MP_ASSET_CLASS_COLUMN_ORDER.indexOf(a), ib = MP_ASSET_CLASS_COLUMN_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
  // A row flagged `excluded` (a property switched out of the totals) is shown
  // in its cell but not summed into the totals; an account whose every row
  // is excluded is dimmed.
  const cell = {};
  const counted = {};
  for (const r of priced) {
    const key = `${r.account} ${r[categoryField]}`;
    cell[key] = (cell[key] || 0) + r.value_usd;
    if (!r.excluded) counted[key] = (counted[key] || 0) + r.value_usd;
  }
  const dimmed = new Set(accounts.filter(a => priced.filter(r => r.account === a).every(r => r.excluded)));
  const rowTotal = a => categories.reduce((s, c) => s + (cell[`${a} ${c}`] || 0), 0);
  const colTotal = c => accounts.reduce((s, a) => s + (counted[`${a} ${c}`] || 0), 0);
  const grandTotal = categories.reduce((s, c) => s + colTotal(c), 0);
  const anyMissing = data.some(r => r.value_usd === null);
  // a zero where the account once held something keeps its currency ("€0.00")
  const heldZero = category => (fxByCurrency && category in fxByCurrency
    ? mpFormatCurrency(0, category, false, fxByCurrency[category], true) : money(0));
  const cellDisplay = (usd, category) => {
    if (fxByCurrency && category in fxByCurrency) {
      return mpFormatCurrency(usd / fxByCurrency[category], category, false, fxByCurrency[category]);
    }
    if (usd === 0) return '<span class="zero">0</span>';
    return money(usd);
  };
  const nativeTotalRow = fxByCurrency
    ? `<tr class="total-row"><td class="ticker"><b>Total (native)</b></td>
        ${categories.map(c => `<td><b>${cellDisplay(colTotal(c), c)}</b></td>`).join('')}
        <td class="muted">—</td>
      </tr>`
    : '';
  // Currency flags only make sense when the columns are ISO currencies
  // (fxByCurrency is only passed for the broker x currency table) -- the
  // broker x asset-class table's columns are asset classes, so
  // mpEscapeHtml(c) is used unflagged there.
  const headerLabel = c => fxByCurrency && c === 'Others' ? 'others 🌍'
    : fxByCurrency && c in MP_CURRENCY_FLAGS
    ? `${mpEscapeHtml(c)} ${MP_CURRENCY_FLAGS[c]}` : mpEscapeHtml(fxByCurrency ? c : MP_ASSET_CLASS_LABELS[c] || c);
  // Broker flags identify the broker itself, not its columns, so unlike
  // headerLabel above they apply regardless of what the columns represent.
  const brokerLabel = a => {
    const name = mpEscapeHtml(MP_BROKER_SHORT_NAMES[a] || a);
    return a in MP_BROKER_FLAGS ? `${name} ${MP_BROKER_FLAGS[a]}` : name;
  };
  wrap.innerHTML = `<table class="data-table"><thead><tr>
    <th class="corner">Broker</th>${categories.map(c => `<th${fxByCurrency && mpCurrencyChart(c) ? ` data-ccy="${mpEscapeHtml(c)}" style="cursor:pointer" title="Open its chart"` : ''}>${headerLabel(c)}</th>`).join('')}<th class="corner">Total</th>
  </tr></thead><tbody>${accounts.map(a => `<tr${dimmed.has(a) ? ' style="opacity:0.45" title="Not included in the totals"' : ''}>
    <td class="ticker" data-account="${mpEscapeHtml(a)}" style="cursor:pointer" title="Open its chart">${brokerLabel(a)}</td>
    ${categories.map(c => `<td>${!cell[`${a} ${c}`] && everHeld.has(`${a} ${c}`) ? heldZero(c) : cellDisplay(cell[`${a} ${c}`] || 0, c)}</td>`).join('')}
    <td><b>${money(rowTotal(a))}</b></td>
  </tr>`).join('')}
  ${nativeTotalRow}
  <tr class="total-row"><td class="ticker"><b>Total (${money.unit || 'USD'})</b></td>
    ${categories.map(c => `<td${c === 'cushion' && colTotal(c) < MP_CUSHION_USD - 0.005 ? ' class="neg" title="under its $10,000"' : ''}><b>${money(colTotal(c))}</b></td>`).join('')}
    <td><b>${money(grandTotal)}</b></td>
  </tr></tbody></table>
  ${anyMissing ? '<p class="empty-note">Some tickers have no price yet — totals are a partial sum.</p>' : ''}`;
  // a bank's or broker's name opens its money over time
  wrap.querySelectorAll('td[data-account]').forEach(td => td.addEventListener('click', () => mpOpenAccountChart(td.dataset.account)));
  // a currency's header opens its chart (as chart 1's slices do)
  if (fxByCurrency) wrap.querySelectorAll('th[data-ccy]').forEach(th => th.addEventListener('click', () => mpOpenPriceDialog(...mpCurrencyChart(th.dataset.ccy))));
}

// Reads the FX:<CCY> synthetic tickers update-market-prices publishes
// into market_prices (see that function's "FX rates" section) for the
// given currency codes, returning {currency: usdPerUnit}. Shared by
// mpFetchCashRows (to convert a cash balance to USD) and
// mpRenderBrokerCurrency (to convert a USD total back to a column's own
// native currency for display).
async function mpFetchFxByCurrency(currencies) {
  if (!currencies.length) return {};
  const { data } = await sb.from('market_prices')
    .select('ticker, price_usd')
    .in('ticker', [...new Set(currencies)].map(c => `FX:${c}`));
  const fxByCurrency = {};
  for (const r of data || []) fxByCurrency[r.ticker.slice(3)] = r.price_usd;
  return fxByCurrency;
}

// Plain bank cash (checking-account balances -- Bank of Cyprus, Revolut
// current accounts) never appears in `trades`/`portfolio_value_usd_by_account`
// at all -- it's not a priced asset, it's just money sitting in an
// account (see bank_transactions' own docstring on why it's a separate
// table). To still show it alongside holdings in the broker x currency /
// broker x asset-class tables, this reads the single most recent
// balance_after per (account, currency, external_source) from
// bank_transactions, sums those per (account, currency), and converts it to
// USD using the already-fetched fxByCurrency map. external_source is part
// of the key because import-bank-csv gives each bank account its own
// ('t_bank_csv:<account_number>'), so e.g. T-Bank's debit and credit card
// -- both RUB, both labelled "T-Bank" -- each contribute their balance
// instead of the most recently active one hiding the other.
// Which properties count in the totals: a display choice only, kept in this
// browser (localStorage), off by default.
function mpRealEstateIncluded(id) {
  try { return JSON.parse(localStorage.getItem('mp_re_in_total') || '[]').includes(id); } catch (_) { return false; }
}
function mpSetRealEstateIncluded(id, on) {
  try {
    const ids = new Set(JSON.parse(localStorage.getItem('mp_re_in_total') || '[]'));
    if (on) ids.add(id); else ids.delete(id);
    localStorage.setItem('mp_re_in_total', JSON.stringify([...ids]));
  } catch (_) { /* no storage: stays off */ }
}

// The same read asked for by several tables of one load (the holdings, the
// balances -- three times each, ~0.2 s a round trip from Tbilisi) goes to the
// database once: its answer is kept for MP_ONCE_MS, each caller getting its
// own copy of the rows (they're changed in place downstream). An error isn't
// kept.
const MP_ONCE_MS = 5000;
const mpOnceCache = new Map();
async function mpOnce(key, query) {
  const hit = mpOnceCache.get(key);
  if (!hit || Date.now() - hit.at > MP_ONCE_MS) mpOnceCache.set(key, { at: Date.now(), result: Promise.resolve(query()) });
  const res = await mpOnceCache.get(key).result;
  if (res.error) mpOnceCache.delete(key);
  return { ...res, data: Array.isArray(res.data) ? res.data.map(r => ({ ...r })) : res.data };
}

// Real estate (real_estate_value view): one row per property, account 'real
// estate', asset class 'real_estate', valued in its currency (RUB) and
// converted with the same FX map.
async function mpFetchRealEstateRows(fxByCurrency) {
  const { data, error } = await mpOnce('real_estate_value:brief', () => sb.from('real_estate_value').select('id, name, currency, current_value'));
  if (error || !data?.length) return [];
  const missing = [...new Set(data.map(r => r.currency))].filter(c => !(c in fxByCurrency));
  if (missing.length) Object.assign(fxByCurrency, await mpFetchFxByCurrency(missing));
  return data.map(r => ({
    account: 'real estate', ticker: `REAL_ESTATE:${r.id}`, currency: r.currency, underlying_currency: r.currency, instrument_type: 'real_estate',
    excluded: !mpRealEstateIncluded(r.id),
    value_usd: r.current_value !== null && r.currency in fxByCurrency ? Number(r.current_value) * fxByCurrency[r.currency] : null,
  }));
}

async function mpRenderRealEstate() {
  const wrap = document.getElementById('mp_re_wrap');
  const { data, error } = await sb.from('real_estate_value').select('*').order('purchase_month');
  if (error) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(error.message)}</p>`; return; }
  if (!data.length) { wrap.innerHTML = '<p class="empty-note">No properties yet.</p>'; return; }
  const fmt = n => n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const month = d => d ? d.slice(0, 7) : '—';
  wrap.innerHTML = `<table class="data-table"><thead><tr>
    <th>In total</th><th>Property</th><th>City</th><th>Bought</th><th>Price paid</th><th>₽/m² then</th><th>₽/m² now</th><th>Value now</th><th></th>
  </tr></thead><tbody>${data.map(r => `<tr>
    <td style="text-align:center"><input type="checkbox" data-re-include="${r.id}" ${mpRealEstateIncluded(r.id) ? 'checked' : ''}
      title="Count this property in the portfolio totals"></td>
    <td class="ticker">${mpEscapeHtml(r.name)}</td>
    <td>${mpEscapeHtml(r.city === 'nizhny_novgorod' ? 'Nizhny Novgorod' : r.city)}</td>
    <td>${month(r.purchase_month)}</td>
    <td>${fmt(r.purchase_price)} ${mpEscapeHtml(r.currency)}</td>
    <td>${fmt(r.purchase_price_per_m2)}</td>
    <td>${fmt(r.latest_price_per_m2)} <span class="zero">(${month(r.latest_month)})</span></td>
    <td><b>${fmt(r.current_value)} ${mpEscapeHtml(r.currency)}</b></td>
    <td><button class="btn" data-re-delete="${r.id}" title="Remove">✕</button></td>
  </tr>`).join('')}</tbody></table>`;
  wrap.querySelectorAll('[data-re-include]').forEach(box => box.addEventListener('change', () => {
    mpSetRealEstateIncluded(box.dataset.reInclude, box.checked);
    mpRenderBrokerCurrency(); mpRenderBrokerAssetClass();
  }));
  wrap.querySelectorAll('[data-re-delete]').forEach(btn => btn.addEventListener('click', async () => {
    const { error: delErr } = await sb.from('real_estate').delete().eq('id', btn.dataset.reDelete);
    document.getElementById('mp_re_status').textContent = delErr ? `Error: ${delErr.message}` : 'Removed.';
    mpRenderRealEstate(); mpRenderBrokerCurrency(); mpRenderBrokerAssetClass();
  }));
}

document.getElementById('mp_re_add').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_re_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  const name = document.getElementById('mp_re_name').value.trim() || 'Property';
  const city = document.getElementById('mp_re_city').value;
  const price = Number(document.getElementById('mp_re_price').value);
  const month = document.getElementById('mp_re_month').value;   // "2017-05"
  if (!(price > 0) || !/^\d{4}-\d{2}$/.test(month)) { statusEl.textContent = 'Enter the purchase price and month.'; return; }
  const { data: idx } = await sb.from('real_estate_index').select('price_per_m2').eq('city', city).eq('month', `${month}-01`).maybeSingle();
  if (!idx) { statusEl.textContent = `No price per m² for ${month} in this city yet — the index may not have been loaded.`; return; }
  const { error } = await sb.from('real_estate').insert({
    user_id: session.user.id, name, city, purchase_price: price, currency: 'RUB', purchase_month: `${month}-01`,
  });
  statusEl.textContent = error ? `Error: ${error.message}` : `Added: ${name}, bought ${month} at ${Number(idx.price_per_m2).toLocaleString('ru-RU')} ₽/m².`;
  mpRenderRealEstate(); mpRenderBrokerCurrency(); mpRenderBrokerAssetClass();
});

async function mpFetchCashRows(fxByCurrency) {
  // One row per (account, currency, external_source): its latest balance
  // (the bank_latest_balances view picks it -- reading every
  // bank_transactions row here instead would hit the API's 1000-row cap).
  const { data, error } = await mpOnce('bank_latest_balances', () => sb.from('bank_latest_balances')
    .select('account, currency, balance_after, tx_date, external_source, product'));
  if (error || !data) return [];
  // Rates for currencies the caller didn't ask for (Revolut's AED / HUF / ILS
  // pockets): fetched here and added to the caller's map, so its native-unit
  // display has them too.
  const missing = [...new Set(data.map(r => r.currency))].filter(c => !(c in fxByCurrency));
  if (missing.length) Object.assign(fxByCurrency, await mpFetchFxByCurrency(missing));
  // A credit card's balance goes to its own 'credit' column, which only
  // ever holds zero or negative amounts (debt); an overpaid card's positive
  // balance is just cash. Everything else is 'cash'.
  // (of the cash, what sits on a brokerage account -- the broker's report or
  // app rows, product brokerage_cash -- rather than a bank's card or account:
  // the salary plan's "spend Russian brokers' cash")
  const totals = new Map();
  const add = (account, currency, type, amount, broker = false) => {
    const key = `${account} ${currency} ${type}`;
    const t = totals.get(key) || { account, currency, type, balance: 0, broker: 0 };
    t.balance += amount;
    if (broker) t.broker += amount;
    totals.set(key, t);
  };
  const isBroker = r => r.product === 'brokerage_cash' || /broker|^tbank_api:/.test(r.external_source || '');
  for (const r of data) {
    const bal = Number(r.balance_after);
    // Revolut's precious-metal pockets (currency XAU, ...) are holdings, not
    // cash: import-revolut-statement writes them to trades too (ticker XAU),
    // priced as gold -- counting the pocket here as well would double it.
    if (['XAU', 'XAG', 'XPT', 'XPD'].includes(r.currency)) continue;
    if (r.product === 'credit_card') {
      add(r.account, r.currency, 'credit', Math.min(bal, 0));
      if (bal > 0) add(r.account, r.currency, 'cash', bal);
    } else {
      add(r.account, r.currency, 'cash', bal, isBroker(r));
    }
  }
  // A receipt paid from an account (the bank chosen for it) is a payment out of it, but its row has no
  // balance of its own: it comes after the account's last balance row, so it is taken off that balance.
  try {
    const { data: paid } = await sb.from('bank_transactions').select('account, currency, amount, tx_date')
      .eq('external_source', 'receipt_csv').is('balance_after', null);
    for (const x of paid || []) {
      const last = data.filter(r => r.account === x.account && r.currency === x.currency && r.product !== 'credit_card')
        .reduce((m, r) => (!m || r.tx_date > m.tx_date ? r : m), null);
      if (last && x.tx_date > last.tx_date) add(x.account, x.currency, 'cash', Number(x.amount));
    }
  } catch { /* the balances without the receipts */ }
  if (!totals.size) return [];

  return [...totals.values()].map(t => ({
    account: t.account,
    currency: t.currency,
    instrument_type: t.type,
    value_usd: t.currency in fxByCurrency ? t.balance * fxByCurrency[t.currency] : null,
    broker_usd: t.currency in fxByCurrency ? t.broker * fxByCurrency[t.currency] : null,
  }));
}

// crypto/metal holdings (asset_class 'crypto' or 'gold' -- see
// update-market-prices' isGold split) are quoted in USD in market_prices
// (there's no "BTC currency"), so unlike a plain cash balance they can't
// be grouped by the `currency` column -- that would dump every coin into
// a single misleading "USD" bucket. Each such row's own ticker (BTC, ETH,
// XAU, ...) becomes its display-unit column instead, alongside the
// ISO-currency columns everything else uses.
// XAUT (Tether Gold, an ERC-20 redeemable 1-for-1 for a troy ounce of
// physical gold) tracks the same spot price as XAU -- this table cares
// about "how much gold exposure", not which wrapper holds it, so XAUT's
// USD value folds into the XAU column instead of getting its own.
const MP_UNIT_QUOTED_ASSET_CLASSES = new Set(['crypto', 'gold']);
// Display only: in the broker x currency table every crypto other than these
// shares one "Altcoins" column (TAO, CRO, TRX, ADI, FLR, on-chain tokens, ...),
// shown in USD since the coins have no common unit. GRAM (Telegram's coin,
// prev. Toncoin) gets its own column (user's choice).
const MP_MAJOR_CRYPTO_COLUMNS = new Set(['BTC', 'ETH', 'SOL', 'GRAM']);
const MP_ALTCOINS_COLUMN = 'Altcoins';
// Charts only: a staked coin is the coin itself -- tsTON (Tonstakers' staked
// TON) is drawn as GRAM. The tables keep it apart (its price isn't GRAM's).
const MP_CHART_COIN_OF = { TSTON: 'GRAM' };
const mpChartCoin = t => MP_CHART_COIN_OF[t] || t;
function mpBrokerCurrencyUnit(r) {
  // any gold -- XAUT, a gold fund (TGLD) -- is the XAU column, its USD value in ounces at XAU's price
  if (r.ticker === 'XAUT' || r.asset_class === 'gold') return 'XAU';
  if (r.asset_class === 'crypto' && !MP_MAJOR_CRYPTO_COLUMNS.has(r.ticker)) return MP_ALTCOINS_COLUMN;
  // underlying_currency (not currency) so CNY-denominated MOEX funds like
  // SBBY/TLCB/AMNY land in the CNY column instead of RUB, which is only
  // the exchange's quote currency, not what the fund's holdings are in.
  return MP_UNIT_QUOTED_ASSET_CLASSES.has(r.asset_class) ? r.ticker : (r.underlying_currency || r.currency);
}

// The rows behind the broker x currency / asset-class tables (and the
// Charts tab): holdings with prices, bank balances, real estate, and the
// USD rate of every currency / crypto unit they're shown in.
async function mpLoadPortfolioBase() {
  const { data, error } = await mpOnce('portfolio_value_usd_by_account', () => sb.from('portfolio_value_usd_by_account').select('*'));
  if (error) throw error;
  const currencies = [...new Set(data.map(r => r.underlying_currency || r.currency)), 'USD', 'EUR', 'GBP', 'RUB', 'CNY', 'TRY', 'RSD', 'GEL'];
  const fxByCurrency = await mpFetchFxByCurrency(currencies);
  // Fold in a USD-per-unit rate for each crypto/metal ticker too, straight
  // from this same query's own price_usd -- no second round-trip needed,
  // since portfolio_value_usd_by_account already joins market_prices.
  // Keyed by mpBrokerCurrencyUnit (not the raw ticker) so XAUT's price
  // lands under the merged 'XAU' key too -- needed for the native-unit
  // display to still work when there's no separate real XAU holding.
  for (const r of data) {
    // no per-unit rate for the mixed Altcoins column -- it's shown in USD
    // (gold's ounce price from XAU / XAUT only: a gold fund's unit price isn't an ounce's)
    if (MP_UNIT_QUOTED_ASSET_CLASSES.has(r.asset_class) && r.price_usd !== null && mpBrokerCurrencyUnit(r) !== MP_ALTCOINS_COLUMN
      && (r.asset_class !== 'gold' || r.ticker === 'XAU' || r.ticker === 'XAUT')) {
      fxByCurrency[mpBrokerCurrencyUnit(r)] = r.price_usd;
    }
  }
  const cashRows = await mpFetchCashRows(fxByCurrency);
  const realEstateRows = await mpFetchRealEstateRows(fxByCurrency);
  return { data, fxByCurrency, cashRows, realEstateRows };
}

// The broker x currency table's rows: funds split by what they hold, each
// row's currency column (European currencies as EUR, the rest of the fiat
// outside the main columns as "others").
async function mpCurrencyRows(base) {
  const split = await mpSplitFundsByCurrency(base.data);
  return [...split, ...base.cashRows, ...base.realEstateRows].map(r => {
    const unit = mpBrokerCurrencyUnit(r);
    // Other European currencies (CHF, DKK, SEK, ...) count as EUR; fiat
    // outside the main columns (JPY, AED, ...) -> one "others" column, in USD.
    const fiat = !MP_UNIT_QUOTED_ASSET_CLASSES.has(r.asset_class) && unit !== MP_ALTCOINS_COLUMN;
    const ccy = fiat && MP_EUROPEAN_AS_EUR.has(unit) ? 'EUR' : unit;
    // own_currency: the currency itself, kept for the Charts tab, which
    // shows the "others" one by one.
    return { ...r, own_currency: ccy, currency: fiat && !MP_MAIN_CURRENCIES.has(ccy) ? MP_OTHER_CURRENCIES_COLUMN : ccy };
  });
}

async function mpRenderBrokerCurrency() {
  const wrap = document.getElementById('mp_broker_currency_wrap');
  let base;
  try { base = await mpLoadPortfolioBase(); }
  catch (error) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(error.message)}</p>`; return; }
  let rows = await mpCurrencyRows(base);
  const everHeld = await mpEverHeld('currency');
  const render = () => mpRenderBrokerPivot(wrap, rows, 'currency', 'No holdings yet — import trades above.', base.fxByCurrency, everHeld);
  render();
  // Too wide for the page: the column holding the least (in USD) folds into
  // "others" (a fiat currency) or "Altcoins" (a coin), one at a time until the
  // table fits. USD, EUR, RUB, BTC and ETH always keep their own columns, as
  // do XAU and the two folded columns themselves. (Hidden -- width 0 -- it's
  // left as is.)
  const keep = new Set(['USD', 'EUR', 'RUB', 'BTC', 'ETH', 'XAU', MP_OTHER_CURRENCIES_COLUMN, MP_ALTCOINS_COLUMN]);
  const tooWide = () => wrap.clientWidth > 0 && (wrap.querySelector('table')?.offsetWidth ?? 0) > wrap.clientWidth;
  while (tooWide()) {
    const sums = new Map();
    for (const r of rows) {
      if (keep.has(r.currency) || !r.value_usd) continue;
      const fiat = !MP_UNIT_QUOTED_ASSET_CLASSES.has(r.asset_class);
      if (!fiat && r.asset_class !== 'crypto') continue;   // a metal stays
      const s = sums.get(r.currency) ?? { usd: 0, fiat };
      s.usd += Math.abs(r.value_usd);
      sums.set(r.currency, s);
    }
    if (!sums.size) break;
    const [ccy, { fiat }] = [...sums].sort((a, b) => a[1].usd - b[1].usd)[0];
    const to = fiat ? MP_OTHER_CURRENCIES_COLUMN : MP_ALTCOINS_COLUMN;
    rows = rows.map(r => (r.currency === ccy ? { ...r, currency: to } : r));
    for (const k of [...everHeld]) if (k.endsWith(` ${ccy}`)) everHeld.add(`${k.slice(0, -ccy.length)}${to}`);
    render();
  }
}
// a narrower window folds more columns, a wider one brings them back; also
// redrawn when the tab that holds it is first shown (its width was 0)
{
  const wrap = document.getElementById('mp_broker_currency_wrap');
  let width = wrap.clientWidth, timer;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (wrap.clientWidth === width || !wrap.clientWidth || !wrap.innerHTML) return;
      width = wrap.clientWidth;
      mpRenderBrokerCurrency();
    }, 300);
  }).observe(wrap);
}

// Funds whose value is split across currency columns by what they hold
// (fund_currency_weights: the trading currency of each holding) instead of
// sitting whole in the fund's own quote currency.
const MP_SPLIT_BY_CURRENCY_FUNDS = new Set(['VWRA', 'VWCE', 'XSX6']);
const MP_MAIN_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'RUB', 'TRY', 'RSD', 'GEL', 'CNY']);
const MP_OTHER_CURRENCIES_COLUMN = 'Others';
// European currencies other than GBP (and RSD / TRY / GEL, which have columns of their own).
const MP_EUROPEAN_AS_EUR = new Set(['CHF', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ISK', 'HRK']);
async function mpSplitFundsByCurrency(rows) {
  if (!rows.some(r => MP_SPLIT_BY_CURRENCY_FUNDS.has(r.ticker))) return rows;
  const { data: weights, error } = await mpOnce('fund_currency_weights:split', () => sb.from('fund_currency_weights').select('*')
    .in('fund', [...MP_SPLIT_BY_CURRENCY_FUNDS]));
  if (error || !weights?.length) return rows;
  const byFund = {};
  for (const w of weights) (byFund[w.fund] ??= []).push(w);
  return rows.flatMap(r => {
    const ws = MP_SPLIT_BY_CURRENCY_FUNDS.has(r.ticker) && r.value_usd !== null ? byFund[r.ticker] : null;
    if (!ws) return [r];
    const total = ws.reduce((s, w) => s + Number(w.weight), 0);
    // The fund's cash / derivatives line ('Various') stays in the fund's own currency.
    return ws.map(w => {
      const ccy = w.currency === 'Various' ? (r.underlying_currency || r.currency) : w.currency;
      return { ...r, underlying_currency: ccy, currency: ccy, value_usd: r.value_usd * Number(w.weight) / total };
    });
  });
}

async function mpRenderBrokerAssetClass() {
  const wrap = document.getElementById('mp_broker_assetclass_wrap');
  const { data, error } = await mpOnce('portfolio_value_usd_by_account', () => sb.from('portfolio_value_usd_by_account').select('*'));
  if (error) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(error.message)}</p>`; return; }
  const fxByCurrency = await mpFetchFxByCurrency(['USD', 'EUR', 'GBP', 'RUB', 'CNY', 'TRY', 'RSD', 'GEL']);
  const cashRows = await mpFetchCashRows(fxByCurrency);
  const realEstateRows = await mpFetchRealEstateRows(fxByCurrency);
  const split = await mpSplitFundsCash(data);
  // in roubles at today's rate when chosen (the choice kept in this browser)
  const rub = document.getElementById('assetclass_ccy').value === 'RUB' && fxByCurrency.RUB;
  const money = rub ? Object.assign(usd => mpFormatCurrency(usd / fxByCurrency.RUB, 'RUB'), { unit: 'RUB' }) : mpFormatUsd;
  // the emergency fund in a column of its own when switched on (kept in this browser)
  const rows = [...split, ...cashRows, ...realEstateRows];
  const cushion = document.getElementById('assetclass_cushion').checked;
  if (cushion) {
    try { await mpCushionEnsure(); } catch (e) { wrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(e.message)}</p>`; return; }
  }
  const everHeld = await mpEverHeld('instrument_type');
  // (a cell the fund emptied -- all of Wise's cash -- shows a grey 0, not an
  // ever-held "$0.00": nothing's gone, it's all in the fund)
  const moved = new Set(rows.filter(mpCushionWhole).map(r => `${r.account} ${r.instrument_type}`));
  const shown = cushion ? new Set([...everHeld].filter(k => !moved.has(k))) : everHeld;
  mpRenderBrokerPivot(wrap, cushion ? mpWithCushion(rows) : rows,
    'instrument_type', 'No holdings yet — import trades above.', undefined, shown, money);
  if (cushion) mpRenderCushionSources(wrap, rows, money);
}

// Under the table, with the emergency fund on: what it takes whole, each a switch -- an
// account's cash, or its liquid assets (but Revolut's funds, which top it up to its $10,000)
function mpRenderCushionSources(wrap, rows, money) {
  const by = new Map();
  for (const r of rows) {
    if (r.instrument_type !== 'cash' && r.instrument_type !== 'liquid') continue;
    if (r.instrument_type === 'liquid' && r.account === 'Revolut') continue;
    const k = `${r.account}|${r.instrument_type}`;
    by.set(k, (by.get(k) || 0) + (Number(r.value_usd) || 0));
  }
  for (const k of mpCushionSources) if (!by.has(k)) by.set(k, 0);
  const items = [...by.entries()].filter(([k, v]) => v > 0.005 || mpCushionSources.has(k))
    .sort((a, b) => Number(mpCushionSources.has(b[0])) - Number(mpCushionSources.has(a[0])) || b[1] - a[1]);
  const box = document.createElement('div');
  box.className = 'empty-note';
  box.append('Emergency fund takes whole: ');
  items.forEach(([k, v], i) => {
    const [account, type] = k.split('|');
    const label = document.createElement('label');
    label.style.whiteSpace = 'nowrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = mpCushionSources.has(k);
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const { error } = cb.checked
        ? await sb.from('cushion_sources').insert({ account, instrument_type: type })
        : await sb.from('cushion_sources').delete().eq('account', account).eq('instrument_type', type);
      if (error) { cb.checked = !cb.checked; cb.disabled = false; alert(error.message); return; }
      if (cb.checked) mpCushionSources.add(k); else mpCushionSources.delete(k);
      mpRenderBrokerAssetClass();
    });
    label.append(cb, ` ${MP_BROKER_SHORT_NAMES[account] || account} ${type === 'liquid' ? 'savings' : 'cash'} ${money(v)}`);
    if (i) box.append(' · ');
    box.append(label);
  });
  box.append(`. The rest up to ${money(MP_CUSHION_USD)}: Revolut's funds -- euro, then dollar, then pound.`);
  wrap.appendChild(box);
}
try { const v = localStorage.getItem('mp_assetclass_ccy'); if (v) document.getElementById('assetclass_ccy').value = v; } catch { /* no storage */ }
try { document.getElementById('assetclass_cushion').checked = localStorage.getItem('mp_assetclass_cushion') === '1'; } catch { /* no storage */ }
document.getElementById('assetclass_ccy').addEventListener('change', e => {
  mpSave('mp_assetclass_ccy', e.target.value);
  if (mpIsSignedIn) mpRenderBrokerAssetClass();
});
document.getElementById('assetclass_cushion').addEventListener('change', e => {
  mpSave('mp_assetclass_cushion', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderBrokerAssetClass();
});

