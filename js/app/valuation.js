// The valuation tabs (Sigmoid, RU ERP, Layer 2, US stocks, US ERP): data/*.csv
// and data/*.json read, the charts and donuts drawn, showTab and the tab bar.

const DATA_DIR = './data';

// 'no-cache', not 'no-store': the browser keeps the file and only asks
// whether it changed (a short 304 when not -- the data is rebuilt once a
// day) instead of downloading it all again on every load: ~2 MB at the
// ~20 KB/s GitHub Pages can give was minutes (01.11.2026).
async function fetchCsv(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  const text = await res.text();
  const lines = text.trim().split(/\r\n|\r|\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  return res.json();
}

function val(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function jsSeries(dates, values, name, color, opts) {
  opts = opts || {};
  return {
    x: dates, y: values, name: name,
    type: 'scatter', mode: 'lines',
    line: { color: color, dash: opts.dash || 'solid', width: opts.width || 2 },
    visible: opts.visible === false ? 'legendonly' : true,
    hovertemplate: '%{x|%Y-%m}<br>' + name + ': <b>%{y:.2f}</b><extra></extra>',
  };
}

// The area between the line and 0 on one side. Not the other side's points
// set to null: Plotly's 'tozeroy' joins the pieces across such gaps anyway
// (connectgaps or not) -- bands running diagonally across 0 (01.11.2026).
// So the other side is clipped to 0 instead, with a point added where the
// line crosses 0 (interpolated in time), so the fill's edge is the line's.
function erpFill(dates, values, above) {
  const x = [], yFill = [];
  const clip = v => (v === null ? null : above ? Math.max(v, 0) : Math.min(v, 0));
  for (let i = 0; i < values.length; i++) {
    const a = values[i - 1], b = values[i];
    if (i > 0 && a !== null && b !== null && (a > 0) !== (b > 0) && a !== 0 && b !== 0) {
      const t0 = Date.parse(dates[i - 1]), t1 = Date.parse(dates[i]);
      x.push(new Date(t0 + (t1 - t0) * a / (a - b)).toISOString().slice(0, 10));
      yFill.push(0);
    }
    x.push(dates[i]);
    yFill.push(clip(b));
  }
  return {
    x, y: yFill,
    fill: 'tozeroy',
    fillcolor: above ? 'rgba(61,214,140,0.12)' : 'rgba(224,82,82,0.12)',
    line: { width: 0 },
    mode: 'lines',
    showlegend: false,
    hoverinfo: 'skip',
    type: 'scatter',
    connectgaps: false,
  };
}

// Recomputes the Y range from only the data visible in the current X window
// whenever that window changes (zoom, pan, or range-slider drag) -- Plotly's
// yaxis.autorange only fits the FULL trace data on initial draw, so without
// this a chart spanning a century-plus of history (e.g. US ERP, 1871-2026)
// stays scaled to a rare historical outlier even after zooming into a recent
// decade with much smaller values.
function autoFitYOnXChange(divId, traces) {
  const el = document.getElementById(divId);
  let guard = false;
  let debounceTimer = null;
  // Precompute each point's timestamp once (rather than `new Date(...)` on
  // every relayout event) -- with ~150 years of monthly data across
  // several traces, re-parsing every x value on every rangeslider drag
  // event was the actual cause of the US ERP tab hanging/stuttering on
  // open: the rangeslider itself fires relayout events during its own
  // initialization, so this ran its full O(points) scan repeatedly before
  // the user even touched anything.
  const cachedTimes = traces.map(t => (t.x || []).map(x => new Date(x).getTime()));
  el.on('plotly_relayout', (ev) => {
    if (guard) return;
    const x0 = ev['xaxis.range[0]'] || (ev['xaxis.range'] && ev['xaxis.range'][0]);
    const x1 = ev['xaxis.range[1]'] || (ev['xaxis.range'] && ev['xaxis.range'][1]);
    if (!x0 || !x1) return; // not an x-range change (e.g. autosize, legend click)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const lo = new Date(x0).getTime();
      const hi = new Date(x1).getTime();
      let yMin = Infinity, yMax = -Infinity;
      traces.forEach((t, ti) => {
        if (!t.y) return;
        const times = cachedTimes[ti];
        for (let i = 0; i < times.length; i++) {
          const xt = times[i];
          const yv = t.y[i];
          if (yv === null || yv === undefined || xt < lo || xt > hi) continue;
          if (yv < yMin) yMin = yv;
          if (yv > yMax) yMax = yv;
        }
      });
      if (!isFinite(yMin) || !isFinite(yMax)) return;
      const pad = (yMax - yMin) * 0.08 || 1;
      guard = true;
      Plotly.relayout(divId, { 'yaxis.range': [yMin - pad, yMax + pad] }).then(() => { guard = false; });
    }, 60);
  });
}

// The yuan's target share -- set here only, every tab takes it (06.11.2026):
// the sigmoid of USD/RUB against its WIN-day average, sharpened by the
// rate's 90-day volatility; yuan are bought (wCnyTarget)
// only under the buy line, sold only over the sell one (06.11.2026: "the
// dollar's only 5 roubles down -- too early to buy back"): m -/+ LINE_SIGMA
// σ₉₀, both shifted down by what yuan cost against roubles over CARRY_DAYS
// -- the CBR's key rate less the PBoC's, of m (no hand-set asymmetry: the
// dearer roubles pay, the harder yuan are to buy and the easier to sell).
// Half of σ's 90 days: the rouble does weaken over time, by less than the
// rates' gap says (interest parity holds in part) -- so a part of the gap;
// in the test 45 days was as good as 90 or better, with lines closer to even.
// The lines won the walk-forward test (2015-2026, monthly) over trading
// toward the target every month; a ±10 pp band on the share as well added
// nothing over them and was dropped; the 2-year average was tried and turned
// down -- it wants more yuan when the rouble has been weakening for years.
const WCNY = { WIN: 365, LINE_SIGMA: 1.5, CARRY_DAYS: 45, K: 15, SIGMA_WIN: 90, SIGMA_REF: 0.0209, LO: 0.20, HI: 0.80 };
// today's x, m, sigma, carry (loadData sets it): the buy / sell lines
let wCnyNow = null;
const wCnyLines = (p = wCnyNow) => {
  if (!p) return null;
  const shift = p.m * (p.carry || 0) * WCNY.CARRY_DAYS / 365;
  return { buy: p.m - WCNY.LINE_SIGMA * p.sigma - shift, sell: p.m + WCNY.LINE_SIGMA * p.sigma - shift, shift };
};
function wCny(x, m) {
  return WCNY.LO + (WCNY.HI - WCNY.LO) / (1 + Math.exp(WCNY.K * (x - m) / m));
}

// Sensitivity amplified by volatility. sigma is the 90-day rolling std dev
// of the rate. At typical historical volatility (SIGMA_REF) this reduces to
// the same k as wCny() above; higher volatility steepens the curve, lower flattens it.
const SIGMA_REF = WCNY.SIGMA_REF;
function wCnyAmplified(x, m, sigma) {
  if (sigma === null || sigma === undefined) return wCny(x, m);
  const kEff = WCNY.K * (sigma / m) / SIGMA_REF;
  return WCNY.LO + (WCNY.HI - WCNY.LO) / (1 + Math.exp(kEff * (x - m) / m));
}

// The target over a history of daily rates: per day from the win-th on --
// x, m (the trailing win-day average), sigma (90-day), w (amplified), wPlain,
// carry (the key rate less the PBoC's that day, a fraction; carryAt(date))
function wCnySeries(dates, rates, win = WCNY.WIN, carryAt = () => 0) {
  const out = [];
  let sum = 0, sSum = 0, sSum2 = 0;
  for (let i = 0; i < rates.length; i++) {
    const x = rates[i];
    sum += x; sSum += x; sSum2 += x * x;
    if (i >= win) sum -= rates[i - win];
    if (i >= WCNY.SIGMA_WIN) { sSum -= rates[i - WCNY.SIGMA_WIN]; sSum2 -= rates[i - WCNY.SIGMA_WIN] ** 2; }
    if (i < win - 1) continue;
    const m = sum / win, sm = sSum / WCNY.SIGMA_WIN;
    const sigma = Math.sqrt(Math.max(sSum2 / WCNY.SIGMA_WIN - sm * sm, 0));
    out.push({ date: dates[i], x, m, sigma, w: wCnyAmplified(x, m, sigma), wPlain: wCny(x, m), carry: carryAt(dates[i]) });
  }
  return out;
}

// The yuan to hold, in money, given what's held now and the whole they're
// a part of: w of the whole -- up only with the dollar under the buy line,
// down only over the sell line -- else the yuan as they are (06.11.2026: new
// money, or a stock sale's, all into roubles then -- no yuan bought at all)
function wCnyTarget(w, cnyNow, total) {
  const t = w * total;
  const l = wCnyLines();
  if (l && t > cnyNow && !(wCnyNow.x < l.buy)) return Math.min(cnyNow, total);
  if (l && t < cnyNow && !(wCnyNow.x > l.sell)) return Math.min(cnyNow, total);
  return t;
}

const LAYOUT_BASE = {
  paper_bgcolor: '#0d1117',
  plot_bgcolor:  '#0d1117',
  font:  { color: '#c9d1d9', size: 11 },
  // getters: a fresh object for every chart. Plotly writes autorange and range into the axis it's given;
  // on a shared one that autorange reached every later chart and overrode the period it asked for
  get xaxis() { return { gridcolor: '#1e2830', linecolor: '#1e2830', tickformat: '%Y-%m', tickangle: -45, dtick: 'M3' }; },
  get yaxis() { return { gridcolor: '#1e2830', linecolor: '#1e2830' }; },
  legend: { bgcolor: '#13191f', bordercolor: '#1e2830', borderwidth: 1 },
  hovermode: 'x unified',
  hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
  margin: { t: 20, r: 20, b: 60, l: 50 },
  shapes: [],
};

function layoutWith(yaxisTitle, shapes) {
  return Object.assign({}, LAYOUT_BASE, {
    yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { title: yaxisTitle }),
    shapes: shapes || [],
  });
}

const HLINE = (y, color, dash) => ({
  type: 'line', xref: 'paper', x0: 0, x1: 1,
  y0: y, y1: y, line: { color, dash: dash || 'dash', width: 1 },
});

const CONFIG = { responsive: true, displayModeBar: true,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
  toImageButtonOptions: { format: 'png', scale: 2 } };

let DATA = null;
let mpIsSignedIn = false;
let mpIncOpen = new Set();
let rendered = {};
// US ERP's "from 2016": redraw the tab's charts with the period it sets
document.getElementById('us_erp_from2016').addEventListener('change', () => {
  if (DATA && rendered.userp) renderChart('userp');
});

function showTab(id) {
  // counted in the database for the user (tab_opens, migration ...184); a failed count doesn't matter
  if (mpIsSignedIn) sb.rpc('record_tab_open', { p_tab: id }).then(() => {}, () => {});
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === id);
  });
  document.querySelectorAll('.chart-wrap').forEach(el => {
    el.classList.toggle('active', el.id === id);
  });
  // Charts drawn while their tab was hidden have no width yet: size them now.
  if (id === 'charts') {
    if (mpChartsPending && mpIsSignedIn) mpRenderCharts();
    else document.querySelectorAll('#mp_charts_grid .pie-plot').forEach(el => { if (el.data) Plotly.Plots.resize(el); });
  }
  if (id === 'capital' && mpIsSignedIn) mpRenderCapital();
  if (id === 'capitalbrokers' && mpIsSignedIn) mpRenderCapitalBrokers();
  if (id === 'cryptostrat') mpRenderCryptoStrategy();
  if (id === 'maturities' && mpIsSignedIn) mpRenderMaturities();
  if (id === 'invested' && mpIsSignedIn) mpRenderInvested();
  if (id === 'expenses' && mpIsSignedIn) mpRenderExpenses();
  if (id === 'products' && mpIsSignedIn) { mpRenderProductList(); mpRenderApplePurchases(); }
  if (DATA && !rendered[id]) {
    rendered[id] = true;
    renderChart(id);
  }
  // The sigmoid tab is drawn on load while hidden (Plotly's 700px default):
  // fit every plot already drawn in the tab to its now visible width.
  document.querySelectorAll(`#${id} .js-plotly-plot`).forEach(el => Plotly.Plots.resize(el));
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => showTab(t.dataset.tab));
});

function renderChart(id) {
  if (id === 'layer2a') {
    Plotly.newPlot('plot_layer1', DATA.layer1,
      layoutWith('%, annualised', [HLINE(0, '#6a7381', 'dot')]), CONFIG);
    Plotly.newPlot('plot_layer2a', DATA.layer2_alloc,
      layoutWith('Z-score', [
        HLINE(0, '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5, '#e05252', 'dot'),
      ]), CONFIG);
    Plotly.newPlot('plot_alloc_target', DATA.allocTarget, DATA.allocTargetLayout, CONFIG);
    // the target split over time (calc_target_weights.py's history); none yet -- no chart
    if (DATA.ruAllocHistory.length) {
      Plotly.newPlot('plot_alloc_history', DATA.ruAllocHistory, Object.assign({}, LAYOUT_BASE, {
        xaxis: Object.assign({}, LAYOUT_BASE.xaxis, {
          type: 'date', tickformat: '%Y-%m', dtick: 'M6',
          rangeslider: { visible: true, thickness: 0.08 }, range: DATA.ruAllocHistoryRange,
        }),
        // 0-100%: the key rate took the share from ~92% (2021) to 0% (2025)
        yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { title: 'stocks, %', range: [0, 100], dtick: 10, ticksuffix: '%' }),
        hovermode: 'x unified',
      }), CONFIG);
    }
  } else if (id === 'layer2r') {
    Plotly.newPlot('plot_layer1i', DATA.layer1_individual,
      layoutWith('%, annualised', [HLINE(0, '#6a7381', 'dot')]), CONFIG);
    Plotly.newPlot('plot_rev_yield', DATA.revYield,
      layoutWith('Revenue Yield, %', [HLINE(0, '#6a7381', 'dot')]), CONFIG);
    Plotly.newPlot('plot_fcf_yield', DATA.fcfYield,
      layoutWith('FCF Yield, %', [HLINE(0, '#6a7381', 'dot')]), CONFIG);
    Plotly.newPlot('plot_vkco_revenue_v2', DATA.vkcoRevenueV2,
      Object.assign({}, LAYOUT_BASE, {
        yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { title: 'Revenue Yield, %' }),
        yaxis2: {
          title: 'Revenue, bln RUB', overlaying: 'y', side: 'right',
          gridcolor: '#1e2830', linecolor: '#1e2830', color: '#3dd68c',
        },
        shapes: [HLINE(0, '#6a7381', 'dot')],
      }), CONFIG);
    Plotly.newPlot('plot_layer2r', DATA.layer2_rebal,
      layoutWith('Z-score', [
        HLINE(0, '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5, '#e05252', 'dot'),
      ]), CONFIG);
    Plotly.newPlot('plot_targetweights', DATA.targetWeights, DATA.targetWeightsLayout, CONFIG);
    mpChartOnClick('plot_targetweights');
    Plotly.newPlot('plot_ru_sectors', DATA.ruSectors, DATA.ruSectorsLayout, CONFIG);
  } else if (id === 'usstocks') {
    Plotly.newPlot('plot_us_zscore', DATA.usZscore,
      layoutWith('Z-score', [
        HLINE(0, '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5, '#e05252', 'dot'),
      ]), CONFIG);
    Plotly.newPlot('plot_us_targetweights', DATA.usTargetWeights, DATA.usTargetWeightsLayout, CONFIG);
    mpChartOnClick('plot_us_targetweights');
    Plotly.newPlot('plot_us_sectors', DATA.usSectors, DATA.usSectorsLayout, CONFIG);
  } else if (id === 'userp') {
    // "from 2016" (on by default): the charts get only the months from 2016 -- the
    // years before are neither drawn nor in the range slider; off -- the whole history
    const usErpFrom = document.getElementById('us_erp_from2016').checked ? '2016-01-01' : null;
    const usErpCut = traces => (usErpFrom ? traces.map(t => {
      const keep = (t.x || []).map(x => x >= usErpFrom);
      return Object.assign({}, t, { x: t.x.filter((_, i) => keep[i]), y: t.y.filter((_, i) => keep[i]),
        ...(Array.isArray(t.customdata) ? { customdata: t.customdata.filter((_, i) => keep[i]) } : {}) });
    }) : traces);
    const usErpTraces = usErpCut(DATA.usErp), usErpZTraces = usErpCut(DATA.usErpZChart);
    const usErpRange = usErpFrom ? [usErpFrom, DATA.usErpDefaultRange[1]] : DATA.usErpDefaultRange;
    for (const div of ['plot_us_erp', 'plot_us_erp_z', 'plot_damodaran_z']) Plotly.purge(div);
    const usErpLayout = Object.assign({}, layoutWith('%', [HLINE(0, '#6a7381', 'dot')]), {
      xaxis: Object.assign({}, LAYOUT_BASE.xaxis, {
        rangeslider: { visible: true, thickness: 0.08 },
        range: usErpRange,
      }),
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, {
        title: '%', autorange: true, rangemode: 'normal',
      }),
    });
    const usErpZLayout = Object.assign({}, layoutWith('Z-score', [
        HLINE(0, '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5, '#e05252', 'dot'),
      ]), {
      xaxis: Object.assign({}, LAYOUT_BASE.xaxis, {
        rangeslider: { visible: true, thickness: 0.08 },
        range: usErpRange,
      }),
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, {
        title: 'Z-score', autorange: true, rangemode: 'normal',
      }),
    });
    Plotly.newPlot('plot_us_erp', usErpTraces, usErpLayout, CONFIG);
    Plotly.newPlot('plot_us_erp_z', usErpZTraces, usErpZLayout, CONFIG);
    autoFitYOnXChange('plot_us_erp', usErpTraces);
    autoFitYOnXChange('plot_us_erp_z', usErpZTraces);
    const damodaranZLayout = Object.assign({}, layoutWith('Z-score', [
        HLINE(0, '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5, '#e05252', 'dot'),
      ]), {
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, {
        title: 'Z-score', autorange: true, rangemode: 'normal',
      }),
    });
    Plotly.newPlot('plot_damodaran_z', usErpCut(DATA.damodaranZChart), damodaranZLayout, CONFIG);
    // under a spoiler, closed by default: drawn while hidden, it takes its width when opened
    const dzDetails = document.getElementById('damodaran_z_details');
    if (dzDetails && !dzDetails.dataset.bound) {
      dzDetails.dataset.bound = '1';
      dzDetails.addEventListener('toggle', () => { if (dzDetails.open) Plotly.Plots.resize('plot_damodaran_z'); });
    }
    Plotly.newPlot('plot_us_alloc_target', DATA.usAllocTarget, DATA.usAllocTargetLayout, CONFIG);
    // the target split over time (calc_us_allocation.py's history); none yet -- no chart
    if (DATA.usAllocHistory.length) {
      Plotly.newPlot('plot_us_alloc_history', DATA.usAllocHistory, Object.assign({}, LAYOUT_BASE, {
        xaxis: Object.assign({}, LAYOUT_BASE.xaxis, {
          type: 'date', tickformat: '%Y-%m', dtick: 'M6',
          rangeslider: { visible: true, thickness: 0.08 }, range: DATA.usAllocHistoryRange,
        }),
        // a fixed 60-100%: the share's whole range since 2019, from a round floor (the user)
        yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { title: 'stocks, %', range: [60, 100], dtick: 5, ticksuffix: '%' }),
        hovermode: 'x unified',
      }), CONFIG);
    }
  } else if (id === 'sigmoid') {
    const layoutAmp = Object.assign({}, LAYOUT_BASE, {
      xaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', title: 'USD/RUB rate', range: DATA.sigmoidAxisRange },
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, { title: 'w_CNY(x), %', range: [0, 100], dtick: 10 }),
      shapes: DATA.sigmoidAmpShapes,
      annotations: DATA.sigmoidAmpAnnotations,
    });
    Plotly.newPlot('plot_sigmoid_amp', DATA.sigmoidAmp, layoutAmp, CONFIG);
    Plotly.newPlot('plot_wcny5y_combined', DATA.wCny5yCombined,
      Object.assign({}, LAYOUT_BASE, {
        xaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', tickformat: '%Y', dtick: 'M12', tickangle: -45 },
        yaxis: Object.assign({}, LAYOUT_BASE.yaxis, {
          title: 'w_CNY(t), %', range: [0, 100], dtick: 10,
        }),
        yaxis2: {
          title: 'USD/RUB rate', overlaying: 'y', side: 'right',
          gridcolor: '#1e2830', linecolor: '#1e2830', color: '#9ca3af',
        },
        shapes: [...(DATA.wCny5yZones || []), HLINE(20, '#6a7381', 'dot'), HLINE(50, '#6a7381', 'dot'), HLINE(80, '#6a7381', 'dot')],
      }), CONFIG);
  }
}

async function fetchLastModified(path) {
  try {
    const res = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('last-modified');
    return lm ? new Date(lm) : null;
  } catch (e) {
    return null;
  }
}

async function loadLastUpdated() {
  const paths = [
    `${DATA_DIR}/composite_valuation.csv`,
    `${DATA_DIR}/erp_portfolio.csv`,
    `${DATA_DIR}/usd_rub_history.csv`,
    `${DATA_DIR}/usd_rub_stats.json`,
    `${DATA_DIR}/target_weights.json`,
    `${DATA_DIR}/target_allocation.json`,
  ];
  const dates = (await Promise.all(paths.map(fetchLastModified))).filter(Boolean);
  const el = document.getElementById('last_updated');
  if (!dates.length) {
    el.textContent = 'Last updated: unknown';
    return;
  }
  const latest = new Date(Math.max(...dates.map(d => d.getTime())));
  const iso = latest.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  el.textContent = `Last updated: ${iso}`;
}

// The dotted circle every sector of a target donut is measured against:
// "at base weight", radius rBase.
function baseCircleTrace(rBase) {
  return {
    type: 'scatterpolar',
    mode: 'lines',
    r: Array.from({ length: 73 }, () => rBase),
    theta: Array.from({ length: 73 }, (_, i) => i * 5),
    line: { color: '#e6edf3', width: 1.5, dash: 'dot' },
    name: 'Base (common reference circle)',
    hoverinfo: 'skip',
  };
}

// A target weights donut (the Russian tickers', the US basket's): each
// ticker's sector as wide as its BASE weight (so sectors tile the full circle
// like a normal portfolio donut, and even 1%-base tickers show up as thin
// slices), all sharing ONE common outer radius (R_BASE) for "at base weight",
// each drawn R_BASE * (target/base) long: a sector whose target equals its
// base ends exactly on the common circle, one with target > base protrudes
// past it, target < base falls short. colors: ticker -> colour; labelSize:
// the tickers' font size. { traces, layout }.
function twDonut(rows, colors, labelSize) {
  const totalBase = rows.reduce((s, r) => s + r.base, 0);
  let cursor = 0;
  const theta = [];   // angular center of each ticker's sector
  const width = [];   // angular width = base share of the full circle
  rows.forEach(r => {
    const w = r.base / totalBase * 360;
    theta.push(cursor + w / 2);
    width.push(w);
    cursor += w;
  });
  const R_BASE = 100; // common reference radius shared by every sector
  const radial = rows.map(r => R_BASE * (r.target / r.base));
  const maxR = Math.max(R_BASE, ...radial);
  const traces = [
    {
      type: 'barpolar',
      r: radial,
      theta,
      width,
      name: 'Target (relative to Base)',
      customdata: rows.map(r => r.ticker),   // a sector's click: its price chart (mpChartOnClick)
      marker: {
        color: rows.map(r => colors[r.ticker] || '#8b949e'),
        opacity: 0.85,
        line: { color: '#0d1117', width: 1 },
      },
      hovertemplate: rows.map(r => {
        const diff = r.target - r.base;
        const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
        const zStr = r.z !== null ? r.z.toFixed(2) : 'n/a';
        return `${r.ticker}<br>Base: <b>${r.base.toFixed(2)}%</b> (sector angle)<br>` +
               `Target: <b>${r.target.toFixed(2)}%</b> (${diffStr} п.п.)<br>Z: ${zStr} (${r.signal})<extra></extra>`;
      }),
    },
    baseCircleTrace(R_BASE),
    {
      type: 'scatterpolar',
      mode: 'text',
      r: rows.map(() => maxR * 1.14),
      theta,
      text: rows.map(r => r.ticker),
      textfont: { color: rows.map(r => colors[r.ticker] || '#8b949e'), size: labelSize },
      showlegend: false,
      hoverinfo: 'skip',
    },
  ];
  const layout = {
    paper_bgcolor: '#0d1117',
    plot_bgcolor: '#0d1117',
    font: { color: '#c9d1d9', size: 10 },
    polar: {
      domain: { x: [0.1, 0.9], y: [0.06, 0.94] },
      bgcolor: '#0d1117',
      radialaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', range: [0, maxR * 1.25], showticklabels: false, ticksuffix: '' },
      angularaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', showticklabels: false, rotation: 90, direction: 'clockwise' },
    },
    showlegend: true,
    legend: { bgcolor: '#13191f', bordercolor: '#1e2830', borderwidth: 1, x: 0.5, y: -0.06, xanchor: 'center', yanchor: 'top', orientation: 'h', font: { size: 9 } },
    margin: { t: 10, r: 10, b: 10, l: 10 },
  };
  return { traces, layout };
}

// The target weights donut's table: by target, highest first.
function twTableHtml(rows, colors) {
  return `
    <table class="data-table">
      <thead><tr>
        <th>Ticker</th><th>Base</th><th>Z-score</th><th>Adjustment</th><th>Target</th><th>&Delta; vs Base</th>
      </tr></thead>
      <tbody>
        ${rows.slice().sort((a, b) => b.target - a.target).map(r => {
          const zStr = r.z !== null ? (r.z >= 0 ? '+' : '') + r.z.toFixed(2) : '—';
          const zCls = r.z === null ? 'muted' : (r.z > 1.5 ? 'pos' : (r.z < -1.5 ? 'neg' : 'muted'));
          const adj = r.adjustment;
          const adjStr = adj !== null ? (adj >= 0 ? '+' : '') + adj.toFixed(2) + ' pp' : '—';
          const delta = r.target - r.base;
          const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' pp';
          const adjCls = adj === null ? 'muted' : (adj > 0 ? 'pos' : (adj < 0 ? 'neg' : 'muted'));
          // coloured only on a signal: without one the delta is just the rescaling to 100%
          const deltaCls = adjCls;
          return `<tr>
            <td class="ticker" data-chart="${r.ticker}" style="color:${colors[r.ticker] || '#8b949e'}">${r.ticker}</td>
            <td>${r.base.toFixed(2)}%</td>
            <td class="${zCls}">${zStr}</td>
            <td class="${adjCls}">${adjStr}</td>
            <td>${r.target.toFixed(2)}%</td>
            <td class="${deltaCls}">${deltaStr}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ticker -> {sector: share of it}. A fund goes by what it holds (fund_sector_weights, scaled to the whole
// fund: cash and bonds have no sector); with no data for it, it stays under "Funds".
function sectorSplit(sectorMap, fundSectors = {}) {
  const out = {};
  Object.entries(sectorMap).forEach(([sector, tickers]) => tickers.forEach(t => {
    const parts = sector === 'Funds' ? Object.entries(fundSectors[t] || {}).filter(([, w]) => w > 0) : [];
    const total = parts.reduce((s, [, w]) => s + w, 0);
    out[t] = total > 0 ? Object.fromEntries(parts.map(([k, w]) => [k, w / total])) : { [sector]: 1 };
  }));
  return out;
}

// fund -> {sector: weight}; empty if the view can't be read (the funds then stay one slice)
async function fundSectorWeights(funds) {
  const { data, error } = await sb.from('fund_sector_weights').select('fund, sector, weight').in('fund', funds);
  const out = {};
  if (!error) (data || []).forEach(r => { (out[r.fund] ??= {})[r.sector] = Number(r.weight); });
  return out;
}

// A basket by sector: the target weights donut's geometry (angle = base, radius = target / base),
// a sector's hover lists its stocks; no click, a sector has no price chart.
function sectorDonut(rows, sectorMap, fundSectors = {}) {
  const split = sectorSplit(sectorMap, fundSectors);
  const bySector = {};
  rows.forEach(r => Object.entries(split[r.ticker] || {}).forEach(([sector, share]) => {
    const s = bySector[sector] ??= { ticker: sector, held: [], base: 0, target: 0, z: null };
    s.base += r.base * share;
    s.target += r.target * share;
    s.held.push({ ticker: r.ticker, target: r.target * share });
  }));
  const sectors = Object.values(bySector).filter(r => r.base > 0).sort((a, b) => b.target - a.target);
  sectors.forEach(r => r.held.sort((a, b) => b.target - a.target));
  const { traces, layout } = twDonut(sectors, MP_SECTOR_COLORS, 11);
  traces[0].customdata = undefined;
  traces[0].hovertemplate = sectors.map(r => {
    const diff = r.target - r.base;
    return `<b>${r.ticker}</b><br>Base: ${r.base.toFixed(2)}%<br>Target: <b>${r.target.toFixed(2)}%</b> (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pp)<br>`
      + `${r.held.map(h => `${h.ticker} ${h.target.toFixed(2)}%`).join('<br>')}<extra></extra>`;
  });
  // the radius by the gap in percentage points (as on the actual-portfolio donut): by the ratio, a 0.3%
  // sector with a small change would stick out further than a 60% one
  const radial = sectors.map(r => Math.max(0, 100 + (r.target - r.base) * 2));
  traces[0].r = radial;
  const maxR = Math.max(100, ...radial);
  // the sector names are long: clear of the widest slice; under 1% only on hover, small ones staggered
  traces[2].text = sectors.map(r => (r.base >= 1 ? r.ticker : ''));
  traces[2].r = sectors.map((r, i) => maxR * (r.base < 5 ? 1.2 + (i % 3) * 0.1 : 1.3));
  layout.polar.radialaxis.range = [0, maxR * 1.5];
  layout.title = { text: 'By economic sector', font: { size: 13, color: '#c9d1d9' }, x: 0.5, y: 0.985 };
  return { traces, layout };
}

// The stocks vs bonds donut (the Russian portfolio's, the US one's): the same
// geometry as the target weights donut -- angular width = base %, one common
// reference circle, radial extent = R_BASE * (target/base). names: the
// sectors in order; base / target / colors: by name. { traces, layout }.
function allocDonut(names, base, target, colors) {
  let cursor = 0;
  const theta = [];
  const width = [];
  names.forEach(n => {
    const w = base[n] / 100 * 360;
    theta.push(cursor + w / 2);
    width.push(w);
    cursor += w;
  });
  const R_BASE = 100;
  const radial = names.map(n => R_BASE * (target[n] / base[n]));
  const maxR = Math.max(R_BASE, ...radial);
  const traces = [
    {
      type: 'barpolar',
      r: radial,
      theta,
      width,
      name: 'Target (relative to Base)',
      marker: {
        color: names.map(n => colors[n]),
        opacity: 0.85,
        line: { color: '#0d1117', width: 1 },
      },
      hovertemplate: names.map(n => {
        const diff = target[n] - base[n];
        const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
        return `${n}<br>Base: <b>${base[n].toFixed(2)}%</b> (sector angle)<br>` +
               `Target: <b>${target[n].toFixed(2)}%</b> (${diffStr} п.п.)<extra></extra>`;
      }),
    },
    baseCircleTrace(R_BASE),
    {
      type: 'scatterpolar',
      mode: 'text',
      r: names.map(() => maxR * 1.14),
      theta,
      text: names,
      textfont: { color: names.map(n => colors[n]), size: 13 },
      showlegend: false,
      hoverinfo: 'skip',
    },
  ];
  const layout = {
    paper_bgcolor: '#0d1117',
    plot_bgcolor: '#0d1117',
    font: { color: '#c9d1d9', size: 11 },
    polar: {
      domain: { x: [0.15, 0.85], y: [0.05, 0.95] },
      bgcolor: '#0d1117',
      radialaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', range: [0, maxR * 1.25], showticklabels: false, ticksuffix: '' },
      angularaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', showticklabels: false, rotation: 90, direction: 'clockwise' },
    },
    showlegend: true,
    legend: { bgcolor: '#13191f', bordercolor: '#1e2830', borderwidth: 1, x: 1, y: 1 },
    margin: { t: 20, r: 20, b: 20, l: 20 },
  };
  return { traces, layout };
}

// EXPERIMENTAL: basket of 37 major US stocks (ticker, base weight %), Z-score
// vs each stock's own rolling history. NOT part of the Russian ERP portfolio.
const US_TICKERS = [
  ['GOOGL', 6],   ['NVDA', 5],   ['LLY', 5],    ['CAT', 5],    ['LIN', 5],
  ['GE', 4],      ['AMZN', 4],   ['WMT', 4],    ['XOM', 4],    ['NEE', 4],
  ['PLD', 4],     ['JPM', 3],    ['BRK-B', 3],  ['JNJ', 3],    ['META', 3],
  ['V', 2],       ['MA', 2],     ['HOOD', 2],   ['MSFT', 2],   ['AAPL', 2],
  ['ABBV', 2],    ['TSLA', 2],   ['HD', 2],     ['PG', 2],     ['KO', 2],
  ['SHEL', 2],    ['CVX', 2],    ['SHW', 2],    ['DUK', 2],    ['AMT', 2],
  ['SOFI', 1.5],  ['XYZ', 1.5],  ['INTC', 1],   ['SPCX', 1],   ['FCX', 1],
  ['SO', 1],      ['EQIX', 1],
];
// the same sectors as public.securities (kept here: the tab also opens signed out)
const US_SECTORS = {
  'Information Technology': ['NVDA', 'MSFT', 'AAPL', 'INTC'],
  Financials: ['JPM', 'BRK-B', 'V', 'MA', 'HOOD', 'SOFI', 'XYZ'],
  'Health Care': ['LLY', 'JNJ', 'ABBV'],
  Industrials: ['CAT', 'GE'],
  'Communication Services': ['GOOGL', 'META', 'SPCX'],
  'Consumer Discretionary': ['AMZN', 'TSLA', 'HD'],
  'Consumer Staples': ['WMT', 'PG', 'KO'],
  Energy: ['XOM', 'SHEL', 'CVX'],
  Materials: ['LIN', 'SHW', 'FCX'],
  Utilities: ['NEE', 'DUK', 'SO'],
  'Real Estate': ['PLD', 'AMT', 'EQIX'],
};
// the Russian basket likewise; the funds are split by what they hold (sectorSplit)
const RU_SECTORS = {
  Financials: ['SBER', 'T', 'DOMRF', 'VTBR'],
  'Communication Services': ['YDEX'],
  'Consumer Discretionary': ['OZON'],
  Energy: ['ROSN'],
  Materials: ['GMKN', 'PLZL'],
  Utilities: ['IRAO'],
  Funds: ['TRND', 'AKME', 'AKFN'],
};
const US_COLORS = [
  '#4da8c8','#f0b429','#3dd68c','#22d3ee','#e05252','#a78bfa','#fb923c',
  '#34d399','#fbbf24','#f472b6','#60a5fa','#facc15','#c084fc','#fb7185',
  '#2dd4bf','#f97316','#84cc16','#e879f9','#38bdf8','#fde047','#f87171',
  '#a3e635','#818cf8','#fbcfe8','#5eead4','#fdba74','#bef264','#c4b5fd',
  '#fca5a5','#67e8f9','#d9f99d','#f0abfc','#93c5fd','#fed7aa','#99f6e4','#ddd6fe',
];
// the Russian portfolio's tickers' colours (the target weights donut, the pies)
const TICKER_COLORS = {
  SBER: '#4da8c8', YDEX: '#f0b429', T: '#3dd68c', DOMRF: '#22d3ee',
  TRND: '#c084fc', OZON: '#e05252', AKME: '#60a5fa', AKFN: '#facc15',
  ROSN: '#a78bfa', VTBR: '#fb923c', GMKN: '#34d399', PLZL: '#fbbf24', IRAO: '#f472b6',
};
const ALLOC_COLORS = { Stocks: '#4da8c8', Bonds: '#f0b429' };

// A series' first and last day, for a chart's default range; none: undefined
const dateRange = dates => (dates.length ? [dates[0], dates[dates.length - 1]] : undefined);

// The target split month by month (calc_us_allocation.py, calc_target_weights.py):
// the stock share at each step of the formula -- plain lines (the user,
// 18.11.2026). No file yet -- no chart.
async function usAllocHistoryChart() {
  const usAllocHistRows = await fetchCsv(`${DATA_DIR}/us_allocation_history.csv`).catch(() => []);
  const usAllocHistDates = usAllocHistRows.map(r => r.date + '-01');
  // age alone, age + rate (the base), and the target with the Z-score's correction
  const usAllocHistory = usAllocHistRows.length ? [
    jsSeries(usAllocHistDates, usAllocHistRows.map(r => val(r.age_stocks)), 'Stocks by age alone', '#8b949e', { width: 1.5, dash: 'dot' }),
    // by the Fed funds rate alone, the rate itself in the hover
    Object.assign(jsSeries(usAllocHistDates, usAllocHistRows.map(r => val(r.rate_stocks)), 'Stocks by Fed rate alone', '#a78bfa', { width: 1.5, dash: 'dot' }), {
      customdata: usAllocHistRows.map(r => val(r.fed_rate)),
      hovertemplate: 'Stocks by Fed rate alone: <b>%{y:.1f}%</b> (rate %{customdata:.2f}%)<extra></extra>',
    }),
    jsSeries(usAllocHistDates, usAllocHistRows.map(r => val(r.base_stocks)), 'Base: age + Fed rate', '#f0b429', { width: 1.5, dash: 'dash' }),
    jsSeries(usAllocHistDates, usAllocHistRows.map(r => val(r.target_stocks)), 'Target: age + Fed rate + ERP Z-score', '#4da8c8', { width: 2.5 }),
  ] : [];
  return { usAllocHistory, usAllocHistoryRange: dateRange(usAllocHistDates) };
}
// the same for the Russian portfolio: rate-based base, composite Z
async function ruAllocHistoryChart() {
  const ruAllocHistRows = await fetchCsv(`${DATA_DIR}/ru_allocation_history.csv`).catch(() => []);
  const ruAllocHistDates = ruAllocHistRows.map(r => r.date + '-01');
  const ruAllocHistory = ruAllocHistRows.length ? [
    Object.assign(jsSeries(ruAllocHistDates, ruAllocHistRows.map(r => val(r.rate_stocks)), 'Base: by CBR key rate alone', '#a78bfa', { width: 1.5, dash: 'dot' }), {
      customdata: ruAllocHistRows.map(r => val(r.key_rate)),
      hovertemplate: 'Base: by CBR key rate alone: <b>%{y:.1f}%</b> (rate %{customdata:.2f}%)<extra></extra>',
    }),
    jsSeries(ruAllocHistDates, ruAllocHistRows.map(r => val(r.target_stocks)), 'Target: key rate + composite ERP Z-score', '#4da8c8', { width: 2.5 }),
  ] : [];
  return { ruAllocHistory, ruAllocHistoryRange: dateRange(ruAllocHistDates) };
}

// The Russian ERP and its tickers (composite_valuation.csv, erp_portfolio.csv,
// the VKCO experiment): the yields, the ERP, the Z-scores.
function ruErpCharts(rows, eyRows, vkcoRows, vkcoRevenueRows, vkcoPredicted) {
  const dates = rows.map(r => r.date + '-01');
  const series = key => rows.map(r => val(r[key]));

  const portYield = series('portfolio_yield');
  const ofz10y = series('ofz10y');
  const erp = series('erp');

  const eyDates = eyRows.map(r => r.date + '-01');
  const eySeries = key => eyRows.map(r => val(r[key]));

  const layer1 = [
    jsSeries(dates, portYield, 'Portfolio EY (all tickers)', '#4da8c8', { width: 2 }),
    jsSeries(dates, ofz10y, 'OFZ 10Y', '#f0b429', { width: 2 }),
    jsSeries(dates, erp, 'ERP (EY − OFZ)', '#3dd68c', { width: 2.5 }),
    erpFill(dates, erp, true),
    erpFill(dates, erp, false),
  ];

  const layer1Individual = [
    jsSeries(eyDates, eySeries('SBER_ey'), 'SBER EY%', '#4da8c8'),
    jsSeries(eyDates, eySeries('YDEX_ey'), 'YDEX EY%', '#f0b429'),
    jsSeries(eyDates, eySeries('T_ey'), 'T EY%', '#3dd68c'),
    jsSeries(eyDates, eySeries('DOMRF_ey'), 'DOMRF EY%', '#22d3ee'),
    jsSeries(eyDates, eySeries('OZON_ey'), 'OZON EY%', '#e05252'),
    jsSeries(eyDates, eySeries('ROSN_ey'), 'ROSN EY%', '#a78bfa', { visible: false }),
    jsSeries(eyDates, eySeries('VTBR_ey'), 'VTBR EY%', '#fb923c', { visible: false }),
    jsSeries(eyDates, eySeries('GMKN_ey'), 'GMKN EY%', '#34d399', { visible: false }),
    jsSeries(eyDates, eySeries('PLZL_ey'), 'PLZL EY%', '#fbbf24', { visible: false }),
    jsSeries(eyDates, eySeries('IRAO_ey'), 'IRAO EY%', '#f472b6', { visible: false }),
    jsSeries(
      vkcoRows.map(r => r.date + '-01'),
      vkcoRows.map(r => val(r.earnings_yield)),
      'VKCO EY% (experimental — not in portfolio)',
      '#94a3b8',
      { visible: false },
    ),
    jsSeries(eyDates, eySeries('ofz10y'), 'OFZ 10Y', '#f0b429', { dash: 'dash', width: 1.5 }),
  ];

  const revYield = [
    jsSeries(dates, series('YDEX_l2yield'), 'YDEX Rev Yield%', '#f0b429'),
    jsSeries(dates, series('OZON_l2yield'), 'OZON Rev Yield%', '#e05252'),
    jsSeries(
      vkcoRows.map(r => r.date + '-01'),
      vkcoRows.map(r => val(r.revenue_yield)),
      'VKCO Rev Yield% (experimental — not in portfolio)',
      '#94a3b8',
      { visible: false },
    ),
  ];

  const fcfYield = [
    jsSeries(dates, series('ROSN_l2yield'), 'ROSN FCF Yield%', '#a78bfa'),
    jsSeries(dates, series('GMKN_l2yield'), 'GMKN FCF Yield%', '#34d399'),
    jsSeries(dates, series('PLZL_l2yield'), 'PLZL FCF Yield%', '#fbbf24'),
  ];

  // EXPERIMENTAL: VKCO Revenue Yield numerator, old (step function, still in
  // production) vs new (spline through real reports + one predicted point).
  const vkcoDates = vkcoRows.map(r => r.date + '-01');
  const vkcoReportPoints = vkcoRevenueRows
    .filter(r => r.revenue_bln !== '' && r.revenue_bln !== undefined)
    .map(r => ({ date: `${parseInt(r.year, 10) + 1}-03-01`, value: val(r.revenue_bln) }));
  const vkcoPredictedDate = vkcoPredicted ? `${vkcoPredicted.year + 1}-03-01` : null;

  const vkcoRevenueV2 = [
    jsSeries(vkcoDates, vkcoRows.map(r => val(r.revenue_yield)), 'Revenue Yield % (OLD: step function)',
      '#facc15', { dash: 'dot', width: 1.2 }),
    jsSeries(vkcoDates, vkcoRows.map(r => val(r.revenue_yield_v2)), 'Revenue Yield % (NEW: spline+predicted)',
      '#facc15', { width: 2.2 }),
    Object.assign(
      jsSeries(vkcoDates, vkcoRows.map(r => val(r.revenue_v2_bln)), 'Revenue numerator, bln RUB (NEW)', '#3dd68c', { width: 2.2 }),
      { yaxis: 'y2' },
    ),
    {
      x: vkcoReportPoints.map(p => p.date), y: vkcoReportPoints.map(p => p.value),
      name: 'Real reported annual revenue', type: 'scatter', mode: 'markers',
      marker: { color: '#ffffff', size: 8 }, yaxis: 'y2',
      hovertemplate: '%{x|%Y-%m}<br>Revenue: <b>%{y:.1f}</b> bln RUB<extra></extra>',
    },
    vkcoPredicted ? {
      x: [vkcoPredictedDate], y: [vkcoPredicted.revenue_bln],
      name: `Predicted ${vkcoPredicted.year} revenue (Method 8)`, type: 'scatter', mode: 'markers',
      marker: { color: '#f472b6', size: 14, symbol: 'star' }, yaxis: 'y2',
      hovertemplate: `Predicted ${vkcoPredicted.year}: <b>%{y:.1f}</b> bln RUB<extra></extra>`,
    } : null,
  ].filter(Boolean);

  const layer2Rebal = [
    jsSeries(dates, series('SBER_z'), 'SBER (EY)', '#4da8c8'),
    jsSeries(dates, series('YDEX_z'), 'YDEX (Rev Yield)', '#f0b429'),
    jsSeries(dates, series('T_z'), 'T (EY)', '#3dd68c'),
    jsSeries(dates, series('DOMRF_z'), 'DOMRF (EY)', '#22d3ee'),
    jsSeries(dates, series('OZON_z'), 'OZON (Rev Yield)', '#e05252'),
    jsSeries(dates, series('ROSN_z'), 'ROSN (FCF Yield)', '#a78bfa', { visible: false }),
    jsSeries(dates, series('VTBR_z'), 'VTBR (EY)', '#fb923c', { visible: false }),
    jsSeries(dates, series('GMKN_z'), 'GMKN (FCF Yield)', '#34d399', { visible: false }),
    jsSeries(dates, series('PLZL_z'), 'PLZL (FCF Yield)', '#fbbf24', { visible: false }),
    jsSeries(dates, series('IRAO_z'), 'IRAO (EY)', '#f472b6', { visible: false }),
    jsSeries(
      vkcoRows.map(r => r.date + '-01'),
      vkcoRows.map(r => val(r.z_score)),
      'VKCO (Rev Yield, experimental — not in portfolio)',
      '#94a3b8',
      { visible: false },
    ),
  ];

  const layer2Alloc = [
    jsSeries(dates, series('portfolio_z'), 'Portfolio Z', '#4da8c8'),
    jsSeries(dates, series('ofz_z'), 'OFZ Z', '#f0b429'),
    jsSeries(dates, series('composite_erp_z'), 'Composite ERP Z (Port − OFZ)', '#3dd68c', { width: 2.5 }),
  ];
  return { layer1, layer1Individual, revYield, fcfYield, vkcoRevenueV2, layer2Rebal, layer2Alloc };
}

// The US basket's Z-scores (us_zscore.csv), a line a ticker, the first five shown.
function usZscoreChart(usZscoreRows) {
  // the axis starts at the first month with a Z-score: before it there's too little history
  const usFirstZ = usZscoreRows.filter(r => r.z_score).map(r => r.date + '-01').sort()[0];
  const usZDates = [...new Set(usZscoreRows.map(r => r.date + '-01'))].filter(d => !usFirstZ || d >= usFirstZ);
  const usByTicker = {};
  usZscoreRows.forEach(r => {
    (usByTicker[r.ticker] = usByTicker[r.ticker] || []).push(r);
  });
  const usMetricLabel = { EY: 'EY', Revenue: 'Rev Yield', FCF: 'FCF Yield' };
  return US_TICKERS.map(([ticker, weight], i) => {
    const trows = usByTicker[ticker] || [];
    const byDate = {};
    trows.forEach(r => { byDate[r.date + '-01'] = r; });
    const metric = trows.length ? trows[0].metric : '';
    return jsSeries(
      usZDates,
      usZDates.map(d => { const r = byDate[d]; return r ? val(r.z_score) : null; }),
      `${ticker} (${usMetricLabel[metric] || metric}) — ${weight}%`,
      US_COLORS[i % US_COLORS.length],
      { visible: i < 5 },
    );
  });
}

// US ERP — Shiller's Excess CAPE Yield + its own Z-score, both computed
// from the FULL 1871-present history stored in the CSV. The full range is
// plotted; use the chart's zoom/pan/range-slider to focus on a period.
function usErpCharts(usErpRows, damodaranErpRows) {
  const usErpDates = usErpRows.map(r => r.date + '-01');
  const usErpYield = usErpRows.map(r => val(r.excess_cape_yield_pct));
  const usErpZ = usErpRows.map(r => val(r.z_score));
  // the months after Shiller's last, estimated by us_erp.py (estimated=1)
  // until he publishes them: a dashed line on from his last month
  const usErpEst = usErpRows.map(r => r.estimated === '1');
  const usErpEstOnly = vals => vals.map((v, i) => (usErpEst[i] || usErpEst[i + 1] ? v : null));
  const usErpReal = vals => vals.map((v, i) => (usErpEst[i] ? null : v));
  const usErpEstSeries = (vals, color, width) => usErpEst.some(Boolean)
    ? [jsSeries(usErpDates, usErpEstOnly(vals), 'estimated (Shiller not out yet)', color, { width, dash: 'dash' })] : [];
  // one series as drawn: solid to Shiller's last month, dashed after it -- and one invisible
  // line over every month that alone answers the hover, so a month's hover shows that month
  // (the solid line has nothing there past Shiller's last month, and the unified hover fell
  // back to its last point, September's, under November's header)
  const usErpLine = (vals, name, color, width) => [
    Object.assign(jsSeries(usErpDates, usErpReal(vals), name, color, { width }), { hoverinfo: 'skip', hovertemplate: undefined }),
    ...usErpEstSeries(vals, color, width).map(t => Object.assign(t, { hoverinfo: 'skip', hovertemplate: undefined, showlegend: false })),
    Object.assign(jsSeries(usErpDates, vals, name, color, { width: 0 }), {
      showlegend: false,
      hovertemplate: name + ': <b>%{y:.2f}</b>' + (usErpEst.some(Boolean) ? '%{customdata}' : '') + '<extra></extra>',
      customdata: usErpEst.map(e => (e ? ' (estimated, Shiller not out yet)' : '')),
    }),
  ];
  // Default visible window is the last 10 years; the full 1871-present
  // history is loaded and reachable via the range-slider/zoom below it.
  const usErpDefaultRange = usErpDates.length
    ? [usErpDates[Math.max(0, usErpDates.length - 121)], usErpDates[usErpDates.length - 1]]
    : undefined;

  // Damodaran's ERP (T12m) -- his own genuine monthly series (recomputed
  // every month since Sept 2008 from trailing-12-month dividends+buybacks
  // vs the current S&P 500 level and Treasury rate), NOT a step function
  // of his annual figure -- see damodaran_erp.py's docstring.
  const damodaranByDate = new Map(damodaranErpRows.map(r => [r.date, val(r.implied_erp_t12m_pct)]));
  const damodaranYield = usErpRows.map(r => damodaranByDate.has(r.date) ? damodaranByDate.get(r.date) : null);

  // the two sides of the gap, as on the RU ERP tab (the user, 18.11.2026): the stocks' yield
  // 1/CAPE and the real 10-year rate, 1/CAPE less the excess yield
  const usErpStocksYield = usErpRows.map(r => { const c = val(r.cape); return c ? 100 / c : null; });
  const usErpBondsYield = usErpStocksYield.map((s, i) => (s == null || usErpYield[i] == null ? null : s - usErpYield[i]));
  const usErp = [
    ...usErpLine(usErpStocksYield, 'S&P 500 earnings yield (1/CAPE), %', '#4da8c8', 2),
    ...usErpLine(usErpBondsYield, '10Y Treasury real yield, %', '#f0b429', 2),
    ...usErpLine(usErpYield, "Shiller's Excess CAPE Yield, %", '#3dd68c', 2),
    jsSeries(usErpDates, damodaranYield, "Damodaran's Implied ERP (T12m), %", '#a78bfa', { width: 1.5, dash: 'dot' }),
  ];

  // each side's own Z-score, as RU ERP's Portfolio Z / OFZ Z (the user, 18.11.2026): the same
  // rolling 36 months as us_erp.py's rolling_zscore (the 36 before, population std, 6+ needed),
  // on the whole history; shown only -- the donut stays on the gap's Z-score
  const usErpRollZ = vals => vals.map((v, i) => {
    if (v == null) return null;
    const h = vals.slice(Math.max(0, i - 36), i).filter(x => x != null);
    if (h.length < 6) return null;
    const m = h.reduce((s, x) => s + x, 0) / h.length;
    const sd = Math.sqrt(h.reduce((s, x) => s + (x - m) ** 2, 0) / h.length);
    return sd < 1e-9 ? 0 : (v - m) / sd;
  });
  const usErpZChart = [
    jsSeries(usErpDates, usErpRollZ(usErpStocksYield), 'Stocks Z (1/CAPE)', '#4da8c8', { width: 1.5 }),
    jsSeries(usErpDates, usErpRollZ(usErpBondsYield), 'Bonds Z (10Y real yield)', '#f0b429', { width: 1.5 }),
    ...usErpLine(usErpZ, 'ERP Z (the gap; drives the donut)', '#3dd68c', 2.5),
    erpFill(usErpDates, usErpZ, true),
    erpFill(usErpDates, usErpZ, false),
  ];

  // Damodaran's OWN Z-score (informational only -- NOT used to drive the
  // allocation donut, which stays driven by Shiller's Z-score). Uses
  // Damodaran's own date axis (2008-09+), not Shiller's (1871+), since its
  // history is much shorter.
  const damodaranDates = damodaranErpRows.map(r => r.date + '-01');
  const damodaranZ = damodaranErpRows.map(r => val(r.z_score));
  const damodaranZChart = [
    jsSeries(damodaranDates, damodaranZ, "Damodaran's Z-score", '#5b9bd5', { width: 2.5 }),
    erpFill(damodaranDates, damodaranZ, true),
    erpFill(damodaranDates, damodaranZ, false),
  ];
  return { usErp, usErpZChart, usErpDefaultRange, damodaranZChart };
}

// A stocks vs bonds donut's table: by target, highest first. rate: the
// rate column's label and value; zClasses: the Z-score coloured past ±1.5
// (the US one's; the Russian one's Z is one portfolio-wide reading, plain).
function allocTableHtml(names, base, target, z, adjustment, colors, rate, zClasses) {
  return `
    <table class="data-table">
      <thead><tr>
        <th>Category</th><th>${rate.label}</th><th>Base</th><th>Z-score</th><th>Adjustment</th><th>Target</th><th>&Delta; vs Base</th>
      </tr></thead>
      <tbody>
        ${names.slice().sort((a, b) => target[b] - target[a]).map(n => {
          const zn = z[n];
          const zStr = zn !== null ? (zn >= 0 ? '+' : '') + zn.toFixed(2) : '—';
          const zCls = zn === null ? 'muted' : (zn > 1.5 ? 'pos' : (zn < -1.5 ? 'neg' : 'muted'));
          const adj = adjustment[n];
          const adjStr = adj !== null ? (adj >= 0 ? '+' : '') + adj.toFixed(2) + ' pp' : '—';
          const delta = target[n] - base[n];
          const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' pp';
          const adjCls = adj === null ? 'muted' : (adj > 0 ? 'pos' : (adj < 0 ? 'neg' : 'muted'));
          // coloured only on a signal: without one the delta is just the rescaling to 100%
          const deltaCls = adjCls;
          return `<tr>
            <td class="ticker" style="color:${colors[n]}">${n}</td>
            <td>${rate.value.toFixed(2)}%</td>
            <td>${base[n].toFixed(1)}%</td>
            ${zClasses ? `<td class="${zCls}">${zStr}</td>` : `<td>${zStr}</td>`}
            <td class="${adjCls}">${adjStr}</td>
            <td>${target[n].toFixed(1)}%</td>
            <td class="${deltaCls}">${deltaStr}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// The US basket's target weights and its stocks vs bonds split
// (us_target_weights.json, us_target_allocation.json): the donuts, their
// notes and tables written into the US stocks / US ERP tabs.
function usTargetCharts(usTargetWeightsData, usTargetAllocationData) {
  // US target weights donut — same geometry/formula as the Russian portfolio's
  // targetWeights chart: angular width = base weight, radial extent =
  // R_BASE * (target/base). Purely illustrative; not a real portfolio.
  const usTwRows = usTargetWeightsData.weights;
  const usTickerColor = {};
  US_TICKERS.forEach(([ticker], i) => { usTickerColor[ticker] = US_COLORS[i % US_COLORS.length]; });
  const { traces: usTargetWeights, layout: usTargetWeightsLayout } = twDonut(usTwRows, usTickerColor, 9);
  const { traces: usSectors, layout: usSectorsLayout } = sectorDonut(usTwRows, US_SECTORS);

  document.getElementById('us_targetweights_note').innerHTML = `
    <b>EXPERIMENTAL</b> — same illustrative donut as the Russian portfolio's Target Weights
    chart, applied to this US-stocks basket. Each sector's <b>angular width</b> is its
    <b>base</b> weight; the <b>radial extent</b> shows the <b>target</b> weight after the same
    Z-score correction (<code>base + 3&middot;sqrt(|Z|&minus;1.5)&middot;sign(Z)</code>, applied
    only when |Z| &gt; 1.5, then renormalized across all 37 positions to sum to 100%; if any
    position would go negative, every position is shifted up by the same amount first so the
    minimum lands at exactly 0). No real rebalancing happens from this.<br>
    Sector extends past the dotted circle → overweight vs base. Sector ends short of it → underweight vs base.<br>
    Data as of ${usTargetWeightsData.date} (updated ${usTargetWeightsData.updated}).
  `;

  document.getElementById('us_targetweights_table_wrap').innerHTML = twTableHtml(usTwRows, usTickerColor);

  // US Stocks vs Bonds allocation donut — same formula/geometry as the
  // Russian portfolio's allocation donut, but driven by the US Fed
  // Funds Rate (base) and the US ERP Z-score (correction) instead of the
  // CBR key rate and composite_erp_z. Purely illustrative.
  const usAllocBase = { Stocks: usTargetAllocationData.base_stocks, Bonds: usTargetAllocationData.base_bonds };
  const usAllocTarget = { Stocks: usTargetAllocationData.target_stocks, Bonds: usTargetAllocationData.target_bonds };
  const usAllocZ = { Stocks: usTargetAllocationData.z, Bonds: usTargetAllocationData.z };
  const usAllocAdjustment = { Stocks: usTargetAllocationData.stocks_adjustment, Bonds: usTargetAllocationData.bonds_adjustment };
  const usAllocNames = ['Stocks', 'Bonds'];
  const { traces: usAllocTargetTrace, layout: usAllocTargetLayout } = allocDonut(usAllocNames, usAllocBase, usAllocTarget, ALLOC_COLORS);

  const usAllocZStr = usTargetAllocationData.z !== null ? usTargetAllocationData.z.toFixed(2) : 'n/a';
  document.getElementById('us_alloc_target_note').innerHTML = `
    <b>EXPERIMENTAL</b> — same illustrative allocation donut as the Russian portfolio's, driven
    by US inputs instead: base stock share is a 50/50 blend of the <b>US Federal Funds Rate</b>
    (<code>w(r) = 100 / (1 + e^((r&minus;${usTargetAllocationData.key_rate_midpoint})/${usTargetAllocationData.key_rate_slope}))</code>,
    r = <span class="stat">${usTargetAllocationData.fed_rate.toFixed(2)}%</span>
    as of ${usTargetAllocationData.fed_rate_date} → <span class="stat">${usTargetAllocationData.rate_stocks.toFixed(1)}%</span> stocks;
    note the formula's constants are calibrated for the CBR's 5–21% rate range, not the Fed's —
    at the Fed's much lower rate this pins the rate-based share near 100% stocks, which is expected,
    not a bug) and an age-based glide path (bonds% = age &minus; 10, age = <span class="stat">${Number(usTargetAllocationData.age).toFixed(1)}</span>
    → <span class="stat">${usTargetAllocationData.age_stocks.toFixed(1)}%</span> stocks)
    → base = <span class="stat">${usTargetAllocationData.base_stocks.toFixed(1)}%</span> stocks,
    then the same Z-gated correction applied via the <b>US ERP Z-score</b>
    (<span class="stat">${usAllocZStr}</span>, ${usTargetAllocationData.signal}) →
    target = <span class="stat">${usTargetAllocationData.target_stocks.toFixed(1)}%</span> stocks /
    <span class="stat">${usTargetAllocationData.target_bonds.toFixed(1)}%</span> bonds.
    No real allocation happens from this.<br>
    Data as of ${usTargetAllocationData.date} (updated ${usTargetAllocationData.updated}).
  `;

  document.getElementById('us_alloc_target_table_wrap').innerHTML = allocTableHtml(usAllocNames, usAllocBase, usAllocTarget, usAllocZ,
    usAllocAdjustment, ALLOC_COLORS, { label: 'Fed Rate', value: usTargetAllocationData.fed_rate }, true);
  return { usTwRows, usTargetWeights, usTargetWeightsLayout, usSectors, usSectorsLayout, usAllocTargetTrace, usAllocTargetLayout, usAllocTarget };
}

// rows: [day, value]: the value as of a day (the last one on or before it), null before the first
const stepAt = rows => { const r = rows.filter(v => Number.isFinite(v[1])).sort((a, b) => a[0] < b[0] ? -1 : 1); return d => { let lo = 0, hi = r.length - 1, v = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (r[mid][0] <= d) { v = r[mid][1]; lo = mid + 1; } else hi = mid - 1; } return v; }; };

// The yuan's target by USD/RUB (the Sigmoid tab): the curve, today's point,
// the buy / sell lines and w_CNY over the 5 years; sets wCnyNow and writes
// the tab's note.
async function sigmoidCharts(usdRubRows, usdRubStats, usdRub5yRows) {
  const usdRubRates = usdRubRows.map(r => val(r.rate));
  // the target from the 5-year history, today's rate (stats.json, the CBR's
  // set for today) appended when the history doesn't have it yet
  const rates5y = usdRub5yRows.map(r => val(r.rate));
  const dates5y = usdRub5yRows.map(r => r.date);
  if (usdRubStats.date && usdRubStats.date > dates5y[dates5y.length - 1]) { dates5y.push(usdRubStats.date); rates5y.push(usdRubStats.x); }
  // the carry: the CBR's key rate (daily) less the PBoC's (monthly), each as of the day
  let ruAt = () => null, cnAt = () => null;
  try { ruAt = stepAt((await fetchCsv(`${DATA_DIR}/key_rate.csv`)).map(r => [r.date, val(r.rate_pct)])); } catch { /* no carry then */ }
  try {
    const { data: cn } = await sb.from('cb_rates_monthly').select('month, rate').eq('country', 'CN');
    cnAt = stepAt((cn || []).map(r => [r.month, Number(r.rate)]));
  } catch { /* no carry then */ }
  const carryAt = d => { const a = ruAt(d), b = cnAt(d); return a != null && b != null ? (a - b) / 100 : 0; };
  const wSeries = wCnySeries(dates5y, rates5y, WCNY.WIN, carryAt);
  const wNow = wSeries[wSeries.length - 1];
  wCnyNow = wNow;
  const lines = wCnyLines();
  const sigmoidX = wNow.x;
  const sigmoidM = wNow.m;

  const axisMin = Math.min(55, ...usdRubRates, sigmoidX, sigmoidM);
  const axisMax = Math.max(120, ...usdRubRates, sigmoidX, sigmoidM);
  const nPoints = 300;
  const curveX = Array.from({ length: nPoints }, (_, i) => axisMin + i * (axisMax - axisMin) / (nPoints - 1));
  const curveY = curveX.map(px => wCny(px, sigmoidM) * 100);

  const sigmoidSigma = wNow.sigma;
  const sigmoidWCnyAmp = wNow.w;
  const sigmoidMWCnyAmp = wCnyAmplified(sigmoidM, sigmoidM, sigmoidSigma);
  const sigmoidWRubAmp = 1 - sigmoidWCnyAmp;
  const curveYAmp = curveX.map(px => wCnyAmplified(px, sigmoidM, sigmoidSigma) * 100);

  const sigmoidAmp = [
    {
      x: curveX, y: curveY, name: `w_CNY(x) fixed k=${WCNY.K}`,
      type: 'scatter', mode: 'lines',
      line: { color: '#9ca3af', width: 1.5, dash: 'dash' },
      hovertemplate: 'USD/RUB: %{x:.2f}<br>w_CNY (fixed k): <b>%{y:.0f}%</b><extra></extra>',
    },
    {
      x: curveX, y: curveYAmp, name: 'w_CNY(x) amplified — the target',
      type: 'scatter', mode: 'lines',
      line: { color: '#a78bfa', width: 2.5 },
      hovertemplate: 'USD/RUB: %{x:.2f}<br>w_CNY: <b>%{y:.0f}%</b><extra></extra>',
    },
    {
      x: [sigmoidX], y: [sigmoidWCnyAmp * 100], name: `current x = ${sigmoidX.toFixed(2)}`,
      type: 'scatter', mode: 'markers',
      marker: { color: '#e05252', size: 11 },
      hovertemplate: `x = ${sigmoidX.toFixed(2)}<br>w_CNY = ${(sigmoidWCnyAmp * 100).toFixed(0)}%<extra></extra>`,
    },
  ];

  const sigmoidAmpShapes = [
    // the buy / sell lines: yuan bought only left of the green, sold only right of the orange
    { type: 'rect', x0: lines.buy, x1: lines.sell, y0: 0, y1: 100, fillcolor: 'rgba(156,163,175,0.07)', line: { width: 0 }, layer: 'below' },
    { type: 'line', x0: lines.buy, x1: lines.buy, y0: 0, y1: 100, line: { color: '#3dd68c', width: 2 } },
    { type: 'line', x0: lines.sell, x1: lines.sell, y0: 0, y1: 100, line: { color: '#f0b429', width: 2 } },
    { type: 'line', x0: sigmoidM, x1: sigmoidM, y0: 0, y1: 100,
      line: { color: '#a78bfa', dash: 'dash', width: 1 } },
    { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: sigmoidMWCnyAmp * 100, y1: sigmoidMWCnyAmp * 100,
      line: { color: '#a78bfa', dash: 'dash', width: 1 } },
    { type: 'line', x0: sigmoidX, x1: sigmoidX, y0: 0, y1: 100,
      line: { color: '#e05252', dash: 'dash', width: 1 } },
    { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: sigmoidWCnyAmp * 100, y1: sigmoidWCnyAmp * 100,
      line: { color: '#e05252', dash: 'dash', width: 1 } },
  ];

  const sigmoidAmpAnnotations = [
    { x: lines.buy, y: 97, text: `buy yuan only below ${lines.buy.toFixed(1)}`, showarrow: false, xanchor: 'right', xshift: -6,
      font: { color: '#3dd68c', size: 12 } },
    { x: lines.sell, y: 97, text: `sell yuan only above ${lines.sell.toFixed(1)}`, showarrow: false, xanchor: 'left', xshift: 6,
      font: { color: '#f0b429', size: 12 } },
    { x: sigmoidX, y: sigmoidWCnyAmp * 100, text: `w_CNY = ${(sigmoidWCnyAmp * 100).toFixed(0)}%`,
      showarrow: false, xanchor: 'left', xshift: 12, yshift: 10,
      font: { color: '#e05252', size: 13 } },
    { x: sigmoidM, y: sigmoidMWCnyAmp * 100, text: `m = ${sigmoidM.toFixed(2)}`,
      showarrow: false, xanchor: 'left', xshift: 12, yshift: -14,
      font: { color: '#a78bfa', size: 12 } },
  ];

  const sigmaStr = sigmoidSigma.toFixed(2);
  const winYears = WCNY.WIN / 365;   // 1
  document.getElementById('sigmoid_amp_note').innerHTML = `
    w_CNY(x) = ${WCNY.LO.toFixed(2)} + ${(WCNY.HI - WCNY.LO).toFixed(2)} / (1 + exp(k_eff·(x−m)/m)), k_eff = ${WCNY.K} · (σ₉₀/m) / ${WCNY.SIGMA_REF}
    (m = the ${winYears === 1 ? '' : `${winYears}-`}year average USD/RUB, currently <span class="stat">${sigmoidM.toFixed(2)}</span>;
    σ₉₀ = 90-day rolling std dev of the rate, currently <span class="stat">${sigmaStr}</span>).
    At typical volatility k_eff ≈ ${WCNY.K}; a sharp move steepens the curve.<br>
    <b>Gray dashed</b> — fixed k. <b>Purple</b> — the target curve.
    <b>Red</b> — current rate (x = <span class="stat">${sigmoidX.toFixed(2)}</span>) and resulting
    w_CNY = <span class="stat">${(sigmoidWCnyAmp * 100).toFixed(0)}%</span>,
    w_RUB = <span class="stat">${(sigmoidWRubAmp * 100).toFixed(0)}%</span>.
    <b>Green / orange lines</b> — yuan are bought (up to the target) only while USD/RUB is under
    m − ${WCNY.LINE_SIGMA}σ₉₀ − c = <span class="stat">${lines.buy.toFixed(2)}</span>
    and sold only while it's over m + ${WCNY.LINE_SIGMA}σ₉₀ − c = <span class="stat">${lines.sell.toFixed(2)}</span>;
    in between (gray) — nothing is bought or sold, whatever the target (yuan held as they are, new money into roubles).
    c = m × (key rate − PBoC rate) × ${WCNY.CARRY_DAYS}/365 = <span class="stat">${lines.shift.toFixed(2)}</span>
    (key rate − PBoC now: <span class="stat">${(wNow.carry * 100).toFixed(2)} pp</span>) — what yuan cost against roubles over ${WCNY.CARRY_DAYS} days.<br>
    Data as of ${dates5y[dates5y.length - 1]}. Set in one place (WCNY in the code): every tab uses it.
  `;

  // w_CNY(t) over the history, with the buy / sell lines
  const wCny5yDates = wSeries.map(p => p.date);
  // the days the rule lets yuan be bought (the dollar under the buy line) or
  // sold (over the sell one), as shaded spans
  const wCny5yZones = [];
  {
    let kind = null, from = null;
    const close = to => { if (kind) wCny5yZones.push({ type: 'rect', xref: 'x', yref: 'paper', x0: from, x1: to, y0: 0, y1: 1, layer: 'below', line: { width: 0 },
      fillcolor: kind === 'buy' ? 'rgba(61,214,140,0.15)' : 'rgba(240,180,41,0.13)' }); };
    wSeries.forEach((p, i) => {
      const l = wCnyLines(p), k = p.x < l.buy ? 'buy' : p.x > l.sell ? 'sell' : null;
      if (k !== kind) { close(p.date); kind = k; from = p.date; }
      if (i === wSeries.length - 1) close(p.date);
    });
  }
  const wCny5yCombined = [
    {
      x: wCny5yDates, y: wSeries.map(p => p.w * 100), name: 'w_CNY(t) — the target',
      type: 'scatter', mode: 'lines',
      line: { color: '#a78bfa', width: 2 },
      yaxis: 'y',
      hovertemplate: '%{x}<br>w_CNY: <b>%{y:.0f}%</b><extra></extra>',
    },
    // the buy / sell lines on the target's axis: the target the curve gives
    // at each line's rate -- the curve falls with the rate, so the target over
    // the green is the rate under the buy line (the same rule, read off purple)
    {
      x: wCny5yDates, y: wSeries.map(p => wCnyAmplified(wCnyLines(p).buy, p.m, p.sigma) * 100), name: 'buy yuan: purple above',
      type: 'scatter', mode: 'lines', line: { color: '#3dd68c', width: 1.2, dash: 'dash' }, yaxis: 'y',
      customdata: wSeries.map(p => wCnyLines(p).buy),
      hovertemplate: '%{x}<br>buy line: <b>%{y:.0f}%</b> (USD/RUB %{customdata:.2f})<extra></extra>',
    },
    {
      x: wCny5yDates, y: wSeries.map(p => wCnyAmplified(wCnyLines(p).sell, p.m, p.sigma) * 100), name: 'sell yuan: purple below',
      type: 'scatter', mode: 'lines', line: { color: '#f0b429', width: 1.2, dash: 'dash' }, yaxis: 'y',
      customdata: wSeries.map(p => wCnyLines(p).sell),
      hovertemplate: '%{x}<br>sell line: <b>%{y:.0f}%</b> (USD/RUB %{customdata:.2f})<extra></extra>',
    },
    {
      x: wCny5yDates, y: wSeries.map(p => p.x), name: 'USD/RUB rate',
      type: 'scatter', mode: 'lines',
      line: { color: '#9ca3af', width: 1 },
      opacity: 0.7,
      yaxis: 'y2',
      hovertemplate: '%{x}<br>USD/RUB: <b>%{y:.2f}</b><extra></extra>',
    },
  ];
  return { sigmoidAmp, sigmoidAmpShapes, sigmoidAmpAnnotations, wCny5yCombined, wCny5yZones,
    sigmoidAxisRange: [axisMin, axisMax], sigmoidWCnyAmp, sigmoidX };
}

// The Russian portfolio's target weights and stocks vs bonds split
// (target_weights.json, target_allocation.json): the donuts, their notes and
// tables written into the Layer 2 tab.
function ruTargetCharts(targetWeightsData, targetAllocationData, fundSectors) {
  // Target weights donut: angular width of each ticker's sector = its BASE
  // weight, radial extent = R_BASE * (target/base) (twDonut).
  const twRows = targetWeightsData.weights;
  const { traces: targetWeights, layout: targetWeightsLayout } = twDonut(twRows, TICKER_COLORS, 10);
  const { traces: ruSectors, layout: ruSectorsLayout } = sectorDonut(twRows, RU_SECTORS, fundSectors);

  document.getElementById('targetweights_note').innerHTML = `
    Each sector's <b>angular width</b> is its <b>base</b> (strategic) weight — so sectors tile the
    full circle like a normal portfolio donut, and even 1% positions show as thin slices. Every
    sector shares one common dotted <b>base reference circle</b>. The sector's <b>radial extent</b>
    shows its <b>target</b> weight after the Z-score correction
    (<code>base + 3&middot;sqrt(|Z|&minus;1.5)&middot;sign(Z)</code>, applied only when |Z| &gt; 1.5,
    then renormalized across all 10 positions to sum to 100%), relative to base.<br>
    Sector extends past the dotted circle → overweight vs base. Sector ends short of it → underweight vs base.<br>
    Data as of ${targetWeightsData.date} (updated ${targetWeightsData.updated}).
  `;

  document.getElementById('targetweights_table_wrap').innerHTML = twTableHtml(twRows, TICKER_COLORS);

  // Layer 2: Allocation target — stocks vs bonds split. Base share comes from
  // an inverse-logistic function of the CBR key rate; the same Z-gated
  // exponential correction used for tickers is applied here via composite_erp_z.
  // Same donut geometry as Target Weights: angular width = Base%, both
  // sectors share one common reference circle, radial extent = R_BASE *
  // (target/base) so over/underweight reads as protrude/retract vs that circle.
  const allocBase = { Stocks: targetAllocationData.base_stocks, Bonds: targetAllocationData.base_bonds };
  const allocTarget = { Stocks: targetAllocationData.target_stocks, Bonds: targetAllocationData.target_bonds };
  // Composite ERP Z is a single portfolio-wide reading — both rows show the
  // same value. Which side actually receives the correction depends on its
  // sign (positive -> Stocks, negative -> Bonds); the Adjustment column
  // (not Z) is what shows that asymmetry.
  const allocZ = { Stocks: targetAllocationData.z, Bonds: targetAllocationData.z };
  const allocAdjustment = { Stocks: targetAllocationData.stocks_adjustment, Bonds: targetAllocationData.bonds_adjustment };
  const allocNames = ['Stocks', 'Bonds'];
  const { traces: allocTargetTrace, layout: allocTargetLayout } = allocDonut(allocNames, allocBase, allocTarget, ALLOC_COLORS);

  const allocZStr = targetAllocationData.z !== null ? targetAllocationData.z.toFixed(2) : 'n/a';
  document.getElementById('alloc_target_note').innerHTML = `
    <b>Target allocation</b> — base stock share from the CBR key rate
    (<code>w(r) = 100 / (1 + e^((r&minus;${targetAllocationData.key_rate_midpoint})/${targetAllocationData.key_rate_slope}))</code>,
    r = <span class="stat">${targetAllocationData.key_rate.toFixed(2)}%</span>
    as of ${targetAllocationData.key_rate_date} → base = <span class="stat">${targetAllocationData.base_stocks.toFixed(1)}%</span> stocks),
    then the same Z-gated correction as the ticker weights applied via Composite ERP Z
    (<span class="stat">${allocZStr}</span>, ${targetAllocationData.signal}) →
    target = <span class="stat">${targetAllocationData.target_stocks.toFixed(1)}%</span> stocks /
    <span class="stat">${targetAllocationData.target_bonds.toFixed(1)}%</span> bonds.<br>
    Data as of ${targetAllocationData.date} (updated ${targetAllocationData.updated}).
  `;

  document.getElementById('alloc_target_table_wrap').innerHTML = allocTableHtml(allocNames, allocBase, allocTarget, allocZ,
    allocAdjustment, ALLOC_COLORS, { label: 'Key Rate', value: targetAllocationData.key_rate }, false);
  return { twRows, targetWeights, targetWeightsLayout, ruSectors, ruSectorsLayout, allocTargetTrace, allocTargetLayout, allocBase, allocTarget };
}

// Every chart of the valuation tabs from data/* (written there by the daily
// jobs), and the targets the My Portfolio pies compare against: DATA.
async function loadData() {
  const [rows, eyRows, usdRubRows, usdRubStats, usdRub5yRows, targetWeightsData, targetAllocationData, vkcoRows, vkcoRevenueRows, vkcoPredicted, usZscoreRows, usTargetWeightsData, usErpRows, usTargetAllocationData, damodaranErpRows] = await Promise.all([
    fetchCsv(`${DATA_DIR}/composite_valuation.csv`),
    fetchCsv(`${DATA_DIR}/erp_portfolio.csv`),
    fetchCsv(`${DATA_DIR}/usd_rub_history.csv`),
    fetchJson(`${DATA_DIR}/usd_rub_stats.json`),
    fetchCsv(`${DATA_DIR}/usd_rub_history_5y.csv`),
    fetchJson(`${DATA_DIR}/target_weights.json`),
    fetchJson(`${DATA_DIR}/target_allocation.json`),
    fetchCsv(`${DATA_DIR}/vkco_zscore.csv`),
    fetchCsv(`${DATA_DIR}/vkco_annual_revenue.csv`),
    fetchJson(`${DATA_DIR}/vkco_revenue_predicted.json`),
    fetchCsv(`${DATA_DIR}/us_zscore.csv`),
    fetchJson(`${DATA_DIR}/us_target_weights.json`),
    fetchCsv(`${DATA_DIR}/us_erp.csv`),
    fetchJson(`${DATA_DIR}/us_target_allocation.json`),
    fetchCsv(`${DATA_DIR}/damodaran_erp.csv`),
  ]);
  const usHist = await usAllocHistoryChart();
  const ruHist = await ruAllocHistoryChart();
  const ru = ruErpCharts(rows, eyRows, vkcoRows, vkcoRevenueRows, vkcoPredicted);
  const usZscore = usZscoreChart(usZscoreRows);
  const us = usErpCharts(usErpRows, damodaranErpRows);
  const usT = usTargetCharts(usTargetWeightsData, usTargetAllocationData);
  const sig = await sigmoidCharts(usdRubRows, usdRubStats, usdRub5yRows);
  const fundSectors = await fundSectorWeights(RU_SECTORS.Funds).catch(() => ({}));
  const ruT = ruTargetCharts(targetWeightsData, targetAllocationData, fundSectors);

  return { fundSectors, layer1: ru.layer1, layer1_individual: ru.layer1Individual, layer2_rebal: ru.layer2Rebal,
           layer2_alloc: ru.layer2Alloc, revYield: ru.revYield, fcfYield: ru.fcfYield, vkcoRevenueV2: ru.vkcoRevenueV2, usZscore,
           usTargetWeights: usT.usTargetWeights, usTargetWeightsLayout: usT.usTargetWeightsLayout,
           usSectors: usT.usSectors, usSectorsLayout: usT.usSectorsLayout,
           usErp: us.usErp, usErpZChart: us.usErpZChart, usErpDefaultRange: us.usErpDefaultRange, damodaranZChart: us.damodaranZChart,
           usAllocTarget: usT.usAllocTargetTrace, usAllocTargetLayout: usT.usAllocTargetLayout,
           usAllocHistory: usHist.usAllocHistory, usAllocHistoryRange: usHist.usAllocHistoryRange,
           ruAllocHistory: ruHist.ruAllocHistory, ruAllocHistoryRange: ruHist.ruAllocHistoryRange,
           usAllocTargetRaw: usT.usAllocTarget,
           sigmoidAmp: sig.sigmoidAmp, sigmoidAmpShapes: sig.sigmoidAmpShapes, sigmoidAmpAnnotations: sig.sigmoidAmpAnnotations,
           wCny5yCombined: sig.wCny5yCombined, wCny5yZones: sig.wCny5yZones,
           targetWeights: ruT.targetWeights, targetWeightsLayout: ruT.targetWeightsLayout, ruSectors: ruT.ruSectors, ruSectorsLayout: ruT.ruSectorsLayout, allocTarget: ruT.allocTargetTrace, allocTargetLayout: ruT.allocTargetLayout,
           sigmoidAxisRange: sig.sigmoidAxisRange,
           // Raw (non-chart-trace) target figures, reused by the My Portfolio
           // pie charts to compare against the user's actual holdings —
           // see mpRenderPortfolioPies().
           ruTargetWeightsRaw: ruT.twRows,
           usTargetWeightsRaw: usT.usTwRows,
           ruAllocTargetRaw: { base: ruT.allocBase, target: ruT.allocTarget },
           // The chart's actual displayed/current target (red dot + "w_CNY = NN%"
           // annotation on the sigmoid tab) is the volatility-amplified value,
           // NOT the plain fixed-k=15 wCny() -- using the latter here would
           // silently disagree with the number the user sees on that chart.
           currentWCny: sig.sigmoidWCnyAmp,
           ruTickerColors: TICKER_COLORS,
           usTickerColors: US_COLORS,
           currentUsdRub: sig.sigmoidX };
}

