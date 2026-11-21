// The Invested tab: invested vs value, earned by asset, and its controls.

// Invested vs value of the investments (investment_daily, migration 058).
let mpInvestedRows = null;
async function mpRenderInvested() {
  const el = document.getElementById('plot_capital_invested');
  const status = document.getElementById('invested_status');
  const ccy = document.getElementById('invested_ccy').value === 'RUB' ? 'RUB' : 'USD';
  if (ccy === 'RUB' && !mpCapitalRub) {
    status.textContent = 'Loading RUB rates…';
    try { mpCapitalRub = await mpLoadRubRates(); } catch (error) { status.textContent = error.message; return; }
  }
  status.textContent = '';
  const conv = mpCapitalConverter(ccy);
  if (!mpInvestedRows) {
    const { rows, error } = await mpFetchAllRows(() => sb.from('investment_daily').select('day, value_usd, invested_usd, income_usd, value_rub, invested_rub, income_rub').order('day'));
    if (error) { status.textContent = error.message; return; }
    mpInvestedRows = rows;
  }
  if (!mpInvestedRows.length) { status.textContent = 'No history yet -- built with the next capital rebuild.'; return; }
  const days = mpInvestedRows.map(r => r.day);
  // roubles: kept by the database at each day's own rate (migration 071)
  const rub = ccy === 'RUB';
  const value = mpInvestedRows.map(r => (rub ? Number(r.value_rub) : conv(r.day, r.value_usd)));
  // own money put in: what's invested less the income that stayed invested (a
  // reinvested dividend, capitalised interest) -- the gap to the value is then
  // all that was earned: price growth, exchange rates, dividends, coupons, interest
  const invested = mpInvestedRows.map(r => (rub ? Number(r.invested_rub) - Number(r.income_rub)
    : conv(r.day, Number(r.invested_usd) - Number(r.income_usd))));
  const money = ccy === 'RUB' ? '%{y:,.0f} ₽' : '$%{y:,.0f}';
  const earned = value.map((v, i) => v - invested[i]);
  const traces = [
    { x: days, y: invested, name: 'Invested (own money)', type: 'scatter', mode: 'lines', line: { color: '#a371f7', width: 2, dash: 'dash' },
      hovertemplate: `${money}<extra>Invested</extra>` },
    { x: days, y: value, name: 'Value', type: 'scatter', mode: 'lines', line: { color: '#58a6ff', width: 2 },
      fill: 'tonexty', fillcolor: 'rgba(88,166,255,0.12)', customdata: earned,
      hovertemplate: `${money}<br>earned ${ccy === 'RUB' ? '%{customdata:,.0f} ₽' : '$%{customdata:,.0f}'}<extra>Value</extra>` },
  ];
  await Plotly.react(el, traces, mpCapitalLayout(ccy, { hovermode: 'x unified' }), CONFIG);
  // A chosen period starts "invested" where the value stood on its first day,
  // adding only what was put in during it -- the gap is then what the period
  // earned, not losses from before it (FinEx funds frozen in 2022, ...).
  const rebase = (from) => {
    let i0 = from ? days.findIndex(d => d >= from) : 0;
    if (i0 < 0) i0 = 0;
    const off = from ? invested[i0] - value[i0] : 0;
    const inv = invested.map(v => v - off);
    const earn = value.map((v, i) => v - inv[i]);
    Plotly.restyle(el, { y: [inv, value], customdata: [null, earn] }, [0, 1]);
    el.mpInvestedLast = { inv, i0 };
    drawEarned();
    mpInvestedAssetsSoon();
  };
  // What was earned by each day of the period (value less invested, from 0 on
  // its first day), and its % over the average capital (Modified Dietz).
  const drawEarned = () => {
    const { inv, i0 } = el.mpInvestedLast;
    const range = el.layout?.xaxis?.range;
    const toDay = range ? String(range[1]).slice(0, 10) : days[days.length - 1];
    let i1 = days.length - 1;
    while (i1 > i0 && days[i1] > toDay) i1--;
    const gap = value.map((v, i) => v - inv[i]);
    const x = days.slice(i0, i1 + 1);
    const y = gap.slice(i0, i1 + 1).map(v => v - gap[i0]);
    const span = Math.max(i1 - i0, 1);
    let base = value[i0];
    for (let i = i0 + 1; i <= i1; i++) base += (inv[i] - inv[i - 1]) * (i1 - i) / span;
    const total = y[y.length - 1] ?? 0;
    const pct = base > 0 ? total / base * 100 : null;
    const fmt = v => (v < 0 ? '−' : '+') + (ccy === 'RUB' ? `${Math.round(Math.abs(v)).toLocaleString('en-US')} ₽` : `$${Math.round(Math.abs(v)).toLocaleString('en-US')}`);
    const up = total >= 0;
    // In %: each day what was earned by then over the capital that worked on
    // average from i0 to that day (Modified Dietz, as the title's -- the money
    // put in weighted by the share of those days left after it): with F the
    // sum of the flows so far and S their days' sum, the weighted part is
    // (j*F - S) / (j - i0).
    const inPct = document.getElementById('invested_earned_pct').checked;
    let shown = y;
    if (inPct) {
      let F = 0, S = 0;
      shown = x.map((_, k) => {
        const j = i0 + k;
        if (k > 0) { const f = inv[j] - inv[j - 1]; F += f; S += f * j; }
        const b = value[i0] + (k > 0 ? (j * F - S) / (j - i0) : 0);
        return b > 0 ? y[k] / b * 100 : null;
      });
    }
    Plotly.react('plot_invested_earned', [{
      x, y: shown, type: 'scatter', mode: 'lines', line: { color: up ? '#3fb950' : '#f85149', width: 2 },
      fill: 'tozeroy', fillcolor: up ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)',
      hovertemplate: `${inPct ? '%{y:+.2f}%' : money}<extra>earned</extra>`,
    }], Object.assign({}, LAYOUT_BASE, {
      title: { text: `${x[0] ?? ''} → ${x[x.length - 1] ?? ''}: ${fmt(total)}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`}`, font: { size: 13 } },
      showlegend: false, hovermode: 'x unified', margin: { t: 40, r: 20, b: 50, l: 70 },
      xaxis: Object.assign({}, LAYOUT_BASE.xaxis, { type: 'date', dtick: undefined, tickformat: undefined }),
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { zeroline: true, zerolinecolor: '#6e7681',
        tickprefix: !inPct && ccy === 'USD' ? '$' : '', ticksuffix: inPct ? '%' : ccy === 'RUB' ? ' ₽' : '' }),
    }), CONFIG);
  };
  el.mpInvestedEarned = drawEarned;
  // the % switch, remembered in this browser (wired once)
  const pctBox = document.getElementById('invested_earned_pct');
  if (!pctBox.mpWired) {
    pctBox.mpWired = true;
    try { pctBox.checked = localStorage.getItem('mp_invested_earned_pct') === '1'; } catch { /* no storage */ }
    pctBox.addEventListener('change', () => {
      mpSave('mp_invested_earned_pct', pctBox.checked ? '1' : '0');
      if (el.mpInvestedEarned) el.mpInvestedEarned();
    });
  }
  el.mpInvestedLast = { inv: invested, i0: 0 };
  el.mpInvestedRebase = rebase;
  // the day counted from, marked by a vertical line
  const mark = d => Plotly.relayout(el, { shapes: d ? [{ type: 'line', xref: 'x', yref: 'paper', x0: d, x1: d, y0: 0, y1: 1,
    line: { color: '#d29922', width: 1.5, dash: 'dot' } }] : [] });
  el.mpInvestedMark = mark;
  // a day chosen to count from wins over the zoom
  const fixedFrom = document.getElementById('invested_from').value;
  if (fixedFrom) {
    rebase(fixedFrom);
    await Plotly.relayout(el, { 'xaxis.range': [fixedFrom, days[days.length - 1]] });
    await mark(fixedFrom);
  } else drawEarned();
  // a last day set for the period: the zoom ends there
  const fixedTo = document.getElementById('invested_to').value;
  if (fixedTo) await Plotly.relayout(el, { 'xaxis.range': [fixedFrom || days[0], fixedTo] });
  mpInvestedAssetsSoon();
  if (!el.mpInvestedBound) {
    el.mpInvestedBound = true;
    // a click on the chart sets the day to count from (the zoom stays)
    el.on('plotly_click', ev => {
      const d = String(ev.points?.[0]?.x ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      document.getElementById('invested_from').value = d;
      mpSave('mp_invested_from', d);
      el.mpInvestedRebase(d);
      el.mpInvestedMark(d);
    });
    el.on('plotly_relayout', ev => {
      if (ev.shapes) return;
      mpInvestedAssetsSoon();   // a new end of the period
      el.mpInvestedEarned();
      if (document.getElementById('invested_from').value) return;
      const a = ev['xaxis.range[0]'] ?? ev['xaxis.range']?.[0];
      if (a) el.mpInvestedRebase(String(a).slice(0, 10));
      else if (ev['xaxis.autorange']) el.mpInvestedRebase(null);
    });
  }
}
// Bonds by name, not by ISIN / MOEX code: MOEX ISS (allows this site's origin).
// The bonds market lists the ones trading; a matured one is looked up alone.
// Remembered in the browser (names don't change).
const MP_BOND_RE = /^(RU|SU)[0-9A-Z]{10}$/;
// Funds known by their ISIN only: Revolut's Flexible Cash Funds -- Fidelity
// Institutional Liquidity Fund, one share class per currency.
// A mark after an asset's name in "what each asset earned": Revolut's
// Flexible Cash Funds, and the S&P 500 funds (IBKR's CSPX / VUAA; T-Bank's
// TSPX is "Т-Капитал США 50", not one)
const MP_ASSET_MARKS = {
  IE0002RUHW32: '💧🇬🇧', IE000AZVL3K0: '💧🇪🇺', IE000H9J0QX4: '💧🇺🇸',
  // the Russian money-market funds: in roubles Sber's SBMM and Alfa-Capital's
  // AKMM, in yuan Alfa-Capital's AKMC
  SBMM: '💧🇷🇺', AKMM: '💧🇷🇺', AKMC: '💧🇨🇳',
  CSPX: '📈🇺🇸', VUAA: '📈🇺🇸',
  // the Moscow Exchange index fund (T-Capital's TMOS)
  TMOS: '📈🇷🇺',
};
const MP_ASSET_NAMES = {
  XSX6: 'STOXX Europe 600', VWRA: 'FTSE All-World (Vanguard, $)', VWCE: 'FTSE All-World (Vanguard, €)',
  CSPX: 'S&P 500 (iShares)', VUAA: 'S&P 500 (Vanguard)',
  IE0002RUHW32: 'Revolut Flexible Cash Funds GBP (Fidelity ILF)',
  IE000AZVL3K0: 'Revolut Flexible Cash Funds EUR (Fidelity ILF)',
  IE000H9J0QX4: 'Revolut Flexible Cash Funds USD (Fidelity ILF)',
  TEUR: 'TEUR (with its blocked part TEUR2)',
};
// Russian funds in the price chart's header (no securities row; "Earned by asset" keeps the tickers)
const MP_FUND_NAMES_RU = {
  TLCB: 'Т-Капитал Локальные валютные облигации', TBRU: 'Т-Капитал Российские облигации', TDIV: 'Т-Капитал Дивидендные акции',
  TGLD: 'Т-Капитал Золото', TMON: 'Т-Капитал Денежный рынок', TMOS: 'Т-Капитал Индекс МосБиржи', TOFZ: 'Т-Капитал ОФЗ',
  TRND: 'Т-Капитал Трендовые акции', TUSD: 'Т-Капитал Вечный портфель (USD)', TBIO: 'Т-Капитал БиоТех', TSOX: 'Т-Капитал Полупроводники',
  TSPX: 'Т-Капитал США 50', AKFN: 'Альфа Индекс финансов', AKGP: 'Альфа Управляемые валютные облигации', AKMB: 'Альфа Управляемые облигации',
  AKME: 'Альфа Управляемые акции', AKMM: 'Альфа Денежный рынок', AMNY: 'АТОН Накопительный в юанях',
  SAFE: 'Сбер Консервативный', SBBY: 'Сбер Инструменты в юанях', SBMM: 'Сбер Сберегательный',
  T: 'Т-Технологии',   // not AT&T (the funds' lists' T): the MOEX one, bought in roubles
};
// Blocked securities (price_freezes: worth 0 from the day they froze) get a
// "(blocked)" mark, so a -100% reads as frozen, not sold.
let mpFrozenTickers = null;
async function mpLoadFrozen() {
  if (mpFrozenTickers) return mpFrozenTickers;
  const { data } = await sb.from('price_freezes').select('ticker');
  mpFrozenTickers = new Set((data || []).map(r => String(r.ticker).toUpperCase()));
  return mpFrozenTickers;
}
async function mpBondNames(tickers) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('mp_bond_names') || '{}'); } catch { /* no storage */ }
  const want = [...new Set(tickers.filter(t => MP_BOND_RE.test(t) && !cache[t]))];
  const iss = 'https://iss.moex.com/iss';
  const put = (rows, cols) => {
    for (const r of rows) {
      const o = Object.fromEntries(cols.map((c, i) => [c.toLowerCase(), r[i]]));
      const name = o.secname || o.name || o.shortname;
      if (!name) continue;
      for (const k of [o.secid, o.isin]) if (k && want.includes(k) && !cache[k]) cache[k] = name;
    }
  };
  try {
    for (let i = 0; i < want.length; i += 50) {
      const r = await fetch(`${iss}/engines/stock/markets/bonds/securities.json?iss.meta=off&iss.only=securities`
        + `&securities.columns=SECID,ISIN,SECNAME&securities=${want.slice(i, i + 50).join(',')}`);
      const j = await r.json();
      put(j.securities.data, j.securities.columns);
    }
    for (const t of want.filter(t => !cache[t])) {
      const r = await fetch(`${iss}/securities.json?iss.meta=off&iss.only=securities&securities.columns=secid,isin,name&q=${t}`);
      const j = await r.json();
      put(j.securities.data, j.securities.columns);
    }
  } catch { /* MOEX unreachable: the codes stay */ }
  try { localStorage.setItem('mp_bond_names', JSON.stringify(cache)); } catch { /* no storage */ }
  return cache;
}
// XIRR of an asset over the period: the yearly return of its own money flows
// -- its value at the start put in on the period's first day (or its first
// buy), each put-in / taken-out on its day, its value at the end taken out on
// the last day (or its last sale). A savings account / deposit has it from a
// day held (opened for a month: does it pay what was promised?); anything
// whose price moves needs 30 days (a week's +1% is "+70% a year").
function mpAssetXirr(r, from, to) {
  // dollars on the exchanges are money passing through (in for days, then into
  // a coin): a rouble's move over those days, made yearly, says nothing
  if (r.asset === 'USD' || r.region === 'crypto' || r.asset === MP_KIND_REGION_LABELS['liquid|crypto']) return null;
  const cash = (r.cash || []).map(([d, v]) => [String(d).slice(0, 10), Number(v)]);
  const v0 = Number(r.value_start), v1 = Number(r.value_end);
  const flows = [];
  if (v0 > 0) flows.push([from, -v0]);
  for (const [d, v] of cash) flows.push([d, -v]);   // put in: money out of the pocket
  const last = v1 > 0 ? to : (cash.length ? cash[cash.length - 1][0] : to);
  if (v1 > 0) flows.push([to, v1]);
  if (flows.length < 2 && !(flows.length === 1 && flows[0][1] < 0)) return null;
  // nothing ever came back (blocked, worth 0; written off): all of it lost
  if (flows.every(([, v]) => v <= 0) && flows.some(([, v]) => v < 0)) return -100;
  const t0 = Date.parse(flows[0][0]);
  const minDays = /^(SAVINGS|DEPOSIT|ВКЛАД):/i.test(r.asset) || ['deposit', 'liquid'].includes(r.kind) ? 1 : 30;
  if ((Date.parse(last) - t0) / 86400000 < minDays) return null;
  const yrs = flows.map(([d]) => (Date.parse(d) - t0) / (365 * 86400000));
  const npv = rate => flows.reduce((s, [, v], i) => s + v / Math.pow(1 + rate, yrs[i]), 0);
  let lo = -0.99, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (fm * flo > 0) { lo = mid; flo = fm; } else { hi = mid; }
  }
  return ((lo + hi) / 2) * 100;
}
// The assets summed by type (stock, bond, deposit, liquid, cash, gold,
// crypto): money summed, the money flows merged by day, and the % worked out
// the way investment_by_asset does it -- over the capital at work averaged
// over the days something was held, but never less than what's in at the end.
// Groups: shares and liquid assets Russian / foreign, bonds in roubles /
// yuan, an exchange's dollars as liquid crypto; deposits, gold, crypto whole.
const MP_KIND_REGION_LABELS = {
  'stock|ru': 'stock 📈 🇷🇺', 'stock|foreign': 'stock 📈 🌍',
  'bond|ru': 'bond 🏛️ 🇷🇺', 'bond|cny': 'bond 🏛️ 🇨🇳',
  'liquid|ru': 'liquid assets 💧 🇷🇺', 'liquid|foreign': 'liquid assets 💧 🌍', 'liquid|crypto': 'liquid assets 💧 ₿',
  deposit: 'deposit 🏦 🇷🇺',
};
function mpKindKey(r) {
  const k = r.kind || 'stock';
  if (k === 'stock') return `stock|${r.region === 'ru' ? 'ru' : 'foreign'}`;
  if (k === 'bond') return `bond|${r.region === 'cny' ? 'cny' : 'ru'}`;
  if (k === 'liquid') return `liquid|${r.region === 'crypto' ? 'crypto' : r.region === 'foreign' ? 'foreign' : 'ru'}`;
  return k;
}
function mpGroupAssetsByKind(rows, from, to, keyOf = mpKindKey) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k) || { kind: k, assets: [], accts: new Set(), value_start: 0, value_end: 0, put_in: 0, taken_out: 0, income: 0, earned: 0, flows: new Map() };
    g.assets.push(r.asset);
    for (const a of String(r.accounts || '').split(/,\s*/).filter(Boolean)) g.accts.add(a);
    for (const c of ['value_start', 'value_end', 'put_in', 'taken_out', 'income', 'earned']) g[c] += Number(r[c]) || 0;
    for (const [d, v] of r.cash || []) { const day = String(d).slice(0, 10); g.flows.set(day, (g.flows.get(day) || 0) + Number(v)); }
    groups.set(k, g);
  }
  return [...groups.values()].map(g => {
    const cash = [...g.flows].sort((a, b) => a[0].localeCompare(b[0]));
    const s = g.value_start > 0 ? from : (cash[0]?.[0] ?? from);
    const e = g.value_end > 0 ? to : (cash[cash.length - 1]?.[0] ?? to);
    const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
    let cap = g.value_start, w = 0, len = 0, putIn = g.value_start;
    let at = s;
    for (const [d, v] of cash) {
      if (d > e) break;
      const l = Math.max(days(at, d), 0);
      if (cap > 0 && l > 0) { w += cap * l; len += l; }
      cap += v; if (v > 0) putIn += v; at = d;
    }
    const l = Math.max(days(at, e), 0);
    if (cap > 0 && l > 0) { w += cap * l; len += l; }
    const finalIn = g.value_start + cash.reduce((t, [, v]) => t + v, 0);
    const base = Math.max(len > 0 ? w / len : putIn, finalIn);
    return {
      asset: MP_KIND_REGION_LABELS[g.kind] || MP_ASSET_CLASS_LABELS[g.kind] || g.kind, accounts: keyOf === mpKindKey ? `${g.assets.length} assets` : [...g.accts].join(', '),
      members: g.assets,
      value_start: g.value_start, value_end: g.value_end, put_in: g.put_in, taken_out: g.taken_out, income: g.income,
      earned: g.earned, pct: base > 0 ? g.earned / base * 100 : null, cash, kind: g.kind.split('|')[0],
    };
  });
}
// What each asset earned over the chart's period (investment_by_asset, migration 062).
let mpInvestedAssetsTimer = null, mpInvestedAssetsKey = '', mpInvestedAssetsRows = null;
function mpInvestedAssetsSoon() {
  clearTimeout(mpInvestedAssetsTimer);
  mpInvestedAssetsTimer = setTimeout(() => mpRenderInvestedAssets(), 300);
}
async function mpRenderInvestedAssets() {
  const el = document.getElementById('plot_invested_assets');
  const status = document.getElementById('invested_by_status');
  const chart = document.getElementById('plot_capital_invested');
  if (!mpInvestedRows?.length) return;
  const days = mpInvestedRows.map(r => r.day);
  const range = chart.layout?.xaxis?.range ?? null;
  const clamp = d => (d < days[0] ? days[0] : d > days[days.length - 1] ? days[days.length - 1] : d);
  const from = clamp(document.getElementById('invested_from').value || (range ? String(range[0]).slice(0, 10) : days[0]));
  const to = clamp(range ? String(range[1]).slice(0, 10) : days[days.length - 1]);
  const ccy = document.getElementById('invested_ccy').value === 'RUB' ? 'RUB' : 'USD';
  const mode = ['money', 'xirr', 'contrib', 'xirrp'].includes(document.getElementById('invested_by_mode').value) ? document.getElementById('invested_by_mode').value : 'pct';
  document.getElementById('invested_by_period').textContent = `${from} → ${to}`;
  const key = `${from}|${to}|${ccy}`;
  if (key !== mpInvestedAssetsKey) {
    status.textContent = 'Loading…';
    const { data, error } = await sb.rpc('investment_by_asset', { p_from: from, p_to: to, p_ccy: ccy });
    if (error) { status.textContent = error.message; return; }
    // blocked securities are left out, as on the portfolio map: their loss from the freeze isn't a choice
    const frozenNow = await mpLoadFrozen();
    mpInvestedAssetsKey = key;
    mpInvestedAssetsRows = data.filter(r => !frozenNow.has(String(r.asset).toUpperCase()));
  }
  status.textContent = '';
  const group = document.getElementById('invested_by_group').value === 'type' ? 'type' : 'asset';
  // contribution: over the capital at work of all the assets together (dividends out of it, the buys they paid back in)
  const cap = window.mpPortfolioCapital ? window.mpPortfolioCapital(mpInvestedAssetsRows, from, to) : 0;
  // amounts come in the currency shown, each at its own day's rate (migration 070)
  const conv = (_day, v) => v;
  const fmtMoney = v => (ccy === 'RUB' ? `${Math.round(v).toLocaleString('en-US')} ₽` : `$${Math.round(v).toLocaleString('en-US')}`);
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
  const irr = r => { const g = window.mpPeriodIrr ? window.mpPeriodIrr(r, from, to) : null; return g == null ? null : g * 100; };
  // merge funds (the box, on by default): the funds of one index as one row -- VWRA and VWCE, one fund in
  // dollars and in euros, are "FTSE All-World funds" -- their money summed and their flows merged by day
  const mergeFunds = document.getElementById('invested_merge_funds').checked;
  const fundGroupOf = new Map(Object.entries(window.mpFundIndexGroups || {}).flatMap(([g, ts]) => ts.map(t => [t, g])));
  const byAsset = () => {
    if (!mergeFunds) return mpInvestedAssetsRows;
    const merged = mpInvestedAssetsRows.filter(r => fundGroupOf.has(String(r.asset).toUpperCase()));
    const counts = new Map(); for (const r of merged) { const g = fundGroupOf.get(String(r.asset).toUpperCase()); counts.set(g, (counts.get(g) || 0) + 1); }
    const many = merged.filter(r => counts.get(fundGroupOf.get(String(r.asset).toUpperCase())) > 1);
    if (!many.length) return mpInvestedAssetsRows;
    const groups = mpGroupAssetsByKind(many, from, to, r => fundGroupOf.get(String(r.asset).toUpperCase()));
    // the group's name, its biggest fund first (the price chart's ticker, the others with it)
    for (const g of groups) { g.name = g.asset = g.kind; g.members = [...g.members].sort((a, b) => Number(many.find(r => r.asset === b).value_end) - Number(many.find(r => r.asset === a).value_end)); }
    return [...mpInvestedAssetsRows.filter(r => !many.includes(r)), ...groups];
  };
  const rows = (group === 'type' ? mpGroupAssetsByKind(mpInvestedAssetsRows, from, to) : byAsset())
    .map(r => ({ ...r, money: conv(to, Number(r.earned)), pctv: r.pct == null ? null : Number(r.pct), xirr: mpAssetXirr(r, from, to),
      contrib: cap > 0 ? Number(r.earned) / cap * 100 : null, xirrp: irr(r) }))
    .map(r => ({ ...r, v: mode === 'money' ? r.money : mode === 'pct' ? r.pctv : r[mode] }))
    .filter(r => r.v != null)
    .sort((a, b) => a.v - b.v);   // biggest on top
  if (!rows.length) { status.textContent = 'Nothing held in this period.'; Plotly.purge(el); return; }
  const names = { ...MP_ASSET_NAMES, ...await mpBondNames(rows.map(r => r.asset)) };
  const frozen = await mpLoadFrozen();
  // the mark after the name: the labels are right-aligned, so the marks line up by the bars
  // funds not merged: by their tickers (VWRA, VWCE -- their names would differ only by the currency)
  const nameOf = r => (!mergeFunds && fundGroupOf.has(String(r.asset).toUpperCase()) ? null : names[r.asset]);
  const label = r => `${nameOf(r) || r.asset}${frozen.has(r.asset) ? ' (blocked)' : ''}${MP_ASSET_MARKS[r.asset] ? ' ' + MP_ASSET_MARKS[r.asset] : ''}`;
  const x = rows.map(r => r.v);
  // every asset, also one with no % (nothing at the start, nothing put in)
  const total = mpInvestedAssetsRows.reduce((t, r) => t + conv(to, Number(r.earned)), 0);
  const pctText = (v, unit = '%') => signed(v, a => `${a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)}${unit}`);
  const orDash = (v, unit) => (v == null ? '—' : pctText(v, unit));
  const trace = {
    type: 'bar', orientation: 'h', y: rows.map(label), x,
    marker: { color: x.map(v => (v >= 0 ? '#3fb950' : '#f85149')) },
    text: rows.map(r => (mode === 'money' ? signed(r.money, fmtMoney) : pctText(r.v, mode === 'contrib' ? ' pp' : '%'))),
    textposition: 'outside', cliponaxis: false, constraintext: 'none', textfont: { size: 11 },
    customdata: rows.map(r => [r.accounts, signed(r.money, fmtMoney), r.pctv == null ? '—' : pctText(r.pctv),
      fmtMoney(conv(from, Number(r.value_start))), fmtMoney(conv(to, Number(r.value_end))),
      fmtMoney(conv(to, Number(r.put_in))), fmtMoney(conv(to, Number(r.taken_out))), fmtMoney(conv(to, Number(r.income))),
      nameOf(r) ? ` · ${r.asset}` : '', r.xirr == null ? '—' : `${pctText(r.xirr)} a year`,
      r.pctv ? fmtMoney(r.money / (r.pctv / 100)) : '—', orDash(r.contrib, ' pp'), orDash(r.xirrp)]),
    hovertemplate: '<b>%{y}</b>%{customdata[8]} (%{customdata[0]})<br>earned %{customdata[1]}<br>'
      + 'contribution %{customdata[11]} · MWR %{customdata[12]} · XIRR %{customdata[9]}<br>dividends kept %{customdata[2]}<br>'
      + 'value %{customdata[3]} → %{customdata[4]}<br>put in %{customdata[5]}, taken out %{customdata[6]}<br>'
      + 'of which dividends / coupons / interest %{customdata[7]}<br>dividends kept is over the capital at work on average: %{customdata[10]}<extra></extra>',
  };
  // the height follows the rows: a few groups get a short chart, not fat bars
  const height = Math.max(160, rows.length * 24 + 90);
  el.style.height = `${height}px`;
  await Plotly.react(el, [trace], Object.assign({}, LAYOUT_BASE, {
    title: { text: `earned in all: ${signed(total, fmtMoney)}${cap > 0 ? ` · ${pctText(total / cap * 100)} on ${fmtMoney(cap)} at work on average` : ''}`, font: { size: 13 } },
    height, margin: { l: 230, r: 70, t: 40, b: 40 }, showlegend: false, bargap: 0.35, hovermode: 'closest',
    xaxis: Object.assign({}, LAYOUT_BASE.xaxis, { type: 'linear', dtick: undefined, tickformat: undefined, tickangle: 0, zeroline: true, zerolinecolor: '#30363d',
      ticksuffix: mode === 'money' ? '' : mode === 'contrib' ? ' pp' : '%', tickprefix: mode === 'money' && ccy === 'USD' ? '$' : '' }),
    yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { type: 'category', automargin: true, tickfont: { size: 11 }, dtick: 1 }),
  }), CONFIG);
  // an asset's name or bar: its price chart (not the groups of the "type" view)
  if (group === 'asset') {
    // a merged fund group: its biggest fund's price, the deals of all of them
    const byLabel = new Map(rows.map(r => [label(r), r.members ? { a: r.members[0], also: r.members.slice(1) } : { a: r.asset, also: [] }]));
    const open = (x, title) => mpOpenPriceDialog(x.a, title, { also: x.also });
    el.removeAllListeners?.('plotly_click');
    el.on('plotly_click', ev => { const x = byLabel.get(ev.points?.[0]?.y); if (x) open(x, ev.points[0].y); });
    el.querySelectorAll('.yaxislayer-above .ytick text').forEach(t => {
      const x = byLabel.get(t.textContent);
      if (!x) return;
      t.style.cursor = 'pointer';
      t.style.pointerEvents = 'all';
      t.onclick = () => open(x, t.textContent);
    });
  }
}


try { const v = localStorage.getItem('mp_invested_by_mode'); if (v) document.getElementById('invested_by_mode').value = v; } catch { /* no storage */ }
// a mode no longer offered (TWR, taken out): the first one
if (document.getElementById('invested_by_mode').selectedIndex < 0) document.getElementById('invested_by_mode').selectedIndex = 0;
try { const v = localStorage.getItem('mp_invested_by_group'); if (v) document.getElementById('invested_by_group').value = v; } catch { /* no storage */ }
try { const v = localStorage.getItem('mp_invested_merge_funds'); if (v) document.getElementById('invested_merge_funds').checked = v !== '0'; } catch { /* no storage */ }
document.getElementById('invested_merge_funds').addEventListener('change', e => {
  mpSave('mp_invested_merge_funds', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderInvestedAssets();
});
document.getElementById('invested_by_group').addEventListener('change', e => {
  mpSave('mp_invested_by_group', e.target.value);
  if (mpIsSignedIn) mpRenderInvestedAssets();
});
document.getElementById('invested_by_mode').addEventListener('change', e => {
  mpSave('mp_invested_by_mode', e.target.value);
  if (mpIsSignedIn) mpRenderInvestedAssets();
});
try { const v = localStorage.getItem('mp_invested_from'); if (v) document.getElementById('invested_from').value = v; } catch { /* no storage */ }
document.getElementById('invested_from').addEventListener('change', e => {
  mpSave('mp_invested_from', e.target.value);
  if (mpIsSignedIn) mpRenderInvested();
});
document.getElementById('invested_from_clear').addEventListener('click', () => {
  document.getElementById('invested_from').value = '';
  try { localStorage.removeItem('mp_invested_from'); } catch { /* no storage */ }
  if (mpIsSignedIn) mpRenderInvested();
});
// The period's last day: the zoom of the charts ends there (empty: the latest day).
try { const v = localStorage.getItem('mp_invested_to'); if (v) document.getElementById('invested_to').value = v; } catch { /* no storage */ }
document.getElementById('invested_to').addEventListener('change', e => {
  const to = e.target.value;
  try { if (to) localStorage.setItem('mp_invested_to', to); else localStorage.removeItem('mp_invested_to'); } catch { /* no storage */ }
  const el = document.getElementById('plot_capital_invested');
  if (!mpIsSignedIn || !mpInvestedRows?.length) return;
  const days = mpInvestedRows.map(r => r.day);
  const range = el.layout?.xaxis?.range;
  const from = document.getElementById('invested_from').value || (range ? String(range[0]).slice(0, 10) : days[0]);
  Plotly.relayout(el, { 'xaxis.range': [from, to || days[days.length - 1]] });
});
// The first transaction: the first day anything was put in or held.
document.getElementById('invested_from_first').addEventListener('click', async () => {
  if (!mpIsSignedIn) return;
  if (!mpInvestedRows) await mpRenderInvested();
  const first = (mpInvestedRows || []).find(r => Number(r.invested_usd) !== 0 || Number(r.value_usd) !== 0);
  if (!first) return;
  document.getElementById('invested_from').value = first.day;
  mpSave('mp_invested_from', first.day);
  mpRenderInvested();
});
// The Snowball portfolio's first deal: its "all time" profit counts from here.
const MP_SNOWBALL_START = '2025-08-28';
document.getElementById('invested_from_snowball').addEventListener('click', () => {
  document.getElementById('invested_from').value = MP_SNOWBALL_START;
  mpSave('mp_invested_from', MP_SNOWBALL_START);
  if (mpIsSignedIn) mpRenderInvested();
});
// The period buttons over "Earned by asset", as the Look-through's: the day
// counted from set to the period's start (as js/lookthrough_treemap.js's
// periodStart: the same day N days / months back, YTD from the last day of
// the year before), the end back to the latest day.
function mpInvestedPeriodStart(period, today) {
  const dt = new Date(`${today}T00:00:00Z`);
  const back = days => { const d = new Date(dt); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
  const months = n => {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() - n, last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(dt.getUTCDate(), last))).toISOString().slice(0, 10);
  };
  return { '1d': back(1), '2d': back(2), '3d': back(3), '4d': back(4), '7d': back(7), '1m': months(1), '3m': months(3), '6m': months(6),
    '1y': months(12), '5y': months(60), ytd: `${today.slice(0, 4) - 1}-12-31`, snowball: MP_SNOWBALL_START }[period] ?? null;
}
function mpMarkInvestedPeriod(period) {
  document.querySelectorAll('#invested_periods [data-period]').forEach(b => b.classList.toggle('primary', b.dataset.period === period));
  try { if (period) localStorage.setItem('mp_invested_period', period); else localStorage.removeItem('mp_invested_period'); } catch { /* no storage */ }
}
for (const b of document.querySelectorAll('#invested_periods [data-period]')) {
  b.addEventListener('click', async () => {
    const period = b.dataset.period;
    document.getElementById('invested_to').value = '';
    try { localStorage.removeItem('mp_invested_to'); } catch { /* no storage */ }
    if (period === 'all') {
      // the first transaction, as "from the period start"
      document.getElementById('invested_from_first').click();
    } else {
      const from = mpInvestedPeriodStart(period, new Date().toISOString().slice(0, 10));
      document.getElementById('invested_from').value = from;
      mpSave('mp_invested_from', from);
      if (mpIsSignedIn) mpRenderInvested();
    }
    mpMarkInvestedPeriod(period);
  });
}
// a day set by hand, or one of the other buttons: no period button stays lit
for (const id of ['invested_from', 'invested_to']) document.getElementById(id).addEventListener('change', () => mpMarkInvestedPeriod(null));
for (const id of ['invested_from_clear', 'invested_from_first', 'invested_from_snowball'])
  document.getElementById(id).addEventListener('click', () => mpMarkInvestedPeriod(id === 'invested_from_snowball' ? 'snowball' : null));
try { const v = localStorage.getItem('mp_invested_period'); if (v) mpMarkInvestedPeriod(v); } catch { /* no storage */ }
try { const v = localStorage.getItem('mp_invested_ccy'); if (v) document.getElementById('invested_ccy').value = v; } catch { /* no storage */ }
document.getElementById('invested_ccy').addEventListener('change', e => {
  mpSave('mp_invested_ccy', e.target.value);
  if (mpIsSignedIn) mpRenderInvested();
});
