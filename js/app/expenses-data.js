// The Expenses tab's data: categories and their colours, loading a period,
// the period controls, places, notes and the edit dialogs' base.

// Expenses over a period, by category, as in Revolut's spending view. The database
// sorts them (migration 132: bank_transactions.expense_category, by hand or by the
// rules in expense_rules; the tab's rows in `expenses`, in dollars at each day's
// rate) -- the page only reads and draws.
// [category, icon, colour], in the order the chart stacks them; the database's
// labels of what isn't spending have no entry here.
// The order is the chart's over time (bottom to top) and its legend, the same
// for every period: housing, food, transport, travel, then the rest; transfers
// to people, cash and the unsorted last.
const MP_EXP_CATS = [
  ['Rent & housing', '🏠', '#ff7a45'],
  ['Nizhny flat bills', '🏢', '#c4501b'],
  ['Bills & utilities', '💡', '#ffb020'],
  ['Phone & internet', '📱', '#ffa657'],
  ['Household', '🧽', '#e8590c'],
  ['Food delivery', '🛵', '#7ee787'],
  ['Restaurants & cafés', '🍽', '#3fb950'],
  ['Groceries', '🛒', '#1a7f37'],
  ['Travel restaurants', '🍝', '#56d364'],
  ['Travel food delivery', '🛵', '#aff5b4'],
  ['Travel groceries', '🧺', '#2ea043'],
  ['Taxi', '🚕', '#58a6ff'],
  ['Public transport', '🚇', '#1f6feb'],
  ['Other transport', '⛽', '#a5d6ff'],
  ['Flights', '✈️', '#a371f7'],
  ['Hotels', '🏨', '#6e40c9'],
  ['Visas', '🛂', '#8957e5'],
  ['Travel entertainment', '🎡', '#b392f0'],
  ['Travel taxi', '🚖', '#9a6cf0'],
  ['Travel public transport', '🚆', '#c9b3f7'],
  ['Travel souvenirs', '🗿', '#8a63d2'],
  ['Other travel', '🧳', '#d2a8ff'],
  ['Entertainment', '🎟', '#00c2c7'],
  ['Cinema', '🎬', '#39a0a6'],
  ['Games', '🎮', '#0a7d83'],
  ['Clothes', '👕', '#bb8009'],
  ['Electronics', '💻', '#7d4e00'],
  ['Gifts', '🎁', '#e0b660'],
  ['Shopping', '🛍', '#d29922'],
  ['Health & sport', '💊', '#db61a2'],
  ['Psychotherapy', '🛋', '#a0457e'],
  ['Personal care', '🪥', '#f0a3c8'],
  ['Education', '🎓', '#ffa198'],
  ['Subscriptions & services', '🧾', '#ffdf5d'],
  ['Relationships', '💝', '#ff6b9d'],
  ['Government & taxes', '🏛', '#8b949e'],
  ['Fees', '🏦', '#6e7681'],
  ['Transfers to people', '👥', '#f85149'],
  ['Cash', '💵', '#d0d7de'],
  ['Other', '•', '#4b5560'],
];
// Categories shown side by side as one group (the food: shades of one green; the
// transport: of one blue; the travel: of one purple; the fun: of one teal; the shopping: of one gold; the housing: of one orange; the health: of one pink) --
// in the donut and the list, ordered by the group's total, then each one's.
const MP_EXP_GROUPS = { 'Travel restaurants': 'Food', 'Travel groceries': 'Food', 'Travel food delivery': 'Food', 'Rent & housing': 'Housing', 'Nizhny flat bills': 'Housing', 'Bills & utilities': 'Housing',
  'Phone & internet': 'Housing', 'Household': 'Housing',
  'Food delivery': 'Food', 'Restaurants & cafés': 'Food', 'Groceries': 'Food',
  'Taxi': 'Transport', 'Public transport': 'Transport', 'Other transport': 'Transport',
  'Flights': 'Travel', 'Hotels': 'Travel', 'Visas': 'Travel', 'Travel entertainment': 'Travel',
  'Travel taxi': 'Travel', 'Travel public transport': 'Travel', 'Travel souvenirs': 'Travel', 'Other travel': 'Travel',
  'Entertainment': 'Fun', 'Games': 'Fun', 'Cinema': 'Fun',
  'Clothes': 'Shopping', 'Electronics': 'Shopping', 'Gifts': 'Shopping', 'Shopping': 'Shopping',
  'Health & sport': 'Health', 'Psychotherapy': 'Health', 'Personal care': 'Health' };
// The income bars' kinds (income_rules' categories), bottom to top
const MP_INCOME_COLORS = { Salary: '#56d4a0', 'Flat rent': '#79c0ff', Interest: '#39c5cf', Coupons: '#e3b341',
  Cashback: '#ff7b72', Other: '#d2a8ff' };
// What's spent day by day, for a part-only bar's frame (the records start in it,
// or it isn't over yet): see where the bars are drawn
const MP_EXP_REGULAR = new Set(['Food delivery', 'Restaurants & cafés', 'Groceries',
  'Taxi', 'Public transport', 'Other transport', 'Health & sport']);
// ... and once a month: the month's payment, or none (one's own flat, grandma's)
// (not the subscriptions: Anthropic's year isn't bought every month; the
// Nizhny Novgorod flat's bills go on wherever one lives)
const MP_EXP_MONTHLY = new Set(['Rent & housing', 'Nizhny flat bills', 'Bills & utilities', 'Phone & internet']);
const MP_EXP_MONTHLY_ANYWHERE = new Set(['Nizhny flat bills']);
// the first days at a new place, left out of the transport's pace: settling in
const MP_EXP_SETTLE_DAYS = 7;
const MP_EXP_TRANSPORT = new Set(['Taxi', 'Public transport', 'Other transport']);
// A group's colour ("by group"): the colour of its main category -- the one
// the group stands for (housing: the rent's orange, not the bills' yellow)
const MP_EXP_GROUP_META = Object.fromEntries(Object.entries({
  Housing: ['🏠', 'Rent & housing'], Food: ['🍽', 'Restaurants & cafés'], Transport: ['🚕', 'Public transport'],
  Travel: ['✈️', 'Visas'], Fun: ['🎟', 'Entertainment'], Shopping: ['🛍', 'Clothes'], Health: ['💊', 'Health & sport'],
}).map(([g, [icon, main]]) => [g, { icon, color: MP_EXP_CATS.find(c => c[0] === main)[2] }]));
// A category's icon and colour (one the page doesn't know yet, or a label of what isn't spending: grey, like Other),
// an income kind's, and the round mark of either: the Expenses list and the account window's feed.
const MP_EXP_META = Object.fromEntries(MP_EXP_CATS.map(c => [c[0], { icon: c[1], color: c[2] }]));
const mpExpMeta = k => MP_EXP_META[k] ?? MP_EXP_GROUP_META[k] ?? { icon: '•', color: '#4b5560' };
const mpIncomeMeta = k => ({ icon: ({ Salary: '💼', 'Flat rent': '🏠' })[k] ?? '💰', color: MP_INCOME_COLORS[k] ?? '#8b949e' });
const mpExpDot = ({ icon, color }) => `<div class="exp-dot" style="background:${color}33;color:${color}">${icon}</div>`;
let mpExpCache = null;
// receipt_lines' columns (migration ...179): the tab's bulk load and the Items dialog's fresh read
// my_qty: of a shared bill's line, how many were mine (migration ...264); read without it while that's not in
const MP_RECEIPT_LINE_COLS_BASE = 'receipt_id, line_no, name_printed, name_en, product_id, qty, unit, unit_price_list, unit_price_paid, line_total, note, is_other, category';
const MP_RECEIPT_LINE_COLS = `${MP_RECEIPT_LINE_COLS_BASE}, my_qty`;
const mpExpFolded = new Set();  // groups folded in the list of the expenses tab
const mpExpOpen = new Set();    // categories open onto their rows -- kept across re-renders
// range {from, to} (YYYY-MM-DD): only the rows of that period; null: the whole history
async function mpExpLoad(range) {
  const within = (b, col) => (range ? b.gte(col, range.from).lte(col, range.to) : b);
  // four pages at a time: a long history (17 000 expense rows) was read one page after another
  const page = async (q) => {
    const out = [];
    for (let from = 0; ; from += 4000) {
      const parts = await Promise.all([0, 1, 2, 3].map(i => q().range(from + i * 1000, from + i * 1000 + 999)));
      let last = false;
      for (const { data, error } of parts) {
        if (error) throw new Error(error.message);
        out.push(...data);
        if (data.length < 1000) { last = true; break; }
      }
      if (last) return out;
    }
  };
  const [rows, eur, rub] = await Promise.all([
    page(() => within(sb.from('expenses')
      .select('id, day, paid_day, paid_at, account, description, amount, currency, usd, category, counted, extrapolated, note, external_source, external_id, receipt_split'), 'day')
      .order('day').order('id')),
    // for showing in euros or roubles
    ...['EUR', 'RUB'].map(c => page(() => sb.from('fx_history').select('day, usd_per_unit').eq('currency', c).order('day'))),
  ]);
  // where one was, with whom (migration 128); none yet or no table: no bands
  const { data: periods } = await sb.from('life_periods').select('start_day, end_day, place, company, note').order('start_day');
  const rates = { EUR: eur.map(r => [r.day, Number(r.usd_per_unit)]), RUB: rub.map(r => [r.day, Number(r.usd_per_unit)]) };
  const usdPer = (c, day) => {
    if (c === 'USD') return 1;
    const rs = rates[c];
    if (!rs?.length) return NaN;
    let lo = 0, hi = rs.length - 1, rate = rs[0][1];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rs[mid][0] <= day) { rate = rs[mid][1]; lo = mid + 1; } else hi = mid - 1; }
    return rate;
  };
  const spent = [], skipped = [];
  for (const r of rows) {
    // the time as the statement gives it (stored as UTC, shown as is); none for
    // 00:00 -- a statement with no time
    const at = r.paid_at ? r.paid_at.slice(11, 16) : '';
    const row = { id: r.id, day: r.day, paid_day: r.paid_day, tx_date: r.day, at: at === '00:00' ? '' : at, ts: r.paid_at || r.day, account: r.account, description: r.description,
      amt: Number(r.amount), ccy: r.currency, usd: r.usd == null ? NaN : Number(r.usd), cat: r.category,
      extrapolated: r.extrapolated, note: r.note, src: r.external_source, xid: r.external_id,
      // a receipt's lines of another category, split off the purchase (migration ...255)
      split: !!r.receipt_split };
    (r.counted ? spent : skipped).push(row);
  }
  // income (migration 141): none yet or no table -- no line
  // page by page: the interest a day (savings, money market funds) runs past 1000 rows
  // (the timed view of migration ...188; the plain table until it's applied)
  const inc = await page(() => within(sb.from('income_timed').select('day, account, usd, category, description, amount, currency, external_source, external_id, clock'), 'day').order('day').order('id'))
    .catch(() => page(() => sb.from('income').select('day, account, usd, category, description, amount, currency, external_source, external_id').order('day').order('id')).catch(() => []));
  // the notes, out and in, from the rows themselves (bank_transactions.expense_note):
  // expenses.note is refresh_expenses' copy, behind a note just written until the next run
  const notes = await page(() => sb.from('bank_transactions').select('external_source, external_id, expense_note').not('expense_note', 'is', null).order('id')).catch(() => null);
  const noteOf = new Map((notes || []).map(n => [`${n.external_source}|${n.external_id}`, n.expense_note]));
  for (const r of [...spent, ...skipped]) r.note = noteOf.get(`${r.src}|${r.xid}`) ?? r.note;
  for (const r of inc || []) { r.src = r.external_source; r.xid = r.external_id; r.note = noteOf.get(`${r.src}|${r.xid}`) || null; }
  // where a payment was made (migration 163): no column yet -- no places
  // and, a delivery, where it was brought to (migration 165): no column yet -- the place alone
  const placed = await page(() => sb.from('bank_transactions').select('external_source, external_id, place_id, delivery_place_id, from:places!place_id(name, url), to:places!delivery_place_id(name, url)').or('place_id.not.is.null,delivery_place_id.not.is.null').order('id'))
    .catch(() => page(() => sb.from('bank_transactions').select('external_source, external_id, from:places!place_id(name, url)').not('place_id', 'is', null).order('id')).catch(() => []));
  const placeOf = new Map((placed || []).map(p => [`${p.external_source}|${p.external_id}`, p]));
  for (const r of [...spent, ...skipped, ...(inc || [])]) {
    const p = placeOf.get(`${r.src}|${r.xid}`);
    r.place = p?.from || null;
    r.deliveredTo = p?.to || null;
    r.placeId = p?.place_id ?? null;
    r.deliveredToId = p?.delivery_place_id ?? null;
  }
  // a time set by hand -- the statement has the day only (migrations 166, 167):
  // it's the row's time, "~" before it when a guess; none yet -- the statement's
  const timed = await page(() => sb.from('bank_transactions').select('external_source, external_id, authorized_at, authorized_approx').not('authorized_at', 'is', null).order('id')).catch(() => []);
  const timeOf = new Map((timed || []).map(t => [`${t.external_source}|${t.external_id}`, t]));
  for (const r of [...spent, ...skipped]) {
    const t = timeOf.get(`${r.src}|${r.xid}`);
    if (!t) continue;
    r.at = t.authorized_at.slice(11, 16);
    r.ts = t.authorized_at;
    r.handTime = true;
    r.approx = !!t.authorized_approx;
  }
  // the places one's rows can be set to (the Place column's picker)
  const placeList = await page(() => sb.from('places').select('id, name, lat, lng, url, google_id, city, street, house, country').order('name'))
    .catch(() => page(() => sb.from('places').select('id, name, lat, lng, url, google_id').order('name')).catch(() => []));
  // the receipt in force for a row out, with its lines (migration ...179,
  // design: docs/items-design.md, not tracked in git): none yet or no table
  // -- the items cell just offers "add items"
  const [receiptsList, receiptLineRows] = await Promise.all([
    // bill_total: a shared bill's printed total (migration ...264); read without it while that's not in
    page(() => sb.from('receipts_active').select('id, tx_source, tx_external_id, source, chain, store_printed, currency, note, receipt_key, purchased_on, bill_total'))
      .catch(() => page(() => sb.from('receipts_active').select('id, tx_source, tx_external_id, source, chain, store_printed, currency, note, receipt_key, purchased_on')).catch(() => [])),
    page(() => sb.from('receipt_lines').select(MP_RECEIPT_LINE_COLS).order('line_no'))
      .catch(() => page(() => sb.from('receipt_lines').select(MP_RECEIPT_LINE_COLS_BASE).order('line_no')).catch(() => [])),
  ]);
  const linesByReceipt = new Map();
  for (const l of receiptLineRows || []) {
    if (!linesByReceipt.has(l.receipt_id)) linesByReceipt.set(l.receipt_id, []);
    linesByReceipt.get(l.receipt_id).push(l);
  }
  const receiptOf = new Map((receiptsList || []).map(r => [`${r.tx_source}|${r.tx_external_id}`,
    { id: r.id, source: r.source, chain: r.chain, store: r.store_printed, currency: r.currency, note: r.note, key: r.receipt_key, day: r.purchased_on, billTotal: r.bill_total ?? null, lines: linesByReceipt.get(r.id) || [] }]));
  // a place shown by its name, with as much of its address as tells it from another of that name
  for (const r of [...spent, ...skipped, ...(inc || [])]) {
    const from = placeList.find(p => p.id === r.placeId), to = placeList.find(p => p.id === r.deliveredToId);
    if (from) r.place = { name: mpPlaceLabel(from, placeList), url: from.url };
    if (to) r.deliveredTo = { name: mpPlaceLabel(to, placeList), url: to.url };
  }
  // the pairs that net out, and the money in that's no income, no refund, no
  // pair's leg (kept by refresh_expenses, migration 156): none yet -- the rows out alone
  const [pairs, unpairedIn, chains, incomeExpect] = await Promise.all([
    page(() => within(sb.from('transfer_pair_timed').select('*'), 'out_day').order('pair_id'))
      .catch(() => page(() => within(sb.from('transfer_pair_rows').select('*'), 'out_day').order('pair_id')).catch(() => [])),
    page(() => within(sb.from('unpaired_in_timed').select('*'), 'day').order('external_source').order('external_id'))
      .catch(() => page(() => sb.from('unpaired_in_rows').select('*').order('external_source').order('external_id')).catch(() => [])),
    // rows that are one move in several steps (migration 160): none yet or no table -- no chains
    page(() => sb.from('expense_chains').select('external_source, external_id, chain')).catch(() => []),
    // the income one expects (migration 161): none yet or no table -- the income bars unframed
    page(() => sb.from('income_expectations').select('category, amount, currency, from_day, to_day')).catch(() => []),
  ]);
  // the statement's time of the income rows and of the transfer legs (their
  // tables have none): from the bank row, by its day; 00:00 is no time
  // the time of each bank row, from the timed views (migration ...188): none for 00:00
  const clockOf = new Map();
  const putClock = (src, id, clock) => { if (src && id && clock && clock !== '00:00') clockOf.set(`${src}|${id}`, clock); };
  for (const r of inc || []) putClock(r.external_source, r.external_id, r.clock);
  for (const p of pairs || []) { putClock(p.out_source, p.out_id, p.out_clock); putClock(p.in_source, p.in_id, p.in_clock); }
  for (const r of unpairedIn || []) putClock(r.external_source, r.external_id, r.clock);
  for (const r of inc || []) {
    const at = clockOf.get(`${r.src}|${r.xid}`);
    if (at) { r.at = at; r.ts = `${r.day} ${at}`; }
  }
  for (const r of unpairedIn || []) {
    r.src = r.external_source; r.xid = r.external_id;
    const at = clockOf.get(`${r.src}|${r.xid}`);
    if (at) { r.at = at; r.ts = `${r.day} ${at}`; }
  }
  return { spent, skipped, usdPer, placeList, receiptOf, periods: periods || [], incomeDays: mpExpIncomeDays(inc || []), incomeRows: inc || [],
    pairs, unpairedIn, incomeExpect: incomeExpect || [], clockOf, chainOf: new Map((chains || []).map(c => [`${c.external_source}|${c.external_id}`, c.chain])),
    range };
}
// Income over the days it was earned in: each payment over the days since the
// one before it from the same source (account and kind) -- a salary paid on
// the 28th-30th would fall in one month twice and in the next not at all, a
// month's back pay all in one; a first payment over the source's usual gap.
// At most 120 days. -> [{day, usd, paid}], paid: the payment's day, for its rate.
// A card payment's merchant alone, as Revolut shows it: TBC writes "POS - SPAR,
// 29.78 GEL, Oct 30 2026 12:00AM, <its category>, MCC: 5411, VISA, 4315..." --
// the row keeps it (the day it was made, the MCC come from it), the table shows
// "SPAR", the whole text on hover.
// A forecast of a period not over yet, into expense_forecasts (migration ...154):
// one row a day per period and currency, the day's last drawing kept --
// written once a drawing, not again for the same numbers.
const mpExpForecastsKept = new Map();
function mpExpKeepForecast(x) {
  const madeOn = mpIsoDay(new Date());
  const key = [madeOn, x.step, x.period, x.ccy].join('|');
  const row = { made_on: madeOn, step: x.step, period: x.period, period_from: x.from, period_to: x.to, currency: x.ccy,
    actual: +x.actual.toFixed(2), projected: +x.projected.toFixed(2), parts: x.parts };
  const sig = JSON.stringify(row);
  if (mpExpForecastsKept.get(key) === sig) return;
  mpExpForecastsKept.set(key, sig);
  sb.from('expense_forecasts').upsert(row, { onConflict: 'user_id,made_on,step,period,currency' })
    .then(({ error }) => { if (error) console.warn('expense forecast not kept:', error.message); });
}
function mpShortDesc(d) {
  const m = String(d || '').match(/^POS(?: wallet)? - (.+?), [\d.]+ [A-Z]{3}, [A-Z][a-z]{2}\s+\d{1,2} \d{4} \d{1,2}:\d{2}[AP]M,/);
  return m ? m[1] : d;
}
function mpExpIncomeDays(rows) {
  const DAY = 86400000, out = [], bySource = new Map();
  for (const r of rows) {
    if (r.usd == null || !Number.isFinite(Number(r.usd))) continue;
    const k = r.account + '\u0000' + r.category;
    if (!bySource.has(k)) bySource.set(k, new Map());
    const days = bySource.get(k);
    days.set(r.day, (days.get(r.day) || 0) + Number(r.usd));
  }
  for (const [key, days] of bySource) {
    const cat = key.split('\u0000')[1];
    const list = [...days].sort((a, b) => a[0].localeCompare(b[0]));
    // a salary is the month it's for, spread over that month: paid by the
    // 12th, the month before (Russia's "расчёт" on the 5th-10th, Serbia's
    // "zarada za" on the 4th-7th), else the month it's paid in (the advance on
    // the 20th, Cyprus' payroll at the month's end, December's paid before the
    // New Year). Spread over the days since the payment before instead, a
    // payday moving by a few days put bits of two salaries into one month -- a
    // steady 5 818 EUR showed as 5 433 to 6 163, the December paid on the
    // 27th made a December of three and a January of one (02.11.2026)
    // Paid in cash (EvenBet, on the 8th and the 25th) it's both halves of the
    // month it's paid in: the cut from 2 x 1 900 to 2 x 900 EUR came in
    // September 2024 at once, the 8th as the month before made August half and half.
    // Paid after the 25th it's the next month's early-month part, given ahead of
    // the New Year (458 EUR on 27.12.2024: no early-January one, a December of
    // three payments and a January of one)
    // A flat's rent is a month's, the month it's paid in: spread over the days
    // since the payment before, the 17 000 RUB of 04.12.2018 after three months
    // with none on record made each of them a third of a rent (03.11.2026)
    const rent = key.endsWith('\u0000Flat rent');
    // Two rents in a month by a month with none: one of them is that month's
    // ("бывало что сразу за несколько месяцев платили"): the later one the next
    // month's, else the earlier one the month before's (07.03 and 20.03.2020
    // with no February: 07.03 is February's)
    const rentMonth = new Map();
    if (rent) {
      const monthPlus = (ym, k) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1)).toISOString().slice(0, 7);
      const byMonth = new Map();
      list.forEach(([d]) => byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) || []), d]));
      const used = new Set(byMonth.keys());
      for (const [ym, ds] of byMonth) {
        if (ds.length < 2) continue;
        const next = monthPlus(ym, 1), prev = monthPlus(ym, -1);
        if (!used.has(next)) { rentMonth.set(ds.at(-1), next); used.add(next); }
        else if (!used.has(prev)) { rentMonth.set(ds[0], prev); used.add(prev); }
      }
    }
    if (key.endsWith('\u0000Salary') || rent) {
      const byPayMonth = key.startsWith('cash\u0000');
      for (const [d, usd] of list) {
        const [y, m, dd] = (rentMonth.get(d) ? rentMonth.get(d) + '-01' : d).split('-').map(Number);
        const shift = rent ? 0 : byPayMonth ? (dd > 25 ? 1 : 0) : (dd <= 12 ? -1 : 0);
        const first = new Date(Date.UTC(y, m - 1 + shift, 1));
        const n = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
        const mo = first.toISOString().slice(0, 8);
        for (let k = 1; k <= n; k++) out.push({ day: `${mo}${String(k).padStart(2, '0')}`, usd: usd / n, paid: d, cat });
      }
      continue;
    }
    const gaps = list.slice(1).map(([d], i) => (Date.parse(d) - Date.parse(list[i][0])) / DAY).sort((a, b) => a - b);
    const usual = gaps.length ? gaps[gaps.length >> 1] : 1;
    list.forEach(([d, usd], i) => {
      const n = Math.max(1, Math.min(120, Math.round(i ? (Date.parse(d) - Date.parse(list[i - 1][0])) / DAY : usual)));
      for (let k = 0; k < n; k++) out.push({ day: new Date(Date.parse(d) - k * DAY).toISOString().slice(0, 10), usd: usd / n, paid: d, cat });
    });
  }
  return out;
}
function mpExpRange() {
  const mode = document.getElementById('exp_period').value;
  const from = document.getElementById('exp_from').value, to = document.getElementById('exp_to').value;
  return { mode, from, to };
}
// The period ending in the month of `anchor` (YYYY-MM-DD) for the chosen mode;
// a month and a year end on the day of `anchor` itself (today: 29.09.2026 -
// 28.10.2026, 29.10.2025 - 28.10.2026).
function mpExpSetPeriod(mode, anchor) {
  const [y, m, d] = anchor.split('-').map(Number);
  const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  let from, to;
  if (mode === 'year') { from = iso(y - 1, m, d + 1); to = anchor; }
  else if (mode === 'cmonth') { from = iso(y, m, 1); to = iso(y, m + 1, 0); }
  else if (mode === 'month') { from = iso(y, m - 1, d + 1); to = anchor; }
  else if (mode === 'cyear') {
    // the calendar year of `anchor`, to today at most
    const today = new Date().toISOString().slice(0, 10);
    from = iso(y, 1, 1); to = iso(y, 12, 31);
    if (to > today) to = today;
  } else {
    const months = mode === '3m' ? 3 : 1;
    from = iso(y, m - months + 1, 1); to = iso(y, m + 1, 0);
  }
  document.getElementById('exp_from').value = from;
  document.getElementById('exp_to').value = to;
}
// The days with a record: from the first one to today -- a period wholly
// outside them is empty, ‹ › don't go there
function mpExpBounds() {
  const today = new Date().toISOString().slice(0, 10);
  // the first record of the whole history, known at once (mpExpEarliest), not only of the rows loaded
  const first = mpExpFirstDay || (mpExpCache?.spent || []).reduce((m, r) => (r.day < m ? r.day : m), today);
  return { first, today };
}
// the day of the earliest expense row, asked at once when the tab opens (first priority,
// not behind the period's load); the back button and the date pickers wait for it only
let mpExpFirstDay = null, mpExpFirstDayAsked = false;
function mpExpAskFirstDay() {
  if (mpExpFirstDayAsked) return;
  mpExpFirstDayAsked = true;
  mpExpEarliest().then(d => { mpExpFirstDay = d; mpExpUpdateNav(); }).catch(() => {});
}
async function mpExpEarliest() {
  const { data, error } = await sb.from('expenses').select('day').order('day').limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.day || null;
}
function mpExpUpdateNav() {
  const { from, to } = mpExpRange();
  const { first, today } = mpExpBounds();
  document.getElementById('exp_prev').disabled = !from || from <= first;
  document.getElementById('exp_next').disabled = !to || to >= today;
  // the date pickers: no day, month or year past today or before the first record
  for (const id of ['exp_from', 'exp_to']) Object.assign(document.getElementById(id), { min: first, max: today });
}
function mpExpShift(dir) {
  const { mode, from, to } = mpExpRange();
  if (!from || !to) return;
  if (dir > 0 ? to >= mpExpBounds().today : from <= mpExpBounds().first) return;
  if (mode === 'custom') {
    const len = Date.parse(to) - Date.parse(from) + 86400000;
    const f = new Date(Date.parse(from) + dir * len), t = new Date(Date.parse(to) + dir * len);
    document.getElementById('exp_from').value = f.toISOString().slice(0, 10);
    document.getElementById('exp_to').value = t.toISOString().slice(0, 10);
  } else {
    const months = mode === 'year' || mode === 'cyear' ? 12 : mode === '3m' ? 3 : 1;
    const [y, m, d] = to.split('-').map(Number);
    // the same day of the month (the last one for a month too short: 31.03 -> 28.02)
    const last = new Date(Date.UTC(y, m + dir * months, 0)).getUTCDate();
    const day = mode === 'year' || mode === 'month' ? Math.min(d, last) : 1;
    mpExpSetPeriod(mode, new Date(Date.UTC(y, m - 1 + dir * months, day)).toISOString().slice(0, 10));
  }
  mpRenderExpenses();
}
// The bars by month / year to today: "this year", "-1 year", ... -> their days
const mpExpRollingDays = new Map();
function mpExpBucketDays(b) {
  if (mpExpRollingDays.has(b)) return mpExpRollingDays.get(b);
  const q = b.match(/^(\d{4}) Q(\d)$/);
  const [y, m0, n] = q ? [Number(q[1]), (q[2] - 1) * 3, 3] : /^\d{4}$/.test(b) ? [Number(b), 0, 12] : [Number(b.slice(0, 4)), b.slice(5, 7) - 1, 1];
  const iso = (mm, dd) => new Date(Date.UTC(y, mm, dd)).toISOString().slice(0, 10);
  return [iso(m0, 1), iso(m0 + n, 0)];
}
// A Google Maps link's place (migration 163): its name, point, Google's id.
// A link to a bare point on the map ("/maps/@41.70,44.78,21z" -- a place
// the map doesn't know) gives the point alone, the name is one's own.
function mpPlaceFromLink(url) {
  if (!/google\.[a-z.]+\/maps\//.test(url)) return null;
  const name = url.match(/\/maps\/place\/([^/]+)/);
  // the place's own point (!3d<lat>!4d<lng>), else the map's centre (@lat,lng);
  // a link from one place to another lists both -- the last is the one shown
  const pt = [...url.matchAll(/!3d(-?[\d.]+)!4d(-?[\d.]+)/g)].pop() || url.match(/@(-?[\d.]+),(-?[\d.]+)/);
  let clean = url;
  try { const u = new URL(url); u.search = ''; clean = u.toString(); } catch { /* as written */ }
  const gid = [...url.matchAll(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/gi)].pop();
  if (!name && !pt) return null;
  return { name: name ? decodeURIComponent(name[1].replace(/\+/g, ' ')) : '', lat: pt ? Number(pt[1]) : null, lng: pt ? Number(pt[2]) : null, url: clean, google_id: gid ? gid[1] : null };
}
// A place's name, and when another has the same name, its address from the
// city on, as far as it takes to tell them apart: the city, then the street,
// then the house ("Spar · Tbilisi, Merab Kostava Street"); with no address to
// tell by, its point.
function mpPlaceLabel(p, list) {
  const same = list.filter(o => o.id !== p.id && o.name.toLowerCase() === p.name.toLowerCase());
  if (!same.length) return p.name;
  const addr = (o, n) => [o.city, [o.street, n > 2 ? o.house : ''].filter(Boolean).join(' ')].slice(0, n > 1 ? 2 : 1).filter(Boolean).join(', ');
  for (const n of [1, 2, 3]) {
    const mine = addr(p, n);
    if (mine && same.every(o => addr(o, n) !== mine)) return `${p.name} · ${mine}`;
  }
  const full = addr(p, 3);
  return p.lat != null ? `${p.name} · ${full ? full + ', ' : ''}${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : `${p.name}${full ? ' · ' + full : ''}`;
}
// A short Google Maps link opened to the full one, by the resolve-map-link function
// (the browser can't follow goo.gl's redirect itself).
async function mpOpenShortMapLink(url) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('sign in first');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/resolve-map-link`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error || res.statusText);
  return r.url;
}
// A point's address, from OpenStreetMap (Nominatim): city, street, house.
async function mpAddressAt(lat, lng) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=en`);
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  return { city: a.city || a.town || a.village || '', street: a.road || a.pedestrian || '', house: a.house_number || '', country: (a.country_code || '').toUpperCase() };
}
// A row's place, its own column: the name, a click opens the map (when
// there's a link), under it what tells it from another of its name; a
// delivery's also where it was brought to, on a line of its own ("→ 🏠 ...").
function mpPlaceHtml(place, to) {
  const one = (p, icon, arrow) => {
    const [name, addr] = [p.name.split(' · ')[0], p.name.split(' · ').slice(1).join(' · ')];
    const text = `${icon} ${mpEscapeHtml(name)}${addr ? `<br><span style="font-size:0.85em;color:#8b949e">${mpEscapeHtml(addr)}</span>` : ''}`;
    // the arrow before "delivered to" is plain text, not part of the link
    return `<div>${arrow ? '→ ' : ''}${p.url
      ? `<a href="${mpEscapeHtml(p.url)}" target="_blank" rel="noopener" style="color:#58a6ff">${text}</a>`
      : `<span>${text}</span>`}</div>`;
  };
  return [place && one(place, '📍'), to && one(to, '🏠', true)].filter(Boolean).join('');
}
// A note's text with its links cut short: a Google Maps place shows as its
// name ("📍 Mugsy's Burger"), any other link as its site; a click opens it.
function mpNoteHtml(note) {
  if (!note) return '✎';
  return note.split(/(https?:\/\/[^\s)]+)/).map((part, i) => {
    if (i % 2 === 0) return mpEscapeHtml(part);
    let label;
    try {
      const u = new URL(part);
      const place = u.pathname.match(/\/maps\/place\/([^/]+)/);
      label = place ? '📍 ' + decodeURIComponent(place[1].replace(/\+/g, ' ')) : '🔗 ' + u.hostname.replace(/^www\./, '');
    } catch { label = '🔗 link'; }
    return `<a href="${mpEscapeHtml(part)}" target="_blank" rel="noopener" style="color:#58a6ff">${mpEscapeHtml(label)}</a>`;
  }).join('');
}
// A row's items (migration ...179, design: docs/items-design.md, not
// tracked in git): a receipt in force shows its line count, the "Other"
// gap flagged if there is one and any unresolved product dimmed; a row
// with none offers to add them by hand.
function mpItemsHtml(receipt) {
  if (!receipt) return '<span style="color:#6a7381">+ items</span>';
  // an Apple order: what it was, by name (its lines are no products)
  if (receipt.source === 'apple') {
    const names = receipt.lines.filter(l => !l.is_other).map(l => l.name_printed);
    return `<span title="${mpEscapeHtml(names.join('\n'))}">🍏 ${mpEscapeHtml(names.slice(0, 2).join(', '))}${names.length > 2 ? ` +${names.length - 2}` : ''}</span>`;
  }
  const n = receipt.lines.filter(l => !l.is_other).length;
  const other = receipt.lines.some(l => l.is_other);
  const unresolved = receipt.lines.some(l => !l.is_other && l.product_id == null);
  return `<span${unresolved ? ' style="color:#d29922" title="a line has no product yet"' : ''}>🧾 ${n} item${n === 1 ? '' : 's'}${other ? ' +' : ''}</span>`;
}
// A row's time next to its date: the statement's, or one set by hand
// (authorized_at, migration 166) -- "~" before a guess (...167). A row
// without a time of its own, or with one set by hand, can get one: a click.
function mpTimeHtml(r) {
  const canSet = r.src && (!r.at || r.handTime);
  const attrs = canSet ? ` class="exp-time" data-src="${mpEscapeHtml(r.src)}" data-xid="${mpEscapeHtml(r.xid || '')}" style="color:#6a7381;cursor:pointer"` : ' style="color:#6a7381"';
  if (!r.at) return canSet ? ` <span${attrs} title="Click to set the time">🕒</span>` : '';
  const title = r.approx ? 'примерное время, проставлено вручную' : r.handTime ? 'время проставлено вручную' : '';
  return ` <span${attrs}${title ? ` title="${title}"` : ''}>${r.approx ? '~' : ''}${r.at}</span>`;
}
// The tab's rows of one bank row (a row out may be in more than one list).
function mpExpRowsOf(src, xid) {
  return [...(mpExpCache?.spent || []), ...(mpExpCache?.skipped || []), ...(mpExpCache?.incomeRows || [])].filter(r => r.src === src && r.xid === xid);
}
// A small form over the page: fields' HTML in, the form's element out to wire;
// closed by Cancel / Esc.
function mpDialog(title, body) {
  let dlg = document.getElementById('mp_dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'mp_dialog';
    dlg.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:16px 18px;min-width:320px;max-width:min(92vw,460px)';
    document.body.appendChild(dlg);
  }
  dlg.style.maxWidth = 'min(92vw,460px)';   // a dialog that needs more (the receipt's items) widens itself
  dlg.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:10px">
    <b>${mpEscapeHtml(title)}</b>${body}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
      <button type="button" data-act="cancel">Cancel</button><button type="submit" data-act="save">Save</button></div></form>`;
  dlg.querySelector('[data-act=cancel]').onclick = () => dlg.close();
  dlg.showModal();
  return dlg.querySelector('form');
}
const MP_FIELD = 'background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:4px 6px;width:100%;box-sizing:border-box';
// The time of a row whose statement gives the day only: on that day (the
// date stays), "approximate" ticked unless it's known to the minute.
function mpEditTime(src, xid) {
  const rows = mpExpRowsOf(src, xid);
  const r = rows[0];
  if (!r) return;
  const form = mpDialog(`Time · ${r.day}`, `
    <input type="time" name="t" value="${r.at || ''}" style="${MP_FIELD}" required>
    <label><input type="checkbox" name="approx"${!r.handTime || r.approx ? ' checked' : ''}> примерное</label>
    ${r.handTime ? '<button type="button" data-act="clear">Remove the time</button>' : ''}`);
  const save = async (t, approx) => {
    const { error } = await sb.from('bank_transactions').update({ authorized_at: t ? `${r.day}T${t}:00Z` : null, authorized_approx: !!t && approx })
      .eq('external_source', src).eq('external_id', xid);
    if (error) { alert(error.message); return; }
    rows.forEach(x => { x.at = t || ''; x.handTime = !!t; x.approx = !!t && approx; x.ts = t ? `${x.day}T${t}:00Z` : x.day; });
    form.closest('dialog').close();
    // re-sorted by the new time; the open categories stay open (mpExpOpen)
    const y = window.scrollY;
    await mpRenderExpenses();
    window.scrollTo(0, y);
  };
  form.querySelector('[data-act=clear]')?.addEventListener('click', () => save(null, false));
  form.addEventListener('submit', e => { e.preventDefault(); save(form.t.value, form.approx.checked); });
}
// A row's place and, a delivery, where it was brought to: one of the places
// there are, or a new one -- a Google Maps link fills its fields (to check).
function mpEditPlace(src, xid) {
  const rows = mpExpRowsOf(src, xid);
  const r = rows[0];
  if (!r) return;
  const list = mpExpCache?.placeList || [];
  // where it was brought to: a delivery's only
  const delivery = r.cat === 'Food delivery' || r.deliveredToId != null;
  // a new place first, then none, then the places A-Z; the search box above filters them
  const opts = sel => `<option value="new">+ new place…</option><option value=""${sel == null ? ' selected' : ''}>—</option>${
    list.map(p => [p, mpPlaceLabel(p, list)]).sort((a, b) => a[1].localeCompare(b[1])).map(([p, label]) => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${mpEscapeHtml(label)}</option>`).join('')}`;
  // under each list: the chosen place's own fields (address, map link) to fill in or fix --
  // a place a receipt made has its name only (15.11.2026)
  const picker = (name, label, sel) => `<label>${label}
    <input type="search" data-for="${name}" placeholder="search…" style="${MP_FIELD};margin:4px 0">
    <select name="${name}" size="7" style="${MP_FIELD}">${opts(sel)}</select></label>
    <a href="#" data-edit="${name}" style="font-size:12px;color:#8b949e;align-self:flex-start">✎ edit the chosen place</a>`;
  const form = mpDialog(`Place · ${r.day} · ${mpShortDesc(r.description)}`, `
    ${picker('from', '📍 Where', r.placeId)}
    ${delivery ? picker('to', '→ 🏠 Delivered to', r.deliveredToId) : ''}
    <fieldset name="nw" style="display:none;border:1px solid #30363d;border-radius:6px;padding:8px;gap:6px;flex-direction:column">
      <legend>New place</legend>
      <input name="link" placeholder="Google Maps link -- fills the fields" style="${MP_FIELD}">
      <input name="pname" placeholder="name" style="${MP_FIELD}">
      <div style="display:flex;gap:6px"><input name="lat" placeholder="lat" style="${MP_FIELD}"><input name="lng" placeholder="lng" style="${MP_FIELD}"></div>
      <div style="display:flex;gap:6px"><input name="city" placeholder="city" style="${MP_FIELD}"><input name="country" placeholder="country (GE)" style="${MP_FIELD};width:30%"></div>
      <div style="display:flex;gap:6px"><input name="street" placeholder="street" style="${MP_FIELD}"><input name="house" placeholder="house" style="${MP_FIELD};width:30%"></div>
      <input name="url" placeholder="map link" style="${MP_FIELD}">
      <input name="gid" placeholder="Google id (0x…:0x…)" style="${MP_FIELD}">
    </fieldset>`);
  form.querySelectorAll('input[data-for]').forEach(box => box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    for (const o of form[box.dataset.for].options) o.hidden = !!q && o.value !== 'new' && !o.text.toLowerCase().includes(q);
  }));
  let target = null;   // which select the new place is for
  let editing = null;  // the place whose fields are being fixed (its id), else a new one
  const nw = form.querySelector('fieldset');
  form.querySelectorAll('a[data-edit]').forEach(a => a.addEventListener('click', ev => {
    ev.preventDefault();
    const p = list.find(x => x.id === Number(form[a.dataset.edit].value));
    if (!p) { alert('Choose a place in the list first.'); return; }
    target = null;
    editing = p.id;
    nw.querySelector('legend').textContent = `Place · ${p.name}`;
    form.link.value = '';
    form.pname.value = p.name || ''; form.lat.value = p.lat ?? ''; form.lng.value = p.lng ?? '';
    form.city.value = p.city || ''; form.country.value = p.country || ''; form.street.value = p.street || ''; form.house.value = p.house || '';
    form.url.value = p.url || ''; form.gid.value = p.google_id || '';
    nw.style.display = 'flex';
    form.pname.required = true;
    form.link.focus();
  }));
  for (const name of delivery ? ['from', 'to'] : ['from']) {
    form[name].addEventListener('change', () => {
      if (form[name].value !== 'new') return;
      target = name;
      editing = null;
      nw.querySelector('legend').textContent = 'New place';
      for (const f of ['link', 'pname', 'lat', 'lng', 'city', 'country', 'street', 'house', 'url', 'gid']) form[f].value = '';
      nw.style.display = 'flex';
      form.pname.required = true;
      form.link.focus();
    });
  }
  form.link.addEventListener('input', async () => {
    let link = form.link.value.trim();
    // a short link (maps.app.goo.gl) has nothing in it: opened to the full one first
    if (/^https:\/\/(maps\.app\.goo\.gl|goo\.gl)\//.test(link)) {
      const full = await mpOpenShortMapLink(link).catch(err => { alert(`The short link: ${err.message}`); return null; });
      if (!full || form.link.value.trim() !== link) return;
      link = full;
    }
    const p = mpPlaceFromLink(link);
    if (!p) return;
    if (p.name) form.pname.value = p.name;
    form.lat.value = p.lat ?? ''; form.lng.value = p.lng ?? '';
    form.url.value = p.url; form.gid.value = p.google_id ?? '';
    // the address at that point (to check): what tells two Spars apart
    if (p.lat == null) return;
    const a = await mpAddressAt(p.lat, p.lng).catch(() => null);
    if (a) { form.city.value = a.city; form.street.value = a.street; form.house.value = a.house; form.country.value = a.country; }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    let newId = null;
    const num = v => (v.trim() === '' ? null : Number(v));
    const txt = v => v.trim() || null;
    const fields = () => ({ name: form.pname.value.trim(), lat: num(form.lat.value), lng: num(form.lng.value), url: txt(form.url.value), google_id: txt(form.gid.value),
      city: txt(form.city.value), street: txt(form.street.value), house: txt(form.house.value), country: txt(form.country.value) });
    const cols = 'id, name, lat, lng, url, google_id, city, street, house, country';
    if (editing) {
      // the chosen place's own fields, fixed in place: every row with it shows them
      const { data, error } = await sb.from('places').update(fields()).eq('id', editing).select(cols).single();
      if (error) { alert(error.message); return; }
      Object.assign(list.find(x => x.id === editing), data);
      for (const x of [...(mpExpCache?.spent || []), ...(mpExpCache?.skipped || []), ...(mpExpCache?.incomeRows || [])]) {
        if (x.placeId === editing) x.place = { name: mpPlaceLabel(data, list), url: data.url };
        if (x.deliveredToId === editing) x.deliveredTo = { name: mpPlaceLabel(data, list), url: data.url };
      }
    }
    if (target) {
      const place = fields();
      const { data, error } = place.google_id
        ? await sb.from('places').upsert(place, { onConflict: 'user_id,google_id' }).select(cols).single()
        : await sb.from('places').insert(place).select(cols).single();
      if (error) { alert(error.message); return; }
      newId = data.id;
      if (!list.some(p => p.id === data.id)) list.push(data);
    }
    const pick = name => (form[name].value === 'new' ? newId : form[name].value ? Number(form[name].value) : null);
    const from = pick('from'), to = delivery ? pick('to') : null;
    const { error } = await sb.from('bank_transactions').update({ place_id: from, delivery_place_id: to }).eq('external_source', src).eq('external_id', xid);
    if (error) { alert(error.message); return; }
    // the row's receipt (migration ...179), if it has one: remember this
    // place for its store, so the next receipt from there picks it by
    // itself (receipt_resolve_place does the same on the database side)
    const receiptHere = mpExpCache?.receiptOf?.get(`${src}|${xid}`);
    if (from && receiptHere) {
      // (a Wolt order's store is Wolt: its place is the restaurant, remembered by
      // receipt_resolve_place under the restaurant's name -- none under Wolt's here)
      const key = /wolt/i.test(receiptHere.chain || '') ? null : mpStoreKey(receiptHere.chain, receiptHere.store);
      // best effort: the pick is saved either way; a failure here must not stop the dialog closing
      if (key) {
        try { await sb.from('store_places').upsert({ store_key: key, place_id: from }, { onConflict: 'user_id,store_key' }); } catch { /* the row's place is set already */ }
      }
    }
    const byId = id => { const p = list.find(x => x.id === id); return p ? { name: mpPlaceLabel(p, list), url: p.url } : null; };
    rows.forEach(x => { x.placeId = from; x.deliveredToId = to; x.place = byId(from); x.deliveredTo = byId(to); });
    form.closest('dialog').close();
    document.querySelectorAll('#expenses .exp-place').forEach(c => {
      if (c.dataset.src === src && c.dataset.xid === xid) c.innerHTML = mpPlaceHtml(r.place, r.deliveredTo);
    });
  });
}

