// The Bonds & deposits tab: redemptions and offers, the ladder, the key rate's
// odds, what to buy next.

// ---- Bonds & deposits tab (05.11.2026): when each bond held is redeemed or
// has its offer (MOEX ISS, straight from the browser), and the term deposits'
// ends (deposit_terms, set by hand: no statement gives them) -- a bar from
// today to the date, its thickness the money in it. ----
const MP_MAT_CACHE = 'mp_moex_bond_dates_v7';
async function mpMoexBondDates(secids) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(MP_MAT_CACHE) || '{}'); } catch { /* none */ }
  const today = new Date().toISOString().slice(0, 10);
  const todo = secids.filter(s => cache[s]?.at !== today);
  const one = async secid => {
    const base = `https://iss.moex.com/iss/securities/${encodeURIComponent(secid)}`;
    const [d, o] = await Promise.all([
      fetch(`${base}.json?iss.meta=off&iss.only=description&description.columns=name,value`).then(r => r.json()).catch(() => null),
      fetch(`${base}/bondization.json?iss.meta=off&iss.only=offers,coupons,amortizations&limit=unlimited`).then(r => r.json()).catch(() => null),
    ]);
    const desc = Object.fromEntries((d?.description?.data || []).map(([k, v]) => [k, v]));
    const table = t => { const c = o?.[t]?.columns || []; return (o?.[t]?.data || []).map(r => Object.fromEntries(c.map((k, i) => [k, r[i]]))); };
    const offers = table('offers').map(r => r.offerdate).filter(x => x && x >= today).sort();
    // the money a bond still pays, per bond in its face currency: coupons (a
    // floating one not fixed yet: at the last known), and the face back
    let lastCoupon = 0;
    const raw = table('coupons');
    // a floating coupon: by MOEX's COUPON_DETAILS -- 'Ключевая ставка',
    // 'Ставка RUONIA', ...; not 'Фиксированный с неизвестными купонами': fixed
    // up to an offer, the rate after it set at the offer (Полюс ПБО-06, Почта
    // БО-001P-07, АФК Система 001Р-24). Unknown future sums are no sign
    // either: a securitisation's coupons wait on its amortisations, its rate
    // fixed (СФО Сплит Финанс 1 at 25%). Without COUPON_DETAILS: floating if
    // the future rates aren't all one known rate
    const details = desc.COUPON_DETAILS || '';
    const rates = new Set(raw.filter(c => c.coupondate > today).map(c => Number(c.valueprc) || 0));
    const floating = /ОФЗ-ПК/.test(desc.NAME || '')
      || (details ? !/^Фиксированный/i.test(details) : rates.size > 1 || rates.has(0));
    const coupons = raw.map(c => { if (c.value) lastCoupon = Number(c.value); return { day: c.coupondate, value: c.value ? Number(c.value) : lastCoupon }; })
      .filter(c => c.day > today && c.value > 0);
    const face = table('amortizations').filter(a => a.amortdate > today).map(a => ({ day: a.amortdate, value: Number(a.value) }));
    // the coupon's rate now, % a year: the last one set (a floater's next
    // ones aren't) -- MOEX's own rate, or its sum over the face and the period
    const set = raw.filter(c => c.value || c.valueprc).pop();
    const rate = !set ? null : Number(set.valueprc) || Number(set.value) / Number(set.facevalue)
      * 365 / Math.max(1, (Date.parse(set.coupondate) - Date.parse(set.startdate)) / 86400000) * 100;
    // every coupon and amortisation, the past ones too: a purchase's yield (06.11.2026)
    const allC = raw.map(c => [c.coupondate, c.value ? Number(c.value) : null]);
    const allA = table('amortizations').map(a => [a.amortdate, Number(a.value)]);
    cache[secid] = { at: today, name: desc.NAME || desc.SHORTNAME || secid, mat: desc.MATDATE || null, offer: offers[0] || null,
      unit: (desc.FACEUNIT || 'RUB').replace('SUR', 'RUB'), coupons, face, floating, rate, allC, allA };
  };
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(one));
  try { localStorage.setItem(MP_MAT_CACHE, JSON.stringify(cache)); } catch { /* no storage */ }
  return cache;
}
// the switches over the chart by year: remembered, redraw the tab
{
  // the ladder: the next five years by default
  const y = new Date().getFullYear();
  for (const [id, def] of [['mat_birth', 1991]]) {
    let v = def;
    try { v = Number(localStorage.getItem('mp_' + id)) || def; } catch { /* no storage */ }
    document.getElementById(id).value = v;
    document.getElementById(id).addEventListener('change', e => {
      mpSave('mp_' + id, e.target.value);
      mpRenderMaturities();
    });
  }
}
for (const id of ['mat_deposits', 'mat_floaters']) {
  try { const v = localStorage.getItem('mp_' + id); if (v) document.getElementById(id).checked = v === '1'; } catch { /* no storage */ }
  document.getElementById(id).addEventListener('change', e => {
    mpSave('mp_' + id, e.target.checked ? '1' : '0');
    mpRenderMaturities();
  });
}
// The floaters' share of the bonds by the odds the CBR key rate goes up or
// down from its level now (asked 05.11.2026): key_rate_odds (migration 174,
// update-key-rate-odds, monthly) -- per 1 pp of the rate, from its history,
// how often it was higher / lower a year, two, three later, made strictly
// monotone; floaters = up / (up + down), the rest fixed coupons. Between two
// buckets' points -- linear. The key rate now: key_rates' last day (every day
// kept, daily).
// The trend over it: the rate's change over the last 365 days, its bucket's
// odds ratio (key_rate_trend_odds) times the level's odds of a rise.
// the power over k, the tab's field (0: no inertia, 1: k whole), 0.5 by default
let MP_TREND_BETA = 0.5;
{
  const el = document.getElementById('mat_beta');
  try { const v = localStorage.getItem('mp_mat_beta'); if (v !== null && v !== '') MP_TREND_BETA = Math.min(1, Math.max(0, Number(v))); } catch { /* no storage */ }
  el.value = MP_TREND_BETA;
  el.addEventListener('change', e => {
    const v = Number(e.target.value);
    MP_TREND_BETA = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    e.target.value = MP_TREND_BETA;
    try { localStorage.setItem('mp_mat_beta', String(MP_TREND_BETA)); } catch { /* no storage */ }
    mpRenderMaturities();
  });
}
async function mpKeyRateOdds() {
  // the last day of each of the last 120 months, for the 10 years' range and
  // mean (the trend's bucket and the rate's position, as the world's are)
  const monthEnds = [];
  const t0 = new Date();
  for (let m = 1; m <= 120; m++) monthEnds.push(new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() - m + 1, 0)).toISOString().slice(0, 10));
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [{ data: odds }, { data: last }, { data: before }, { data: trend }, { data: decade }, { data: horizon }, { data: cnLast }] = await Promise.all([
    sb.from('key_rate_odds').select('rate_from, rate_to, rate, days, up, down, floaters_pct').order('rate'),
    sb.from('key_rates').select('day, rate').order('day', { ascending: false }).limit(1),
    sb.from('key_rates').select('day, rate').lte('day', yearAgo).order('day', { ascending: false }).limit(1),
    sb.from('key_rate_trend_odds').select('trend_from, trend_to, position, n, obs_up, exp_up, odds_ratio').order('trend_from').order('position'),
    sb.from('key_rates').select('day, rate').in('day', monthEnds),
    sb.from('key_rate_horizon_odds').select('country, horizon, rate, months, down, up').order('horizon').order('rate'),
    sb.from('cb_rates_monthly').select('month, rate').eq('country', 'CN').order('month', { ascending: false }).limit(1),
  ]);
  // a bucket's point at its whole rate (06.11.2026; was its days' mean -- 9.32 for 9-10%)
  const pts = (odds || []).map(o => ({ ...o, rate: Number(o.rate_from), up: Number(o.up), down: Number(o.down), floaters_pct: Number(o.floaters_pct) }));
  const share = x => {
    if (!pts.length) return null;
    if (x <= pts[0].rate) return pts[0].floaters_pct;
    if (x >= pts.at(-1).rate) return pts.at(-1).floaters_pct;
    const i = pts.findIndex(p => p.rate >= x), a = pts[i - 1], b = pts[i];
    return a.floaters_pct + (b.floaters_pct - a.floaters_pct) * (x - a.rate) / (b.rate - a.rate);
  };
  const now = last?.[0] ? Number(last[0].rate) : null;
  const change = now != null && before?.[0] ? Math.round((now - Number(before[0].rate)) * 100) / 100 : null;
  // the world's k (key_rate_trend_odds): the change as a share of the last 10
  // years' range, and where the rate stands against their mean
  const dec = (decade || []).map(d => Number(d.rate));
  let rel = null, position = null, range = null;
  if (now != null && dec.length >= 100) {
    const all = [...dec, now], mean = dec.reduce((t, v) => t + v, 0) / dec.length;
    const sd = Math.sqrt(dec.reduce((t, v) => t + (v - mean) ** 2, 0) / dec.length) || 1;
    range = { min: Math.min(...all), max: Math.max(...all), mean };
    rel = change != null && range.max > range.min ? change / (range.max - range.min) : null;
    position = (now - mean) / sd < -0.5 ? 0 : (now - mean) / sd > 0.5 ? 2 : 1;
  }
  const tb = rel == null ? null : (trend || []).find(t => Number(t.position) === position && rel > Number(t.trend_from) && rel <= Number(t.trend_to));
  const ratio = tb ? Number(tb.odds_ratio) : 1;
  const hz = c => (horizon || []).filter(r => (r.country || 'RU') === c).map(r => ({ h: r.horizon, rate: Number(r.rate), months: r.months, down: Number(r.down), up: Number(r.up) }));
  // the level's share, the trend's odds ratio over it -- weakened, k^0.5, for
  // the level to weigh more (asked 05.11.2026; a walk-forward test had k^0.5
  // and k^1 within 0.03 pp a year)
  const kb = ratio ** MP_TREND_BETA;
  const withTrend = x => { const p = share(x) / 100; return p <= 0 || p >= 1 ? p * 100 : 100 * p * kb / (p * kb + 1 - p); };
  return { pts, share, withTrend, ratio, kb, change, rel, position, range, trend: tb, trends: trend || [], now, since: last?.[0]?.day || null,
    horizon: hz('RU'), horizonCN: hz('CN'), cnNow: cnLast?.[0] ? Number(cnLast[0].rate) : null, cnSince: cnLast?.[0]?.month?.slice(0, 7) || null };
}

// The fixed coupons' ladder by the CBR's odds (asked 05.11.2026), from
// key_rate_horizon_odds at today's key rate (its 1 pp bucket):
//   net -- the net odds of a cut per horizon, down - up (the two tables), 0
//     where a rise is likelier: what locking the rate in for that long wins;
//   its length (06.11.2026 -- all from net, nothing even any more: at the
//     PBoC's 3% net is 13, 7, 1, then 0, and the ladder was 8 even years) --
//     to the last horizon net is above 0, no longer than the age allows:
//     (80 - age) / 3 up to 65, 5 to 15 years (35: 15, 50: 10, 65: 5); past
//     65 a year less every six, not under 2 (71: 4, 77: 3, 83: 2); no net
//     anywhere (no cut likelier than a rise) -- a year: keep it short;
//   a year's weight -- net times the years it locks the rate in, times how
//     far the forecast still holds (1 - h/16; the tables drift to the long
//     run by h/15): h * net * (1 - h/16) -- rising to a peak and down after.
// rows: one country's table; step: its bucket (RU 1 pp, CN 0.5 pp)
const mpBucket = (rows, now, step) => {
  const rates = [...new Set(rows.map(r => r.rate))].sort((a, b) => a - b);
  const k = Math.floor(now / step + 1e-9) * step;
  return Math.min(rates.at(-1), Math.max(rates[0], k));
};
function mpLadderAuto(rows, now, age, step = 1) {
  if (now == null || !rows.length) return null;
  const rate = mpBucket(rows, now, step);
  const col = rows.filter(r => Math.abs(r.rate - rate) < 1e-9).sort((a, b) => a.h - b.h);
  if (col.length < 15) return null;
  const s = col.reduce((t, r) => t + r.down, 0) / col.length;
  const netAll = col.map(r => Math.max(0, r.down - r.up));
  const nRate = netAll.reduce((last, x, i) => x > 0.005 ? i + 1 : last, 0);
  const nAge = age <= 65 ? Math.min(15, Math.max(5, Math.round((80 - age) / 3))) : Math.max(2, 5 - Math.floor((age - 65) / 6));
  const years = Math.max(1, Math.min(nRate, nAge)), net = netAll.slice(0, years);
  const raw = net.map((x, i) => (i + 1) * x * (1 - (i + 1) / 16)), rs = raw.reduce((t, x) => t + x, 0);
  const weights = rs ? raw.map(x => x / rs) : net.map(() => 1 / years);
  // the floaters' bonus (06.11.2026): over the years the age allows, where a
  // cut isn't likelier than a rise locking the rate in buys nothing -- half
  // the share of such years, half how much likelier a rise is on average (the
  // share alone jumped to 100% at 8%)
  const bonus = (netAll.slice(0, nAge).filter(x => x <= 0.005).length / nAge
    + col.slice(0, nAge).reduce((t, r) => t + Math.max(0, r.up - r.down), 0) / nAge) / 2;
  return { rate, s, nRate, nAge, years, weights, net, short: !nRate, bonus };
}

function mpLadderHeat(prefix, rows, now, auto, step, xTitle) {
  if (!rows.length) return;
  const xs = [...new Set(rows.map(r => r.rate))].sort((a, b) => a - b), hs = [...new Set(rows.map(r => r.h))].sort((a, b) => a - b);
  const cell = (h, k) => rows.find(r => r.h === h && Math.abs(r.rate - k) < 1e-9);
  const curRate = now != null ? mpBucket(rows, now, step) : null;
  const val = (c, field) => field === 'net' ? Math.max(0, c.down - c.up) : c[field];
  const heat = (id, field, scale) => Plotly.newPlot(id, [{
    type: 'heatmap', x: xs, y: hs.map(h => `${h} г`), z: hs.map(h => xs.map(k => { const c = cell(h, k); return c ? val(c, field) * 100 : null; })),
    text: hs.map(h => xs.map(k => { const c = cell(h, k); return c ? `${Math.round(val(c, field) * 100)}${c.months ? '' : '*'}` : ''; })),
    texttemplate: '%{text}', textfont: { size: 9 }, colorscale: scale, zmin: 0, zmax: 100, showscale: false,
    customdata: hs.map(h => xs.map(k => cell(h, k)?.months ?? 0)),
    hovertemplate: 'ставка %{x}%, через %{y}: %{z:.0f}%<br>месяцев в истории: %{customdata} (0 — по соседним)<extra></extra>' }],
    { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#c9d1d9' }, margin: { l: 45, r: 10, t: 10, b: 40 },
      hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
      xaxis: { title: { text: xTitle, font: { size: 11 } }, tickfont: { size: 10 }, dtick: step, ticksuffix: '%' }, yaxis: { autorange: 'reversed', tickfont: { size: 10 } },
      shapes: [
        ...(curRate != null ? [auto
          ? { type: 'rect', xref: 'x', yref: 'y', x0: curRate - step / 2, x1: curRate + step / 2, y0: -0.5, y1: auto.years - 0.5, line: { color: '#f85149', width: 2 } }
          : { type: 'rect', xref: 'x', yref: 'paper', x0: curRate - step / 2, x1: curRate + step / 2, y0: 0, y1: 1, line: { color: '#f85149', width: 2 } }] : []),
        ...(auto ? [{ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: -0.5, y1: auto.years - 0.5, line: { color: '#f5c542', width: 1, dash: 'dot' } }] : []),
      ] }, { responsive: true, displaylogo: false, displayModeBar: false });
  heat(`plot_${prefix}_h_down`, 'down', [[0, '#0d1117'], [1, '#58a6ff']]);
  heat(`plot_${prefix}_h_up`, 'up', [[0, '#0d1117'], [1, '#a371f7']]);
  heat(`plot_${prefix}_h_net`, 'net', [[0, '#0d1117'], [1, '#f5c542']]);
}
function mpLadderNote(auto, now, age, from, cny = false) {
  if (!auto) return 'Ставка или таблицы ещё не загружены — лесенка пока ровная на 5 лет.';
  const to = from + auto.years - 1;
  return `Сейчас ${now}% (столбец ${auto.rate}%): ${auto.short ? 'снижение ставки не вероятнее повышения ни на одном сроке — держать коротко, 1 год'
      : `перевес снижения есть до ${auto.nRate}-го года включительно`}, по возрасту (${age}) не больше ${auto.nAge} → <b>${auto.years} ${auto.years === 1 ? 'год' : auto.years < 5 ? 'года' : 'лет'}</b> (${from}–${to}, жёлтая рамка).
    Вес года: перевес снижения («ниже» − «выше») × число лет, на которое год фиксирует ставку × (1 − лет/16) — надёжность прогноза.
    ${auto.bonus > 0.005 ? (cny ? `Бонус «держать коротко» ${Math.round(auto.bonus * 100)}% (доля сроков без перевеса снижения и перевес повышения, пополам; юаневых флоатеров нет) — в ${from} год. `
      : `Бонус флоатерам ${Math.round(auto.bonus * 100)}% от остатка (доля сроков без перевеса снижения и перевес повышения, пополам). `) : ''}
    Веса: ${auto.weights.map((w, i) => `${from + i} — ${(w * 100).toFixed(1)}%`).join(', ')}.`;
}

// The OFZ on MOEX's main board, a day's cache: name, maturity, last price (%
// of the face), the face, the accrued coupon, the yield, the day's turnover;
// pd -- a fixed coupon (25xxx/26xxx), pk -- a floater (29xxx)
async function mpOfzList() {
  const KEY = 'mp_ofz_v1', today = new Date().toISOString().slice(0, 10);
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c?.at === today) return c.list; } catch { /* none */ }
  const j = await fetch('https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQOB/securities.json?iss.meta=off&iss.only=securities,marketdata'
    + '&securities.columns=SECID,SHORTNAME,MATDATE,FACEVALUE,PREVPRICE,ACCRUEDINT,FACEUNIT&marketdata.columns=SECID,YIELD,VALTODAY')
    .then(r => r.json()).catch(() => null);
  if (!j) return [];
  const md = new Map((j.marketdata?.data || []).map(([id, y, v]) => [id, { y, v }]));
  const list = (j.securities?.data || []).filter(r => r[2] && (r[6] || 'SUR') === 'SUR').map(([secid, name, mat, face, price, accrued]) => ({
    secid, name, mat, face: Number(face), price: Number(price), accrued: Number(accrued),
    yield: Number(md.get(secid)?.y) || 0, turnover: Number(md.get(secid)?.v) || 0,
    pd: /^SU2[56]\d{3}/.test(secid), pk: /^SU29\d{3}/.test(secid) }));
  try { localStorage.setItem(KEY, JSON.stringify({ at: today, list })); } catch { /* no storage */ }
  return list;
}

// The yuan corporate bonds to buy (06.11.2026; not the yuan OFZ -- asked): on
// MOEX's main corporate board, face in yuan, of the most reliable issuers
// (top-rated: Gazprom capital, RZD, Nornickel, Polyus, PhosAgro,
// Atomenergoprom, Rosneft, Metalloinvest, the EDB -- MOEX gives no ratings,
// so a list), a yield of 3-12% (over that the market prices trouble), a
// day's cache; `due` -- the offer, if any, else the maturity: when the money
// may come back
const MP_CNY_ISSUERS = /^(ГазКап|РЖД|НорНик|Полюс|ФосАгро|Атомэнпр|Роснфт|МЕТАЛИН|ЕАБР)/;
async function mpCnyBondList() {
  const KEY = 'mp_cny_bonds_v1', today = new Date().toISOString().slice(0, 10);
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c?.at === today) return c.list; } catch { /* none */ }
  const j = await fetch('https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json?iss.meta=off&iss.only=securities,marketdata'
    + '&securities.columns=SECID,SHORTNAME,MATDATE,OFFERDATE,FACEUNIT,FACEVALUE,PREVPRICE,ACCRUEDINT&marketdata.columns=SECID,YIELD,VALTODAY')
    .then(r => r.json()).catch(() => null);
  if (!j) return [];
  const md = new Map((j.marketdata?.data || []).map(([id, y, v]) => [id, { y, v }]));
  const list = (j.securities?.data || []).filter(r => r[4] === 'CNY' && r[2] && MP_CNY_ISSUERS.test(r[1] || '')).map(([secid, name, mat, offer, , face, price, accrued]) => ({
    secid, name, mat, offer, due: offer || mat, face: Number(face), price: Number(price) || 100, accrued: Number(accrued) || 0,
    yield: Number(md.get(secid)?.y) || 0, turnover: Number(md.get(secid)?.v) || 0 }))
    .filter(b => b.yield >= 3 && b.yield <= 12);
  try { localStorage.setItem(KEY, JSON.stringify({ at: today, list })); } catch { /* no storage */ }
  return list;
}

// The OFZ-PK to buy (06.11.2026): of the new kind, 1-3 years out, trading
// over 1 mln roubles a day, the
// biggest spread over the key rate -- the coupon now (MOEX) less the key
// rate, plus the price's discount to the face over the years left
async function mpBestPk(ofz, keyNow) {
  const y = new Date().getFullYear();
  // only the new kind (29014 on): the coupon by RUONIA over its own period; the
  // old ones (29006-29010) take the half year before -- they look richer while
  // the rate falls and catch up with a rise half a year late, worse at what a
  // floater is for
  const cands = ofz.filter(b => b.pk && Number(b.secid.slice(2, 7)) >= 29014 && (b.turnover || 0) > 1e6 && b.mat > `${y + 1}` && b.mat < `${y + 4}`);
  if (!cands.length) return null;
  if (keyNow == null) return cands.sort((a, b) => b.turnover - a.turnover)[0];
  const dates = await mpMoexBondDates(cands.map(b => b.secid));
  const spread = b => { const r = dates[b.secid]?.rate, yrs = Math.max(0.05, (Date.parse(b.mat) - Date.now()) / (365 * 86400000));
    return r == null ? -Infinity : r - keyNow + (100 - (b.price || 100)) / yrs; };
  return cands.map(b => ({ ...b, spread: spread(b) })).sort((a, b) => b.spread - a.spread)[0];
}

// MOEX's figures for bonds (06.11.2026, the portfolio's yield cards): per
// security its main board's coupon (% a year; a floater's -- none), coupon
// period (days), last price (%), yield (effective, to maturity or the offer;
// a floater's -- 0) and duration (days); a day's cache
async function mpBondMarket(secids) {
  const KEY = 'mp_bond_market_v1', today = new Date().toISOString().slice(0, 10);
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* none */ }
  if (cache.at !== today) cache = { at: today, m: {} };
  const todo = [...new Set(secids)].filter(id => !(id in cache.m));
  for (let i = 0; i < todo.length; i += 20) {
    const ids = todo.slice(i, i + 20).join(',');
    const j = await fetch(`https://iss.moex.com/iss/engines/stock/markets/bonds/securities.json?iss.meta=off&iss.only=securities,marketdata&securities=${ids}`
      + '&securities.columns=SECID,BOARDID,COUPONPERCENT,COUPONPERIOD,PREVPRICE&marketdata.columns=SECID,BOARDID,YIELD,DURATION').then(r => r.json()).catch(() => null);
    const md = new Map((j?.marketdata?.data || []).map(([id, b, y, d]) => [`${id}|${b}`, { y, d }]));
    for (const [id, b, cp, per, price] of j?.securities?.data || []) {
      if (!['TQOB', 'TQCB', 'TQIR'].includes(b)) continue;
      const m = md.get(`${id}|${b}`) || {};
      cache.m[id] = { coupon: cp != null ? Number(cp) : null, period: Number(per) || null, price: Number(price) || null, yield: Number(m.y) || 0, dur: Number(m.d) || 0 };
    }
    for (const id of todo.slice(i, i + 20)) if (!(id in cache.m)) cache.m[id] = null;
  }
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* no storage */ }
  return new Map(Object.entries(cache.m));
}

// The Bonds & deposits tab's buy logic for others (06.11.2026: the salary
// plan's step 8): set by mpRenderMaturities; session() -- a buyer for one
// plan: (ccy 'RUB' | 'CNY', usd) -> { buys: [{ ticker, name, units, usd }],
// left } -- whole bonds, one at a time into the year (or the floaters)
// furthest under its target in share of it, the targets with what this
// session spent and this money in; the rest is left
let mpBondCtx = null;

// The bonds (moex_bond, moex_ofz) and deposits held: one row a security, its
// accounts together, with MOEX's dates and payments (mpMoexBondDates) and the
// deposits' ends (deposit_terms, set by hand); null on an error (written into status)
async function mpMatHeldRows(status) {
  const { data: held, error } = await sb.from('portfolio_value_usd_by_account').select('ticker, account, quantity, value_usd, asset_class, currency')
    .gt('quantity', 0).or('asset_class.in.(moex_bond,moex_ofz),ticker.like.DEPOSIT:*');
  if (error) { status.textContent = error.message; return null; }
  const { data: terms } = await sb.from('deposit_terms').select('ticker, end_day');
  const endOf = new Map((terms || []).map(t => [t.ticker, t.end_day]));
  // one row a security, its accounts together
  const by = new Map();
  for (const h of held || []) {
    const r = by.get(h.ticker) || { ticker: h.ticker, qty: 0, usd: 0, accounts: new Set(), deposit: h.ticker.startsWith('DEPOSIT:'), currency: h.currency };
    r.qty += Number(h.quantity); r.usd += Number(h.value_usd); r.accounts.add(h.account);
    by.set(h.ticker, r);
  }
  const rows = [...by.values()];
  const dates = await mpMoexBondDates(rows.filter(r => !r.deposit).map(r => r.ticker));
  for (const r of rows) {
    if (r.deposit) { r.name = r.ticker.replace(/^DEPOSIT:/, 'Вклад '); r.mat = endOf.get(r.ticker) || null; r.offer = null; }
    else Object.assign(r, { name: dates[r.ticker]?.name || r.ticker, mat: dates[r.ticker]?.mat || null, offer: dates[r.ticker]?.offer || null,
      unit: dates[r.ticker]?.unit || 'RUB', coupons: dates[r.ticker]?.coupons || [], face: dates[r.ticker]?.face || [], floating: !!dates[r.ticker]?.floating, rate: dates[r.ticker]?.rate ?? null,
      allC: dates[r.ticker]?.allC || [], allA: dates[r.ticker]?.allA || [] });
    r.next = r.offer || r.mat;
  }
  return rows;
}

// The bars from today to each bond's offer and maturity, a deposit's end; `plan` --
// the buy plan's bonds [{ name, mat, offer, usd, n, kind: 'fixed' | 'float' | 'cny' }],
// a bar each, hatched (06.11.2026). c: mpRenderMaturities' figures
function mpMatDrawGantt(c, plan = []) {
  const { dark, el, endOrMax, label, money, shown, span, today } = c;
  // a bond held takes its plan into its own row (06.11.2026: it was doubled)
  const held = shown.map(r => { const p = plan.find(q => q.secid === r.ticker); return p ? { ...r, planN: p.n, planUsd: p.usd } : r; });
  const all = [...held, ...plan.filter(p => !shown.some(r => r.ticker === p.secid)).map(p => ({ ...p, planned: true, unit: p.kind === 'cny' ? 'CNY' : 'RUB', floating: p.kind === 'float', qty: p.n }))]
    .sort((a, b) => (a.offer || a.mat || '9999').localeCompare(b.offer || b.mat || '9999'));
  const lab = r => (r.planned ? '+ ' : '') + label(r);
  const yy = all.map((r, i) => r.planned ? `${lab(r)}\u200b${i}` : lab(r));   // a planned row its own, even of a bond held
  const maxU = Math.max(...all.map(r => r.usd + (r.planUsd || 0)), 1), wd = r => 0.25 + 0.6 * Math.sqrt((r.usd + (r.planUsd || 0)) / maxU);
  const colorOf = r => r.deposit ? '#2bb5a8' : r.floating ? (r.offer ? 'rgba(163,113,247,0.45)' : '#a371f7')
    : r.unit === 'CNY' ? (r.offer ? 'rgba(247,120,186,0.45)' : '#f778ba') : r.offer ? 'rgba(88,166,255,0.45)' : '#58a6ff';
  const pattern = { shape: all.map(r => r.planned ? '/' : ''), fgcolor: '#0d1117', solidity: 0.35 };
  const traces = [
    { type: 'bar', orientation: 'h', name: 'до оферты', y: yy, base: all.map(() => today), x: all.map(r => r.offer ? span(today, r.offer) : 0),
      width: all.map(wd), marker: { color: '#f0a03c', pattern }, hovertemplate: '%{y}: оферта %{customdata}<extra></extra>', customdata: all.map(r => r.offer || '') },
    { type: 'bar', orientation: 'h', name: 'до погашения', y: yy, base: all.map(r => r.offer || today), x: all.map(r => r.mat ? span(r.offer || today, r.mat) : 0),
      width: all.map(wd), marker: { color: all.map(colorOf), pattern },
      hovertemplate: '%{y}: погашение %{customdata}<extra></extra>', customdata: all.map(r => r.mat || 'не указано') },
  ];
  const annotations = all.map((r, i) => ({ x: endOrMax(r), y: yy[i], xanchor: 'left', xshift: 6, showarrow: false, font: { size: 11, color: r.planned ? '#3dd68c' : '#8b949e' },
    text: r.planned ? `план: +${r.n} шт · ${money(r.usd)}` : `${r.deposit ? '' : `${r.floating ? 'перем.' : 'пост.'} · ${Math.round(r.qty)} шт · `}${money(r.usd)}${r.next ? '' : ' · срок?'}`
      + (r.planN ? ` · <span style="color:#3dd68c">план +${r.planN} шт · ${money(r.planUsd)}</span>` : '') }));
  el.style.height = `${Math.max(300, all.length * 26 + 110)}px`;
  Plotly.newPlot(el, traces, { ...dark, barmode: 'overlay', showlegend: false, margin: { l: 260, r: 140, t: 50, b: 30 },
    xaxis: { type: 'date', gridcolor: '#1e2830', range: [today, [...all.map(endOrMax)].sort().pop()], side: 'top' },
    yaxis: { autorange: 'reversed', automargin: true, tickfont: { size: 11 }, tickvals: yy, ticktext: all.map(lab) }, annotations }, { responsive: true, displaylogo: false });
  // a deposit's end, set by a click on its row
  el.removeAllListeners?.('plotly_click');
  el.on('plotly_click', async ev => {
    const r = all[ev.points?.[0]?.pointIndex];
    // a bond (held or planned): its price chart
    const isin = r && !r.deposit ? (r.ticker || r.secid) : null;
    if (isin) { mpOpenPriceDialog(isin, r.name || isin); return; }
    if (!r?.deposit) return;
    const v = prompt(`${r.name}: дата окончания (ГГГГ-ММ-ДД)`, r.mat || '');
    if (v === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { alert('Формат даты: ГГГГ-ММ-ДД'); return; }
    const { error: e } = await sb.from('deposit_terms').upsert({ ticker: r.ticker, end_day: v.trim(), updated_at: new Date().toISOString() });
    if (e) { alert(e.message); return; }
    mpRenderMaturities();
  });
  // a bond's name on the left: its price chart too
  const byText = new Map(all.map(r => [lab(r), r]));
  el.querySelectorAll('.yaxislayer-above .ytick text').forEach(t => {
    const r = byText.get(t.textContent);
    const isin = r && !r.deposit ? (r.ticker || r.secid) : null;
    if (!isin) return;
    t.style.cursor = 'pointer'; t.style.pointerEvents = 'all';
    t.onclick = () => mpOpenPriceDialog(isin, r.name || isin);
  });
}

// The four pies; `add` -- the buy plan's purchases (06.11.2026: entering a
// sum redraws them with what it buys): { fixed: year -> $, float: $, cny: year -> $ }
function mpMatDrawPies(c, add) {
  const { bestPk, cauto, cf, cnyAll, cnyBondList, cr, ct, fixedMV, floatBase, floatBonus, floatPct, from, key, levelPct, mvBonds, mvCnyBy, mvFixedBy, mvFloat, odds, ofzAll, pieCny, pieRub, pieW, pies, rubPie, rungs, shadeOf, targetMV, to, usdPer, yuanPie } = c;
  pies.innerHTML = '';
  // a deposit the money comes from (06.11.2026): out of its year, not of the bonds
  const aDep = add?.dep?.usd || 0, depY = add?.dep?.y;
  const aFixed = y => (add?.fixed.get(y) || 0) - (y === depY ? aDep : 0), aCny = y => add?.cny.get(y) || 0, aFloat = add?.float || 0;
  const aFixedAll = add ? [...add.fixed.values()].reduce((t, v) => t + v, 0) - aDep : 0, aCnyAll = add ? [...add.cny.values()].reduce((t, v) => t + v, 0) : 0;
  const withBuys = add && (aFixedAll + aDep + aFloat + aCnyAll) > 0 ? ' — с покупками' : '';
  // 1. yuan vs rouble, as the chart in USD/RUB -> CNY Weight
  {
    const rub = pieRub + aFixedAll + aFloat, cny = pieCny + aCnyAll, tot = rub + cny || 1, w = pieW;
    // the target with the buy / sell lines (as the calculator's): w_CNY,
    // or the yuan as held when the dollar's between the lines
    const aimPct = w != null ? wCnyTarget(w / 100, pieCny, tot) / tot * 100 : null;
    mpTargetPie(pies, `Облигации, вклады и фонды ликвидности: юани и рубли${withBuys}`, [
      { label: 'в юанях', usd: cny, target: aimPct ?? cny / tot * 100, color: '#f778ba' },
      { label: 'в рублях', usd: rub, target: aimPct != null ? 100 - aimPct : rub / tot * 100, color: '#58a6ff' },
    ], w != null ? `w_CNY ${Math.round(w)}% по курсу USD/RUB (вкладка «USD/RUB → CNY Weight»). `
      + (() => {
        const l = wCnyLines(), fx = v => v.toFixed(1).replace('.', ',');
        if (cny / tot * 100 < w) return l && !(wCnyNow.x < l.buy) ? `Юаней меньше, но доллар ${fx(wCnyNow.x)} — выше линии покупки ${fx(l.buy)}: юани не покупать, цель — держать их как есть, новые деньги — в рубли.` : 'Юаней меньше и доллар ниже линии покупки — цель w_CNY, докупить.';
        return l && !(wCnyNow.x > l.sell) ? `Юаней больше, но доллар ${fx(wCnyNow.x)} — ниже линии продажи ${fx(l.sell)}: юани не продавать, цель — держать их как есть.` : 'Юаней больше и доллар выше линии продажи — цель w_CNY, продать.';
      })() : 'Цель w_CNY ещё не посчитана — открой вкладку «USD/RUB → CNY Weight».', null, false, null, rubPie);
  }
  // 2. fixed vs floating; which floater to buy: an OFZ-PK 1-3 years out, the most traded
  {
    const fl = mvFloat + aFloat, bonds = mvBonds + aFixedAll + aDep + aFloat;
    const short = bonds * floatPct / 100 - fl, y = new Date().getFullYear();
    const pk = bestPk;
    const hover = short <= 5 ? 'флоатеров достаточно — новых не покупать' : !pk ? `недобор ${rubPie(short)}; подходящей ОФЗ-ПК нет`
      : `купить: ${mpEscapeHtml(pk.name)} (ОФЗ-ПК, до ${pk.mat.slice(5, 7)}.${pk.mat.slice(0, 4)}) — ${Math.max(1, Math.round(short / (((pk.price || 100) / 100 * pk.face + (pk.accrued || 0)) * usdPer('RUB'))))} шт`;
    mpTargetPie(pies, `Российские облигации: постоянный и переменный купон (по рыночной цене)${withBuys}`, [
      { label: 'постоянный купон', usd: bonds - fl, target: 100 - floatPct, color: '#58a6ff', hover: 'что покупать по годам — на диаграмме лесенки' },
      { label: 'переменный купон', usd: fl, target: floatPct, color: '#a371f7', hover },
    ], !key || !odds.pts.length ? 'Таблица вероятностей ключевой ещё не посчитана (update-key-rate-odds, раз в месяц).'
      : `Ключевая ${key.now}% на ${odds.since}: по уровню флоатеров ${levelPct}%`
        + (odds.change != null ? `; за год ${odds.change > 0 ? '+' : ''}${odds.change} пп — шансы повышения ×${odds.ratio}^${MP_TREND_BETA} = ×${odds.kb.toFixed(2)}` : '')
        + ` → ${Math.round(floatBase * 10) / 10}%${floatBonus > 0.005 ? `; бонус лесенки ${Math.round(floatBonus * 100)}% от остатка → ${floatPct}%` : ''}. Вероятность, что за 1–3 года её повысят, против того, что понизят — по истории ЦБ с 2013 г.`, null, false, null, rubPie);
  }
  // 3. the rouble fixed coupons by ladder year; what's outside the ladder -- one grey slice, target 0
  {
    const fx = y => fixedMV(y) + aFixed(y);
    // this year's (a deposit closing in days, a bond redeemed): its own slice "2026", target 0 -- the money
    // goes into the rungs short of their target when it comes back; only earlier / later years are outside
    const nowY = String(new Date().getFullYear()), thisYear = fx(nowY);
    const outside = [...new Set([...mvFixedBy.keys(), ...(add ? add.fixed.keys() : [])])].filter(y => !rungs.includes(y) && y !== nowY).reduce((t, y) => t + fx(y), 0);
    const tw = rungs.reduce((t, y) => t + targetMV(y), 0) || 1;
    const total = rungs.reduce((t, y) => t + fx(y), 0) + outside + thisYear;
    const ofz0 = ofzAll.filter(b => b.pd && (b.turnover || 0) > 1e6 && b.yield > 0);
    const buyLine = y => {
      const short = total * targetMV(y) / tw - fx(y);
      if (short <= 5) return 'недобора нет';
      const b = ofz0.filter(o => o.mat.startsWith(y)).sort((a, c) => c.yield - a.yield)[0];
      if (!b) return `недобор ${rubPie(short)}; ОФЗ-ПД с погашением в этом году нет`;
      const n = Math.max(1, Math.round(short / (((b.price || 100) / 100 * b.face + (b.accrued || 0)) * usdPer('RUB'))));
      return `купить: ${mpEscapeHtml(b.name)} (до ${b.mat.slice(5, 7)}.${b.mat.slice(0, 4)}, ${b.yield.toFixed(1)}%) — ${n} шт`;
    };
    const shade = shadeOf(rungs.length, [168, 208, 255], [31, 86, 160]);
    mpTargetPie(pies, `Рублёвые с постоянным купоном: по годам лесенки (по рыночной цене)${withBuys}`, [
      ...(thisYear > 0 ? [{ label: nowY, usd: thisYear, target: 0, color: '#d0e4ff', hover: 'погашается в этом году: деньги пойдут в ступени с недобором' }] : []),
      ...rungs.map((y, i) => ({ label: y, usd: fx(y), target: targetMV(y) / tw * 100, color: shade(i), hover: buyLine(y) })),
      ...(outside > 0 ? [{ label: 'вне лесенки', usd: outside, target: 0, color: '#6e7681' }] : []),
    ], `Цель — веса лесенки ${from}–${to} по вероятностям ЦБ; ${nowY} — что погашается в этом году (вклады, облигации), «вне лесенки» — погашения позже; их деньги идут в ступени с недобором.`,
      null, false, null, rubPie);
  }
  // 4. the yuan ones by ladder year
  if (cnyAll > 0) {
    const cy = y => (mvCnyBy.get(y) || 0) + aCny(y);
    const outside = [...mvCnyBy.keys()].filter(y => !cr.includes(y)).reduce((t, y) => t + cy(y), 0);
    const tw = cr.reduce((t, y, i) => t + (cauto ? cauto.weights[i] : 1 / cr.length), 0) || 1;
    const total = cr.reduce((t, y) => t + cy(y), 0) + outside;
    const share = y => { const i = cr.indexOf(y); return (cauto ? cauto.weights[i] : 1 / cr.length) / tw; };
    const cnyBuy = y => {
      const short = total * share(y) - cy(y);
      if (short <= 5) return 'недобора нет';
      const b = cnyBondList.filter(o => o.due.startsWith(y)).sort((a, c) => c.yield - a.yield || c.turnover - a.turnover)[0];
      if (!b) return `недобор ${yuanPie(short)}; надёжных юаневых выпусков с погашением или офертой в этом году нет`;
      const n = Math.max(1, Math.round(short / ((b.price / 100 * b.face + b.accrued) * usdPer('CNY'))));
      return `купить: ${mpEscapeHtml(b.name)} (${b.offer ? 'оферта' : 'до'} ${b.due.slice(5, 7)}.${b.due.slice(0, 4)}, ${b.yield.toFixed(1)}%, номинал ${b.face} ¥) — ${n} шт`;
    };
    const shade = shadeOf(cr.length, [255, 196, 226], [176, 52, 120]);
    mpTargetPie(pies, `Юаневые: по годам лесенки (по рыночной цене)${withBuys}`, [
      ...cr.map((y, i) => ({ label: y, usd: cy(y), target: share(y) * 100, color: shade(i), hover: cnyBuy(y) })),
      ...(outside > 0 ? [{ label: 'вне лесенки', usd: outside, target: 0, color: '#6e7681' }] : []),
    ], `Цель — веса юаневой лесенки ${cf}–${ct} по ставке Банка Китая (${odds.cnNow ?? '—'}%); «вне лесенки» — погашения позже, их деньги идут в годы с недобором.`,
      null, false, null, yuanPie);
  }
  // the pies drawn one by one: each later one narrowed the row under the ones
  // before (06.11.2026: the first one clipped) -- all of them refit now
  requestAnimationFrame(() => pies.querySelectorAll('.pie-plot').forEach(el => Plotly.Plots.resize(el)));
}

// The key rate's charts: the odds by its level, the world's central banks'
// inertia, the formula with today's numbers, the floaters' share by the rate
function mpMatOddsCharts(c) {
  const { age, dark, floatBase, floatBonus, floatPct, key, levelPct, odds } = c;
  // the share's function of the key rate, today's key rate on it
  const op = odds.pts;
  // the odds table: up / the same / down per bucket of the key rate, and
  // without the same -- floaters / fixed; today's bucket outlined
  if (op.length) {
    const lbl = op.map(p => `${p.rate_from}–${p.rate_to}%`);
    const cur = key ? op.findIndex(p => key.now >= p.rate_from && key.now < p.rate_to) : -1;
    const outline = c => op.map((_, i) => i === cur ? '#f85149' : c);
    const widths = op.map((_, i) => i === cur ? 3 : 0);
    const pct = v => `${Math.round(v * 100)}%`;
    const same = op.map(p => Math.max(0, 1 - p.up - p.down));
    const barLayout = (yTitle) => ({ ...dark, barmode: 'stack', showlegend: true, legend: { orientation: 'h', y: -0.22 }, margin: { l: 45, r: 10, t: 30, b: 70 },
      hovermode: 'x unified', hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
      xaxis: { type: 'category', tickangle: -45, tickfont: { size: 10 } }, yaxis: { title: yTitle, tickformat: '.0%', range: [0, 1], gridcolor: '#1e2830' },
      annotations: cur >= 0 ? [{ x: lbl[cur], y: 1, yanchor: 'bottom', showarrow: false, text: 'сейчас', font: { color: '#f85149', size: 11 } }] : [] });
    const bar = (name, ys, color) => ({ type: 'bar', name, x: lbl, y: ys, marker: { color, line: { color: outline(color), width: widths } },
      text: ys.map(v => v >= 0.08 ? pct(v) : ''), textposition: 'inside', insidetextanchor: 'middle', textangle: 0, textfont: { size: 10 }, constraintext: 'none', hovertemplate: `${name}: %{y:.0%}<extra></extra>` });
    Plotly.newPlot('plot_kr_odds', [bar('повысят', op.map(p => p.up), '#a371f7'), bar('не изменится', same, '#6e7681'), bar('понизят', op.map(p => p.down), '#58a6ff')],
      barLayout('вероятность'), { responsive: true, displaylogo: false, displayModeBar: false });
    Plotly.newPlot('plot_kr_split', [bar('повысят → флоатеры', op.map(p => p.floaters_pct / 100), '#a371f7'), bar('понизят → постоянный купон', op.map(p => 1 - p.floaters_pct / 100), '#58a6ff')],
      barLayout('доля облигаций'), { responsive: true, displaylogo: false, displayModeBar: false });
  }
  // the inertia, the world's central banks': the odds ratio per bucket of
  // the year's change (a share of the 10 years' range) and per where the
  // rate stands against its 10 years -- three bars a bucket; on a log axis
  // around x1 (no effect); today's cell outlined
  const tr = odds.trends.map(t => ({ ...t, from: Number(t.trend_from), to: Number(t.trend_to), pos: Number(t.position), r: Number(t.odds_ratio) }));
  if (tr.length) {
    const pc = v => `${Math.round(Math.abs(v) * 100)}%`;
    const buckets = [...new Map(tr.map(t => [t.from, t])).values()];
    const pn = v => Math.round(Math.abs(v) * 100);
    const tl = buckets.map(t => t.from <= -50 ? `−${pn(t.to)}%<br>и больше` : t.to >= 50 ? `+${pn(t.from)}%<br>и больше`
      : t.from < 0 && t.to > 0 ? '≈ 0' : t.to <= 0 ? `−${pn(t.to)}…<br>${pn(t.from)}%` : `+${pn(t.from)}…<br>${pn(t.to)}%`);
    const curB = odds.trend ? buckets.findIndex(t => t.from === Number(odds.trend.trend_from)) : -1;
    const POS = [['ставка ниже средней за 10 лет', '#58a6ff'], ['около средней', '#8b949e'], ['выше средней', '#f0a03c']];
    Plotly.newPlot('plot_kr_trend', POS.map(([name, color], p) => {
      const row = buckets.map(b => tr.find(t => t.from === b.from && t.pos === p));
      return { type: 'bar', name, x: tl, y: row.map(t => t?.r ?? 1), base: 0,
        marker: { color, line: { color: row.map((_, i) => i === curB && p === odds.position ? '#f85149' : 'rgba(0,0,0,0)'), width: 3 } },
        text: row.map(t => (t?.r ?? 1).toFixed(2)), textposition: 'outside', textfont: { size: 9, color: '#c9d1d9' }, cliponaxis: false,
        customdata: row.map(t => [Math.round(Number(t?.obs_up ?? 0) * 100), Math.round(Number(t?.exp_up ?? 0) * 100), t?.n ?? 0]),
        hovertemplate: `%{x}, ${name}: потом повышали в %{customdata[0]}% случаев, при таком положении ставки обычно %{customdata[1]}% → ×%{y:.2f}<extra></extra>` };
    }), { ...dark, barmode: 'group', showlegend: true, legend: { orientation: 'h', y: -0.32, font: { size: 10 } }, margin: { l: 45, r: 10, t: 30, b: 95 },
        hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
        xaxis: { type: 'category', title: { text: 'изменение ставки за год, % от её размаха за 10 лет (− снизили, + подняли)', font: { size: 11 } }, tickangle: 0, tickfont: { size: 10 } },
        yaxis: { type: 'log', range: [Math.log10(0.15), Math.log10(7)], tickvals: [0.2, 0.5, 1, 2, 5], ticktext: ['×0.2', '×0.5', '×1', '×2', '×5'], gridcolor: '#1e2830' },
        shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 1, y1: 1, line: { color: '#8b949e', width: 1, dash: 'dash' } }],
        annotations: curB >= 0 && odds.range ? [{ x: tl[curB], y: Math.log10(7), yanchor: 'top', showarrow: false, font: { color: '#f85149', size: 11 },
          text: `сейчас ${odds.change > 0 ? '+' : ''}${odds.change} пп = ${odds.rel > 0 ? '+' : '−'}${pc(odds.rel)} размаха ${odds.range.min}–${odds.range.max}%` }] : [] },
      { responsive: true, displaylogo: false, displayModeBar: false });
  }
  // the formula, today's numbers in it
  if (key && op.length) {
    const p = levelPct / 100, k = odds.ratio, kb = odds.kb;
    const lp = Math.abs(Math.log(p / (1 - p))), lk = Math.abs(MP_TREND_BETA * Math.log(k));
    document.getElementById('kr_formula').innerHTML = `Флоатеров = p·k<sup>${MP_TREND_BETA}</sup> / (p·k<sup>${MP_TREND_BETA}</sup> + 1 − p), где p — доля по уровню ключевой (диаграмма «Без „не изменится“»), k — поправка за изменение ставки за год по 49 центробанкам мира, включая ЦБ РФ (диаграмма «Инерция»), ослабленная степенью ${MP_TREND_BETA}.
      Сейчас: p = ${levelPct}%, k = ×${k}, k<sup>${MP_TREND_BETA}</sup> = ×${kb.toFixed(3)} → ${p.toFixed(3)}·${kb.toFixed(3)} / (${p.toFixed(3)}·${kb.toFixed(3)} + ${(1 - p).toFixed(3)}) = <b>${(Math.round(floatBase * 10) / 10)}%</b>${floatBonus > 0.005 ? `; с бонусом лесенки ${Math.round(floatBonus * 100)}% от остатка — <b>${floatPct}%</b>` : ''}.
      Вклад в сдвиг от 50/50: p — ${Math.round(lp / (lp + lk || 1) * 100)}%, k — ${Math.round(lk / (lp + lk || 1) * 100)}%.`;
  }
  Plotly.newPlot('plot_mat_floatfn', [
    { x: op.map(p => p.rate), y: op.map(p => p.floaters_pct), type: 'scatter', mode: 'lines+markers', line: { color: '#a371f7', width: 2.5 }, marker: { size: 6 },
      customdata: op.map(p => [`${p.rate_from}–${p.rate_to}%`, (p.up * 100).toFixed(0), (p.down * 100).toFixed(0), p.days]),
      hovertemplate: 'ключевая %{customdata[0]}: повысят %{customdata[1]}%, понизят %{customdata[2]}% (%{customdata[3]} дн.)<br>→ флоатеров %{y:.1f}%<extra></extra>' },
    ...(op.length && odds.ratio !== 1 ? [{ x: op.map(p => p.rate), y: op.map(p => odds.withTrend(p.rate)), type: 'scatter', mode: 'lines',
      line: { color: '#f0a03c', width: 2, dash: 'dot' }, hovertemplate: `с нынешним трендом (×${odds.kb.toFixed(2)}): %{y:.1f}%<extra></extra>` }] : []),
    // the final share: with the ladder's bonus at each rate (06.11.2026)
    ...(op.length && odds.horizon.length ? [{ x: op.map(p => p.rate), type: 'scatter', mode: 'lines+markers', name: 'итог',
      y: op.map(p => { const base = odds.withTrend(p.rate), b = mpLadderAuto(odds.horizon, p.rate, age, 1)?.bonus || 0; return base + b * (100 - base); }),
      customdata: op.map(p => Math.round((mpLadderAuto(odds.horizon, p.rate, age, 1)?.bonus || 0) * 100)),
      marker: { size: 5 },
      line: { color: '#3dd68c', width: 2.5 }, hovertemplate: 'итог (бонус лесенки %{customdata}% от остатка): <b>%{y:.1f}%</b><extra></extra>' }] : []),
    ...(key && op.length ? [{ x: [key.now], y: [floatPct], type: 'scatter', mode: 'markers+text', marker: { size: 12, color: '#f85149' },
      text: [`сейчас ${key.now}% → ${floatPct}%`], textposition: 'middle right', textfont: { color: '#e6edf3' }, hoverinfo: 'skip' }] : []),
  ], { ...dark, showlegend: false, margin: { l: 50, r: 20, t: 10, b: 45 }, hovermode: 'x unified',
    hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
    xaxis: { title: 'ключевая ставка', ticksuffix: '%', range: [3, 23], dtick: 1, gridcolor: '#1e2830', zeroline: false },
    yaxis: { title: 'флоатеров = вероятность повышения', ticksuffix: '%', range: [-3, 103], dtick: 10, gridcolor: '#1e2830', zeroline: false } },
    { responsive: true, displaylogo: false, displayModeBar: false });
}

// The floaters by term and spread (asked 05.11.2026). A floater's coupon
// follows the key rate, so its term hardly matters -- but its spread over the
// key rate is fixed for the whole term: if the market's spreads widen by
// 1 pp, a bond with N years left loses some N% of its price (a short one
// little -- the green zone, up to 3 years); a long one is worth it at a
// bigger spread. The spread: the coupon now over the key rate (the CBR's),
// plus the price's discount to the face spread over the years left.
// `plan` -- the buy plan's floaters ({ secid, name, mat, usd, n }): one held
// grows by them, a new one joins, outlined green (06.11.2026)
async function mpMatDrawFloat(c, plan = []) {
  const { dark, key, money, plotFloat, shown } = c;
  const held = shown.filter(r => r.floating && r.next && r.unit === 'RUB');
  const extra = plan.filter(p => !held.some(r => r.ticker === p.secid));
  const extraDates = extra.length ? await mpMoexBondDates(extra.map(p => p.secid)) : {};
  const floaters = [
    ...held.map(r => { const p = plan.find(q => q.secid === r.ticker); return { ...r, usd: r.usd + (p?.usd || 0), plannedN: p?.n || 0 }; }),
    ...extra.map(p => ({ ticker: p.secid, name: p.name, next: p.mat, usd: p.usd, rate: extraDates[p.secid]?.rate ?? null, plannedN: p.n, isNew: true })),
  ];
  plotFloat.style.display = floaters.length ? '' : 'none';
  if (!floaters.length) return;
  const md = await fetch(`https://iss.moex.com/iss/engines/stock/markets/bonds/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID,PREVWAPRICE,PREVPRICE&securities=${floaters.map(r => r.ticker).join(',')}`)
    .then(r => r.json()).catch(() => null);
  const priceOf = new Map((md?.securities?.data || []).filter(([, w, p]) => w || p).map(([id, w, p]) => [id, Number(w || p)]));
  const pts = floaters.map(r => {
    const years = Math.max(0.05, (Date.parse(r.next) - Date.now()) / (365 * 86400000));
    const price = priceOf.get(r.ticker) ?? 100;
    const spread = r.rate != null && key ? r.rate - key.now + (100 - price) / years : null;
    return { r, years, price, spread, ofz: /^SU/.test(r.ticker) };
  }).filter(p => p.spread != null);
  const maxX = Math.max(5, ...pts.map(p => p.years + 0.5));
  const maxUsdF = Math.max(...pts.map(p => p.r.usd), 1);
  const name = p => (p.r.plannedN ? '+ ' : '') + (p.r.name.length > 26 ? p.r.name.slice(0, 25) + '…' : p.r.name);
  Plotly.newPlot(plotFloat, [{
    type: 'scatter', mode: 'markers+text', x: pts.map(p => p.years), y: pts.map(p => p.spread),
    text: pts.map(name), textposition: 'top center', textfont: { size: 11, color: pts.map(p => p.r.plannedN ? '#3dd68c' : '#c9d1d9') },
    marker: { size: pts.map(p => 12 + 28 * Math.sqrt(p.r.usd / maxUsdF)), color: pts.map(p => p.ofz ? '#c9b3ff' : '#a371f7'),
      line: { color: pts.map(p => p.r.plannedN ? '#3dd68c' : '#0d1117'), width: pts.map(p => p.r.plannedN ? 3 : 1) } },
    customdata: pts.map(p => [p.r.next, money(p.r.usd), p.r.rate.toFixed(2), p.price.toFixed(2), p.years.toFixed(1),
      p.r.plannedN ? `<br><b>план: +${p.r.plannedN} шт</b>${p.r.isNew ? ' (новая)' : ''}` : '', `${p.spread >= 0 ? '+' : '−'}${Math.abs(p.spread).toFixed(2).replace('.', ',')}`]),
    hovertemplate: '<b>%{text}</b><br>до %{customdata[0]} (%{customdata[4]} г.) · %{customdata[1]}<br>купон сейчас %{customdata[2]}%, цена %{customdata[3]}%'
      + '<br>надбавка к ключевой ≈ %{customdata[6]} пп<br>надбавки на рынке +1 пп → цена ≈ −%{customdata[4]}%%{customdata[5]}<extra></extra>',
  }], { ...dark, title: 'Флоатеры: срок и надбавка к ключевой', showlegend: false, margin: { l: 50, r: 20, t: 50, b: 40 },
    hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
    xaxis: { title: 'лет до погашения / оферты', range: [0, maxX], gridcolor: '#1e2830', zeroline: false },
    yaxis: { title: 'надбавка, пп', gridcolor: '#1e2830', zerolinecolor: '#30363d', range: [Math.min(-1, ...pts.map(p => p.spread - 1)), Math.max(3, ...pts.map(p => p.spread + 1))] },
    shapes: [{ type: 'rect', xref: 'x', yref: 'paper', x0: 0, x1: 3, y0: 0, y1: 1, fillcolor: 'rgba(61,214,140,0.07)', line: { width: 0 }, layer: 'below' }],
    annotations: [{ xref: 'x', yref: 'paper', x: 1.5, y: 1, yanchor: 'top', showarrow: false, font: { size: 11, color: '#3dd68c' }, text: 'до 3 лет: рост надбавок почти не бьёт по цене' },
      { xref: 'x', yref: 'paper', x: (3 + maxX) / 2, y: 1, yanchor: 'top', showarrow: false, font: { size: 11, color: '#8b949e' }, text: 'длиннее — только за бо́льшую надбавку' }] },
    { responsive: true, displaylogo: false });
  // a ball: its price chart
  plotFloat.removeAllListeners?.('plotly_click');
  plotFloat.on('plotly_click', ev => { const p = pts[ev.points?.[0]?.pointIndex]; if (p) mpOpenPriceDialog(p.r.ticker, p.r.name || p.r.ticker); });
}

// the scale by the ladder's targets (06.11.2026: a year far over them --
// 2028's $518 -- flattened the ladder's shape): bars over the top cut, their
// sum written at the top with an arrow
// in roubles (06.11.2026: they're Russian bonds -- the dollars were the
// portfolio's unit); KR: dollars -> roubles
// `add` -- the buy plan's face by year ({ fixed: year -> $, float: year -> $ }):
// a hatched layer over the bars, the targets with it in (06.11.2026)
function mpMatDrawYears(c, add = null) {
  const { KR, auto, dark, floatPct, from, mvAll, mvBonds, mvFixedBy, mvFloatBy, rub, rungs, to, weightOf, weightSum, withFloaters } = c;
  const aF = y => add?.fixed.get(y) || 0, aL = y => add?.float.get(y) || 0;
  const addAll = add ? [...add.fixed.values(), ...add.float.values()].reduce((t, v) => t + v, 0) : 0;
  // the deposit the money comes from: its year's bar less it
  const dUsd = add?.dep?.usd || 0, dY = add?.dep?.y;
  // the targets as the pies': the ladder's share of the rouble market value, purchases in
  const lAll = mvAll - dUsd + addAll - (mvBonds + addAll) * floatPct / 100;
  const tOf = y => weightOf.has(y) ? lAll * weightOf.get(y) / weightSum : 0;
  const yys = [...new Set([...mvFixedBy.keys(), ...(withFloaters ? mvFloatBy.keys() : []), ...rungs, ...(add ? [...add.fixed.keys(), ...(withFloaters ? add.float.keys() : [])] : [])])].sort();
  const fixedV = y => (mvFixedBy.get(y) || 0) - (y === dY ? dUsd : 0), floatV = y => mvFloatBy.get(y) || 0;
  const totA = y => fixedV(y) + aF(y) + (withFloaters ? floatV(y) + aL(y) : 0);
  const perR = Math.max(0, ...rungs.map(tOf));
  const yTop = Math.max(perR * 2.2, 1);
  const over = y => totA(y) > yTop;
  Plotly.newPlot('plot_mat_years', [
    { type: 'bar', name: 'постоянный купон и вклады', x: yys, y: yys.map(y => fixedV(y) * KR), marker: { color: '#58a6ff' }, hovertemplate: '%{y:,.0f} ₽' },
    ...(withFloaters ? [{ type: 'bar', name: 'флоатеры', x: yys, y: yys.map(y => floatV(y) * KR), marker: { color: '#a371f7' }, hovertemplate: '%{y:,.0f} ₽' }] : []),
    ...(addAll ? [{ type: 'bar', name: 'покупки по плану', x: yys, y: yys.map(y => (aF(y) + (withFloaters ? aL(y) : 0)) * KR),
      marker: { color: 'rgba(88,166,255,0.35)', line: { color: '#58a6ff', width: 1 }, pattern: { shape: '/', fgcolor: '#58a6ff', solidity: 0.3 } }, hovertemplate: 'покупки: %{y:,.0f} ₽' }] : []),
    { type: 'scatter', mode: 'text', x: yys, y: yys.map(y => (over(y) ? yTop * 0.93 : totA(y)) * KR), text: yys.map(y => (over(y) ? '↑ ' : '') + rub(totA(y))), textposition: yys.map(y => over(y) ? 'middle center' : 'top center'), textfont: { color: yys.map(y => over(y) ? '#0d1117' : '#c9d1d9') }, showlegend: false, hoverinfo: 'skip', cliponaxis: false },
    // the ladder's target per year: a tick over the bar; outside the ladder 0
    { type: 'scatter', mode: 'markers', name: `цель лесенки ${from}–${to}${auto ? ` (по вероятностям ЦБ: ${auto.years} лет)` : ' (таблицы не загружены: ровно)'}${addAll ? ', с покупками' : ''}`, x: yys, y: yys.map(y => tOf(y) * KR),
      marker: { symbol: 'line-ew-open', size: 34, color: '#d62728', line: { width: 3, color: '#d62728' } },
      customdata: yys.map(y => { const d = fixedV(y) + aF(y) - tOf(y); return `${d >= 0 ? 'перебор' : 'недобор'} ${rub(Math.abs(d))}${withFloaters && floatV(y) ? ' (флоатеры не в счёт)' : ''}`; }),
      hovertemplate: '%{y:,.0f} ₽ — %{customdata}' },
  ], { ...dark, barmode: 'stack', title: 'Рублёвые по году погашения: рыночная стоимость, ₽', margin: { l: 50, r: 20, t: 50, b: 30 },
    hovermode: 'x unified', hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
    legend: { orientation: 'h', y: -0.15 }, yaxis: { gridcolor: '#1e2830', ticksuffix: ' ₽', tickformat: ',.0f', range: [0, yTop * KR] }, xaxis: { type: 'category' } },
    { responsive: true, displaylogo: false });
}

// the yuan chart, the same way: `add` -- year -> $ of face
function mpMatDrawCnyYears(c, add = null) {
  const { cauto, cf, cnyAll, cnyEl, cr, ct, dark, mvCnyBy, odds, usdPer } = c;
  if (!(cnyAll > 0)) return;
  const aC = y => add?.get(y) || 0, addAll = add ? [...add.values()].reduce((t, v) => t + v, 0) : 0;
  const mvC = y => mvCnyBy.get(y) || 0, mvCAll = [...mvCnyBy.values()].reduce((t, v) => t + v, 0);
  const cys = [...new Set([...mvCnyBy.keys(), ...cr, ...(add ? add.keys() : [])])].sort();
  const ctot = y => mvC(y) + aC(y);
  const ct2 = y => { const i = cr.indexOf(y); return i < 0 ? 0 : (mvCAll + addAll) * (cauto ? cauto.weights[i] : 1 / cr.length); };
  const KC = 1 / (usdPer('CNY') || 1), yuan = v => `${Math.round(v * KC).toLocaleString('ru-RU')} ¥`;
  Plotly.newPlot(cnyEl, [
    { type: 'bar', name: 'в юанях', x: cys, y: cys.map(y => mvC(y) * KC), marker: { color: '#f778ba' }, hovertemplate: '%{y:,.0f} ¥' },
    ...(addAll ? [{ type: 'bar', name: 'покупки по плану', x: cys, y: cys.map(y => aC(y) * KC),
      marker: { color: 'rgba(247,120,186,0.35)', line: { color: '#f778ba', width: 1 }, pattern: { shape: '/', fgcolor: '#f778ba', solidity: 0.3 } }, hovertemplate: 'покупки: %{y:,.0f} ¥' }] : []),
    { type: 'scatter', mode: 'text', x: cys, y: cys.map(y => ctot(y) * KC), text: cys.map(y => yuan(ctot(y))), textposition: 'top center', showlegend: false, hoverinfo: 'skip', cliponaxis: false },
    { type: 'scatter', mode: 'markers', name: `цель юаневой лесенки ${cf}–${ct}${cauto ? ` (по ставке Банка Китая ${odds.cnNow}%: ${cauto.years} лет)` : ' (таблицы не загружены: ровно)'}${addAll ? ', с покупками' : ''}`, x: cys, y: cys.map(y => ct2(y) * KC),
      marker: { symbol: 'line-ew-open', size: 34, color: '#d62728', line: { width: 3, color: '#d62728' } },
      customdata: cys.map(y => { const d = ctot(y) - ct2(y); return `${d >= 0 ? 'перебор' : 'недобор'} ${yuan(Math.abs(d))}`; }),
      hovertemplate: '%{y:,.0f} ¥ — %{customdata}' },
  ], { ...dark, barmode: 'stack', title: 'В юанях по году погашения: рыночная стоимость, ¥', margin: { l: 50, r: 20, t: 50, b: 30 },
    hovermode: 'x unified', hoverlabel: { bgcolor: '#13191f', bordercolor: '#1e2830', font: { color: '#c9d1d9' } },
    legend: { orientation: 'h', y: -0.18 }, yaxis: { gridcolor: '#1e2830', ticksuffix: ' ¥', tickformat: ',.0f', range: [0, Math.max(...cys.map(ctot), ...cr.map(ct2), 1) * 1.2 * KC] }, xaxis: { type: 'category' } },
    { responsive: true, displaylogo: false });
}

// flows: [[years from the start, amount]]: the effective yearly rate, % (bisection); null: none
function mpIrr(flows) {
  const npv = r => flows.reduce((t, [t0, a]) => t + a / (1 + r) ** t0, 0);
  let lo = -0.9, hi = 3;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (npv(lo) * npv(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2 * 100;
}

// by the deals (06.11.2026): each purchase's own yield -- its price with the
// accrued coupon on its day against what the bond pays after it (coupons,
// amortisations, the face back -- or at the offer, as MOEX's), effective a
// year; a floater's -- its coupon now over the price paid. The held bond's
// -- its purchases' by quantity; a sale takes from all alike
// -- heldBonds: the bonds held; mkt: mpBondMarket's figures; deals: their trades
function mpMatDealYields(heldBonds, mkt, deals) {
  const dealYield = new Map();
  for (const r of heldBonds) {
    const buys = (deals || []).filter(d => d.ticker === r.ticker && d.side === 'buy' && Number(d.quantity) > 0);
    if (!buys.length) continue;
    const m = mkt.get(r.ticker) || {}, freq = m.period ? 365 / m.period : 2;
    let w = 0, sum = 0;
    for (const d of buys) {
      const q = Number(d.quantity), day = d.trade_date, yrs = x => (Date.parse(x) - Date.parse(day)) / (365 * 86400000);
      const end = r.offer && r.offer > day ? r.offer : r.mat;
      const faceLeft = r.allA.filter(([dt]) => dt > day).reduce((t, [, v]) => t + v, 0) || 1000;
      // the price: % of the face (Sber) or money a bond (T-Bank, Alfa) -- over 200 it's money
      const pct = Number(d.price) > 200 ? Number(d.price) / faceLeft * 100 : Number(d.price);
      const paid = pct / 100 * faceLeft + (Number(d.nkd) || 0) / q;
      let y;
      if (r.floating) y = r.rate != null ? r.rate / (pct / 100) : null;
      else {
        let last = 0;
        const flows = [[0, -paid]];
        for (const [dt, v] of r.allC) { if (v) last = v; if (dt > day && (!end || dt <= end)) flows.push([yrs(dt), v || last]); }
        let amortised = 0;
        for (const [dt, v] of r.allA) if (dt > day && (!end || dt < end)) { flows.push([yrs(dt), v]); amortised += v; }
        if (end) flows.push([yrs(end), faceLeft - amortised]);
        y = mpIrr(flows);
      }
      if (y == null || !Number.isFinite(y)) continue;
      w += q; sum += q * y;
    }
    if (w) dealYield.set(r.ticker, { eff: sum / w, ytm: freq * ((1 + sum / w / 100) ** (1 / freq) - 1) * 100 });
  }
  return dealYield;
}

// what to buy (06.11.2026): the OFZ-PD (fixed-coupon OFZ, 25xxx/26xxx)
// maturing in a ladder year -- the best yield of those trading over 1 mln
// roubles a day; the floaters -- an OFZ-PK (29xxx) 1-3 years out, the most
// traded. With money to invest (roubles, the field): one bond at a time
// into the bucket furthest under its target -- the targets taken with the
// money in -- till the money's out; without it, what closes every shortfall
// c: mpRenderMaturities' figures; sets mpBondCtx (the salary plan's bond buyer)
async function mpMatBuyPlan(c) {
  const { cauto, cr, fixedMV, floatPct, key, mvAll, mvCnyBy, mvDeposits, mvFloat, pieCny, pieLiquid, pieRub, pieW, rub, rungs, shown, sumMap, usdPer, weightOf, weightSum } = c;
  const ofz = await mpOfzList();
  const rubUsd = usdPer('RUB') || 1;
  const cost = b => ((b.price || 100) / 100 * b.face + (b.accrued || 0)) * rubUsd;
  const liquid = ofz.filter(b => (b.turnover || 0) > 1e6 && (b.pk || b.yield > 0));   // a floater has no yield on MOEX
  const pk = await mpBestPk(ofz, key?.now ?? null);
  // the yuan side (06.11.2026: all three kinds in one plan): the ladder's
  // years, the reliable corporates due in each
  const cnyBondsAll = await mpCnyBondList();
  const cnyUsd = usdPer('CNY') || 0;
  const costOf = r => r.kind === 'cny' ? (r.b.price / 100 * r.b.face + r.b.accrued) * cnyUsd : cost(r.b);
  const cnyMVAll = sumMap(mvCnyBy);
  const buckets = [
    ...rungs.map(y => ({ kind: 'fixed', key: y, w: weightOf.get(y) / weightSum, cur: fixedMV(y),
      b: liquid.filter(b => b.pd && b.mat.startsWith(y)).sort((a, c) => c.yield - a.yield)[0] })),
    { kind: 'float', key: '—', cur: mvFloat, b: pk },
    ...(cnyUsd ? cr.map((y, i) => ({ kind: 'cny', key: y, w: cauto ? cauto.weights[i] : 1 / cr.length, cur: mvCnyBy.get(y) || 0,
      b: cnyBondsAll.filter(o => o.due.startsWith(y)).sort((a, c) => c.yield - a.yield || c.turnover - a.turnover)[0] })) : []),
  ];
  mpBondCtx = {
    session() {
      const spentBy = new Map(); let spentRub = 0, spentCny = 0;
      return (ccy, usd) => {
        const cny = ccy === 'CNY';
        const pool = buckets.map((k, i) => ({ ...k, i })).filter(k => k.b && (cny ? k.kind === 'cny' : k.kind !== 'cny'));
        const total = cny ? cnyMVAll + spentCny + usd : mvAll + spentRub + usd;
        const floatT = cny ? 0 : Math.max(0, total - mvDeposits) * floatPct / 100, ladderT = total - floatT;
        const target = k => cny ? total * k.w : k.kind === 'float' ? floatT : ladderT * k.w;
        const buys = new Map();
        let left = usd;
        for (let guard = 0; guard < 100000; guard++) {
          const can = pool.filter(k => costOf(k) <= left + 1e-9);
          if (!can.length) break;
          // as the tab's: roubles short times the share of the target short
          const score = k => { const t = target(k), g = t - k.cur - (spentBy.get(k.i) || 0); return t > 0 && g > 0 ? g * g / t : g; };
          const k = can.sort((a, c) => score(c) - score(a))[0];
          const price = costOf(k);
          spentBy.set(k.i, (spentBy.get(k.i) || 0) + price); left -= price;
          const b = buys.get(k.b.secid) || { ticker: k.b.secid, name: k.b.name, units: 0, usd: 0 };
          b.units++; b.usd += price; buys.set(k.b.secid, b);
        }
        const spent = usd - left;
        if (cny) spentCny += spent; else spentRub += spent;
        return { buys: [...buys.values()], left };
      };
    },
  };
  // the yield cards (06.11.2026): the bonds held and the plan's, by market
  // value -- current yield (the coupon over the price), yield to maturity
  // (MOEX's effective one, unreinvested by the coupon's frequency), the
  // effective one, duration; a floater's yields -- its coupon now
  const heldBonds = shown.filter(r => !r.deposit && r.unit);
  const mkt = await mpBondMarket([...heldBonds.map(r => r.ticker), ...buckets.filter(k => k.b).map(k => k.b.secid)]);
  const figures = (secid, r) => {
    const m = mkt.get(secid) || {};
    const coupon = m.coupon ?? r?.rate ?? null, price = m.price || (r ? null : 100);
    const eff = m.yield > 0 ? m.yield : coupon, freq = m.period ? 365 / m.period : 2;
    const yrs = r?.next ? Math.max(0, (Date.parse(r.next) - Date.now()) / (365 * 86400000)) : null;
    return { cur: coupon != null ? coupon / ((price || 100) / 100) : null, eff, ytm: eff != null ? freq * ((1 + eff / 100) ** (1 / freq) - 1) * 100 : null,
      dur: m.dur > 0 ? m.dur / 365 : (r?.floating || !m.coupon ? (m.period || 91) / 365 / 2 : yrs) };
  };
  const { data: deals } = await sb.from('trades').select('ticker, side, quantity, price, nkd, trade_date')
    .in('ticker', heldBonds.map(r => r.ticker).length ? heldBonds.map(r => r.ticker) : ['-']).in('side', ['buy', 'sell']);
  const dealYield = mpMatDealYields(heldBonds, mkt, deals);
  const metricsCards = plans => {
    const groups = [['₽ рублёвые облигации', r => r.unit === 'RUB', p => p.kind !== 'cny'], ['¥ юаневые облигации', r => r.unit !== 'RUB', p => p.kind === 'cny']];
    return groups.map(([title, heldOk, planOk]) => {
      const items = [
        ...heldBonds.filter(heldOk).map(r => { const f = figures(r.ticker, r), d = dealYield.get(r.ticker); return { v: r.usd, ...f, dEff: d?.eff ?? f.eff, dYtm: d?.ytm ?? f.ytm }; }),
        // the plan's are bought at today's price: their deals' yield is the market's
        ...plans.filter(p => p.spent > 0 && p.b && planOk(p)).map(p => { const f = figures(p.b.secid, null); return { v: p.spent, ...f, dEff: f.eff, dYtm: f.ytm }; }),
      ];
      const avg = k => { const xs = items.filter(i => i[k] != null && Number.isFinite(i[k])); const w = xs.reduce((t, i) => t + i.v, 0); return w ? xs.reduce((t, i) => t + i.v * i[k], 0) / w : null; };
      if (!items.length) return '';
      const pct = v => v == null ? '—' : `${v.toFixed(2).replace('.', ',')}%`;
      const card = (label, val, deal) => `<div style="flex:1 1 150px;min-width:0;background:#13191f;border:1px solid #1e2830;border-radius:8px;padding:10px 14px">
          <div style="color:#8b949e;font-size:0.8rem">${label}</div><div style="font-size:1.4rem;font-weight:600;font-variant-numeric:tabular-nums">${val}${deal ? ` <span style="font-size:0.85rem;font-weight:400;color:#8b949e">${deal} по сделкам</span>` : ''}</div></div>`;
      return `<div style="margin:6px 0 4px;color:#8b949e;font-size:0.85rem">${title}${plans.some(p => p.spent > 0 && planOk(p)) ? ' — с покупками' : ''}</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px">${card('Текущая доходность', pct(avg('cur')))}${card('Доходность к погашению', pct(avg('ytm')), pct(avg('dYtm')))}
          ${card('Эффективная доходность', pct(avg('eff')), pct(avg('dEff')))}${card('Дюрация, лет', avg('dur') == null ? '—' : avg('dur').toFixed(1).replace('.', ','))}</div>`;
    }).join('');
  };
  const td = 'style="padding:4px 10px;text-align:left;white-space:nowrap"', tdr = 'style="padding:4px 10px;text-align:right;white-space:nowrap"';
  const box = document.getElementById('mat_buy');
  let money = 0, whole = true, depFrom = '';
  // the sum starts at 0 every time (06.11.2026); the whole-bonds switch is remembered
  try { whole = localStorage.getItem('mp_mat_invest_whole') !== '0'; } catch { /* no storage */ }
  // where the money comes from (06.11.2026: "90k -- the deposit closing in
  // a month"): new money, or a rouble deposit closed -- then the deposit
  // leaves the rouble part by as much and the whole stays
  const rubDeposits = shown.filter(r => r.deposit && (r.currency || 'RUB') === 'RUB' && r.mat).sort((a, c) => a.mat.localeCompare(c.mat));
  try { depFrom = localStorage.getItem('mp_mat_invest_from') || ''; } catch { /* no storage */ }
  if (!rubDeposits.some(r => r.ticker === depFrom)) depFrom = '';
  const depOf = M => { const r = rubDeposits.find(d => d.ticker === depFrom); return r ? { row: r, y: r.mat.slice(0, 4), usd: Math.min(M, r.usd) } : null; };
  const plan = () => {
    const M = money * rubUsd;   // dollars
    // the targets with the money in (or as they are, without it): yuan vs
    // rouble by w_CNY over the first pie's whole (the money-market funds
    // stay as they are), the rouble part -- floaters by their share of the
    // bonds, the rest the ladder
    const dep = M > 0 ? depOf(M) : null, D = dep ? dep.usd : 0;
    const whole0 = pieRub - D + pieCny + M;
    // w_CNY of the whole -- or, the dollar between the lines, the yuan as held
    const cnyT = pieW != null ? wCnyTarget(pieW / 100, pieCny, whole0) : cnyMVAll + M * (pieCny / ((pieRub + pieCny) || 1));
    // no yuan bought unless the yuan's target is over what's held (06.11.2026:
    // the yuan's years under their share were topped up while the yuan as a
    // whole were held as they are)
    const cnyOk = cnyT > pieCny + 1e-6;
    const rubT = Math.max(0, whole0 - cnyT - pieLiquid);
    const floatT = Math.max(0, rubT - (mvDeposits - D)) * floatPct / 100, ladderT = rubT - floatT;
    const target = k => k.kind === 'float' ? floatT : k.kind === 'cny' ? cnyT * k.w : ladderT * k.w;
    const rows = buckets.map(k => ({ ...k, cur: k.kind === 'fixed' && dep && k.key === dep.y ? k.cur - D : k.cur, t: target(k), n: 0, spent: 0 }));
    if (M > 0) {
      let left = M;
      const step = whole ? null : M / 500;
      for (let guard = 0; guard < 100000; guard++) {
        const can = rows.filter(r => r.b && (r.kind !== 'cny' || cnyOk) && (whole ? costOf(r) <= left + 1e-9 : left > 1e-9));
        if (!can.length) break;
        // roubles short times the share of the target short -- short^2 / target
        // (06.11.2026: by the share alone a small sum topped the small years
        // at the ladder's ends up first; by the roubles alone they waited last)
        const score = r => { const g = r.t - r.cur - r.spent; return r.t > 0 && g > 0 ? g * g / r.t : g; };
        const r = can.sort((a, c) => score(c) - score(a))[0];
        const amt = whole ? costOf(r) : Math.min(step, left);
        r.spent += amt; left -= amt; if (whole) r.n++;
      }
      if (!whole) rows.forEach(r => { r.n = r.b ? r.spent / costOf(r) : 0; });
      return { rows, left, dep };
    }
    // no money -- no purchases (06.11.2026: 0 bought what closed every shortfall)
    return { rows, left: 0, dep: null };
  };
  // the table (06.11.2026): what's held and what to buy, by kind (rouble
  // floaters, rouble fixed, yuan fixed, yuan floaters), then by year of
  // maturity; a year's (the floaters' -- the group's) target and what it
  // becomes once per year
  const yieldOf = new Map([...ofz.map(b => [b.secid, b.yield]), ...cnyBondsAll.map(b => [b.secid, b.yield])]);
  const heldKind = r => r.deposit ? ((r.currency || 'RUB') === 'RUB' ? 'fixed' : null)
    : r.unit === 'RUB' ? (r.floating ? 'float' : 'fixed') : (r.floating ? 'cnyfloat' : 'cny');
  const GROUPS = [['float', '₽ флоатер'], ['fixed', '₽ постоянный'], ['cny', '¥ постоянный'], ['cnyfloat', '¥ флоатер']];
  const draw = () => {
    const { rows: plans, left, dep } = plan();
    // the pies with what the money buys (none without a sum)
    if (money > 0) {
      const fixed = new Map(), cny = new Map(); let fl = 0;
      for (const p of plans) {
        if (!p.spent) continue;
        if (p.kind === 'float') fl += p.spent;
        else (p.kind === 'cny' ? cny : fixed).set(p.key, ((p.kind === 'cny' ? cny : fixed).get(p.key) || 0) + p.spent);
      }
      mpMatDrawPies(c, { fixed, float: fl, cny, dep });
    } else mpMatDrawPies(c, null);
    // the year charts and the bars, with the plan's bonds by face (06.11.2026)
    const bought = plans.filter(p => p.n > 0 && p.b);
    const faceUsd = p => p.spent;   // the year charts are by market value: what's paid
    const yr = p => (p.kind === 'cny' ? p.b.due : p.b.mat).slice(0, 4);
    const fFixed = new Map(), fFloat = new Map(), fCny = new Map();
    for (const p of bought) { const m = p.kind === 'cny' ? fCny : p.kind === 'float' ? fFloat : fFixed; m.set(yr(p), (m.get(yr(p)) || 0) + faceUsd(p)); }
    mpMatDrawYears(c, money > 0 ? { fixed: fFixed, float: fFloat, dep } : null);
    mpMatDrawCnyYears(c, money > 0 ? fCny : null);
    mpMatDrawFloat(c, money > 0 ? bought.filter(p => p.kind === 'float').map(p => ({ secid: p.b.secid, name: p.b.name, mat: p.b.mat, usd: p.spent, n: whole ? p.n : Math.round(p.n * 10) / 10 })) : []);
    mpMatDrawGantt(c, money > 0 ? bought.map(p => ({ secid: p.b.secid, name: p.b.name, mat: p.b.mat, offer: p.kind === 'cny' ? p.b.offer : null, usd: p.spent,
      n: whole ? p.n : Math.round(p.n * 10) / 10, kind: p.kind })) : []);
    const spent = plans.reduce((t, r) => t + r.spent, 0);   // the purchases only: a deposit's money out isn't in
    const planOf = (kind, y) => plans.find(p => p.kind === kind && (kind === 'float' || p.key === y));
    const body = [];
    for (const [kind, label] of GROUPS) {
      const held = shown.filter(r => heldKind(r) === kind && r.mat);
      const years = new Set(held.map(r => r.mat.slice(0, 4)));
      if (kind === 'fixed') rungs.forEach(y => years.add(y));
      if (kind === 'cny') cr.forEach(y => years.add(y));
      const fp = kind === 'float' ? planOf('float') : null;
      if (fp && fp.b) years.add(fp.b.mat.slice(0, 4));
      const groupRows = [];
      for (const y of [...years].sort()) {
        const p = kind === 'float' ? (fp?.b?.mat.startsWith(y) ? fp : null) : planOf(kind, y);
        const items = held.filter(r => r.mat.startsWith(y)).map(r => ({ name: r.name, sub: r.offer ? `оферта ${r.offer.slice(5, 7)}.${r.offer.slice(0, 4)}` : '',
          yld: yieldOf.get(r.ticker), qty: r.deposit ? null : r.qty, each: r.deposit ? null : r.usd / (r.qty || 1), value: r.usd, n: 0,
          sum: dep && dep.row === r ? -dep.usd : 0, close: dep && dep.row === r, secid: r.ticker }));
        // the year's pick, marked whether or not the money reaches it (06.11.2026)
        if (p && p.b) {
          const mine = items.find(i => i.secid === p.b.secid);
          const each = costOf(p);
          if (mine) { mine.n = p.n; mine.sum = p.spent; mine.each = each; mine.rec = true; mine.sub = [mine.sub, 'рекомендация'].filter(Boolean).join(' · '); }
          else items.push({ name: p.b.name, sub: (kind === 'cny' && p.b.offer ? `оферта ${p.b.offer.slice(5, 7)}.${p.b.offer.slice(0, 4)} · ` : '') + 'рекомендация',
            yld: p.b.yield || null, qty: 0, each, value: 0, n: p.n, sum: p.spent, rec: true, secid: p.b.secid });
        }
        const cur = kind === 'fixed' ? fixedMV(y) : kind === 'cny' ? (mvCnyBy.get(y) || 0) : null;
        const t = kind === 'fixed' || kind === 'cny' ? (p ? p.t : 0) : null;
        const ySpent = items.reduce((s2, i) => s2 + i.sum, 0);
        if (!items.length && !(t > 5)) continue;
        if (!items.length) items.push({ name: kind === 'cny' ? 'надёжных юаневых выпусков на этот год нет' : 'ОФЗ-ПД с погашением в этом году нет', empty: true });
        groupRows.push({ y, items, cur, t, after: cur != null ? cur + ySpent : null });
      }
      if (!groupRows.length) continue;
      // the floaters: one target for the group
      const gT = kind === 'float' ? fp?.t : null, gCur = kind === 'float' ? mvFloat : null, gSpent = kind === 'float' ? (fp?.spent || 0) : 0;
      const gSpan = groupRows.reduce((t2, g) => t2 + g.items.length, 0);
      let firstOfGroup = true;
      for (const g of groupRows) g.items.forEach((i, k) => {
        const cells = [];
        cells.push(`<td ${td}>${firstOfGroup ? label : ''}</td>`);
        cells.push(`<td ${td}>${k === 0 ? g.y : ''}</td>`);
        cells.push(i.empty ? `<td ${td} colspan="6" style="color:#8b949e">${i.name}</td>`
          : `<td ${td}${i.secid && i.qty != null && !/^(DEPOSIT|SAVINGS|ВКЛАД):/.test(i.secid) ? ` data-chart="${mpEscapeHtml(i.secid)}" data-chart-title="${mpEscapeHtml(i.name)}"` : ''}>${mpEscapeHtml(i.name)}${i.sub ? ` <span style="color:${i.rec ? '#3dd68c' : '#8b949e'}">${i.sub}</span>` : ''}</td>`
            + `<td ${tdr}>${i.yld ? i.yld.toFixed(1) + '%' : '—'}</td><td ${tdr}>${i.each ? rub(i.each) : '—'}</td>`
            + `<td ${tdr}>${i.qty == null ? 'вклад' : i.qty || '—'}</td><td ${tdr}>${i.value ? rub(i.value) : '—'}</td>`
            + `<td ${tdr}>${i.close ? '<b style="color:#f85149">закрыть</b>' : i.n ? `<b style="color:#3dd68c">+${whole ? i.n : i.n.toFixed(1)}</b>` : i.rec ? '<span style="color:#8b949e">+0</span>' : ''}</td>`);
        cells.push(`<td ${tdr}>${i.sum ? (i.sum < 0 ? `<span style="color:#f85149">−${rub(-i.sum)}</span>` : rub(i.sum)) : ''}</td>`);
        if (kind === 'float') { if (firstOfGroup) cells.push(`<td ${tdr} rowspan="${gSpan}">${rub(gCur)}</td><td ${tdr} rowspan="${gSpan}">${rub(gT || 0)}</td><td ${tdr} rowspan="${gSpan}"><b>${rub(gCur + gSpent)}</b></td>`); }
        else if (kind === 'cnyfloat') { if (firstOfGroup) cells.push(`<td ${tdr} rowspan="${gSpan}" colspan="3" style="color:#8b949e">цели нет</td>`); }
        else if (k === 0) cells.push(`<td ${tdr} rowspan="${g.items.length}">${rub(g.cur)}</td><td ${tdr} rowspan="${g.items.length}">${rub(g.t)}</td><td ${tdr} rowspan="${g.items.length}"><b>${rub(g.after)}</b></td>`);
        body.push(`<tr${firstOfGroup ? ' style="border-top:2px solid #30363d"' : ''}>${cells.join('')}</tr>`);
        firstOfGroup = false;
      });
    }
    document.getElementById('mat_metrics').innerHTML = metricsCards(plans);
    box.innerHTML = `<div class="section-title" style="font-size:0.95rem">Облигации: что есть и что докупить</div>
        <div class="form-row" style="gap:16px;margin:4px 0 8px">
          <label>Сколько вложить, ₽: <input type="number" id="mat_invest" min="0" step="1000" value="${money}" style="width:190px"></label>
          <label>Откуда: <select id="mat_invest_from"><option value="">новые деньги</option>${rubDeposits.map(r => `<option value="${mpEscapeHtml(r.ticker)}"${r.ticker === depFrom ? ' selected' : ''}>${mpEscapeHtml(r.name)} — ${rub(r.usd)}, до ${r.mat.slice(8, 10)}.${r.mat.slice(5, 7)}.${r.mat.slice(0, 4)}</option>`).join('')}</select></label>
          <label><input type="checkbox" id="mat_invest_whole"${whole ? ' checked' : ''}> целыми облигациями</label>
        </div>
        <div><table class="data-table" style="width:auto"><thead><tr>
          <th ${td}>Вид</th><th ${td}>Год</th><th ${td}>Облигация</th><th ${tdr}>Доходность</th><th ${tdr}>За штуку</th><th ${tdr}>Есть, шт</th><th ${tdr}>Стоимость</th>
          <th ${tdr}>Купить, шт</th><th ${tdr}>На сумму</th><th ${tdr}>Год: сейчас</th><th ${tdr}>Цель</th><th ${tdr}>Станет</th></tr></thead><tbody>
          ${body.join('')}
          <tr style="border-top:2px solid #30363d"><td ${td} colspan="8"><b>Итого к покупке</b>${money ? ` · не потрачено ${rub(left)}` : ''}</td><td ${tdr}><b>${rub(spent)}</b></td><td colspan="3"></td></tr>
          ${dep ? `<tr><td ${td} colspan="8" style="color:#8b949e">из вклада: ${mpEscapeHtml(dep.row.name)}${dep.usd < dep.row.usd - 1e-6 ? ` (часть; остаётся ${rub(dep.row.usd - dep.usd)})` : ''}${money * rubUsd > dep.usd + 1e-6 ? ` · новых денег ${rub(money * rubUsd - dep.usd)}` : ''}</td><td ${tdr} style="color:#f85149">−${rub(dep.usd)}</td><td colspan="3"></td></tr>` : ''}
          </tbody></table></div>
        <p class="note">${money ? 'Зелёным — что купить.' : 'Введи сумму — появится, что на неё купить.'}</p>`;
    // (the money goes one bond at a time to where "the rouble shortfall × the share of the target missing" is the
    // largest -- the targets with what's put in: yuan and roubles by w_CNY, the floaters by their share, the rest
    // the ladder; values and targets at the market price in roubles, a buy at the day before's price with its NKD)
    box.querySelector('#mat_invest').addEventListener('change', e => {
      money = Math.max(0, Number(e.target.value) || 0);
      draw();
    });
    box.querySelector('#mat_invest_from').addEventListener('change', e => {
      depFrom = e.target.value;
      mpSave('mp_mat_invest_from', depFrom);
      // no sum yet -- the deposit's whole
      const d = rubDeposits.find(r => r.ticker === depFrom);
      if (d && !money) money = Math.floor(d.usd / rubUsd);
      draw();
    });
    box.querySelector('#mat_invest_whole').addEventListener('change', e => {
      whole = e.target.checked;
      mpSave('mp_mat_invest_whole', whole ? '1' : '0');
      draw();
    });
  };
  draw();
}

async function mpRenderMaturities() {
  const status = document.getElementById('mat_status');
  status.textContent = 'Loading…';
  const rows = await mpMatHeldRows(status);
  if (!rows) return;
  const today = new Date().toISOString().slice(0, 10);
  // the year charts by market value (06.11.2026: the face back at maturity wasn't wanted) -- no coupons
  const withDeposits = document.getElementById('mat_deposits').checked;
  const shown = rows.filter(r => (r.next || r.deposit) && (withDeposits || !r.deposit)).sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999'));
  status.textContent = shown.some(r => !r.next) ? 'У вклада не указана дата окончания — клик по нему на графике.' : '';
  const money = v => mpFormatUsd(v).replace(/\.\d+$/, '');
  const label = r => `${r.name.length > 34 ? r.name.slice(0, 33) + '…' : r.name}`;
  const dark = { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#c9d1d9' } };
  const span = (from, to) => (Date.parse(to) - Date.parse(from));
  const endOrMax = r => r.mat || r.offer || today;
  const el = document.getElementById('plot_mat');
  const c = { shown, today, money, label, dark, span, endOrMax, el };
  mpMatDrawGantt(c);
  // the money coming in by year, as MOEX schedules it: the face back
  // (redemptions, amortisations) and the coupons, times the bonds held, at
  // today's rates; a deposit its sum and its interest at its end
  const { data: fx } = await sb.from('fx_history').select('currency, usd_per_unit, day').in('currency', ['RUB', 'CNY', 'EUR']).order('day', { ascending: false }).limit(30);
  const usdPer = ccy => ccy === 'USD' ? 1 : Number((fx || []).find(f => f.currency === ccy)?.usd_per_unit) || 0;
  // the yuan (and any other currency's) face back by year: the yuan ladder's
  // whole (the rouble ladder goes by market value, below)
  const cnyFaceBy = new Map();
  // the same by market value (06.11.2026: the pies and the buy plan -- what
  // the money is worth now, not the face back): a bond's value spread over
  // its years as its face comes back
  const mvFixedBy = new Map(), mvFloatBy = new Map(), mvCnyBy = new Map();
  let mvDeposits = 0;
  const add = (m, day, usd) => { const y = day.slice(0, 4); m.set(y, (m.get(y) || 0) + usd); };
  for (const r of shown) {
    if (r.deposit) {
      if (!r.mat) continue;
      const rub = (r.currency || 'RUB') === 'RUB';
      if (!rub) add(cnyFaceBy, r.mat, r.usd);
      add(rub ? mvFixedBy : mvCnyBy, r.mat, r.usd); if (rub) mvDeposits += r.usd;
      continue;
    }
    const k = r.qty * usdPer(r.unit);
    if (r.unit !== 'RUB') {
      for (const f of r.face) add(cnyFaceBy, f.day, f.value * k);
      { const tf = r.face.reduce((t, f) => t + f.value, 0) || 1; for (const f of r.face) add(mvCnyBy, f.day, r.usd * f.value / tf); }
      continue;
    }
    { const tf = r.face.reduce((t, f) => t + f.value, 0) || 1; for (const f of r.face) add(r.floating ? mvFloatBy : mvFixedBy, f.day, r.usd * f.value / tf); }
  }
  // the target ladder (05.11.2026): the face of everything held spread over
  // its years -- evenly, or more in the far ones (1 : 2 : ... : n, to lock the
  // high rates in for longer) -- each year's maturing money bought into the far end.
  // A floater locks no rate in -- its coupon follows the key rate down -- so
  // it fills no rung: the rungs count the fixed coupons and the deposits, and
  // a floater's money, at its redemption or offer, goes into the rungs short
  // of their target (asked 05.11.2026). The floaters have their own share by
  // the key rate's odds (mpKeyRateOdds); the rungs share the rest
  const odds = await mpKeyRateOdds();
  // the ladder only by the CBR's odds (06.11.2026: no hand-set years or
  // shapes); till the tables load -- an even five years
  const age = new Date().getFullYear() - Number(document.getElementById('mat_birth').value || 1991);
  const auto = mpLadderAuto(odds.horizon, odds.now, age, 1);
  const from = new Date().getFullYear() + 1, to = from + (auto ? auto.years : 5) - 1;
  const rungs = [];
  for (let y = from; y <= to && to - from < 40; y++) rungs.push(String(y));
  const key = odds.now != null ? { now: odds.now } : null;
  const levelPct = key && odds.pts.length ? Math.round(odds.share(key.now) * 10) / 10 : 0;
  // the level's and the trend's share, plus the ladder's bonus on the rest
  const floatBase = key && odds.pts.length ? odds.withTrend(key.now) : 0;
  const floatBonus = auto?.bonus || 0;
  const floatPct = Math.round((floatBase + floatBonus * (100 - floatBase)) * 10) / 10;
  // the floaters' share is of the rouble bonds (asked 05.11.2026: the pie is
  // only them); the ladder -- the rouble face, deposits too, less the floaters' target
  const weightOf = new Map(rungs.map((y, i) => [y, auto ? auto.weights[i] : 1]));
  const weightSum = [...weightOf.values()].reduce((t, w) => t + w, 0);
  // the floaters out of the years' bars unless asked (05.11.2026): they fill
  // no rung; the ladder and the pie still count them
  const withFloaters = document.getElementById('mat_floaters').checked;
  // by market value: the totals, the ladder's targets, a year's fixed coupons
  const sumMap = m => [...m.values()].reduce((t, v) => t + v, 0);
  const mvFloat = sumMap(mvFloatBy), mvAll = sumMap(mvFixedBy) + mvFloat, mvBonds = mvAll - mvDeposits;
  const ladderMV = mvAll - mvBonds * floatPct / 100;
  const targetMV = y => weightOf.has(y) ? ladderMV * weightOf.get(y) / weightSum : 0;
  const fixedMV = y => mvFixedBy.get(y) || 0;
  // the ladder's tables: down / up / the net per horizon x key rate, today's
  // rate's column (the ladder's years) and the ladder's years outlined
  mpLadderHeat('kr', odds.horizon, odds.now, auto, 1, 'ключевая ставка сейчас');
  document.getElementById('kr_ladder_note').innerHTML = mpLadderNote(auto, odds.now, age, from);
  // the floaters against their share by the key rate, as the other target pies
  const pies = document.getElementById('mat_pies');
  // the first pie's money: the Russian infrastructure's bonds, deposits and
  // money-market funds by what they hold; the target -- w_CNY by USD/RUB
  const { data: ruRows } = await sb.from('portfolio_value_usd_by_account').select('value_usd, underlying_currency, instrument_type')
    .eq('infra_region', 'ru').in('instrument_type', ['bond', 'deposit', 'liquid']).gt('quantity', 0);
  const pieRub = (ruRows || []).filter(r => (r.underlying_currency || 'RUB') === 'RUB').reduce((t, r) => t + Number(r.value_usd || 0), 0);
  const pieCny = (ruRows || []).filter(r => (r.underlying_currency || 'RUB') !== 'RUB').reduce((t, r) => t + Number(r.value_usd || 0), 0);
  const pieLiquid = (ruRows || []).filter(r => r.instrument_type === 'liquid' && (r.underlying_currency || 'RUB') === 'RUB').reduce((t, r) => t + Number(r.value_usd || 0), 0);
  const pieW = typeof DATA !== 'undefined' && DATA?.currentWCny != null ? DATA.currentWCny * 100 : null;
  // the yuan ladder (by the PBoC's rate)
  const cnyAll = [...cnyFaceBy.values()].reduce((t, v) => t + v, 0);
  const cauto = mpLadderAuto(odds.horizonCN, odds.cnNow, age, 0.5);
  // no reliable yuan floaters on MOEX (06.11.2026): their bonus kept short --
  // in the ladder's first year
  if (cauto && cauto.bonus > 0) cauto.weights = cauto.weights.map((w, i) => (1 - cauto.bonus) * w + (i === 0 ? cauto.bonus : 0));
  const cf = new Date().getFullYear() + 1, ct = cf + (cauto ? cauto.years : 5) - 1;
  const cr = []; for (let y = cf; y <= ct; y++) cr.push(String(y));
  const ofzAll = await mpOfzList(), cnyBondList = await mpCnyBondList();
  const bestPk = await mpBestPk(ofzAll, key?.now ?? null);
  const rubPie = v => `${Math.round(v / (usdPer('RUB') || 1)).toLocaleString('ru-RU')} ₽`;
  const yuanPie = v => `${Math.round(v / (usdPer('CNY') || 1)).toLocaleString('ru-RU')} ¥`;
  const shadeOf = (n, from, to) => i => { const t = n > 1 ? i / (n - 1) : 0;
    return '#' + from.map((a, k) => Math.round(a + (to[k] - a) * t).toString(16).padStart(2, '0')).join(''); };
  Object.assign(c, { pies, pieRub, pieCny, pieLiquid, pieW, mvAll, mvBonds, mvDeposits, mvFloat, mvFixedBy, mvFloatBy, mvCnyBy, sumMap, fixedMV, targetMV,
    floatPct, floatBase, floatBonus, levelPct, key, odds, age, auto, rungs, from, to, weightOf, weightSum, withFloaters,
    cnyAll, cauto, cr, cf, ct, ofzAll, cnyBondList, bestPk, usdPer, rubPie, yuanPie, shadeOf });
  mpMatDrawPies(c, null);
  mpMatOddsCharts(c);
  const plotFloat = document.getElementById('plot_mat_float');
  c.plotFloat = plotFloat;
  await mpMatDrawFloat(c);
  const KR = 1 / (usdPer('RUB') || 1);
  const rub = v => `${Math.round(v * KR).toLocaleString('ru-RU')} ₽`;
  Object.assign(c, { KR, rub });
  mpMatDrawYears(c);
  const cnyEl = document.getElementById('plot_mat_cny');
  cnyEl.style.display = document.getElementById('mat_cn_tables').style.display = cnyAll > 0 ? '' : 'none';
  c.cnyEl = cnyEl;
  mpMatDrawCnyYears(c);
  await mpMatBuyPlan(c);
  // the yuan ladder's tables and note (its chart: drawCnyYears above)
  if (cnyAll > 0) {
    mpLadderHeat('cn', odds.horizonCN, odds.cnNow, cauto, 0.5, `ставка Банка Китая сейчас (на ${odds.cnSince || '—'})`);
    document.getElementById('cn_ladder_note').innerHTML = mpLadderNote(cauto, odds.cnNow, age, cf, true);
  }
}

