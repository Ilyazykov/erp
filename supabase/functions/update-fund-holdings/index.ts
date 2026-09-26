// Supabase Edge Function: update-fund-holdings
//
// Refreshes the look-through tables (see
// migrations/20250101000027_fund_holdings.sql): every position of the funds
// held here, from each fund's issuer, matched into one list of securities.
//
//   CSPX        -- iShares: the product page's own data API
//                  (get-product-data, component=holdings) -- every holding
//                  with ticker, ISIN, weight, sector, country.
//   VUAA        -- Vanguard S&P 500 UCITS ETF (portfolio 9503; VUAA is its
//                  accumulating share class) and
//   VWRA, VWCE  -- Vanguard FTSE All-World UCITS ETF (portfolio 9679; two
//                  listings of one share class): the vanguard.co.uk GraphQL
//                  endpoint the fund pages use (borHoldings), paged by
//                  lastItemKey. Month-end lists.
//   XSX6        -- Xtrackers STOXX Europe 600: DWS's constituent export
//                  (.xlsx; weights as fractions).
//   AKME, AKFN  -- Alfa-Capital: the fund page's "Состав фонда", read from
//                  the React Router data the page embeds (turbo-stream
//                  encoded) -- by issuer, not by security; an issuer's ISIN
//                  is taken from the page's own lists of the same fund
//                  where they name one.
// TRND (T-Capital) has no machine-readable list we can reach: tbank.ru
// isn't reachable from outside Russia and T-Capital only publishes monthly
// PDF reports, so it's seeded once by the migration (from the 27.02.2026
// report) and this function leaves it alone.
//
// Matching: a security is its ISIN. Its one name / sector / country come
// from the best source that lists it -- Russian shares: MOEX ISS (ticker
// and short name by ISIN) plus RU_SECTORS below; others: Vanguard's names
// ("NVIDIA Corp"), then iShares, then DWS; sectors normalised to GICS (DWS
// uses ICB names: "Technology" -> "Information Technology"). Positions
// with no ISIN (cash, futures, FX forwards, "Прочее") go to the shared
// 'OTHER' row.
// Every security gets a ticker: the issuer's (iShares, Vanguard), MOEX's
// for Russian ones, the one already stored, else OpenFIGI's (the listing
// on the home exchange; DWS gives no tickers at all); the ISIN itself only
// if none of those knows it (retried next run).
// And a country (of risk) and trading currency: the issuer's (iShares,
// DWS), else from iShares' ACWI / World / EM IMI lists (REFERENCE_ISHARES
// -- Vanguard gives neither), Russian ones Russia / RUB, else the ISIN's
// country (for offshore domiciles -- KY, BM, JE... -- the home exchange's,
// via OpenFIGI) and that country's currency.
// Shares the user holds directly (market_prices rows of instrument_type
// 'stock' that aren't funds) are linked by ISIN too -- MOEX ISS for MOEX
// tickers, the issuers' lists for US ones -- via securities.market_ticker.
//
// Each fund's rows are replaced as a whole (a fund that fails to load
// keeps its previous list). Called by pg_cron on the 2nd of each month
// (deployed with --no-verify-jwt; it only ever writes public data, with
// the service role).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { xlsxRows } from '../_shared/xlsx_rows.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

interface Holding {
  name: string; ticker: string | null; isin: string | null; weight: number;
  sector: string | null; country: string | null; currency: string | null; asset_class: string | null;
}
interface FundList { as_of: string; source: string; holdings: Holding[] }

async function fetchOk(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}
const ymd = (n: number | string) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const orNull = (s: unknown) => (typeof s === 'string' && s.trim() && s.trim() !== '-' ? s.trim() : null);

async function ishares(portfolioId: string): Promise<FundList> {
  const url = 'https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data'
    + `?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=ishares-uk&locale=en_GB&userType=individual&portfolioId=${portfolioId}&component=holdings`;
  const j = await (await fetchOk(url)).json();
  const dp = j.componentsByNameMap?.holdings?.containersByNameMap?.all?.dataPointsByNameMap;
  if (!dp?.issueName?.value?.length) throw new Error(`iShares ${portfolioId}: no holdings in the response`);
  const col = (k: string) => (dp[k]?.value ?? []) as unknown[];
  const [names, tickers, isins, weights, sectors, countries, classes, currencies] =
    ['issueName', 'ticker', 'isin', 'holdingPercent', 'sectorName', 'countryOfRisk', 'assetClass', 'marketCurrencyCode'].map(col);
  return {
    as_of: ymd(dp.asOfDate.value), source: 'ishares.com',
    holdings: names.map((n, i) => ({
      name: String(n), ticker: orNull(tickers[i]), isin: orNull(isins[i]), weight: Number(weights[i]),
      sector: orNull(sectors[i]), country: orNull(countries[i]), asset_class: orNull(classes[i]),
      currency: orNull(currencies[i]),
    })),
  };
}

async function vanguard(portId: string): Promise<FundList> {
  const query = 'query H($portIds:[String!]!,$lastItemKey:String){borHoldings(portIds:$portIds){holdings(limit:1500,lastItemKey:$lastItemKey)'
    + '{items{issuerName securityLongDescription gicsSectorDescription marketValuePercentage ticker isin effectiveDate} lastItemKey}}}';
  const items: Record<string, unknown>[] = [];
  let lastItemKey: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await fetchOk('https://www.vanguard.co.uk/gpx/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-consumer-id': 'uk0', Origin: 'https://www.vanguard.co.uk' },
      body: JSON.stringify({ query, variables: { portIds: [portId], lastItemKey } }),
    });
    const h = (await res.json()).data?.borHoldings?.[0]?.holdings;
    if (!h) throw new Error(`Vanguard ${portId}: no holdings in the response`);
    items.push(...h.items);
    lastItemKey = h.lastItemKey;
    if (!lastItemKey) break;
  }
  if (!items.length) throw new Error(`Vanguard ${portId}: empty list`);
  return {
    as_of: String(items[0].effectiveDate), source: 'vanguard.co.uk',
    holdings: items.map(i => ({
      name: String(i.securityLongDescription || i.issuerName), ticker: orNull(i.ticker), isin: orNull(i.isin),
      weight: Number(i.marketValuePercentage ?? 0), sector: orNull(i.gicsSectorDescription), country: null, currency: null, asset_class: null,
    })),
  };
}

async function dws(isin: string): Promise<FundList> {
  const bytes = new Uint8Array(await (await fetchOk(`https://etf.dws.com/etfdata/export/GBR/ENG/excel/product/constituent/${isin}/`)).arrayBuffer());
  const rows = xlsxRows(bytes);
  const hdr = rows.find(r => r.B === 'Name' && r.C === 'ISIN');
  if (!hdr) throw new Error(`DWS ${isin}: no constituent table`);
  const col = Object.fromEntries(Object.entries(hdr).map(([c, name]) => [name, c]));
  const holdings = rows.filter(r => /^\d+$/.test(r.A || '') && r[col.Weighting] !== undefined).map(r => ({
    name: r[col.Name], ticker: null, isin: /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(r[col.ISIN] || '') ? r[col.ISIN] : null,
    weight: Number(r[col.Weighting]) * 100, sector: orNull(r[col['Industry Classification']]),
    country: orNull(r[col.Country]), currency: orNull(r[col.Currency]), asset_class: orNull(r[col['Type of Security']]),
  }));
  // The export carries no date of its own: it's the current list.
  return { as_of: new Date().toISOString().slice(0, 10), source: 'etf.dws.com', holdings };
}

// React Router's turbo-stream: a flat JSON array where an object's keys are
// "_<index of the key string>" and its values indices into the same array;
// negative indices are null / undefined / NaN markers.
function decodeTurboStream(html: string): unknown {
  // The payload is a JS string literal: scan to its closing quote.
  const start = html.indexOf('streamController.enqueue("');
  if (start < 0) throw new Error('no embedded page data');
  const from = start + 'streamController.enqueue('.length;
  let end = from + 1;
  while (end < html.length && html[end] !== '"') end += html[end] === '\\' ? 2 : 1;
  const arr = JSON.parse(JSON.parse(html.slice(from, end + 1))) as unknown[];
  const memo = new Map<number, unknown>();
  const res = (i: number): unknown => {
    if (typeof i !== 'number' || i < 0) return null;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && /^[A-Z]$/.test(v[0])) return v;   // typed value (Date, Promise, ...)
      const out: unknown[] = []; memo.set(i, out);
      for (const x of v) out.push(res(x as number));
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}; memo.set(i, out);
      for (const [k, vi] of Object.entries(v)) out[k.startsWith('_') ? String(arr[Number(k.slice(1))]) : k] = res(vi as number);
      return out;
    }
    return v;
  };
  return res(0);
}

function walk(o: unknown, visit: (x: Record<string, unknown>) => void, seen = new Set<unknown>()) {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o);
  if (Array.isArray(o)) { for (const x of o) walk(x, visit, seen); return; }
  visit(o as Record<string, unknown>);
  for (const v of Object.values(o)) walk(v, visit, seen);
}

async function alfaCapital(slug: string): Promise<FundList> {
  const html = await (await fetchOk(`https://www.alfacapital.ru/individual/bpifs/${slug}`)).text();
  const data = decodeTurboStream(html);
  let structure: { issuers: { name: string; percentage: number }[]; date: string } | null = null;
  const isinOf = new Map<string, string>();   // "name|percentage" -> ISIN
  walk(data, (x) => {
    // The fund's own block sits under the "alfa-capital-product-structure"
    // loader (the page header carries other funds' lists too).
    for (const [k, v] of Object.entries(x)) {
      if (!k.includes('product-structure') || !v || typeof v !== 'object') continue;
      walk(v, (y) => {
        if (!structure && Array.isArray(y.issuers) && Array.isArray(y.assetTypes) && typeof y.date === 'string') structure = y as typeof structure;
      });
    }
    if (typeof x.name === 'string' && typeof x.isin === 'string' && typeof x.percentage === 'number') isinOf.set(`${x.name}|${x.percentage}`, x.isin);
  });
  if (!structure) throw new Error(`Alfa-Capital ${slug}: no "Состав фонда" data on the page`);
  const s = structure as { issuers: { name: string; percentage: number }[]; date: string };
  return {
    as_of: s.date, source: 'alfacapital.ru',
    holdings: s.issuers.map(i => ({
      name: i.name, ticker: null, isin: isinOf.get(`${i.name}|${i.percentage}`) ?? null, weight: Number(i.percentage),
      sector: null, country: null, currency: null, asset_class: i.name === 'Прочее' ? 'Other' : null,
    })),
  };
}

// fund ticker(s) -> loader; funds sharing one portfolio share one fetch.
const SOURCES: { funds: string[]; load: () => Promise<FundList> }[] = [
  { funds: ['CSPX'], load: () => ishares('253743') },
  { funds: ['VUAA'], load: () => vanguard('9503') },
  { funds: ['VWRA', 'VWCE'], load: () => vanguard('9679') },
  { funds: ['XSX6'], load: () => dws('LU0328475792') },
  { funds: ['AKME'], load: () => alfaCapital('bpif_akmrs') },
  { funds: ['AKFN'], load: () => alfaCapital('bpif-fullincfin') },
];
const FUNDS = new Set([...SOURCES.flatMap(s => s.funds), 'TRND']);

// GICS sectors of Russian shares (MOEX has no sector field).
const RU_SECTORS: Record<string, string> = {
  SBER: 'Financials', VTBR: 'Financials', T: 'Financials', MOEX: 'Financials', DOMRF: 'Financials', CBOM: 'Financials',
  SVCB: 'Financials', BSPB: 'Financials', RENI: 'Financials', MBNK: 'Financials', SPBE: 'Financials', SFIN: 'Financials',
  LKOH: 'Energy', ROSN: 'Energy', TATN: 'Energy', GAZP: 'Energy', NVTK: 'Energy', SNGS: 'Energy', TRNFP: 'Energy', FLOT: 'Energy', SIBN: 'Energy',
  GMKN: 'Materials', PLZL: 'Materials', RUAL: 'Materials', MAGN: 'Materials', NLMK: 'Materials', PHOR: 'Materials', UGLD: 'Materials', CHMF: 'Materials', ALRS: 'Materials',
  YDEX: 'Communication Services', MTSS: 'Communication Services', RTKM: 'Communication Services',
  OZON: 'Consumer Discretionary', LENT: 'Consumer Staples', MGNT: 'Consumer Staples', X5: 'Consumer Staples',
  POSI: 'Information Technology', HEAD: 'Industrials', AFLT: 'Industrials', MDMG: 'Health Care',
  IRAO: 'Utilities', MRKV: 'Utilities', MRKC: 'Utilities', MRKP: 'Utilities', LSNGP: 'Utilities', HYDR: 'Utilities', FEES: 'Utilities',
};
const GICS: Record<string, string> = {
  Communication: 'Communication Services', Technology: 'Information Technology', Telecommunications: 'Communication Services',
  'Basic Materials': 'Materials',
};
const SECTORS = new Set(['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary', 'Consumer Staples',
  'Communication Services', 'Industrials', 'Energy', 'Materials', 'Utilities', 'Real Estate']);
const gics = (s: string | null) => { const g = s ? (GICS[s] ?? s) : null; return g && SECTORS.has(g) ? g : null; };
const isIsin = (s: string | null): s is string => !!s && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s);
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
// Name preference by source: Vanguard's are the tidiest.
const NAME_RANK: Record<string, number> = { 'vanguard.co.uk': 4, 'ishares.com': 3, 'etf.dws.com': 2, 'alfacapital.ru': 1 };

// MOEX ISS: by ISIN -> ticker (+ short name); by ticker -> ISIN (+ short name).
const iss = async (url: string) => (await fetchOk(`https://iss.moex.com/iss/${url}${url.includes('?') ? '&' : '?'}iss.meta=off`)).json();
async function moexByIsin(isin: string): Promise<{ secid: string; name: string } | null> {
  const j = await iss(`securities.json?q=${isin}&securities.columns=secid,isin,shortname,primary_boardid,is_traded`);
  const rows = (j.securities?.data ?? []) as [string, string, string, string, number][];
  const hit = rows.filter(r => r[1] === isin).sort((a, b) => (b[4] - a[4]) || (a[3] === 'TQBR' ? -1 : 1))[0];
  return hit ? { secid: hit[0], name: hit[2] } : null;
}
// Shares only (a fund's units -- TYPE exchange_ppif -- aren't a security to look through to).
async function moexBySecid(secid: string): Promise<{ isin: string; name: string } | null> {
  const j = await iss(`securities/${encodeURIComponent(secid)}.json?iss.only=description&description.columns=name,value`);
  const d = Object.fromEntries((j.description?.data ?? []) as [string, string][]);
  return d.ISIN && /share|depositary/.test(d.TYPE || '') ? { isin: d.ISIN, name: d.SHORTNAME || d.NAME || secid } : null;
}

// OpenFIGI (api.openfigi.com, no key: 25 requests/min, 10 ISINs each):
// ISIN -> the listing on the security's home exchange (Bloomberg exchange
// code by the ISIN's country), else its first non-OTC listing -- its
// ticker, and via EXCH_COUNTRY its country and currency.
const HOME_EXCH: Record<string, string[]> = {
  US: ['US'], GB: ['LN'], NL: ['NA'], FR: ['FP'], DE: ['GY', 'GR'], CH: ['SW', 'SE'], IT: ['IM'], ES: ['SM'], SE: ['SS'],
  DK: ['DC'], NO: ['NO'], FI: ['FH'], BE: ['BB'], AT: ['AV'], IE: ['ID', 'LN'], PT: ['PL'], LU: ['LX', 'NA', 'FP'], PL: ['PW'],
  JP: ['JT', 'JP'], HK: ['HK'], KY: ['HK', 'US'], BM: ['US', 'HK'], CA: ['CT', 'CN'], AU: ['AU'], KR: ['KS'], TW: ['TT'],
  CN: ['CH', 'C1', 'C2'], IN: ['IN', 'IS'], BR: ['BZ'], ZA: ['SJ'], SG: ['SP'], IL: ['IT', 'US'], JE: ['LN'], GG: ['LN'],
};
const OTC = new Set(['PQ', 'UV', 'GF', 'GD', 'GS', 'GM', 'GI', 'GB', 'GH', 'GT', 'GE', 'EU', 'EO', 'TH', 'QT']);
// Bloomberg exchange code -> country (ISO 3166 alpha-2).
const EXCH_COUNTRY: Record<string, string> = {
  US: 'US', UN: 'US', UW: 'US', UQ: 'US', LN: 'GB', HK: 'HK', CH: 'CN', C1: 'CN', C2: 'CN', JT: 'JP', JP: 'JP', SP: 'SG',
  AU: 'AU', CT: 'CA', CN: 'CA', NA: 'NL', FP: 'FR', GY: 'DE', GR: 'DE', SW: 'CH', SE: 'CH', SS: 'SE', DC: 'DK', NO: 'NO',
  IM: 'IT', SM: 'ES', TT: 'TW', KS: 'KR', IN: 'IN', IS: 'IN', BZ: 'BR', SJ: 'ZA', TB: 'TH', MK: 'MY', IJ: 'ID', PM: 'PH',
  MM: 'MX', TI: 'TR', IT: 'IL', AB: 'SA', UH: 'AE', DH: 'AE', QD: 'QA', KK: 'KW', PW: 'PL', CI: 'CL', CB: 'CO', PE: 'PE',
  GA: 'GR', ID: 'IE', BB: 'BE', AV: 'AT', FH: 'FI', PL: 'PT', LX: 'LU', NZ: 'NZ', EY: 'EG', CP: 'CZ', HB: 'HU', RM: 'RU',
};
async function openFigi(isins: string[]): Promise<Map<string, { ticker: string; code: string | null }>> {
  const out = new Map<string, { ticker: string; code: string | null }>();
  for (let i = 0; i < isins.length && i < 400; i += 10) {
    const batch = isins.slice(i, i + 10);
    if (i) await new Promise(r => setTimeout(r, 2600));
    const res = await fetch('https://api.openfigi.com/v3/mapping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map(idValue => ({ idType: 'ID_ISIN', idValue }))),
    });
    if (!res.ok) break;   // rate-limited: the rest waits for the next run
    const j = await res.json() as { data?: { ticker: string; exchCode: string }[] }[];
    j.forEach((r, k) => {
      const d = r.data ?? [];
      const home = HOME_EXCH[batch[k].slice(0, 2)] ?? [];
      const hit = home.map(e => d.find(x => x.exchCode === e)).find(Boolean) ?? d.find(x => !OTC.has(x.exchCode)) ?? d[0];
      if (hit?.ticker) out.set(batch[k], { ticker: hit.ticker, code: EXCH_COUNTRY[hit.exchCode] ?? null });
    });
  }
  return out;
}

// Country -> ISO code: issuers' names (iShares "Korea (South)", DWS
// "United Kingdom") through the English region names, plus aliases.
const CODE_BY_NAME = new Map<string, string>();
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b);
  try { const n = regionName.of(code); if (n && n !== code) CODE_BY_NAME.set(n.toLowerCase(), code); } catch { /* not a region */ }
}
for (const [n, c] of Object.entries({
  'korea (south)': 'KR', 'south korea': 'KR', 'russian federation': 'RU', 'czech republic': 'CZ', turkey: 'TR',
  'taiwan (republic of china)': 'TW', 'united states of america': 'US', usa: 'US', 'hong kong sar': 'HK',
})) CODE_BY_NAME.set(n, c);
const codeOf = (name: string | null) => (name ? CODE_BY_NAME.get(name.toLowerCase()) ?? null : null);
// Offshore domiciles: the ISIN prefix says nothing about where the company is.
const OFFSHORE = new Set(['KY', 'BM', 'VG', 'JE', 'GG', 'IM', 'PA', 'CW', 'LR', 'MH', 'BS', 'GI', 'AN', 'MU', 'XS']);
// Country -> its currency (fallback when no source gives the trading currency).
const EUR = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const CCY: Record<string, string> = {
  ...Object.fromEntries(EUR.map(c => [c, 'EUR'])), US: 'USD', GB: 'GBP', JP: 'JPY', CN: 'CNY', HK: 'HKD', AU: 'AUD', CA: 'CAD',
  CH: 'CHF', SE: 'SEK', DK: 'DKK', NO: 'NOK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', TR: 'TRY', IL: 'ILS', IN: 'INR', KR: 'KRW',
  TW: 'TWD', SG: 'SGD', TH: 'THB', MY: 'MYR', ID: 'IDR', PH: 'PHP', NZ: 'NZD', BR: 'BRL', MX: 'MXN', CL: 'CLP', CO: 'COP',
  PE: 'PEN', ZA: 'ZAR', EG: 'EGP', SA: 'SAR', AE: 'AED', QA: 'QAR', KW: 'KWD', RU: 'RUB', VN: 'VND', PK: 'PKR',
};

interface Security {
  id: string; isin: string | null; ticker: string | null; market_ticker: string | null; name: string;
  sector: string | null; country: string | null; country_code: string | null; currency: string | null;
  asset_class: string | null; _rank: number;
}
const blank = (isin: string, name: string): Security => ({
  id: isin, isin, ticker: null, market_ticker: null, name, sector: null, country: null, country_code: null, currency: null,
  asset_class: null, _rank: -1,
});

// Reference lists, only to fill in country / currency / ticker / sector of
// securities the funds' own issuers don't describe (Vanguard gives neither
// country nor currency): iShares MSCI ACWI, Core MSCI World, Core MSCI EM IMI.
const REFERENCE_ISHARES = ['251850', '251882', '264659'];

Deno.serve(async () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const result: Record<string, unknown> = {};

    // 1. Every issuer's list (and the reference lists).
    const lists: { funds: string[]; list: FundList }[] = [];
    for (const src of SOURCES) {
      try { lists.push({ funds: src.funds, list: await src.load() }); }
      catch (err) { for (const f of src.funds) result[f] = { error: String(err) }; }
    }
    const reference = new Map<string, Holding>();
    for (const id of REFERENCE_ISHARES) {
      try { for (const h of (await ishares(id)).holdings) if (isIsin(h.isin)) reference.set(h.isin, h); }
      catch (err) { result[`reference_${id}`] = { error: String(err) }; }
    }

    // 2. One security per ISIN.
    const securities = new Map<string, Security>();
    const fill = (s: Security, h: Holding) => {
      s.ticker ??= h.ticker;
      s.sector ??= gics(h.sector);
      s.country_code ??= codeOf(h.country);
      s.currency ??= h.currency && /^[A-Z]{3}$/.test(h.currency) ? (h.currency === 'CNH' ? 'CNY' : h.currency) : null;
      s.asset_class ??= h.asset_class && /equit/i.test(h.asset_class) ? 'Equity' : null;
    };
    for (const { list } of lists) {
      const rank = NAME_RANK[list.source] ?? 0;
      for (const h of list.holdings) {
        if (!isIsin(h.isin)) continue;
        const s = securities.get(h.isin) ?? blank(h.isin, h.name);
        if (rank > s._rank) { s.name = h.name; s._rank = rank; }
        fill(s, h);
        securities.set(h.isin, s);
      }
    }
    for (const s of securities.values()) { const r = reference.get(s.id); if (r) fill(s, r); }
    // Russian ones: MOEX ticker, name and sector; Russia, RUB.
    const moexCache = new Map<string, { secid: string; name: string } | null>();
    for (const s of securities.values()) {
      if (!s.isin!.startsWith('RU')) continue;
      if (!moexCache.has(s.isin!)) moexCache.set(s.isin!, await moexByIsin(s.isin!).catch(() => null));
      s.country_code = 'RU'; s.currency = 'RUB';
      const m = moexCache.get(s.isin!);
      if (!m) continue;
      s.ticker = m.secid; s.name = m.name;
      s.sector = RU_SECTORS[m.secid] ?? s.sector;
      // A fund's "Минфин" line is an OFZ (secid SU...), a bond.
      if (/^SU/.test(m.secid) || /ОФЗ/.test(m.name)) { s.asset_class = 'Bond'; s.sector = null; } else s.asset_class = 'Equity';
    }

    // What's still missing (a ticker; the country of an offshore-domiciled
    // one): what's already stored, then OpenFIGI; then the ISIN's own
    // country, its currency, and the ISIN as the ticker.
    const stored = new Map<string, { ticker: string; country_code: string; currency: string }>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('securities').select('id, ticker, country_code, currency').range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) stored.set(r.id, r);
      if (!data || data.length < 1000) break;
    }
    const offshore = (s: Security) => OFFSHORE.has(s.id.slice(0, 2));
    for (const s of securities.values()) {
      const st = stored.get(s.id);
      if (!st) continue;
      if (!s.ticker && st.ticker !== s.id) s.ticker = st.ticker;
      if (!s.country_code && (!offshore(s) || st.country_code !== s.id.slice(0, 2))) s.country_code = st.country_code;
      s.currency ??= st.currency;
    }
    const ask = [...securities.values()].filter(s => !s.ticker || (!s.country_code && offshore(s))).map(s => s.id);
    const figi = ask.length ? await openFigi(ask).catch(() => new Map<string, { ticker: string; code: string | null }>()) : new Map();
    const tickerless: string[] = [];
    for (const s of securities.values()) {
      const f = figi.get(s.id);
      s.ticker ??= f?.ticker ?? null;
      s.country_code ??= f?.code ?? null;
      s.country_code ??= s.id.slice(0, 2);
      s.currency ??= CCY[s.country_code] ?? null;
      s.currency ??= 'USD';   // no source and an unmapped country: the likeliest listing currency
      s.country = regionName.of(s.country_code) ?? s.country_code;
      if (!s.ticker) { tickerless.push(s.id); s.ticker = s.id; }
      s.asset_class ??= 'Equity';
    }

    // 3. Shares held directly -> their security, by ISIN.
    const { data: held } = await db.from('market_prices').select('ticker, source').eq('instrument_type', 'stock');
    const byTicker = new Map<string, Security>();
    for (const s of securities.values()) {
      if (!s.ticker) continue;
      const prev = byTicker.get(s.ticker);
      if (!prev || (s.isin!.startsWith('US') && !prev.isin!.startsWith('US'))) byTicker.set(s.ticker, s);
    }
    const unlinked: string[] = [];
    for (const { ticker, source } of (held ?? []) as { ticker: string; source: string }[]) {
      if (FUNDS.has(ticker) || ticker.includes(':')) continue;
      let s: Security | undefined;
      if (/moex/i.test(source || '')) {
        const m = await moexBySecid(ticker).catch(() => null);
        if (m) {
          s = securities.get(m.isin) ?? {
            ...blank(m.isin, m.name), ticker, sector: RU_SECTORS[ticker] ?? null,
            country: 'Russia', country_code: 'RU', currency: 'RUB', asset_class: 'Equity', _rank: 0,
          };
          securities.set(m.isin, s);
        }
      } else {
        const hit = byTicker.get(ticker);
        s = hit && !hit.isin!.startsWith('RU') ? hit : undefined;
      }
      if (s) s.market_ticker = ticker; else unlinked.push(ticker);
    }

    // 4. Write: securities, then each fund's list.
    const { error: clrErr } = await db.from('securities').update({ market_ticker: null }).not('market_ticker', 'is', null);
    if (clrErr) throw new Error(clrErr.message);
    const secRows = [...securities.values()].map(({ _rank, ...s }) => ({ ...s, updated_at: new Date().toISOString() }));
    for (let i = 0; i < secRows.length; i += 1000) {
      const { error } = await db.from('securities').upsert(secRows.slice(i, i + 1000), { onConflict: 'id' });
      if (error) throw new Error(error.message);
    }
    for (const { funds, list } of lists) {
      const weights = new Map<string, { weight: number; raw_name: string }>();
      for (const h of list.holdings) {
        if (!Number.isFinite(h.weight)) continue;
        const id = isIsin(h.isin) ? h.isin : 'OTHER';
        const cur = weights.get(id);
        if (cur) cur.weight += h.weight; else weights.set(id, { weight: h.weight, raw_name: id === 'OTHER' ? 'cash, derivatives, other' : h.name });
      }
      for (const fund of funds) {
        const rows = [...weights].map(([security_id, w]) => ({
          fund, security_id, weight: Math.round(w.weight * 1e6) / 1e6, raw_name: w.raw_name,
          as_of: list.as_of, source: list.source, updated_at: new Date().toISOString(),
        }));
        const { error: delErr } = await db.from('fund_holdings').delete().eq('fund', fund);
        if (delErr) throw new Error(delErr.message);
        for (let i = 0; i < rows.length; i += 1000) {
          const { error } = await db.from('fund_holdings').insert(rows.slice(i, i + 1000));
          if (error) throw new Error(error.message);
        }
        const top = rows.sort((a, b) => b.weight - a.weight).slice(0, 3)
          .map(r => `${securities.get(r.security_id)?.ticker || securities.get(r.security_id)?.name || r.security_id} ${Math.round(r.weight * 100) / 100}%`);
        result[fund] = {
          as_of: list.as_of, securities: rows.length,
          total_weight: Math.round(rows.reduce((s, r) => s + r.weight, 0) * 100) / 100, top,
        };
      }
    }
    result.TRND = { skipped: 'no fetchable source; the list seeded by migration 027 (as of 2026-02-27) is kept' };
    result.securities = secRows.length;
    result.direct_linked = secRows.filter(s => s.market_ticker).map(s => `${s.market_ticker}=${s.id}`);
    result.direct_unlinked = unlinked;
    result.resolved_via_openfigi = figi.size;
    result.without_ticker = tickerless;
    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
