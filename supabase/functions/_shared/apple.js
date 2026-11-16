// Apple's purchase history (16.11.2026): the text of reportaproblem.apple.com's
// purchase list, copied from the page as it is (Cmd+A, Cmd+C into a .txt).
// Each purchase there is
//
//   12 Nov 2026                 <- the day it was ordered
//   MQZFTJMF3S                  <- Apple's order ID
//   Total ₺159,99
//   YouTube Premium             <- an item: its title, twice,
//   YouTube Premium
//   YouTube                     <- the app it is in
//   Renews 12 Dec 2026          <- a subscription's period / renewal / "Monthly" (not always)
//   ₺159,99                     <- the item's price, ending the item
//   ...more items, each ending at its price...
//
// (an iCloud+ plan has its period as the title -- "25 Feb 2022 - 25 Mar 2022",
// twice -- and the plan as the one line after it). Prices come as the
// account's store writes them: "₺1.479,99", "9,99 €", "RUB1,234.56",
// "1 690 ₽", "Free". The page's own lines around the list (the header, the
// footer's links) are not purchases and are left out.
//
// Plain JS, no Deno APIs: import-apple-purchases imports it as is and
// tests/apple.test.mjs runs the same file under Node.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_RE = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/;
const PERIOD_RE = /^(\d{1,2} [A-Za-z]+\.? \d{4} - \d{1,2} [A-Za-z]+\.? \d{4}|(Renews|Renewed|Expires|Expired)\b.*)$/;
const CADENCE_RE = /^(Weekly|Monthly|Every \d+ Months|Quarterly|Yearly|Annual|Annually)$/i;

const clean = s => String(s ?? '').replace(/[‎‏﻿]/g, '').replace(/[  ]/g, ' ').trim();

export function appleDay(s) {
  const m = clean(s).match(DAY_RE);
  const mon = m && MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// A price as the store writes it: { value, currency }, or null when the line isn't one.
export function applePrice(s) {
  const t = clean(s);
  if (t === 'Free') return { value: 0, currency: null };
  let m;
  if ((m = t.match(/^₺\s?([\d.]+(?:,\d{1,2})?)$/))) return { value: Number(m[1].replace(/\./g, '').replace(',', '.')), currency: 'TRY' };
  if ((m = t.match(/^([\d.]+(?:,\d{1,2})?)\s?€$/)) || (m = t.match(/^€\s?([\d.]+(?:,\d{1,2})?)$/))) return { value: Number(m[1].replace(/\./g, '').replace(',', '.')), currency: 'EUR' };
  if ((m = t.match(/^RUB\s?([\d,]+(?:\.\d{1,2})?)$/))) return { value: Number(m[1].replace(/,/g, '')), currency: 'RUB' };
  if ((m = t.match(/^([\d ]+(?:,\d{1,2})?)\s?₽$/))) return { value: Number(m[1].replace(/ /g, '').replace(',', '.')), currency: 'RUB' };
  if ((m = t.match(/^\$\s?([\d,]+(?:\.\d{1,2})?)$/))) return { value: Number(m[1].replace(/,/g, '')), currency: 'USD' };
  return null;
}

// Is this text Apple's purchase history?
export function isApplePurchaseHistory(text) {
  const head = String(text ?? '').slice(0, 3000);
  return /Report a Problem/.test(head) && /Apple Account/.test(head) && /^Total /m.test(String(text ?? ''));
}

// { orders: [{ orderId, date, currency, total, items: [{ lineNo, title, app, period, price }], warnings }], free }
// -- `free`: the orders of nothing paid (free apps), left out.
export function parseApplePurchases(text) {
  const L = String(text ?? '').split(/\r\n|\r|\n/).map(clean);
  const starts = [];
  for (let i = 0; i + 2 < L.length; i++) {
    if (appleDay(L[i]) && /^[A-Z0-9]{8,20}$/.test(L[i + 1]) && /^Total\b/.test(L[i + 2])) starts.push(i);
  }
  const orders = [];
  let free = 0;
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : L.length;
    const totalP = applePrice(L[s + 2].replace(/^Total\s*/, ''));
    const body = L.slice(s + 3, end).filter(Boolean);
    // items: the lines up to each price; what follows the last price is the page's, not the order's
    const items = [];
    let group = [];
    for (const line of body) {
      const p = applePrice(line);
      if (!p) { group.push(line); continue; }
      const periods = group.filter(g => PERIOD_RE.test(g));
      const cadence = group.filter(g => CADENCE_RE.test(g));
      const texts = group.filter(g => !PERIOD_RE.test(g) && !CADENCE_RE.test(g));
      const title = texts[0] ?? periods[0] ?? '?';
      const app = texts.length >= 2 ? texts[texts.length - 1] : null;
      // the iCloud+ kind: the period is the title, so the item is the line after it
      const period = texts.length === 1 && periods.length ? periods[0] : periods[0] ?? null;
      items.push({ lineNo: items.length + 1, title, app: app && app !== title ? app : null,
        period: [cadence[0], period].filter(Boolean).join(' · ') || null, price: p.value, currency: p.currency });
      group = [];
    }
    const total = totalP?.value ?? NaN;
    if (!(total > 0)) { free++; return; }
    const currency = totalP.currency || items.find(i => i.currency)?.currency || null;
    const warnings = [];
    const sum = Math.round(items.reduce((a, i) => a + i.price, 0) * 100) / 100;
    if (Math.abs(sum - total) >= 0.005) warnings.push(`items add up to ${sum.toFixed(2)}, the total is ${total.toFixed(2)}`);
    // a free item that came with paid ones (a game's free add-ons) is no part of the payment
    const paid = items.filter(i => i.price > 0).map((i, n) => ({ ...i, lineNo: n + 1 }));
    orders.push({ orderId: L[s + 1], date: appleDay(L[s]), currency, total, items: paid, warnings });
  });
  return { orders, free };
}
