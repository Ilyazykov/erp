// The Charts tab's pies: slice colours, plain pies and pies against target weights.

// ---- Charts tab: pies built from the same rows as the My Portfolio tables ----
const MP_PIE_COLORS = ['#4a9ff5', '#7fd351', '#8e8e8e', '#f0c040', '#e8452c', '#c2307a', '#6fc0f8', '#a86ee8',
  '#3dd6b5', '#f08a3c', '#9aa5b1', '#e05287', '#5b6ee1', '#b8d44a'];
// ---- Slice colours: brand / association colours, the same thing the same
// colour on every chart. ----
const MP_OTHER_COLOR = '#4a5563';
const MP_SECTOR_COLORS = {
  Financials: '#f08a3c', Industrials: '#f5c542', 'Health Care': '#9b5de5', 'Information Technology': '#3a9bf7',
  'Communication Services': '#4cb86a', 'Consumer Discretionary': '#f29bd0', 'Consumer Staples': '#4fd1c5',
  Energy: '#e8574d', Materials: '#8e8e93', Utilities: '#b9b4f5', 'Real Estate': '#f7b6d8', Unclassified: '#5c6470',
};
const MP_COLORS = {
  // currencies & coins
  currency: {
    USD: '#86e04a', EUR: '#3a9bf7', RUB: '#8e8e93', GBP: '#f2452b', CNY: '#d42a7a', JPY: '#ff7eb6', TRY: '#ff6a13',
    RSD: '#4f7dff', GEL: '#00aeef', CHF: '#e3242b', CAD: '#ff8a80', TWD: '#3d6bff', KRW: '#6fa8ff', HKD: '#ff6f61', AUD: '#ffd000',
    INR: '#ff9933', BRL: '#00c853', ZAR: '#7cd322', SGD: '#ff5c5c', SAR: '#00a86b', ILS: '#3f8cff', MXN: '#00b86b',
    AED: '#c08457', MYR: '#5a78ff',
    XAU: '#f5c542', BTC: '#ff7a1a', ETH: '#9b6bff', SOL: '#00d9a3', GRAM: '#29b6f6', TON: '#29b6f6', TAO: '#c3c9d1',
  },
  broker: {
    Freedom24: '#00d1b2', 'Bank of Cyprus': '#4fc3f7', Revolut: '#8e8e93', Wise: '#9fe870', Raiffeisen: '#c9a400',
    UniCredit: '#8c1c28', 'Credo Bank': '#e8562a', 'TBC Bank': '#00aeef', 'Ziraat Bank': '#ff1f2d', IBKR: '#a64dff', Sber: '#4fd05b', 'T-Bank': '#ffdd2d',
    'Ozon Bank': '#1f6bff', Alfa: '#ff2d2d', 'Yandex Bank': '#ff6a1f', Finuslugi: '#00b4ff', Telegram: '#29b6f6',
    Binance: '#b5651d', Bybit: '#ff9500', 'Crypto.com': '#1a5fb4', Trust: '#3b8cff', cash: '#86e04a',
    '(unspecified)': '#7b8494',
  },
  // asset types (liquid assets the same grey as deposits, as asked)
  type: {
    bond: '#3a9bf7', cash: '#86e04a', cushion: '#2bb5a8', deposit: '#8e8e93', liquid: '#8e8e93', gold: '#f5c542', crypto: '#f2452b',
    stock: '#d6307f', real_estate: '#e0864a',
  },
  // countries: those whose currency is on chart 1 in that colour; EU states in blues
  country: {
    US: '#86e04a', GB: '#f2452b', CN: '#d42a7a', JP: '#ff7eb6', RU: '#8e8e93', TR: '#ff6a13', RS: '#4f7dff',
    CH: '#e3242b', CA: '#ff8a80', TW: '#3d6bff', KR: '#6fa8ff', HK: '#ff6f61', AU: '#ffd000', IN: '#ff9933',
    BR: '#00c853', ZA: '#7cd322', SG: '#ff5c5c', SA: '#00a86b', IL: '#3f8cff', MX: '#00b86b', AE: '#c08457',
    NO: '#ff4d6d', EU: '#3a9bf7',
    FR: '#3a9bf7', DE: '#1a5fd6', NL: '#5c9dff', ES: '#2e6ef0', IT: '#7ab3ff', SE: '#4a8cff', DK: '#1f66e8',
    FI: '#94c2ff', BE: '#2a57c9', IE: '#66a3ff', AT: '#3f78f0', PT: '#a3c8ff', PL: '#1d4fbf', LU: '#5a85e6',
  },
};
function mpSliceColor(label, colorOf) {
  if (/^other\b/.test(label)) return MP_OTHER_COLOR;
  const c = colorOf(label);
  if (c) return c;
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return MP_PIE_COLORS[h % MP_PIE_COLORS.length];
}

const MP_EU_MEMBERS = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const mpFlagOf = code => (/^[A-Z]{2}$/.test(code || '') && code !== 'XX'
  ? String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0))) : '🌍');

// `order`: slice labels in the order they go round from 12 o'clock
// clockwise (the user's own charts); anything not listed follows, largest
// first, and the small-slices "other" goes last.
// smallGroupOf (optional): label -> group number, to list the "other"
// slice's contents group by group (currencies before crypto), each largest first.
// colorOf (optional): label -> colour (MP_COLORS); anything it doesn't
// know gets a stable colour from the fallback palette; "other" is always
// the same neutral grey.
// breakdown (optional): label -> {part: USD} -- a slice made of parts (EU
// -> its member states), listed largest first on hover and under the chart.
// chartOf (optional): label -> [asset, title, opts] for mpOpenPriceDialog -- a click on the slice opens it.
function mpPie(el, title, buckets, note = '', order = null, groupSmall = true, smallGroupOf = () => 0, colorOf = () => null,
  breakdown = {}, chartOf = null) {
  const card = document.createElement('div');
  card.className = 'pie-card';
  card.innerHTML = `<h4>${mpEscapeHtml(title)}</h4><div class="pie-plot"></div><p class="pie-total"></p>`
    + `<p class="note pie-other" hidden></p>${note ? `<p class="note">${mpEscapeHtml(note)}</p>` : ''}`;
  el.appendChild(card);
  // (`order` may also be a function label -> rank number)
  const rank = k => (/^other\b/.test(k) ? 1e9 : typeof order === 'function' ? order(k)
    : order && order.includes(k) ? order.indexOf(k) : 1e6);
  let entries = Object.entries(buckets).filter(([, v]) => v > 0.005)
    .sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1] - a[1]));
  if (!entries.length) { card.querySelector('.pie-plot').innerHTML = '<p class="empty-note">No data.</p>'; return; }
  // Slices under 1% go into one "other" slice (what's in it shows on hover);
  // labels sit inside the slices big enough to hold them -- no outside
  // labels shrinking the pie.
  const total = entries.reduce((s, e) => s + e[1], 0);
  card.querySelector('.pie-total').innerHTML = `Total: <b>${mpFormatUsd(total)}</b>`;
  const small = entries.filter(e => e[1] / total < 0.01);
  if (groupSmall && small.length > 1) {
    entries = entries.filter(e => e[1] / total >= 0.01);
    const listed = [...small].sort((a, b) => (smallGroupOf(a[0]) - smallGroupOf(b[0])) || (b[1] - a[1]))
      .map(e => `${e[0]} ${(e[1] / total * 100).toFixed(2)}%`);
    // The hover box is clipped to the plot, so it lists the first dozen;
    // the full list goes under the chart.
    const HOVER_LINES = 12;
    entries.push(['other', small.reduce((s, e) => s + e[1], 0),
      [...listed.slice(0, HOVER_LINES), ...(listed.length > HOVER_LINES ? [`… +${listed.length - HOVER_LINES} more below`] : [])].join('<br>')]);
    const otherEl = card.querySelector('.pie-other');
    otherEl.textContent = 'other: ';
    // each one clickable when the chart opens its slices (chartOf): the same window as its own slice would
    const smallSorted = [...small].sort((a, b) => (smallGroupOf(a[0]) - smallGroupOf(b[0])) || (b[1] - a[1]));
    smallSorted.forEach((e, i) => {
      const what = chartOf ? chartOf(e[0]) : null;
      const el = document.createElement(what ? 'a' : 'span');
      el.textContent = `${e[0]} ${(e[1] / total * 100).toFixed(2)}%`;
      if (what) { el.href = '#'; el.style.cssText = 'color:inherit;text-decoration:underline dotted;cursor:pointer'; el.onclick = ev => { ev.preventDefault(); mpOpenPriceDialog(...what); }; }
      otherEl.append(el, i < smallSorted.length - 1 ? ', ' : '');
    });
    otherEl.hidden = false;
  }
  for (const e of entries) {
    const parts = breakdown[e[0]];
    if (!parts) continue;
    const listed = Object.entries(parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / total * 100).toFixed(2)}%`);
    e[2] = [...listed.slice(0, 12), ...(listed.length > 12 ? [`… +${listed.length - 12} more below`] : [])].join('<br>');
    const line = document.createElement('p');
    line.className = 'note';
    line.textContent = `${e[0]}: ${listed.join(', ')}`;
    card.querySelector('.pie-other').before(line);
  }
  Plotly.newPlot(card.querySelector('.pie-plot'), [{
    type: 'pie', labels: entries.map(e => e[0]), values: entries.map(e => e[1]), sort: false, direction: 'clockwise',
    text: entries.map(e => (e[1] / total >= 0.035 ? `${e[0]}<br>${(e[1] / total * 100).toFixed(1)}%` : '')),
    textinfo: 'text', textposition: 'inside', insidetextorientation: 'horizontal',
    customdata: entries.map(e => e[2] || ''),
    marker: { colors: entries.map(e => mpSliceColor(e[0], colorOf)), line: { color: '#0d1117', width: 1 } },
    hovertemplate: '%{label}<br>$%{value:,.0f} - %{percent}<br>%{customdata}<extra></extra>',
  }], {
    paper_bgcolor: '#13191f', plot_bgcolor: '#13191f', font: { size: 12 },   // inside labels: Plotly picks black / white per slice
    uniformtext: { minsize: 9, mode: 'hide' },
    showlegend: false, margin: { t: 10, b: 10, l: 10, r: 10 },
  }, { responsive: true, displayModeBar: false });
  const plot = card.querySelector('.pie-plot');
  if (chartOf && plot.on) {
    plot.on('plotly_click', ev => {
      const what = chartOf(ev.points?.[0]?.label);
      if (what) mpOpenPriceDialog(...what);
    });
  }
}

// A pie measured against target weights, drawn like the USD/RUB -> CNY
// Weight donuts (mpDrawTargetDonut): slice angle = actual share, radius =
// the dotted target circle plus (actual% - target%) -- bulging past it =
// overweight, short of it = underweight. items: [{label, usd, target (%), color}].
// Black or white text, whichever reads better on the colour.
function mpContrastText(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0d1117' : '#ffffff';
}
// Target shares are of today's total (a slice whose dollars don't move --
// deposits -- keeps its %); targetTotal (optional) is only shown, the sum
// of the dollar targets when it differs from today's total.
// shareOfTarget: show / draw each target as a share of targetTotal instead
// (chart 8: the US ERP 77.6% is of the target total).
// before (optional): {label: USD} before the salary plan -- the table then
// shows what the plan buys / sells per slice instead of the gap to target.
// money (optional): USD -> display string (chart 7 / 11 in roubles); USD otherwise.
// bought (optional, with `before`): [[what, USD]] -- the purchases listed
// under the table instead of a per-slice Bought / sold column (chart 5:
// what was bought -- VWRA, VWCE, single stocks -- not what each country got).
function mpTargetPie(el, title, items, note = '', targetTotal = null, shareOfTarget = false, before = null, money = null, bought = null) {
  const fmt = money || mpFormatUsd;
  const card = document.createElement('div');
  card.className = 'pie-card';
  card.innerHTML = `<h4>${mpEscapeHtml(title)}</h4><div class="pie-plot target"></div><p class="pie-total"></p>${note ? `<p class="note">${mpEscapeHtml(note)}</p>` : ''}`;
  el.appendChild(card);
  // (a slice the plan emptied -- sold off -- stays listed)
  const usable = items.filter(it => it.usd > 0 || it.target > 0 || (before && before[it.label] > 0));
  const total = usable.reduce((s, it) => s + Math.max(0, it.usd), 0);
  // Targets are % of this: the target total (shareOfTarget) or today's total.
  const base = shareOfTarget && targetTotal ? targetTotal : total;
  if (!total) { card.querySelector('.pie-plot').innerHTML = '<p class="empty-note">No data.</p>'; return; }
  card.querySelector('.pie-total').innerHTML = `Total: <b>${fmt(total)}</b>`
    // A target is never below what's there: only a real shortfall (> $1) is shown.
    + (targetTotal !== null && targetTotal - total > 1 ? ` / Target: <b>${fmt(targetTotal)}</b>` : '');
  // What each slice should be in dollars at its target share.
  const targets = document.createElement('table');
  targets.className = 'data-table';
  targets.style.cssText = 'width:auto;margin:0 auto 8px';
  // Without a salary: Now / Target. With one: Now (before the plan), what the
  // plan buys / sells, After (the chart's figures) and Target.
  const showDelta = before && !bought;
  targets.innerHTML = `<thead><tr><th></th><th>Now</th>${before ? `${showDelta ? '<th>Bought / sold</th>' : ''}<th>After</th>` : ''}<th>Target</th></tr></thead><tbody>${usable.map(it => {
    const want = it.target / 100 * base;
    const was = before ? (before[it.label] || 0) : Math.max(0, it.usd);
    const delta = before ? it.usd - was : 0;
    const deltaCell = Math.abs(delta) < 0.005 ? '<td class="muted">0</td>'
      : `<td class="${delta > 0 ? 'pos' : 'neg'}">${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}</td>`;
    return `<tr><td class="ticker">${mpEscapeHtml(it.label)}</td><td>${fmt(Math.max(0, was))}</td>
      ${before ? `${showDelta ? deltaCell : ''}<td>${fmt(Math.max(0, it.usd))}</td>` : ''}<td><b>${fmt(want)}</b></td></tr>`;
  }).join('')}${(() => {
    // Totals row.
    const nowSum = usable.reduce((a, it) => a + Math.max(0, before ? (before[it.label] || 0) : it.usd), 0);
    const afterSum = usable.reduce((a, it) => a + Math.max(0, it.usd), 0);
    const wantSum = usable.reduce((a, it) => a + it.target / 100 * base, 0);
    const d = afterSum - nowSum;
    const dCell = Math.abs(d) < 0.005 ? '<td class="muted">0</td>'
      : `<td class="${d > 0 ? 'pos' : 'neg'}"><b>${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}</b></td>`;
    return `<tr class="total-row"><td class="ticker"><b>Total</b></td><td><b>${fmt(nowSum)}</b></td>
      ${before ? `${showDelta ? dCell : ''}<td><b>${fmt(afterSum)}</b></td>` : ''}<td><b>${fmt(wantSum)}</b></td></tr>`;
  })()}</tbody>`;
  // (with `bought` -- even empty -- the per-slice table isn't shown: chart 5)
  if (!bought) card.querySelector('.pie-total').after(targets);
  if (before && bought && bought.length) {
    const list = document.createElement('table');
    list.className = 'data-table';
    list.style.cssText = 'width:auto;margin:0 auto 8px';
    list.innerHTML = `<thead><tr><th>Bought</th><th>USD</th></tr></thead><tbody>${bought.map(([what, usd]) =>
      `<tr><td class="ticker">${mpEscapeHtml(what)}</td><td class="${usd < 0 ? 'neg' : 'pos'}">${usd < 0 ? '−' : '+'}${fmt(Math.abs(usd))}</td></tr>`).join('')}
      ${(() => { const t = bought.reduce((a, [, v]) => a + v, 0);
        return `<tr class="total-row"><td class="ticker"><b>Total</b></td><td class="${t < 0 ? 'neg' : 'pos'}"><b>${t < 0 ? '−' : '+'}${fmt(Math.abs(t))}</b></td></tr>`; })()}</tbody>`;
    card.querySelector('.pie-total').after(list);
  }
  const R_BASE = 100;
  let cursor = 0;
  const rows = usable.map(it0 => {
    // the gold slice (chart 3's asset classes) opens gold's chart, its XAU and XAUT deals marked
    const it = !it0.chart && it0.label === MP_ASSET_CLASS_LABELS.gold ? { ...it0, chart: 'XAU', chartAlso: ['XAUT'] } : it0;
    const current = Math.max(0, it.usd) / total * 100;
    const wantUsd = it.target / 100 * base;
    const w = current / 100 * 360;
    // Radius from actual / target (slices over / under by the same proportion
    // stand out the same, whatever their size), softened by a square root so
    // a small slice 40% over bulges ~18%, not 40%; capped at 1.4x, where a
    // slice with a 0 target sits.
    const ratio = wantUsd > 0 ? Math.max(0, it.usd) / wantUsd : (it.usd > 0 ? Infinity : 1);
    const row = { ...it, current, theta: cursor + w / 2, width: w, r: R_BASE * Math.min(1.4, Math.sqrt(ratio)) };
    cursor += w;
    return row;
  });
  const maxR = Math.max(R_BASE, ...rows.map(r => r.r));
  const layout = mpDonutLayout(maxR);
  layout.paper_bgcolor = layout.plot_bgcolor = layout.polar.bgcolor = '#13191f';
  layout.showlegend = false;
  layout.margin = { t: 10, b: 10, l: 10, r: 10 };
  layout.polar.domain = { x: [0, 1], y: [0, 1] };
  layout.polar.radialaxis.range = [0, maxR * 1.03];   // fill the card, only a hair of room past the widest slice
  Plotly.newPlot(card.querySelector('.pie-plot'), [
    {
      type: 'barpolar', r: rows.map(r => r.r), theta: rows.map(r => r.theta), width: rows.map(r => r.width),
      marker: { color: rows.map(r => r.color), line: { color: '#0d1117', width: 1 } },
      // a slice's own line (item.hover) under, if any; the sums by `money` when given
      hovertemplate: rows.map(r => { const m = money ? money : v => `$${Math.round(v).toLocaleString('en-US')}`;
        return `${r.label}<br>${m(r.usd)} - ${r.current.toFixed(1)}%<br>target ${r.target.toFixed(1)}% = ${m(r.target / 100 * base)}`
          + `${r.hover ? `<br>${r.hover}` : ''}<extra></extra>`; }),
    },
    {
      type: 'scatterpolar', mode: 'lines', hoverinfo: 'skip',
      r: Array.from({ length: 73 }, () => R_BASE), theta: Array.from({ length: 73 }, (_, i) => i * 5),
      line: { color: '#e6edf3', width: 1.5, dash: 'dot' },
    },
    // Labels inside the slices, black or white by the slice's brightness (like the plain pies).
    {
      type: 'scatterpolar', mode: 'text', hoverinfo: 'skip',
      r: rows.map(r => r.r * 0.6), theta: rows.map(r => r.theta),
      text: rows.map(r => (r.width >= 25 ? `${r.label}<br>${r.current.toFixed(1)}% / ${r.target.toFixed(1)}%` : '')),
      textfont: { color: rows.map(r => mpContrastText(r.color)), size: 12 },
    },
  ], layout, { responsive: true, displayModeBar: false });
  // a slice whose item names an asset (item.chart, its other tickers item.chartAlso): its price chart on a click
  const plot = card.querySelector('.pie-plot');
  if (rows.some(r => r.chart) && plot.on) {
    plot.style.cursor = 'pointer';
    plot.on('plotly_click', ev => {
      const p = ev.points?.find(x => x.curveNumber === 0);
      const r = p && rows[p.pointNumber];
      if (r?.chart) mpOpenPriceDialog(r.chart, r.chart === 'XAU' ? 'Gold' : r.label, { also: r.chartAlso || [] });
    });
  }
}

const mpAdd =(acc, key, v) => { if (v) acc[key] = (acc[key] || 0) + v; return acc; };
// Credit-card debt isn't shown on its own: it's netted against liquid
// assets of the same infrastructure -- a Russian bank's card against the
// liquid assets held in Russian banks / brokers only, any other card
// against the rest -- spread over those holdings in proportion to their
// size (so no broker goes negative because of a card).
// mpIsRuInfra and mpNetCreditIntoLiquid: js/lookthrough_treemap.js (one copy), set on window by the module script below.
// Asset-type buckets (rows already credit-netted -- mpNetCreditIntoLiquid).
function mpAssetBuckets(rows, keep = null) {
  const b = {};
  for (const r of rows) if (r.value_usd) mpAdd(b, r.instrument_type, r.value_usd);
  return Object.fromEntries(Object.entries(b).filter(([k]) => !keep || keep.includes(k))
    .map(([k, v]) => [MP_ASSET_CLASS_LABELS[k] || k, v]));
}

