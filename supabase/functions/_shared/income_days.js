// Income over the days it was earned in -- mpExpIncomeDays of index.html,
// copied as is (tests/charts.test.mjs checks the two are the same text): the
// edge function month_totals runs it to sum the income by month for the
// "Over time" chart (month_totals, migration ...190), so the server's months
// are the page's. Plain JS, no Deno APIs.

// rows: [{day, account, category, usd, eur, rub}] -- each source (account and
// category) is spread on its own, so the month's sum is kept per source
// -> [{month, category, account, usd, eur, rub}]
export function incomeMonthTotals(rows) {
  const bySource = new Map();
  for (const r of rows) {
    const k = r.account + '\u0000' + r.category;
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(r);
  }
  const out = new Map();
  for (const list of bySource.values()) {
    const { account, category } = list[0];
    // in each currency every payment at its own day's rate: the page divides
    // a day's share by the rate of the day it was paid -- the same thing
    for (const ccy of ['usd', 'eur', 'rub']) {
      const days = mpExpIncomeDays(list.map(r => ({ day: r.day, account: r.account, category: r.category, usd: r[ccy] })));
      for (const d of days) {
        const month = d.day.slice(0, 7) + '-01';
        const k = month + '\u0000' + account + '\u0000' + category;
        if (!out.has(k)) out.set(k, { month, category, account, usd: null, eur: null, rub: null });
        const o = out.get(k);
        o[ccy] = (o[ccy] || 0) + d.usd;
      }
    }
  }
  return [...out.values()];
}

export function mpExpIncomeDays(rows) {
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
