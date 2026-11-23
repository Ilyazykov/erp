// The price chart window of an asset (mpOpenPriceDialog), opened by a click on
// a ticker or a chart's sector anywhere on the page.

// An asset's price through time (price_history, in dollars; in the paper's own
// currency at each day's rate), a year by default, with the deals in it marked.
// Asian exchanges name their shares by numbers (Taiwan's 2330 is TSMC, Tokyo's 8306 MUFG, Seoul's
// 005930 Samsung, Hong Kong's 700 Tencent): the name people know them by instead. The rest of the
// numbered ones: their company's name without the "Co Ltd" (mpShortName).
const MP_SHORT_NAMES = {
  // Taiwan
  2330: 'TSMC', 2454: 'MediaTek', 2308: 'Delta Electronics', 2317: 'Foxconn', 3711: 'ASE Technology', 2303: 'UMC',
  2383: 'Elite Material', 1303: 'Nan Ya Plastics', 3037: 'Unimicron', 2891: 'CTBC Financial', 2882: 'Cathay Financial',
  2881: 'Fubon Financial', 2412: 'Chunghwa Telecom', 2382: 'Quanta Computer', 3231: 'Wistron', 2345: 'Accton', 3017: 'Asia Vital',
  2327: 'Yageo', 2357: 'Asus', 3008: 'Largan', 6669: 'Wiwynn', 2301: 'Lite-On', 2886: 'Mega Financial', 2884: 'E.Sun Financial',
  2885: 'Yuanta Financial', 2887: 'Taishin Financial', 2892: 'First Financial', 2880: 'Hua Nan Financial', 2002: 'China Steel',
  // Japan
  8306: 'MUFG', 7203: 'Toyota', 8035: 'Tokyo Electron', 8316: 'SMFG', 6098: 'Recruit', 6857: 'Advantest', 6758: 'Sony',
  6501: 'Hitachi', 8411: 'Mizuho', 9984: 'SoftBank Group', 8058: 'Mitsubishi Corp', 6861: 'Keyence', 8766: 'Tokio Marine',
  8001: 'Itochu', 7011: 'Mitsubishi Heavy', 9983: 'Fast Retailing', 8031: 'Mitsui & Co', 6981: 'Murata', 6503: 'Mitsubishi Electric',
  4063: 'Shin-Etsu', 6752: 'Panasonic', 7974: 'Nintendo', 4502: 'Takeda', 5803: 'Fujikura', 7741: 'Hoya', 9433: 'KDDI',
  2914: 'Japan Tobacco', 8591: 'ORIX', 8002: 'Marubeni', 9434: 'SoftBank Corp', 6367: 'Daikin', 7267: 'Honda', 8053: 'Sumitomo Corp',
  6701: 'NEC', 6301: 'Komatsu', 6702: 'Fujitsu', 6954: 'Fanuc', 4568: 'Daiichi Sankyo', 9432: 'NTT', 4519: 'Chugai', 4503: 'Astellas',
  3382: 'Seven & i', 8802: 'Mitsubishi Estate', 4901: 'Fujifilm', 7269: 'Suzuki', 8801: 'Mitsui Fudosan', 9020: 'JR East', 7751: 'Canon',
  6273: 'SMC', 6902: 'Denso', 4661: 'Oriental Land', '285A': 'Kioxia', 8725: 'MS&AD', 8630: 'Sompo', 6762: 'TDK', 6723: 'Renesas',
  6971: 'Kyocera', 5108: 'Bridgestone', 8015: 'Toyota Tsusho', 7182: 'Japan Post Bank', 8308: 'Resona', 8309: 'Sumitomo Mitsui Trust',
  // Korea
  '005930': 'Samsung Electronics', '000660': 'SK Hynix', '005935': 'Samsung Electronics (pref)', 402340: 'SK Square',
  '005380': 'Hyundai Motor', 105560: 'KB Financial', '055550': 'Shinhan Financial', '012450': 'Hanwha Aerospace', '000270': 'Kia',
  '035420': 'Naver', '068270': 'Celltrion', '006400': 'Samsung SDI', '005490': 'POSCO', '066570': 'LG Electronics',
  '028260': 'Samsung C&T', '009150': 'Samsung Electro-Mechanics', '034020': 'Doosan Enerbility', '086790': 'Hana Financial',
  '012330': 'Hyundai Mobis', '032830': 'Samsung Life',
  // Hong Kong, China
  700: 'Tencent', 9988: 'Alibaba', 939: 'China Construction Bank', 1398: 'ICBC', 1810: 'Xiaomi', 3690: 'Meituan', 3988: 'Bank of China',
  2318: 'Ping An', 9999: 'NetEase', 1211: 'BYD', 992: 'Lenovo', 9618: 'JD.com', 9961: 'Trip.com', 2899: 'Zijin Mining',
  2628: 'China Life', 9888: 'Baidu', 857: 'PetroChina', 1288: 'Agricultural Bank of China', 3968: 'China Merchants Bank',
  1299: 'AIA', 388: 'HKEX', 1: 'CK Hutchison', 16: 'Sun Hung Kai', 883: 'CNOOC', 941: 'China Mobile', 2269: 'WuXi Biologics',
  386: 'Sinopec', 1088: 'China Shenhua', 2388: 'BOC Hong Kong', 669: 'Techtronic', 2: 'CLP', 823: 'Link REIT', 1113: 'CK Asset',
};
// A ticker as people know it: the short name of a numbered share (its company's name, trimmed, when
// not in MP_SHORT_NAMES); any other ticker as it is
// a code that tells nothing: a number (2330) or an ISIN (FR0014013RC7)
const mpCodeLike = t => /^\d+[A-Z]?$/.test(String(t)) || /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(t));
function mpShortName(ticker, name) {
  const t = String(ticker ?? '');
  if (MP_SHORT_NAMES[t]) return MP_SHORT_NAMES[t];
  if (!mpCodeLike(t) || !name) return t;
  // France's registered loyalty shares ("L'OREAL SA - PF - 2028", "SODEXO EUR4 (PRIM FIDELITE)(REGD)"):
  // just the company (they merge with its ordinary shares like Alphabet's classes); capitals in ordinary case
  let n = String(name);
  n = n.replace(/\s-\sPF\s-\s\d{4}\s*$/, '').replace(/\s+EUR[\d.]+.*$/i, '').replace(/\s*\(.*$/, '');
  if (n === n.toUpperCase()) n = n.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, c => c.toUpperCase());
  n = n.replace(/\s+(SA|SE|NV|AG|PLC)$/i, '');
  const trimmed = String(n).replace(/[,.]/g, ' ').replace(/\b(Co|Ltd|Inc|Corp|Corporation|Holdings?|Group|PLC|Limited|Company|Kabushiki Kaisha|KK)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  return trimmed.length > 26 ? trimmed.slice(0, 26).replace(/\s\S*$/, '') : trimmed || t;
}
const MP_PRICE_PERIODS = [['1m', 1], ['3m', 3], ['6m', 6], ['YTD', 'ytd'], ['1y', 12], ['2y', 24], ['3y', 36], ['4y', 48], ['5y', 60], ['all', null]];
// opts.also: other tickers of the same thing whose deals are marked too (the
// portfolio map's merged gold: XAU's price, the deals of XAU and XAUT)
// a chart's sector or bar whose point carries a ticker (customdata): its price chart
// A chart's deal marks: one a day per account, paper and currency. An order filled in parts is several
// trades on one spot, and the hover showed only the top one. Marks only: the average counts each trade.
function mpMergeDayDeals(deals) {
  const byKey = new Map();
  for (const d of deals) {
    const key = [d.trade_date, d.side, d.account, d.ticker, d.currency].join('|');
    const m = byKey.get(key);
    const q = Number(d.quantity), p = Number(d.price);
    if (!m) { byKey.set(key, { ...d, quantity: q, n: 1, cost: p > 0 ? q * p : null }); continue; }
    m.quantity += q;
    m.n += 1;
    m.cost = m.cost != null && p > 0 ? m.cost + q * p : null;
    if (m.money != null) m.money += Number(d.money) || 0;
  }
  return [...byKey.values()].map(({ cost, ...m }) => ({ ...m, price: cost != null && m.quantity > 0 ? cost / m.quantity : null }));
}

function mpChartOnClick(id) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el?.on) return;
  el.removeAllListeners?.('plotly_click');   // newPlot again (a re-render): one handler, not two
  el.on('plotly_click', ev => {
    const t = ev.points?.find(p => typeof p.customdata === 'string' && p.customdata)?.customdata;
    if (t) mpOpenPriceDialog(t, t);
  });
}
// a ticker in any table marked data-chart (the target weights, the money to allocate): its price chart
document.addEventListener('click', ev => {
  const td = ev.target.closest?.('[data-chart]');
  if (td && td.dataset.chart) mpOpenPriceDialog(td.dataset.chart, td.dataset.chartTitle || td.dataset.chart);
});
// When a bank's own exchange is fair, by the times of the user's exchanges (23.11.2026): shown under a
// currency's chart. Ziraat: its receipts' times -- 10:52 and 16:34 on weekdays ~1% off the market,
// 19:29, 21:42, 02:58 and a Sunday's 17:16 ~3%. T-Bank: its 67 exchanges -- ~1% on a weekday 10:00-18:59
// (Moscow), ~5.5-7.5% from 19:00 to midnight, ~2.5-3.5% at night, ~6% on a weekend. TBC: its 4 exchanges
// (weekdays, no times) -- dollars ~0.4%, euros ~0.9-1.15%; over 2 500 GEL its app offers to ask for a better
// rate (Entrepreneur Georgia); nothing found on its weekends.
const MP_FX_RULES = {
  TRY: 'Ziraat: weekdays 11:00–17:30 Tbilisi ~1%, evenings and weekends ~3%.',
  GEL: 'TBC: dollars ~0.4%, euros ~1%; over 2 500 GEL ask for a better rate.',
  RUB: 'T-Bank: weekdays 10:00–19:00 Moscow ~1%, evenings and weekends ~6%.',
};
// Gold funds, their deals marked on gold's chart as buys through a fund (the weight: their share of gold)
// -- T-Capital's TGLD, bought on T-Bank's brokerage account (May-June 2026); securities / fund_holdings
// don't list it, so it's named here
const MP_GOLD_FUNDS = [{ fund: 'TGLD', weight: 1 }];
// An index fund's chart marks the buys of a broader fund too (23.11.2026): part of FTSE All-World is the S&P 500
// (60.3% by weight) and STOXX Europe 600 (14.2%). The weight: what the broad fund holds of this fund's papers.
const MP_INDEX_FUNDS = new Set(['CSPX', 'VUAA', 'SXR8', 'VOO', 'SPY', 'IVV', 'TSPX', 'XSX6']);
const MP_BROAD_FUNDS = ['VWRA', 'VWCE'];   // one fund, two listings: one list of holdings
// The window a chart opens in (a paper's, a currency's, a bank's): title, period buttons, the controls given,
// a headline, the plot, a note. Ids are `${prefix}_head`, `_chart`, `_note`. Opened before anything is drawn
// (Plotly measures a closed dialog as empty); removed however it's closed.
function mpChartDialog(prefix, titleHtml, controlsHtml = '') {
  const dlg = document.createElement('dialog');
  dlg.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:16px 18px;min-width:320px;width:min(94vw,1400px)';
  dlg.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><b>${titleHtml}</b><button type="button" data-act="close">✕</button></div>
    <div class="form-row" style="gap:6px;align-items:center">${MP_PRICE_PERIODS.map(([l]) => `<button class="btn${l === '1y' ? ' primary' : ''}" type="button" data-p="${l}">${l}</button>`).join('')}
      ${controlsHtml}</div>
    <div id="${prefix}_head" style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"></div>
    <div id="${prefix}_chart" style="height:min(60vh,600px)"></div>
    <p class="note" style="margin:0" id="${prefix}_note">Loading…</p>
  </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  dlg.querySelector('[data-act=close]').onclick = () => dlg.close();
  return { dlg, head: dlg.querySelector(`#${prefix}_head`), plot: dlg.querySelector(`#${prefix}_chart`), note: dlg.querySelector(`#${prefix}_note`) };
}
// The period buttons of such a window: the one pressed lit, onPick(its label).
function mpBindPeriods(dlg, onPick) {
  dlg.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    dlg.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('primary', x === b));
    onPick(b.dataset.p);
  });
}
// The first day of a period counted back from `last`; "all": `first`.
function mpPeriodStart(period, first, last) {
  const spec = MP_PRICE_PERIODS.find(([l]) => l === period)?.[1];
  if (spec == null) return first;
  if (spec === 'ytd') return `${last.slice(0, 4) - 1}-12-31`;
  const d = new Date(`${last}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - spec); return d.toISOString().slice(0, 10);
}

async function mpOpenPriceDialog(asset, title, opts = {}) {
  if (asset === 'XAU' && !opts.via?.length) opts = { ...opts, via: MP_GOLD_FUNDS };
  const dealTickers = [asset, ...(opts.also || [])];
  const numbered = mpCodeLike(asset);   // a number or an ISIN: its name instead
  if (numbered && MP_SHORT_NAMES[asset]) title = MP_SHORT_NAMES[asset];
  const { dlg, note } = mpChartDialog('mp_price',
    `<span id="mp_price_title">${mpEscapeHtml(title)}</span> <span id="mp_price_meta" style="color:#8b949e;font-weight:normal">${title !== asset && !numbered && !opts.currency ? `· ${mpEscapeHtml(dealTickers.join(' + '))}` : ''}</span>`,
    `<label style="margin-left:12px" id="mp_price_ccy_box"><input type="checkbox" id="mp_price_usd"> in USD</label>
      <label style="margin-left:12px;display:none" id="mp_price_via_box"><input type="checkbox" id="mp_price_via" checked> buys through funds</label>
      <label style="margin-left:12px;display:none" id="mp_price_pay_box"><input type="checkbox" id="mp_price_pay" checked> payouts</label>
      <label style="margin-left:12px;display:none" id="mp_price_inv_box"><input type="checkbox" id="mp_price_inv"> <span></span></label>
      <label style="margin-left:12px;display:none" id="mp_price_rate_box"><input type="checkbox" id="mp_price_rate" checked> <span></span></label>
      <label style="margin-left:12px;display:none" id="mp_price_avg_box"><input type="checkbox" id="mp_price_avg_all"> avg over all time</label>`);
  // the company, its country (a flag) and sector from the funds' lists (securities), instead of the
  // ticker again: "NVDA · NVIDIA Corp 🇺🇸 · Information Technology"
  let ccyReady = () => {};
  const ccyKnown = new Promise(r => { ccyReady = r; });
  // a coin is no company: SOL (Solana) isn't the ASX's SOL (Washington H. Soul Pattinson) the funds' lists
  // hold, nor bought through those funds -- what market_prices says the ticker is decides
  const cryptoKnown = sb.from('market_prices').select('asset_class').eq('ticker', asset).maybeSingle()
    .then(({ data }) => data?.asset_class === 'crypto', () => false);
  sb.from('securities').select('name, country, country_code, sector, currency').or(`market_ticker.eq.${asset},ticker.eq.${asset}`)
    .then(async ({ data }) => {
      if (await cryptoKnown) return;
      // one ticker, two companies (T: AT&T in the funds' lists, T-Technologies on MOEX): the one in the
      // currency of one's deals; none of them -- the broker's name from the deals
      const c = await ccyKnown;
      const s = (data || []).find(x => !c || !x.currency || String(x.currency).toUpperCase() === c);
      if (!s) {
        // no fund's list has it: a name of ours, or the broker's from its latest deal ("Zynex-ао (сделка …)")
        let name = MP_FUND_NAMES_RU[asset] || MP_ASSET_NAMES[asset];
        if (!name) {
          const { data: t } = await sb.from('trades').select('note').eq('ticker', asset).in('side', ['buy', 'sell']).or('note.ilike.*(сделка*,note.ilike.*(market order*').order('trade_date', { ascending: false }).limit(1);
          name = String(t?.[0]?.note || '').replace(/\s*\((сделка|market order)[^)]*\)\s*$/, '').replace(/^паи\s+[БЗ]ПИФ\s+рфи\s+/i, '').replace(/(-|\s+)ао$/, '').trim();
        }
        if (name && name.toLowerCase() !== String(title).toLowerCase())
          dlg.querySelector('#mp_price_meta').textContent = `${title !== asset && !numbered ? `· ${asset} ` : ''}· ${name}`;
        return;
      }
      const cc = String(s.country_code || '').toUpperCase();
      const flag = /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
      const parts = [s.name && s.name.toLowerCase() !== String(title).toLowerCase() && s.name !== mpShortName(asset, s.name) ? s.name : '', flag || s.country || '', s.sector || '']   // the flag alone; the country's name only without one
        .filter(Boolean).map(mpEscapeHtml);
      // a numbered share: its short name in bold, the full one after it, no number
      if (numbered) dlg.querySelector('#mp_price_title').textContent = mpShortName(asset, s.name);
      if (parts.length) dlg.querySelector('#mp_price_meta').innerHTML = `${title !== asset && !numbered ? `· ${mpEscapeHtml(asset)} ` : ''}· ${parts.join(' · ')}`;
    }, () => { /* the header stays as it is */ });
  let prices, deals, ccy, fx, payouts = [];
  try {
    let wallet;
    [prices, deals, wallet] = await Promise.all([
      mpFetchAll(() => sb.from('price_history').select('ticker, day, price_usd').in('ticker', dealTickers).order('day')),
      mpFetchAll(() => sb.from('trades').select('ticker, trade_date, side, quantity, price, currency, fee_tax, fee_currency, account, external_source').in('ticker', dealTickers).in('side', ['buy', 'sell']).order('trade_date')),
      // a coin's deals are its exchanges' and wallets' own rows: a buy (by card or for
      // another coin) and a sale; transfers, fees, interest and Earn moves aren't deals
      mpFetchAll(() => sb.from('wallet_transactions').select('symbol, tx_time, kind, amount, chain').or(dealTickers.map(t => `symbol.ilike.${t}`).join(','))
        .in('kind', ['trade', 'purchase', 'trade_out']).order('tx_time')),
    ]);
    // the paper's currency: the one most of its deals are in (SBBY's first buys were in yuan, the rest in roubles)
    { const n = new Map(); for (const d of deals) if (d.currency) { const c = String(d.currency).toUpperCase(); n.set(c, (n.get(c) || 0) + 1); }
      ccy = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
      ccyReady(n.size ? ccy : null); }
    if (wallet.length) {
      // ...and Snowball's old rows of the coin go (its "sell" of 23.09.2025 was the network fee of a move from Trust to Bybit)
      const CHAIN = { cryptocom: 'Crypto.com', bybit: 'Bybit', binance: 'Binance', telegram: 'Telegram Wallet' };
      deals = [...deals.filter(d => d.external_source !== 'snowball_csv'),
        ...wallet.filter(w => Number(w.amount) !== 0).map(w => ({ trade_date: String(w.tx_time).slice(0, 10), side: Number(w.amount) > 0 ? 'buy' : 'sell',
          quantity: Math.abs(Number(w.amount)), account: CHAIN[w.chain] || w.chain, ticker: String(w.symbol).toUpperCase(), time: w.tx_time, chain: w.chain }))]
        .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    }
    // an exchange's deal at its real price: the other side of the swap (the same place, the same moment --
    // Bybit's 424.68 USDT for 0.00441558 BTC, Binance's RUB, Crypto.com's EUR); a Crypto.com buy with no other
    // side was paid by card: the bank's CRYPTO.COM payment of that day whose price is the closest to the market's
    try {
      const coinDeals = deals.filter(d => d.chain && d.time && d.price == null);
      if (coinDeals.length) {
        const times = [...new Set(coinDeals.map(d => d.time))];
        const legs = [];
        for (let i = 0; i < times.length; i += 100) legs.push(...await mpFetchAll(() => sb.from('wallet_transactions').select('chain, tx_time, symbol, kind, amount')
          .in('tx_time', times.slice(i, i + 100)).in('kind', ['trade', 'trade_out'])));
        const cdcCard = coinDeals.some(d => d.chain === 'cryptocom')
          ? await mpFetchAll(() => sb.from('bank_transactions').select('booked_at, amount, currency, description').ilike('description', '%crypto.com%').lt('amount', 0)) : [];
        const curs = [...new Set([...legs.map(l => String(l.symbol).toUpperCase()), ...cdcCard.map(b => String(b.currency).toUpperCase())])].filter(c => /^[A-Z]{3}$/.test(c) && c !== 'USD');
        const fxl = curs.length ? await mpFetchAll(() => sb.from('fx_history').select('currency, day, usd_per_unit').in('currency', curs).order('day')) : [];
        const STABLE = new Set(['USDT', 'USDC', 'DAI', 'USD', 'FDUSD', 'BUSD']);
        const usdOf = (c, day) => { c = String(c).toUpperCase(); if (STABLE.has(c)) return 1; let v = null; for (const r of fxl) if (r.currency === c && r.day <= day) v = Number(r.usd_per_unit); return v; };
        const closeOn = day => { let v = null; for (const p of prices) { if (p.day > day) break; v = Number(p.price_usd); } return v; };
        const used = new Set();
        for (const d of coinDeals) {
          const q = Number(d.quantity);
          const leg = legs.find(l => l.chain === d.chain && l.tx_time === d.time && String(l.symbol).toUpperCase() !== d.ticker
            && Number(l.amount) !== 0 && Math.sign(Number(l.amount)) === (d.side === 'buy' ? -1 : 1) && usdOf(l.symbol, d.trade_date));
          if (leg) { d.price = Math.abs(Number(leg.amount)) * usdOf(leg.symbol, d.trade_date) / q; d.currency = 'USD'; d.account += ` (${Math.abs(Number(leg.amount))} ${leg.symbol})`; continue; }
          if (d.chain !== 'cryptocom' || d.side !== 'buy') continue;
          const mkt = closeOn(d.trade_date);
          let best = null;
          for (const b of cdcCard) {
            if (used.has(b)) continue;
            const day = (String(b.description).match(/\d{4}-\d{2}-\d{2}/) || [String(b.booked_at || '').slice(0, 10)])[0];
            const k = usdOf(b.currency, day);
            if (!day || !k || Math.abs(new Date(day) - new Date(d.trade_date)) > 1.5 * 864e5) continue;
            const px = Math.abs(Number(b.amount)) * k / q, off = mkt ? Math.abs(px / mkt - 1) : 1;
            if (off <= 0.15 && (!best || off < best.off)) best = { b, px, off };   // the day's close, not the minute's: up to 15% off on a day like 05.02.2026
          }
          if (best) { used.add(best.b); d.price = best.px; d.currency = 'USD'; d.account += ` (${Math.abs(Number(best.b.amount))} ${best.b.currency} by card)`; }
        }
      }
    } catch (err) { console.warn('swap prices:', err); }
    // a coin sold on one exchange and bought back on another within hours (Telegram's BTC to USDT, the USDT
    // sent to Bybit, BTC bought there again, 15.11.2025): a move between one's own places, no sale or buy --
    // the same coin, another place, the buy 90-102% of the sale (the fees and the spread on the way), in 6 hours
    {
      const t = d => new Date(d.time || `${d.trade_date}T12:00:00Z`).getTime();
      const gone = new Set();
      for (const sell of deals.filter(d => d.side === 'sell' && d.time)) {
        const buy = deals.find(d => d.side === 'buy' && d.time && !gone.has(d) && d.ticker === sell.ticker && d.account !== sell.account
          && t(d) >= t(sell) && t(d) - t(sell) <= 6 * 3600e3 && Number(d.quantity) >= Number(sell.quantity) * 0.9 && Number(d.quantity) <= Number(sell.quantity) * 1.02);
        if (buy) { gone.add(sell); gone.add(buy); }
      }
      if (gone.size) deals = deals.filter(d => !gone.has(d));
    }
    // a coin bought by card (card_crypto_purchases: the bank's payment linked to the coin received -- Mercuryo
    // sending ETH to one's own wallet, a Telegram Wallet top-up): a buy at what was paid, in dollars that day;
    // a Telegram Wallet "purchase" already among the deals gets its price from it
    try {
      const card = await mpFetchAll(() => sb.from('card_crypto_purchases').select('coin, coins, paid, currency, paid_on, received_at, kind').in('coin', dealTickers).order('received_at'));
      if (card.length) {
        const cur = [...new Set(card.map(c => String(c.currency).toUpperCase()).filter(c => c !== 'USD'))];
        const fxc = cur.length ? await mpFetchAll(() => sb.from('fx_history').select('currency, day, usd_per_unit').in('currency', cur).order('day')) : [];
        const usdOn = (c, day) => { if (c === 'USD') return 1; let v = null; for (const r of fxc) if (r.currency === c && r.day <= day) v = Number(r.usd_per_unit); return v; };
        for (const c of card) {
          const day = String(c.received_at || c.paid_on).slice(0, 10), q = Number(c.coins), k = usdOn(String(c.currency).toUpperCase(), c.paid_on);
          if (!(q > 0) || !k) continue;
          const px = Number(c.paid) * k / q, coin = String(c.coin).toUpperCase();
          const same = c.kind === 'purchase' ? deals.find(d => d.side === 'buy' && d.price == null && d.ticker === coin && d.trade_date === day && Math.abs(Number(d.quantity) - q) <= q * 0.01) : null;
          if (same) { same.price = px; same.currency = 'USD'; same.account += ` (${c.paid} ${c.currency} by card)`; }
          else if (c.kind !== 'purchase') deals.push({ trade_date: day, side: 'buy', quantity: q, price: px, currency: 'USD', ticker: coin, account: `${c.paid} ${c.currency} by card, to the wallet` });
        }
        deals.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      }
    } catch (err) { console.warn('card purchases:', err); }
    // a movement without a deal (a broker report's transfer between its agreements, a code
    // change: price 0, e.g. T-Bank's SBER 120 out of one agreement and into another,
    // dated the report's day) is no buy or sale
    deals = deals.filter(d => d.price == null || Number(d.price) !== 0);
    for (const d of deals) d.account = d.account || d.external_source || '—';
    // what it paid out: coupons and dividends (trades 'dividend': quantity = the amount), a deposit's or
    // savings account's interest (its 'buy' noted as interest), an exchange's Earn on a coin
    const [payTrades, payWallet] = await Promise.all([
      mpFetchAll(() => sb.from('trades').select('ticker, trade_date, side, quantity, currency, account, note').in('ticker', dealTickers)
        .or('side.eq.dividend,and(side.eq.buy,note.ilike.*interest*),and(side.eq.buy,note.ilike.*процент*),and(side.eq.buy,note.ilike.*капитализац*)').order('trade_date')),
      mpFetchAll(() => sb.from('wallet_transactions').select('symbol, tx_time, amount, chain').or(dealTickers.map(t => `symbol.ilike.${t}`).join(','))
        .in('kind', ['interest', 'reward']).order('tx_time')),
    ]);
    payouts = [
      ...payTrades.map(t => ({ day: t.trade_date, amount: Number(t.quantity), ccy: (t.currency || '').toUpperCase(), account: t.account || '—',
        what: t.side === 'dividend' ? (/купон|coupon/i.test(t.note || '') ? 'coupon' : 'dividend') : 'interest' })),
      ...payWallet.map(w => ({ day: String(w.tx_time).slice(0, 10), amount: Number(w.amount), ccy: String(w.symbol).toUpperCase(), account: w.chain, what: 'interest' })),
    ].filter(p => Number.isFinite(p.amount) && p.amount !== 0).sort((a, b) => a.day.localeCompare(b.day));
    fx = ccy === 'USD' ? [] : await mpFetchAll(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', ccy).order('day'));
  } catch (err) { ccyReady(null); note.textContent = String(err.message || err); return; }
  // One thing under several tickers (merged funds: VWRA and VWCE are one fund, one ISIN, in dollars and
  // in euros): the main ticker's history, and before its first day the longest other one's, scaled to
  // meet it there (VWRA's history starts 23.03.2026, VWCE's months before)
  {
    const own = prices.filter(p => p.ticker === asset);
    if (own.length && dealTickers.length > 1) {
      const first = own[0].day;
      const other = dealTickers.slice(1).map(t => prices.filter(p => p.ticker === t)).filter(r => r.length && r[0].day < first)
        .sort((a, b) => a[0].day.localeCompare(b[0].day))[0];
      const meet = other ? [...other].reverse().find(p => p.day <= first) : null;
      if (meet && Number(meet.price_usd) > 0) {
        const k = Number(own[0].price_usd) / Number(meet.price_usd);
        prices = [...other.filter(p => p.day < first).map(p => ({ day: p.day, price_usd: Number(p.price_usd) * k })), ...own];
      } else prices = own;
    } else prices = own.length ? own : prices;
  }
  // Revolut's money-market funds: a unit is always about one of their currency, so what moves their
  // value in dollars is that currency -- its rate to the dollar instead (GBP/USD, EUR/USD), the
  // money in and out marked on it; the dollar fund's is always 1
  // The same for a deposit or a savings account (a unit is one rouble, euro...): its currency's rate.
  // A currency worth little against the dollar (the rouble) the other way round, USD/RUB: roubles a dollar.
  const MONEY_FUND_CCY = { IE0002RUHW32: 'GBP', IE000AZVL3K0: 'EUR', IE000H9J0QX4: 'USD' };
  // (opts.currency: a currency itself, chart 1's slice -- its rate, no deals)
  const moneyCcy = opts.currency || MONEY_FUND_CCY[String(asset).toUpperCase()] || (/^(DEPOSIT|SAVINGS|ВКЛАД):/i.test(String(asset)) ? ccy : null);
  let rateNote = '';
  // the dollar's own slice (chart 1): no rate to the dollar -- the Fed's rate alone (the BIS's, monthly)
  if (opts.currency === 'USD') {
    dlg.querySelector('#mp_price_title').textContent = 'USD — Fed rate';
    dlg.querySelector('#mp_price_meta').textContent = '';
    dlg.querySelector('#mp_price_ccy_box').style.display = 'none';
    let pol = [];
    try {
      pol = (await mpFetchAll(() => sb.from('cb_rates_monthly').select('month, rate').eq('country', 'US').order('month')))
        .map(r => ({ day: r.month, rate: Number(r.rate) }));
    } catch (err) { note.textContent = String(err.message || err); return; }
    if (!pol.length) { note.textContent = 'No Fed rates stored yet.'; return; }
    const today = new Date().toISOString().slice(0, 10);
    const drawFed = period => {
      const from = mpPeriodStart(period, pol[0].day, today);
      const i0 = Math.max(0, pol.findLastIndex(r => r.day <= from));
      const ps = pol.slice(i0);
      const xs = [...ps.map((r, i) => (i === 0 && r.day < from ? from : r.day)), today], ys = [...ps.map(r => r.rate), ps[ps.length - 1].rate];
      Plotly.react(dlg.querySelector('#mp_price_chart'), [{ x: xs, y: ys, type: 'scatter', mode: 'lines', line: { shape: 'hv', color: '#d2a8ff', width: 2 },
        hovertemplate: '%{x}: Fed rate %{y}<extra></extra>' }], Object.assign({}, LAYOUT_BASE, {
        margin: { l: 60, r: 30, t: 24, b: 40 }, showlegend: false, hovermode: 'closest',
        xaxis: Object.assign({}, LAYOUT_BASE.xaxis, { type: 'date', dtick: undefined, tickformat: undefined, range: [from, today] }),
        yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { ticksuffix: '%', tickformat: undefined }),
      }), CONFIG);
      const first = ys[0], last = ys[ys.length - 1];
      dlg.querySelector('#mp_price_head').innerHTML = `<span style="font-size:2em;font-weight:700">${last}%</span>`
        + `<span style="color:#8b949e">${first === last ? 'unchanged' : `${last > first ? '▲' : '▼'} ${Math.abs(last - first).toFixed(2)} pp`} over ${mpEscapeHtml(period)}</span>`;
      note.textContent = `Fed rate (the BIS's, a month's as at its end; the middle of the target range): ${ps[ps.length - 1].day.slice(0, 7)} ${last}%`;
    };
    mpBindPeriods(dlg, drawFed);
    drawFed('1y');
    return;
  }
  if (moneyCcy === 'USD') {
    note.textContent = 'Dollars: a unit is always $1, the value moves only by the interest earned.';
    return;
  }
  if (moneyCcy) {
    const rates = fx.length && ccy === moneyCcy ? fx : await mpFetchAll(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', moneyCcy).order('day'));
    // by default every currency's price in dollars (EUR/USD, RUB/USD, CNY/USD -- one way for all, its rise a
    // rise of the line); the box turns it round
    if (opts.invert === undefined) opts = { ...opts, invert: true };
    const cheap = !opts.invert;
    const invBox = dlg.querySelector('#mp_price_inv_box');
    invBox.style.display = '';
    invBox.querySelector('span').textContent = cheap ? `${moneyCcy}/USD` : `USD/${moneyCcy}`;
    invBox.querySelector('input').onchange = () => { dlg.close(); mpOpenPriceDialog(asset, title, { ...opts, invert: !opts.invert }); };
    if (cheap) {
      // one dollar, shown in the currency at each day's rate: the currency per dollar
      prices = rates.map(r => ({ day: r.day, price_usd: 1 }));
      ccy = moneyCcy;
      fx = rates;
      rateNote = `USD/${moneyCcy} rate`;
      dlg.querySelector('#mp_price_title').textContent = opts.currency ? `USD/${moneyCcy}` : `${title} — USD/${moneyCcy}`;
    } else {
      prices = rates.map(r => ({ day: r.day, price_usd: Number(r.usd_per_unit) }));
      ccy = 'USD';
      fx = [];
      rateNote = `${moneyCcy}/USD rate`;
      dlg.querySelector('#mp_price_title').textContent = opts.currency ? `${moneyCcy}/USD` : `${title} — ${moneyCcy}/USD`;
    }
  }
  // a currency's own chart (chart 1): its exchanges (the view currency_exchanges -- transfers between
  // currencies, a bank's own exchanges, yuan funds bought for roubles), each at the rate it got: the
  // currency's amount over the other side's dollars that day (USD/RUB: roubles a dollar; RUB/USD the other way)
  let fxDeals = [];
  if (opts.currency) {
    try {
      const C = opts.currency;
      const rows = await mpFetchAll(() => sb.from('currency_exchanges').select('*')
        .or(`sold_ccy.eq.${C},bought_ccy.eq.${C}`).order('at'));
      const amt = (a, c) => `${Number(a).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c}`;
      // how far the rate got was off the day's rate (fx_history: the CBR's for the rouble, the market's for the
      // rest): what came in over what went out, at that rate, and in dollars -- "(+1.99%, +$7.49)" better,
      // "(-1.15%, -$4.66)" worse
      const edge = e => {
        const p = Number(e.sold_usd) > 0 ? (Number(e.bought_usd) / Number(e.sold_usd) - 1) * 100 : null;
        if (p == null || !Number.isFinite(p)) return '';
        const sign = p >= 0 ? '+' : '-', usd = Math.abs(Number(e.bought_usd) - Number(e.sold_usd)).toFixed(2);
        return ` (${sign}${Math.abs(p).toFixed(2)}%, ${sign}$${usd})`;
      };
      // the time, when known (the view's known_at: set by hand or from the bank's receipt -- a wall-clock time
      // kept as UTC), and its weekday: a bank's rate is worse when the market's shut (Ziraat: ~3% on an evening
      // or a weekend, ~1% in a weekday's hours)
      const when = t => (t ? `${String(t).slice(11, 16)} ${new Date(String(t).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}, ` : '');
      fxDeals = rows.map(e => {
        const bought = e.bought_ccy === C;
        const mine = Number(bought ? e.bought_amount : e.sold_amount), otherUsd = Number(bought ? e.sold_usd : e.bought_usd);
        if (!(mine > 0) || !(otherUsd > 0)) return null;
        const rate = opts.invert ? otherUsd / mine : mine / otherUsd;
        // through what, short: the bank (TBC Bank), banks (Revolut → Ozon Bank), the fund (T-Bank, TLCB), the card
        const how = String(e.how || '');
        // (a broker's own account says "broker" -- the view's; an exchange in a bank's app "in-bank exchange";
        // cash, an exchange office)
        const acct = how.split(': ')[0];
        const via = / -> /.test(how) ? how.replace(/ -> /, ' → ')
          : e.kind === 'fund' ? how.replace(/^(.*?): (?:buy|sell) /, '$1 broker, ')
          : e.kind === 'card' ? `${acct} card`
          : / broker$/.test(acct) || /^(IBKR|Freedom24|Interactive Brokers)$/i.test(acct) ? acct
          : acct === 'cash' ? 'cash, exchange office'
          : `${acct}, in-bank exchange`;
        // the mark as the chart's own asset's deal: on USD/RUB (the dollar's price in roubles) roubles bought
        // are the dollar sold -- a red sale; on RUB/USD (the rouble's price) a green buy
        return { day: String(e.at).slice(0, 10), bought, mine, usd: otherUsd, card: e.kind === 'card', side: bought === !!opts.invert ? 'buy' : 'sell', rate,
          text: `${amt(e.sold_amount, e.sold_ccy)} → ${amt(e.bought_amount, e.bought_ccy)}${edge(e)}<br>${when(e.known_at)}${mpEscapeHtml(via)}` };
      }).filter(Boolean);
    } catch (err) { console.warn('currency exchanges:', err); }
  }
  // ...and its central bank's rate under it: the CBR's key rate by day (key_rates), the others' policy
  // rates by month from the BIS (cb_rates_monthly: a month's rate as at its end); the lari's from the
  // NBG itself (the BIS hasn't it); the dirham is pegged to the dollar, the CBUAE's rate follows the
  // Fed's: the Fed's. None for the lek.
  const MP_CB_OF = { RUB: ['RU', 'CBR key rate'], EUR: ['XM', 'ECB rate'], GBP: ['GB', 'BoE rate'], CNY: ['CN', 'PBoC rate'],
    GEL: ['GE', 'NBG rate'], AED: ['US', 'Fed rate (AED pegged)'],
    TRY: ['TR', 'CBRT rate'], HUF: ['HU', 'MNB rate'], ILS: ['IL', 'BoI rate'], RSD: ['RS', 'NBS rate'], MKD: ['MK', 'NBRM rate'],
    JPY: ['JP', 'BoJ rate'], CHF: ['CH', 'SNB rate'], CAD: ['CA', 'BoC rate'], AUD: ['AU', 'RBA rate'], KRW: ['KR', 'BoK rate'],
    HKD: ['HK', 'HKMA rate'], INR: ['IN', 'RBI rate'], BRL: ['BR', 'BCB rate'], ZAR: ['ZA', 'SARB rate'], PLN: ['PL', 'NBP rate'],
    CZK: ['CZ', 'CNB rate'], SEK: ['SE', 'Riksbank rate'], NOK: ['NO', 'Norges Bank rate'], MXN: ['MX', 'Banxico rate'] };
  let policy = [], policyName = '';
  if (opts.currency && MP_CB_OF[opts.currency]) {
    try {
      const [country, name] = MP_CB_OF[opts.currency];
      policy = country === 'RU'
        ? (await mpFetchAll(() => sb.from('key_rates').select('day, rate').order('day'))).map(r => ({ day: r.day, rate: Number(r.rate) }))
        : (await mpFetchAll(() => sb.from('cb_rates_monthly').select('month, rate').eq('country', country).order('month'))).map(r => ({ day: r.month, rate: Number(r.rate) }));
      policyName = name;
    } catch (err) { console.warn('central bank rate:', err); }
  }
  if (!prices.length && opts.currency) { note.textContent = `No ${opts.currency} rates stored (fx_history keeps only the currencies of the accounts).`; return; }
  if (!prices.length) { note.textContent = 'No price history for this asset (a deposit, a savings account or cash has none).'; return; }
  // Splits: price_history keeps each day's price as it was (GOOGL 2 255 -> 112 on
  // 18.07.2022, its 20-for-1) -- a day's move of almost exactly a whole number of
  // times is taken for one, and the days before it are shown in today's
  // shares, as charts show a split. The capital needs none: it has the shares as they were.
  const splits = [];
  let factor = 1;
  const raw = prices.map(p => Number(p.price_usd));
  for (let i = prices.length - 1; i > 0; i--) {
    const r = raw[i - 1] / raw[i];
    if (!Number.isFinite(r) || r <= 0) { prices[i - 1] = { ...prices[i - 1], price_usd: raw[i - 1] / factor }; continue; }
    const k = r >= 1 ? r : 1 / r;
    // the nearest of the ratios splits are made in, within 6%: the day moves too (PLZL's 10-for-1 on
    // 27.03.2025 came out 10.18, GOOGL's 20-for-1 on 18.07.2022 20.9 -- taken for 21 by the nearest
    // whole number); a crash of a bond (98 -> 64) is no split; a 3-for-2 can't be told from one, so none
    const n = [2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100].reduce((b, x) => (Math.abs(k / x - 1) < Math.abs(k / b - 1) ? x : b), 2);
    if (Math.abs(k / n - 1) >= 0.06) { prices[i - 1] = { ...prices[i - 1], price_usd: raw[i - 1] / factor }; continue; }
    if (n && k >= 1.45) { factor *= r >= 1 ? n : 1 / n; splits.push(`${prices[i].day} ${r >= 1 ? `${n}-for-1` : `1-for-${n}`}`); }
    prices[i - 1] = { ...prices[i - 1], price_usd: raw[i - 1] / factor };
  }
  // A fund's constituent (opened from the map's expanded funds, opts.via: [{ fund, weight }]): each
  // buy / sale of the fund is one of this paper -- the money (the fund's USD price that day x its
  // units) x the paper's weight in the fund, over the paper's USD price that day
  // (a map tile in "as held" or merged passes an empty list: looked up here too)
  if (!opts.via?.length && !rateNote && dealTickers.some(t => MP_INDEX_FUNDS.has(t))) {
    try {
      const own = await mpFetchAll(() => sb.from('fund_holdings').select('security_id').in('fund', dealTickers.filter(t => MP_INDEX_FUNDS.has(t))).order('fund').order('security_id'));
      const broad = await mpFetchAll(() => sb.from('fund_holdings').select('security_id, weight').eq('fund', MP_BROAD_FUNDS[0]).order('security_id'));
      const ids = new Set(own.map(r => r.security_id));
      const weight = broad.reduce((a, r) => a + (ids.has(r.security_id) ? Number(r.weight) || 0 : 0), 0) / 100;
      if (weight > 0) opts = { ...opts, indexVia: true, via: MP_BROAD_FUNDS.map(fund => ({ fund, weight })) };
    } catch (err) { console.warn('broad funds holding it:', err); }
  }
  if (!opts.via?.length && !rateNote && !(await cryptoKnown)) {
    try {
      const { data: secs } = await sb.from('securities').select('id, name').or(dealTickers.map(t => `ticker.eq.${t},market_ticker.eq.${t}`).join(','));
      // the company's other share classes too (GOOGL and GOOG: one "Alphabet Inc")
      const names = [...new Set((secs || []).map(r => r.name).filter(Boolean))];
      const { data: same } = names.length ? await sb.from('securities').select('id').in('name', names) : { data: [] };
      const ids = [...new Set([...(secs || []), ...(same || [])].map(r => r.id))];
      const { data: fh } = ids.length ? await sb.from('fund_holdings').select('fund, weight').in('security_id', ids) : { data: [] };
      const w = new Map();
      for (const r of fh || []) w.set(r.fund, (w.get(r.fund) || 0) + (Number(r.weight) || 0) / 100);
      opts = { ...opts, via: [...w].filter(([, v]) => v > 0).map(([fund, weight]) => ({ fund, weight })) };
    } catch (err) { console.warn('funds holding it:', err); }
  }
  if (opts.via?.length) {
    try {
      const funds = opts.via.map(v => v.fund);
      const [fundDeals, fundPx] = await Promise.all([
        mpFetchAll(() => sb.from('trades').select('ticker, trade_date, side, quantity, price, account').in('ticker', funds).in('side', ['buy', 'sell']).gt('price', 0).order('trade_date')),
        mpFetchAll(() => sb.from('price_history').select('ticker, day, price_usd').in('ticker', funds).order('day')),
      ]);
      const lastOn = (rows, day) => { let v = null; for (const r of rows) { if (r.day > day) break; v = Number(r.price_usd); } return v; };
      const pxOf = new Map(funds.map(f => [f, fundPx.filter(r => r.ticker === f)]));
      for (const d of fundDeals) {
        const w = opts.via.find(v => v.fund === d.ticker)?.weight;
        const fUsd = lastOn(pxOf.get(d.ticker) || [], d.trade_date), pUsd = lastOn(prices, d.trade_date);
        if (!(w > 0) || !(fUsd > 0) || !(pUsd > 0)) continue;
        const money = Number(d.quantity) * fUsd * w;
        deals.push({ trade_date: d.trade_date, side: d.side, quantity: Math.round(money / pUsd * 1e6) / 1e6, ticker: asset, via: true, indexVia: !!opts.indexVia, money,
          account: `${d.account || '—'}, via ${d.ticker}` });
      }
      deals.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    } catch (err) { console.warn('fund deals:', err); }
  }
  const usdBox = dlg.querySelector('#mp_price_usd');
  // gold trades in dollars: opens in USD whatever most of the buys were paid in (the box gets that currency back)
  if (!rateNote && ['XAU', 'XAUT'].includes(asset)) usdBox.checked = true;
  if (ccy === 'USD' || rateNote) dlg.querySelector('#mp_price_ccy_box').style.display = 'none';   // a rate: nothing to switch
  // the rate of a day: the last one on or before it
  const rateOn = day => { let lo = 0, hi = fx.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (fx[m].day <= day) { r = Number(fx[m].usd_per_unit); lo = m + 1; } else hi = m - 1; } return r; };
  const today = prices[prices.length - 1].day;
  const startOf = p => mpPeriodStart(p, prices[0].day, today);
  let period = '1y';
  const draw = () => {
    const usd = ccy === 'USD' || usdBox.checked;
    const unit = usd ? 'USD' : ccy;
    const val = (day, v) => (usd ? Number(v) : (rateOn(day) ? Number(v) / rateOn(day) : null));
    const from = startOf(period);
    const pts = prices.filter(p => p.day >= from).map(p => ({ day: p.day, v: val(p.day, p.price_usd) })).filter(p => p.v != null);
    const priceOn = day => { const p = [...pts].reverse().find(x => x.day <= day) ?? pts[0]; return p?.v ?? null; };
    // a money-market fund's or a deposit's "buys" and "sales" are the money moved in and out of it
    // (a withdrawal to the account is no sale): none on its currency's rate
    const viaOn = dlg.querySelector('#mp_price_via').checked;
    const shown = rateNote ? [] : deals.filter(d => d.trade_date >= from && (viaOn || !d.via));
    const fmt = v => (unit === 'USD' ? `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 4 : 2 })}` : `${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 4 : 2 })} ${unit}`);
    // the line green when the period ended up, red when down (a broker app's way)
    const lineCol = pts.length > 1 && pts[pts.length - 1].v < pts[0].v ? '#f85149' : '#3fb950';
    const traces = [{ x: pts.map(p => p.day), y: pts.map(p => p.v), type: 'scatter', mode: 'lines', line: { color: lineCol, width: 2 },
      name: 'price', hovertemplate: `%{x}: %{y:,.4~f} ${unit}<extra></extra>` }];
    // the payouts (yellow dots on the line): each, or a month's together when there are many (Revolut's
    // funds pay every day); a fund's fee taken off its return nets within the month
    let payTrace = null, payShapes = [], avgNote = '';
    if (dlg.querySelector('#mp_price_pay').checked) {
      let ps = payouts.filter(p => p.day >= from);
      if (ps.length > 24) {
        const byMonth = new Map();
        for (const p of ps) {
          const k = `${p.day.slice(0, 7)}|${p.ccy}|${p.what}`;
          const m = byMonth.get(k) || { ...p, amount: 0, n: 0 };
          m.amount += p.amount; m.n += 1; m.day = p.day;
          byMonth.set(k, m);
        }
        ps = [...byMonth.values()].filter(p => p.amount > 0);
      }
      ps = ps.filter(p => p.amount > 0);
      const fmtAmt = (a, c) => `${a.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 6 : 2 })} ${c}`;
      // a thin grey line through the whole chart, a dot on its top (the usual way: Yahoo's, TradingView's)
      payShapes = ps.map(p => ({ type: 'line', xref: 'x', yref: 'paper', x0: p.day, x1: p.day, y0: 0, y1: 0.96, line: { color: 'rgba(139,148,158,0.45)', width: 1 }, layer: 'below' }));
      if (ps.length) payTrace = { x: ps.map(p => p.day), y: ps.map(() => 0.96), yaxis: 'y2', type: 'scatter', mode: 'markers', name: 'payouts', cliponaxis: false,
        marker: { color: '#8b949e', size: 7, symbol: 'circle' },
        text: ps.map(p => `${p.what} ${fmtAmt(p.amount, p.ccy)}${p.n > 1 ? ` (${p.day.slice(0, 7)}, ${p.n} payments)` : ''} at ${p.account}`),
        hovertemplate: '%{x}: %{text}<extra></extra>' };
    }
    // one's own deals drawn over the ones through a fund (via), and brighter. Sber's app's marks: a little
    // "house" (a box with a pointed end) just off the line -- a buy under it pointing up at it, a sale over
    // it pointing down; drawn as shapes in pixels around the deal's point, an invisible dot there for the hover
    const dealShapes = [];
    // a mark's hover: units to two decimals (a coin's small amount to four significant digits), and what the
    // deal came to in its own currency; a fund's share in dollars; no price stored: about, at the day's price
    const dealQty = q => Number(q).toLocaleString('en-US', Math.abs(Number(q)) >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 });
    const dealMoney = d => {
      const sum = (v, c) => (c === 'USD' ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c}`);
      if (d.money != null) return sum(d.money, 'USD');
      if (Number(d.price) > 0) return sum(Number(d.quantity) * Number(d.price), String(d.currency || ccy).toUpperCase());
      const at = priceOn(d.trade_date);
      return at == null ? '—' : `~${fmt(Number(d.quantity) * at)}`;
    };
    const house = (up, k) => {
      const g = 3, w = 3.5 * k, sh = g + 4 * k, b = g + 11 * k, sg = up ? -1 : 1;   // gap, half-width, shoulders, base
      const P = (x, y) => `${x.toFixed(1)},${(sg * y).toFixed(1)}`;
      return `M ${P(0, g)} L ${P(w, sh)} L ${P(w, b)} L ${P(-w, b)} L ${P(-w, sh)} Z`;
    };
    for (const via of [true, false]) {
      for (const [side, color] of [['buy', '#3fb950'], ['sell', '#f85149']]) {
        const ds = mpMergeDayDeals(shown.filter(d => d.side === side && !!d.via === via));
        if (!ds.length) continue;
        // one's own: a mark of the line's own colour goes light (a buy on a green line, a sale on a red one),
        // of the other colour stays bright (a buy on a red line, a sale on a green one)
        const upLine = lineCol === '#3fb950';
        const fill = via ? color : side === 'buy' ? (upLine ? '#b4ffc0' : '#39ff5a') : (upLine ? '#ff2d2d' : '#ffa8a8');
        for (const d of ds) dealShapes.push({ type: 'path', xref: 'x', yref: 'y', xsizemode: 'pixel', ysizemode: 'pixel',
          xanchor: d.trade_date, yanchor: priceOn(d.trade_date), path: house(side === 'buy', via ? 0.75 : 1),
          fillcolor: fill, line: { color: '#000000', width: 0.6 }, layer: 'above' });
        traces.push({ x: ds.map(d => d.trade_date), y: ds.map(d => priceOn(d.trade_date)), type: 'scatter', mode: 'markers', name: `${side}${via ? ' via a fund' : ''}`,
          marker: { color: fill, size: 14, opacity: 0 },
          text: ds.map(d => `${side} ${dealMoney(d)}<br>${dealQty(d.quantity)} ${d.ticker || asset}<br>${d.account}${d.n > 1 ? ` (${d.n} trades)` : ''}`), hovertemplate: '%{x}:<br>%{text}<extra></extra>' });
      }
    }
    // a currency's exchanges: a mark at the rate each got (off the line by how much better or worse than the day's)
    const fxShown = fxDeals.filter(d => d.day >= from);
    // the chart runs to the last deal when that's after the last price (a Sunday's exchange, the market shut
    // since Friday): the line stops at its last price, the mark stands on its own
    const end = [today, ...shown.map(d => d.trade_date), ...fxShown.map(d => d.day)].reduce((a, b) => (b > a ? b : a));
    for (const [side, color] of [['buy', '#39ff5a'], ['sell', '#ff2d2d']]) {
      const ds = fxShown.filter(d => d.side === side);
      if (!ds.length) continue;
      for (const d of ds) dealShapes.push({ type: 'path', xref: 'x', yref: 'y', xsizemode: 'pixel', ysizemode: 'pixel',
        xanchor: d.day, yanchor: d.rate, path: house(side === 'buy', d.card ? 0.55 : 0.9), fillcolor: color, line: { color: '#000000', width: 0.6 }, layer: 'above' });
      traces.push({ x: ds.map(d => d.day), y: ds.map(d => d.rate), type: 'scatter', mode: 'markers', name: side === 'buy' ? 'bought' : 'sold',
        marker: { color, size: 14, opacity: 0 }, text: ds.map(d => d.text),
        hovertemplate: '%{x}:<br>%{text}<extra></extra>' });
    }
    if (payTrace) traces.push(payTrace);
    // the central bank's rate: a step line over the rate's, its own scale on the right (from the last change
    // before the period); the box hides it
    const fromIdx = policy.findLastIndex(r => r.day <= from);
    const pol = dlg.querySelector('#mp_price_rate').checked ? policy.slice(Math.max(0, fromIdx)) : [];
    if (pol.length) {
      const xs = [...pol.map((r, i) => (i === 0 && r.day < from ? from : r.day)), end], ys = [...pol.map(r => r.rate), pol[pol.length - 1].rate];
      traces.push({ x: xs, y: ys, yaxis: 'y3', type: 'scatter', mode: 'lines', line: { shape: 'hv', color: 'rgba(139,148,158,0.55)', width: 1.5, dash: 'dot' },
        name: policyName, hovertemplate: `%{x}: ${policyName} %{y}<extra></extra>` });   // (y3's ticksuffix gives the %)
    }
    // like a broker's app: the period's low and high (white dots, the price by them), a line at today's
    // price and one at the average buy price of what one holds now
    const lines = [], notes = [];
    const last0 = pts[pts.length - 1];
    if (pts.length > 1) {
      const lo = pts.reduce((a, p) => (p.v < a.v ? p : a)), hi = pts.reduce((a, p) => (p.v > a.v ? p : a));
      traces.push({ x: [lo.day, hi.day], y: [lo.v, hi.v], type: 'scatter', mode: 'markers', name: 'low / high', cliponaxis: false,
        marker: { color: '#ffffff', size: 6 }, hoverinfo: 'skip' });
      // the price by each on a dark plate (Sber's way)
      // the last day's low or high: today's price label says it already; one near the right end: to the left of
      // its dot (to the right it ran into today's label)
      const lastDay = pts[pts.length - 1].day, nearEnd = d => pts.findIndex(q => q.day === d) > pts.length * 0.85;
      for (const [p, up] of [[lo, false], [hi, true]]) if (p.day !== lastDay) notes.push({ x: p.day, y: p.v, xref: 'x', yref: 'y', text: fmt(p.v), showarrow: false,
        xanchor: nearEnd(p.day) ? 'right' : 'left', yanchor: up ? 'bottom' : 'top', xshift: nearEnd(p.day) ? -5 : 5, yshift: up ? 2 : -2,
        bgcolor: '#2d333b', font: { color: '#8b949e', size: 12 }, borderpad: 3 });
    }
    // to the right of the plot, a gap between (they melted into the line's end)
    const label = (y, text, bg, fg) => notes.push({ xref: 'paper', x: 1, xanchor: 'left', xshift: pol.length ? 52 : 10, yref: 'y', y, text, showarrow: false,
      bgcolor: bg, font: { color: fg, size: 12 }, borderpad: 3 });
    if (last0) {
      lines.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: last0.v, y1: last0.v, line: { color: 'rgba(230,237,243,0.35)', width: 1 }, layer: 'below' });
      label(last0.v, fmt(last0.v), '#e6edf3', '#0d1117');
    }
    // (over the whole history, or only the deals in the period shown -- the box)
    const avgAll = dlg.querySelector('#mp_price_avg_all').checked;
    // the average buy price of what's held: one's own deals over the whole history (not a fund's), as Sber
    // counts it -- each buy adds its cost with the fee and its units, a sale takes units out at the average
    // (checked on SBMM: 18.3767 this way against Sber's 18.3771; FIFO gave 18.41); none when nothing is held
    if (!rateNote) {
      const chartOn = day => { let v = null; for (const p of prices) { if (p.day > day) break; v = p.price_usd; } return v == null ? null : val(day, v); };
      const pos = { qty: 0, cost: 0 };
      // the funds' buys too when they're shown (the box) -- but on an index fund's own chart its average stays
      // that of the units one holds of it: a broad fund's buy is a mark only
      for (const d of deals.filter(x => (viaOn || !x.via) && !x.indexVia && (avgAll || x.trade_date >= from))) {
        const q = Number(d.quantity); if (!(q > 0)) continue;
        if (d.side === 'buy') {
          const at = chartOn(d.trade_date);
          const dc = String(d.currency || ccy).toUpperCase();
          // the broker's fee is in the cost (Sber's 297.99 for SBER is the prices and the fees over 91 shares)
          const fee = String(d.fee_currency || dc).toUpperCase() === dc ? Number(d.fee_tax) || 0 : 0;
          let px = Number(d.price) > 0 ? Number(d.price) + fee / q : null;
          if (px != null && dc !== unit) {
            const r = fx.length ? rateOn(d.trade_date) : null;   // USD per unit of the paper's currency
            px = unit === 'USD' && dc === ccy && r ? px * r : null;
          }
          // a price from before a split: to the chart's (split-adjusted) scale
          if (px != null && at > 0) { const k = px / at; if (k > 1.45 || k < 1 / 1.45) { const n = Math.round(k >= 1 ? k : 1 / k); px = k >= 1 ? px / n : px * n; } }
          px = px ?? at;
          if (px == null) continue;
          pos.qty += q; pos.cost += q * px;
        } else if (pos.qty > 0) {
          const avg = pos.cost / pos.qty; pos.qty = Math.max(0, pos.qty - q); pos.cost = pos.qty * avg;
        }
      }
      const { qty, cost } = pos;
      if (qty > 1e-9 && cost > 0) {
        const avg = cost / qty;
        lines.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: avg, y1: avg, line: { color: '#8b949e', width: 1, dash: 'dot' }, layer: 'below' });
        label(avg, `avg ${fmt(avg)}`, '#30363d', '#e6edf3');
        avgNote = ` · average buy price ${fmt(avg)} for ${Math.round(qty * 1e6) / 1e6} held (${last0 ? `${last0.v >= avg ? '+' : ''}${((last0.v / avg - 1) * 100).toFixed(1)}%` : ''})`;
      }
    }
    // a currency's: the same over its exchanges -- each bought adds its units and the dollars paid, each sold
    // takes units out at the average; the average's dollars a unit, shown as the chart is (CCY/USD or USD/CCY)
    if (opts.currency && fxDeals.length) {
      const pos = { qty: 0, usd: 0 };
      for (const d of fxDeals.filter(x => avgAll || x.day >= from)) {
        if (d.bought) { pos.qty += d.mine; pos.usd += d.usd; }
        else if (pos.qty > 0) { const a = pos.usd / pos.qty; pos.qty = Math.max(0, pos.qty - d.mine); pos.usd = pos.qty * a; }
      }
      if (pos.qty > 1e-9 && pos.usd > 0) {
        const avg = opts.invert ? pos.usd / pos.qty : pos.qty / pos.usd;
        lines.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: avg, y1: avg, line: { color: '#8b949e', width: 1, dash: 'dot' }, layer: 'below' });
        label(avg, `avg ${fmt(avg)}`, '#30363d', '#e6edf3');
        avgNote = ` · average rate ${fmt(avg)} for ${Math.round(pos.qty).toLocaleString('en-US')} ${opts.currency} bought (${last0 ? `${last0.v >= avg ? '+' : ''}${((last0.v / avg - 1) * 100).toFixed(1)}%` : ''})`;
      }
    }
    // the two labels on the right (today's price, the average) apart when they'd overlap: ~22 px of the plot's
    if (notes.length) {
      const ys = [...pts.map(p => p.v), ...notes.filter(n => n.xref === 'paper').map(n => n.y)], span = (Math.max(...ys) - Math.min(...ys)) || 1;
      const px = v => v / span * 350;   // the plot's ~350 px tall
      // (any number of them -- today's, a currency's average buy and sell: top down, each at least 22 px under the one above)
      const side = notes.filter(n => n.xref === 'paper').sort((a, b) => b.y - a.y);
      let prev = Infinity;
      for (const n of side) { const at = Math.min(px(n.y), prev - 22); n.yshift = at - px(n.y); prev = at; }
    }
    // the rate's scale: its line in the lower quarter
    const rateRange = () => {
      const rs = pol.map(r => r.rate), lo = Math.min(...rs), hi = Math.max(...rs), span = Math.max(hi - lo, 0.25, Math.abs(hi) * 0.05);
      return [lo - span * 0.08, lo + span / 0.25];
    };
    Plotly.react(dlg.querySelector('#mp_price_chart'), traces, Object.assign({}, LAYOUT_BASE, {
      margin: { l: 60, r: pol.length ? 172 : 130, t: 24, b: 40 }, showlegend: false, hovermode: 'closest', annotations: notes,
      xaxis: Object.assign({}, LAYOUT_BASE.xaxis, { type: 'date', dtick: undefined, tickformat: undefined, range: [from, end] }),
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { type: 'linear', tickformat: undefined, ticksuffix: unit === 'USD' ? '' : ` ${unit}`, tickprefix: unit === 'USD' ? '$' : '' },
        // with the central bank's rate in the lower quarter, the currency's line (its marks and the low's label too)
        // keeps just above where the rate's line reaches
        pol.length ? (() => {
          const ys = [...pts.map(p => p.v), ...fxShown.map(d => d.rate)].filter(Number.isFinite);
          const lo = Math.min(...ys), hi = Math.max(...ys), sp = (hi - lo) || Math.abs(hi) * 0.02 || 1;
          const [r0, r1] = rateRange(), rTop = Math.max(...pol.map(r => r.rate));
          const f = Math.min(0.4, (rTop - r0) / (r1 - r0) + 0.07);   // the rate line's top, a share of the height, and a gap
          const total = sp / (1 - f - 0.05);
          return { range: [lo - f * total, lo - f * total + total] };
        })() : {}),
      // the rate in the chart's lower quarter, grey and faint: there, not in the way of the currency's line
      ...(pol.length ? { yaxis3: { overlaying: 'y', side: 'right', showgrid: false, zeroline: false, ticksuffix: '%', fixedrange: true,
        tickfont: { color: 'rgba(139,148,158,0.7)' }, linecolor: '#1e2830', range: rateRange() } } : {}),
      yaxis2: { overlaying: 'y', range: [0, 1], visible: false, fixedrange: true }, shapes: [...payShapes, ...lines, ...dealShapes],
    }), CONFIG);
    const first = pts[0], last = pts[pts.length - 1];
    const ch = first && last && first.v ? (last.v / first.v - 1) * 100 : null;
    note.textContent = first ? `${rateNote ? `${rateNote}: ` : ''}${first.day} ${fmt(first.v)} → ${last.day} ${fmt(last.v)}${ch == null ? '' : ` (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%)`}`
      + `${shown.length ? ` · deals marked: ${shown.length}` : ''}${fxShown.length ? ` · exchanges marked: ${fxShown.length} (at the rate each got)` : ''}${pol.length ? ` · ${policyName} now ${pol[pol.length - 1].rate}%` : ''}${avgNote}${splits.length ? ` · split-adjusted: ${splits.join(', ')}` : ''}` : 'No prices in this period.';
    // a currency's exchange rule: when the bank's rate is fair (from the marks' times, 23.11.2026)
    let rule = dlg.querySelector('#mp_price_fx_rule');
    if (!rule) { rule = document.createElement('p'); rule.id = 'mp_price_fx_rule'; rule.className = note.className; note.after(rule); }
    rule.textContent = MP_FX_RULES[opts.currency] || '';
    rule.style.display = rule.textContent ? '' : 'none';
    // today's price, big, and the period's change under the title (a broker app's header)
    const head = dlg.querySelector('#mp_price_head');
    if (first && last) {
      const up = last.v >= first.v, col = up ? '#3fb950' : '#f85149', d = last.v - first.v;
      // a currency's rate: its sign (82.19 ₽), the central bank's rate after it in brackets, (14%)
      const sym = unit !== 'USD' && opts.currency ? (MP_CURRENCY_SYMBOLS[unit] || (() => {
        try { return new Intl.NumberFormat('en', { style: 'currency', currency: unit, currencyDisplay: 'narrowSymbol' }).formatToParts(1).find(x => x.type === 'currency')?.value; } catch { return null; }
      })()) : null;
      const big = sym && sym !== unit ? `${last.v.toLocaleString('en-US', { maximumFractionDigits: last.v < 10 ? 4 : 2 })} ${sym}` : fmt(last.v);
      head.innerHTML = `<span style="font-size:2em;font-weight:700">${mpEscapeHtml(big)}</span>`
        + (pol.length ? `<span style="color:#8b949e;font-size:1.3em" title="${mpEscapeHtml(policyName)}">(${pol[pol.length - 1].rate}%)</span>` : '')
        + `<span style="color:${col};font-size:1.1em">${up ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}% · ${mpEscapeHtml(fmt(Math.abs(d)))}</span>`
        + `<span style="color:#8b949e">over ${mpEscapeHtml(period)}</span>`;
    } else head.innerHTML = '';
  };
  mpBindPeriods(dlg, p => { period = p; draw(); });
  usdBox.onchange = draw;
  // the funds' deals marked as this paper's: shown or not (remembered); the box only when there are any
  const viaBox = dlg.querySelector('#mp_price_via');
  try { viaBox.checked = localStorage.getItem('mp_price_via') !== '0'; } catch { /* no storage */ }
  if (!rateNote && deals.some(d => d.via)) dlg.querySelector('#mp_price_via_box').style.display = '';
  const payBox = dlg.querySelector('#mp_price_pay');
  try { payBox.checked = localStorage.getItem('mp_price_pay') !== '0'; } catch { /* no storage */ }
  if (payouts.length) dlg.querySelector('#mp_price_pay_box').style.display = '';
  payBox.onchange = () => { mpSave('mp_price_pay', payBox.checked ? '1' : '0'); draw(); };
  // the central bank's rate over a currency's: on whenever the window opens (not remembered), the box hides it
  // for a look; the box only when there's one
  const rateBox = dlg.querySelector('#mp_price_rate');
  rateBox.checked = true;
  if (policy.length) { dlg.querySelector('#mp_price_rate_box').style.display = ''; dlg.querySelector('#mp_price_rate_box span').textContent = policyName; }
  rateBox.onchange = draw;
  // the average over the period shown, or over all time with the box -- off whenever the window opens (not
  // remembered, the user's rule 23.11.2026); the box where there's an average to draw
  const avgBox = dlg.querySelector('#mp_price_avg_all');
  avgBox.checked = false;
  if (fxDeals.length || (!rateNote && deals.length)) dlg.querySelector('#mp_price_avg_box').style.display = '';
  avgBox.onchange = draw;
  viaBox.onchange = () => { mpSave('mp_price_via', viaBox.checked ? '1' : '0'); draw(); };
  draw();
}
