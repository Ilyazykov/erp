// The Capital and Capital by broker tabs: the capital over time, by asset type
// and by broker, in a chosen currency.

// ---- Capital tab: capital_daily_total (nightly, update-capital-history) ----
let mpCapitalRows = null;
async function mpRenderCapital() {
  const status = document.getElementById('capital_status');
  const el = document.getElementById('plot_capital');
  if (!mpCapitalRows) {
    status.textContent = 'Loading…';
    const { rows, error } = await mpFetchAllRows(() => sb.from('capital_daily_total')
      .select('day, capital_usd, real_estate_usd').order('day'));
    if (error) { status.textContent = error.message; return; }
    mpCapitalRows = rows;
  }
  if (!mpCapitalRows.length) { status.textContent = 'No history yet — it is built nightly by update-capital-history.'; return; }
  const ccy = mpCapitalCcy();
  if (ccy === 'RUB' && !mpCapitalRub) {
    status.textContent = 'Loading RUB rates…';
    try { mpCapitalRub = await mpLoadRubRates(); }
    catch (error) { status.textContent = error.message; return; }
  }
  status.textContent = '';
  const conv = mpCapitalConverter(ccy);
  const days = mpCapitalRows.map(r => r.day);
  const capital = mpCapitalRows.map(r => conv(r.day, r.capital_usd));
  const showRe = document.getElementById('capital_show_re').checked;
  const hover = name => (ccy === 'RUB' ? '%{y:,.0f} ₽' : '$%{y:,.0f}') + `<extra>${name}</extra>`;
  const traces = [{ x: days, y: capital, name: 'Capital', type: 'scatter', mode: 'lines',
    line: { color: '#58a6ff', width: 2 }, hovertemplate: hover('Capital') }];
  if (showRe) {
    traces.push({ x: days, y: mpCapitalRows.map(r => conv(r.day, r.real_estate_usd)), name: 'Real estate',
      type: 'scatter', mode: 'lines', line: { color: '#d29922', width: 2 }, hovertemplate: hover('Real estate') });
    traces.push({ x: days, y: mpCapitalRows.map(r => conv(r.day, Number(r.capital_usd || 0) + Number(r.real_estate_usd || 0))),
      name: 'Capital + real estate', type: 'scatter', mode: 'lines', line: { color: '#8b949e', width: 1, dash: 'dot' },
      hovertemplate: hover('Total') });
  }
  await Plotly.react(el, traces, mpCapitalLayout(ccy), CONFIG);
  mpCapitalPeriod(days[0], days[days.length - 1]);
  if (!el.mpCapitalBound) {
    el.mpCapitalBound = true;
    el.on('plotly_relayout', ev => {
      const a = ev['xaxis.range[0]'] ?? ev['xaxis.range']?.[0];
      const b = ev['xaxis.range[1]'] ?? ev['xaxis.range']?.[1];
      if (a && b) mpCapitalPeriod(String(a).slice(0, 10), String(b).slice(0, 10));
      else if (ev['xaxis.autorange']) mpCapitalPeriod(days[0], days[days.length - 1]);
    });
  }
  await mpRenderCapitalTypes(ccy, conv);
}

function mpCapitalLayout(ccy, extra = {}) {
  return Object.assign({}, LAYOUT_BASE, {
    xaxis: Object.assign({}, LAYOUT_BASE.xaxis, { type: 'date', dtick: undefined, tickformat: undefined,
      rangeslider: { visible: true, bgcolor: '#13191f', bordercolor: '#1e2830' },
      rangeselector: { bgcolor: '#13191f', activecolor: '#1f6feb', font: { color: '#c9d1d9' }, buttons: [
        { count: 1, label: '1M', step: 'month', stepmode: 'backward' },
        { count: 3, label: '3M', step: 'month', stepmode: 'backward' },
        { count: 6, label: '6M', step: 'month', stepmode: 'backward' },
        { count: 1, label: 'YTD', step: 'year', stepmode: 'todate' },
        { count: 1, label: '1Y', step: 'year', stepmode: 'backward' },
        { count: 2, label: '2Y', step: 'year', stepmode: 'backward' },
        { count: 3, label: '3Y', step: 'year', stepmode: 'backward' },
        { step: 'all', label: 'All' },
      ] } }),
    yaxis: Object.assign({}, LAYOUT_BASE.yaxis, ccy === 'RUB'
      ? { title: 'RUB', tickformat: ',.0f', ticksuffix: ' ₽', autorange: true, fixedrange: false }
      : { title: 'USD', tickformat: '$,.0f', autorange: true, fixedrange: false }),
    margin: { t: 40, r: 20, b: 40, l: 80 },
  }, extra);
}

// ---- Capital by asset type (capital_daily_by_type): stacked areas ----
let mpCapitalTypeRows = null;
const MP_CAPITAL_TYPES = ['cash', 'liquid', 'deposit', 'gold', 'bond', 'stock', 'crypto'];
const MP_CAPITAL_TYPE_COLORS = Object.assign({}, MP_COLORS.type, {
  liquid: '#b8b8bd',     // a lighter grey than deposits: the two sit next to each other here
  crypto: '#ff9f1a',     // orange: the pies' red merges with stocks' crimson when stacked on it
  negative: '#a855f7',   // debt beyond everything it could be netted against
});
// A day's buckets with credit netted within each infrastructure first
// (Russian debt against Russian holdings, as the tables do): against liquid
// assets, then cash, bonds, stocks. Whatever that leaves is netted against
// the other infrastructure's holdings the same way; only what's still left
// is `negative`. A type below zero counts as debt too -- a broker's cash
// goes negative between a withdrawal and the settlement of the sale that
// paid for it (the shares still held till then).
function mpCapitalTypeBuckets(r) {
  const v = {}, debt = {};
  for (const p of ['ru', 'fx']) {
    v[p] = Object.fromEntries(MP_CAPITAL_TYPES.map(t => [t, Number(r[`${p}_${t}`] || 0)]));
    debt[p] = -Math.min(0, Number(r[`${p}_credit`] || 0));
    for (const t of MP_CAPITAL_TYPES) if (v[p][t] < 0) { debt[p] -= v[p][t]; v[p][t] = 0; }
  }
  const net = (p, d) => {
    for (const t of ['liquid', 'cash', 'bond', 'stock']) {
      const take = Math.min(v[p][t], d);
      v[p][t] -= take; d -= take;
    }
    return d;
  };
  const left = { ru: net('ru', debt.ru), fx: net('fx', debt.fx) };
  const beyond = net('fx', left.ru) + net('ru', left.fx);
  const out = Object.fromEntries(MP_CAPITAL_TYPES.map(t => [t, v.ru[t] + v.fx[t]]));
  out.negative = -beyond;
  return out;
}
// Plotly always draws gridlines under the traces: the stacked areas would
// hide them. So dotted lines at the ticks Plotly placed, drawn as shapes
// above the areas, as in the spreadsheet's chart.
function mpGridOverAreas(el) {
  const fl = el._fullLayout;
  if (!fl?.xaxis?._vals || !fl?.yaxis?._vals) return;
  const line = { color: 'rgba(13, 17, 23, 0.18)', width: 1, dash: 'dot' };
  const shapes = [
    ...fl.xaxis._vals.map(v => ({ type: 'line', layer: 'above', xref: 'x', yref: 'paper', x0: v.x, x1: v.x, y0: 0, y1: 1, line })),
    ...fl.yaxis._vals.map(v => ({ type: 'line', layer: 'above', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: v.x, y1: v.x, line })),
  ];
  Plotly.relayout(el, { shapes });
}
// A capital chart of stacked areas (by type, by broker): its dotted y grid (in
// % of the total when `pct`), drawn, the grid laid over the areas, and again
// on zoom / range buttons / resize (not on its own shapes update).
async function mpDrawAreas(el, traces, layout, pct) {
  layout.yaxis = Object.assign({}, layout.yaxis, { griddash: 'dot' },
    pct ? { title: '% of the total', tickformat: '.0f', ticksuffix: '%', tickprefix: '', range: [0, 100], autorange: false } : {});
  await Plotly.react(el, traces, layout, CONFIG);
  mpGridOverAreas(el);
  if (!el.mpGridBound) {
    el.mpGridBound = true;
    el.on('plotly_relayout', ev => {
      if (Object.keys(ev).some(k => /^(xaxis|yaxis|autosize)/.test(k))) mpGridOverAreas(el);
    });
  }
}
async function mpRenderCapitalTypes(ccy, conv) {
  const el = document.getElementById('plot_capital_types');
  if (!mpCapitalTypeRows) {
    const { rows, error } = await mpFetchAllRows(() => sb.from('capital_daily_by_type').select('*').order('day'));
    if (error) { el.textContent = error.message; return; }
    mpCapitalTypeRows = rows;
  }
  if (!mpCapitalTypeRows.length) return;
  const days = mpCapitalTypeRows.map(r => r.day);
  const buckets = mpCapitalTypeRows.map(mpCapitalTypeBuckets);
  const pct = document.getElementById('capital_types_pct').checked;
  const withRe = document.getElementById('capital_types_re').checked;
  const money = pct ? '%{y:.1f}%' : ccy === 'RUB' ? '%{y:,.0f} ₽' : '$%{y:,.0f}';
  const area = (key, label, ys, group) => ({
    x: days, y: ys, name: label, type: 'scatter', mode: 'lines', stackgroup: group,
    // no outline: a type at zero would still draw its line along the stack's top
    line: { width: 0, color: MP_CAPITAL_TYPE_COLORS[key] }, fillcolor: MP_CAPITAL_TYPE_COLORS[key],
    hovertemplate: `${money}<extra>${label}</extra>`,
  });
  // bottom to top: the more rarely a type jumps, the lower -- bonds and gold
  // drift, crypto swings but is seldom bought, stocks grow with every purchase,
  // liquid assets and cash move with every transfer. Deposits (the box): right
  // under liquid assets, with the money at hand, or at the bottom, as they sit still
  const order = document.getElementById('capital_types_dep').checked
    ? ['bond', 'gold', 'crypto', 'stock', 'deposit', 'liquid', 'cash']
    : ['deposit', 'bond', 'gold', 'crypto', 'stock', 'liquid', 'cash'];
  const series = [];
  if (withRe) series.push(['real_estate', MP_ASSET_CLASS_LABELS.real_estate, mpCapitalTypeRows.map(r => conv(r.day, r.real_estate))]);
  for (const t of order) series.push([t, MP_ASSET_CLASS_LABELS[t], buckets.map((b, i) => conv(days[i], b[t]))]);
  // as %: each type's share of the day's holdings (the debt left over, if
  // any, isn't a holding -- it's not drawn then)
  const totals = days.map((_, i) => series.reduce((a, [, , ys]) => a + Math.max(0, ys[i]), 0));
  const traces = series.map(([key, label, ys]) =>
    area(key, label, pct ? ys.map((y, i) => (totals[i] > 0 ? 100 * Math.max(0, y) / totals[i] : 0)) : ys, 'assets'));
  if (!pct && buckets.some(b => b.negative < -0.5)) {
    traces.push(area('negative', 'debt beyond assets 🔻', buckets.map((b, i) => conv(days[i], b.negative)), 'debt'));
  }
  const layout = mpCapitalLayout(ccy, { hovermode: 'x unified' });
  layout.xaxis = Object.assign({}, layout.xaxis, { griddash: 'dot' });
  await mpDrawAreas(el, traces, layout, pct);
}
try {
  document.getElementById('capital_types_pct').checked = localStorage.getItem('mp_capital_types_pct') === '1';
  document.getElementById('capital_types_dep').checked = localStorage.getItem('mp_capital_types_dep') !== '0';
} catch { /* no storage */ }
for (const id of ['capital_types_re', 'capital_types_pct', 'capital_types_dep']) {
  document.getElementById(id).addEventListener('change', () => {
    mpSave('mp_capital_types_pct', document.getElementById('capital_types_pct').checked ? '1' : '0');
    mpSave('mp_capital_types_dep', document.getElementById('capital_types_dep').checked ? '1' : '0');
    if (mpIsSignedIn) mpRenderCapitalTypes(mpCapitalCcy(), mpCapitalConverter(mpCapitalCcy()));
  });
}
// ---- Capital by broker tab (capital_daily_by_account): stacked areas ----
let mpCapitalBrokerRows = null;
// "Only what is known exactly": per account, the stretches [from, to) to blank --
// cash before its first count (all before is reconstructed), and a bank from its
// first synthetic row (extrapolated / data gap) to its next real transaction.
let mpExactMask = null;
async function mpLoadExactMask() {
  const mask = {};
  const add = (a, from, to) => (mask[a] = mask[a] || []).push([from, to]);
  const { data: cnt, error: e1 } = await sb.from('bank_transactions').select('tx_date')
    .like('external_source', 'cash_csv:%').eq('synthetic_kind', 'balance_snapshot').ilike('description', 'Cash on hand count%')
    .order('tx_date').limit(1);
  if (e1) throw e1;
  add('cash', '0000-01-01', cnt && cnt.length ? cnt[0].tx_date.slice(0, 10) : '9999-12-31');
  const { rows: synRows, error: synError } = await mpFetchAllRows(() => sb.from('bank_transactions').select('account, tx_date, external_source')
    .in('synthetic_kind', ['extrapolated', 'data_gap']).not('external_source', 'like', 'cash_csv:%')
    .order('tx_date'));
  if (synError) throw synError;
  const syn = synRows.map(r => ({ ...r, tx_date: r.tx_date.slice(0, 10) }));
  const bySrc = new Map();
  for (const r of syn) { if (!bySrc.has(r.external_source)) bySrc.set(r.external_source, []); bySrc.get(r.external_source).push(r); }
  const nextDay = d => mpDayShift(d, 1);
  for (const [src, rs] of bySrc) {
    // past the last statement row only synthetic rows: blank from the day after it
    const { data: lr, error: el } = await sb.from('bank_transactions').select('tx_date').eq('external_source', src)
      .is('synthetic_kind', null).order('tx_date', { ascending: false }).limit(1);
    if (el) throw el;
    const lastReal = lr && lr.length ? lr[0].tx_date.slice(0, 10) : '0000-01-01';
    if (rs.some(r => r.tx_date > lastReal)) add(rs[0].account, nextDay(lastReal), '9999-12-31');
    let i = 0;
    while (i < rs.length && rs[i].tx_date <= lastReal) {
      const start = rs[i].tx_date;
      const { data: nx, error } = await sb.from('bank_transactions').select('tx_date').eq('external_source', src)
        .is('synthetic_kind', null).gt('tx_date', start).order('tx_date').limit(1);
      if (error) throw error;
      const end = nx && nx.length ? nx[0].tx_date.slice(0, 10) : '9999-12-31';
      add(rs[i].account, start, end);
      while (i < rs.length && rs[i].tx_date < end) i++;
    }
  }
  return mask;
}
// The least cash on hand (USD) on each day before the first cash count: walking
// back from the count, every exact cash payment (cash_csv:on_hand, not synthetic
// -- a purchase known with its price and on no card) must have been held since
// the withdrawal that paid for it. An exact cash inflow lowers that need by its
// amount; an inflow of an approximate amount (estimated / extrapolated) ends it,
// since nothing proves how much came in. Approximate spending is left out. Kept
// in USD across currencies, so an unrecorded exchange changes nothing. An inflow
// whose amount is known though its day is not (the salary in cash) lowers the
// need like an exact one. The flat
// rent counts too where only its amount is uncertain (the rent went up at an
// unknown date): at the lowest rent known exactly in that currency.
// Returned twice: `strict` as above, and `events` -- the same walk taking in
// also everything that surely happened at an approximate amount (estimated,
// cash_csv:estimated: spending at its estimate, an inflow lowering the need by
// its estimate); only the purely extrapolated rows stay out.
let mpProvenCash = null;
async function mpLoadProvenCash(cashOnDay) {
  const { data: cnt, error: e1 } = await sb.from('bank_transactions').select('tx_date')
    .like('external_source', 'cash_csv:%').eq('synthetic_kind', 'balance_snapshot').ilike('description', 'Cash on hand count%')
    .order('tx_date').limit(1);
  if (e1) throw e1;
  if (!cnt || !cnt.length) return { strict: {}, events: {} };
  const countDay = cnt[0].tx_date.slice(0, 10);
  const { rows: ev, error: evError } = await mpFetchAllRows(() => sb.from('bank_transactions').select('tx_date, amount, currency, synthetic_kind, external_source, description, amount_approximate')
    .like('external_source', 'cash_csv:%').lte('tx_date', countDay + 'T23:59:59Z').order('tx_date'));
  if (evError) throw evError;
  const rates = {};
  for (const c of new Set(ev.map(r => r.currency))) {
    if (c === 'USD') continue;
    const { rows, error } = await mpFetchAllRows(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', c).order('day'));
    if (error) throw error;
    rates[c] = rows.map(r => [r.day, Number(r.usd_per_unit)]);
  }
  const usd = (c, day, a) => {
    if (c === 'USD') return a;
    const rs = rates[c] || [];
    if (!rs.length) return NaN;
    let lo = 0, hi = rs.length - 1, rate = rs[0][1];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rs[mid][0] <= day) { rate = rs[mid][1]; lo = mid + 1; } else hi = mid - 1; }
    return a * rate;
  };
  const isExact = r => r.external_source === 'cash_csv:on_hand' && !r.synthetic_kind;
  const isRent = r => /^Paid the flat rent/.test(r.description || '');
  const minRent = {};
  for (const r of ev) {
    if (isExact(r) && isRent(r) && Number(r.amount) < 0) minRent[r.currency] = Math.min(minRent[r.currency] ?? Infinity, -Number(r.amount));
  }
  const byDay = new Map();
  for (const r of ev) {
    if (r.synthetic_kind === 'balance_snapshot') continue;
    const d = r.tx_date.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const isEvent = r => r.external_source === 'cash_csv:estimated';
  const days = [...byDay.keys()].sort().reverse();
  const walk = loose => {
    const out = {};
    let need = cashOnDay(countDay);
    let k = 0;
    // need at the end of day d = need before the first event of the next day with events
    for (let t = Date.parse(countDay + 'T00:00:00Z'); k < days.length; t -= 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      // never more than the whole cash ledger holds that day: below zero (money
      // borrowed and put on a card, 2021) the need is none, and isn't carried back
      // to the first cash row as cash out of nowhere
      if (d < countDay) out[d] = need = Math.min(need, Math.max(0, cashOnDay(d)));
      if (k < days.length && days[k] === d) {
        for (const r of byDay.get(d).slice().reverse()) {
          // an exchange within the cash (both legs here, in USD it nets out) brings no new money in
          if (!isExact(r) && /^Exchanged .* in cash/.test(r.description || '')) continue;
          const a = Number(r.amount), exact = isExact(r);
          const v = usd(r.currency, d, Math.abs(a));
          if (!Number.isFinite(v)) { need = 0; continue; }
          const known = exact || (loose && isEvent(r));
          if (a < 0) {
            if (known) need += v;
            else if (isRent(r) && minRent[r.currency]) need += usd(r.currency, d, Math.min(-a, minRent[r.currency]));
          } else need = known || r.amount_approximate === false ? Math.max(0, need - v) : 0;
        }
        k++;
      }
    }
    return out;
  };
  return { strict: walk(false), events: walk(true) };
}
const MP_BROKER_FALLBACK_COLORS = ['#7b8494', '#c08457', '#6fa8ff', '#ff7eb6', '#00b86b', '#ffd000', '#9b6bff', '#ff6a13'];
// What the broker chart and a bank's window both need: the daily history, which days are estimates, and
// how a day's value splits into exact, known at an approximate amount, and estimated.
async function mpEnsureBrokerRows() {
  if (mpCapitalBrokerRows) return;
  const { rows, error } = await mpFetchAllRows(() => sb.from('capital_daily_by_account').select('day, accounts, real_estate').order('day'));
  if (error) throw error;
  mpCapitalBrokerRows = rows;
}
async function mpEnsureExactData(proven) {
  if (!mpExactMask) mpExactMask = await mpLoadExactMask();
  if (proven && !mpProvenCash) {
    const cashOn = new Map(mpCapitalBrokerRows.map(r => [r.day, Number((r.accounts || {}).cash || 0)]));
    mpProvenCash = await mpLoadProvenCash(day => cashOn.get(day) || 0);
  }
}
// the Total row of the broker tables: every bank and broker together, without real estate
const MP_ALL_ACCOUNTS = '__all__';
const mpAccountFull = (a, r) => (a === MP_ALL_ACCOUNTS
  ? Object.values(r.accounts || {}).reduce((sum, v) => sum + Number(v || 0), 0)
  : Number((a === 'real estate' ? r.real_estate : (r.accounts || {})[a]) || 0));
const mpAccountMasked = (a, day) => (mpExactMask[a] || []).some(([f, t]) => f <= day && day < t);
// exact: blank where it's an estimate; cash with `proven`: there the least it must have been
const mpAccountExact = (a, r, proven) => (!mpAccountMasked(a, r.day) ? mpAccountFull(a, r)
  : a === 'cash' && proven ? mpProvenCash.strict[r.day] || 0 : 0);
// cash: what surely happened, at approximate amounts
const mpAccountKnown = (a, r) => (mpAccountMasked(a, r.day) ? mpProvenCash.events[r.day] || 0 : mpAccountFull(a, r));
const mpFade = (c, alpha) => (/^#[0-9a-f]{6}$/i.test(c) ? `rgba(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)}, ${alpha})` : c);
// The stacked parts of a value: solid (exact), known (half-faded), extrapolated (faded); null where there's none.
function mpEstimateLayers(exact, full, known) {
  const pos = y => Math.max(0, y);
  const solid = exact.map(pos);
  const m = known ? known.map((v, i) => Math.min(pos(full[i]), Math.max(pos(v), solid[i]))) : solid;
  const above = (lo, hi) => hi.map((h, i) => Math.max(0, h - lo[i]));
  return {
    solid,
    known: known && m.some((v, i) => v - solid[i] > 0.5) ? above(solid, m) : null,
    extrapolated: full.some((f, i) => pos(f) - m[i] > 0.5) ? above(m, full.map(pos)) : null,
  };
}
// the stacked layers' lowest and highest, with a margin (a debt is stacked down from zero)
function mpAccountYRange(layers) {
  let hi = -Infinity, lo = Infinity;
  layers[0].x.forEach((_, i) => {
    let up = 0, down = 0;
    for (const t of layers) { if (t.stackgroup === 'assets') up += t.y[i] || 0; else down += t.y[i] || 0; }
    hi = Math.max(hi, up);
    lo = Math.min(lo, down < 0 ? down : up);
  });
  if (!Number.isFinite(hi)) return null;
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad];
}

// One account's history by currency, split as the Currencies pie is: {label, byDay: Map(day number -> USD)},
// the largest first, the small non-main ones under "other". null until the migration is there (the chart is then one colour).
const mpAccountSeries = new Map();
const mpDayNumber = day => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.UTC(2000, 0, 1)) / 864e5);
async function mpAccountCurrencySeries(account) {
  if (mpAccountSeries.has(account)) return mpAccountSeries.get(account);
  const { data, error } = await sb.rpc('capital_account_series', { p_account: account });
  if (error || !data?.length) return null;
  const parts = (await mpSplitFundsByCurrency(data.map(s => ({ ...s, value_usd: 1 })))).map(mpCurrencyColumn);
  const add = (m, d, v) => m.set(d, (m.get(d) || 0) + v);
  const byLabel = new Map();
  for (const p of parts) {
    const label = mpCurrencySliceLabel(p);
    if (!byLabel.has(label)) byLabel.set(label, { byDay: new Map(), cashByDay: new Map() });
    const c = byLabel.get(label);
    // the "cash" account's part (its tickers end in :cash), for the Total to fade on the days it's an estimate
    const isCash = /^CASH:.*:cash$/.test(p.ticker);
    p.days.forEach((d, i) => {
      const v = Number(p.amounts[i]) * p.value_usd;
      add(c.byDay, d, v);
      if (isCash) add(c.cashByDay, d, v);
    });
  }
  const ranked = [...byLabel].map(([label, c]) => ({ label, ...c, size: [...c.byDay.values()].reduce((s, v) => s + Math.abs(v), 0) }))
    .sort((a, b) => b.size - a.size);
  // the main currencies, gold, BTC and ETH always on their own, however small; the rest up to 8 layers, then "other"
  const named = new Set(ranked.filter(r => MP_MAIN_CURRENCIES.has(r.label.split(' ')[0]) || ['XAU', 'BTC', 'ETH'].includes(r.label.split(' ')[0])));
  for (const r of ranked) { if (named.size >= 8) break; named.add(r); }
  const out = ranked.filter(r => named.has(r));
  const rest = ranked.filter(r => !named.has(r));
  if (rest.length) {
    const byDay = new Map(), cashByDay = new Map();
    for (const r of rest) {
      for (const [d, v] of r.byDay) add(byDay, d, v);
      for (const [d, v] of r.cashByDay) add(cashByDay, d, v);
    }
    out.push({ label: 'other', byDay, cashByDay });
  }
  mpAccountSeries.set(account, out);
  return out;
}

// A bank's or broker's money over time, in a chart window (a click on its name in the broker tables);
// MP_ALL_ACCOUNTS (a click on Total): all of them together, by currency too.
async function mpOpenAccountChart(account) {
  const { dlg, head, plot, note } = mpChartDialog('mp_account', account === MP_ALL_ACCOUNTS ? 'All banks and brokers' : mpEscapeHtml(MP_BROKER_SHORT_NAMES[account] || account),
    `<label style="margin-left:12px"><input type="checkbox" id="mp_account_rub"> in RUB</label>
     <label style="margin-left:12px;display:none" id="mp_account_fade_box"><input type="checkbox" id="mp_account_fade"> grey out estimates</label>`);
  const rubBox = dlg.querySelector('#mp_account_rub');
  // estimates greyed out or drawn like the rest (remembered); the box where there are any
  const fadeBox = dlg.querySelector('#mp_account_fade');
  try { fadeBox.checked = localStorage.getItem('mp_account_fade') !== '0'; } catch { fadeBox.checked = true; }
  try {
    await mpEnsureBrokerRows();
    await mpEnsureExactData(account === 'cash');
  } catch (error) { note.textContent = error.message; return; }
  // the split by currency, once more if the database was busy (a capital recount running); without it, one colour
  const loadSeries = () => mpAccountCurrencySeries(account).catch(() => null);
  const series = await loadSeries() ?? await new Promise(ok => setTimeout(ok, 1500)).then(loadSeries);
  const firstHeld = mpCapitalBrokerRows.findIndex(r => Math.abs(mpAccountFull(account, r)) >= 1);
  if (firstHeld < 0) { note.textContent = 'No history for this account.'; return; }
  const rows = mpCapitalBrokerRows.slice(firstHeld);
  const today = rows[rows.length - 1].day;
  const color = MP_COLORS.broker[account] || (account === 'real estate' ? MP_COLORS.type.real_estate : '#4a9ff5');
  if (mpExactMask[account === MP_ALL_ACCOUNTS ? 'cash' : account]?.length) dlg.querySelector('#mp_account_fade_box').style.display = '';
  let period = '1y';
  const draw = () => {
    const rub = rubBox.checked, conv = mpCapitalConverter(rub ? 'RUB' : 'USD'), fadeOn = fadeBox.checked;
    // a period is the whole period, at zero before the account's first money; "all" starts at that first money
    const from = mpPeriodStart(period, rows[0].day, today);
    const shown = mpCapitalBrokerRows.filter(r => r.day >= from);
    const days = shown.map(r => r.day), full = shown.map(r => conv(r.day, mpAccountFull(account, r)));
    const parts = mpEstimateLayers(shown.map(r => conv(r.day, mpAccountExact(account, r, true))), full,
      account === 'cash' ? shown.map(r => conv(r.day, mpAccountKnown(account, r))) : null);
    // a small account (Binance's few dollars) in cents, and its small coins drawn too
    const cents = Math.max(...full.map(Math.abs)) < 100;
    const tiny = cents ? 0.005 : 0.5;
    const amount = v => Math.abs(v).toLocaleString('en-US', cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
    const fmt = v => (rub ? `${v < 0 ? '−' : ''}${amount(v)} ₽` : `${v < 0 ? '−' : ''}$${amount(v)}`);
    const area = (y, fillcolor, stackgroup = 'assets', extra = {}) => ({ x: days, y, type: 'scatter', mode: 'lines', stackgroup,
      // (the Total in steps: a slope between a faded day and a solid one would draw a spike at the first cash count)
      line: { width: 0, color: fillcolor, shape: account === MP_ALL_ACCOUNTS ? 'hv' : 'linear' }, fillcolor, hoverinfo: 'skip', showlegend: false, ...extra });
    const layers = [];
    let hover = full.map((v, i) => `${fmt(v)}${fadeOn && Math.max(0, v) - parts.solid[i] > 0.5 ? ` (exact: ${fmt(parts.solid[i])})` : ''}`);
    let shapes = [], cashEstimated = false;
    if (series) {
      // by currency; an account's days that are estimates shaded over all of them
      const nums = shown.map(r => mpDayNumber(r.day));
      const lines = series.map(c => {
        const y = shown.map((r, i) => conv(r.day, c.byDay.get(nums[i]) || 0));
        // the Total: the cash of the days it's an estimate, faded on top of the stack
        const est = shown.map((r, i) => (fadeOn && account === MP_ALL_ACCOUNTS && mpAccountMasked('cash', r.day)
          ? Math.min(Math.max(0, y[i]), Math.max(0, conv(r.day, c.cashByDay.get(nums[i]) || 0))) : 0));
        return { label: c.label, color: mpSliceColor(c.label, mpCurrencyColor), y, est };
      }).filter(c => c.y.some(v => Math.abs(v) >= tiny));
      for (const c of lines) layers.push(area(c.y.map((v, i) => Math.max(0, v) - c.est[i]), c.color, 'assets', { name: c.label, legendgroup: c.label, showlegend: lines.length > 1 }));
      for (const c of lines) if (c.est.some(v => v >= tiny)) {
        cashEstimated = true;
        layers.push(area(c.est, mpFade(c.color, 0.45), 'assets', { name: `${c.label} (estimate)`, legendgroup: c.label }));
      }
      for (const c of lines) if (c.y.some(v => v < -tiny)) layers.push(area(c.y.map(v => Math.min(0, v)), c.color, 'debt', { name: c.label, legendgroup: c.label }));
      hover = days.map((_, i) => `<b>${fmt(full[i])}</b>${lines.map(c => [c, c.y[i]]).filter(([, v]) => Math.abs(v) >= tiny).sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `<br><span style="color:${c.color}">■</span> ${mpEscapeHtml(c.label)}: ${fmt(v)}${c.est[i] >= tiny ? ` (estimate: ${fmt(c.est[i])})` : ''}`).join('')}`);
      shapes = (fadeOn ? mpExactMask[account] || [] : []).filter(([f, t]) => t > days[0] && f <= days[days.length - 1])
        .map(([f, t]) => ({ type: 'rect', xref: 'x', yref: 'paper', x0: f < days[0] ? days[0] : f, x1: t > days[days.length - 1] ? days[days.length - 1] : t,
          y0: 0, y1: 1, fillcolor: 'rgba(13,17,23,0.55)', line: { width: 0 }, layer: 'above' }));
    } else {
      layers.push(area(fadeOn ? parts.solid : full.map(v => Math.max(0, v)), color));
      if (fadeOn && parts.known) layers.push(area(parts.known, mpFade(color, 0.75)));
      if (fadeOn && parts.extrapolated) layers.push(area(parts.extrapolated, mpFade(color, 0.45)));
      if (full.some(v => v < -0.5)) layers.push(area(full.map(v => Math.min(0, v)), color, 'debt'));
    }
    const first = full[0], last = full[full.length - 1], diff = last - first;
    const pct = first > 0 ? ` · ${diff >= 0 ? '+' : ''}${(diff / first * 100).toFixed(1)}%` : '';
    head.innerHTML = `<span style="font-size:2em;font-weight:700">${fmt(last)}</span><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}${pct}</span><span class="muted">over ${period}</span>`;
    // several layers are read as shares of the stack: from zero, or the lowest would be cut off; one is fitted
    const fit = mpAccountYRange(layers);
    const yRange = fit && layers.filter(t => t.showlegend).length > 1 ? [Math.min(0, fit[0]), fit[1]] : fit;
    Plotly.react(plot, [...layers, { x: days, y: full, type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false,
      text: hover, hovertemplate: '%{x}:<br>%{text}<extra></extra>' }],
    Object.assign({}, LAYOUT_BASE, { showlegend: layers.some(t => t.showlegend), hovermode: 'x', shapes,
      xaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', type: 'date', tickangle: -45, range: [days[0], days[days.length - 1]], hoverformat: '%d %b %Y' },
      yaxis: Object.assign({}, LAYOUT_BASE.yaxis, rub ? { tickformat: cents ? ',.2~f' : ',.0f', ticksuffix: ' ₽' } : { tickformat: cents ? '$,.2~f' : '$,.0f' }, yRange ? { range: yRange, autorange: false } : {}),
      margin: { t: 10, r: 20, b: 60, l: 80 } }), CONFIG);
    note.textContent = `${!fadeOn ? '' : cashEstimated ? 'Faded: estimated cash. ' : parts.known || parts.extrapolated ? `${series ? 'Shaded' : 'Faded'}: estimates. ` : ''}Includes money moved in and out, not only gains.`;
  };
  mpBindPeriods(dlg, p => { period = p; draw(); });
  fadeBox.onchange = () => { mpSave('mp_account_fade', fadeBox.checked ? '1' : '0'); draw(); };
  rubBox.onchange = async () => {
    if (rubBox.checked && !mpCapitalRub) {
      note.textContent = 'Loading RUB rates…';
      try { mpCapitalRub = await mpLoadRubRates(); } catch (error) { rubBox.checked = false; note.textContent = error.message; return; }
    }
    draw();
  };
  draw();
}

async function mpRenderCapitalBrokers() {
  const status = document.getElementById('brokers_status');
  const el = document.getElementById('plot_capital_brokers');
  const ccy = document.getElementById('brokers_ccy').value === 'RUB' ? 'RUB' : 'USD';
  if (!mpCapitalBrokerRows) {
    status.textContent = 'Loading…';
    try { await mpEnsureBrokerRows(); } catch (error) { status.textContent = error.message; return; }
  }
  if (ccy === 'RUB' && !mpCapitalRub) {
    status.textContent = 'Loading RUB rates…';
    try { mpCapitalRub = await mpLoadRubRates(); } catch (error) { status.textContent = error.message; return; }
  }
  if (!mpCapitalBrokerRows.length) { status.textContent = 'No history yet.'; return; }
  status.textContent = '';
  const conv = mpCapitalConverter(ccy);
  const rows = mpCapitalBrokerRows, days = rows.map(r => r.day);
  const pct = document.getElementById('brokers_pct').checked;
  const withRe = document.getElementById('brokers_re').checked;
  const mode = document.getElementById('brokers_exact').value;
  const exact = mode !== 'all';
  const proven = mode === 'proven' || mode === 'both';
  if (exact && (!mpExactMask || (proven && !mpProvenCash))) {
    status.textContent = 'Loading…';
    try { await mpEnsureExactData(proven); } catch (error) { status.textContent = error.message; return; }
    status.textContent = '';
  }
  const value = (a, r) => (mode === 'all' ? mpAccountFull(a, r) : mpAccountExact(a, r, proven));
  // accounts, the one holding money earliest at the bottom
  const first = new Map();
  rows.forEach((r, i) => Object.entries(r.accounts || {}).forEach(([a, v]) => {
    if (Math.abs(Number(v)) >= 1 && !first.has(a)) first.set(a, i);
  }));
  // ... except these, top down: cash, TBC, BoC, Revolut, IBKR, Freedom, UniCredit,
  // T-Bank, Sber, Finuslugi, Ozon, Yandex, Alfa -- then the rest -- then
  // Raiffeisen and Ziraat at the very bottom
  const BOTTOM = ['Ziraat Bank', 'Raiffeisen'];
  const TOP = ['Alfa', 'Yandex Bank', 'Ozon Bank', 'Finuslugi', 'Sber', 'T-Bank', 'UniCredit', 'Freedom24', 'IBKR', 'Revolut', 'Bank of Cyprus', 'TBC Bank', 'cash'];
  const rank = a => (BOTTOM.includes(a) ? BOTTOM.indexOf(a) - BOTTOM.length : TOP.indexOf(a) + 1);
  const accounts = [...first.keys()].sort((a, b) => rank(a) - rank(b) || first.get(a) - first.get(b));
  let fallback = 0;
  const color = a => MP_COLORS.broker[a] || MP_BROKER_FALLBACK_COLORS[fallback++ % MP_BROKER_FALLBACK_COLORS.length];
  const series = [];
  if (withRe) series.push(['real estate 🏠', MP_COLORS.type.real_estate, rows.map(r => conv(r.day, r.real_estate))]);
  // 'both': each bank as its proven part, then what the estimates add on top of it
  // (faded) -- the 4th entry; the full value drives the totals and the debt
  for (const a of accounts) {
    const full = mode === 'both' ? rows.map(r => conv(r.day, mpAccountFull(a, r))) : null;
    // cash: the middle layer -- what surely happened, at approximate amounts
    const mid = mode === 'both' && a === 'cash'
      ? rows.map(r => conv(r.day, mpAccountKnown(a, r))) : null;
    series.push([MP_BROKER_SHORT_NAMES[a] || a, color(a), rows.map(r => conv(r.day, value(a, r))), full, mid]);
  }
  const top = ([, , ys, full], i) => (full ? full[i] : ys[i]);
  const totals = days.map((_, i) => series.reduce((s, x) => s + Math.max(0, top(x, i)), 0));
  const money = pct ? '%{y:.1f}%' : ccy === 'RUB' ? '%{y:,.0f} ₽' : '$%{y:,.0f}';
  const area = (label, c, ys, group, legend = true, name = label, fill = c) => ({
    x: days, y: ys, name, type: 'scatter', mode: 'lines', stackgroup: group, showlegend: legend,
    legendgroup: label, line: { width: 0, color: c }, fillcolor: fill, hovertemplate: `${money}<extra>${name}</extra>`,
  });
  const share = (y, i) => (pct ? (totals[i] > 0 ? 100 * Math.max(0, y) / totals[i] : 0) : Math.max(0, y));
  // positive totals stacked up; a bank below zero as a whole stacked down
  const traces = [];
  // solid: exact / proven; half-faded: events known at approximate amounts; faded: extrapolated
  for (const [label, c, ys, full, mid] of series) {
    traces.push(area(label, c, ys.map(share), 'assets'));
    if (!full) continue;
    const parts = mpEstimateLayers(ys, full, mid);
    if (parts.known) traces.push(area(label, c, parts.known.map(share), 'assets', false, `${label} (known, approximate amount)`, mpFade(c, 0.75)));
    if (parts.extrapolated) traces.push(area(label, c, parts.extrapolated.map(share), 'assets', false, `${label} (extrapolated)`, mpFade(c, 0.45)));
  }
  if (!pct) {
    for (const [label, c, ys, full] of series) {
      const neg = full || ys;
      if (neg.some(y => y < -0.5)) traces.push(area(label, c, neg.map(y => Math.min(0, y)), 'debt', false));
    }
  }
  // the hover: one list of what isn't zero that day, the largest first -- a line
  // for each of the 40-odd layers, most of them $0, ran off the screen
  const hoverValue = v => (pct ? `${v.toFixed(1)}%` : ccy === 'RUB' ? `${Math.round(v).toLocaleString('en-US')} ₽`
    : `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`);
  // the day's total on top (net of the debt below zero), then each layer
  const hoverLines = days.map((_, i) => (pct ? '' : `<b>Total: ${hoverValue(traces.reduce((s, t) => s + t.y[i], 0))}</b><br>`)
    + (traces.map(t => [t.name, t.fillcolor, t.y[i]]).filter(([, , v]) => Math.abs(v) >= 0.5)
      .sort((a, b) => b[2] - a[2])
      .map(([n, c, v]) => `<span style="color:${c}">■</span> ${String(n).replace(/</g, '&lt;')}: ${hoverValue(v)}`).join('<br>') || 'nothing'));
  for (const t of traces) { t.hoverinfo = 'skip'; delete t.hovertemplate; }
  traces.push({ x: days, y: days.map(() => 0), type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false,
    text: hoverLines, hovertemplate: '%{text}<extra></extra>' });
  const layout = mpCapitalLayout(ccy, { hovermode: 'x unified' });
  // the hover's title: the day, not the month the ticks show
  layout.xaxis = Object.assign({}, layout.xaxis, { griddash: 'dot', hoverformat: '%d %b %Y' });
  await mpDrawAreas(el, traces, layout, pct);
}
try {
  const saved = localStorage.getItem('mp_capital_ccy'); if (saved) document.getElementById('brokers_ccy').value = saved;
  document.getElementById('brokers_pct').checked = localStorage.getItem('mp_brokers_pct') === '1';
  const m = localStorage.getItem('mp_brokers_exact');
  document.getElementById('brokers_exact').value = m === '1' ? 'exact' : ['proven', 'exact', 'both'].includes(m) ? m : 'all';
} catch { /* no storage */ }
for (const id of ['brokers_ccy', 'brokers_re', 'brokers_pct', 'brokers_exact']) {
  document.getElementById(id).addEventListener('change', () => {
    try {
      localStorage.setItem('mp_capital_ccy', document.getElementById('brokers_ccy').value);
      localStorage.setItem('mp_brokers_pct', document.getElementById('brokers_pct').checked ? '1' : '0');
      localStorage.setItem('mp_brokers_exact', document.getElementById('brokers_exact').value);
    } catch { /* no storage */ }
    if (mpIsSignedIn) mpRenderCapitalBrokers();
  });
}
// Capital at the start and end of the shown period and the change between.
function mpCapitalPeriod(a, b) {
  const rows = (mpCapitalRows || []).filter(r => r.day >= a && r.day <= b);
  const out = document.getElementById('capital_period');
  if (rows.length < 2) { out.textContent = ''; return; }
  const ccy = mpCapitalCcy(), conv = mpCapitalConverter(ccy);
  const v0 = conv(rows[0].day, rows[0].capital_usd), v1 = conv(rows[rows.length - 1].day, rows[rows.length - 1].capital_usd);
  const d = v1 - v0, pct = v0 ? d / v0 * 100 : 0;
  const f = v => ccy === 'RUB' ? `${Math.round(v).toLocaleString('en-US')} ₽` : '$' + Math.round(v).toLocaleString('en-US');
  out.textContent = `${rows[0].day}: ${f(v0)} → ${rows[rows.length - 1].day}: ${f(v1)} · `
    + `${d >= 0 ? '+' : '−'}${f(Math.abs(d))} (${d >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`;
}
// Shown in USD or RUB (the choice kept in this browser): RUB at each day's
// Bank of Russia rate (fx_history, last rate on or before the day).
let mpCapitalRub = null;
function mpCapitalCcy() {
  return document.getElementById('capital_ccy').value === 'RUB' ? 'RUB' : 'USD';
}
async function mpLoadRubRates() {
  const rows = await mpFetchAll(() => sb.from('fx_history').select('day, usd_per_unit')
    .eq('currency', 'RUB').order('day'));
  return rows.map(r => [r.day, Number(r.usd_per_unit)]);
}
function mpCapitalConverter(ccy) {
  if (ccy !== 'RUB' || !mpCapitalRub?.length) return (_day, usd) => Number(usd || 0);
  const rates = mpCapitalRub;
  return (day, usd) => {
    let lo = 0, hi = rates.length - 1, rate = rates[0][1];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rates[mid][0] <= day) { rate = rates[mid][1]; lo = mid + 1; } else hi = mid - 1; }
    return Number(usd || 0) / rate;
  };
}
try { const saved = localStorage.getItem('mp_capital_ccy'); if (saved) document.getElementById('capital_ccy').value = saved; } catch { /* no storage */ }
document.getElementById('capital_ccy').addEventListener('change', e => {
  mpSave('mp_capital_ccy', e.target.value);
  if (mpIsSignedIn) mpRenderCapital();
});
document.getElementById('capital_show_re').addEventListener('change', () => { if (mpIsSignedIn) mpRenderCapital(); });

