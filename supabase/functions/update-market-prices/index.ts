// Supabase Edge Function: update-market-prices
//
// Daily fetcher for the `market_prices` table -- current, USD-converted
// prices for every ticker that can appear in ANY user's imported broker
// trades (see supabase/functions/import-trades-csv/index.ts and the
// `current_holdings` view in supabase/migrations/20250101000003_holdings_view.sql).
//
// This is a TypeScript port of the former erp_valuation/fetch_portfolio_prices.py
// script. That script (and the GitHub Actions workflow that ran it,
// .github/workflows/market_prices_update.yml) have been deleted -- this
// function is now the ONLY thing that updates market_prices, and it is
// triggered entirely from within Supabase via pg_cron + pg_net (see
// supabase/migrations/20250101000005_schedule_market_prices.sql), not
// GitHub Actions. The frontend (index.html) only ever reads the finished
// `portfolio_value_usd` view via supabase-js.
//
// Ticker universe
// ----------------
// Rather than hardcode the ticker list, this function first asks Supabase
// for the DISTINCT tickers actually present across all users' `trades`
// (via a service-role client, which bypasses RLS -- this is the one place
// in the repo that is allowed to see cross-user data, and it only ever
// reads the `ticker` column, never quantities/prices/user_id). That makes
// the function self-updating: any ticker in any future CSV import gets
// picked up automatically, with no code change.
//
// If that query fails or comes back empty, it falls back to SEED_TICKERS
// below -- the tickers observed in a real sample export, kept here only as
// a reasonable bootstrap/offline-dev set, not as the supported universe.
//
// Asset classes
// -------------
// Each ticker is classified into one of:
//   - moex: Russian shares, MOEX-listed ETFs/BPIFs, corporate bonds (ISIN
//     prefix RU000A...) and OFZ government bonds (ISIN prefix SU...).
//     Priced via the MOEX ISS API (iss.moex.com, free, no auth).
//   - crypto: BTC, ETH, XAU, XAUT, or any other symbol that isn't
//     conclusively MOEX and resolves against Yahoo's <TICKER>-USD symbol.
//   - western_etf: UCITS ETFs (VUAA, VWCE, VWRA, CSPX, XSX6, ...) that
//     don't resolve on the plain Yahoo US endpoint -- resolved best-effort
//     by trying a handful of common exchange suffixes.
//   - us_stock: anything else, fetched from the plain Yahoo Finance chart
//     endpoint.
//
// Any ticker that fails to resolve anywhere is simply skipped (with a
// logged reason) -- it will show up in `current_holdings` with a quantity
// but no matching row in `market_prices`, and `portfolio_value_usd` already
// handles that gracefully (null price/value via a left join).
//
// Currency conversion
// --------------------
// MOEX prices in RUB are converted to USD using the latest official
// Bank of Russia (CBR) USD/RUB rate, fetched fresh from CBR's XML API on
// every run (an Edge Function has no access to this repo's
// data/usd_rub_history.csv, which is what the Python version reused --
// so this hits the same ultimate data source, CBR, directly instead). Any
// other native currency (EUR for most Western ETFs, but also e.g. CNY for
// some MOEX-listed corporate bonds) is converted generically via Yahoo's
// <CCY>USD=X pair, fetched on demand and cached per run.
//
// Invocation
// ----------
// Two ways, both handled identically (no end-user JWT is required or
// checked -- there is no per-user context for a market-data refresh):
//   (a) pg_cron, on a daily schedule, via net.http_post with the service
//       role key as a bearer token (see the scheduling migration). This
//       function is deployed with --no-verify-jwt (see
//       .github/workflows/supabase_deploy.yml), so Supabase's
//       platform-level JWT gate doesn't reject the cron caller, which has
//       no end-user session to present.
//   (b) Manually, e.g. `supabase functions invoke update-market-prices`,
//       for testing -- also with the service role (or anon) key as bearer.
//
// This function ALWAYS uses its own service-role client (from the
// SUPABASE_SERVICE_ROLE_KEY env var Supabase injects automatically into
// every Edge Function) to read trades and write market_prices, regardless
// of which key the caller authenticated with -- this table is not
// per-user data, and the anon key cannot write to it (see the migration's
// RLS policy).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const MOEX_ISS_BASE = 'https://iss.moex.com/iss';
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CBR_DYNAMIC_URL = 'https://www.cbr.ru/scripts/XML_dynamic.asp';
const CBR_USD_CODE = 'R01235';

const REQUEST_TIMEOUT_MS = 20_000;
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// The "My Portfolio" tab's target-weight tickers (US_STOCK_TICKERS /
// RU_STOCK_TICKERS in index.html) -- kept in sync manually, same as
// SEED_TICKERS below. Always fetched in addition to whatever's actually in
// `trades`, so a ticker that's in the target allocation but not yet held
// (e.g. current=$0, waiting to be bought) still gets a real price instead
// of showing "n/a" in the Price / share column and being unbuyable by the
// lot-aware allocator.
const TARGET_UNIVERSE_TICKERS = [
  'SBER', 'YDEX', 'T', 'DOMRF', 'TRND', 'OZON', 'AKME', 'AKFN', 'ROSN', 'VTBR', 'GMKN', 'PLZL', 'IRAO',
  'GOOGL', 'NVDA', 'LLY', 'CAT', 'LIN', 'GE', 'AMZN', 'WMT', 'XOM', 'NEE', 'PLD',
  'JPM', 'BRK-B', 'JNJ', 'META', 'V', 'MA', 'HOOD', 'MSFT', 'AAPL', 'ABBV',
  'TSLA', 'HD', 'PG', 'KO', 'SHEL', 'CVX', 'SHW', 'DUK', 'AMT', 'SOFI', 'XYZ',
  'INTC', 'SPCX', 'FCX', 'SO', 'EQIX',
];

// Bootstrap/offline-dev ticker set only -- used solely as a fallback when
// the Supabase distinct-ticker query is unavailable or empty. NOT the
// supported universe; see module docstring.
const SEED_TICKERS = [
  'AKFN', 'AKMB', 'AKME', 'AKMM', 'AMNY', 'CSPX', 'DOMRF', 'GMKN', 'GOOGL',
  'IRAO', 'META', 'MSFT', 'MU', 'NVDA', 'OZON', 'PLZL', 'ROSN',
  'RU000A1008Y3', 'RU000A103661', 'RU000A1043K9', 'RU000A105104',
  'RU000A1057D4', 'RU000A105L27', 'RU000A1069P3', 'RU000A10AAQ4',
  'RU000A10ANZ8', 'RU000A10AZ45', 'RU000A10C5L7', 'RU000A10CKZ0',
  'RU000A10CMT9', 'RU000A10D2Y6', 'RU000A10D3S6', 'RU000A10D616',
  'RU000A10DD30', 'RU000A10DDR0', 'RU000A10DT08', 'RU000A10E6D0',
  'RU000A10EA08', 'RU000A10EF52', 'RU000A10EMU3', 'RU000A10EYG7',
  'RU000A10EYY0', 'RU000A10F7L0', 'RU000A10F827', 'SAFE', 'SBBY', 'SBER',
  'SBMM', 'SNAP', 'SPCX', 'SU26212RMFS9', 'SU26237RMFS6', 'SU26244RMFS2',
  'SU26246RMFS7', 'SU26247RMFS5', 'SU26248RMFS3', 'SU26251RMFS7',
  'SU29007RMFS0', 'SU29008RMFS8', 'SU29015RMFS3', 'SU29020RMFS3',
  'SU29021RMFS1', 'T', 'TBRU', 'TLCB', 'TRND', 'TSEM', 'VTBR', 'VUAA',
  'VWCE', 'VWRA', 'WMT', 'XSX6', 'YDEX',
  'BTC', 'ETH', 'XAU', 'XAUT',
];

// ISIN prefixes that identify MOEX-traded debt instruments generically.
const MOEX_OFZ_ISIN_PREFIX = 'SU';
const MOEX_CORP_BOND_ISIN_PREFIX = 'RU000A';

// Yahoo suffixes tried, in order, for Western-exchange ETFs that don't
// resolve on the plain (US) Yahoo symbol. Best-effort: whichever responds
// first with a real price wins -- but a UCITS ETF often lists on several
// of these exchanges at once in different currencies (e.g. XSX6 trades on
// both LSE in GBp and Xetra in EUR), and this list has no way to know
// which specific listing a given user actually holds; it just picks
// whichever exchange happens to be tried first (.L) and answers fastest.
// WESTERN_ETF_EXCHANGE_OVERRIDE lets a specific ticker skip the generic
// suffix search entirely and go straight to the listing the user actually
// holds -- user-confirmed, same pattern as UNDERLYING_CURRENCY_BY_TICKER.
const WESTERN_ETF_SUFFIXES = ['.L', '.DE', '.AS', '.SW', '.MI', '.PA'];
const WESTERN_ETF_EXCHANGE_OVERRIDE: Record<string, string> = { XSX6: '.DE' };

// Yahoo symbol overrides for crypto/metal tickers that don't follow the
// plain <TICKER>-USD convention.
const CRYPTO_YAHOO_OVERRIDES: Record<string, string> = {
  XAU: 'GC=F', // gold spot has no clean Yahoo FX symbol; COMEX gold
               // futures (USD/troy oz) is the closest reliable proxy
};
const KNOWN_CRYPTO_TICKERS = new Set([
  'BTC', 'ETH', 'XAU', 'XAUT', 'SOL', 'USDT', 'USDC', 'BNB', 'XRP', 'DOGE', 'ADA', 'TON',
]);

// Only these ISS "group" values represent an instrument actually traded on
// a real cash equities/bonds market (as opposed to an index/iNAV
// calculation, an OTC/repo quote board, an FX cross, a derivative, etc.).
// The free-text `q=` search matches loosely (e.g. searching "GOOGL" also
// turns up an unrelated OTC quote board entry, "MU" turns up an RTSI index
// basket) -- restricting to these groups plus an exact SECID match is what
// keeps that noise from being mistaken for a real MOEX-traded instrument.
const MOEX_TRADEABLE_GROUPS = new Set(['stock_shares', 'stock_ppif', 'stock_bonds']);

// MOEX's CURRENCYID/FACEUNIT uses 'SUR' as its internal code for Russian
// rubles (a holdover from the pre-1998 ruble); normalized to the standard
// ISO code 'RUB' before storing/displaying it.
function normalizeCurrency(currency: string | null | undefined): string | null {
  if (!currency) return currency ?? null;
  return currency.toUpperCase() === 'SUR' ? 'RUB' : currency;
}

// Yahoo quotes some exchanges in a minor unit rather than the major
// currency unit, and marks that with a lowercase second letter in the
// currency code (its normal codes are all-uppercase ISO-4217, e.g. "USD",
// "EUR"). Confirmed via a real fetch: XSX6 on the LSE (XSX6.L) comes back
// as currency "GBp" (pence, 1/100 GBP) with a price in the thousands, NOT
// "GBP" -- treating that as whole pounds would inflate the USD value
// ~100x. Divide by 100 and use the major-unit ISO code for the FX lookup.
const MINOR_UNIT_CURRENCIES: Record<string, string> = { GBp: 'GBP', ZAc: 'ZAR', ILa: 'ILS' };

// Maps a possibly-minor-unit Yahoo currency code to its major-unit ISO
// equivalent for STORAGE/display purposes (e.g. in market_prices.currency
// and .underlying_currency) -- distinct from toUsd()'s own normalization,
// which additionally rescales the price by /100. Without this, the same
// underlying currency (GBP) could be written as two different strings
// ("GBP" for one ticker, "GBp" for another) depending on which exchange
// quoted it, splitting what should be one currency bucket into two in any
// grouping/breakdown (e.g. the "broker x currency" summary table).
function normalizeMinorUnitCurrency(currency: string | null): string | null {
  if (currency === null) return null;
  return MINOR_UNIT_CURRENCIES[currency] ?? currency;
}

function log(msg: string): void {
  console.log(msg);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, retries = 2): Promise<string | null> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: HTTP_HEADERS, signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
      } else {
        return await resp.text();
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    await sleep(500);
  }
  log(`  fetch failed for ${url}: ${String(lastErr)}`);
  return null;
}

// deno-lint-ignore no-explicit-any
async function fetchJson(url: string): Promise<any | null> {
  const text = await fetchText(url);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    log(`  bad JSON from ${url}: ${String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// USD/RUB conversion -- fetched live from the Bank of Russia (CBR) XML API,
// the same ultimate data source usd_rub_tracker/scripts/update_usd_rub.py
// uses to build data/usd_rub_history.csv. An Edge Function can't read that
// CSV (it isn't part of this deployment), so this hits CBR directly and
// takes the single most recently published rate.
// ---------------------------------------------------------------------------

function ddmmyyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function latestUsdRubRate(): Promise<number | null> {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 10);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 1);

  const url = `${CBR_DYNAMIC_URL}?date_req1=${ddmmyyyy(start)}&date_req2=${ddmmyyyy(end)}&VAL_NM_RQ=${CBR_USD_CODE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let buf: ArrayBuffer;
  try {
    const resp = await fetch(url, { headers: HTTP_HEADERS, signal: controller.signal });
    if (!resp.ok) {
      log(`  CBR fetch failed: HTTP ${resp.status}`);
      return null;
    }
    buf = await resp.arrayBuffer();
  } catch (e) {
    log(`  CBR fetch failed: ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  // CBR serves windows-1251-encoded XML.
  const text = new TextDecoder('windows-1251').decode(buf);
  const records = [...text.matchAll(/<Record Date="(\d{2})\.(\d{2})\.(\d{4})"[^>]*>[\s\S]*?<Value>([\d,]+)<\/Value>/g)];
  if (!records.length) return null;
  // Records are already in ascending date order from CBR; take the last
  // (most recently published, which may be dated "tomorrow" -- CBR
  // publishes a rate in advance for the next business day, same behavior
  // the Python version's data source exhibits).
  const last = records[records.length - 1];
  const rate = parseFloat(last[4].replace(',', '.'));
  return Number.isNaN(rate) ? null : rate;
}

// ---------------------------------------------------------------------------
// Ticker classification
// ---------------------------------------------------------------------------

type TickerClass = 'moex_ofz' | 'moex_bond' | 'moex_share_or_etf_or_other' | 'crypto' | 'deposit' | 'money_market_fund';

// A bank deposit/savings account is represented as a synthetic ticker,
// not an ISIN or a real listed instrument -- e.g. "DEPOSIT:Revolut" for
// Revolut Instant Access Savings. `DEPOSIT_PREFIX_LEGACY_CYRILLIC` covers
// an older ticker convention ("ВКЛАД:Т16%13", bank name/rate/term) already
// present in this user's existing trades from Snowball -- kept working
// rather than requiring a data migration, but new imports use the English
// prefix. Either way, the actual currency lives in that trade's own
// `currency` column, not encoded into the ticker string, since `trades`
// already has a column for exactly that (see fetchDepositCurrencies
// below). `quantity` in `trades` is not a share count -- it's already the
// balance itself, in whatever currency that trade recorded -- so there is
// no per-unit "price" to look up; it just needs an FX conversion factor to
// USD. See how this is used below: price_usd is set via
// fxRateToUsd(currency, ...) so quantity * price_usd (the standard formula
// every other asset class uses) yields the correct USD value without any
// special-casing in the `portfolio_value_usd` view.
const DEPOSIT_PREFIX = 'DEPOSIT:';
const DEPOSIT_PREFIX_LEGACY_CYRILLIC = 'ВКЛАД:';

// Revolut's Flexible Cash Funds are money-market funds (Fidelity
// Institutional Liquidity Fund plc share classes) whose ticker is the
// fund's own ISIN -- not a MOEX or Yahoo-listed instrument, so the generic
// "everything else" resolution path below would spend requests searching
// for it as a US stock/ETF and never find it. Its per-unit price is
// pinned at ~1.00 in its own currency by design (a money-market fund keeps
// its NAV stable, unlike a bond whose price floats with rates), so like a
// bank deposit it only needs an FX conversion, not a real price lookup --
// see the money-market handling below, which mirrors the deposit one.
// User-confirmed list of the three share classes actually held (USD/GBP/
// EUR Class R); a new share class would need to be added here.
const MONEY_MARKET_FUND_ISINS = new Set(['IE000H9J0QX4', 'IE0002RUHW32', 'IE000AZVL3K0']);

// MOEX-listed bond/money-market ETFs (BPIFs) whose holdings are bonds/cash
// instruments, not equities -- but which the generic MOEX group classifier
// (stock_ppif) can't distinguish from an equity ETF like AKME/AKFN/TRND,
// since MOEX's API only exposes an instrument-type code, not the fund's
// underlying asset class. User-confirmed list (from their broker's own
// bond-portfolio breakdown) rather than guessed from fund names, since
// name-based heuristics (e.g. matching "облигации") miss cases like SBBY
// ("БПИФ Фонд Инструменты в юанях" -- no "bond" in the name at all, but
// it's a bond fund) and would need constant upkeep as new funds list.
const MOEX_BOND_ETF_TICKERS = new Set(['TBRU', 'SAFE', 'SBMM', 'AKMB', 'AKMM', 'TLCB', 'SBBY']);

// Of the bond ETFs above, SBBY and TLCB specifically hold CNY/foreign-
// currency bonds even though MOEX quotes their per-unit price in RUB.
// `currency` always stores the honest MOEX quote currency (RUB for both);
// this maps a ticker to what its holdings are actually denominated in,
// written to the separate `underlying_currency` column instead, so
// RUB-vs-non-RUB groupings downstream (e.g. the My Portfolio "CNY weight"
// chart) can tell the two apart without `currency` itself lying about the
// quote. User-confirmed list.
const UNDERLYING_CURRENCY_BY_TICKER: Record<string, string> = { SBBY: 'CNY', TLCB: 'CNY' };

function classifyTicker(ticker: string): TickerClass {
  const t = ticker.toUpperCase();
  if (t.startsWith(DEPOSIT_PREFIX) || t.startsWith(DEPOSIT_PREFIX_LEGACY_CYRILLIC)) return 'deposit';
  if (MONEY_MARKET_FUND_ISINS.has(t)) return 'money_market_fund';
  if (KNOWN_CRYPTO_TICKERS.has(t)) return 'crypto';
  if (t.startsWith(MOEX_CORP_BOND_ISIN_PREFIX)) return 'moex_bond';
  if (t.startsWith(MOEX_OFZ_ISIN_PREFIX) && t.length >= 10 && /\d/.test(t)) return 'moex_ofz';
  // Everything else: try MOEX shares/ETFs first (cheap, single request per
  // batch), fall back to US/crypto/Western-ETF resolution via Yahoo.
  return 'moex_share_or_etf_or_other';
}

// ---------------------------------------------------------------------------
// MOEX ISS fetching
// ---------------------------------------------------------------------------

interface MoexPriceInfo {
  price_rub: number;
  currency: string | null;
  as_of: string | null;
}

// MOEX ISS responses are columnar (parallel `columns`/`data` arrays whose
// per-row values can be string | number | null depending on the column) --
// there is no fixed shape known ahead of time, so a loosely-typed row
// object is used throughout this section rather than `any`.
type MoexRow = Record<string, string | number | null>;

function rowsToObjects(cols: string[], rows: unknown[][]): MoexRow[] {
  return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])) as MoexRow);
}

async function moexFetchSharesBatchOnBoard(tickers: string[], board: string): Promise<Record<string, MoexPriceInfo>> {
  if (!tickers.length) return {};
  const out: Record<string, MoexPriceInfo> = {};
  const joined = tickers.join(',');
  const url =
    `${MOEX_ISS_BASE}/engines/stock/markets/shares/boards/${board}/securities.json` +
    `?securities=${encodeURIComponent(joined)}&iss.meta=off&iss.only=securities,marketdata`;
  const data = await fetchJson(url);
  if (!data) return out;

  const secCols: string[] = data.securities?.columns ?? [];
  const secRows: unknown[][] = data.securities?.data ?? [];
  const secs = rowsToObjects(secCols, secRows);
  const secBySecid: Record<string, MoexRow> = Object.fromEntries(secs.map((s) => [s.SECID, s]));

  const mdCols: string[] = data.marketdata?.columns ?? [];
  const mdRows: unknown[][] = data.marketdata?.data ?? [];
  const mds = rowsToObjects(mdCols, mdRows);
  const mdBySecid: Record<string, MoexRow> = Object.fromEntries(mds.map((m) => [m.SECID, m]));

  for (const [secid, sec] of Object.entries(secBySecid)) {
    const md = mdBySecid[secid] ?? {};
    const price = md.LAST ?? sec.PREVLEGALCLOSEPRICE ?? sec.PREVPRICE;
    if (price === null || price === undefined) continue;
    out[secid] = {
      price_rub: Number(price),
      currency: String(sec.CURRENCYID ?? 'RUB'),
      as_of: sec.PREVDATE === null || sec.PREVDATE === undefined ? null : String(sec.PREVDATE),
    };
  }
  return out;
}

function moexFetchSharesBatch(tickers: string[]): Promise<Record<string, MoexPriceInfo>> {
  // Covers ordinary shares AND MOEX-listed ETFs/BPIFs, which also trade on
  // TQBR (confirmed via ISS securities search, e.g. AKFN/AKMB/TRND).
  return moexFetchSharesBatchOnBoard(tickers, 'TQBR');
}

interface MoexSearchHit {
  secid: string;
  group: string;
  type?: string;
  primary_boardid?: string;
  marketprice_boardid?: string;
}

async function moexResolveViaSearch(ticker: string): Promise<MoexSearchHit | null> {
  // Generic fallback: /iss/securities.json?q=TICKER tells us which
  // engine/market/board this instrument actually trades on (SECID may
  // differ from the query, e.g. bonds are keyed by ISIN). Deliberately
  // strict: requires an exact (case-insensitive) SECID match AND a real
  // tradeable group -- a loose/fuzzy match on an index/OTC/repo board is
  // rejected outright rather than risking a wrong price for an unrelated
  // instrument (e.g. US tickers like GOOGL/MSFT/NVDA/MU/META/SNAP
  // superficially "match" unrelated MOEX OTC quote boards or index
  // baskets and must NOT be treated as MOEX securities).
  const data = await fetchJson(`${MOEX_ISS_BASE}/securities.json?q=${encodeURIComponent(ticker)}&iss.meta=off`);
  if (!data) return null;
  const cols: string[] = data.securities?.columns ?? [];
  const rows: unknown[][] = data.securities?.data ?? [];
  const candidates = rowsToObjects(cols, rows);
  const exact = candidates.filter(
    (c) =>
      String(c.secid ?? '').toUpperCase() === ticker.toUpperCase() &&
      MOEX_TRADEABLE_GROUPS.has(String(c.group ?? '')) &&
      c.primary_boardid,
  );
  const hit = exact[0];
  if (!hit) return null;
  return {
    secid: String(hit.secid),
    group: String(hit.group ?? ''),
    type: hit.type === undefined || hit.type === null ? undefined : String(hit.type),
    primary_boardid: hit.primary_boardid === undefined || hit.primary_boardid === null ? undefined : String(hit.primary_boardid),
    marketprice_boardid: hit.marketprice_boardid === undefined || hit.marketprice_boardid === null ? undefined : String(hit.marketprice_boardid),
  };
}

async function moexListTradedBoards(secid: string): Promise<string[]> {
  // /iss/securities/{secid}.json lists EVERY board a security has ever
  // been listed on, across every market -- this narrows that down to
  // boards worth trying for a price: still-tradeable (is_traded=1), on
  // the actual "shares" market, ordered so the primary board is tried
  // first. Needed because `primary_boardid` from the search endpoint is
  // sometimes stale/wrong for an instrument that has since moved its main
  // liquidity to a different board (e.g. a CNY-denominated BPIF whose
  // real board is TQTY, not TQBR).
  const data = await fetchJson(`${MOEX_ISS_BASE}/securities/${encodeURIComponent(secid)}.json?iss.meta=off&iss.only=boards`);
  if (!data) return [];
  const cols: string[] = data.boards?.columns ?? [];
  const rows: unknown[][] = data.boards?.data ?? [];
  const boards = rowsToObjects(cols, rows);
  const tradeable = boards.filter((b) => b.is_traded === 1 && b.market === 'shares');
  tradeable.sort((a, b) => (a.is_primary === 1 ? 0 : 1) - (b.is_primary === 1 ? 0 : 1));
  return tradeable.map((b) => b.boardid as string);
}

async function moexFetchBond(secid: string, board: string): Promise<MoexPriceInfo | null> {
  // Bonds are quoted as a % of face value, not an absolute price, so the
  // actual RUB value per unit is FACEVALUE * price_pct / 100 (+ accrued
  // interest, NKD, which is excluded here -- this is a market-value
  // snapshot of the bond itself, matching how `cash_flows` already tracks
  // coupon/redemption payments separately).
  const market = 'bonds';
  const url =
    `${MOEX_ISS_BASE}/engines/stock/markets/${market}/boards/${board}/securities/${encodeURIComponent(secid)}.json` +
    `?iss.meta=off&iss.only=securities,marketdata`;
  const data = await fetchJson(url);

  let pricePct: string | number | null = null;
  let facevalue: string | number | null = null;
  let currency: string | number | null = 'RUB';
  let asOf: string | number | null = null;

  if (data) {
    const secCols: string[] = data.securities?.columns ?? [];
    const secRows: unknown[][] = data.securities?.data ?? [];
    const mdCols: string[] = data.marketdata?.columns ?? [];
    const mdRows: unknown[][] = data.marketdata?.data ?? [];
    if (secRows.length) {
      const sec = rowsToObjects(secCols, secRows)[0];
      facevalue = sec.FACEVALUE;
      currency = sec.FACEUNIT ?? sec.CURRENCYID ?? 'RUB';
      asOf = sec.PREVDATE ?? null;
      pricePct = sec.PREVPRICE;
    }
    if (mdRows.length) {
      const md = rowsToObjects(mdCols, mdRows)[0];
      if (md.LAST !== null && md.LAST !== undefined) {
        pricePct = md.LAST;
      }
    }
  }

  if (pricePct === null || pricePct === undefined || facevalue === null || facevalue === undefined) {
    // Not currently traded (matured/delisted/illiquid) -- fall back to
    // the most recent historical session on this board.
    const histUrl =
      `${MOEX_ISS_BASE}/history/engines/stock/markets/${market}/boards/${board}` +
      `/securities/${encodeURIComponent(secid)}.json?iss.meta=off&sort_order=desc&limit=1`;
    const hist = await fetchJson(histUrl);
    if (!hist) return null;
    const cols: string[] = hist.history?.columns ?? [];
    const rows: unknown[][] = hist.history?.data ?? [];
    if (!rows.length) return null;
    const row = rowsToObjects(cols, rows)[0];
    facevalue = facevalue ?? row.FACEVALUE;
    currency = row.FACEUNIT ?? currency;
    asOf = row.TRADEDATE ?? null;
    pricePct = row.LEGALCLOSEPRICE ?? row.CLOSE ?? row.MARKETPRICE2 ?? row.MARKETPRICE3;
  }

  if (pricePct === null || pricePct === undefined || facevalue === null || facevalue === undefined) {
    return null;
  }

  const priceNative = Number(facevalue) * Number(pricePct) / 100.0;
  return { price_rub: priceNative, currency: currency === null ? null : String(currency), as_of: asOf === null ? null : String(asOf) };
}

interface MoexResolved extends MoexPriceInfo {
  secid: string;
  asset_class: string;
}

async function fetchMoexPrices(tickers: string[]): Promise<Record<string, MoexResolved>> {
  // Resolves a mixed list of MOEX candidate tickers (shares, ETFs, corp
  // bonds, OFZ) to {price_rub, currency, as_of, secid, asset_class}. Tries
  // the cheap batched shares/ETF lookup first, then falls back to the
  // generic securities search (which reveals the correct
  // engine/market/board) for anything left over, including all bonds.
  const results: Record<string, MoexResolved> = {};

  log(`MOEX: batch share/ETF lookup for ${tickers.length} candidates...`);
  const shareHits = await moexFetchSharesBatch(tickers);
  for (const [t, info] of Object.entries(shareHits)) {
    const assetClass = MOEX_BOND_ETF_TICKERS.has(t.toUpperCase()) ? 'moex_bond_etf' : 'moex_share_or_etf';
    results[t] = { ...info, secid: t, asset_class: assetClass };
  }
  const remaining = tickers.filter((t) => !(t in results));

  log(`MOEX: resolving ${remaining.length} remaining candidates via securities search...`);
  for (const ticker of remaining) {
    const info = await moexResolveViaSearch(ticker);
    if (info === null) {
      log(`  ${ticker}: not found on MOEX`);
      continue;
    }
    const secid = info.secid;
    const board = info.marketprice_boardid || info.primary_boardid;
    const group = info.group ?? '';
    if (group === 'stock_bonds') {
      if (!board) {
        log(`  ${ticker}: MOEX bond found (${secid}) but no board`);
        continue;
      }
      const bond = await moexFetchBond(secid, board);
      if (bond === null) {
        log(`  ${ticker}: MOEX bond found (${secid}/${board}) but no price data`);
        continue;
      }
      const assetClass = info.type === 'ofz_bond' ? 'moex_ofz' : 'moex_bond';
      results[ticker] = { ...bond, secid, asset_class: assetClass };
    } else if (group === 'stock_shares' || group === 'stock_ppif' || group === 'stock_index') {
      // The board reported by the search endpoint isn't always where the
      // instrument actually has live/last-close data (e.g. a
      // CNY-denominated BPIF whose real liquidity is on TQTY, not the
      // nominal primary board TQBR) -- try every currently-tradeable
      // shares-market board for this secid until one returns a price.
      const otherBoards = (await moexListTradedBoards(secid)).filter((b) => b !== board);
      const boardsToTry = [...(board ? [board] : []), ...otherBoards];
      let hit: Record<string, MoexPriceInfo> | null = null;
      for (const candidateBoard of boardsToTry) {
        hit = await moexFetchSharesBatchOnBoard([secid], candidateBoard);
        if (hit[secid]) break;
        hit = null;
        await sleep(100);
      }
      if (!hit) {
        log(`  ${ticker}: MOEX security found (${secid}) but no market data on any board`);
        continue;
      }
      const assetClass = MOEX_BOND_ETF_TICKERS.has(ticker.toUpperCase()) ? 'moex_bond_etf' : 'moex_share_or_etf';
      results[ticker] = { ...hit[secid], secid, asset_class: assetClass };
    } else {
      log(`  ${ticker}: MOEX group '${group}' not handled, skipping`);
    }
    await sleep(150);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Yahoo Finance fetching (US stocks, crypto/metals, Western ETFs)
// ---------------------------------------------------------------------------

interface YahooHit {
  price: number;
  currency: string | null;
  as_of: string | null;
  symbol?: string;
}

async function yahooFetchSymbol(symbol: string): Promise<YahooHit | null> {
  // Fetches meta (currency, regularMarketPrice, regularMarketTime) for a
  // single Yahoo chart symbol -- only needs the latest quote (meta
  // block), not the full daily series.
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const data = await fetchJson(url);
  if (!data) return null;
  const result = data.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta ?? {};
  const price = meta.regularMarketPrice;
  if (price === null || price === undefined) return null;
  const ts = meta.regularMarketTime;
  const asOf = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
  return { price: Number(price), currency: meta.currency ?? null, as_of: asOf, symbol: meta.symbol };
}

function fetchUsStockPrice(ticker: string): Promise<YahooHit | null> {
  return yahooFetchSymbol(ticker);
}

function fetchCryptoPrice(ticker: string): Promise<YahooHit | null> {
  const symbol = CRYPTO_YAHOO_OVERRIDES[ticker.toUpperCase()] ?? `${ticker.toUpperCase()}-USD`;
  return yahooFetchSymbol(symbol);
}

async function fetchWesternEtfPrice(ticker: string): Promise<YahooHit | null> {
  const override = WESTERN_ETF_EXCHANGE_OVERRIDE[ticker.toUpperCase()];
  if (override) {
    const hit = await yahooFetchSymbol(`${ticker}${override}`);
    return hit ? { ...hit, symbol: hit.symbol ?? `${ticker}${override}` } : null;
  }
  // Best-effort: try common UCITS-ETF exchange suffixes in turn, use
  // whichever first returns a valid quote.
  for (const suffix of WESTERN_ETF_SUFFIXES) {
    const hit = await yahooFetchSymbol(`${ticker}${suffix}`);
    if (hit !== null) {
      return { ...hit, symbol: hit.symbol ?? `${ticker}${suffix}` };
    }
    await sleep(100);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------

const fxCache: Record<string, number | null> = {};

async function fxRateToUsd(currency: string, usdRubRate: number | null): Promise<number | null> {
  // Returns how many USD one unit of `currency` is worth. RUB uses the
  // freshly-fetched CBR rate. Any other currency (EUR, CNY, GBP, ...) is
  // resolved generically via Yahoo's <CCY>USD=X pair and cached for the
  // rest of this run, so MOEX bonds denominated in currencies other than
  // RUB (e.g. CNY-denominated corporate bonds, seen in real data) convert
  // correctly instead of being silently dropped.
  const c = currency.toUpperCase();
  if (c === 'USD') return 1.0;
  if (c === 'RUB' || c === 'SUR') return usdRubRate ? 1.0 / usdRubRate : null;
  if (c in fxCache) return fxCache[c];
  // A single transient failure (network blip, rate limit) shouldn't
  // permanently blank out every asset in this currency for the rest of the
  // run -- only a null result is cached after retrying a few times, not on
  // the first miss.
  let rate: number | null = null;
  for (let attempt = 0; attempt < 3 && rate === null; attempt++) {
    if (attempt > 0) await sleep(300);
    const hit = await yahooFetchSymbol(`${c}USD=X`);
    rate = hit ? hit.price : null;
  }
  fxCache[c] = rate;
  if (rate === null) log(`  no FX rate found for ${c} -> USD after retries`);
  return rate;
}

async function toUsd(price: number, currency: string | null, usdRubRate: number | null): Promise<number | null> {
  if (currency === null) return null;
  let p = price;
  let c = currency;
  if (c in MINOR_UNIT_CURRENCIES) {
    p = p / 100.0;
    c = MINOR_UNIT_CURRENCIES[c];
  }
  const rate = await fxRateToUsd(c, usdRubRate);
  return rate !== null ? p * rate : null;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function fetchDistinctTickers(supabase: any): Promise<string[] | null> {
  // Distinct tickers across ALL users' trades, via the service-role
  // client (bypasses RLS). Only ever reads the `ticker` column -- no
  // quantities, prices, or user_id leave this function. Returns null on
  // any failure (caller falls back to SEED_TICKERS), or a possibly-empty
  // list.
  //
  // Paged in batches of 1000: PostgREST caps an unbounded select() at 1000
  // rows by default, so a single unpaged query silently truncates once
  // `trades` grows past that (as it now can, since each fund-statement
  // interest row is its own trades row) -- some tickers would then never
  // even reach classification, let alone show up as "unresolved".
  const pageSize = 1000;
  const tickers = new Set<string>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('trades')
      .select('ticker')
      .range(from, from + pageSize - 1);
    if (error) {
      log(`  distinct-ticker query failed, will fall back to seed list: ${error.message}`);
      return null;
    }
    // deno-lint-ignore no-explicit-any
    for (const row of data as any[]) {
      if (row.ticker) tickers.add(String(row.ticker).trim());
    }
    if (data.length < pageSize) break;
  }
  return [...tickers].sort();
}

// deno-lint-ignore no-explicit-any
async function fetchTickerCurrencies(supabase: any, tickers: string[]): Promise<Record<string, string>> {
  // A deposit or money-market-fund ticker carries no currency of its own --
  // that lives in `trades.currency` for the rows that use it (a deposit
  // ticker has no ISIN/exchange currency at all; a fund ISIN like
  // IE000H9J0QX4 is shared across USD/GBP/EUR Class R share classes, so the
  // ticker string alone doesn't say which). Reads only ticker+currency
  // (same cross-user, service-role, no-PII pattern as fetchDistinctTickers)
  // and takes whichever currency appears first for each ticker; in practice
  // a given user only ever records a specific ticker in one currency, so
  // "first seen" is just "the" currency.
  if (!tickers.length) return {};
  const { data, error } = await supabase
    .from('trades')
    .select('ticker, currency')
    .in('ticker', tickers);
  if (error) {
    log(`  ticker-currency query failed: ${error.message}`);
    return {};
  }
  const out: Record<string, string> = {};
  // deno-lint-ignore no-explicit-any
  for (const row of data as any[]) {
    if (row.ticker && row.currency && !(row.ticker in out)) {
      out[row.ticker] = String(row.currency).toUpperCase();
    }
  }
  return out;
}

type InfraRegion = 'ru' | 'foreign';
type InstrumentType = 'stock' | 'bond' | 'gold' | 'crypto' | 'fx_rate';

interface PriceRow {
  ticker: string;
  price_usd: number;
  native_price: number | null;
  currency: string | null;
  asset_class: string;
  infra_region: InfraRegion;
  instrument_type: InstrumentType;
  underlying_currency: string | null;
  source: string;
  as_of: string | null;
}

// deno-lint-ignore no-explicit-any
async function upsertMarketPrices(supabase: any, rows: PriceRow[]): Promise<{ upserted: number; error: string | null }> {
  if (!rows.length) return { upserted: 0, error: null };
  // updated_at defaults to now() only on INSERT -- an upsert against an
  // existing row is an UPDATE under the hood, which does NOT re-run the
  // column default, so it must be set explicitly here on every row for
  // updated_at to actually reflect "when this price was last refreshed".
  const nowIso = new Date().toISOString();
  const withTimestamp = rows.map((r) => ({ ...r, updated_at: nowIso }));
  const batchSize = 200;
  let upserted = 0;
  for (let i = 0; i < withTimestamp.length; i += batchSize) {
    const batch = withTimestamp.slice(i, i + batchSize);
    const { error } = await supabase.from('market_prices').upsert(batch, { onConflict: 'ticker' });
    if (error) {
      return { upserted, error: error.message };
    }
    upserted += batch.length;
  }
  return { upserted, error: null };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function runUpdate(): Promise<Record<string, unknown>> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  log('Fetching distinct tickers from Supabase trades...');
  let tickers = await fetchDistinctTickers(supabase);
  if (!tickers || !tickers.length) {
    log('Using SEED_TICKERS fallback list (Supabase query unavailable or empty).');
    tickers = [...SEED_TICKERS];
  } else {
    log(`Found ${tickers.length} distinct tickers across all users' trades.`);
  }
  // Always include the target-allocation universe too, regardless of what
  // any user currently holds -- see TARGET_UNIVERSE_TICKERS.
  tickers = [...new Set([...tickers, ...TARGET_UNIVERSE_TICKERS])].sort();

  const usdRubRate = await latestUsdRubRate();
  log(`Latest USD/RUB rate: ${usdRubRate}`);

  // --- classify ---
  const moexCandidates: string[] = [];
  const cryptoCandidates: string[] = [];
  const depositCandidates: string[] = [];
  const moneyMarketCandidates: string[] = [];
  for (const t of tickers) {
    const cls = classifyTicker(t);
    if (cls === 'moex_ofz' || cls === 'moex_bond' || cls === 'moex_share_or_etf_or_other') {
      moexCandidates.push(t);
    }
    if (cls === 'crypto') {
      cryptoCandidates.push(t);
    }
    if (cls === 'deposit') {
      depositCandidates.push(t);
    }
    if (cls === 'money_market_fund') {
      moneyMarketCandidates.push(t);
    }
  }

  const rowsOut: PriceRow[] = [];
  const resolved = new Set<string>();

  // --- FX rates (<CCY>->USD), published as their own synthetic tickers
  //     "FX:<CCY>" so the frontend can convert any USD-denominated value
  //     back to its own native currency (or convert a plain cash balance,
  //     e.g. a bank statement's EUR/GBP balance_after, which never
  //     appears in `trades` and so has no ticker of its own) without
  //     needing its own copy of FX logic -- it just reads market_prices
  //     like any other price. CASH_FX_CURRENCIES is the closed set of
  //     currencies actually seen across bank statements and holdings
  //     today; extend it if a new currency shows up. ---
  const CASH_FX_CURRENCIES = ['USD', 'EUR', 'GBP', 'RUB', 'CNY', 'TRY'];
  for (const currency of CASH_FX_CURRENCIES) {
    const rate = await fxRateToUsd(currency, usdRubRate);
    if (rate === null) { log(`  FX rate ${currency}->USD: unavailable, skipping FX:${currency}`); continue; }
    rowsOut.push({
      ticker: `FX:${currency}`,
      price_usd: Math.round(rate * 1e8) / 1e8,
      native_price: 1,
      currency,
      asset_class: 'fx_rate',
      infra_region: 'foreign',
      instrument_type: 'fx_rate',
      underlying_currency: currency,
      source: currency === 'USD' ? 'identity' : currency === 'RUB' ? 'cbr_fx' : 'yahoo_fx',
      as_of: new Date().toISOString().slice(0, 10),
    });
    resolved.add(`FX:${currency}`);
  }

  // --- Bank deposits (quantity in `trades` is already the balance in
  //     that trade's own currency, not a unit count -- see classifyTicker).
  //     Currency is per-ticker (fetched from `trades` itself, not guessed
  //     from the ticker string), so this covers RUB deposits (Snowball's
  //     "ВКЛАД:Т16%13") and non-RUB ones (e.g. "ВКЛАД:Revolut" for EUR/USD
  //     Instant Access Savings) with the same code path. ---
  if (depositCandidates.length) {
    const depositCurrencies = await fetchTickerCurrencies(supabase, depositCandidates);
    for (const ticker of depositCandidates) {
      const currency = depositCurrencies[ticker];
      if (!currency) { log(`  deposit ticker ${ticker}: no currency found in trades, skipping`); continue; }
      const rate = await fxRateToUsd(currency, usdRubRate);
      if (rate === null) { log(`  deposit ticker ${ticker}: no ${currency}->USD rate available, skipping`); continue; }
      rowsOut.push({
        ticker,
        price_usd: Math.round(rate * 1e8) / 1e8,
        native_price: 1,
        currency,
        asset_class: 'deposit',
        infra_region: currency === 'RUB' ? 'ru' : 'foreign',
        instrument_type: 'bond',
        underlying_currency: currency,
        source: currency === 'RUB' ? 'cbr_fx' : 'yahoo_fx',
        as_of: new Date().toISOString().slice(0, 10),
      });
      resolved.add(ticker);
    }
  }

  // --- Money-market funds (Revolut Flexible Cash Funds) -- NAV is pinned
  //     at ~1.00 in the fund's own currency by design, so like a deposit
  //     this only needs an FX conversion, not a real price lookup. Unlike
  //     a deposit ticker, the same ISIN can appear in `trades` under more
  //     than one currency in principle (Class R share classes are USD/GBP/
  //     EUR-specific in practice, one currency per ISIN, but the lookup is
  //     still per-ticker rather than assumed). ---
  if (moneyMarketCandidates.length) {
    const fundCurrencies = await fetchTickerCurrencies(supabase, moneyMarketCandidates);
    for (const ticker of moneyMarketCandidates) {
      const currency = fundCurrencies[ticker];
      if (!currency) { log(`  money-market fund ${ticker}: no currency found in trades, skipping`); continue; }
      const rate = await fxRateToUsd(currency, usdRubRate);
      if (rate === null) { log(`  money-market fund ${ticker}: no ${currency}->USD rate available, skipping`); continue; }
      rowsOut.push({
        ticker,
        price_usd: Math.round(rate * 1e8) / 1e8,
        native_price: 1,
        currency,
        asset_class: 'money_market_fund',
        infra_region: 'foreign',
        instrument_type: 'bond',
        underlying_currency: currency,
        source: currency === 'RUB' ? 'cbr_fx' : 'yahoo_fx',
        as_of: new Date().toISOString().slice(0, 10),
      });
      resolved.add(ticker);
    }
  }

  // --- MOEX (shares, ETFs, corp bonds, OFZ) ---
  const moexHits = await fetchMoexPrices(moexCandidates);
  for (const [ticker, info] of Object.entries(moexHits)) {
    const priceNative = info.price_rub;
    const quoteCurrency = normalizeCurrency(info.currency) ?? 'RUB';
    const priceUsd = await toUsd(priceNative, quoteCurrency, usdRubRate);
    if (priceUsd === null) {
      log(`  ${ticker}: MOEX price found but could not convert ${quoteCurrency} -> USD, skipping`);
      continue;
    }
    // `currency` is always the honest MOEX quote currency. MOEX prices
    // some funds' units in RUB even though the fund's actual holdings are
    // foreign-currency bonds (e.g. SBBY/TLCB hold CNY bonds but their
    // per-unit price on MOEX is quoted in RUB) -- that distinction is
    // captured separately in `underlying_currency`, not by changing
    // `currency` itself.
    const instrumentType: InstrumentType =
      (info.asset_class === 'moex_bond' || info.asset_class === 'moex_ofz' || info.asset_class === 'moex_bond_etf')
        ? 'bond'
        : 'stock';
    const underlyingCurrency = UNDERLYING_CURRENCY_BY_TICKER[ticker.toUpperCase()] ?? quoteCurrency;
    rowsOut.push({
      ticker,
      price_usd: Math.round(priceUsd * 1e6) / 1e6,
      native_price: priceNative,
      currency: quoteCurrency,
      asset_class: info.asset_class,
      infra_region: 'ru',
      instrument_type: instrumentType,
      underlying_currency: underlyingCurrency,
      source: 'moex_iss',
      as_of: info.as_of,
    });
    resolved.add(ticker);
  }

  // --- crypto / metals ---
  for (const ticker of cryptoCandidates) {
    const hit = await fetchCryptoPrice(ticker);
    if (hit === null) {
      log(`  ${ticker}: no Yahoo crypto/metal quote found`);
      continue;
    }
    const priceUsd = await toUsd(hit.price, hit.currency ?? 'USD', usdRubRate);
    if (priceUsd === null) {
      await sleep(150);
      continue;
    }
    const cryptoCurrency = normalizeMinorUnitCurrency(hit.currency);
    rowsOut.push({
      ticker,
      price_usd: Math.round(priceUsd * 1e6) / 1e6,
      native_price: hit.price,
      currency: cryptoCurrency,
      asset_class: 'crypto',
      infra_region: 'foreign',
      instrument_type: ticker.toUpperCase() === 'XAU' ? 'gold' : 'crypto',
      underlying_currency: cryptoCurrency,
      source: 'yahoo_finance',
      as_of: hit.as_of,
    });
    resolved.add(ticker);
    await sleep(150);
  }

  // --- everything left over: try as a plain US stock, then as a
  //     Western-exchange ETF with common suffixes ---
  const leftover = tickers.filter(
    (t) => !resolved.has(t) && classifyTicker(t) === 'moex_share_or_etf_or_other' && !(t in moexHits),
  );
  for (const ticker of leftover) {
    let hit = await fetchUsStockPrice(ticker);
    let assetClass = 'us_stock';
    let sourceSymbol = ticker;
    if (hit === null) {
      hit = await fetchWesternEtfPrice(ticker);
      assetClass = 'western_etf';
      if (hit !== null) sourceSymbol = hit.symbol ?? ticker;
    }
    if (hit === null) {
      log(`  ${ticker}: no price found on MOEX or Yahoo (US/Western-ETF) -- skipping`);
      await sleep(150);
      continue;
    }
    const priceUsd = await toUsd(hit.price, hit.currency ?? 'USD', usdRubRate);
    if (priceUsd === null) {
      log(`  ${ticker}: found ${sourceSymbol} but could not convert ${hit.currency} -> USD`);
      await sleep(150);
      continue;
    }
    const leftoverCurrency = normalizeMinorUnitCurrency(hit.currency);
    rowsOut.push({
      ticker,
      price_usd: Math.round(priceUsd * 1e6) / 1e6,
      native_price: hit.price,
      currency: leftoverCurrency,
      asset_class: assetClass,
      infra_region: 'foreign',
      instrument_type: 'stock',
      underlying_currency: leftoverCurrency,
      source: 'yahoo_finance',
      as_of: hit.as_of,
    });
    resolved.add(ticker);
    await sleep(150);
  }

  const unresolved = tickers.filter((t) => !resolved.has(t));
  log(`Resolved ${resolved.size}/${tickers.length} tickers.`);
  if (unresolved.length) {
    log(`Unresolved (${unresolved.length}): ${[...unresolved].sort().join(', ')}`);
  }

  log(`Upserting ${rowsOut.length} rows into market_prices...`);
  const { upserted, error } = await upsertMarketPrices(supabase, rowsOut);

  return {
    total_tickers: tickers.length,
    resolved: resolved.size,
    unresolved: unresolved.sort(),
    upserted,
    upsert_error: error,
    usd_rub_rate: usdRubRate,
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const summary = await runUpdate();
    const status = summary.upsert_error ? 500 : 200;
    return new Response(JSON.stringify(summary), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
