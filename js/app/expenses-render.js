// The Expenses tab drawn (mpRenderExpenses) and its controls.

// The tab's rows in mpExpCache: the period on screen first, then the whole history
// in the background, and a period not in yet before its figures; false on an error
// (written into status)
async function mpExpEnsureRows(status) {
  if (!mpExpCache) {
    // the period on screen first, then the whole history in the background
    status.textContent = 'Loading transactions…';
    const range = { from: document.getElementById('exp_from').value, to: document.getElementById('exp_to').value };
    // the monthly sums alongside: the chart over time, the whole history at once
    try {
      // (no table yet -- the migration not in: the chart empty, the rest of the tab as it is)
      const [cache, totals] = await Promise.all([mpExpLoad(range), mpExpLoadTotals().catch(() => [])]);
      mpExpCache = cache;
      mpExpCache.totals = totals;
    } catch (error) { status.textContent = error.message; return false; }
    mpExpFull = false;
    mpExpLoadRest();
  }
  // a period whose rows are not in the cache yet is loaded before its figures are drawn:
  // the page shows none of them as zeros or as a part
  const want = { from: document.getElementById('exp_from').value, to: document.getElementById('exp_to').value };
  if (!mpExpFull && !mpExpCovers(want)) {
    status.textContent = 'Loading…';
    try { mpMergeExpCache(await mpExpLoadFresh(want)); } catch (error) { status.textContent = error.message; return false; }
  }
  return true;
}

// The spending in the period: the ring by category and the list, each
// category opening onto its rows. c: mpRenderExpenses' figures
// a row's amount with its currency's sign ("₾21.44", "€7.62", "$8.20"); a currency with no sign keeps its code
function mpExpAmount(n, ccy) {
  const sign = typeof MP_CURRENCY_SYMBOLS !== 'undefined' && MP_CURRENCY_SYMBOLS[ccy];
  try {
    const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    if (sign) return s.replace(/^(-?)[^\d-]+/, `$1${sign}`);
    if (!s.includes(ccy)) return s;
  } catch { /* not a currency Intl knows (a crypto ticker) */ }
  // no sign (RSD, BTC, ...): the number and the code, a crypto amount to its satoshi
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${ccy}`;
}
async function mpExpDrawSpent(c) {
  const { cats, ccy, conv, daysIn, esc, from, groupedTop, meta, money, perDayText, rowMoney, sym, to, total } = c;
  const donut = document.getElementById('plot_exp_donut');
  await Plotly.react(donut, [{
    type: 'pie', hole: 0.78, sort: false, direction: 'clockwise',
    labels: cats.map(c => c.cat), values: cats.map(c => c.total),
    marker: { colors: cats.map(c => meta[c.cat].color), line: { color: '#0d1117', width: 3 } },
    textinfo: 'none', hovertemplate: `%{label}: %{value:,.0f} ${sym} · %{percent}<extra></extra>`,
  }], {
    paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117', showlegend: false, margin: { t: 10, b: 10, l: 10, r: 10 },
    annotations: [
      { text: 'Total spent', showarrow: false, x: 0.5, y: 0.58, font: { size: 14, color: '#8b949e' } },
      { text: `<b>${money(total)}</b>`, showarrow: false, x: 0.5, y: 0.46, font: { size: 30, color: '#e6edf3' } },
      { text: `${from} – ${to}`, showarrow: false, x: 0.5, y: 0.35, font: { size: 11, color: '#6a7381' } },
      { text: daysIn(from, to) ? `${perDayText(total / daysIn(from, to))} · ${daysIn(from, to)} days` : '',
        showarrow: false, x: 0.5, y: 0.28, font: { size: 13, color: '#8b949e' } },
    ],
  }, { ...CONFIG, displayModeBar: false });

  // the note is one's own (bank_transactions.expense_note): click to write it
  const rowsTable = list => `<div class="exp-rows"><table class="data-table"><thead><tr><th>Date</th><th>Description</th><th style="text-align:left">Category</th><th>Note</th><th style="width:1%;text-align:left">Place</th><th style="width:1%;text-align:left">Items</th><th>Account</th><th>Amount</th><th>${ccy}</th></tr></thead><tbody>${
    // newest first, to the second -- rows with no time in their statement too,
    // by the importer's 00:00:SS (their order within the day)
    list.slice().sort((a, b) => b.day.localeCompare(a.day) || String(b.ts).localeCompare(String(a.ts))).map(r => `<tr><td style="white-space:nowrap">${r.day}${mpTimeHtml(r)}</td><td style="text-align:left"${mpShortDesc(r.description) !== r.description ? ` title="${esc(r.description)}"` : ''}>${esc(mpShortDesc(r.description))} ${mpLinkHtml(r)}</td>
      <td class="exp-cat-set" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}"${r.split ? ' data-split="1" title="Set on the receipt\'s lines: click to open it"' : ' title="Click to change the category"'} style="text-align:left;cursor:pointer;color:#c9d1d9">${esc(r.cat || '—')}</td>
      <td class="exp-note" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to write a note" style="text-align:left;cursor:pointer;color:#8b949e">${mpNoteHtml(r.note)}</td><td class="exp-place" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to set the place" style="text-align:left;max-width:180px;cursor:pointer">${mpPlaceHtml(r.place, r.deliveredTo)}</td>
      <td class="exp-items" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to see / add items" style="text-align:left;cursor:pointer">${mpItemsHtml(mpExpCache?.receiptOf?.get(`${r.src}|${r.xid}`))}</td>
      ${r.src === 'receipt_csv'
        ? `<td class="exp-account" data-src="${esc(r.src)}" data-xid="${esc(r.xid || '')}" title="Click to set the account" style="text-align:left;cursor:pointer">${esc(r.account)}</td>`
        : `<td style="text-align:left">${esc(r.account)}</td>`}
      <td>${esc(mpExpAmount(r.amt, r.ccy))}</td><td>${rowMoney(conv(r))}</td></tr>`).join('')}</tbody></table></div>`;
  const catList = document.getElementById('exp_categories');
  // the list: the groups always (food, travel, housing, ...), and without "by
  // group" each one's categories under it, indented -- the same groups either way
  const items = [];
  for (const c of cats) {
    const g = MP_EXP_GROUPS[c.cat];
    if (groupedTop || !g) { items.push(c); continue; }
    if (items.at(-1)?.group !== g && items.at(-1)?.cat !== g) {
      const members = cats.filter(x => MP_EXP_GROUPS[x.cat] === g);
      items.push({ cat: g, header: true, total: members.reduce((t, x) => t + x.total, 0), rows: members.flatMap(x => x.rows) });
    }
    items.push({ ...c, group: g });
  }
  // a group's line (without "by group") folds its categories in and out, its
  // rows are under them; folded or not stays across re-renders
  const folded = c => c.group && mpExpFolded.has(c.group);
  catList.innerHTML = items.length ? items.map((c, i) => `<div class="exp-cat${c.group ? ' exp-sub' : ''}" data-i="${i}"${c.group ? ` data-g="${c.group}"` : ''}${c.header ? ` data-head="${c.cat}"` : ''}${folded(c) ? ' style="display:none"' : ''}>
      ${mpExpDot(meta[c.cat])}
      <div class="exp-name"><b>${c.header ? `<span class="exp-caret">${mpExpFolded.has(c.cat) ? '▸' : '▾'}</span> ` : ''}${c.cat}</b><span>${c.rows.length} transaction${c.rows.length === 1 ? '' : 's'}</span></div>
      <div class="exp-amt"><b>${money(c.total)}</b><span>${total ? Math.round(c.total / total * 100) : 0}%</span></div>
    </div><div class="exp-open" data-i="${i}" style="display:none"></div>`).join('')
    : '<p class="empty-note">No expenses in this period.</p>';
  catList.querySelectorAll('.exp-cat').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.head) {
      const g = el.dataset.head, fold = !mpExpFolded.has(g);
      fold ? mpExpFolded.add(g) : mpExpFolded.delete(g);
      el.querySelector('.exp-caret').textContent = fold ? '▸' : '▾';
      catList.querySelectorAll(`.exp-cat[data-g="${g}"]`).forEach(sub => {
        sub.style.display = fold ? 'none' : '';
        if (fold) catList.querySelector(`.exp-open[data-i="${sub.dataset.i}"]`).style.display = 'none';
      });
      return;
    }
    const box = catList.querySelector(`.exp-open[data-i="${el.dataset.i}"]`);
    if (!box.innerHTML) box.innerHTML = rowsTable(items[el.dataset.i].rows);
    box.style.display = box.style.display === 'none' ? '' : 'none';
    box.style.display === 'none' ? mpExpOpen.delete(items[el.dataset.i].cat) : mpExpOpen.add(items[el.dataset.i].cat);
  }));
  items.forEach((c, i) => {
    if (c.header || folded(c) || !mpExpOpen.has(c.cat)) return;
    const box = catList.querySelector(`.exp-open[data-i="${i}"]`);
    box.innerHTML = rowsTable(c.rows);
    box.style.display = '';
  });
}

async function mpExpDrawIncome(c) {
  const { ccy, esc, from, money, rowMoney, sym, to, total, usdPer } = c;
  // income in the period, as the spending above: a ring by kind (a salary, a
  // flat's rent, ...) and the list, each kind opening onto its transfers --
  // on the day each came in (not spread over the month it's for, as the bars do)
  const incRows = mpExpCache.incomeRows.filter(r => r.day >= from && r.day <= to && Number.isFinite(Number(r.usd)));
  const incConv = r => Number(r.usd) / usdPer(ccy, r.day);
  const incCats = [...incRows.reduce((m, r) => {
    const k = r.category || 'Other income';
    if (!m.has(k)) m.set(k, { cat: k, total: 0, rows: [] });
    const e = m.get(k); e.total += incConv(r); e.rows.push(r);
    return m;
  }, new Map()).values()].sort((x, y) => y.total - x.total);
  const incTotal = incCats.reduce((t, c) => t + c.total, 0);
  const incColor = k => mpIncomeMeta(k).color;
  await Plotly.react(document.getElementById('plot_inc_donut'), incCats.length ? [{
    type: 'pie', hole: 0.78, sort: false, direction: 'clockwise',
    labels: incCats.map(c => c.cat), values: incCats.map(c => c.total),
    marker: { colors: incCats.map(c => incColor(c.cat)), line: { color: '#0d1117', width: 3 } },
    textinfo: 'none', hovertemplate: `%{label}: %{value:,.0f} ${sym} · %{percent}<extra></extra>`,
  }] : [], {
    paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117', showlegend: false, margin: { t: 10, b: 10, l: 10, r: 10 },
    xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [
      { text: 'Total income', showarrow: false, x: 0.5, y: 0.58, xref: 'paper', yref: 'paper', font: { size: 14, color: '#8b949e' } },
      { text: `<b>${money(incTotal)}</b>`, showarrow: false, x: 0.5, y: 0.46, xref: 'paper', yref: 'paper', font: { size: 30, color: '#e6edf3' } },
      { text: `${from} – ${to}`, showarrow: false, x: 0.5, y: 0.35, xref: 'paper', yref: 'paper', font: { size: 11, color: '#6a7381' } },
      { text: incTotal && total ? `spent ${Math.round(total / incTotal * 100)}% of it` : '', showarrow: false, x: 0.5, y: 0.28,
        xref: 'paper', yref: 'paper', font: { size: 13, color: '#8b949e' } },
    ],
  }, { ...CONFIG, displayModeBar: false });
  const incList = document.getElementById('inc_categories');
  // the income groups opened by the user stay open across the tab's re-renders (as mpExpOpen does for expenses)
  const incOpen = mpIncOpen;
  const incTable = list => `<div class="exp-rows"><table class="data-table"><thead><tr><th>Date</th><th>Description</th><th style="text-align:left">Type</th><th>Note</th><th style="width:1%;text-align:left">Place</th><th>Account</th><th>Amount</th><th>${ccy}</th></tr></thead><tbody>${
    list.slice().sort((x, y) => y.day.localeCompare(x.day)).map(r => `<tr><td style="white-space:nowrap">${r.day}${mpTimeHtml(r)}</td>
      <td style="text-align:left">${esc(r.description || '')} ${mpLinkHtml(r)}</td>
      <td class="inc-cat-set" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to change the type" style="text-align:left;cursor:pointer;color:#c9d1d9">${esc(r.category || '—')}</td>
      <td class="exp-note" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to write a note" style="text-align:left;cursor:pointer;color:#8b949e">${mpNoteHtml(r.note)}</td><td class="exp-place" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to set the place" style="text-align:left;max-width:180px;cursor:pointer">${mpPlaceHtml(r.place, r.deliveredTo)}</td>
      <td style="text-align:left">${esc(r.account)}</td>
      <td>${Number(r.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${esc(r.currency || '')}</td><td>${rowMoney(incConv(r))}</td></tr>`).join('')}</tbody></table></div>`;
  incList.innerHTML = incCats.length ? incCats.map((c, i) => `<div class="exp-cat" data-i="${i}">
      ${mpExpDot(mpIncomeMeta(c.cat))}
      <div class="exp-name"><b>${esc(c.cat)}</b><span>${c.rows.length} transaction${c.rows.length === 1 ? '' : 's'}</span></div>
      <div class="exp-amt"><b>${money(c.total)}</b><span>${incTotal ? Math.round(c.total / incTotal * 100) : 0}%</span></div>
    </div><div class="exp-open" data-i="${i}" style="display:none"></div>`).join('')
    : '<p class="empty-note">No income in this period.</p>';
  incList.querySelectorAll('.exp-cat').forEach(el => el.addEventListener('click', () => {
    const box = incList.querySelector(`.exp-open[data-i="${el.dataset.i}"]`);
    if (!box.innerHTML) box.innerHTML = incTable(incCats[el.dataset.i].rows);
    box.style.display = box.style.display === 'none' ? '' : 'none';
    box.style.display === 'none' ? incOpen.delete(incCats[el.dataset.i].cat) : incOpen.add(incCats[el.dataset.i].cat);
  }));
  incCats.forEach((c, i) => {
    if (!incOpen.has(c.cat)) return;
    const box = incList.querySelector(`.exp-open[data-i="${i}"]`);
    box.innerHTML = incTable(c.rows);
    box.style.display = '';
  });
}

// The bars over time: their labels (a calendar month / quarter / year, or
// one ending today), the bar a day falls in and the first day counted;
// a rolling one's days into mpExpRollingDays
function mpExpBarBuckets(rolling, step, span, today, first) {
  const buckets = [];
  let bucket, startDay;
  if (rolling) {
    // months / quarters / years ending today: 29.09 - 28.10, 29.08 - 28.09, ... (the same day
    // of the month, the last one for a month too short)
    const unit = step.replace(/_td$/, ''), n = { month: 1, quarter: 3, year: 12 }[unit];
    const [y, m, d] = today.split('-').map(Number);
    const end = k => {
      const last = new Date(Date.UTC(y, m - k * n, 0)).getUTCDate();
      return new Date(Date.UTC(y, m - 1 - k * n, Math.min(d, last)));
    };
    const count = span === 'all' ? Infinity : Math.max(1, Math.round(Number(span) / n));
    mpExpRollingDays.clear();
    const ranges = [];
    for (let k = 0; k < count; k++) {
      const to = end(k).toISOString().slice(0, 10);
      const from = new Date(end(k + 1).getTime() + 86400000).toISOString().slice(0, 10);
      const label = k === 0 ? `this ${unit}` : `-${k} ${unit}${k === 1 ? '' : 's'}`;
      mpExpRollingDays.set(label, [from, to]);
      ranges.unshift([label, from]);
      if (from <= first) break;
    }
    buckets.push(...ranges.map(r => r[0]));
    startDay = ranges[0][1];
    bucket = day => ranges.findLast(r => r[1] <= day)[0];
  } else {
    const monthOf = mo => step === 'year' ? mo.slice(0, 4)
      : step === 'quarter' ? `${mo.slice(0, 4)} Q${Math.ceil(Number(mo.slice(5, 7)) / 3)}` : mo;
    bucket = day => monthOf(day.slice(0, 7));
    const endMo = today.slice(0, 7);
    const startMo = span === 'all' ? first.slice(0, 7)
      : (([y, m]) => new Date(Date.UTC(y, m - Number(span), 1)).toISOString().slice(0, 7))(endMo.split('-').map(Number));
    startDay = startMo + '-01';
    for (let [y, m] = startMo.split('-').map(Number); ; m++) {
      const mo = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 7);
      if (mo > endMo) break;
      const b = monthOf(mo);
      if (buckets[buckets.length - 1] !== b) buckets.push(b);
    }
  }
  return { buckets, bucket, startDay };
}
const mpMonthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const mpNextMonth = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 7);
// the working days (Mon-Fri) of a..z
function mpWorkDays(a, z) {
  let n = 0;
  for (let d = a; d <= z; d = mpDayShift(d, 1)) if (![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())) n++;
  return n;
}
// an expectation's pay days up to `until`, each with its share of the month's
// amount: a month paid on its last day; a first month begun after its 1st, its
// working days' share, paid with the next month (the new job from 20.10.2026:
// 9 of October's 22 working days on top of November's salary)
function mpExpExpectedPays(e, until) {
  const out = [];
  for (let m = e.from_day.slice(0, 7); m <= until.slice(0, 7); m = mpNextMonth(m)) {
    const a = m + '-01', z = mpMonthEnd(m);
    if (e.to_day && a > e.to_day) break;
    const from = e.from_day > a ? e.from_day : a, to = e.to_day && e.to_day < z ? e.to_day : z;
    const share = mpWorkDays(from, to) / mpWorkDays(a, z);
    out.push([from > a ? mpMonthEnd(mpNextMonth(m)) : z, share]);
  }
  return out;
}

async function mpExpDrawBars(c) {
  const { ccy, conv, dmy, known, lifeName, meta, money, periods, spent, spreadOn, sym, today, withExtrapolated } = c;
  // the chosen span to this month, by month / quarter / year, stacked by category --
  // not tied to the period above, so stepping through periods leaves it as it is
  const span = document.getElementById('exp_span').value;
  const step = document.getElementById('exp_step').value;
  const bars = document.getElementById('plot_exp_months');
  const totalsRows = mpExpCache.totals || [];
  const barsKey = [today, span, step, ccy, spent.length, totalsRows.length, mpExpCache.incomeDays.length,
    (mpExpCache.loaded || []).length, mpExpFull, periods.length, spreadOn, withExtrapolated,
    document.getElementById('exp_income').value, document.getElementById('exp_grouped').checked].join('|');
  if (bars.mpExpKey === barsKey) return;
  bars.mpExpKey = barsKey;
  // the spending and the income by calendar month / quarter / year: the monthly
  // sums (month_totals, migration ...190 -- the whole history at once), each row
  // at its own day's rate in each currency, as the rows were; "spread prepaid
  // rent" picks the months by day or by paid_day. To today (a rolling month /
  // quarter / year) needs the days: from the rows, as they come in
  const rolling = /_td$/.test(step);
  const ccyCol = ccy.toLowerCase();
  const expMonths = totalsRows.filter(r => r.kind === 'expense' && r.basis === (spreadOn ? 'day' : 'paid') && r.counted
    && (withExtrapolated || !r.extrapolated));
  const incMonths = totalsRows.filter(r => r.kind === 'income');
  // the records' first day (the rows with no dollar sum too): a bar the records start in, "only from ..."
  const first = expMonths.reduce((m, r) => (r.first_day && r.first_day < m ? r.first_day : m), today);
  const { buckets, bucket, startDay } = mpExpBarBuckets(rolling, step, span, today, first);
  // by group: the shades of one colour (MP_EXP_GROUPS) as one bar part
  const catOf = document.getElementById('exp_grouped').checked ? c => MP_EXP_GROUPS[c] ?? c : c => c;
  // to today, or to this month's end (a month of rent paid ahead is in it)
  const inSpan = day => day >= startDay && (rolling ? day <= today : day.slice(0, 7) <= today.slice(0, 7));
  // category \0 bucket -> spent, each category on its own (the forecast below reads them so)
  const catBy = new Map();
  const addTo = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  if (rolling) {
    for (const r of spent) if (inSpan(r.day) && Number.isFinite(r.usd)) addTo(catBy, r.cat + '\u0000' + bucket(r.day), conv(r));
  } else {
    for (const r of expMonths) if (r[ccyCol] != null && inSpan(r.month)) addTo(catBy, r.category + '\u0000' + bucket(r.month), Number(r[ccyCol]));
  }
  const byBucket = new Map();
  for (const [k, v] of catBy) { const [c, b] = k.split('\u0000'); addTo(byBucket, catOf(c) + '\u0000' + b, v); }
  // a category the page doesn't know yet: before transfers to people, cash and the unsorted
  const tail = ['Transfers to people', 'Cash', 'Other'];
  const names = [...new Set([...MP_EXP_CATS.filter(c => !tail.includes(c[0])).map(c => catOf(c[0])),
    ...[...expMonths].sort((x, y) => (x.first_day < y.first_day ? -1 : x.first_day > y.first_day ? 1 : 0)).map(r => r.category)
      .filter(c => !(c in known)), ...tail])];
  const order = names.filter(n => buckets.some(b => byBucket.has(n + '\u0000' + b)));
  // where one was, in the bar's hover only -- the names of the short trips wouldn't fit on it
  const where = buckets.map(b => {
    const [f, t] = mpExpBucketDays(b);
    const names = [...new Set(periods.filter(p => p.start_day <= t && p.end_day >= f).map(lifeName))];
    return names.length ? 'Where: ' + (names.length > 6 ? names.slice(0, 6).join(', ') + ', …' : names.join(', ')) : '';
  });
  // income: a line over the stacks (a bar above it is a period spent more than
  // came in), or a bar of its own to the right of each spending bar
  const incomeMode = document.getElementById('exp_income').value;
  const sideBySide = incomeMode === 'bars';
  const incomeBy = new Map();
  const incomeByCat = new Map();   // kind \0 bucket -> came in: the bars split by kind (a salary, a flat's rent, ...)
  const addIncome = (b, cat, v) => {
    incomeBy.set(b, (incomeBy.get(b) || 0) + v);
    const k = (cat || 'Other income') + '\u0000' + b;
    incomeByCat.set(k, (incomeByCat.get(k) || 0) + v);
  };
  // each payment over the days it was earned in (mpExpIncomeDays): by month the server's sums, to today the rows'
  if (incomeMode !== 'off' && !rolling) {
    for (const r of incMonths) if (r[ccyCol] != null && inSpan(r.month)) addIncome(bucket(r.month), r.category, Number(r[ccyCol]));
  } else if (incomeMode !== 'off') {
    for (const r of mpExpCache.incomeDays) {
      if (r.day < startDay || (/_td$/.test(step) ? r.day > today : r.day.slice(0, 7) > today.slice(0, 7))) continue;
      addIncome(bucket(r.day), r.cat, r.usd / mpExpCache.usdPer(ccy, r.paid));
    }
  }
  // a bar of a part only (the records start in it, or it isn't over yet): a
  // dashed frame around it, what part above it, its label with *
  const partial = buckets.map(b => {
    const [f, t] = mpExpBucketDays(b);
    const start = first > startDay ? first : startDay;
    return f < start ? `only from ${dmy(start)}` : t > today ? `only to ${dmy(today)}` : '';
  });
  const totals = buckets.map(b => order.reduce((t, n) => t + (byBucket.get(n + '\u0000' + b) || 0), 0));
  // a part-only bar's frame: the whole period as it would likely be. The
  // one-offs (a laptop, a trip) as they are; the regular spending per category
  // (03.11.2026: May 2017, the records starting on the 22nd, had food 20 $ and
  // no rent, June 125 $ and 25 $ -- the 10 days' pace gave May 62 $ of food):
  //  - the records start in it: as much as the next whole period, per day;
  //  - it isn't over yet: the day-by-day ones (MP_EXP_REGULAR) for the days
  //    left at the pace where one lives now, the monthly ones (MP_EXP_MONTHLY) as much as the last
  //    whole period, if not paid yet -- none then, none now (one's own flat);
  //  never less than what's there.
  const nDays = (a, z) => (Date.parse(z) - Date.parse(a)) / 86400000 + 1;
  // the day-by-day pace now: spent a day where one lives now, since the place's
  // first day or the last whole period's first, whichever is later (Tbilisi from
  // 19.10.2026: October's days there, not November's first two alone), up to
  // the day before yesterday -- TBC books a payment 1-3 days later, the last
  // two days aren't all in yet
  const lastWhole = buckets.map((x, k) => k).filter(k => !partial[k]).pop();
  const here = periods.filter(p => p.start_day <= today && p.end_day >= today).sort((x, y) => y.start_day.localeCompare(x.start_day))[0];
  const dayShift = mpDayShift;
  let paceFrom = lastWhole !== undefined ? mpExpBucketDays(buckets[lastWhole])[0] : today;
  if (here && here.start_day > paceFrom) paceFrom = here.start_day;
  // the transport's pace not from the first week at a new place: the airport,
  // the papers (Tbilisi from 19.10.2026: 82 EUR of taxis in two days, 8 USD a
  // day as a pace) -- unless that leaves under a week to go by. The food's
  // goes on from the first day.
  const settled = here ? dayShift(here.start_day, MP_EXP_SETTLE_DAYS) : null;
  const transportFrom = settled && settled > paceFrom && dayShift(today, -2) >= dayShift(settled, 6) ? settled : paceFrom;
  const paceTo = dayShift(today, -2) >= paceFrom ? dayShift(today, -2) : today;
  // a category's spending over some days: its whole months from the monthly
  // sums, the days of a month in part from the rows -- once all of them are
  // loaded (else no forecast yet: rowsMissing). By paid_day a row is loaded by
  // its day, on or after paid_day (rent paid ahead): all the days from there on
  const loaded = mpExpCache.loaded || [mpExpCache.range];
  const covered = (a, z) => {
    if (loaded.some(r => !r)) return true;
    let at = a;
    for (const r of [...loaded].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))) {
      if (r.from <= at && r.to >= at) { if (r.to >= z) return true; at = dayShift(r.to, 1); }
    }
    return false;
  };
  const catMonth = new Map();   // category \0 YYYY-MM -> spent
  for (const r of expMonths) if (r[ccyCol] != null) addTo(catMonth, r.category + '\u0000' + r.month.slice(0, 7), Number(r[ccyCol]));
  let rowsMissing = false;
  const sumCat = (cat, from, to, after) => {
    if (after && after >= from) from = dayShift(after, 1);
    let x = 0;
    for (let mo = from.slice(0, 7); from <= to && mo <= to.slice(0, 7);
      mo = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 1)).toISOString().slice(0, 7)) {
      const a = mo + '-01', z = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).toISOString().slice(0, 10);
      if (from <= a && z <= to) { x += catMonth.get(cat + '\u0000' + mo) || 0; continue; }
      const f = from > a ? from : a, t = to < z ? to : z;
      if (!covered(f, spreadOn ? t : '9999-12-31')) rowsMissing = true;
      for (const r of spent) if (r.cat === cat && r.day >= f && r.day <= t && Number.isFinite(r.usd)) x += conv(r);
    }
    return x;
  };
  const paceStart = cat => (MP_EXP_TRANSPORT.has(cat) && transportFrom <= paceTo ? transportFrom : paceFrom);
  const dailyRate = cat => sumCat(cat, paceStart(cat), paceTo) / nDays(paceStart(cat), paceTo);
  // null: the rows it needs aren't all in yet -- no frame
  const projected = buckets.map((b, i) => {
    if (!partial[i]) return totals[i];
    rowsMissing = false;
    const [f, t] = mpExpBucketDays(b);
    const start = first > startDay ? first : startDay;
    const startsIn = f < start;
    let ref = -1;
    if (startsIn) { for (let k = i + 1; k < buckets.length; k++) if (!partial[k]) { ref = k; break; } }
    else { for (let k = i - 1; k >= 0; k--) if (!partial[k]) { ref = k; break; } }
    const [rf, rt] = ref >= 0 ? mpExpBucketDays(buckets[ref]) : [null, null];
    let extra = 0;
    const parts = [];
    for (const cat of [...MP_EXP_REGULAR, ...MP_EXP_MONTHLY]) {
      const a = catBy.get(cat + '\u0000' + b) || 0;
      let est, how;
      if (startsIn) {
        est = ref >= 0 ? sumCat(cat, rf, rt) / nDays(rf, rt) * nDays(f, t) : a;
        how = ref >= 0 ? `as ${rf}..${rt}, per day` : 'as it is';
      } else if (MP_EXP_REGULAR.has(cat)) {
        const cut = paceTo < f ? dayShift(f, -1) : paceTo;
        est = sumCat(cat, f, cut) + dailyRate(cat) * Math.max(0, nDays(dayShift(cut, 1), t));
        how = `to ${cut} as it is, then ${dailyRate(cat).toFixed(2)} a day (the pace ${paceStart(cat)}..${paceTo})`;
      } else {
        // the last whole period's monthly payments -- made where one lives now
        // (after the day one came: not Cyprus' or a trip's), the Nizhny flat's wherever
        const after = MP_EXP_MONTHLY_ANYWHERE.has(cat) || !here ? null : here.start_day;
        est = ref >= 0 ? sumCat(cat, rf, rt, after) : 0;
        how = ref >= 0 ? `the payments of ${rf}..${rt}${after ? ` after ${after}` : ''}` : 'none';
      }
      extra += Math.max(0, est - a);
      if (a || est) parts.push({ cat, actual: +a.toFixed(2), estimate: +Math.max(a, est).toFixed(2), how });
    }
    if (rowsMissing) return null;
    // kept day by day, to set against what the period comes to (migration ...154)
    if (!startsIn) mpExpKeepForecast({ step, period: b, from: f, to: t, ccy, actual: totals[i], projected: totals[i] + extra, parts });
    return totals[i] + extra;
  });
  // where a new year starts: between the bars of December and January
  const yearOf = b => mpExpBucketDays(b)[0].slice(0, 4);
  const yearStarts = step === 'year' ? [] : buckets.map((b, i) => i).filter(i => i > 0 && yearOf(buckets[i]) !== yearOf(buckets[i - 1]));
  const yearLines = yearStarts.map(i => ({ type: 'line', xref: 'x', yref: 'paper', x0: i - 0.5, x1: i - 0.5, y0: 0, y1: 1,
    line: { color: '#6e7681', width: 2 }, layer: 'below' }));
  const yearLabels = yearStarts.map(i => ({ x: i - 0.5, xref: 'x', y: 1, yref: 'paper', text: yearOf(buckets[i]), showarrow: false,
    xanchor: 'left', yanchor: 'top', xshift: 3, font: { size: 11, color: '#8b949e' } }));
  // side by side: Plotly can't stack within a group, so the stack is laid by
  // hand (base) in the left half of the slot, the income in the right half
  // income on the left, spending on the right (03.11.2026)
  const half = { income: { offset: -0.42, width: 0.4 }, spent: { offset: 0.02, width: 0.4, mid: 0.22 } };
  const stackBase = buckets.map(() => 0);
  const spentTraces = order.map(n => {
    const y = buckets.map(b => byBucket.get(n + '\u0000' + b) ?? null);  // null: no line in the hover
    const trace = { type: 'bar', name: n, x: buckets, y,
      marker: { color: (MP_EXP_GROUP_META[n] ?? meta[n]).color }, hovertemplate: `${n}: %{y:,.0f} ${sym}<extra></extra>` };
    if (!sideBySide) return trace;
    const base = [...stackBase];
    y.forEach((v, i) => { stackBase[i] += v || 0; });
    // with a base %{y} is the bar's top: its own value from customdata
    return { ...trace, base, offset: half.spent.offset, width: half.spent.width, customdata: y,
      hovertemplate: `${n}: %{customdata:,.0f} ${sym}<extra></extra>` };
  });
  const incomeY = buckets.map(b => incomeBy.get(b) ?? 0);
  // side by side: the income bar stacked by kind, the salary at the bottom
  const incomeKinds = [...new Set([...incomeByCat.keys()].map(k => k.split('\u0000')[0]))]
    .sort((x, y) => (MP_INCOME_COLORS[x] ? Object.keys(MP_INCOME_COLORS).indexOf(x) : 99) - (MP_INCOME_COLORS[y] ? Object.keys(MP_INCOME_COLORS).indexOf(y) : 99));
  // an income bar of a period not over yet: what it will likely come to, framed
  // as the spending bar is -- the expected salary (income_expectations) for each
  // month whose last day, its pay day, is still ahead and none of it came in that
  // month yet; the other kinds (interest, coupons, the flat's rent, ...) at the
  // last whole period's pace a day for the days left. Not the salaries of the
  // past: the job they came from may be over (Cyprus, 19.10.2026).
  const expect = mpExpCache.incomeExpect || [];
  const expectKinds = new Set(['Salary', ...expect.map(e => e.category)]);
  const incomeProjected = buckets.map((b, i) => {
    const now = incomeBy.get(b) || 0;
    const [f, t] = mpExpBucketDays(b);
    if (!partial[i] || t <= today || incomeMode === 'off') return now;
    let extra = 0;
    for (const e of expect) {
      for (const [pay, share] of mpExpExpectedPays(e, t)) {
        if (pay <= today || pay > t || pay < f) continue;
        // (the month's income rows not all loaded yet: no frame yet)
        if (!covered(pay.slice(0, 7) + '-01', today)) return null;
        // none of it in the pay day's month yet (not the old job's last salary
        // before from_day: Wheely's of 29.10.2026)
        const came = (mpExpCache.incomeRows || []).some(r => r.category === e.category && r.day.slice(0, 7) === pay.slice(0, 7) && r.day >= e.from_day);
        if (!came) extra += share * Number(e.amount) * mpExpCache.usdPer(e.currency, today) / mpExpCache.usdPer(ccy, today);
      }
    }
    if (lastWhole !== undefined) {
      const [rf, rt] = mpExpBucketDays(buckets[lastWhole]);
      for (const kind of incomeKinds) {
        if (expectKinds.has(kind)) continue;
        extra += (incomeByCat.get(kind + '\u0000' + buckets[lastWhole]) || 0) / nDays(rf, rt) * nDays(dayShift(today, 1), t);
      }
    }
    return now + extra;
  });
  const incomeFramed = i => sideBySide && incomeProjected[i] != null && incomeProjected[i] - (incomeBy.get(buckets[i]) || 0) > 0.5;
  const incomeBase = buckets.map(() => 0);
  // in the hover a rule over the income (its first kind that bucket) and over the totals
  const hoverRule = '<span style="color:#484f58">────────────────</span><br>';
  const firstKindAt = buckets.map(b => incomeKinds.find(kind => incomeByCat.has(kind + '\u0000' + b)));
  const incomeTraces = !incomeBy.size ? [] : sideBySide
    ? incomeKinds.map(kind => {
      const y = buckets.map(b => incomeByCat.get(kind + '\u0000' + b) ?? null);
      const base = [...incomeBase];
      y.forEach((v, i) => { incomeBase[i] += v || 0; });
      return { type: 'bar', name: `Income: ${kind}`, x: buckets, y, base, offset: half.income.offset, width: half.income.width,
        marker: { color: MP_INCOME_COLORS[kind] ?? '#8b949e' }, customdata: y.map((v, i) => [v, firstKindAt[i] === kind ? hoverRule : '']),
        hovertemplate: `%{customdata[1]}<b>${kind}: %{customdata[0]:,.0f} ${sym}</b><extra></extra>` };
    })
    : [{ type: 'scatter', mode: 'lines+markers', name: 'Income', x: buckets, y: incomeY, line: { color: '#e6edf3', width: 2 },
      marker: { color: '#e6edf3', size: 7, line: { color: '#0d1117', width: 1 } },
      hovertemplate: `${hoverRule}<b>Income: %{y:,.0f} ${sym}</b><extra></extra>` }];
  // a part-only bar's frame around the spending bar alone
  const frameX = i => (sideBySide ? [i + half.spent.offset, i + half.spent.offset + half.spent.width] : [i - 0.46, i + 0.46]);
  await Plotly.react(bars, [...spentTraces,
  ...incomeTraces,
  // the bar's total and where one was, in the hover only: first there -- the stack's
  // hover lists the traces last to first
  // under the line: what came in, what went out, and the difference -- or the
  // spending alone with the income off
  { type: 'scatter', mode: 'markers', marker: { opacity: 0 }, name: 'Total', showlegend: false,
    x: buckets, y: totals,
    customdata: buckets.map((b, i) => mpExpRollingDays.has(b) && /_td$/.test(step)
      ? mpExpBucketDays(b).map(x => x.split('-').reverse().join('.')).join(' – ') + (where[i] ? '<br>' + where[i] : '')
      : where[i]).map((w, i) => {
      const amt = v => `${v < 0 ? '−' : ''}${Math.round(Math.abs(v)).toLocaleString('en-US')} ${sym}`;
      const sums = incomeMode === 'off' ? [`<b>Total spent: ${amt(totals[i])}</b>`]
        : [`<b>Total income: ${amt(incomeY[i])}</b>`, `<b>Total spent: ${amt(totals[i])}</b>`,
          `<b>Net: ${incomeY[i] - totals[i] >= 0 ? '+' : ''}${amt(incomeY[i] - totals[i])}</b>`];
      return hoverRule + [...sums, partial[i] && `<i>${partial[i]}</i>`, w].filter(Boolean).join('<br>');
    }),
    hovertemplate: `%{customdata}<extra></extra>` }], {
    barmode: sideBySide ? 'overlay' : 'stack', paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117', font: { color: '#8b949e' },
    margin: { t: 10, b: 40, l: 60, r: 10 }, hovermode: 'x unified', hoverlabel: { font: { size: 11 } },
    // labels at an angle, the margin grown to fit them; the legend above, out of their way
    xaxis: { type: 'category', gridcolor: '#1e2830', tickangle: -45, automargin: true,
             tickvals: buckets, ticktext: buckets.map((b, i) => (partial[i] ? b + '*' : b)) },
    yaxis: { gridcolor: '#1e2830', ticksuffix: ccy === 'RUB' ? ' ₽' : '', tickprefix: ccy === 'RUB' ? '' : sym },
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom' },
    // a line between the years (by month / quarter), the year above it
    shapes: [...yearLines, ...buckets.flatMap((b, i) => partial[i] && totals[i] && projected[i] != null ? [{
      type: 'rect', xref: 'x', yref: 'y', x0: frameX(i)[0], x1: frameX(i)[1], y0: 0, y1: projected[i],
      line: { color: '#8b949e', width: 1.5, dash: 'dot' }, fillcolor: 'rgba(0,0,0,0)', layer: 'above' }] : []),
    ...buckets.flatMap((b, i) => incomeFramed(i) ? [{
      type: 'rect', xref: 'x', yref: 'y', x0: i + half.income.offset, x1: i + half.income.offset + half.income.width, y0: 0, y1: incomeProjected[i],
      line: { color: '#8b949e', width: 1.5, dash: 'dot' }, fillcolor: 'rgba(0,0,0,0)', layer: 'above' }] : [])],
    annotations: [...yearLabels, ...buckets.flatMap((b, i) => partial[i] && totals[i] && projected[i] != null ? [{
      // x as the index: "2017" would be read as position 2017
      x: sideBySide ? i + half.spent.mid : i, xref: 'x', y: projected[i], yref: 'y', text: `${partial[i]}<br>≈ ${money(projected[i])} for all of it`,
      showarrow: false, yanchor: 'bottom', yshift: 2,
      font: { size: 10, color: '#8b949e' } }] : []),
    ...buckets.flatMap((b, i) => incomeFramed(i) ? [{
      x: i + half.income.offset + half.income.width / 2, xref: 'x', y: incomeProjected[i], yref: 'y', text: `≈ ${money(incomeProjected[i])}<br>coming in`,
      showarrow: false, yanchor: 'bottom', yshift: 2, font: { size: 10, color: '#8b949e' } }] : [])],
  }, CONFIG);
  bars.removeAllListeners?.('plotly_click');
  bars.on('plotly_click', ev => {
    const b = ev.points?.[0]?.x;
    if (!b) return;
    // a bar opens as the period: a quarter's 3 months, a calendar month or year
    const q = b.match(/^(\d{4}) Q(\d)$/);
    if (q) {
      document.getElementById('exp_period').value = '3m';
      mpExpSetPeriod('3m', `${q[1]}-${String(q[2] * 3).padStart(2, '0')}-01`);
    } else if (/^\d{4}$/.test(b)) {
      document.getElementById('exp_period').value = 'cyear';
      mpExpSetPeriod('cyear', `${b}-01-01`);
    } else {
      document.getElementById('exp_period').value = 'custom';
      [document.getElementById('exp_from').value, document.getElementById('exp_to').value] = mpExpBucketDays(b);
    }
    mpRenderExpenses();
  });
}

function mpExpDrawExcluded(c) {
  const { ccy, conv, esc, from, group, inPeriod, money, skipped, to, usdPer } = c;
  // Not counted: each row out with the row in it went to (a pair, migration
  // 155) under it, -out and +in -- the two net out
  const signed = (v, s = v < 0 ? '−' : '+') => s + money(Math.abs(v));
  // every pair of a row out: one row out can be given back in several rows (manual links)
  const pairsOf = new Map();
  for (const p of mpExpCache.pairs || []) {
    const k = `${p.out_source}|${p.out_id}`;
    pairsOf.set(k, [...(pairsOf.get(k) || []), p]);
  }
  const pairOf = { get: k => (pairsOf.get(k) || [])[0] };
  const inConv = p => Number(p.in_usd) / usdPer(ccy, p.in_day);
  const legRow = (day, description, account, amt, rowCcy, value, noteCell, leg) => `<tr class="${leg ? 'pair-in' : 'pair-out'}"${leg ? ' style="color:#8b949e"' : ''}>
    <td style="white-space:nowrap">${day}</td>
    <td style="text-align:left"${mpShortDesc(description) !== description ? ` title="${esc(description)}"` : ''}>${leg ? '↳ ' : ''}${esc(mpShortDesc(description))}</td>
    ${noteCell}<td style="text-align:left">${esc(account)}</td>
    <td>${amt < 0 ? '−' : '+'}${Math.abs(amt).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${rowCcy}</td><td>${signed(value)}</td></tr>`;
  // a transfer leg's time, when its bank row has one (a savings trade has none)
  const legClock = (src, xid) => {
    const at = mpExpCache.clockOf?.get(`${src}|${xid}`);
    return at ? mpTimeHtml({ src, xid, at }) : '';
  };
  const inRow = p => legRow(p.in_day + legClock(p.in_source, p.in_id), p.in_description, p.in_account, Number(p.in_amount), p.in_currency, inConv(p), '<td></td><td></td>', true);
  const pairsTable = (list, extra = []) => `<div class="exp-rows"><table class="data-table pair-rows"><thead><tr><th>Date</th><th>Description</th><th>Note</th><th style="width:1%;text-align:left">Place</th><th>Account</th><th>Amount</th><th>${ccy}</th></tr></thead><tbody>${
    list.slice().sort((a, b) => b.day.localeCompare(a.day) || String(b.ts).localeCompare(String(a.ts))).map(r => {
      const ps = pairsOf.get(`${r.src}|${r.xid}`) || [];
      return legRow(r.day + mpTimeHtml(r), r.description, r.account, -r.amt, r.ccy, -conv(r),
        `<td class="exp-note" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to write a note" style="text-align:left;cursor:pointer;color:#8b949e">${mpNoteHtml(r.note)}</td><td class="exp-place" data-src="${esc(r.src || '')}" data-xid="${esc(r.xid || '')}" title="Click to set the place" style="text-align:left;max-width:180px;cursor:pointer">${mpPlaceHtml(r.place, r.deliveredTo)}</td>`)
        + ps.map(inRow).join('');
    }).join('')}${extra.map(p => legRow(p.out_day + legClock(p.out_source, p.out_id), p.out_description, p.out_account, Number(p.out_amount), p.out_currency,
      Number(p.out_usd) / usdPer(ccy, p.out_day), '<td></td><td></td>') + inRow(p)).join('')}</tbody></table></div>`;
  // chains (migration 160): a move in several steps, its rows out of the pairs
  // and the categories below into one block each
  const chainOf = mpExpCache.chainOf || new Map();
  const chainKey = (src, xid) => chainOf.get(`${src}|${xid}`);
  const outKeys = new Set(skipped.map(r => `${r.src}|${r.xid}`));
  const chained = new Map();
  const chainAdd = (name, ts, html, value, out = 0) => {
    if (!chained.has(name)) chained.set(name, []);
    chained.get(name).push({ ts: String(ts), html, value, out });
  };
  for (const r of skipped) {
    const name = chainKey(r.src, r.xid);
    if (!name || !Number.isFinite(r.usd)) continue;
    const ps = pairsOf.get(`${r.src}|${r.xid}`) || [];
    chainAdd(name, r.ts, legRow(r.day + mpTimeHtml(r), r.description, r.account, -r.amt, r.ccy, -conv(r),
      `<td style="text-align:left;color:#8b949e">${r.note ? esc(r.note) : ''}</td>`) + ps.map(inRow).join(''),
      -conv(r) + ps.reduce((s, p) => s + inConv(p), 0), conv(r));
  }
  for (const p of mpExpCache.pairs || []) {
    const name = chainKey(p.out_source, p.out_id);
    if (!name || outKeys.has(`${p.out_source}|${p.out_id}`) || !Number.isFinite(Number(p.in_usd))) continue;
    const out = Number(p.out_usd) / usdPer(ccy, p.out_day);
    chainAdd(name, p.out_day, legRow(p.out_day, p.out_description, p.out_account, Number(p.out_amount), p.out_currency, out, '<td></td><td></td>') + inRow(p), out + inConv(p));
  }
  for (const r of mpExpCache.unpairedIn || []) {
    const name = chainKey(r.external_source, r.external_id);
    if (!name || !Number.isFinite(Number(r.usd))) continue;
    const v = Number(r.usd) / usdPer(ccy, r.day);
    chainAdd(name, r.day, legRow(r.day, r.description, r.account, Number(r.amount), r.currency, v, '<td></td><td></td>', true), v);
  }
  // a chain shows when any step is in the period
  const chains = [...chained].map(([name, steps]) => ({ name, steps: steps.sort((a, b) => a.ts.localeCompare(b.ts)) }))
    .filter(c => c.steps.some(s => s.ts.slice(0, 10) >= from && s.ts.slice(0, 10) <= to));
  const unchained = list => list.filter(r => !chainKey(r.src ?? r.external_source, r.xid ?? r.external_id));
  const skip = group(inPeriod(unchained(skipped)));
  // the pairs whose row out is no bank row (a savings account's, a deposit's,
  // a broker's trade): the money back to a card, its own line
  const backPairs = (mpExpCache.pairs || []).filter(p => p.out_day >= from && p.out_day <= to
    && !outKeys.has(`${p.out_source}|${p.out_id}`) && Number.isFinite(Number(p.in_usd)) && !chainKey(p.out_source, p.out_id));
  const inOf = rows => rows.reduce((s, r) => s + (pairsOf.get(`${r.src}|${r.xid}`) || []).reduce((t, p) => t + inConv(p), 0), 0);
  const sumLine = (out, back) => `<b>${signed(-out)}</b>${back ? ` <span style="color:#8b949e">${signed(back)} in · net ${signed(back - out)}</span>` : ''}`;
  const inPeriodIn = unchained(mpExpCache.unpairedIn || []).filter(r => r.day >= from && r.day <= to && Number.isFinite(Number(r.usd)));
  // dividends: no income -- the share is worth as much less; their own line
  const isDividend = r => /дивиденд|dividend/i.test(r.description);
  const inGroup = (title, sub, list) => {
    if (!list.length) return '';
    const sum = list.reduce((s, r) => s + Number(r.usd) / usdPer(ccy, r.day), 0);
    return `<details><summary class="exp-cat" style="display:flex"><div class="exp-name"><b>${title}</b>
      <span>${list.length} transaction${list.length === 1 ? '' : 's'}${sub}</span></div>
      <div class="exp-amt"><b>${signed(sum)}</b></div></summary>
      <div class="exp-rows"><table class="data-table"><thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Amount</th><th>${ccy}</th></tr></thead><tbody>${
        list.slice().sort((a, b) => b.day.localeCompare(a.day)).map(r => `<tr><td style="white-space:nowrap">${r.day}${mpTimeHtml(r)}</td>
          <td style="text-align:left"${mpShortDesc(r.description) !== r.description ? ` title="${esc(r.description)}"` : ''}>${esc(mpShortDesc(r.description))}</td>
          <td style="text-align:left">${esc(r.account)}</td><td>+${Number(r.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${r.currency}</td>
          <td>${signed(Number(r.usd) / usdPer(ccy, r.day))}</td></tr>`).join('')}</tbody></table></div></details>`;
  };
  // the rows out of the chains in the period count in the total as before
  const skipTotal = skip.reduce((s, c) => s + c.total, 0)
    + chains.reduce((s, c) => s + c.steps.reduce((t, x) => t + (x.ts.slice(0, 10) >= from && x.ts.slice(0, 10) <= to ? x.out : 0), 0), 0);
  const exWrap = document.getElementById('exp_excluded');
  const openNow = new Set([...exWrap.querySelectorAll('details[open] > summary b')].map(b => b.textContent));
  const exHtml = skip.length || backPairs.length || inPeriodIn.length || chains.length ? `<div class="section-title" style="margin-top:24px">Not counted: ${signed(-skipTotal)}</div>
    <p class="note">Money that only moved between your own money: each row out (−), and under it the row in (+) it became when
      the two are paired -- they net out, the difference is what an exchange cost. Click a line to see its rows -- something
      that is spending after all means a rule in expense_rules is too wide, or the row's expense_category is to be set by hand.</p>
    ${chains.map(c => `<details><summary class="exp-cat" style="display:flex"><div class="exp-name"><b>${esc(c.name)}</b>
      <span>one move in ${c.steps.length} step${c.steps.length === 1 ? '' : 's'}</span></div>
      <div class="exp-amt"><span style="color:#8b949e">net ${signed(c.steps.reduce((s, x) => s + x.value, 0))}</span></div></summary>
      <div class="exp-rows"><table class="data-table pair-rows"><thead><tr><th>Date</th><th>Description</th><th>Note</th><th style="width:1%;text-align:left">Place</th><th>Account</th><th>Amount</th><th>${ccy}</th></tr></thead>
      <tbody>${c.steps.map(s => s.html).join('')}</tbody></table></div></details>`).join('')}
    ${skip.map(c => `<details><summary class="exp-cat" style="display:flex"><div class="exp-name"><b>${c.cat}</b>
      <span>${c.rows.length} transaction${c.rows.length === 1 ? '' : 's'}</span></div><div class="exp-amt">${sumLine(c.total, inOf(c.rows))}</div></summary>
      ${pairsTable(c.rows)}</details>`).join('')}
    ${backPairs.length ? `<details><summary class="exp-cat" style="display:flex"><div class="exp-name"><b>Out of savings, deposits, brokers</b>
      <span>${backPairs.length} pair${backPairs.length === 1 ? '' : 's'}</span></div><div class="exp-amt">${sumLine(
        -backPairs.reduce((s, p) => s + Number(p.out_usd) / usdPer(ccy, p.out_day), 0), backPairs.reduce((s, p) => s + inConv(p), 0))}</div></summary>
      ${pairsTable([], backPairs)}</details>` : ''}
    ${inGroup('Dividends', ' -- not income: the share is worth as much less', inPeriodIn.filter(isDividend))}
    ${inGroup('Money in, no pair and no income', ' -- a leg the matcher missed, or income no rule knows yet', inPeriodIn.filter(r => !isDividend(r)))}` : '';
  // drawn again only when its content changed: the background load adds older months,
  // which this section does not show, so its open sections stay as they are
  if (exWrap.dataset.html !== exHtml) { exWrap.innerHTML = exHtml; exWrap.dataset.html = exHtml; }
  // the sections the user opened stay open: the background load draws this section again
  for (const b of openNow) exWrap.querySelectorAll('details > summary b').forEach(t => { if (t.textContent === b) t.closest('details').open = true; });
}

async function mpRenderExpenses() {
  mpExpAskFirstDay();
  const status = document.getElementById('exp_status');
  if (!document.getElementById('exp_from').value) mpExpSetPeriod(document.getElementById('exp_period').value, new Date().toISOString().slice(0, 10));
  if (!(await mpExpEnsureRows(status))) return;
  status.textContent = mpExpFull ? '' : 'Loading the rest of the history…';
  mpExpUpdateNav();
  const { skipped, usdPer } = mpExpCache;
  const spreadOn = document.getElementById('exp_spread').checked;
  // worked out rather than recorded (the cash that left no trace, ...): shown or not
  const withExtrapolated = document.getElementById('exp_extrapolated').checked;
  const recorded = withExtrapolated ? mpExpCache.spent : mpExpCache.spent.filter(r => !r.extrapolated);
  const spent = spreadOn ? recorded : recorded.map(r => ({ ...r, day: r.paid_day, tx_date: r.paid_day }));
  // a period with no end is where one still is: to today
  const periods = mpExpCache.periods.map(p => ({ ...p, end_day: p.end_day ?? new Date().toISOString().slice(0, 10) }));
  const lifeName = p => `${p.place}${p.company ? ' with ' + p.company : ''}`;
  const dmy = d => d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4);
  const lifeSel = document.getElementById('exp_life');
  const { from, to } = mpExpRange();
  const ccy = document.getElementById('exp_ccy').value;
  const sym = { EUR: '€', USD: '$', RUB: '₽' }[ccy];
  // spending a day: periods of any length side by side -- the days up to today
  // (none to come in a period not over yet)
  const today = new Date().toISOString().slice(0, 10);
  const daysIn = (f, t) => Math.max(0, Math.round((Date.parse(t < today ? t : today) - Date.parse(f)) / 86400000) + 1);
  const perDay = (f, t) => {
    const n = daysIn(f, t);
    if (!n) return null;
    let sum = 0;
    for (const r of spent) if (r.day >= f && r.day <= t && Number.isFinite(r.usd)) sum += r.usd / usdPer(ccy, r.day);
    return sum / n;
  };
  const perDayText = v => v == null ? '' : (ccy === 'RUB' ? `${Math.round(v).toLocaleString('en-US')} ₽` : sym + Math.round(v).toLocaleString('en-US')) + ' a day';
  const lifeKey = [ccy, spreadOn, withExtrapolated, spent.length].join('|');
  if (periods.length && lifeSel.mpKey !== lifeKey) {
    lifeSel.mpKey = lifeKey;
    lifeSel.length = 1;
    periods.forEach((p, i) => lifeSel.add(new Option(
      `${dmy(p.start_day)} – ${dmy(p.end_day)}: ${lifeName(p)} · ${perDayText(perDay(p.start_day, p.end_day))}`, i)));
  }
  const here = periods.filter(p => p.start_day <= to && p.end_day >= from);
  document.getElementById('exp_life_now').textContent = here.length
    ? 'Where: ' + here.map(p => `${lifeName(p)} ${dmy(p.start_day)} – ${dmy(p.end_day)}`).join(' · ') : '';
  lifeSel.value = String(periods.findIndex(p => p.start_day === from && p.end_day === to)).replace('-1', '');
  const conv = r => r.usd / usdPer(ccy, r.day);
  const money = v => {
    const n = Math.round(v).toLocaleString('en-US');
    return ccy === 'RUB' ? `${n} ₽` : sym + n;
  };
  // a single row's equivalent: to the cent (a coffee is $1.73, not $2)
  const rowMoney = v => {
    const n = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return ccy === 'RUB' ? `${n} ₽` : sym + n;
  };
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const inPeriod = list => list.filter(r => r.day >= from && r.day <= to && Number.isFinite(r.usd));
  const rows = inPeriod(spent);
  const known = MP_EXP_META;
  const meta = new Proxy({}, { get: (_, k) => mpExpMeta(k) });
  // by group: the categories of one group (MP_EXP_GROUPS) as one line
  const groupedTop = document.getElementById('exp_grouped_top').checked;
  const group = (list, byGroup = false) => {
    const g = new Map();
    for (const r of list) {
      const cat = byGroup ? MP_EXP_GROUPS[r.cat] ?? r.cat : r.cat;
      if (!g.has(cat)) g.set(cat, { cat, total: 0, rows: [] });
      const e = g.get(cat);
      e.total += conv(r);
      e.rows.push(r);
    }
    return [...g.values()].sort((a, b) => b.total - a.total);
  };
  const cats = group(rows, groupedTop);
  // the fixed order of MP_EXP_CATS (housing, food, transport, travel, ...,
  // transfers to people, cash, the unsorted), a group where its first
  // category is; one the page doesn't know yet before that tail
  const rank = cat => {
    const i = MP_EXP_CATS.findIndex(c => c[0] === cat || MP_EXP_GROUPS[c[0]] === cat);
    return i >= 0 ? i : MP_EXP_CATS.findIndex(c => c[0] === 'Transfers to people') - 0.5;
  };
  cats.sort((a, b) => rank(a.cat) - rank(b.cat) || b.total - a.total);
  const total = cats.reduce((s, c) => s + c.total, 0);
  const c = { ccy, sym, from, to, today, periods, spent, spreadOn, withExtrapolated, usdPer, skipped, lifeName, dmy, daysIn, perDayText,
    conv, money, rowMoney, esc, inPeriod, known, meta, groupedTop, group, cats, total };
  await mpExpDrawSpent(c);
  await mpExpDrawIncome(c);
  await mpExpDrawBars(c);
  mpExpDrawExcluded(c);
}
for (const id of ['exp_from', 'exp_to']) {
  document.getElementById(id).addEventListener('change', e => {
    // typed in past the bounds: to the nearest day within them
    const { first, today } = mpExpBounds();
    if (e.target.value > today) e.target.value = today;
    if (e.target.value && e.target.value < first) e.target.value = first;
    document.getElementById('exp_period').value = 'custom';
    if (mpIsSignedIn) mpRenderExpenses();
  });
}
// the page always opens on the calendar month (the first paint loads only it): the period chosen
// last time isn't restored -- a saved "from – to" opened the month under that label, and Chrome
// put back the last year with its dates on a reload (its form restore; autocomplete="off" too)
function mpExpOpenOnMonth() {
  document.getElementById('exp_period').value = 'cmonth';
  mpExpSetPeriod('cmonth', new Date().toISOString().slice(0, 10));
}
mpExpOpenOnMonth();
// back / forward from the browser's page cache: the page as it was left, the month again
window.addEventListener?.('pageshow', e => { if (e.persisted) { mpExpOpenOnMonth(); if (mpIsSignedIn) mpRenderExpenses(); } });
try { const saved = localStorage.getItem('mp_exp_ccy'); if (saved) document.getElementById('exp_ccy').value = saved; } catch { /* no storage */ }
document.getElementById('exp_period').addEventListener('change', e => {
  const today = new Date().toISOString().slice(0, 10);
  if (e.target.value !== 'custom') mpExpSetPeriod(e.target.value, ['year', 'month', 'cmonth'].includes(e.target.value) ? today : document.getElementById('exp_to').value || today);
  if (mpIsSignedIn) mpRenderExpenses();
});
try {
  // '1' / '0': saved when income was a checkbox
  const saved = localStorage.getItem('mp_exp_income');
  document.getElementById('exp_income').value = { 1: 'line', 0: 'off' }[saved] ?? (['off', 'line', 'bars'].includes(saved) ? saved : 'off');
} catch { /* no storage */ }
try { document.getElementById('exp_grouped').checked = localStorage.getItem('mp_exp_grouped') === '1'; } catch { /* no storage */ }
try { document.getElementById('exp_grouped_top').checked = localStorage.getItem('mp_exp_grouped_top') === '1'; } catch { /* no storage */ }
document.getElementById('exp_grouped_top').addEventListener('change', e => {
  mpSave('mp_exp_grouped_top', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderExpenses();
});
document.getElementById('exp_grouped').addEventListener('change', e => {
  mpSave('mp_exp_grouped', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderExpenses();
});
document.getElementById('exp_income').addEventListener('change', e => {
  mpSave('mp_exp_income', e.target.value);
  if (mpIsSignedIn) mpRenderExpenses();
});
for (const id of ['exp_span', 'exp_step']) {
  // the grouping ('by') starts at month every time; the choice is still remembered while the page is open
  try { const saved = id === 'exp_step' ? null : localStorage.getItem('mp_' + id); if (saved) document.getElementById(id).value = saved; } catch { /* no storage */ }
  document.getElementById(id).addEventListener('change', e => {
    mpSave('mp_' + id, e.target.value);
    if (mpIsSignedIn) mpRenderExpenses();
  });
}
document.getElementById('exp_cmp_span').addEventListener('change', () => {
  mpCmpKey = '';
  if (mpIsSignedIn) mpRenderCumulative().catch(() => { /* the chart shows its own note */ });
});
try { const saved = localStorage.getItem('mp_exp_extrapolated'); if (saved) document.getElementById('exp_extrapolated').checked = saved === '1'; } catch { /* no storage */ }
document.getElementById('exp_extrapolated').addEventListener('change', e => {
  mpSave('mp_exp_extrapolated', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderExpenses();
});
try { const saved = localStorage.getItem('mp_exp_spread'); if (saved) document.getElementById('exp_spread').checked = saved === '1'; } catch { /* no storage */ }
document.getElementById('exp_spread').addEventListener('change', e => {
  mpSave('mp_exp_spread', e.target.checked ? '1' : '0');
  if (mpIsSignedIn) mpRenderExpenses();
});
document.getElementById('exp_ccy').addEventListener('change', e => {
  mpSave('mp_exp_ccy', e.target.value);
  if (mpIsSignedIn) mpRenderExpenses();
});
document.getElementById('exp_prev').addEventListener('click', () => { if (mpIsSignedIn) mpExpShift(-1); });
document.getElementById('exp_next').addEventListener('click', () => { if (mpIsSignedIn) mpExpShift(1); });

