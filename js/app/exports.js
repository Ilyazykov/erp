// My Portfolio's exports: to Numbers (.xlsx with charts) and the full Snowball
// CSVs (with and without the cash).

// Maps this app's `trades.side` values to Snowball's `Event` column (the
// full export below) -- see Snowball's "custom broker" template for the
// column semantics.
const MP_FUND_SNOWBALL_EVENT = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  stock_as_dividend: 'Stock_As_Dividend',
  amortisation: 'Amortisation',
  repayment: 'Repayment',
};
// ---- Export to Numbers (.xlsx with charts) ----
// The capital (capital_daily) as of the 6th of each month from the month
// chosen, and the latest day, as money.numbers lays it out: a summary sheet
// (by asset type / currency / account over time, stacked areas in USD and in
// shares) and a sheet per date (accounts x currencies in each currency at the
// day's rate, the USD total, asset types, shares by index, the Russian block,
// the flat, three pies). Written as OOXML by hand -- charts included, which
// the spreadsheet libraries leave out -- and zipped with JSZip; Numbers opens
// it with its charts as its own.
const MP_XLSX_RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MP_XLSX_EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MP_XLSX_CLASSES = ['Акции', 'Облигации', 'Вклады', 'Кэш', 'Золото', 'Крипта', 'Прочее'];
const MP_XLSX_INDEXES = ['S&P500', 'S&P400', 'S&P600', 'STOXX600', 'MOEX', 'Акции мира'];
const MP_XLSX_RU = ['Облигации 🇷🇺', 'Вклады 🇷🇺', 'Облигации 🇨🇳'];
// funds by the index they follow; a single share: Russian -> MOEX, an S&P 500
// member -> S&P500, any other -> world
const MP_XLSX_INDEX_OF = {
  CSPX: 'S&P500', VUAA: 'S&P500', VOO: 'S&P500', SPY: 'S&P500', IVV: 'S&P500', SXR8: 'S&P500', SPXS: 'S&P500',
  SPY4: 'S&P400', IJH: 'S&P400', MDY: 'S&P400', IJR: 'S&P600', ISP6: 'S&P600', SLY: 'S&P600',
  XSX6: 'STOXX600', EXSA: 'STOXX600', MEUD: 'STOXX600', VWRA: 'Акции мира', VWCE: 'Акции мира', IWDA: 'Акции мира', SWDA: 'Акции мира',
};
const MP_XLSX_SP500 = new Set(['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'META', 'AMZN', 'TSLA', 'MU', 'WMT', 'JPM', 'V', 'MA', 'BRK.B', 'AVGO',
  'LLY', 'UNH', 'XOM', 'JNJ', 'PG', 'HD', 'COST', 'NFLX', 'AMD', 'INTC', 'KO', 'PEP', 'DIS', 'ORCL', 'ADBE', 'CRM', 'QCOM', 'CSCO', 'BAC', 'PFE']);
const MP_XLSX_STABLE = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP']);
const MP_XLSX_RU_ACCOUNTS = new Set(['Sber', 'T-Bank', 'Alfa', 'Yandex Bank', 'Ozon Bank', 'Finuslugi']);
const MP_XLSX_FIAT_ORDER = ['USD', 'EUR', 'GBP', 'RUB', 'TRY', 'RSD', 'CNY', 'GEL'];

// The dates, the capital on them, and what's needed to show it in each currency.
async function mpXlsxModel(fromMonth) {
  const { data: last, error } = await sb.from('capital_daily').select('day').order('day', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const lastDay = last?.[0]?.day;
  if (!lastDay) throw new Error('No capital history yet.');
  const days = [];
  let [y, m] = fromMonth.split('-').map(Number);
  for (;;) {
    const d = `${y}-${String(m).padStart(2, '0')}-06`;
    if (d > lastDay) { if (days.at(-1) !== lastDay) days.push(lastDay); break; }
    days.push(d);
    if (++m > 12) { m = 1; y++; }
  }
  const rows = await mpFetchAll(() => sb.from('capital_daily')
    .select('day, account, ticker, instrument_type, currency, value_usd').in('day', days).order('day'));
  const first = days[0], lo = new Date(Date.parse(first) - 40 * 86400000).toISOString().slice(0, 10);
  const ccys = [...new Set(rows.map(r => r.currency).filter(Boolean)).add('RUB')];
  const fx = await mpFetchAll(() => sb.from('fx_history').select('currency, day, usd_per_unit')
    .in('currency', ccys).gte('day', lo).lte('day', lastDay).order('day'));
  const priced = [...new Set(rows.filter(r => r.instrument_type === 'crypto' || r.instrument_type === 'gold').map(r => r.ticker)).add('XAU')];
  const px = await mpFetchAll(() => sb.from('price_history').select('ticker, day, price_usd')
    .in('ticker', priced).gte('day', lo).lte('day', lastDay).order('day'));
  const stocks = [...new Set(rows.filter(r => r.instrument_type === 'stock').map(r => r.ticker))];
  const { data: regions } = await sb.from('market_prices').select('ticker, infra_region').in('ticker', stocks.length ? stocks : ['-']);
  const { data: estates } = await sb.from('real_estate').select('city, currency');
  const city = estates?.[0]?.city;
  const { data: m2 } = city
    ? await sb.from('real_estate_index').select('month, price_per_m2, currency').eq('city', city).order('month')
    : { data: [] };
  // the latest value on or before the day
  const latest = (list, key, field) => {
    const by = new Map();
    for (const r of list) { if (!by.has(r[key])) by.set(r[key], []); by.get(r[key]).push(r); }
    return (k, d) => { const l = by.get(k) || []; let v = null; for (const r of l) { if (r.day <= d) v = Number(r[field]); else break; } return v; };
  };
  const usdPer = latest(fx, 'currency', 'usd_per_unit');
  const priceOf = latest(px, 'ticker', 'price_usd');
  const regionOf = new Map((regions || []).map(r => [r.ticker, r.infra_region]));
  const m2On = d => { let v = null; for (const r of m2 || []) if (r.month <= d) v = r; return v; };

  const colOf = r => r.instrument_type === 'crypto' ? (r.ticker === 'XAUT' ? 'XAU' : MP_XLSX_STABLE.has(r.ticker) ? 'USD' : r.ticker)
    : r.instrument_type === 'gold' ? 'XAU' : (r.currency || 'USD');
  const classOf = r => {
    const t = r.instrument_type;
    if (t === 'crypto') return r.ticker === 'XAUT' ? 'Золото' : MP_XLSX_STABLE.has(r.ticker) ? 'Кэш' : 'Крипта';
    return t === 'stock' ? 'Акции' : t === 'bond' ? 'Облигации' : t === 'deposit' || t === 'liquid' ? 'Вклады'
      : t === 'cash' || t === 'credit' ? 'Кэш' : t === 'gold' ? 'Золото' : 'Прочее';
  };
  const indexOf = r => MP_XLSX_INDEX_OF[r.ticker]
    ?? (regionOf.get(r.ticker) === 'ru' || r.currency === 'RUB' ? 'MOEX' : MP_XLSX_SP500.has(r.ticker) ? 'S&P500' : 'Акции мира');
  const ruOf = r => !MP_XLSX_RU_ACCOUNTS.has(r.account) ? null
    : r.instrument_type === 'bond' ? (r.currency === 'CNY' ? 'Облигации 🇨🇳' : r.currency === 'RUB' ? 'Облигации 🇷🇺' : null)
    : (r.instrument_type === 'deposit' || r.instrument_type === 'liquid') && r.currency === 'RUB' ? 'Вклады 🇷🇺' : null;
  const isFiat = c => c !== 'XAU' && !priced.includes(c) || MP_XLSX_FIAT_ORDER.includes(c);

  const snaps = days.map(day => {
    const acc = new Map();
    const s = { day, acc, estate: { usd: 0, native: 0, ccy: null }, ru: {}, ruPos: {}, cols: new Map() };
    for (const r of rows.filter(x => x.day === day)) {
      const usd = Number(r.value_usd);
      if (!usd) continue;
      if (r.instrument_type === 'real_estate') {
        s.estate.usd += usd; s.estate.ccy = r.currency;
        const per = usdPer(r.currency, day); if (per) s.estate.native += usd / per;
        continue;
      }
      if (!acc.has(r.account)) acc.set(r.account, { usd: 0, native: new Map(), usdBy: new Map(), cls: {}, idx: {}, pos: [] });
      const a = acc.get(r.account);
      const col = colOf(r);
      const unitUsd = isFiat(col) ? usdPer(col, day) : priceOf(col === 'XAU' ? (r.ticker === 'XAUT' ? 'XAUT' : 'XAU') : col, day) ?? priceOf(col, day);
      a.usd += usd;
      a.usdBy.set(col, (a.usdBy.get(col) || 0) + usd);
      if (unitUsd) a.native.set(col, (a.native.get(col) || 0) + usd / unitUsd);
      const c = classOf(r); a.cls[c] = (a.cls[c] || 0) + usd;
      const i = r.instrument_type === 'stock' ? indexOf(r) : null;
      if (i) a.idx[i] = (a.idx[i] || 0) + usd;
      // each position too: the sheet's cells are written as the sum of them
      a.pos.push({ col, native: unitUsd ? usd / unitUsd : null, usd, cls: c, idx: i, worldFund: MP_XLSX_INDEX_OF[r.ticker] === 'Акции мира' });
      const ru = ruOf(r);
      if (ru) { s.ru[ru] = (s.ru[ru] || 0) + usd; (s.ruPos[ru] ??= []).push(usd); }
      s.cols.set(col, (s.cols.get(col) || 0) + usd);
    }
    // the rate to the dollar: a currency's units per USD, a metal's / coin's USD price
    s.rate = col => isFiat(col) ? (usdPer(col, day) ? 1 / usdPer(col, day) : null) : priceOf(col, day);
    s.rubPerUsd = usdPer('RUB', day) ? 1 / usdPer('RUB', day) : null;
    s.m2 = m2On(day);
    return s;
  });
  // the same columns on every sheet: currencies first, then the metal, then coins by size
  const allCols = new Map();
  for (const s of snaps) for (const [c, v] of s.cols) allCols.set(c, Math.max(allCols.get(c) || 0, Math.abs(v)));
  const fiat = [...allCols.keys()].filter(isFiat).sort((a, b) => (MP_XLSX_FIAT_ORDER.indexOf(a) + 1 || 99) - (MP_XLSX_FIAT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const coins = [...allCols.keys()].filter(c => !isFiat(c) && c !== 'XAU').sort((a, b) => allCols.get(b) - allCols.get(a));
  const cols = [...fiat, ...(allCols.has('XAU') ? ['XAU'] : []), ...coins];
  const classes = MP_XLSX_CLASSES.filter(c => snaps.some(s => [...s.acc.values()].some(a => a.cls[c])));
  return { snaps, cols, classes, isFiat, lastDay };
}

const mpXmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mpColL = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const mpRef = (sheet, c1, r1, c2, r2) => `'${sheet.replace(/'/g, "''")}'!$${mpColL(c1)}$${r1 + 1}:$${mpColL(c2)}$${r2 + 1}`;

// A sheet in the making: cells by (row, col), 0-based; styles: 0 plain, 1
// header, 2 money, 3 whole, 4 coin, 5 title, 6 bold whole, 7 bold money.
function mpXlsxSheet(name) {
  const cells = new Map();
  return {
    name, cells, charts: [], widths: {},
    set(r, c, v, s = 0, f = null) { if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return; cells.set(`${r},${c}`, { r, c, v, s, f }); },
    get(r, c) { return cells.get(`${r},${c}`)?.v; },
  };
}

// Numbers' own palette, in the order it hands colours out
const MP_XLSX_PALETTE = ['00A2FF', '61D836', '929292', 'F8BA00', 'FF2600', 'FF42A1', '22AEFF', '73DD4E', 'A0A0A0', 'F9C321', 'FF4322', 'D93386',
  '44BAFF', '87E366', 'AFAFAF', 'FACC43', 'FF6044', 'DF4E97', '66C7FF', '9BE87F', 'BEBEBE'];
// each chart's colours as money.numbers has them, by slice / series
const MP_XLSX_TYPE_COLORS = { 'Облигации': '00A2FF', 'Кэш': '61D836', 'Вклады': '929292', 'Золото': 'F8BA00', 'Крипта': 'FF2600', 'Акции': 'FF42A1', 'Квартира': '8BCBFA' };
const MP_XLSX_CCY_COLORS = { EUR: '00A2FF', USD: '61D836', RUB: '929292', TRY: 'F8BA00', GBP: 'FF2600', CNY: 'FF42A1', RSD: '22AEFF', ETH: '73DD4E',
  TON: 'A0A0A0', GRAM: 'A0A0A0', XAU: 'F9C321', BTC: 'FF4322', SOL: 'D93386', TAO: '44BAFF', TRX: '87E366', DOGE: 'AFAFAF' };
const MP_XLSX_COLORS = {
  'По валютам': MP_XLSX_CCY_COLORS,
  'По банкам': { 'Freedom24': '44BAFF', 'Банк Кипра': '479FF8', 'Wise': '81D653', 'Revolut': '929292', 'Райф': 'EFBD40', 'Зираат': 'EA4025', 'IBKR': 'C23175',
    'Сбер': '61D836', 'Тиньков': '81D653', 'Ozon-Банк': 'F8BA00', 'Binance': 'EFBD40', 'Telegram': '54ABF8', 'Bybit': '90DB67', 'Cryptocom': 'A0A0A0',
    'Trust': 'F1C54B', 'Nexo': 'EB5335', 'cash': 'C84285' },
  'По типам активов': MP_XLSX_TYPE_COLORS, 'Инвестиции': MP_XLSX_TYPE_COLORS, 'С квартирой': MP_XLSX_TYPE_COLORS,
  'Акции по индексам': { 'Акции мира': 'C23175', 'STOXX600': '479FF8', 'S&P500': '81D653', 'S&P400': '929292', 'S&P600': 'FF2600', 'MOEX': 'EA4025' },
  'Крипта': { TON: '479FF8', GRAM: '479FF8', TAO: 'A0A0A0', ETH: '81D653', TRX: '929292', DOGE: 'FF2600', BTC: 'EA4025', SOL: 'C23175' },
  'Россия': { 'MOEX 🇷🇺': '00A2FF', 'Облигации 🇷🇺': '61D836', 'Вклады 🇷🇺': '929292', 'Облигации 🇨🇳': 'F8BA00' },
  'Акции по брокерам': { 'Freedom24': '00A2FF', 'IBKR': 'FF42A1' },
  'Россия и мир': { 'Всего 🇷🇺': 'EA4025', 'Всего 🌎': '479FF8' },
  'area:По типам активов': { 'Кэш': '81D653', 'Вклады': '929292', 'Золото': 'EFBD40', 'Облигации': '479FF8', 'Акции': 'C23175', 'Крипта': 'FFD932' },
  'area:По валютам': { ...MP_XLSX_CCY_COLORS, RSD: 'FF42A1', CNY: '22AEFF', SOL: 'A0A0A0', TON: 'D93386', GRAM: 'D93386' },
  'area:По банкам': { 'Банк Кипра': '00A2FF', 'Wise': '61D836', 'Revolut': '929292', 'Райф': 'F8BA00', 'Зираат': 'FF2600', 'IBKR': 'FF42A1', 'Финуслуги': '22AEFF',
    'Сбер': '73DD4E', 'Binance': 'A0A0A0', 'Тиньков': 'F9C321', 'Bybit': 'FF4322', 'Cryptocom': 'D93386', 'Telegram': '44BAFF', 'Nexo': '87E366',
    'Trust': 'DF4E97', 'cash': '9BE87F', 'Freedom24': 'BEBEBE' },
};
// the colours for a chart's labels: by the full label, else by it without its
// flag; one not in money.numbers takes the next colour of the palette not used yet
function mpXlsxColors(key, labels) {
  const map = MP_XLSX_COLORS[key] || {};
  const known = labels.map(l => map[l] ?? map[l.replace(/[^\p{L}\p{N}&+.\- ]/gu, '').trim()]);
  const spare = MP_XLSX_PALETTE.filter(c => !known.includes(c));
  return known.map((c, i) => c || spare.shift() || MP_XLSX_PALETTE[i % MP_XLSX_PALETTE.length]);
}
const mpXlsxFill = hex => `<c:spPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></c:spPr>`;

function mpXlsxChartXml(ch) {
  const x = mpXmlEsc;
  const font = (sz, b = 0) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${b}"><a:latin typeface="Helvetica Neue"/><a:cs typeface="Helvetica Neue"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr>`;
  const ser = (s, i) => {
    const tx = s.nameRef ? `<c:tx><c:strRef><c:f>${x(s.nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${x(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` : '';
    // a pie: a colour per slice, "name / %" outside it with a leader line; an area: a colour per series
    const fill = ch.type === 'pie' ? ch.cats.map((_, j) => `<c:dPt><c:idx val="${j}"/><c:bubble3D val="0"/>${mpXlsxFill(ch.colors[j])}</c:dPt>`).join('') : mpXlsxFill(ch.colors[i]);
    const lbl = ch.type === 'pie'
      ? `<c:dLbls>${font(1200)}<c:dLblPos val="bestFit"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:separator>\n</c:separator><c:showLeaderLines val="1"/></c:dLbls>` : '';
    const cat = `<c:cat><c:strRef><c:f>${x(ch.catRef)}</c:f><c:strCache><c:ptCount val="${ch.cats.length}"/>${ch.cats.map((c, j) => `<c:pt idx="${j}"><c:v>${x(c)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>`;
    const val = `<c:val><c:numRef><c:f>${x(s.ref)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${s.values.length}"/>${s.values.map((v, j) => Number.isFinite(v) ? `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>` : '').join('')}</c:numCache></c:numRef></c:val>`;
    return ch.type === 'pie'
      ? `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${fill}${lbl}${cat}${val}</c:ser>`
      : `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${fill}${cat}${val}</c:ser>`;
  };
  const plot = ch.type === 'pie'
    ? `<c:pieChart><c:varyColors val="1"/>${ch.series.map(ser).join('')}<c:firstSliceAng val="0"/></c:pieChart>`
    : `<c:areaChart><c:grouping val="${ch.type === 'area%' ? 'percentStacked' : 'stacked'}"/><c:varyColors val="0"/>${ch.series.map(ser).join('')}<c:axId val="101"/><c:axId val="102"/></c:areaChart>`
      + `<c:catAx><c:axId val="101"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/>${font(1000)}<c:crossAx val="102"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`
      + `<c:valAx><c:axId val="102"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="${ch.type === 'area%' ? '0%' : '#,##0'}" sourceLinked="0"/><c:tickLblPos val="nextTo"/>${font(1000)}<c:crossAx val="101"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  const legend = ch.type === 'pie' ? '' : `<c:legend><c:legendPos val="t"/><c:overlay val="0"/>${font(1100)}</c:legend>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="zero"/></c:chart>`
    + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' + font(1100) + '</c:chartSpace>';
}

// The workbook's files from its sheets.
async function mpXlsxZip(sheets) {
  if (!window.JSZip) {
    await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = ok; s.onerror = () => fail(new Error('JSZip did not load')); document.head.appendChild(s); });
  }
  const zip = new JSZip();
  const strings = [], strIdx = new Map();
  const str = v => { if (!strIdx.has(v)) { strIdx.set(v, strings.length); strings.push(v); } return strIdx.get(v); };
  const types = [], NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  let chartNo = 0;
  sheets.forEach((sh, i) => {
    const n = i + 1;
    const byRow = new Map();
    for (const cell of sh.cells.values()) { if (!byRow.has(cell.r)) byRow.set(cell.r, []); byRow.get(cell.r).push(cell); }
    const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map(r => `<row r="${r + 1}" ht="20" customHeight="1">${byRow.get(r).sort((a, b) => a.c - b.c).map(cell => {
      const ref = `${mpColL(cell.c)}${r + 1}`;
      if (typeof cell.v === 'string' && !cell.f) return `<c r="${ref}" t="s" s="${cell.s}"><v>${str(cell.v)}</v></c>`;
      return `<c r="${ref}" s="${cell.s}">${cell.f ? `<f>${mpXmlEsc(cell.f)}</f>` : ''}<v>${cell.v}</v></c>`;
    }).join('')}</row>`).join('');
    const colsXml = Object.keys(sh.widths).length
      ? `<cols>${Object.entries(sh.widths).sort((a, b) => a[0] - b[0]).map(([c, w]) => `<col min="${+c + 1}" max="${+c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    zip.file(`xl/worksheets/sheet${n}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}"><sheetViews><sheetView workbookViewId="0" zoomScale="100" zoomScaleNormal="100" showGridLines="0"/></sheetViews>${colsXml}<sheetData>${rowsXml}</sheetData>${sh.charts.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`);
    types.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    if (!sh.charts.length) return;
    zip.file(`xl/worksheets/_rels/sheet${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`);
    const anchors = [], rels = [];
    sh.charts.forEach((ch, j) => {
      chartNo++;
      zip.file(`xl/charts/chart${chartNo}.xml`, mpXlsxChartXml(ch));
      types.push(`<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      rels.push(`<Relationship Id="rId${j + 1}" Type="${NS}/chart" Target="../charts/chart${chartNo}.xml"/>`);
      // the top-left cell and a size in pixels (EMU: 9525 a pixel) -- Numbers
      // lays rows out taller than a file says, so a size in cells comes out uneven
      const { c, r, w, h } = ch.at;
      anchors.push(`<xdr:oneCellAnchor><xdr:from><xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${w * 9525}" cy="${h * 9525}"/>`
        + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${j + 2}" name="Chart ${j + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
        + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
        + `<c:chart r:id="rId${j + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`);
    });
    zip.file(`xl/drawings/drawing${n}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
    types.push(`<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
  });
  zip.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t xml:space="preserve">${mpXmlEsc(s)}</t></si>`).join('')}</sst>`);
  // the look of money.numbers: grey header / label column, darker totals, a grid of thin lines
  // styles: 0 plain, 1 header, 2 money, 3 whole, 4 coin, 5 title, 6 total whole, 7 total money,
  // 8 label, 9 total label, 10 money on grey, 11 text in the grid, 12 grand money, 13 share
  const xf = (num, font, fill, border) => `<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>`;
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="#,##0.00######"/><numFmt numFmtId="167" formatCode="0.00"/></numFmts>'
    + '<fonts count="3"><font><sz val="10"/><name val="Helvetica Neue"/></font><font><b/><sz val="10"/><name val="Helvetica Neue"/></font><font><b/><sz val="16"/><name val="Helvetica Neue"/></font></fonts>'
    + '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFDBDBDB"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFC8C8C8"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFA5A5A5"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"><color rgb="FFAAAAAA"/></left><right style="thin"><color rgb="FFAAAAAA"/></right><top style="thin"><color rgb="FFAAAAAA"/></top><bottom style="thin"><color rgb="FFAAAAAA"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="14">${[xf(0, 0, 0, 0), xf(0, 1, 2, 1), xf(164, 0, 0, 1), xf(165, 0, 0, 1), xf(166, 0, 0, 1), xf(0, 2, 0, 0), xf(165, 1, 3, 1), xf(164, 1, 3, 1),
      xf(0, 1, 2, 1), xf(0, 1, 4, 1), xf(164, 0, 2, 1), xf(0, 0, 0, 1), xf(164, 1, 4, 1), xf(167, 0, 0, 1)].join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}"><sheets>${sheets.map((s, i) => `<sheet name="${mpXmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="${NS}/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="${NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + types.join('') + '</Types>');
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// The names money.numbers shows: accounts in its order, currencies and indexes with flags.
const MP_XLSX_ACCOUNT = {
  Revolut: 'Revolut 🇪🇺', Wise: 'Wise 🇪🇺', 'Bank of Cyprus': 'Банк Кипра 🇨🇾', IBKR: 'IBKR 🇺🇸', Freedom24: 'Freedom24 🇰🇿',
  'Ziraat Bank': 'Зираат 🇹🇷', Raiffeisen: 'Райф 🇷🇸', 'Credo Bank': 'Credo 🇬🇪', 'TBC Bank': 'TBC 🇬🇪', Sber: 'Сбер 🇷🇺', 'T-Bank': 'Тиньков 🇷🇺',
  Alfa: 'Альфа 🇷🇺', 'Ozon Bank': 'Ozon-Банк 🇷🇺', 'Yandex Bank': 'Яндекс 🇷🇺', Finuslugi: 'Финуслуги 🇷🇺',
  Binance: 'Binance', Bybit: 'Bybit', 'Crypto.com': 'Cryptocom', Telegram: 'Telegram', Trust: 'Trust', Nexo: 'Nexo', cash: 'cash 💵',
};
const MP_XLSX_FLAG = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', RUB: '🇷🇺', TRY: '🇹🇷', RSD: '🇷🇸', CNY: '🇨🇳', GEL: '🇬🇪' };
const MP_XLSX_INDEX_LABEL = { 'S&P500': 'S&P500 🇺🇸', 'S&P400': 'S&P400 🇺🇸', 'S&P600': 'S&P600 🇺🇸', 'STOXX600': 'STOXX600 🇪🇺', MOEX: 'MOEX 🇷🇺', 'Акции мира': 'Акции мира 🌎' };
const mpXlsxAcc = a => MP_XLSX_ACCOUNT[a] ?? a;
const mpXlsxCol = c => MP_XLSX_FLAG[c] ? `${c} ${MP_XLSX_FLAG[c]}` : c;
const mpXlsxAccOrder = (a, b) => {
  const keys = Object.keys(MP_XLSX_ACCOUNT), i = keys.indexOf(a), j = keys.indexOf(b);
  return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || a.localeCompare(b);
};

// One date's sheet, as money.numbers lays it out: accounts x currencies (each
// cell the sum of the positions in that currency), the USD total of the row
// from the rates below, asset types and indexes (sums of the positions in
// USD), the totals, the rates, the totals in USD; the Russian block and the
// flat to the right of it; the pies' data further right, its cells referring
// to the table's; the pies under the table, four to a row.
function mpXlsxDaySheet(model, s, name) {
  const { cols, classes, isFiat } = model;
  const sh = mpXlsxSheet(name);
  const L = mpColL;
  const [y, mo, d] = s.day.split('-').map(Number);
  sh.set(0, 0, `${d} ${MP_XLSX_RU_MONTHS[mo - 1]} ${y}`, 5);
  const accounts = [...s.acc.entries()].sort((a, b) => mpXlsxAccOrder(a[0], b[0]));
  const H = 2, R0 = 3, RN = R0 + accounts.length - 1;
  const cCol = i => 1 + i, cTot = 1 + cols.length, cCls = i => cTot + 1 + i, cClsTot = cTot + 1 + classes.length;
  const cIdx = i => cClsTot + 1 + i, cIdxTot = cClsTot + 1 + MP_XLSX_INDEXES.length;
  const rT = RN + 1, rRate = RN + 2, rUsd = RN + 3;
  const cRub = cols.indexOf('RUB') >= 0 ? cCol(cols.indexOf('RUB')) : null;
  const rubRef = cRub !== null ? `${L(cRub)}$${rRate + 1}` : String(s.rubPerUsd || 0);
  const sumOf = list => list.reduce((t, v) => t + v, 0);
  const plus = (list, dec) => list.map(v => v.toFixed(dec)).join('+');

  sh.set(H, 0, '', 1);
  cols.forEach((c, i) => sh.set(H, cCol(i), mpXlsxCol(c), 1));
  sh.set(H, cTot, 'Всего (USD)', 9);
  classes.forEach((c, i) => sh.set(H, cCls(i), c, 1));
  sh.set(H, cClsTot, 'Всего', 9);
  MP_XLSX_INDEXES.forEach((c, i) => sh.set(H, cIdx(i), MP_XLSX_INDEX_LABEL[c], 1));
  sh.set(H, cIdxTot, 'Всего', 9);

  accounts.forEach(([acc, a], k) => {
    const r = R0 + k;
    sh.set(r, 0, mpXlsxAcc(acc), 8);
    cols.forEach((c, i) => {
      const parts = a.pos.filter(p => p.col === c && p.native).map(p => p.native);
      const dec = isFiat(c) ? 2 : 8;
      if (!parts.length) { sh.set(r, cCol(i), 0, isFiat(c) ? 2 : 4); return; }
      sh.set(r, cCol(i), Number(sumOf(parts).toFixed(dec)), isFiat(c) ? 2 : 4, plus(parts, dec));
    });
    const terms = cols.map((c, i) => s.rate(c) ? `${L(cCol(i))}${r + 1}${isFiat(c) ? '/' : '*'}${L(cCol(i))}$${rRate + 1}` : null).filter(Boolean);
    sh.set(r, cTot, a.usd, 10, terms.join('+') || null);
    classes.forEach((c, i) => {
      const parts = a.pos.filter(p => p.cls === c).map(p => p.usd);
      if (parts.length) sh.set(r, cCls(i), sumOf(parts), 2, plus(parts, 2));
    });
    sh.set(r, cClsTot, a.usd, 10, `SUM(${L(cCls(0))}${r + 1}:${L(cCls(classes.length - 1))}${r + 1})`);
    MP_XLSX_INDEXES.forEach((c, i) => {
      const parts = a.pos.filter(p => p.idx === c).map(p => p.usd);
      if (parts.length) sh.set(r, cIdx(i), sumOf(parts), 2, plus(parts, 2));
    });
    const st = sumOf(a.pos.filter(p => p.idx).map(p => p.usd));
    if (st) sh.set(r, cIdxTot, st, 10, `SUM(${L(cIdx(0))}${r + 1}:${L(cIdx(MP_XLSX_INDEXES.length - 1))}${r + 1})`);
  });

  // totals: in each currency, its rate to the dollar, in USD
  sh.set(rT, 0, 'Всего', 9); sh.set(rRate, 0, 'Курс к доллару', 8); sh.set(rUsd, 0, 'Всего (USD)', 9);
  const sum = c => accounts.length ? `SUM(${L(c)}${R0 + 1}:${L(c)}${RN + 1})` : '0';
  const colSum = c => accounts.reduce((t, _, k) => t + (sh.get(R0 + k, c) || 0), 0);
  cols.forEach((c, i) => {
    const rate = s.rate(c);
    sh.set(rT, cCol(i), colSum(cCol(i)), isFiat(c) ? 7 : 4, sum(cCol(i)));
    if (rate) sh.set(rRate, cCol(i), rate, isFiat(c) ? 4 : 2);
    sh.set(rUsd, cCol(i), s.cols.get(c) || 0, 7, rate ? `${L(cCol(i))}${rT + 1}${isFiat(c) ? '/' : '*'}${L(cCol(i))}${rRate + 1}` : null);
  });
  const grand = accounts.reduce((t, [, a]) => t + a.usd, 0);
  sh.set(rT, cTot, grand, 12, sum(cTot));
  sh.set(rRate, cTot, grand * (s.rubPerUsd || 0), 7, `${L(cTot)}${rUsd + 1}*${rubRef}`);   // the total in rubles
  sh.set(rUsd, cTot, grand, 12, `${L(cTot)}${rT + 1}`);
  classes.forEach((c, i) => sh.set(rUsd, cCls(i), colSum(cCls(i)), 7, sum(cCls(i))));
  sh.set(rUsd, cClsTot, grand, 12, `SUM(${L(cCls(0))}${rUsd + 1}:${L(cCls(classes.length - 1))}${rUsd + 1})`);
  // the world funds look through to the indexes: 53% S&P 500, 7% S&P 400, 16% STOXX 600, 24% the rest
  const world = sumOf(accounts.flatMap(([, a]) => a.pos.filter(p => p.worldFund).map(p => p.usd)));
  const share = { 'S&P500': 0.53, 'S&P400': 0.07, STOXX600: 0.16, 'Акции мира': -0.76 };
  let idxGrand = 0;
  MP_XLSX_INDEXES.forEach((c, i) => {
    const v = colSum(cIdx(i)) + (share[c] || 0) * world;
    idxGrand += v;
    sh.set(rUsd, cIdx(i), v, 7, share[c] && world ? `${sum(cIdx(i))}${share[c] > 0 ? '+' : '-'}${world.toFixed(2)}*${Math.abs(share[c])}` : sum(cIdx(i)));
  });
  sh.set(rUsd, cIdxTot, idxGrand, 12, `SUM(${L(cIdx(0))}${rUsd + 1}:${L(cIdx(MP_XLSX_INDEXES.length - 1))}${rUsd + 1})`);

  // Russia, USD and rubles, and the rest of the world -- to the right
  const cRu = cIdxTot + 2;
  sh.set(R0, cRu - 1, 'USD', 8); sh.set(R0 + 1, cRu - 1, 'RUB', 8);
  MP_XLSX_RU.forEach((k, i) => {
    const parts = s.ruPos[k] || [];
    sh.set(H, cRu + i, k, 1);
    sh.set(R0, cRu + i, s.ru[k] || 0, 2, parts.length ? plus(parts, 2) : null);
    sh.set(R0 + 1, cRu + i, (s.ru[k] || 0) * (s.rubPerUsd || 0), 3, `${L(cRu + i)}${R0 + 1}*${rubRef}`);
  });
  const ruTot = MP_XLSX_RU.reduce((t, k) => t + (s.ru[k] || 0), 0), cRuT = cRu + MP_XLSX_RU.length;
  sh.set(H, cRuT, 'Всего 🇷🇺', 9); sh.set(H, cRuT + 1, 'Всего 🌎', 9);
  sh.set(R0, cRuT, ruTot, 7, `SUM(${L(cRu)}${R0 + 1}:${L(cRuT - 1)}${R0 + 1})`);
  sh.set(R0 + 1, cRuT, ruTot * (s.rubPerUsd || 0), 6, `SUM(${L(cRu)}${R0 + 2}:${L(cRuT - 1)}${R0 + 2})`);
  sh.set(R0, cRuT + 1, grand - ruTot, 7, `${L(cTot)}${rUsd + 1}-${L(cRuT)}${R0 + 1}`);
  // the flat
  const cFlat = cRuT + 3;
  sh.set(H, cFlat, 'кв.м.', 1); sh.set(H, cFlat + 1, 'Квартира', 9);
  if (s.m2) sh.set(R0, cFlat, Number(s.m2.price_per_m2), 3);
  sh.set(R0, cFlat + 1, s.estate.usd, 2);
  sh.set(R0 + 1, cFlat, 'с квартирой', 8);
  sh.set(R0 + 1, cFlat + 1, grand + s.estate.usd, 12, `${L(cFlat + 1)}${R0 + 1}+${L(cTot)}${rUsd + 1}`);

  // the pies take their slices straight from the table, as the original does:
  // a label cell and a value cell for each
  const ref = (r, c) => `${L(c)}${r + 1}`;
  const clsTotRef = k => ref(rUsd, cCls(classes.indexOf(k)));
  const coins = cols.filter(c => !isFiat(c) && c !== 'XAU');
  const accRow = acc => R0 + accounts.findIndex(x => x[0] === acc);
  const cls = k => [[H, cCls(classes.indexOf(k))], [rUsd, cCls(classes.indexOf(k))]];
  const idx = k => [[H, cIdx(MP_XLSX_INDEXES.indexOf(k))], [rUsd, cIdx(MP_XLSX_INDEXES.indexOf(k))]];
  const blocks = [
    ['По валютам', cols.map((c, i) => [[H, cCol(i)], [rUsd, cCol(i)]])],
    ['По банкам', accounts.map(([acc]) => [[accRow(acc), 0], [accRow(acc), cTot]])],
    ['По типам активов', classes.map(cls)],
    ['Акции по индексам', MP_XLSX_INDEXES.map(idx)],
    ['Крипта', coins.map(c => [[H, cCol(cols.indexOf(c))], [rUsd, cCol(cols.indexOf(c))]])],
    ['Россия', [idx('MOEX'), ...MP_XLSX_RU.map((k, i) => [[H, cRu + i], [R0, cRu + i]])]],
    ['Инвестиции', ['Акции', 'Облигации', 'Вклады'].filter(k => classes.includes(k)).map(cls)],
    ['Акции по брокерам', classes.includes('Акции') ? accounts.map(([acc]) => [[accRow(acc), 0], [accRow(acc), cCls(classes.indexOf('Акции'))]]) : []],
    ['Россия и мир', [[[H, cRuT], [R0, cRuT]], [[H, cRuT + 1], [R0, cRuT + 1]]]],
    ['С квартирой', [...classes.map(cls), [[H, cFlat + 1], [R0, cFlat + 1]]]],
  ].map(([t, list]) => [t, list.filter(([, [r, c]]) => (sh.get(r, c) || 0) > 0.005)]).filter(([, list]) => list.length);
  const q = `'${name.replace(/'/g, "''")}'!`;
  const union = cells => `(${cells.map(([r, c]) => `${q}$${L(c)}$${r + 1}`).join(',')})`;
  const pieTop = rUsd + 3;
  blocks.forEach(([title, list], b) => {
    sh.charts.push({
      type: 'pie', title, at: { c: (b % 4) * 6, r: pieTop + Math.floor(b / 4) * 27, w: 520, h: 480 },
      catRef: union(list.map(x => x[0])), cats: list.map(([[r, c]]) => sh.get(r, c)), colors: mpXlsxColors(title, list.map(([[r, c]]) => sh.get(r, c))),
      series: [{ name: 'USD', ref: union(list.map(x => x[1])), values: list.map(([, [r, c]]) => sh.get(r, c) || 0) }],
    });
  });

  // where the summary takes its numbers from
  sh.refs = {
    cls: Object.fromEntries(classes.map(k => [k, q + clsTotRef(k)])),
    col: Object.fromEntries(cols.map((c, i) => [c, q + ref(rUsd, cCol(i))])),
    acc: Object.fromEntries(accounts.map(([acc]) => [acc, q + ref(accRow(acc), cTot)])),
    estate: q + ref(R0, cFlat + 1),
  };
  // money.numbers' widths: the accounts, the currencies, the asset types and indexes, the blocks on the right
  sh.widths[0] = 16.35;
  for (let c = 1; c <= cFlat + 1; c++) sh.widths[c] = c < cTot ? 10.63 : c <= cIdxTot ? 13 : 13.89;
  return sh;
}

// The summary: the history by asset type, currency and account -- each cell
// referring to its date's sheet -- and the same as shares of the total, with a
// stacked-area chart for each; the charts on top, the tables below them.
function mpXlsxSummary(model, daySheets) {
  const { snaps, cols, classes } = model;
  const sh = mpXlsxSheet('Сводка');
  const label = s => s.day.split('-').reverse().join('.');
  const accounts = [...new Set(snaps.flatMap(s => [...s.acc.keys()]))].sort(mpXlsxAccOrder);
  const clsOf = (s, k) => [...s.acc.values()].reduce((t, a) => t + (a.cls[k] || 0), 0);
  const tables = [
    // the flat is a column of its own, left out of the total and the chart
    ['По типам активов', classes, (s, k) => clsOf(s, k), 'cls', [['Недвижимость', s => s.estate.usd, 'estate']], k => k],
    ['По валютам', cols, (s, k) => s.cols.get(k) || 0, 'col', [], mpXlsxCol],
    ['По банкам', accounts, (s, k) => s.acc.get(k)?.usd || 0, 'acc', [], mpXlsxAcc],
  ];
  const n = snaps.length;
  const r = 46, pctTop = r + n + 4;
  let c0 = 0;
  tables.forEach(([title, keys, value, kind, extra, show], t) => {
    const shown = keys.filter(k => snaps.some(s => Math.abs(value(s, k)) > 0.5));
    const cTot = c0 + 1 + shown.length;
    for (const pct of [false, true]) {
      const top = pct ? pctTop : r;
      sh.set(top - 1, c0, pct ? `${title}-1` : title, 0);
      sh.set(top, c0, '', 1);
      shown.forEach((k, i) => sh.set(top, c0 + 1 + i, show(k), 1));
      sh.set(top, cTot, 'Всего', 9);
      if (!pct) extra.forEach(([k], e) => sh.set(top, cTot + 1 + e, k, 1));
      snaps.forEach((s, j) => {
        const row = top + 1 + j, absRow = r + 1 + j;
        const refs = daySheets[j].refs;
        const tot = shown.reduce((a, k) => a + value(s, k), 0);
        sh.set(row, c0, label(s), 8);
        shown.forEach((k, i) => {
          const cell = `${mpColL(c0 + 1 + i)}${absRow + 1}`;
          if (pct) sh.set(row, c0 + 1 + i, tot ? value(s, k) / tot : 0, 13, `IF(${mpColL(cTot)}${absRow + 1}=0,0,${cell}/${mpColL(cTot)}${absRow + 1})`);
          else sh.set(row, c0 + 1 + i, value(s, k), 2, refs[kind][k] ?? null);
        });
        sh.set(row, cTot, tot, 7, pct ? `${mpColL(cTot)}${absRow + 1}` : `SUM(${mpColL(c0 + 1)}${row + 1}:${mpColL(cTot - 1)}${row + 1})`);
        if (!pct) extra.forEach(([, f, key], e) => sh.set(row, cTot + 1 + e, f(s), 2, refs[key] ?? null));
      });
      sh.charts.push({
        type: pct ? 'area%' : 'area', title, at: { c: t * 9, r: pct ? 25 : 1, w: 820, h: 420 },
        catRef: mpRef('Сводка', c0, top + 1, c0, top + n), cats: snaps.map(label), colors: mpXlsxColors(`area:${title}`, shown.map(show)),
        series: shown.map((k, i) => ({ name: show(k), nameRef: mpRef('Сводка', c0 + 1 + i, top, c0 + 1 + i, top),
          ref: mpRef('Сводка', c0 + 1 + i, top + 1, c0 + 1 + i, top + n), values: snaps.map(s => Math.max(0, value(s, k))) })),
      });
    }
    c0 = cTot + 2 + extra.length;
  });
  for (let c = 0; c < c0 + 2; c++) sh.widths[c] = 10.63;
  let c1 = 0;
  for (const [, keys, value, , extra] of tables) {   // the date columns, as wide as money.numbers'
    sh.widths[c1] = 16.35;
    c1 += 3 + keys.filter(k => snaps.some(s => Math.abs(value(s, k)) > 0.5)).length + extra.length;
  }
  return sh;
}

document.getElementById('mp_xlsx_export').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_xlsx_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  statusEl.textContent = 'Loading the capital history…';
  try {
    const model = await mpXlsxModel(document.getElementById('mp_xlsx_from').value || '2024-11');
    const names = model.snaps.map((s, i) => {
      const [y, m, d] = s.day.split('-').map(Number);
      // the latest day, when it isn't a 6th, as money.numbers names it (a dot in a name breaks Numbers' chart ranges)
      return i === model.snaps.length - 1 && d !== 6 ? 'cur' : `${MP_XLSX_EN_MONTHS[m - 1]} ${y}`;
    });
    statusEl.textContent = 'Building the workbook…';
    const days = model.snaps.map((s, i) => mpXlsxDaySheet(model, s, names[i]));
    const sheets = [mpXlsxSummary(model, days), ...days];
    const blob = await mpXlsxZip(sheets);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `money_${model.lastDay}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    statusEl.textContent = `Downloaded: a summary and ${model.snaps.length} dates (${model.snaps[0].day} … ${model.lastDay}).`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Full export to Snowball ----
// Mirrors Snowball's own export (statements/Snowball_Export_*.csv): every
// field quoted, upper-case events, "YYYY-MM-DD 00:00:00" dates, comma
// decimals; listed securities by exchange (MCX, NASDAQ, LSE, ...), the rest
// as CUSTOM_HOLDING with CUSTOM_HOLDING_PRICE / CUSTOM_HOLDING_SETTINGS rows.
const SNOWBALL_HEADER = ['Event', 'Date', 'Symbol', 'Price', 'Quantity', 'Currency', 'FeeTax', 'Exchange', 'NKD', 'FeeCurrency', 'DoNotAdjustCash', 'Note'];
const SNOWBALL_EXCHANGE = { MOEX: 'MCX', MCX: 'MCX', ARCA: 'NYSE ARCA', NYSEARCA: 'NYSE ARCA', LSEETF: 'LSE', IBIS: 'XETRA' };
// Where Snowball lists a US share the broker gives no exchange for
// (Freedom24's "MU.US"), as its own export has them.
const SNOWBALL_US_LISTING = { MU: 'NASDAQ', TSEM: 'NASDAQ', SNAP: 'NYSE', WMT: 'NYSE', SPCX: 'NYSE ARCA' };
// Snowball's CustomHoldingType codes, as seen in its export: 2 deposit, 3 metal, 8 crypto.
const SNOWBALL_CUSTOM_TYPE = { deposit: [2, 'Cash'], gold: [3, 'Materials'], crypto: [8, 'Crypto'] };
// Exchange log kinds (import-bybit / -binance / -crypto-com / -telegram-wallet)
// that are a trade or a reward; deposits, withdrawals, transfers, Earn moves
// and network fees are not -- the reconciling row covers what they change.
const SNOWBALL_WALLET_TRADE_KINDS = new Set(['trade', 'convert', 'purchase', 'trade_out', 'card']);
const SNOWBALL_WALLET_REWARD_KINDS = new Set(['interest', 'reward']);
// Snowball caps the number of custom holdings, so only the ones it already
// has are exported; other crypto, deposits, savings and ЦФА are left out.
const SNOWBALL_CUSTOM_HOLDINGS = new Set(['BTC', 'ETH', 'XAUT', 'XAU', 'ВКЛАД:Т16%13']);
const SNOWBALL_STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP']);
const SNOWBALL_FIAT = new Set(['EUR', 'USD', 'GBP', 'CHF', 'RUB', 'TRY', 'AUD', 'CAD', 'BRL', 'SGD']);

// Plain decimal (never "1e-7"), at most 10 fraction digits, comma separator.
function snowballNumber(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(10).replace(/\.?0+$/, '').replace('.', ',');
}

// What kind of custom holding a ticker is, or null for a listed security.
function snowballCustomKind(ticker, exchange, mp) {
  if (/^(DEPOSIT|SAVINGS|ВКЛАД):/.test(ticker)) return 'deposit';
  if (/^CFA:/.test(ticker) || exchange === 'Atomyze') return 'other';
  if (/^TOKEN:/.test(ticker)) return 'crypto';
  // Not 'liquid': that's money-market funds too (SBMM, Revolut's IE... funds), listed in Snowball.
  const type = mp?.instrument_type;
  if (type === 'crypto' || type === 'gold' || type === 'deposit') return type;
  if (mp?.asset_class === 'crypto') return 'crypto';
  if (mp?.asset_class === 'gold') return 'gold';
  return null;
}

// The name Snowball knows a custom holding by: a statement deposit that
// replaced a Snowball one ("[replaces Snowball DEPOSIT:Т16%13]",
// import-bank-csv) goes back to it, with Snowball's own "ВКЛАД:" prefix.
function snowballCustomSymbol(ticker, note) {
  const replaced = String(note || '').match(/\[replaces Snowball ([^\]]+)\]/)?.[1].trim() || ticker;
  const legacy = replaced.replace(/^DEPOSIT:/, 'ВКЛАД:');
  return SNOWBALL_CUSTOM_HOLDINGS.has(legacy) ? legacy : replaced;
}

// Snowball's exchange code; '' when unknown. A MOEX-priced security is MCX
// whatever venue the broker booked it on (T-Bank: ММВБ, СПБ, ВНБ).
function snowballListedExchange(exchange, mp) {
  if ((mp?.asset_class || '').startsWith('moex') || mp?.source === 'moex_iss') return 'MCX';
  const e = (exchange || '').trim().toUpperCase();
  if (/МОСК|MOSCOW|ММВБ/.test(e)) return 'MCX';
  if (!e || /СПБ|ВНБ/.test(e)) return '';
  return SNOWBALL_EXCHANGE[e] || e;
}

// The full export's rows ([date, ticker, cells]), sorted by date, and a
// summary of what was left out -- for its own button and for the cash one.
async function snowballFullRows(statusEl) {
  {
    statusEl.textContent = 'Loading trades, wallets and prices…';
    const [trades, wallets, balances, walletTxs, holdings, cardBuys] = await Promise.all([
      mpFetchAll(() => sb.from('trades')
        .select('ticker, side, quantity, price, trade_date, currency, fee_tax, fee_currency, exchange, nkd, account, note, external_source, external_id')
        .order('trade_date').order('id')),
      mpFetchAll(() => sb.from('crypto_wallets').select('id, chain, account')),
      mpFetchAll(() => sb.from('wallet_balances').select('wallet_id, contract, ticker')),
      mpFetchAll(() => sb.from('wallet_transactions')
        .select('wallet_id, tx_hash, seq, tx_time, kind, contract, symbol, amount').order('tx_time')),
      mpFetchAll(() => sb.from('portfolio_value_usd').select('ticker, quantity')),
      mpFetchAll(() => sb.from('card_crypto_purchases')
        .select('wallet_id, tx_hash, kind, seq, paid, currency').in('matched_by', ['auto', 'manual'])),
    ]);

    const marketRows = await mpFetchAll(() => sb.from('market_prices')
      .select('ticker, price_usd, asset_class, instrument_type, source'));
    const market = new Map(marketRows.map(m => [m.ticker, m]));

    // Each ticker's custom-holding kind (null = listed) and quote currency.
    const kindOf = new Map();
    const currencyOf = new Map();
    const noteCurrency = (ticker, cur) => { if (cur && !currencyOf.has(ticker)) currencyOf.set(ticker, cur); };

    const rows = [];  // [date, ticker, cells[]]
    // Snowball's import refuses a ":" in Symbol, though its own export writes
    // one (its deposit "ВКЛАД:Т16%13"): "ВКЛАД-Т16%13" -- import-trades-csv
    // reads it back as "ВКЛАД:".
    const push = (event, date, ticker, price, quantity, currency, feeTax, exchange, nkd, feeCurrency, note) => {
      rows.push([date, ticker, [event, `${date} 00:00:00`, ticker.replace(/:/g, '-'), snowballNumber(price), snowballNumber(quantity),
        currency || '', snowballNumber(feeTax || 0), exchange, snowballNumber(nkd ?? 0), feeCurrency || '', 'False', note || '']]);
    };
    // Running quantity of every custom holding, to reconcile crypto at the end.
    const customQty = new Map();
    const addQty = (ticker, q) => customQty.set(ticker, (customQty.get(ticker) || 0) + q);

    // 1. Trades table: brokers, funds, deposits, ЦФА, metals, Snowball's own rows.
    // Rows left out of current holdings (holding_exclusions: coins counted in
    // a wallet now) stay in: here they're the purchase history, and crypto is
    // reconciled with the balances at the end anyway.
    const leftOut = new Set();  // custom holdings Snowball doesn't have
    let tradeRows = 0;
    // Like Snowball's own portfolio, the export starts on its first deal.
    let beforeStart = 0;
    let movedWithoutDeal = 0;
    const gifts = [];  // shares credited at price 0, waiting for the day's price
    const blocked = new Set();
    const noPosition = new Set();  // sales of what was bought before the start
    // Buys before sales on a day, so a same-day round trip has its position.
    const sideOrder = { buy: 0, stock_as_dividend: 1, dividend: 2, amortisation: 3, repayment: 4, sell: 5 };
    trades.sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : sideOrder[a.side] - sideOrder[b.side]));
    // The exchange a ticker is booked on anywhere, for its rows that have none.
    const exchangeOf = new Map();
    for (const t of trades) {
      const e = snowballListedExchange(t.exchange, market.get(t.ticker));
      if (e && !exchangeOf.has(t.ticker)) exchangeOf.set(t.ticker, e);
    }
    // A bond's last principal payment; a "repayment" before it was a partial one.
    const lastPrincipal = new Map();
    for (const t of trades) if (t.side === 'amortisation' || t.side === 'repayment') lastPrincipal.set(t.ticker, t.trade_date);
    const position = new Map();  // position over all trades, the start's earlier ones too
    const accountPosition = new Map();  // the same per account: a payout is for the shares held there
    const exported = new Map();  // position in the export (from the start)
    const redeemed = new Set();
    for (const t of trades) {
      const mp = market.get(t.ticker);
      const before = position.get(t.ticker) || 0;
      const accountKey = `${t.account}|${t.ticker}`;
      const held = accountPosition.get(accountKey) || 0;
      const q = Number(t.quantity);
      if (t.side === 'buy' || t.side === 'stock_as_dividend') { position.set(t.ticker, before + q); accountPosition.set(accountKey, held + q); }
      if (t.side === 'sell') { position.set(t.ticker, before - q); accountPosition.set(accountKey, held - q); }
      // Securities moved between T-Bank's agreements (or under a new code)
      // with no deal: import-tbank-broker's zero-price reconciling rows, dated
      // the report's end as it gives no date. Not deals in the portfolio.
      if (t.external_source === 'tbank_broker_xlsx' && (t.external_id || '').includes(':adjust:')) { movedWithoutDeal++; continue; }
      // Blocked assets (bought before the Snowball portfolio) aren't in it.
      if (t.ticker.startsWith('BLOCKED:') || mp?.asset_class === 'blocked') { blocked.add(t.ticker); continue; }
      if (t.trade_date < MP_SNOWBALL_START) { beforeStart++; continue; }
      let event = MP_FUND_SNOWBALL_EVENT[t.side];
      if (!event) continue;
      if (mp?.instrument_type === 'cash' || mp?.instrument_type === 'fx_rate') continue;
      // A coin from a crypto statement (Revolut crypto) that has no price row.
      const kind = snowballCustomKind(t.ticker, t.exchange, mp) || (/crypto/.test(t.external_source || '') ? 'crypto' : null);
      const symbol = kind ? snowballCustomSymbol(t.ticker, t.note) : t.ticker;
      if (kind && !SNOWBALL_CUSTOM_HOLDINGS.has(symbol)) { leftOut.add(symbol); continue; }
      kindOf.set(symbol, kind);
      if (kind) {
        // A deposit's interest is income, not money put in.
        if (kind === 'deposit' && t.side === 'buy' && /interest|капитализац|процент/i.test(t.note || '')) event = 'Stock_As_Dividend';
        noteCurrency(symbol, t.currency);
        if (t.side === 'buy' || t.side === 'stock_as_dividend') addQty(symbol, q);
        if (t.side === 'sell') addQty(symbol, -q);
        push(event.toUpperCase(), t.trade_date, symbol, t.price, t.quantity, t.currency, t.fee_tax, 'CUSTOM_HOLDING',
          t.nkd, t.fee_currency || t.currency, t.account);
        tradeRows++;
        continue;
      }
      // Snowball's fields: a payout's price is per share / bond, a redemption's
      // quantity is the bonds. Brokers that book only the amount (Sber: price =
      // amount) get them from the position held.
      let price = Number(t.price);
      let quantity = q;
      if (event === 'Repayment' && t.trade_date < lastPrincipal.get(t.ticker)) event = 'Amortisation';
      if ((event === 'Dividend' || event === 'Amortisation') && price === quantity && (held > 0 || before > 0)) price = quantity / (held > 0 ? held : before);
      if (event === 'Repayment') {
        if (before > 0 && Math.abs(quantity - before) > 1e-9) { price = quantity / before; quantity = before; }
        redeemed.add(t.ticker);
      }
      const have = exported.get(t.ticker) || 0;
      if (event === 'Sell') {
        // The broker's own write-off of a redeemed bond: the redemption did it.
        if (price === 0 && redeemed.has(t.ticker)) continue;
        if (have <= 1e-9) { noPosition.add(t.ticker); continue; }
        quantity = Math.min(quantity, have);
      }
      if (event === 'Buy' || event === 'Stock_As_Dividend') exported.set(t.ticker, have + quantity);
      if (event === 'Sell' || event === 'Repayment') exported.set(t.ticker, have - quantity);
      // Snowball takes a bond's price in money and its accrued interest per
      // bond. Sber and T-Bank give the price in % of a 1000 nominal and the
      // interest for the whole deal (the same reading as refresh_investment_daily).
      let nkd = t.nkd;
      if (event === 'Buy' || event === 'Sell') {
        // (an RU... ISIN is a bond unless it's a fund's units: "паи БПИФ ...")
        const bond = ['bond', 'moex_bond', 'moex_ofz'].includes(mp?.asset_class)
          || (/^(SU|RU)\d/.test(t.ticker) && !/^паи /i.test(t.note || ''));
        if (bond && price < 300 && ['RUB', 'CNY'].includes((t.currency || 'RUB').toUpperCase())) price *= 10;
        if (bond && ['sber_broker_html', 'tbank_broker_xlsx'].includes(t.external_source) && q) nkd = Number(t.nkd || 0) / q;
      }
      // No exchange anywhere: a US share as Snowball lists it; a rouble / yuan
      // one (T-Bank's own funds booked on ВНБ) trades on MOEX.
      push(event.toUpperCase(), t.trade_date, symbol, price, quantity, t.currency, t.fee_tax,
        snowballListedExchange(t.exchange, mp) || exchangeOf.get(t.ticker) || SNOWBALL_US_LISTING[t.ticker]
          || (['RUB', 'CNY'].includes((t.currency || '').toUpperCase()) ? 'MCX' : ''),
        nkd, t.fee_currency || t.currency, t.account);
      // Shares given (Freedom24's SNAP, WMT): the report has no price -- the
      // day's market price, and no money taken for them (DoNotAdjustCash).
      if (event === 'Stock_As_Dividend' && !price) {
        const cells = rows[rows.length - 1][2];
        cells[10] = 'True';
        gifts.push([t.trade_date, t.ticker, (t.currency || 'USD').toUpperCase(), cells]);
      }
      tradeRows++;
    }

    // 2. Crypto exchange logs: trades and rewards per coin. A trade's price
    // comes from the stablecoin / fiat leg booked at the same moment, else
    // from that day's price history.
    const walletById = new Map(wallets.map(w => [w.id, w]));
    const tokenTicker = new Map(balances.filter(b => b.contract).map(b => [`${b.wallet_id}|${b.contract}`, b.ticker]));
    const coinOf = tx => (tx.contract ? tokenTicker.get(`${tx.wallet_id}|${tx.contract}`) : (tx.symbol || '').toUpperCase()) || null;
    const isQuote = s => SNOWBALL_STABLECOINS.has(s) || SNOWBALL_FIAT.has(s);
    const legs = new Map();  // wallet|time -> rows of one trade
    for (const tx of walletTxs) {
      if (!SNOWBALL_WALLET_TRADE_KINDS.has(tx.kind)) continue;
      const key = `${tx.wallet_id}|${tx.tx_time}`;
      if (!legs.has(key)) legs.set(key, []);
      legs.get(key).push(tx);
    }
    const walletCoins = new Set();
    const markWalletCoin = coin => {
      if (!coin || isQuote(coin)) return false;
      const kind = snowballCustomKind(coin, null, market.get(coin));
      if (kind !== 'crypto' && kind !== 'gold') return false;
      if (!SNOWBALL_CUSTOM_HOLDINGS.has(coin)) { leftOut.add(coin); return false; }
      kindOf.set(coin, kind);
      currencyOf.set(coin, 'USD');
      walletCoins.add(coin);
      return true;
    };
    // Coins only ever moved in (on-chain wallets) still get their reconciling row.
    for (const b of balances) markWalletCoin(b.ticker);
    const needHistory = [];  // rows waiting for a price from price_history
    // Coins bought by card through an on-ramp (card_crypto_purchases): a buy
    // at what the card paid, even when the wallet booked a plain arrival
    // (Trust's ETH on-chain).
    const cardBuyOf = new Map(cardBuys.map(c => [`${c.wallet_id}|${c.tx_hash}|${c.kind}|${c.seq}`, c]));
    let walletRows = 0;
    for (const tx of walletTxs) {
      const cardBuy = cardBuyOf.get(`${tx.wallet_id}|${tx.tx_hash}|${tx.kind}|${tx.seq}`);
      const isTrade = SNOWBALL_WALLET_TRADE_KINDS.has(tx.kind) || !!cardBuy;
      if (!isTrade && !SNOWBALL_WALLET_REWARD_KINDS.has(tx.kind)) continue;
      const coin = coinOf(tx);
      const amount = Number(tx.amount);
      if (!amount || !markWalletCoin(coin)) continue;
      if (tx.tx_time.slice(0, 10) < MP_SNOWBALL_START) { beforeStart++; continue; }
      const event = !isTrade ? 'STOCK_AS_DIVIDEND' : amount > 0 ? 'BUY' : 'SELL';
      if (event === 'STOCK_AS_DIVIDEND' && amount < 0) continue;
      let price = null;
      let currency = 'USD';
      if (cardBuy && amount > 0) {
        price = Number(cardBuy.paid) / amount;
        currency = cardBuy.currency;
      } else if (isTrade) {
        // Several fills in the same second: the quote legs pay for all of them.
        const group = legs.get(`${tx.wallet_id}|${tx.tx_time}`) || [];
        const same = group.filter(g => coinOf(g) === coin && Math.sign(Number(g.amount)) === Math.sign(amount));
        const others = group.filter(g => coinOf(g) !== coin);
        const quotes = others.filter(g => isQuote(coinOf(g)) && Math.sign(Number(g.amount)) === -Math.sign(amount));
        if (quotes.length && quotes.length === others.length && new Set(quotes.map(coinOf)).size === 1) {
          const q = coinOf(quotes[0]);
          currency = SNOWBALL_STABLECOINS.has(q) ? 'USD' : q;
          price = quotes.reduce((s, g) => s + Math.abs(Number(g.amount)), 0)
            / same.reduce((s, g) => s + Math.abs(Number(g.amount)), 0);
        }
      }
      const date = tx.tx_time.slice(0, 10);
      const account = walletById.get(tx.wallet_id)?.account || '';
      push(event, date, coin, price, Math.abs(amount), currency, 0, 'CUSTOM_HOLDING', 0, currency, account);
      if (price === null) needHistory.push(rows[rows.length - 1]);
      walletRows++;
      addQty(coin, event === 'SELL' ? -Math.abs(amount) : Math.abs(amount));
    }

    // 3. Price history for custom holdings (USD), converted to each one's currency.
    statusEl.textContent = 'Loading price history…';
    const customTickers = [...kindOf].filter(([, k]) => k && k !== 'deposit').map(([t]) => t);
    const historyTickers = [...new Set([...customTickers, ...gifts.map(g => g[1])])];
    const history = historyTickers.length ? await mpFetchAll(() => sb.from('price_history')
      .select('ticker, day, price_usd').in('ticker', historyTickers).order('ticker').order('day')) : [];
    const fxCurrencies = [...new Set([...customTickers.map(t => currencyOf.get(t) || 'USD'), ...gifts.map(g => g[2])])]
      .filter(c => c !== 'USD');
    const fx = new Map();  // currency -> [[day, usdPerUnit]] ascending
    for (const c of fxCurrencies) {
      const r = await mpFetchAll(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', c).order('day'));
      fx.set(c, r.map(x => [x.day, Number(x.usd_per_unit)]));
    }
    // Last value on or before the day, from an ascending [[day, value]] list.
    const asOf = (list, day) => {
      let lo = 0, hi = (list?.length || 0) - 1, best = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= day) { best = list[mid][1]; lo = mid + 1; } else hi = mid - 1; }
      return best;
    };
    const historyBy = new Map();
    for (const h of history) {
      if (!historyBy.has(h.ticker)) historyBy.set(h.ticker, []);
      historyBy.get(h.ticker).push([h.day, Number(h.price_usd)]);
    }
    const inCurrency = (usd, cur, day) => {
      if (usd === null || !cur || cur === 'USD') return usd;
      const rate = asOf(fx.get(cur), day);
      return rate ? usd / rate : null;
    };
    for (const row of needHistory) {
      const [date, ticker, cells] = row;
      const usd = asOf(historyBy.get(ticker), date) ?? market.get(ticker)?.price_usd ?? 0;
      cells[3] = snowballNumber(usd);
    }
    for (const [date, ticker, cur, cells] of gifts) {
      const price = inCurrency(asOf(historyBy.get(ticker), date), cur, date);
      if (price) cells[3] = snowballNumber(price);
    }

    // 4. Reconcile crypto with the current balances (transfers, network fees).
    const today = new Date().toISOString().slice(0, 10);
    const held = new Map(holdings.map(h => [h.ticker, Number(h.quantity)]));
    let reconciled = 0;
    for (const coin of walletCoins) {
      const diff = (held.get(coin) || 0) - (customQty.get(coin) || 0);
      if (Math.abs(diff) < 1e-9) continue;
      const usd = historyBy.get(coin)?.at(-1)?.[1] ?? market.get(coin)?.price_usd ?? 0;
      push(diff > 0 ? 'BUY' : 'SELL', today, coin, usd, Math.abs(diff), 'USD', 0, 'CUSTOM_HOLDING', 0, 'USD',
        'reconciled with current balance (transfers, network fees)');
      reconciled++;
    }

    // 5. Daily prices and settings.
    let priceRows = 0;
    for (const ticker of customTickers) {
      const list = historyBy.get(ticker) || [];
      const cur = currencyOf.get(ticker) || 'USD';
      list.forEach(([day, usd]) => {
        if (day < MP_SNOWBALL_START) return;
        const price = inCurrency(usd, cur, day);
        if (price === null) return;
        rows.push([day, ticker, ['CUSTOM_HOLDING_PRICE', `${day} 00:00:00`, ticker.replace(/:/g, '-'), snowballNumber(price), '0', cur,
          '0', 'CUSTOM_HOLDING', '0', '', '', '']]);
        priceRows++;
      });
    }
    for (const [ticker, kind] of kindOf) {
      const known = SNOWBALL_CUSTOM_TYPE[kind];
      if (!known) continue;
      const settings = {
        Holding: { Note: '', Currency: currencyOf.get(ticker) || 'USD', Description: ticker, DividendTax: null, Sector: known[1] },
        Settings: { CustomHoldingType: known[0], IncomeType: 1, FirstIncomeDate: null, GenerateIncome: false,
          IncomeAmount: 0, IncomeReinvestmentType: 0, IsIncomeReinvested: false, MaturityDate: null,
          Period: 1, PeriodType: 3, NextIncomeDate: null },
      };
      // Snowball writes the JSON with @*@ for quotes and \uXXXX for non-ASCII.
      const json = JSON.stringify(settings).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        .replace(/"/g, '@*@');
      rows.push([today, ticker, ['CUSTOM_HOLDING_SETTINGS', `${today} 00:00:00`, ticker.replace(/:/g, '-'), '0', '0', currencyOf.get(ticker) || 'USD',
        '0', 'CUSTOM_HOLDING', '0', '', '', json]]);
    }

    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const summary = `${tradeRows} from trades, ${walletRows} from crypto exchange logs, `
      + `${reconciled} reconciling, ${priceRows} custom-holding prices, from ${MP_SNOWBALL_START} (Snowball's first deal).`
      + (blocked.size ? ` Blocked assets left out: ${[...blocked].sort().join(', ')}.` : '')
      + (noPosition.size ? ` Sales of what was bought before ${MP_SNOWBALL_START} left out: ${[...noPosition].sort().join(', ')}.` : '')
      + (beforeStart ? ` ${beforeStart} other trades before ${MP_SNOWBALL_START} left out.` : '')
      + (movedWithoutDeal ? ` ${movedWithoutDeal} T-Bank moves without a deal (between agreements, code changes) left out.` : '')
      + (leftOut.size ? ` Left out (not a custom holding in Snowball): ${[...leftOut].sort().join(', ')}.` : '');
    return { rows, today, summary };
  }
}

function snowballDownload(rows, fileName) {
  const quote = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [SNOWBALL_HEADER.join(','), ...rows.map(r => r[2].map(quote).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('mp_full_snowball_export').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_full_snowball_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  try {
    const { rows, today, summary } = await snowballFullRows(statusEl);
    snowballDownload(rows, `snowball_full_export_${today}.csv`);
    statusEl.textContent = `Downloaded ${rows.length} rows: ${summary}`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});
// ---- Full export with cash ----
// The full export plus the money on the bank and broker accounts
// (bank_transactions: every account, credit cards and cash on hand too, but
// metal pockets) as Snowball's CASH_IN / CASH_OUT rows. Snowball moves its cash with
// every row of the full export (buys, sells,
// payouts -- DoNotAdjustCash False), so the cash rows are what's left: each
// day's change of the accounts' balances less what the export's rows of that
// day do to the cash. One row per currency for the balance the day before the
// first deal, then the rest -- money coming in or going out (a salary, a card
// payment, a transfer to a savings account, a conversion's two legs), and a
// deal's money that lands in the account on settlement, days after Snowball
// books the deal. A deal and its settlement cancel out, so what's left is
// summed over a few days and written on the first of them. Snowball's balance
// then ends where the accounts are today.
const SNOWBALL_CASH_WINDOW_DAYS = 4;
const SNOWBALL_METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);
// Bank rows with a kind of their own, by how the statements word them; the
// rest is money in / out. A conversion is two rows of one bank a few minutes
// apart, one currency out and another in: worded the same (Ziraat's "Döviz
// Satış" with its Ref, Revolut's "Exchanged to GBP", Raiffeisen's
// "kupoprodaja efektive" with its number), or else both worded as one. A
// broker's commission for a deal (Sber's "Комиссия Биржи / Брокера",
// Freedom24's "Комиссия за сделки") is in the deal already, and a payment that
// merely includes a commission (a utility bill) is a payment.
const SNOWBALL_CASH_FX = /exchang|конверт|обмен валют|döviz|kupoprodaja|currency exchange/i;
const SNOWBALL_CASH_GAIN = /interest|процент|капитализац|cashback|кэшбэк|кешбэк|вознаграждение за операции покупок|\bfaiz\b|kamata/i;
const SNOWBALL_CASH_EXPENSE = /\bfee\b|комисси|commission|provizij|odrzavanje|maintenance|обслуживан|ндфл|налог|\btax\b|ücret|masraf/i;
const SNOWBALL_CASH_DEAL_FEE = /за сделк|по сделк|комиссия биржи|комиссия брокера|includes a commission|включая комисси/i;
// A broker's own money rows (its report or app): only top-ups / withdrawals
// are rows of their own -- deals and payouts are the full export's.
const SNOWBALL_CASH_BROKER_SOURCE = /^(sber_broker_html|tbank_broker_xlsx|ibkr_csv|freedom24_xlsx|revolut_invest_csv|atomyze_xlsx)|-app$/;
const SNOWBALL_CASH_BROKER_MOVE = /пополнен|вывод|withdraw|deposit|top-up|bank transfer|перевод|^зачисление д\/с$/i;
// A bank row moving money into what the export holds (a fund, a metal, a
// savings account or deposit): the export's buy is that row.
const SNOWBALL_CASH_HELD_MOVE = /flexible cash funds|instant access savings|exchanged to (xau|xag|xpt|xpd)|накопительн|вклад|savings account/i;
const SNOWBALL_CASH_RECONCILE = 'reconciling: deals settling on other days, rows not itemised';

// What a row of the full export does to Snowball's cash, by currency.
function snowballCashEffect(cells) {
  const [event, , , priceS, qtyS, currency, feeS, , nkdS, feeCurrency, doNotAdjust] = cells;
  if (doNotAdjust === 'True') return [];
  const n = s => Number(String(s || '0').replace(',', '.')) || 0;
  const price = n(priceS), qty = n(qtyS), fee = n(feeS), nkd = n(nkdS);
  const out = [];
  const money = { BUY: -(price + nkd) * qty, SELL: (price + nkd) * qty, DIVIDEND: qty, AMORTISATION: qty, REPAYMENT: price * qty }[event];
  if (money === undefined) return out;
  out.push([currency, money]);
  if (fee) out.push([feeCurrency || currency, -fee]);
  return out;
}

// The full export as this button gives it -- fewer custom holdings, each
// row's Note saying what it was, so an upload of Snowball's export can split
// them again:
//  - XAUT is XAU (both troy ounces of gold): its rows go to XAU, Note
//    "XAUT: <account>";
//  - every rouble deposit and savings account (DEPOSIT: / SAVINGS: / ВКЛАД:,
//    not an exchange's Earn) is one holding "ВКЛАДЫ", Note "<ticker>:
//    <account>", priced 1 rouble a unit: money put in is a buy, taken out a
//    sale, interest stock as a dividend, and what one held before the first
//    deal a buy that day (Snowball moves the cash for a custom holding's buy
//    whatever DoNotAdjustCash says, so the cash rows bring that money in);
//  - deposits / savings in another currency are cash: their balances by day
//    (foreignSavings) join the bank accounts' in the cash rows.
const SNOWBALL_DEPOSITS = 'ВКЛАДЫ';
async function snowballMergedRows(fullRows, today) {
  const savingsPattern = /^(DEPOSIT|SAVINGS|ВКЛАД):/i;
  const rows = [];
  // XAU's price starts with its own first deal (Revolut, 06.10.2025), XAUT's
  // earlier (23.09): those days get XAUT's dollar price in euros, else
  // Snowball prices the gold at 0 there.
  const xauPriced = new Set(fullRows.filter(([, t, c]) => t === 'XAU' && c[0] === 'CUSTOM_HOLDING_PRICE').map(([d]) => d));
  const eur = (await mpFetchAll(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', 'EUR').order('day')))
    .map(f => [f.day, Number(f.usd_per_unit)]);
  const eurOn = d => { let v = null; for (const [day, k] of eur) { if (day > d) break; v = k; } return v; };
  for (const r of fullRows) {
    const [d, ticker, cells] = r;
    if (savingsPattern.test(ticker)) continue;
    if (ticker === 'XAUT') {
      if (cells[0] === 'CUSTOM_HOLDING_PRICE' && !xauPriced.has(d) && eurOn(d)) {
        const usd = Number(String(cells[3]).replace(',', '.'));
        rows.push([d, 'XAU', ['CUSTOM_HOLDING_PRICE', cells[1], 'XAU', snowballNumber(usd / eurOn(d)), '0', 'EUR', '0', 'CUSTOM_HOLDING', '0', '', '', '']]);
        continue;
      }
      if (cells[0] === 'CUSTOM_HOLDING_PRICE' || cells[0] === 'CUSTOM_HOLDING_SETTINGS') continue;
      const c = [...cells];
      c[2] = 'XAU';
      c[11] = `XAUT: ${cells[11] || ''}`;
      rows.push([d, 'XAU', c]);
      continue;
    }
    rows.push(r);
  }
  const wallets = await mpFetchAll(() => sb.from('crypto_wallets').select('account'));
  const cryptoAccounts = new Set(wallets.map(w => w.account));
  const trades = (await mpFetchAll(() => sb.from('trades')
    .select('ticker, side, quantity, price, trade_date, currency, note, account')
    .or('ticker.like.DEPOSIT:%,ticker.like.SAVINGS:%,ticker.like.ВКЛАД:%').order('trade_date').order('id')))
    .filter(t => !cryptoAccounts.has(t.account) && (t.side === 'buy' || t.side === 'sell'));
  const foreignSavings = new Map();  // currency -> day -> change
  const foreignOpening = new Map();  // currency -> balance the day before the first deal
  const held = new Map();            // rouble ticker -> balance before the first deal
  const n = v => Number(v) || 0;
  for (const t of trades) {
    const cur = (t.currency || 'RUB').toUpperCase();
    const money = n(t.quantity) * (n(t.price) || 1) * (t.side === 'sell' ? -1 : 1);
    if (cur !== 'RUB') {
      if (t.trade_date < MP_SNOWBALL_START) foreignOpening.set(cur, (foreignOpening.get(cur) || 0) + money);
      else if (t.trade_date <= today) {
        if (!foreignSavings.has(cur)) foreignSavings.set(cur, new Map());
        foreignSavings.get(cur).set(t.trade_date, (foreignSavings.get(cur).get(t.trade_date) || 0) + money);
      }
      continue;
    }
    if (t.trade_date < MP_SNOWBALL_START) { held.set(t.ticker, (held.get(t.ticker) || 0) + money); continue; }
    if (t.trade_date > today) continue;
    const interest = t.side === 'buy' && /interest|капитализац|процент/i.test(t.note || '');
    const event = interest ? 'STOCK_AS_DIVIDEND' : t.side === 'buy' ? 'BUY' : 'SELL';
    rows.push([t.trade_date, SNOWBALL_DEPOSITS, [event, `${t.trade_date} 00:00:00`, SNOWBALL_DEPOSITS, '1', snowballNumber(Math.abs(money)),
      'RUB', '0', 'CUSTOM_HOLDING', '0', 'RUB', 'False', `${t.ticker}: ${t.account || ''}`]]);
  }
  for (const [ticker, bal] of held) {
    if (bal < 0.005) continue;
    rows.push([MP_SNOWBALL_START, SNOWBALL_DEPOSITS, ['BUY', `${MP_SNOWBALL_START} 00:00:00`, SNOWBALL_DEPOSITS, '1', snowballNumber(Math.round(bal * 100) / 100),
      'RUB', '0', 'CUSTOM_HOLDING', '0', 'RUB', 'False', `${ticker}: balance before ${MP_SNOWBALL_START}`]]);
  }
  const settings = {
    Holding: { Note: '', Currency: 'RUB', Description: 'Вклады и накопительные счета', DividendTax: null, Sector: 'Cash' },
    Settings: { CustomHoldingType: 2, IncomeType: 1, FirstIncomeDate: null, GenerateIncome: false, IncomeAmount: 0,
      IncomeReinvestmentType: 0, IsIncomeReinvested: false, MaturityDate: null, Period: 1, PeriodType: 3, NextIncomeDate: null },
  };
  const json = JSON.stringify(settings).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .replace(/"/g, '@*@');
  rows.push([today, SNOWBALL_DEPOSITS, ['CUSTOM_HOLDING_SETTINGS', `${today} 00:00:00`, SNOWBALL_DEPOSITS, '0', '0', 'RUB',
    '0', 'CUSTOM_HOLDING', '0', '', '', json]]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { rows, foreignSavings, foreignOpening };
}

document.getElementById('mp_cash_snowball_export').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_cash_snowball_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  try {
    const { rows: fullRows, today } = await snowballFullRows(statusEl);
    statusEl.textContent = 'Loading bank and broker accounts…';
    const { rows, foreignSavings, foreignOpening } = await snowballMergedRows(fullRows, today);
    const bank = await mpFetchAll(() => sb.from('bank_transactions')
      .select('account, currency, external_source, product, balance_after, tx_date, booked_at, amount, description, synthetic_kind')
      .not('balance_after', 'is', null).order('id'));

    // Each account's (account, currency, source -- as bank_latest_balances
    // takes them) balance at the end of every day it moved.
    const series = new Map();
    for (const r of bank) {
      // a credit card too: its debt is what the savings it paid into owe
      if (SNOWBALL_METALS.has(r.currency)) continue;
      const key = `${r.account}|${r.currency}|${r.external_source}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key).push(r);
    }
    const day = d => String(d).slice(0, 10);
    const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
    const balanceChange = new Map();  // currency -> day -> change of all its accounts
    const bump = (m, cur, d, v) => {
      if (!m.has(cur)) m.set(cur, new Map());
      m.get(cur).set(d, (m.get(cur).get(d) || 0) + v);
    };
    const opening = new Map();  // currency -> balance the day before the first deal
    for (const [key, list] of series) {
      const cur = key.split('|')[1];
      list.sort((a, b) => {
        const ka = a.booked_at || a.tx_date, kb = b.booked_at || b.tx_date;
        return ka < kb ? -1 : ka > kb ? 1 : (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : 0);
      });
      const endOfDay = new Map();
      for (const r of list) endOfDay.set(day(r.booked_at || r.tx_date), Number(r.balance_after));
      let prev = 0;
      for (const [d, bal] of [...endOfDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (d < MP_SNOWBALL_START) { prev = bal; continue; }
        if (d > today) break;
        bump(balanceChange, cur, d, bal - prev);
        prev = bal;
      }
      const open = [...endOfDay].filter(([d]) => d < MP_SNOWBALL_START).sort((a, b) => (a[0] < b[0] ? -1 : 1)).pop();
      if (open) opening.set(cur, (opening.get(cur) || 0) + open[1]);
    }

    // Savings / deposits in another currency, and the dollars on the crypto
    // exchanges and wallets (stablecoins -- their history isn't reliable:
    // Telegram Wallet doesn't say how many it spent, so only today's balance,
    // as money that arrived today).
    for (const [cur, byDay] of foreignSavings) for (const [d, v] of byDay) bump(balanceChange, cur, d, v);
    for (const [cur, v] of foreignOpening) opening.set(cur, (opening.get(cur) || 0) + v);
    const coins = await mpFetchAll(() => sb.from('wallet_balances').select('ticker, symbol, quantity'));
    const stable = coins.filter(c => SNOWBALL_STABLECOINS.has(String(c.ticker || c.symbol || '').toUpperCase()))
      .reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    if (stable >= 0.005) bump(balanceChange, 'USD', today, stable);

    // What the full export's rows do to the cash, by currency and day.
    const exportEffect = new Map();
    for (const [d, , cells] of rows) for (const [cur, v] of snowballCashEffect(cells)) bump(exportEffect, cur, d, v);

    const out = [];
    const push = (event, d, cur, amount, note) => out.push([d, cur, [event, `${d} 00:00:00`, cur, '1', snowballNumber(Math.round(amount * 100) / 100),
      cur, '0', '', '', '', 'False', note]]);
    const r2 = v => snowballNumber(Math.round(v * 100) / 100);

    // Conversions, interest and fees: rows of their own, their money taken
    // off what's left to write as money in / out (typedEffect).
    const typedEffect = new Map();
    const pool = [...series.values()].flat().filter(r => !r.synthetic_kind && Number(r.amount));
    const at = r => Date.parse(r.booked_at || r.tx_date);
    // Where a row comes from, in its Note -- bank, product and source (the
    // source names the account) -- so the rows can be told apart again.
    const tag = r => `${r.account} · ${r.product || ''} · ${r.external_source}`;
    const used = new Set();
    const byBank = new Map();
    for (const r of pool) {
      if (!byBank.has(r.account)) byBank.set(r.account, []);
      byBank.get(r.account).push(r);
    }
    let converts = 0, gains = 0, expenses = 0;
    for (const list of byBank.values()) {
      list.sort((a, b) => at(a) - at(b));
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (used.has(a) || !(Number(a.amount) < 0)) continue;
        const near = list.filter(b => !used.has(b) && b !== a && b.currency !== a.currency && Number(b.amount) > 0
          && Math.abs(at(b) - at(a)) <= 5 * 60000);
        // (Ziraat's two legs differ in spaces only: "Satış ; ... USD 21,02" / "Satış; ... USD21,02")
        const plain = r => (r.description || '').replace(/\s+/g, '');
        const same = near.filter(b => plain(b) === plain(a) && SNOWBALL_CASH_FX.test(a.description || ''));
        const both = near.filter(b => SNOWBALL_CASH_FX.test(a.description || '') && SNOWBALL_CASH_FX.test(b.description || ''));
        const pick = same.length ? same : both;
        if (!pick.length) continue;
        const b = pick.sort((x, y) => Math.abs(at(x) - at(a)) - Math.abs(at(y) - at(a)))[0];
        used.add(a); used.add(b);
        const d = day(a.booked_at || a.tx_date);
        if (d < MP_SNOWBALL_START || d > today) continue;
        const paid = -Number(a.amount), got = Number(b.amount);
        // Snowball's own: Symbol = the currency got, Price = the amount paid,
        // Quantity = the amount got, Currency = the currency paid.
        out.push([d, b.currency, ['CASH_CONVERT', `${d} 00:00:00`, b.currency, r2(paid), r2(got), a.currency, '0', '', '', '', 'False',
          `${tag(a)} -> ${tag(b)}: ${a.description || ''}`.slice(0, 300)]]);
        bump(typedEffect, a.currency, d, -paid);
        bump(typedEffect, b.currency, day(b.booked_at || b.tx_date), got);
        converts++;
      }
    }
    for (const r of pool) {
      if (used.has(r)) continue;
      const d = day(r.booked_at || r.tx_date);
      if (d < MP_SNOWBALL_START || d > today) continue;
      const amount = Number(r.amount), text = r.description || '';
      let event = null;
      if (amount > 0 && SNOWBALL_CASH_GAIN.test(text)) event = 'CASH_GAIN';
      else if (amount < 0 && SNOWBALL_CASH_EXPENSE.test(text) && !SNOWBALL_CASH_DEAL_FEE.test(text)) event = 'CASH_EXPENSE';
      if (!event) continue;
      push(event, d, r.currency, Math.abs(amount), `${tag(r)}: ${text}`.slice(0, 300));
      bump(typedEffect, r.currency, d, amount);
      used.add(r);
      if (event === 'CASH_GAIN') gains++; else expenses++;
    }
    // Every other money row on its own, but those the full export already
    // books: a broker's deals, payouts and fees (only its top-ups and
    // withdrawals are rows here), and money moved into a fund, a metal or a
    // savings account / deposit the export holds. What's left over -- a deal
    // settling days after Snowball books it, a row worded otherwise -- the
    // reconciling rows below take, summed over a few days.
    // The money of a buy / sale of what the export holds outside a broker
    // (ВКЛАДЫ, a Revolut fund, gold, coins bought by card) is a bank row of
    // the same amount within a few days -- worded any way ("SBERBANK ONL@IN
    // CARD-VKLAD", "Internal transfer to contract ...", "External bank
    // transfer AO Yandex Bank"): that row is the deal's, not one of its own.
    const held = [];
    for (const [d, , c] of rows) {
      if ((c[0] !== 'BUY' && c[0] !== 'SELL') || !['CUSTOM_HOLDING', 'EUFUND'].includes(c[7])) continue;
      const money = Number(String(c[3]).replace(',', '.')) * Number(String(c[4]).replace(',', '.'));
      held.push({ d, cur: c[5], money: c[0] === 'BUY' ? -money : money, taken: false });
    }
    const daysApart = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
    const heldDeal = (r, d) => {
      const amount = Number(r.amount);
      const h = held.filter(x => !x.taken && x.cur === r.currency && daysApart(x.d, d) <= 5
        && Math.abs(x.money - amount) <= Math.max(0.01, Math.abs(amount) * 0.002))
        .sort((x, y) => daysApart(x.d, d) - daysApart(y.d, d))[0];
      if (h) h.taken = true;
      return !!h;
    };
    let itemised = 0;
    for (const r of pool) {
      if (used.has(r)) continue;
      const d = day(r.booked_at || r.tx_date);
      if (d < MP_SNOWBALL_START || d > today) continue;
      const text = r.description || '';
      if (SNOWBALL_CASH_BROKER_SOURCE.test(r.external_source || '') || r.product === 'brokerage_cash'
        ? !SNOWBALL_CASH_BROKER_MOVE.test(text) : heldDeal(r, d) || SNOWBALL_CASH_HELD_MOVE.test(text)) continue;
      const amount = Number(r.amount);
      push(amount > 0 ? 'CASH_IN' : 'CASH_OUT', d, r.currency, Math.abs(amount), `${tag(r)}: ${text}`.slice(0, 300));
      bump(typedEffect, r.currency, d, amount);
      itemised++;
    }
    const finals = [];
    const currencies = new Set([...balanceChange.keys(), ...exportEffect.keys(), ...opening.keys(), ...typedEffect.keys()]);
    for (const cur of [...currencies].sort()) {
      const open = opening.get(cur) || 0;
      if (Math.abs(open) >= 0.005) push(open > 0 ? 'CASH_IN' : 'CASH_OUT', MP_SNOWBALL_START, cur, Math.abs(open),
        `balance on ${addDays(MP_SNOWBALL_START, -1)}`);
      const changes = balanceChange.get(cur) || new Map();
      const effects = exportEffect.get(cur) || new Map();
      const typed = typedEffect.get(cur) || new Map();
      const days = [...new Set([...changes.keys(), ...effects.keys(), ...typed.keys()])].sort();
      let pending = 0, since = null;
      const flush = () => {
        if (since && Math.abs(pending) >= 0.005) push(pending > 0 ? 'CASH_IN' : 'CASH_OUT', since, cur, Math.abs(pending), SNOWBALL_CASH_RECONCILE);
        pending = 0; since = null;
      };
      for (const d of days) {
        if (since && d > addDays(since, SNOWBALL_CASH_WINDOW_DAYS)) flush();
        const rest = (changes.get(d) || 0) - (effects.get(d) || 0) - (typed.get(d) || 0);
        if (Math.abs(rest) < 0.005) continue;
        if (!since) since = d;
        pending += rest;
        if (Math.abs(pending) < 0.005) { pending = 0; since = null; }
      }
      flush();
      const end = open + [...changes.values()].reduce((s, v) => s + v, 0);
      if (Math.abs(end) >= 0.005) finals.push(`${cur} ${end.toFixed(2)}`);
    }
    const all = [...rows, ...out].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    snowballDownload(all, `snowball_full_export_with_cash_${today}.csv`);
    statusEl.textContent = `Downloaded ${all.length} rows: the full export (${rows.length}) and ${out.length} cash rows from ${series.size} accounts `
      + `(${converts} conversions, ${gains} interest / cashback, ${expenses} fees / taxes, ${itemised} money in / out, the rest reconciling). `
      + `Snowball's balances should then be: ${finals.join(', ')}.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

