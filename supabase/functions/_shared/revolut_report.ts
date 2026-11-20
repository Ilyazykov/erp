// Revolut's combined report of every account (the app: Statements -> "all
// accounts", one CSV of sections): the current accounts' transactions by day
// (no time) with each account's running and closing balance, the funds'
// daily returns, and the metal purchases to the millisecond. sync-openbanking
// ({"action": "revolut_report"}) takes the current accounts' rows as the
// Open Banking API's are taken -- checked against the statement, written only
// where neither the statement nor the API has them -- and the metal
// purchases' time onto the rows that have none.

export type ReportRow = { day: string; desc: string; category: string; amount: number; balance: number | null };
export type ReportAccount = { currency: string; closing: number | null; rows: ReportRow[] };
export type ReportMetal = { at: string; metal: string; units: number; value: number; currency: string };
// a brokerage (Invest) deal, in the Invest statement's own columns -- the
// report's Investment Services section, empty until the deal settles: filled
// in by hand from the app meanwhile (20.11.2026, VWCE bought at 21:12)
export type ReportInvest = { at: string; ticker: string; type: string; quantity: number; price: number; total: number; currency: string };
export type RevolutReport = { from: string; to: string; accounts: ReportAccount[]; metals: ReportMetal[]; invest: ReportInvest[] };

// RFC 4180: quoted cells may hold commas and doubled quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const SYMBOL_CCY: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '₪': 'ILS' };
// "-€3,800.00", "$238.00", "0.00 AED", "₪0.00" -> a number, the sign kept
function money(s: string): number | null {
  const t = (s ?? '').trim();
  if (!t || !/\d/.test(t)) return null;
  const n = Number(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (t.includes('-') ? -n : n) : null;
}
function currencyOf(s: string): string {
  const t = (s ?? '').trim();
  const sym = Object.keys(SYMBOL_CCY).find(k => t.includes(k));
  return sym ? SYMBOL_CCY[sym] : (t.match(/\b([A-Z]{3})\b/)?.[1] ?? '');
}
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
// "Nov 5, 2026" -> "2026-11-05"
function dayOf(s: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec((s ?? '').trim());
  return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null;
}

export function isRevolutReport(text: string): boolean {
  return /^﻿?"?Current Accounts Summaries"?,/.test(text) && /Current Accounts Transaction Statements/.test(text);
}

export function parseRevolutReport(text: string): RevolutReport {
  const rows = parseCsv(text);
  const accounts = new Map<string, ReportAccount>();
  const acc = (ccy: string) => {
    if (!accounts.has(ccy)) accounts.set(ccy, { currency: ccy, closing: null, rows: [] });
    return accounts.get(ccy)!;
  };
  const metals: ReportMetal[] = [];
  const invest: ReportInvest[] = [];
  let investHeader = false;
  let part = '', ccy = '', daysOwned = 0, to = '';
  let col: { amount: number; balance: number; fee: number } | null = null;
  let metalHeader = false;
  for (const r of rows) {
    const c0 = (r[0] ?? '').trim();
    if (/^(Current Accounts Summaries|Current Accounts Transaction Statements|Savings Accounts|Flexible Cash Funds|Investment Services|Crypto|Commodity)/.test(c0)
      && !/^Flexible Cash Funds\s+\(/.test(c0)) { part = c0; ccy = ''; col = null; metalHeader = false; investHeader = false; continue; }
    const head = /^Personal Account \(([A-Z]{3})\)$/.exec(c0);
    if (head) { ccy = head[1]; col = null; continue; }
    if ((r[2] ?? '').trim() === 'Days owned (in selected period)') daysOwned = Math.max(daysOwned, Number(r[3]) || 0);
    for (const cell of r.slice(0, 2)) { const d = dayOf(cell); if (d && d > to) to = d; }

    if (part === 'Current Accounts Summaries' && ccy && (r[2] ?? '').trim() === 'Closing balance') acc(ccy).closing = money(r[3]);
    if (part === 'Current Accounts Transaction Statements' && ccy) {
      if (c0 === 'Date') {
        // a foreign account's amounts come twice -- its own, then in euros: the first of each
        col = { amount: r.indexOf('Money in/out'), balance: r.indexOf('Balance'), fee: r.indexOf('Fees') };
        continue;
      }
      const day = dayOf(c0);
      if (day && col) {
        const amount = money(r[col.amount]);
        if (amount === null) continue;
        const fee = col.fee >= 0 ? (money(r[col.fee]) ?? 0) : 0;
        acc(ccy).rows.push({ day, desc: (r[1] ?? '').trim(), category: (r[2] ?? '').trim(),
          amount: Number((amount - Math.abs(fee)).toFixed(8)), balance: col.balance >= 0 ? money(r[col.balance]) : null });
      }
    }
    // Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate
    // 2026-11-20T17:12:00Z,VWCE,BUY - MARKET,6.28140703,EUR 159.20,EUR 1000,EUR,1.0000
    if (part === 'Investment Services Transaction Statements') {
      if (c0 === 'Date' && (r[1] ?? '').trim() === 'Ticker') { investHeader = true; continue; }
      if (investHeader && /^\d{4}-\d{2}-\d{2}T/.test(c0)) {
        const num = (x: string) => Number((x ?? '').replace(/[A-Z]{3}/g, '').replace(/,/g, '').trim());
        const t = { at: c0, ticker: (r[1] ?? '').trim().toUpperCase(), type: (r[2] ?? '').trim().toUpperCase(), quantity: num(r[3]),
          price: num(r[4]), total: num(r[5]), currency: (r[6] ?? '').trim().toUpperCase() };
        if (t.ticker && /^(BUY|SELL)\b/.test(t.type) && t.quantity > 0 && t.price > 0 && t.currency) invest.push(t);
        if (c0.slice(0, 10) > to) to = c0.slice(0, 10);
      }
    }
    if (part.startsWith('Commodity')) {
      if (c0 === 'on Purchase date') { metalHeader = true; continue; }
      if (metalHeader && /^\d{4}-\d{2}-\d{2}T/.test(c0)) {
        const value = money(r[4]);
        if (value !== null) metals.push({ at: c0, metal: (r[1] ?? '').trim().toUpperCase(), units: Number(r[2]), value, currency: currencyOf(r[4]) });
        if (c0.slice(0, 10) > to) to = c0.slice(0, 10);
      }
    }
  }
  const from = to && daysOwned
    ? new Date(Date.parse(`${to}T00:00:00Z`) - (daysOwned - 1) * 86400000).toISOString().slice(0, 10) : '';
  return { from, to, accounts: [...accounts.values()], metals, invest };
}
