// My Portfolio: the Supabase client, sign-in, the statement / export import
// (any file, its kind detected) and the panels of what was uploaded and when.

// ---- My Portfolio (Supabase auth only for now) ----
const SUPABASE_URL = 'https://xdltomehejjtgzdxbiyx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_C21SGa0MVRBIUg7RG0zpNA_bk0k_Khr';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

document.getElementById('btn_login').addEventListener('click', async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await sb.auth.signOut();
  } else {
    await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
  }
});

// Detects which of the importable CSV shapes a file is, from its header
// row alone -- no user-facing "what kind of file is this" picker needed.
// Each source has a header distinct enough to tell apart:
//   - Snowball broker export starts with "Event,Date,Symbol,..."
//   - Revolut account statement starts with "Type,Product,Started Date,..."
//   - Revolut Flexible Cash Funds statement starts with "Date,Description,"
//     followed by a quoted "Value, <CCY>" column
//   - Revolut Instant Access Savings statement also starts with
//     "Date,Description," but followed by "Interest rate (..." instead --
//     checked first since both share the "Date,Description," prefix.
//   - Bank of Cyprus "Transaction History" export starts with a few
//     metadata lines (Period:, Account number:, ...) before its own
//     header row "Date,Description,Transaction type,..." -- checked
//     against every line up front (not just the first), since the real
//     header isn't on line 1 the way the other sources' headers are.
//   - This project's own combined Raiffeisen Bank Serbia CSV (built by
//     hand from PDF statements -- Raiffeisen has no CSV export) starts
//     with "account_number,currency,date_executed,..."
//   - Bybit Data Export transaction logs (Funding / Unified Trading
//     "Account Change Details") start with a "UID: <uid>,Company Name:"
//     line, then "Uid,Date & Time(UTC),Coin,..." or "Uid,Currency,Contract,..."
//   - Crypto.com App export starts with "Timestamp (UTC),Transaction
//     Description,Currency,Amount,To Currency,..."
//   - IBKR Activity Statement (CSV) starts with "Statement,Header,Field
//     Name,Field Value"
//   - Wise balance statement (one file per currency balance) starts with
//     "\"TransferWise ID\",Date,\"Date Time\",Amount,Currency,..."
//   - Freedom24 broker report downloaded as JSON (Кабинет -> Отчеты
//     брокера): a JSON object whose companyName is "Freedom24"
//   - Sber broker report (HTML, one per month): "Отчет брокера" with a
//     "Портфель Ценных Бумаг" table
//   - Revolut brokerage (Invest) statement starts with "Date,Ticker,Type,
//     Quantity,Price per share,Total Amount,Currency,FX Rate"
//   - Revolut crypto account statement starts with "Symbol,Type,Quantity,
//     Price,Value,Fees,Date"
//   - Binance "Export Transaction Records" starts with "User ID,Time,Account,
//     Operation,Coin,Change,Remark"; its deposit / withdrawal history
//     exports ("Time,Coin,Network,Amount,...") only repeat rows of it
//   - This project's own Telegram Wallet CSV (built from the Wallet app's
//     scraped history -- Wallet has no export) starts with
//     "timestamp_utc,section,title,amount,currency,status"
//   - This project's own generic bank CSV (built from PDF statements of
//     banks with no CSV export -- Yandex Bank, T-Bank; the bank's name is
//     a column) starts with "bank,account_number,product,..."
//   - This project's own broker-operations CSV (trades of a broker with no
//     downloadable report -- Alfa-Investments) starts with
//     "broker,account_number,date,operation,..."
function mpDetectCsvKind(headerLine, fullText) {
  const h = headerLine.trim();
  if (/^Event,Date,Symbol/i.test(h)) return 'snowball';
  if (/^Type,Product,Started Date/i.test(h)) return 'revolut_account';
  // Revolut's combined report of all accounts: the days after the statement,
  // as the Open Banking rows are (sync-openbanking, _shared/revolut_report.ts)
  if (/^﻿?"?Current Accounts Summaries"?,/.test(h)) return 'revolut_report';
  if (/^Date,Description,Interest rate/i.test(h)) return 'revolut_deposit';
  if (/^Date,Description,"?Value,/i.test(h)) return 'revolut_fund';
  if (/^Date,Description,Transaction type,/im.test(fullText)) return 'boc_account';
  if (/^account_number,currency,date_executed,/i.test(h)) return 'raiffeisen_account';
  if (/^bank,account_number,product,/i.test(h)) return 'bank_csv';
  // items within a purchase (migration ...179, design: docs/items-design.md,
  // not tracked in git) -- a receipt photo turned into this CSV by an LLM
  // outside this app; see the upload instructions next to the file picker
  if (/^﻿?receipt,date,/i.test(h)) return 'receipt_csv';
  if (/^\uFEFF?თარიღი,დანიშნულება,/.test(h) && /^Date,Description,Additional Information,Paid Out,Paid In,Balance,/m.test(fullText)) return 'tbc_account';
  if (/^\uFEFF?broker,account_number,date,operation,/i.test(h)) return 'broker_csv';
  if (/^UID:\s*\d+,Company Name:/i.test(h)
      && /^Uid,(Date & Time\(UTC\),Coin|Currency,Contract),/m.test(fullText)) return 'bybit_log';
  if (/^\uFEFF?Timestamp \(UTC\),Transaction Description,Currency,Amount,To Currency,/i.test(h)) return 'cryptocom';
  if (/^timestamp_utc,section,title,amount,currency,status$/i.test(h)) return 'telegram_wallet';
  if (/^\uFEFF?"?TransferWise ID"?,Date,"?Date Time"?,Amount,Currency,/i.test(h)) return 'wise';
  if (/^\uFEFF?Statement,Header,Field Name,Field Value/i.test(h)) return 'ibkr';
  if (/^\uFEFF?User ID,Time,Account,Operation,Coin,Change,Remark/i.test(h)) return 'binance';
  if (/^\uFEFF?Symbol,Type,Quantity,Price,Value,Fees,Date/i.test(h)) return 'revolut_crypto';
  if (/^\uFEFF?\{/.test(h) && /"companyName"\s*:\s*"Freedom24"/.test(fullText)) return 'freedom24_json';
  // a Ziraat PDF statement read on the page (mpZiraatPdfRead)
  if (/^\{"ziraat_pdf":true/.test(h)) return 'ziraat_pdf';
  if (/^\uFEFF?Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency/i.test(h)) return 'revolut_invest';
  if (/<html/i.test(fullText.slice(0, 2000)) && /Отчет брокера/.test(fullText) && /Сделки купли\/продажи ценных бумаг|Портфель Ценных Бумаг/.test(fullText)) return 'sber_broker';
  if (/^\uFEFF?Time,Coin,Network,Amount,(Fee,)?Address,TXID,Status/i.test(h)) return 'binance_aux';
  return null;
}

// Any number of files (multi-select or drag & drop) go into a queue and are
// imported one by one, one status line per file; files added while a queue
// is running join its end.
const mpImportQueue = [];
let mpImportRunning = false;
let mpImportedSinceRefresh = false;   // a file went in since the last capital-rebuild request
// A PDF's text as rows (14.11.2026, Wolt's receipts): pdf.js, loaded the first time
// one's needed; per page, the pieces on one line by their height, left to right, a
// piece close to the one before it joined to it -- [{ cells: [{ s, x }] }]
async function mpPdfRows(file) {
  if (!window.pdfjsLib) {
    await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = ok; s.onerror = () => fail(new Error('pdf.js did not load')); document.head.appendChild(s); });
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const byY = new Map();
    for (const it of (await (await pdf.getPage(p)).getTextContent()).items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ s: it.str.trim(), x: it.transform[4], end: it.transform[4] + (it.width || 0) });
    }
    // pieces a point or two apart in height are one line (Raiffeisen's statements set a
    // row's description a point above its dates): the lines, each its pieces
    const lines = [];
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      const last = lines[lines.length - 1];
      if (last && last.y - y <= 2) last.items.push(...byY.get(y));
      else lines.push({ y, items: [...byY.get(y)] });
    }
    for (const { y, items } of lines) {
      const cells = [];
      for (const it of items.sort((a, b) => a.x - b.x)) {
        const last = cells[cells.length - 1];
        if (last && it.x - last.end < 4) { last.s += (it.x - last.end > 0.5 ? ' ' : '') + it.s; last.end = it.end; }
        else cells.push({ ...it });
      }
      rows.push({ cells, y });
    }
  }
  return rows;
}
// Raiffeisen Bank Serbia's monthly statement ("Izvod po tekućem / deviznom računu", PDF,
// 15.11.2026) as import-raiffeisen-statement's CSV: the rows of its period, uploaded with
// ?from=&to= so only those days are replaced. A transaction starts at a row with its two
// dates (received, executed) and has its amounts on that row by their column (ref.
// currency, debit "Isplata", credit "Uplata", balance "Stanje"); the rows under it, as far
// as the next one, carry the rest of its description and the original amount / rate. Each
// row's balance is checked against the one before it and the "Prethodno stanje" (opening):
// a statement read wrong is left out, not loaded.
function mpIsRaifPdf(rows) {
  const t = rows.slice(0, 40).map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  return /Raiffeisen bank/i.test(t) && /Izvod po (tekućem|deviznom) računu/i.test(t);
}
function mpRaifPdfCsv({ name, rows }) {
  const num = s => Number(String(s).replace(/,/g, ''));
  const isNum = s => /^-?[\d,]*\d\.\d{2}$/.test(s);
  const iso = d => d.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
  const txt = rows.map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  const account = txt.match(/\b(\d{18})\b/)?.[1];
  const from = txt.match(/Od (\d{2}\.\d{2}\.\d{4})/)?.[1], to = txt.match(/do (\d{2}\.\d{2}\.\d{4})/)?.[1];
  if (!account || !from || !to) return { error: 'Raiffeisen statement: its account or period not found' };
  const out = [];
  let ccy = null, opening = null, bal = null, cur = null;
  // a description piece, the original amount ("18.00 EUR") cut out of it where the two ran together
  const descPart = (t, x) => {
    const m = x.s.match(/^(.*?)\s*([\d,]+\.\d{2}) ([A-Z]{3})\b\s*(.*)$/);
    if (m && x.x < 375) { t.orig = m[2]; t.origCcy = m[3]; return [m[1], m[4]].filter(Boolean).join(' '); }
    return x.s;
  };
  const close = () => {
    if (!cur) return;
    const desc = cur.desc.join(' ').replace(/\s+/g, ' ').trim();
    out.push({ ...cur, desc });
    cur = null;
  };
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].cells, s0 = c[0]?.s || '';
    if (s0 === 'Valuta:') { close(); ccy = c[1]?.s; opening = null; bal = null; continue; }
    // the opening balance: a number at the right on the "Prethodno stanje" row or the one above it
    if (c.some(x => x.s === 'Prethodno stanje:')) {
      const here = [...c, ...(rows[i - 1]?.cells || [])].find(x => x.x >= 540 && isNum(x.s));
      if (here) { opening = num(here.s); bal = opening; }
      continue;
    }
    if (c.length >= 2 && DATE.test(s0) && c[0].x < 60 && DATE.test(c[1].s) && c[1].x < 130) {
      close();
      // the amounts' column by their right edge (they're set flush right: a long one starts to the left of its column)
      const at = (lo, hi) => c.find(x => x.end > lo && x.end <= hi && isNum(x.s))?.s;
      cur = { received: iso(s0), executed: iso(c[1].s), ccy,
        card: c.find(x => x.x >= 130 && x.x < 185 && /^\d{4}$/.test(x.s))?.s || '',
        desc: [], ref: at(330, 380), debit: at(440, 500), credit: at(500, 545), balance: at(545, 700), orig: '', origCcy: '', rate: '' };
      cur.desc = c.filter(x => x.x >= 185 && x.x < 330).map(x => descPart(cur, x));
      for (const x of c.filter(x => x.x >= 375 && x.x < 440)) {
        const o = x.s.match(/^([\d,]+\.\d{2}) ([A-Z]{3})$/); if (o) { cur.orig = o[1]; cur.origCcy = o[2]; }
      }
      continue;
    }
    // under a transaction: its description's next lines, the original amount, the rate; anything
    // else (the closing balance, "STANJE", the notes at the end, a page's header) ends it
    if (cur && c.length && c.every(x => x.x >= 185) && !c.some(x => /Izvod|^Od \d|^do \d|^\d{18}$/.test(x.s)) && !c.every(x => x.x >= 540)) {
      for (const x of c) {
        const o = x.s.match(/^([\d,]+\.\d{2}) ([A-Z]{3})$/), k = x.s.match(/^Kurs:\s*([\d.,]+)?$/);
        if (x.x >= 375 && x.x < 440 && o) { cur.orig = o[1]; cur.origCcy = o[2]; }
        else if (k) cur.rate = k[1] || '';
        else if (x.x < 330) cur.desc.push(descPart(cur, x));
      }
      continue;
    }
    close();
  }
  close();
  if (!out.length) return { error: 'Raiffeisen statement: no transactions in it' };
  // each balance from the one before (the opening first): the statement was read right
  let prev = null, prevCcy = null;
  for (const t of out) {
    if (!t.ccy || t.balance == null || (t.debit == null && t.credit == null)) return { error: `Raiffeisen statement: a row of ${t.executed} not read whole` };
    if (t.ccy !== prevCcy) { prev = null; prevCcy = t.ccy; }
    const start = prev ?? (t === out.find(x => x.ccy === t.ccy) ? opening : null);
    if (start != null && Math.abs(start + num(t.credit || 0) - num(t.debit || 0) - num(t.balance)) > 0.005) {
      return { error: `Raiffeisen statement: the balance after the row of ${t.executed} (${t.desc}) doesn't follow from the one before -- not loaded` };
    }
    prev = num(t.balance);
  }
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = ['account_number,currency,date_executed,date_received,card_number,description,debit,credit,balance,amount_orig_value,amount_orig_currency,exchange_rate,amount_ref_currency,source_file',
    ...out.map(t => [account, t.ccy, t.executed, t.received, t.card, t.desc || '(no description in statement)', num(t.debit || 0), num(t.credit || 0), num(t.balance),
      t.orig ? num(t.orig) : 0, t.origCcy, t.rate ? num(t.rate) : 0, num(t.ref || 0), name].map(q).join(','))].join('\n') + '\n';
  return { csv, account, from: iso(from), to: iso(to), currencies: [...new Set(out.map(t => t.ccy))], count: out.length };
}
// Alfa-Bank's account statement ("Выписка по счету", PDF, 16.11.2026) as this project's bank
// CSV (statements/alfa/alfa_*.csv, import-bank-csv): the current, the salary and the
// daily-balance savings account ("Альфа-Счёт на ежедневный остаток" -- savings, a trade
// row). A transaction starts at a row with its posting day and operation code, its amount
// at the right; the rows just under it carry the rest of its description, joined with a
// space (as the CSVs made by hand from these PDFs have it, so the keys match). "HOLD" rows
// (an unconfirmed operation, 0.00) are left out. The sum of the rows must take the opening
// balance to the closing one, and match the statement's own in and out totals: a statement
// read wrong is left out, not loaded. The CSV's name carries the statement's period (the
// freshness table's "Statements to").
function mpIsAlfaPdf(rows) {
  const t = rows.slice(0, 30).map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  return /Выписка по сч[её]ту/.test(t) && /Номер сч[её]та\s+\d{20}/.test(t) && rows.some(r => r.cells.some(c => /АЛЬФА-БАНК/.test(c.s)));
}
// Alfa-Investments' "Инвестиционный отчёт" (PDF): the portfolio's value, shares and return
// -- no deals or money movements in it (those come from the broker report, XML)
function mpIsAlfaInvestReport(rows) {
  const t = rows.slice(0, 12).map(r => r.cells.map(c => c.s).join(' ')).join(' ');
  return /Инвестиционный/.test(t) && /отч[её]т/.test(t) && /Клиент/.test(t) && /Период/.test(t);
}
function mpAlfaPdfCsv({ name, rows }) {
  const money = s => { const m = String(s).replace(/[\s ]/g, '').match(/^(-?\d+(?:,\d{1,2})?)([A-Z]{3})?$/); return m ? Number(m[1].replace(',', '.')) : null; };
  const iso = d => d.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
  const lines = rows.map(r => r.cells.map(c => c.s).join(' '));
  const txt = lines.join('\n');
  const account = txt.match(/Номер сч[её]та\s+(\d{20})/)?.[1];
  const period = txt.match(/За период с (\d{2}\.\d{2}\.\d{4}) по (\d{2}\.\d{2}\.\d{4})/);
  const ccyRaw = txt.match(/Валюта сч[её]та\s+([A-Z]{3})/)?.[1];
  const type = txt.match(/Тип сч[её]та\s+([^\n]*?)(?:\s+(?:Поступления|Расходы|Входящий|Исходящий)\b|$)/m)?.[1]?.trim() || '';
  const total = label => { const m = txt.match(new RegExp(`${label}\\s+(-?[\\d\\s\\u00a0]+,\\d{2})\\s*[A-Z]{3}`)); return m ? money(m[1]) : null; };
  const opening = total('Входящий остаток'), closing = total('Исходящий остаток'), inflow = total('Поступления'), outflow = total('Расходы');
  if (!account || !period || !ccyRaw || opening == null || closing == null) return { error: 'Alfa-Bank statement: its account, period or balances not found' };
  if (/депозит|вклад/i.test(type)) return { error: `Alfa-Bank statement: a deposit ("${type}") -- not read here` };
  const ccy = ccyRaw === 'RUR' ? 'RUB' : ccyRaw;
  const product = /ежедневн|накопит/i.test(type) ? 'savings_account' : 'current_account';
  const from = iso(period[1]), to = iso(period[2]);
  // the transactions: a row with the day (left) and the code, its amount at the right;
  // under it (a few points down, the same page) the rest of its description
  const out = [];
  let cur = null, prevY = null;
  for (const { cells: c, y } of rows) {
    const s0 = c[0]?.s || '';
    const amountCell = c.find(x => x.x >= 440 && money(x.s) != null && /[A-Z]{3}$/.test(x.s.trim()));
    if (DATE.test(s0) && c[0].x < 60 && c[1] && c[1].x < 180 && amountCell) {
      cur = { date: iso(s0), code: c[1].s, desc: c.filter(x => x.x >= 180 && x !== amountCell).map(x => x.s), amount: money(amountCell.s) };
      out.push(cur);
      prevY = y;
      continue;
    }
    if (cur && prevY != null && prevY - y > 0 && prevY - y <= 14 && c.length && c.every(x => x.x >= 180 && x.x < 440)) {
      cur.desc.push(...c.map(x => x.s));
      prevY = y;
      continue;
    }
    cur = null; prevY = null;   // HOLD, the totals, the signature, a page's foot: the transaction's over
  }
  const r2 = x => Math.round(x * 100) / 100;
  const sum = r2(out.reduce((a, t) => a + t.amount, 0));
  if (Math.abs(opening + sum - closing) > 0.005) {
    return { error: `Alfa-Bank statement: the rows (${sum}) don't take the opening balance ${opening} to the closing ${closing} -- not loaded` };
  }
  const ins = r2(out.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0)), outs = r2(-out.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0));
  if ((inflow != null && Math.abs(ins - inflow) > 0.005) || (outflow != null && Math.abs(outs - outflow) > 0.005)) {
    return { error: `Alfa-Bank statement: in ${ins} / out ${outs} read, the statement says ${inflow} / ${outflow} -- not loaded` };
  }
  // the statement's order, by day (stable); the balance after each
  out.sort((a, b) => a.date.localeCompare(b.date));
  let bal = opening;
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = ['bank,account_number,product,currency,date,time,card,description,amount,balance,operation_code,source_file',
    ...out.map(t => {
      bal = r2(bal + t.amount);
      return ['Alfa', account, product, ccy, t.date, '', '', t.desc.join(' ').replace(/\s+/g, ' ').trim() || '(no description in statement)',
        t.amount.toFixed(2), bal.toFixed(2), t.code, name].map(q).join(',');
    })].join('\n') + '\n';
  return { csv, account, product, type, currency: ccy, from, to, count: out.length, closing };
}
// T-Bank's «Справка о движении средств» / "Bank Statement" (PDF, Russian or English, 21.11.2026)
// as this project's bank CSV (statements/tbank/tbank_*.csv, import-bank-csv): the debit and the
// credit card, the current accounts, the savings account and the deposit (its accounts, one per
// currency). A transaction starts at a row with its two days (made, processed) and its amounts,
// the times on the row under it, the rest of its description on the rows below (a page break
// included). The statement's own in and out totals must match the rows: a statement read wrong
// is left out, not loaded. The metal account (grams, not money) is not read here.
function mpIsTbankPdf(rows) {
  const t = rows.slice(0, 25).map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  return /«ТБАНК»|^TBANK$/m.test(t) && /Справка о движении средств|Bank Statement/.test(t) && /Номер договора|Contract number/.test(t);
}
// a statement's figures: { kind: 'card' | 'deposit', contract, accounts: [{ account, currency }],
// from, to, opened, txs: [{ date, time, amount, currency, origAmount, origCurrency, desc, card }] }
// (txs as the statement lists them, the newest first) or { error }
function mpTbankPdfParse({ rows }) {
  const iso = d => d.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const num = s => { const m = String(s ?? '').replace(/[\s ]/g, '').match(/^([+-]?\d+(?:[.,]\d{1,2})?)/); return m ? Number(m[1].replace(',', '.')) : null; };
  const SIGN = { '₽': 'RUB', '$': 'USD', '€': 'EUR', '¥': 'CNY', RUR: 'RUB' };
  const ccyOf = s => { const m = String(s ?? '').trim().match(/([₽$€¥]|[A-Z]{3})$/); return m ? SIGN[m[1]] || m[1] : null; };
  const DATE = /^\d{2}\.\d{2}\.\d{4}$/, TIME = /^\d{2}:\d{2}(:\d{2})?$/;
  const txt = rows.map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  const contract = txt.match(/(?:Номер договора|Contract number):\s*(\d+)/)?.[1];
  const period = txt.match(/(?:за период с|for the period from) (\d{2}\.\d{2}\.\d{4}) (?:по|to) (\d{2}\.\d{2}\.\d{4})/);
  if (!contract || !period) return { error: 'T-Bank statement: its contract or period not found' };
  const opened = txt.match(/(?:Дата заключения договора|Date of conclusion of the contract):\s*(\d{2}\.\d{2}\.\d{4})/)?.[1] || '';
  const total = label => { const m = txt.match(new RegExp(`(?:${label}):\\s*([\\d\\s\\u00a0]*\\d,\\d{2})`)); return m ? num(m[1]) : null; };
  const inflow = total('Пополнения|Replenishment'), outflow = total('Расходы|Expenses');
  const txs = [];
  const depAccounts = [...txt.matchAll(/^(\d{20}) ([A-Z]{3})$/gm)].map(m => ({ account: m[1], currency: m[2] === 'RUR' ? 'RUB' : m[2] }));
  const kind = depAccounts.length ? 'deposit' : 'card';
  let accounts;
  if (kind === 'deposit') {
    accounts = depAccounts;
    let cur = null;
    for (const { cells: c } of rows) {
      const line = c.map(x => x.s).join(' ');
      if (/^(Пополнения|Replenishment):/.test(line)) break;
      const at = (a, b) => c.filter(x => x.x >= a && x.x < b);
      const m = c[0] && c[0].x < 120 && c[0].s.match(/^(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2}(?::\d{2})?)$/);
      if (m) {
        const orig = at(150, 290)[0]?.s;
        cur = { date: iso(m[1]), time: m[2], amount: num(orig), currency: ccyOf(orig), origAmount: num(orig), origCurrency: ccyOf(orig), desc: at(390, 999).map(x => x.s), card: '' };
        if (cur.amount == null || !cur.currency) return { error: `T-Bank statement: a row of ${m[1]} without its amount -- not loaded` };
        txs.push(cur);
        continue;
      }
      if (cur && c.length && c.every(x => x.x >= 390)) cur.desc.push(...c.map(x => x.s));
    }
  } else {
    const account = txt.match(/(?:Номер лицевого сч[её]та|Personal account number):\s*(\d{20})/)?.[1];
    if (!account) return { error: 'T-Bank statement: its account number not found' };
    const BY_CODE = { 810: 'RUB', 643: 'RUB', 840: 'USD', 978: 'EUR', 156: 'CNY' };
    let cur = null;
    for (const { cells: c } of rows) {
      const line = c.map(x => x.s).join(' ');
      if (/^(Пополнения|Replenishment):/.test(line)) break;
      const at = (a, b) => c.filter(x => x.x >= a && x.x < b);
      if (c[0] && DATE.test(c[0].s) && c[0].x < 100 && c[1] && DATE.test(c[1].s) && c[1].x < 190) {
        const orig = at(190, 290)[0]?.s, own = at(290, 385)[0]?.s;
        cur = { date: iso(c[0].s), time: '', amount: num(own), currency: ccyOf(own), origAmount: num(orig), origCurrency: ccyOf(orig), desc: at(385, 495).map(x => x.s), card: at(495, 999)[0]?.s || '' };
        if (cur.amount == null || cur.origAmount == null) return { error: `T-Bank statement: a row of ${c[0].s} without its amount -- not loaded` };
        txs.push(cur);
        continue;
      }
      if (cur && !cur.time && c[0] && TIME.test(c[0].s) && c[0].x < 100) { cur.time = c[0].s; cur.desc.push(...at(385, 495).map(x => x.s)); continue; }
      // the rest of the description -- on the next page too (the foot and the column heads between)
      if (cur && c.length && c.every(x => x.x >= 385 && x.x < 495)) cur.desc.push(...c.map(x => x.s));
    }
    accounts = [{ account, currency: BY_CODE[account.slice(5, 8)] || txs[0]?.currency || 'RUB' }];
  }
  for (const t of txs) t.desc = t.desc.join(' ').replace(/\s+/g, ' ').trim();
  if (txs.some(t => kind === 'card' && !t.time)) return { error: 'T-Bank statement: a row without its time -- not loaded' };
  const r2 = x => Math.round(x * 100) / 100;
  const ins = r2(txs.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0)), outs = r2(-txs.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0));
  if (inflow == null || outflow == null) return { error: 'T-Bank statement: its in and out totals not found -- not loaded' };
  if (Math.abs(ins - inflow) > 0.005 || Math.abs(outs - outflow) > 0.005) {
    return { error: `T-Bank statement: in ${ins} / out ${outs} read, the statement says ${inflow} / ${outflow} -- not loaded` };
  }
  return { kind, contract, accounts, from: iso(period[1]), to: iso(period[2]), opened, txs, inflow, outflow };
}
// The CSV's product of an account, by its number (the balance-sheet account): null -- not read here
function mpTbankProduct(account) {
  if (/^455/.test(account)) return 'credit_card';
  if (/^42301/.test(account)) return 'savings_account';
  if (/^423/.test(account)) return 'term_deposit';
  if (/^40817810/.test(account)) return 'debit_card';
  if (/^(40817|47411)/.test(account)) return 'current_account';
  return null;
}
// A Russian statement's description in the words the English one has (the rows loaded so far
// are mostly from English statements; the categories go by these words). "Перевод себе" says
// nothing of where from: the contract whose statement, uploaded with it, has the money going
// out to this one within two minutes. Anything else stays as the statement has it.
function mpTbankDescription(t, contract, outgoing, used) {
  const d = t.desc;
  let m;
  if ((m = d.match(/^Внутренний перевод на договор (\d+)$/))) return `Internal transfer to contract ${m[1]}`;
  if ((m = d.match(/^Внутрибанковский перевод с договора (\d+)$/))) return `Intrabank transfer from contract ${m[1]}`;
  if ((m = d.match(/^Внешний перевод по номеру телефона (\+\d+)$/))) return `External transfer by phone number ${m[1]}`;
  if ((m = d.match(/^Внешний банковский перевод (?:на )?сч[её]т (.+)$/))) return `External bank transfer to account ${m[1]}`;
  if (/^Проценты на остаток$/.test(d)) return 'Interest on the balance';
  if (/^Проценты по вкладу$/.test(d)) return 'Deposit interest';
  if (/^Вывод средств с брокерского сч[её]та$/.test(d)) return 'Intrabank transfer';
  if (/^Кэшбэк$/.test(d)) return 'Cashback';
  if (/^Перевод себе$/.test(d)) {
    const at = x => Date.parse(`${x.date}T${x.time.slice(0, 5)}:00Z`) / 60000;
    const o = outgoing.find(o => !used.has(o) && o.to === contract && o.from !== contract && Math.abs(o.t.amount + t.amount) < 0.005 && Math.abs(at(o.t) - at(t)) <= 2);
    if (!o) return 'Intrabank transfer';
    used.add(o);
    return `Intrabank transfer from contract ${o.from}`;
  }
  return d;
}
// docs: [{ name, rows }] of T-Bank's statements (mpIsTbankPdf) -> [{ text, file?, checked? }]:
// a bank CSV per account (tbank_<account>_<from>_<to>.csv, the statement's period: the freshness
// table's "Statements to"), a line on each statement. A row already stored (the same account,
// day, time and amount) keeps its stored description -- its key, so it's updated, not doubled,
// and its labels stay; a stored row on the statement's days it no longer has goes
// (import-bank-csv). The balance runs from the stored one before the statement's first day.
async function mpTbankPdfCsvs(docs) {
  const out = [], parsed = [], seen = new Map();
  for (const d of docs) {
    const p = mpTbankPdfParse(d);
    if (p.error) { out.push({ text: `${d.name}: ${p.error}` }); continue; }
    const key = `${p.contract}|${p.from}|${p.to}|${p.txs.length}|${p.inflow}|${p.outflow}`;
    if (seen.has(key)) { out.push({ text: `${d.name}: the same statement as ${seen.get(key)} -- left out.` }); continue; }
    seen.set(key, d.name);
    parsed.push({ ...p, name: d.name });
  }
  const outgoing = parsed.flatMap(p => p.txs.filter(t => t.amount < 0)
    .map(t => ({ t, from: p.contract, to: t.desc.match(/^(?:Внутренний перевод на договор|Internal transfer to contract) (\d+)$/)?.[1] }))
    .filter(o => o.to));
  const used = new Set();
  for (const p of parsed) for (const t of p.txs) t.description = mpTbankDescription(t, p.contract, outgoing, used);
  const r2 = x => Math.round(x * 100) / 100;
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const p of parsed) {
    for (const { account, currency } of p.accounts) {
      const product = mpTbankProduct(account);
      const what = `${p.name}: T-Bank statement, ${product || 'account'} …${account.slice(-4)} ${currency}, ${p.from} – ${p.to}`;
      if (!product) { out.push({ text: `${what}: not a money account (the metal account?) -- not read here, to Claude.` }); continue; }
      // the statement's order is the newest first: the oldest first, by day and time (stable)
      const txs = p.txs.filter(t => t.currency === currency && t.amount !== 0).reverse()
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      if (!txs.length) {
        if (p.kind === 'card') out.push({ text: `${what}: no transactions -- noted as checked to ${p.to}.`, checked: { name: p.name, from: p.from, to: p.to } });
        continue;
      }
      const deposit = product === 'savings_account' || product === 'term_deposit';
      const first = txs[0].date, last = txs[txs.length - 1].date;
      // the rows stored on these days: their keys (account:day:time:description:amount[:dupN])
      const stored = deposit
        ? await mpFetchAll(() => sb.from('trades').select('external_id, ticker, note').eq('external_source', `t_bank_deposit_csv:${account}`)
          .gte('trade_date', first).lte('trade_date', last).order('id'))
        : await mpFetchAll(() => sb.from('bank_transactions').select('external_id, balance_after').eq('external_source', `t_bank_csv:${account}`)
          .gte('tx_date', `${first}T00:00:00Z`).lte('tx_date', `${last}T23:59:59.999Z`).order('id'));
      const ids = stored.map(s => s.external_id.replace(/:dup\d+$/, ''));
      const takenIds = new Set();
      let kept = 0;
      for (const t of txs) {
        const head = `${account}:${t.date}:${t.time}:`, tail = `:${Number(t.amount.toFixed(2))}`;
        const i = ids.findIndex((id, n) => !takenIds.has(n) && id.startsWith(head) && id.endsWith(tail) && id.length > head.length + tail.length);
        if (i < 0) continue;
        takenIds.add(i);
        const desc = ids[i].slice(head.length, -tail.length);
        if (desc !== t.description) kept++;
        t.description = desc;
        t.storedBalance = stored[i].balance_after;
      }
      let depositName = '', replaces = '', bal = 0;
      if (deposit) {
        // the holding's name and the Snowball ticker it replaced: as stored (the rate isn't in the statement)
        const { data: prev } = await sb.from('trades').select('ticker, note').eq('external_source', `t_bank_deposit_csv:${account}`)
          .order('trade_date', { ascending: false }).limit(1);
        const s = prev?.[0];
        depositName = s ? s.ticker.replace(/^(?:DEPOSIT|SAVINGS):T-Bank [A-Z]{3}\s*/, '') : product === 'term_deposit' ? p.opened : '';
        replaces = s?.note?.match(/\[replaces Snowball ([^\]]+)\]/)?.[1] || '';
      } else {
        // the balance: from the first row already stored with one (the stored history's
        // own, its opening debt included), else from the stored row before the first day, else 0
        let sum = 0;
        const anchor = txs.find(t => { sum = r2(sum + t.amount); return t.storedBalance != null; });
        if (anchor) bal = r2(Number(anchor.storedBalance) - sum);
        else {
          const { data: prev, error } = await sb.from('bank_transactions').select('balance_after').eq('external_source', `t_bank_csv:${account}`)
            .lt('tx_date', `${first}T00:00:00Z`).not('balance_after', 'is', null).order('tx_date', { ascending: false }).limit(1);
          if (error) { out.push({ text: `${what}: ${error.message}` }); continue; }
          bal = Number(prev?.[0]?.balance_after ?? 0);
        }
      }
      const csv = ['bank,account_number,product,currency,date,time,card,description,amount,balance,amount_orig_value,amount_orig_currency,replaces_snowball,deposit_name,source_file',
        ...txs.map(t => {
          bal = r2(bal + t.amount);
          return ['T-Bank', account, product, currency, t.date, t.time, t.card, t.description || '(no description in statement)', t.amount.toFixed(2), deposit ? '' : bal.toFixed(2),
            t.origAmount.toFixed(2), t.origCurrency || currency, replaces, depositName, p.name].map(q).join(',');
        })].join('\n') + '\n';
      out.push({
        text: `${what}: ${txs.length} transaction(s)${kept ? ` (${kept} under the description already stored)` : ''}${deposit ? '' : `, balance after the last ${bal.toFixed(2)}`}.`,
        file: new File([csv], `tbank_${account}_${p.from}_${p.to}.csv`, { type: 'text/csv' }),
      });
    }
  }
  return out;
}
// Sber's statements (PDF, СберБанк Онлайн -> Выписки и справки, Russian or English, 21.11.2026)
// as this project's bank CSV (statements/sber/sber_*.csv, import-bank-csv): the debit card's
// payment account, the credit card, the savings account and a deposit. Every row carries the
// balance after it: each one must follow from the one before, and the period's opening and
// closing balances and in / out totals must match -- a statement read wrong is left out.
// A card statement lists what was processed within its period, under the day each operation was
// made: a day at its edges can have operations that came in another statement -- such a day,
// with stored rows this statement hasn't, is left out (else the upload took them away).
function mpIsSberPdf(rows) {
  const t = rows.slice(0, 8).map(r => r.cells.map(c => c.s).join(' ')).join('\n');
  return /www\.sberbank\.ru/.test(t) && /Выписка по|statement/i.test(t);
}
// { kind: 'card' | 'account', product, account, currency, from, to, opening, closing, inflow,
// outflow, limit, depositType, rate, opened, txs: [{ date, time, amount, balance, category,
// desc, auth, processed, card }] (the oldest first, in the order of the balances) } or { error }
function mpSberPdfParse({ rows }) {
  const iso = d => d.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const num = s => { const m = String(s ?? '').replace(/[\s ₽]/g, '').match(/^([+-]?\d+(?:,\d{1,2})?)$/); return m ? Number(m[1].replace(',', '.')) : null; };
  const DATE = /^\d{2}\.\d{2}\.\d{4}$/, TIME = /^\d{2}:\d{2}$/;
  const lines = rows.map(r => r.cells.map(c => c.s).join(' '));
  const txt = lines.join('\n');
  const title = lines.slice(0, 8).find(l => /Выписка по|statement/i.test(l) && !/sberbank\.ru/.test(l)) || '';
  const period = txt.match(/(?:За период|For the period) (\d{2}\.\d{2}\.\d{4}) — (\d{2}\.\d{2}\.\d{4})/);
  const account = txt.match(/(?:Номер сч[её]та|Account No\.)\s+(\d{5} \d{3} \d \d{4} \d{7})/)?.[1]?.replace(/ /g, '');
  if (!period || !account) return { error: 'Sber statement: its period or account number not found' };
  const from = iso(period[1]), to = iso(period[2]);
  // a header figure: the cell after its label (the header's two columns share lines)
  const label = re => {
    for (const { cells } of rows.slice(0, 60)) {
      const i = cells.findIndex(c => re.test(c.s));
      if (i >= 0 && cells[i + 1]) { const v = num(cells[i + 1].s); if (v != null) return v; }
    }
    return null;
  };
  const esc = d => d.replace(/\./g, '\\.');
  const opening = label(new RegExp(`^(?:Остаток на|Balance as of) ${esc(period[1])}$`));
  const closing = label(new RegExp(`^(?:Остаток на|Balance as of) ${esc(period[2])}$`));
  const inflow = label(/^(?:Пополнение|Deposit)$/), outflow = label(/^(?:Списание|Withdrawal)$/);
  if (opening == null || closing == null || inflow == null || outflow == null) return { error: 'Sber statement: its balances or in / out totals not found -- not loaded' };
  const BY_CODE = { 810: 'RUB', 643: 'RUB', 840: 'USD', 978: 'EUR', 156: 'CNY' };
  const currency = BY_CODE[account.slice(5, 8)] || 'RUB';
  let kind, product, depositType = '';
  if (/платёжному|платежному|Payment account/i.test(title)) { kind = 'card'; product = 'debit_card'; }
  else if (/кредитной карты|credit card/i.test(title)) { kind = 'card'; product = 'credit_card'; }
  else if (/«Накопительный сч[её]т»|Savings account/i.test(title)) { kind = 'account'; product = 'savings_account'; }
  else if (/по вкладу «(.+)»/.test(title)) { kind = 'account'; product = 'term_deposit'; depositType = title.match(/по вкладу «(.+)»/)[1]; }
  else return { error: `Sber statement "${title}": not a kind read here -- to Claude` };
  const limit = label(/^(?:Кредитный лимит|Credit limit)$/);
  if (product === 'credit_card' && limit == null) return { error: 'Sber statement: the credit card\'s limit not found -- not loaded' };
  const rate = txt.match(/(?:Процентная ставка|Interest rate)\s+([\d.,]+%)/)?.[1] || '';
  const opened = txt.match(/(?:Дата открытия сч[её]та|Дата заключения договора|Account opening date)\s+(\d{2}\.\d{2}\.\d{4})/)?.[1] || '';
  const txs = [];
  let cur = null, stage = 0, lastY = null;   // stage 1: the row's first line read, 2: its second
  for (const { cells: c, y } of rows) {
    const at = (a, b) => c.filter(x => x.x >= a && x.x < b);
    // a line of the row before: just under its last one (not the page's foot, the next page)
    const near = cur && lastY != null && lastY - y > 0 && lastY - y <= 16;
    if (kind === 'card') {
      if (c[0] && DATE.test(c[0].s) && c[0].x < 100 && c[1] && TIME.test(c[1].s) && c[1].x < 150) {
        const amt = at(380, 495)[0]?.s, bal = at(495, 999)[0]?.s;
        if (num(amt) == null || num(bal) == null) return { error: `Sber statement: a row of ${c[0].s} without its amount or balance -- not loaded` };
        cur = { date: iso(c[0].s), time: c[1].s, amount: /^\+/.test(amt.trim()) ? num(amt) : -num(amt), balance: num(bal), category: at(150, 380).map(x => x.s), desc: [], auth: '', processed: '' };
        txs.push(cur); stage = 1; lastY = y; continue;
      }
      if (near && stage === 1 && c[0] && DATE.test(c[0].s) && c[0].x < 100 && c[1] && c[1].x < 150) {
        cur.processed = iso(c[0].s); cur.auth = c[1].s; cur.desc.push(...at(150, 380).map(x => x.s)); stage = 2; lastY = y; continue;
      }
      if (near && c.length && c.every(x => x.x >= 150 && x.x < 380)) { (stage === 1 ? cur.category : cur.desc).push(...c.map(x => x.s)); lastY = y; continue; }
      cur = null; stage = 0;
    } else {
      if (c[0] && DATE.test(c[0].s) && c[0].x < 100 && c[1] && c[1].x < 248) {
        const amt = at(430, 515)[0]?.s, bal = at(515, 999)[0]?.s;
        if (num(amt) == null || num(bal) == null) return { error: `Sber statement: a row of ${c[0].s} without its amount or balance -- not loaded` };
        cur = { date: iso(c[0].s), time: '', amount: num(amt), balance: num(bal), category: [], desc: at(100, 248).map(x => x.s), auth: at(248, 430).map(x => x.s).join(' '), processed: '' };
        txs.push(cur); lastY = y; continue;
      }
      if (near && c.length && c.every(x => x.x >= 100 && x.x < 248)) {
        if (!/^к\/с |^corr/i.test(c[0].s)) cur.desc.push(...c.map(x => x.s));
        lastY = y; continue;
      }
      cur = null;
    }
  }
  const r2 = x => Math.round(x * 100) / 100;
  let openingNow = opening;
  for (const t of txs) {
    t.desc = t.desc.join(' ').replace(/\s+/g, ' ').trim();
    t.category = t.category.join(' ').replace(/\s+/g, ' ').trim();
    t.card = t.desc.match(/\*{4}(\d{4})/)?.[1] || '';
  }
  // the credit card's limit set ("-", +the limit, 09.10.2021): not money -- left out, the
  // balance it starts at taken as the opening one
  const limitSet = product === 'credit_card' ? txs.find(t => t.desc === '-' && Math.abs(t.amount - limit) < 0.005) : null;
  if (limitSet) { txs.splice(txs.indexOf(limitSet), 1); openingNow = r2(opening + limitSet.amount); }
  // the order the money moved in: the statement lists a day's rows out of it (06.10.2021: 12:11,
  // then 14:29, 14:37 below it), so from the opening balance on, each next row is one whose
  // amount takes the balance before it to its own -- of that day, the earliest such (by time,
  // then the lowest on the page). None: the statement's own balances don't add up there (06.11.2020,
  // the account's first day) -- the earliest row, its balance as the statement has it. The
  // opening and the closing balance and the totals must still add up.
  const chain = [];
  let bal = openingNow, breaks = 0;
  for (const day of [...new Set(txs.map(t => t.date))].sort()) {
    const left = txs.filter(t => t.date === day).reverse();
    while (left.length) {
      let best = -1;
      for (let k = 0; k < left.length; k++) {
        if (Math.abs(r2(bal + left[k].amount) - left[k].balance) > 0.005) continue;
        if (best < 0 || left[k].time < left[best].time) best = k;
      }
      if (best < 0) {
        breaks++;
        best = 0;
        for (let k = 1; k < left.length; k++) if (left[k].time < left[best].time) best = k;
      }
      const [t] = left.splice(best, 1);
      bal = t.balance;
      chain.push(t);
    }
  }
  // Operations the statement leaves out (its credit card, 04.09–03.10.2022: the limit left fell
  // 8 080 with no row): its balances follow the order operations were processed in, so taken in
  // that order (a processing day's rows chained by their balances), a jump no row accounts for
  // is one -- a row is added for it, dated the day the jump shows, its balance the one before
  // the next row. Jumps that only come from the order (one way, then back) cancel out and are
  // left alone: what's added is what the totals miss.
  const hidden = [];
  if (kind === 'card') {
    const gaps = [];
    let b = openingNow;
    for (const day of [...new Set(txs.map(t => t.processed || t.date))].sort()) {
      const left = txs.filter(t => (t.processed || t.date) === day).reverse();
      while (left.length) {
        let k = left.findIndex(t => Math.abs(r2(b + t.amount) - t.balance) < 0.005);
        if (k < 0) {
          k = 0;
          for (let j = 1; j < left.length; j++) if (`${left[j].date} ${left[j].time}` < `${left[k].date} ${left[k].time}`) k = j;
          gaps.push({ before: left[k], amount: r2(left[k].balance - left[k].amount - b), balance: r2(left[k].balance - left[k].amount) });
        }
        b = left.splice(k, 1)[0].balance;
      }
    }
    // a jump and the one undoing it (the order): out of the count
    const net = r2(gaps.reduce((a, g) => a + g.amount, 0));
    const missing = r2(closing - openingNow - r2(txs.reduce((a, t) => a + t.amount, 0)));
    if (Math.abs(missing) > 0.005 && Math.abs(net - missing) < 0.005) {
      const open = [...gaps];
      for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
        if (open[i] && open[j] && Math.abs(open[i].amount + open[j].amount) < 0.005) { open[i] = open[j] = null; break; }
      }
      // what's left of the jumps once the pairs are gone, kept only if it is the whole miss
      const rest = open.filter(Boolean);
      const sumRest = r2(rest.reduce((a, g) => a + g.amount, 0));
      for (const g of Math.abs(sumRest - missing) < 0.005 ? rest : [{ ...gaps[gaps.length - 1], amount: missing }]) {
        const t = g.before;
        hidden.push({ date: t.processed || t.date, time: '', amount: g.amount, balance: g.balance, category: '', auth: '', processed: t.processed || t.date, card: '',
          desc: `${g.amount < 0 ? 'Списание' : 'Зачисление'}, которого нет в выписке Сбера (остаток ${r2(g.balance - g.amount)} -> ${g.balance} до операции ${t.date} ${t.time} ${t.amount})`, hidden: true });
      }
    }
  }
  // the totals: a statement read wrong is left out
  const all = [...txs, ...hidden];
  const sum = r2(all.reduce((a, t) => a + t.amount, 0));
  const ins = r2(all.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0)), outs = r2(-all.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0));
  if (Math.abs(r2(openingNow + sum) - closing) > 0.005 || Math.abs(ins - inflow) > 0.005 || Math.abs(outs - outflow) > 0.005) {
    return { error: `Sber statement: in ${ins} / out ${outs} read, the statement says ${inflow} / ${outflow} (balance ${opening} -> ${closing}) -- not loaded` };
  }
  for (const h of hidden) {
    const i = chain.findIndex(t => `${t.date} ${t.time}` >= `${h.date} ${h.time}`);
    chain.splice(i < 0 ? chain.length : i, 0, h);
  }
  return { kind, product, account, currency, from, to, opening, closing, inflow, outflow, limit, depositType, rate, opened, txs: chain, breaks, hidden: hidden.length };
}
// docs: [{ name, rows }] of Sber's statements (mpIsSberPdf) -> [{ text, file?, checked? }]: a bank
// CSV per statement (sber_<account>_<from>_<to>.csv). A row already stored (the same account,
// day, time and amount) keeps its stored description (the key: updated, not doubled, its labels
// kept). An account's row is "<operation> (<the account>)", as the CSVs made by hand have it.
// The credit card's balance is the debt (what's left of the limit minus the limit).
async function mpSberPdfCsvs(docs) {
  const out = [], seen = new Map();
  const r2 = x => Math.round(x * 100) / 100;
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const d of docs) {
    const p = mpSberPdfParse(d);
    if (p.error) { out.push({ text: `${d.name}: ${p.error}` }); continue; }
    const key = `${p.account}|${p.from}|${p.to}|${p.txs.length}|${p.closing}`;
    if (seen.has(key)) { out.push({ text: `${d.name}: the same statement as ${seen.get(key)} -- left out.` }); continue; }
    seen.set(key, d.name);
    const { account, product, currency } = p;
    const what = `${d.name}: Sber statement, ${product} …${account.slice(-4)} ${currency}, ${p.from} – ${p.to}`;
    const txs = p.txs.filter(t => t.amount !== 0);
    if (!txs.length) { out.push({ text: `${what}: no transactions, balance ${p.closing} -- noted as checked to ${p.to}.`, checked: { name: d.name, from: p.from, to: p.to } }); continue; }
    const deposit = product === 'savings_account' || product === 'term_deposit';
    const named = product === 'savings_account' ? 'Накопительный счёт' : `вклад «${p.depositType}»`;
    for (const t of txs) t.description = deposit ? `${t.desc} (${named})` : t.desc;
    const days = [...new Set(txs.map(t => t.date))].sort();
    const first = days[0], last = days[days.length - 1];
    const stored = deposit
      ? await mpFetchAll(() => sb.from('trades').select('external_id, trade_date').eq('external_source', `sber_deposit_csv:${account}`)
        .gte('trade_date', first).lte('trade_date', last).order('id'))
      : await mpFetchAll(() => sb.from('bank_transactions').select('external_id, tx_date').eq('external_source', `sber_csv:${account}`)
        .gte('tx_date', `${first}T00:00:00Z`).lte('tx_date', `${last}T23:59:59.999Z`).eq('synthetic', false).order('id'));
    const ids = stored.map(s => s.external_id.replace(/:dup\d+$/, ''));
    const taken = new Set();
    let kept = 0;
    for (const t of txs) {
      const head = `${account}:${t.date}:${t.time}:`, tail = `:${Number(t.amount.toFixed(2))}`;
      const i = ids.findIndex((id, n) => !taken.has(n) && id.startsWith(head) && id.endsWith(tail) && id.length > head.length + tail.length);
      t.matched = i >= 0;
      if (i < 0) continue;
      taken.add(i);
      const desc = ids[i].slice(head.length, -tail.length);
      if (desc !== t.description) kept++;
      t.description = desc;
    }
    // the days at the statement's edges with stored rows it hasn't: left out
    let use = txs;
    const skipped = [];
    {
      const strangers = new Set(stored.filter((s, n) => !taken.has(n)).map(s => String(s.tx_date ?? s.trade_date).slice(0, 10)));
      const lead = days.filter(x => x < p.from && strangers.has(x)).pop();
      const trailFrom = mpDayShift(p.to, -4);
      const trail = days.filter(x => x >= trailFrom && strangers.has(x) && txs.filter(t => t.date === x).every(t => t.matched))[0];
      use = txs.filter(t => !(lead && t.date <= lead) && !(trail && t.date >= trail));
      for (const x of days) if ((lead && x <= lead) || (trail && x >= trail)) skipped.push(x);
    }
    let depositName = '';
    if (deposit) {
      const { data: prev } = await sb.from('trades').select('ticker').eq('external_source', `sber_deposit_csv:${account}`).order('trade_date', { ascending: false }).limit(1);
      depositName = prev?.[0] ? prev[0].ticker.replace(/^(?:DEPOSIT|SAVINGS):Sber [A-Z]{3}\s*/, '') : product === 'term_deposit' ? `${p.rate} ${p.opened}`.trim() : '';
    }
    const csv = ['bank,account_number,product,currency,date,time,card,description,amount,balance,category_bank,auth_code,processing_date,deposit_name,source_file',
      ...use.map(t => ['Sber', account, product, currency, t.date, t.time, t.card, t.description || '(no description in statement)', t.amount.toFixed(2),
        (product === 'credit_card' ? r2(t.balance - p.limit) : t.balance).toFixed(2), t.category, t.auth, t.processed, depositName, d.name].map(q).join(','))].join('\n') + '\n';
    const closing = product === 'credit_card' ? r2(p.closing - p.limit) : p.closing;
    out.push({
      text: `${what}: ${use.length} transaction(s)${kept ? ` (${kept} under the description already stored)` : ''}, balance ${closing.toFixed(2)}`
        + `${p.hidden ? `; ${p.hidden} operation(s) the statement leaves out added from its balances` : ''}`
        + `${skipped.length ? `; left out ${skipped.join(', ')}: stored rows of those days aren't in this statement (processed outside its period) -- they stay` : ''}.`,
      file: use.length ? new File([csv], `sber_${account}_${p.from}_${p.to}.csv`, { type: 'text/csv' }) : null,
    });
  }
  return out;
}
// TBC Bank's statement as PDF (tbconline.ge -> the account -> statement -> PDF, 22.11.2026): the
// account's IBAN and the period in its head, the opening and closing balances, the totals paid out
// and in; then the rows -- the day, the description and the additional information (each may run
// on to a second line), the amount in the Paid Out or the Paid In column, the balance after it.
// The PDF writes the CSV's Georgian in Latin letters ("restorani, kape, bari") and a day of the
// month with one space ("Nov 1 2026", the CSV: "Nov  1 2026").
function mpIsTbcPdf(rows) {
  return rows.slice(0, 15).some(r => r.cells[0]?.s === 'Account Statement:' && r.cells.some(c => /^GE\d{2}TB\d{16}$/.test(c.s)));
}
// The CSV's card-payment categories, as the PDF writes them
const MP_TBC_CATEGORIES = {
  'restorani, kape, bari': 'რესტორანი, კაფე, ბარი',
  'sasursato maghaziebi': 'სასურსათო მაღაზიები',
  'skhvadaskhva kharjebi': 'სხვადასხვა ხარჯები',
  'ghamis klubi': 'ღამის კლუბი',
};
// the PDF's description as the CSV has it (a category not listed above stays in Latin letters)
function mpTbcDescription(s) {
  return s.replace(/\b([A-Z][a-z]{2}) (\d) (\d{4} \d{1,2}:\d{2}[AP]M)/, '$1  $2 $3')
    .replace(/(\d{1,2}:\d{2}[AP]M), (.+?), MCC:/, (m, t, cat) => `${t},  ${MP_TBC_CATEGORIES[cat] ?? cat}, MCC:`);
}
// -> { iban, currency, from, to, opening, closing, paidOut, paidIn, txs: [{ date, description, info, amount, balance }] } or { error }
function mpTbcPdfParse({ rows }) {
  const num = s => Number(s.replace(/,/g, ''));
  const dmy = s => { const [d, m, y] = s.split('/'); return `${y}-${m}-${d}`; };
  const head = rows.find(r => r.cells[0]?.s === 'Account Statement:');
  const iban = head.cells.find(c => /^GE\d{2}TB\d{16}$/.test(c.s)).s;
  const period = head.cells.map(c => c.s).filter(s => /^\d{2}\/\d{2}\/\d{4}$/.test(s));
  const figure = label => {
    const r = rows.find(x => x.cells[0]?.s === label);
    const c = r?.cells.find(x => /^-?[\d,]+\.\d{2}$/.test(x.s));
    return c ? { value: num(c.s), currency: r.cells[r.cells.indexOf(c) + 1]?.s } : null;
  };
  const opening = figure('Opening Balance'), closing = figure('Closing Balance'), paidOut = figure('Total Paid out'), paidIn = figure('Total Paid in');
  if (!opening || !closing || !paidOut || !paidIn || period.length < 2) return { error: "the statement's head (period, balances, totals) not read" };
  const txs = [];
  let cols = null, cur = null;
  for (const { cells } of rows) {
    if (cells[0]?.s === 'Date' && cells.some(c => c.s === 'Balance')) {
      // the header: Paid Out / Paid In ("Paid" twice, "Out" and "In" on the line below), Balance
      const paid = cells.filter(c => /^Paid/.test(c.s));
      cols = { out: paid[0].x, in: paid[1].x, info: cells.find(c => c.s === 'Additional Information').x };
      cur = null;
      continue;
    }
    if (!cols) continue;
    if (/^\d+ - \d+$/.test(cells[0]?.s || '')) { cur = null; continue; }   // the page's number
    const date = /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]?.s || '') ? cells[0].s : null;
    if (date) {
      const money = cells.filter(c => /^[\d,]+\.\d{2}$/.test(c.s) && c.x > cols.info);
      if (money.length !== 2) return { error: `a row of ${date} has no amount and balance` };
      const [amt, bal] = money;
      const out = Math.abs(amt.x - cols.out) < Math.abs(amt.x - cols.in);
      const text = cells.slice(1).filter(c => !money.includes(c));
      // the description column ends where the additional information's begins: the first row tells it
      cols.infoAt ??= text[1]?.x;
      cur = { date: dmy(date), desc: [], info: [], amount: (out ? -1 : 1) * num(amt.s), balance: num(bal.s) };
      txs.push(cur);
      for (const c of text) (cols.infoAt != null && c.x >= cols.infoAt - 2 ? cur.info : cur.desc).push(c.s);
      continue;
    }
    if (!cur) continue;
    for (const c of cells) (cols.infoAt != null && c.x >= cols.infoAt - 2 ? cur.info : cur.desc).push(c.s);
  }
  const r2 = x => Math.round(x * 100) / 100;
  // the balances: each row's the one before it and its amount; the totals and the closing balance the statement's
  let bal = opening.value;
  for (const t of txs) {
    if (r2(bal + t.amount) !== r2(t.balance)) return { error: `the balance after a row of ${t.date} (${t.balance}) isn't the one before (${r2(bal)}) and its amount (${t.amount})` };
    bal = t.balance;
  }
  const sum = f => r2(txs.filter(f).reduce((a, t) => a + Math.abs(t.amount), 0));
  if (r2(bal) !== closing.value || sum(t => t.amount < 0) !== paidOut.value || sum(t => t.amount > 0) !== paidIn.value)
    return { error: `the rows don't add up to the statement's totals (paid out ${sum(t => t.amount < 0)} / ${paidOut.value}, paid in ${sum(t => t.amount > 0)} / ${paidIn.value}, closing ${r2(bal)} / ${closing.value})` };
  return {
    iban, currency: opening.currency, from: dmy(period[0]), to: dmy(period[1]), opening: opening.value, closing: closing.value,
    txs: txs.map(t => ({ date: t.date, description: mpTbcDescription(t.desc.join(' ')), info: t.info.join(' '), amount: t.amount, balance: t.balance })),
  };
}
// docs: [{ name, rows }] of TBC's statements (mpIsTbcPdf) -> [{ text, file?, checked? }]: a bank CSV
// per statement, as the bank's CSV of the same account makes (tbcToBankCsv): the same account
// number, product, descriptions and the bank's type. A row already stored (the same account, day
// and amount) keeps its stored description -- the key: updated, not doubled, its labels kept.
async function mpTbcPdfCsvs(docs) {
  const out = [], seen = new Map();
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const d of docs) {
    const p = mpTbcPdfParse(d);
    if (p.error) { out.push({ text: `${d.name}: TBC statement: ${p.error} -- not loaded.` }); continue; }
    const key = `${p.iban}|${p.from}|${p.to}|${p.txs.length}|${p.closing}`;
    if (seen.has(key)) { out.push({ text: `${d.name}: the same statement as ${seen.get(key)} -- left out.` }); continue; }
    seen.set(key, d.name);
    const what = `${d.name}: TBC statement, ${p.iban} ${p.currency}, ${p.from} – ${p.to}`;
    // the account: by its IBAN (TBC_ACCOUNTS), else the stored account its rows are, else by its kind
    let acc = Object.keys(TBC_ACCOUNTS).find(n => TBC_ACCOUNTS[n].iban === p.iban);
    let product = acc && TBC_ACCOUNTS[acc].product;
    if (!acc && p.txs.length) {
      const pick = await tbcMatchAccount(p.txs);
      if (pick && pick.currency === p.currency) ({ num: acc, product } = pick);
    }
    if (!acc) {
      const kind = tbcKindOf(p.txs);
      product = kind?.product ?? 'current_account';
      acc = Object.keys(TBC_ACCOUNTS).find(n => TBC_ACCOUNTS[n].product === product && TBC_ACCOUNTS[n].currency === p.currency);
    }
    if (!acc) { out.push({ text: `${what}: an account not known yet -- upload its CSV statement first.` }); continue; }
    if (!p.txs.length) { out.push({ text: `${what}: no transactions, balance ${p.closing} -- noted as checked to ${p.to}.`, checked: { name: d.name, from: p.from, to: p.to } }); continue; }
    const deposit = product === 'savings_account';
    const first = p.txs[0].date, last = p.txs[p.txs.length - 1].date;
    const stored = deposit
      ? await mpFetchAll(() => sb.from('trades').select('external_id').eq('external_source', `tbc_bank_deposit_csv:${acc}`)
        .gte('trade_date', first).lte('trade_date', last).order('id'))
      : await mpFetchAll(() => sb.from('bank_transactions').select('external_id').eq('external_source', `tbc_bank_csv:${acc}`)
        .gte('tx_date', `${first}T00:00:00Z`).lte('tx_date', `${last}T23:59:59.999Z`).eq('synthetic', false).order('id'));
    const ids = stored.map(s => s.external_id.replace(/:dup\d+$/, ''));
    const taken = new Set();
    let kept = 0;
    for (const t of p.txs) {
      const head = `${acc}:${t.date}::`, tail = `:${Number(t.amount.toFixed(2))}`;
      // the same description first, else the row of that day and amount
      let i = ids.findIndex((id, n) => !taken.has(n) && id === head + t.description + tail);
      if (i < 0) i = ids.findIndex((id, n) => !taken.has(n) && id.startsWith(head) && id.endsWith(tail) && id.length > head.length + tail.length);
      if (i < 0) continue;
      taken.add(i);
      const desc = ids[i].slice(head.length, -tail.length);
      if (desc !== t.description) kept++;
      t.description = desc;
    }
    // the bank's type, as its CSV has it
    const type = t => /^Transfer between your accounts$/.test(t.description) ? 'საკუთარ ანგარიშებს შორის გადარიცხვა'
      : t.amount < 0 && /^(POS|Private transfer)/.test(t.description) ? 'გადარიცხვა თანხის გატანა' : '';
    const csv = ['bank,account_number,product,currency,date,time,card,description,amount,balance,category_bank,source_file',
      ...p.txs.map(t => ['TBC Bank', acc, product, p.currency, t.date, '', '', t.description, t.amount, t.balance.toFixed(2), type(t), d.name].map(q).join(','))].join('\n') + '\n';
    out.push({
      text: `${what}: ${p.txs.length} transaction(s)${kept ? ` (${kept} under the description already stored)` : ''}, balance ${p.closing.toFixed(2)}.`,
      file: new File([csv], `tbc_${acc}_${p.from}_${p.to}.csv`, { type: 'text/csv' }),
    });
  }
  return out;
}
// MyMagti's payment history (magticom.ge -> MyMagti -> ტრანზაქციები, the page printed to PDF,
// 22.11.2026) as this project's receipt CSV, as Wolt's receipts are: each payment a receipt of
// one line (the number paid for; "ბალანსის შევსება", a top-up, when the page shows it opened),
// matched to the bank's row by match_receipts. Its number: Magti's number paid for, the day and
// time; store and chain as the banks name Magti ("Magticom": Revolut's row, TBC's POS row). A
// payment shown on several pages (each opening one) is one receipt, what each page adds put
// together.
function mpIsMagtiPdf(rows) {
  return rows.some(r => r.cells.some(c => /magticom\.ge\/\S*payment-history/.test(c.s)));
}
// [{ amount, number, day, time, topup, method, card }]
function mpMagtiPayments(rows) {
  const MON = { 'იან': 1, 'თებ': 2, 'მარ': 3, 'აპრ': 4, 'მაი': 5, 'ივნ': 6, 'ივლ': 7, 'აგვ': 8, 'სექ': 9, 'ოქტ': 10, 'ნოე': 11, 'დეკ': 12 };
  const out = [];
  let cur = null;
  // the page's icons (the lari sign, the calendar, the clock) are characters of its own font
  const clean = x => x.replace(/[\uE000-\uF8FF]/g, '').trim();
  for (const { cells: raw } of rows) {
    const cells = raw.map(c => ({ ...c, s: clean(c.s) }));
    const s = cells.map(c => c.s).filter(Boolean);
    const date = s.map(x => x.match(/^(\d{1,2}) \/ (\S+) \/ (\d{4})$/)).find(Boolean);
    const amount = cells.find(c => c.x < 200 && /^\d+(?:[.,]\d{1,2})?$/.test(c.s));
    if (date && amount && MON[date[2]]) {
      cur = { amount: Number(amount.s.replace(',', '.')), number: '', day: `${date[3]}-${String(MON[date[2]]).padStart(2, '0')}-${date[1].padStart(2, '0')}`, time: '', topup: false, method: '', card: '' };
      out.push(cur);
    }
    if (!cur) continue;
    for (const x of s) {
      if (/^\d{9}$/.test(x) && !cur.number) cur.number = x;
      else if (/^\d{2}:\d{2}:\d{2}$/.test(x) && !cur.time) cur.time = x;
      else if (/ბალანსის შევსება/.test(x)) cur.topup = true;
      else if (/\*{4} \*{4} \*{4} (\d{4})/.test(x)) cur.card = x.match(/(\d{4})$/)[1];
    }
    const m = s.findIndex(x => /^გადახდის მეთოდი:?$/.test(x));
    if (m >= 0 && s[m + 1]) cur.method = s[m + 1] === 'საბანკო ბარათი' ? 'card' : s[m + 1];
  }
  return out;
}
// Magti's internet packages (MyMagti -> ინტერნეტი, 22.11.2026), by price in lari: a top-up of
// exactly a package's price is that package bought (the line names it; the top-up in its note)
const MP_MAGTI_PACKAGES = {
  2: ['ინტერნეტი ულიმიტო, 1 დღე', 'Internet unlimited, 1 day'],
  5: ['ინტერნეტი 1 000 MB, 30 დღე', 'Internet 1 000 MB, 30 days'],
  9: ['ინტერნეტი 3 000 MB, 30 დღე', 'Internet 3 000 MB, 30 days'],
  10: ['ინტერნეტი ულიმიტო, 7 დღე', 'Internet unlimited, 7 days'],
  12: ['ინტერნეტი 5 000 MB, 30 დღე', 'Internet 5 000 MB, 30 days'],
  30: ['ინტერნეტი 20 000 MB, 30 დღე', 'Internet 20 000 MB, 30 days'],
  35: ['ინტერნეტი ულიმიტო, 30 დღე', 'Internet unlimited, 30 days'],
};
// docs: [{ name, rows }] of MyMagti's pages -> { csv, payments }; csv null when none read
function mpMagtiReceiptsCsv(docs) {
  const payments = [];
  for (const d of docs) for (const p of mpMagtiPayments(d.rows)) {
    const had = payments.find(q => q.number === p.number && q.day === p.day && q.time === p.time && q.amount === p.amount);
    if (had) { had.method ||= p.method; had.card ||= p.card; had.topup ||= p.topup; continue; }
    payments.push(p);
  }
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  // online: paid on the site, not at a place (import-receipts leaves it without one)
  const out = ['receipt,date,time,store,chain,city,country,currency,total,line,item,item_en,qty,unit,unit_price_list,unit_price_paid,line_total,barcode,note,online'];
  for (const p of payments) {
    const how = p.method === 'card' ? `bank card${p.card ? ` …${p.card}` : ''}` : p.method;
    const pack = MP_MAGTI_PACKAGES[p.amount];
    const paid = [p.topup ? `balance top-up ${p.number}` : `payment ${p.number}`, how ? `paid by ${how}` : ''].filter(Boolean).join(', ');
    out.push([`MAGTI-${p.number}-${p.day.replace(/-/g, '')}-${p.time.replace(/:/g, '')}`, p.day, p.time.slice(0, 5), 'Magticom', 'Magticom', '', 'GE', 'GEL',
      p.amount.toFixed(2), 1, pack ? `${pack[0]} (${p.number})` : `${p.topup ? 'ბალანსის შევსება' : 'გადახდა'} ${p.number}`,
      pack ? `${pack[1]} (${p.number})` : `${p.topup ? 'Balance top-up' : 'Payment'}, number ${p.number}`,
      1, 'pcs', p.amount.toFixed(2), p.amount.toFixed(2), p.amount.toFixed(2), '', pack ? `${paid[0].toUpperCase()}${paid.slice(1)}` : how ? `Paid by ${how}` : '', 1].map(q).join(','));
  }
  return { csv: payments.length ? out.join('\n') + '\n' : null, payments };
}
// Wolt's receipts (PDFs, 14.11.2026) as this project's receipt CSV: an order comes as two --
// the venue's (the food, "Receipt #...") and Wolt's own ("Wolt delivery receipt #...": delivery,
// service fee) -- and is paid as one (TBC: "POS - WOLT GEORGIA LTD", the sum of both). Both are
// one receipt, its number the Order ID, store and chain as the bank names Wolt ("WOLT GEORGIA LTD";
// both receipts are Wolt's; the bank row's description has it -- match_receipts' chain_hit), the restaurant its venue (the place); the venue's lines numbered from 1, Wolt's
// from 101. Uploaded together they're one receipt here already; uploaded one by one, each
// is a receipt of its own part and import-receipts puts the second into the first (by the
// day and the Order ID). A dish with options (a group row, its parts under it, indented) is
// one line, the options its note.
// docs: [{ name, rows }] (mpPdfRows) -> { csv, orders, problems }; csv null when none read
function mpWoltReceiptsCsv(docs) {
  const num = s => Number(String(s).replace(/[^\d.,-]/g, '').replace(',', '.'));
  const problems = [];
  const parsed = [];
  for (const { name, rows } of docs) {
    const first = s => rows.find(r => r.cells[0]?.s === s);
    const head = rows.find(r => /receipt #\d+/i.test(r.cells[0]?.s || ''));
    const orderId = first('Order ID')?.cells[1]?.s;
    if (!head || !orderId) { problems.push(`${name}: not a Wolt receipt`); continue; }
    const when = rows.find(r => /time$/i.test(r.cells[0]?.s || '') && /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(r.cells[1]?.s || ''));
    const [, dd, mm, yyyy, hhmm] = when ? when.cells[1].s.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})$/) : [];
    const iHead = rows.findIndex(r => r.cells[0]?.s === 'Item');
    const iTotal = rows.findIndex(r => /^Total in [A-Z]{3}/.test(r.cells[0]?.s || ''));
    const iPay = rows.findIndex(r => r.cells[0]?.s === 'Payment method');
    if (!dd || iHead < 0 || iTotal < iHead) { problems.push(`${name}: its date or items not found`); continue; }
    const itemX = rows[iHead].cells[0].x;
    const items = [];
    for (const r of rows.slice(iHead + 1, iTotal)) {
      const c = r.cells, price = num(c[c.length - 1].s);
      if (c[0].x > itemX + 8 && items.length && items[items.length - 1].group) {
        // a group's part: the dish itself gives its quantity, the rest are its options
        const g = items[items.length - 1];
        if (c[0].s === g.name && c.length >= 5) { g.qty = num(c[2].s); g.unit = num(c[3].s); }
        else g.opts.push(price ? `${c[0].s} (+${price.toFixed(2)})` : c[0].s);
      } else if (c.length >= 5) items.push({ name: c[0].s, qty: num(c[2].s), unit: num(c[3].s), price, opts: [] });
      else items.push({ name: c[0].s, qty: 1, unit: null, price, opts: [], group: true });
    }
    const total = num(rows[iTotal].cells[rows[iTotal].cells.length - 1].s);
    const paid = iPay >= 0 ? rows.slice(iPay + 1, iHead).reduce((s, r) => s + (r.cells.length >= 2 ? num(r.cells[r.cells.length - 1].s) : 0), 0) : total;
    const sum = items.reduce((s, it) => s + it.price, 0);
    if (Math.abs(sum - total) > 0.005 || Math.abs(paid - total) > 0.005) { problems.push(`${name}: its items add up to ${sum.toFixed(2)}, paid ${paid.toFixed(2)}, total ${total.toFixed(2)}`); continue; }
    parsed.push({ name, orderId, delivery: /^Wolt delivery receipt/i.test(head.cells[0].s), venue: first('Venue')?.cells[1]?.s,
      type: first('Order type')?.cells[1]?.s || '', date: `${yyyy}-${mm}-${dd}`, time: hhmm,
      currency: rows[iTotal].cells[0].s.match(/^Total in ([A-Z]{3})/)[1], total, items });
  }
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const out = ['receipt,date,time,store,chain,city,country,currency,total,line,item,item_en,qty,unit,unit_price_list,unit_price_paid,line_total,barcode,note,venue'];
  const orders = [];
  for (const orderId of new Set(parsed.map(p => p.orderId))) {
    const docsOf = parsed.filter(p => p.orderId === orderId);
    const food = docsOf.find(p => !p.delivery), fees = docsOf.find(p => p.delivery);
    const any = food || fees;
    const total = Math.round(((food?.total || 0) + (fees?.total || 0)) * 100) / 100;
    // named as the bank names it: TBC's "POS - WOLT GEORGIA LTD" (the Expenses tab's description)
    const wolt = any.currency === 'GEL' ? 'WOLT GEORGIA LTD' : 'Wolt';
    const lines = [...(food?.items || []).map((it, i) => [i + 1, it]), ...(fees?.items || []).map((it, i) => [101 + i, it])];
    for (const [line, it] of lines) {
      const unit = it.unit ?? (it.qty ? Math.round(it.price / it.qty * 100) / 100 : it.price);
      out.push([orderId, any.date, any.time, wolt, wolt, '', '', any.currency, total.toFixed(2), line,
        it.name, it.name, it.qty || 1, 'pcs', unit.toFixed(2), unit.toFixed(2), it.price.toFixed(2), '', it.opts.join('; '), food?.venue || ''].map(q).join(','));
    }
    orders.push({ orderId, venue: food?.venue || null, date: any.date, total, currency: any.currency, files: docsOf.map(p => p.name),
      part: food && fees ? null : food ? 'the food receipt' : 'the delivery receipt' });
  }
  return { csv: orders.length ? out.join('\n') + '\n' : null, orders, problems };
}
// Ziraat's PDF statement is a picture (no text in it, 23.11.2026): read from the page's pixels
// and OCR. `page` is { width, height, lum(x, y) } (0 black - 255 white); `ocr(rect, kind)` reads
// a rectangle -- kind 'digits' (a date, an amount), 'code' (the invoice no) or 'text'. The table's
// grey header band and its borders give the columns (at their fixed share of the table, as Ziraat
// prints it); each row is a line of ink in the date column (a row's explanation wraps over two
// lines, its date in the middle). Returns { accountNo, currency, rows: [{ date, invoiceNo,
// description, amount, balanceAfter }] } (newest first, as printed), owed / received from the foot.
async function mpZiraatPdfPage(page, ocr) {
  const { width: W, height: H, lum } = page;
  const greyRow = y => { let n = 0; for (let x = 0; x < W; x += 2) { const v = lum(x, y); if (v > 180 && v < 235) n++; } return n > W / 2 * 0.6; };
  let hy0 = -1, hy1 = -1;
  for (let y = 0; y < H; y++) { if (greyRow(y)) { if (hy0 < 0) hy0 = y; hy1 = y; } else if (hy0 >= 0 && y - hy1 > 8) break; }
  if (hy0 < 0) return null;
  // the band's left and right ends: the table's
  const mid = Math.round((hy0 + hy1) / 2);
  let tx0 = 0, tx1 = W - 1;
  while (tx0 < W && !(lum(tx0, mid) > 180 && lum(tx0, mid) < 235)) tx0++;
  while (tx1 > 0 && !(lum(tx1, mid) > 180 && lum(tx1, mid) < 235)) tx1--;
  const tw = tx1 - tx0;
  // the columns: the header's words -- Date | Invoice No | Explanation | Transaction Amount |
  // Balance -- as runs of ink across the band, a gap of 1% of the table between them
  const starts = [];
  let last = -1e9;
  for (let x = tx0 + 2; x < tx1 - 2; x++) {
    let ink = false;
    for (let y = hy0 + 2; y < hy1 - 2; y++) if (lum(x, y) < 120) { ink = true; break; }
    if (!ink) continue;
    if (x - last > tw * 0.011) starts.push(x);
    last = x;
  }
  if (starts.length !== 5) return null;
  const pad = Math.round(tw * 0.006);
  const X = { date: starts[0] - pad, inv: starts[1] - pad, expl: starts[2] - pad, amt: starts[3] - pad, bal: starts[4] - pad, end: tx1 };
  // lines of ink in a strip, below the band to the table's bottom border
  const inkLines = (x0, x1, y0, y1) => {
    const out = [];
    let start = -1;
    for (let y = y0; y < y1; y++) {
      let ink = false;
      for (let x = x0; x < x1; x++) if (lum(x, y) < 140) { ink = true; break; }
      if (ink && start < 0) start = y;
      if (!ink && start >= 0) { if (y - start > 4) out.push([start, y]); start = -1; }
    }
    return out;
  };
  // the table's bottom: the first long dark line below the band
  let ty1 = H - 1;
  for (let y = hy1 + 2; y < H; y++) {
    let n = 0;
    for (let x = tx0; x < tx1; x += 2) if (lum(x, y) < 120) n++;
    if (n > tw / 2 * 0.9) { ty1 = y; break; }
  }
  const inside = 6;
  const dates = inkLines(X.date + inside, X.inv - inside, hy1 + 3, ty1 - 2);
  // the foot ("Amount Owed:", "Recipient:") stands in the invoice column, below the last date
  const invLines = inkLines(X.inv + inside, X.expl - inside, hy1 + 3, ty1 - 2);
  const lastDate = dates.length ? dates[dates.length - 1][1] : hy1;
  const foot = invLines.filter(([a]) => a > lastDate + 2);
  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const [a, b] = dates[i], h = b - a;
    const top = i ? Math.round((dates[i - 1][1] + a) / 2) : hy1 + 3;
    const bottom = i + 1 < dates.length ? Math.round((b + dates[i + 1][0]) / 2) : (foot.length ? foot[0][0] - 2 : Math.min(ty1 - 2, b + h * 2));
    const line = { y: a - Math.round(h * 0.35), h: Math.round(h * 1.7) };
    const rect = (x0, x1, y, hh) => ({ left: x0 + inside, top: y, width: x1 - x0 - 2 * inside, height: hh });
    rows.push({
      date: await ocr(rect(X.date, X.inv, line.y, line.h), 'digits'),
      invoiceNo: await ocr(rect(X.inv, X.expl, line.y, line.h), 'code'),
      description: await ocr(rect(X.expl, X.amt, top, bottom - top), 'text'),
      amount: await ocr(rect(X.amt, X.bal, line.y, line.h), 'digits'),
      balanceAfter: await ocr(rect(X.bal, X.end, line.y, line.h), 'digits'),
    });
  }
  const footVals = [];
  for (const [a, b] of foot) footVals.push(await ocr(rect2(X.amt, X.end, a - Math.round((b - a) * 0.35), Math.round((b - a) * 1.7)), 'digits'));
  function rect2(x0, x1, y, hh) { return { left: x0 + inside, top: y, width: x1 - x0 - 2 * inside, height: hh }; }
  // the box above the table: "Customer No : 103119215-5001", "Currency : TRY"
  const head = await ocr({ left: Math.round(tx0 + tw * 0.55), top: Math.max(0, Math.round(hy0 - (hy1 - hy0) * 3.2)), width: Math.round(tw * 0.45), height: Math.round((hy1 - hy0) * 2.9) }, 'text');
  return { head, rows, foot: footVals };
}

// The pages read (mpZiraatPdfPage) into the statement, checked: every amount and balance a
// number, each balance the one below it (older) plus its amount, the amounts out and in summing
// to the foot's "Amount Owed" / "Recipient" -- a misread digit doesn't go in. { error } else.
function mpZiraatPdfStatement(pages) {
  // an amount is always printed with its kuruş ("-100.028,37"), its separators often misread
  // (a comma as a dot, one dropped): its digits, the last two the kuruş
  const num = s => {
    const m = String(s || '').replace(/[\s—–]/g, '').match(/^[^-\d]*(-?)(\d[\d.,]*\d)$/);
    return m && m[2].replace(/[.,]/g, '').length >= 3 ? Number(m[1] + m[2].replace(/[.,]/g, '')) / 100 : null;
  };
  const head = pages.map(p => p.head).join('\n');
  const accountNo = head.match(/(\d{9})\s*-\s*(\d{4})/);
  // the currency's code, "TRY" read as "IRY" at times
  const code = (head.match(/Currency\s*\S?\s*([A-Z]{2,3})\b/) || [])[1] || '';
  const cur = ['USD', 'EUR', 'GBP'].includes(code) ? code : /^(?:.RY|T.Y|TR.|TL)$/.test(code) ? 'TRY' : null;
  const rows = pages.flatMap(p => p.rows).map(r => ({
    date: (String(r.date).match(/(\d{2})\.?(\d{2})\.?(\d{4})/) || []).slice(1).join('.'),
    invoiceNo: String(r.invoiceNo).replace(/\s/g, '').replace(/^(\D)(.*)$/, (m, a, b) => a + b.replace(/O/g, '0').replace(/[IL]/g, '1')),
    description: String(r.description).replace(/\s+/g, ' ').trim(),
    amount: num(r.amount), balanceAfter: num(r.balanceAfter),
  }));
  const foot = pages.flatMap(p => p.foot).map(num);
  const where = r => `the row of ${r.date || '?'} ${r.invoiceNo} (${r.amount ?? '?'}, balance ${r.balanceAfter ?? '?'})`;
  if (!rows.length) return { error: 'no rows read from the statement' };
  if (!accountNo || !cur) return { error: "the account number / currency not read from the statement's head" };
  const unread = rows.find(r => !/^\d{2}\.\d{2}\.\d{4}$/.test(r.date) || r.amount === null || r.balanceAfter === null);
  if (unread) return { error: `${where(unread)} misread` };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const older = rows[i + 1];
    if (older && Math.abs(older.balanceAfter + r.amount - r.balanceAfter) > 0.005) return { error: `${where(r)} doesn't add up with the balance below it -- misread` };
  }
  const out = rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
  const inn = rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  if (foot.length < 2 || foot[0] === null || foot[1] === null
    || Math.abs(foot[0] - out) > 0.005 || Math.abs(foot[1] - inn) > 0.005) {
    return { error: `the amounts read don't sum to the statement's totals (${foot.join(' / ')} vs ${out.toFixed(2)} / ${inn.toFixed(2)}) -- misread` };
  }
  return { accountNo: `${accountNo[1]}-${accountNo[2]}`, currency: cur, rows };
}

// A Ziraat PDF statement (a picture) read on the page: pdf.js draws each page, Tesseract.js
// (loaded the first time one's needed) reads the cells mpZiraatPdfPage points at -- the text
// in Turkish, dates / amounts / the invoice no. as digits and capitals only. -> the statement
// (mpZiraatPdfStatement) or { error }; null when the PDF isn't one of Ziraat's.
let mpTesseract = null;
async function mpZiraatPdfRead(file, onPage) {
  await mpPdfRows({ arrayBuffer: async () => new ArrayBuffer(0) }).catch(() => {});   // pdf.js loaded
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (!window.Tesseract) {
    await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = ok; s.onerror = () => fail(new Error('Tesseract.js did not load')); document.head.appendChild(s); });
  }
  if (!mpTesseract) {
    const text = await Tesseract.createWorker('tur');
    const digits = await Tesseract.createWorker('eng');
    await digits.setParameters({ tessedit_char_whitelist: '0123456789.,-', tessedit_pageseg_mode: '7' });
    const code = await Tesseract.createWorker('eng');
    await code.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: '7' });
    mpTesseract = { text, digits, code };
  }
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (onPage) onPage(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 4 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data, W = canvas.width;
    const ocr = async (r, kind) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, r.width); c.height = Math.max(1, r.height);
      c.getContext('2d').drawImage(canvas, r.left, r.top, r.width, r.height, 0, 0, r.width, r.height);
      return (await mpTesseract[kind].recognize(c)).data.text.trim();
    };
    const read = await mpZiraatPdfPage({ width: W, height: canvas.height, lum: (x, y) => px[(y * W + x) * 4] }, ocr);
    if (read) pages.push(read);
  }
  if (!pages.length) return null;
  return mpZiraatPdfStatement(pages);
}

async function mpImportFiles(files) {
  const listEl = document.getElementById('mp_any_csv_status');
  files = [...files];
  if (!files.length) { if (!mpImportRunning) listEl.textContent = 'Choose or drop a file first.'; return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { listEl.textContent = 'Sign in first.'; return; }
  if (!mpImportRunning) listEl.textContent = '';
  // PDFs, read here: Raiffeisen's, Alfa-Bank's, T-Bank's and Sber's statements -- each its own
  // CSV of the statement's days --, MyMagti's payment history (a receipt CSV) and Wolt's receipts (an order's two put together, one receipt CSV)
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  if (pdfs.length) {
    files = files.filter(f => !pdfs.includes(f));
    const line = document.createElement('div');
    line.textContent = `${pdfs.length} PDF(s): reading…`;
    listEl.appendChild(line);
    try {
      let docs = [];
      for (const f of pdfs) docs.push({ name: f.name, rows: await mpPdfRows(f) });
      // Ziraat's statements are pictures (no text in them): read by OCR, each sent as the
      // statement's rows (JSON) to import-ziraat-statement
      const pictures = docs.filter(d => !d.rows.length);
      docs = docs.filter(d => d.rows.length);
      for (const d of pictures) {
        const rl = document.createElement('div');
        listEl.appendChild(rl);
        const f = pdfs.find(x => x.name === d.name);
        try {
          const r = await mpZiraatPdfRead(f, (n, of) => { rl.textContent = `${d.name}: a picture PDF -- reading it (OCR), page ${n} of ${of}…`; });
          if (!r) { rl.textContent = `${d.name}: a PDF with no text in it, not a Ziraat statement -- nothing read.`; continue; }
          if (r.error) { rl.textContent = `${d.name}: Ziraat statement, ${r.error}.`; continue; }
          const days = r.rows.map(x => x.date.split('.').reverse().join('-')).sort();
          rl.textContent = `${d.name}: Ziraat statement (PDF, read by OCR), account ${r.accountNo} ${r.currency}, ${days[0]} – ${days[days.length - 1]}: `
            + `${r.rows.length} transaction(s), every amount checked against the balances and the totals.`;
          files.push(new File([JSON.stringify({ ziraat_pdf: true, pdf: true, ...r })], `ziraat_${r.accountNo}_${days[0]}_${days[days.length - 1]}.json`, { type: 'application/json' }));
        } catch (error) {
          rl.textContent = `${d.name}: reading the picture PDF failed: ${error.message}`;
        }
      }
      const raif = docs.filter(d => mpIsRaifPdf(d.rows));
      docs = docs.filter(d => !raif.includes(d));
      for (const d of raif) {
        const rl = document.createElement('div');
        listEl.appendChild(rl);
        const r = mpRaifPdfCsv(d);
        if (r.error) { rl.textContent = `${d.name}: ${r.error}`; continue; }
        rl.textContent = `${d.name}: Raiffeisen statement, ${r.account} ${r.currencies.join('/')}, ${r.from} – ${r.to}: ${r.count} transaction(s)`
          + ' (the days of the statement are replaced; the history before and after stays).';
        const f = new File([r.csv], `raif_${r.account}_${r.from}_${r.to}.csv`, { type: 'text/csv' });
        f.mpQuery = `?from=${r.from}&to=${r.to}`;
        files.push(f);
      }
      // Alfa-Bank's account statements: each its bank CSV, named by its period
      const alfa = docs.filter(d => mpIsAlfaPdf(d.rows));
      const alfaInvest = docs.filter(d => !alfa.includes(d) && mpIsAlfaInvestReport(d.rows));
      docs = docs.filter(d => !alfa.includes(d) && !alfaInvest.includes(d));
      for (const d of alfaInvest) {
        const rl = document.createElement('div');
        rl.textContent = `${d.name}: Alfa-Investments' investment report -- the portfolio's value and return only, nothing to load (the deals and the money come from the broker report, XML).`;
        listEl.appendChild(rl);
      }
      for (const d of alfa) {
        const rl = document.createElement('div');
        listEl.appendChild(rl);
        const r = mpAlfaPdfCsv(d);
        if (r.error) { rl.textContent = `${d.name}: ${r.error}`; continue; }
        const what = `${d.name}: Alfa-Bank statement, ${r.type || r.product} …${r.account.slice(-4)} ${r.currency}, ${r.from} – ${r.to}`;
        if (!r.count) {
          // no movements: nothing to import, but the account's checked to the statement's end
          await sb.from('statement_uploads').insert({ account: 'Alfa', kind: 'bank_csv', file_name: d.name, period_from: r.from, period_to: r.to });
          mpImportedSinceRefresh = true;
          rl.textContent = `${what}: no transactions, balance ${r.closing} -- noted as checked to ${r.to}.`;
          continue;
        }
        rl.textContent = `${what}: ${r.count} transaction(s), closing balance ${r.closing}.`;
        files.push(new File([r.csv], `alfa_${r.account}_${r.from}_${r.to}.csv`, { type: 'text/csv' }));
      }
      // T-Bank's statements: a bank CSV per account, all read together ("Перевод себе" takes
      // its contract from the other statement)
      const tbank = docs.filter(d => mpIsTbankPdf(d.rows));
      const sber = docs.filter(d => !tbank.includes(d) && mpIsSberPdf(d.rows));
      const tbc = docs.filter(d => !tbank.includes(d) && !sber.includes(d) && mpIsTbcPdf(d.rows));
      docs = docs.filter(d => !tbank.includes(d) && !sber.includes(d) && !tbc.includes(d));
      if (tbank.length || sber.length || tbc.length) {
        const bankWise = [['T-Bank', tbank, mpTbankPdfCsvs], ['Sber', sber, mpSberPdfCsvs], ['TBC Bank', tbc, mpTbcPdfCsvs]];
        for (const r of (await Promise.all(bankWise.map(([bank, ds, f]) => Promise.resolve(ds.length ? f(ds) : []).then(rs => rs.map(r => ({ ...r, bank })))))).flat()) {
          const rl = document.createElement('div');
          rl.textContent = r.text;
          listEl.appendChild(rl);
          if (r.file) files.push(r.file);
          if (r.checked) {
            // no movements: nothing to import, but the account's checked to the statement's end
            await sb.from('statement_uploads').insert({ account: r.bank, kind: 'bank_csv', file_name: r.checked.name, period_from: r.checked.from, period_to: r.checked.to });
            mpImportedSinceRefresh = true;
          }
        }
      }
      // MyMagti's payment history: a receipt CSV of its payments
      const magti = docs.filter(d => mpIsMagtiPdf(d.rows));
      docs = docs.filter(d => !magti.includes(d));
      if (magti.length) {
        const { csv, payments } = mpMagtiReceiptsCsv(magti);
        const rl = document.createElement('div');
        rl.textContent = `${magti.map(d => d.name).join(', ')}: MyMagti payment history, ${payments.length} payment(s)`
          + `${payments.length ? ` (${payments.map(p => `${p.day} ${p.time} ${p.amount.toFixed(2)} GEL, ${p.number}`).join('; ')})` : ''}.`;
        listEl.appendChild(rl);
        if (csv) files.push(new File([csv], `magti_${[...new Set(payments.map(p => p.number))].join('+')}_${payments.map(p => p.day).sort()[0]}_${payments.map(p => p.day).sort().pop()}.csv`, { type: 'text/csv' }));
      }
      if (!docs.length) { line.remove(); }
      const { csv, orders, problems } = docs.length ? mpWoltReceiptsCsv(docs) : { csv: null, orders: [], problems: [] };
      if (docs.length) line.textContent = `${docs.length} PDF(s): ${orders.length} Wolt order(s)`
        + `${orders.length ? ` (${orders.map(o => `${o.date} WOLT ${o.venue || ''} ${o.total.toFixed(2)} ${o.currency}${o.part ? `, ${o.part} only -- the other part joins it when uploaded` : ''}`).join('; ')})` : ''}`
        + `${problems.length ? `. Left out: ${problems.join('; ')}` : ''}.`;
      if (csv) files.push(new File([csv], `wolt_${orders.map(o => `${o.date}_${(o.venue || 'order').replace(/\W+/g, '_')}`).join('+')}.csv`, { type: 'text/csv' }));
    } catch (error) {
      line.textContent = `${pdfs.length} PDF(s): ${error.message}`;
    }
  }
  for (const file of files) {
    const line = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = `${file.name}: `;
    const msg = document.createElement('span');
    msg.textContent = 'queued';
    line.append(name, msg);
    listEl.appendChild(line);
    mpImportQueue.push({ file, msg });
  }
  if (mpImportRunning) return;
  mpImportRunning = true;
  try {
    while (mpImportQueue.length) {
      const { file, msg } = mpImportQueue.shift();
      msg.textContent = 'uploading…';
      await mpImportOneFile(file, msg, session);
    }
  } finally {
    mpImportRunning = false;
    mpRenderLatestSources();
    // the capital charts are rebuilt in the database a few minutes later
    // (queued here; the capital-refresh-step cron job does the work)
    if (mpImportedSinceRefresh) {
      mpImportedSinceRefresh = false;
      // Apple's orders still waiting for their charge: a statement just in may have it
      // (not every importer calls match_receipts, which links them too -- Ziraat's doesn't)
      await sb.rpc('match_apple_receipts').then(() => {}, () => {});
      const line = document.createElement('div');
      const { error } = await sb.rpc('request_my_capital_refresh');
      line.textContent = error ? `Capital history not queued for a rebuild: ${error.message}`
        : 'Capital history queued for a rebuild -- the Capital charts catch up in a few minutes (reload the page then).';
      listEl.appendChild(line);
    }
  }
}
document.getElementById('mp_any_csv_upload').addEventListener('click', () => {
  const input = document.getElementById('mp_any_csv_file');
  mpImportFiles(input.files);
  input.value = '';
});
{
  const drop = document.getElementById('mp_any_csv_drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    mpImportFiles(e.dataTransfer.files);
  });
}

// The newest real record per account: bank_transactions (synthetic rows left
// out -- they say nothing about which statement is in) and trades, each with
// the external_source it came from.
// How often each account wants a fresh statement: closed ones never; cash and
// Wise only now and then (no reminder); brokers and banks no longer in daily
// use monthly (30 days). Any other bank weekly while in active use -- at least
// 4 real transactions per 30 days over the 90 days before its newest record --
// else monthly.
const MP_ACCOUNT_SCHEDULE = {
  UniCredit: 'closed', Finuslugi: 'closed', YooMoney: 'closed', cash: 365, Wise: 365, 'Credo Bank': 365, 'TBC Bank': 30,
  IBKR: 30, Freedom24: 30, Raiffeisen: 30, 'Ziraat Bank': 30, 'Yandex Bank': 365,
  Bybit: 30, 'Crypto.com': 30, Telegram: 365, Binance: 365,
};
// The split accounts' parts, each on a period set by how active it is (its
// real records over the last 90 / 180 days, income that comes by itself --
// dividends, coupons, interest -- left out; latest_data_per_part): over 40 a
// month (a broker: 20) every 2 weeks, 2+ a month monthly, any in half a year
// every 2 months, none yearly. A part synced by itself is "auto" whatever its
// activity.
const mpPartPeriod = p => {
  const perMonth = (p.rows_90d || 0) / 3;
  return perMonth > (p.part === 'Broker' ? 20 : 40) ? 14 : perMonth >= 2 ? 30 : (p.rows_180d || 0) > 0 ? 60 : 365;
};
// Where each account's statements come from (the row's tooltip). "As is":
// the bank's own file goes straight into Upload; "to Claude": a PDF /
// screenshots turned into this project's CSV first.
const MP_ACCOUNT_SOURCE = {
  Revolut: 'Revolut app → avatar → Documents & statements → by type: account, Flexible Cash Funds, savings, stocks, crypto, gold -- CSV each. Upload as is.',
  'Bank of Cyprus': '1Bank → Accounts → Transaction history → Export (CSV). Upload as is.',
  IBKR: 'Synced every morning through the Flex Web Service (IBKR automatic sync, below the uploads); or the IBKR Activity Statement, CSV, for the period since the last one, uploaded as is.',
  Bybit: 'Synced every morning through a read-only API key (Bybit automatic sync, below the uploads); or Bybit → Data Export → Transaction Log → Account Change Details: the Funding and the Unified Trading file, uploaded as is.',
  Freedom24: 'Cash movements synced every morning through the Tradernet API (Freedom24 automatic sync, below the uploads); or the cash-movement table (tradernet_table.xlsx) without a filter -- it must keep the «Сделка» rows. Shares credited as gifts: web cabinet → Отчёты брокера → JSON, from 28.04.2026 to today. Upload as is.',
  'Ziraat Bank': 'Ziraat internet banking → account activity (Hesap Hareketleri) → Excel (.xlsx). Upload as is.',
  Raiffeisen: 'Raiffeisen statements (PDF) → to Claude, who adds them to the combined Raiffeisen CSV.',
  'T-Bank': 'Broker and ЦФА: synced every morning through the T-Invest API (T-Bank broker automatic sync, below the uploads); or T-Investments → reports → broker report (.xlsx) / the Atomyze report, upload as is. Cards, credit card, current and savings accounts, deposit: «Справка о движении средств» (PDF, Russian or English) for each contract, uploaded as is (all together: a transfer between them is named by the other statement); metal account → to Claude.',
  Sber: 'Broker: SberBank Online → Инвестиции → account → Отчёты и справки → broker report (.html, one per month), upload as is. Cards, credit card, savings account, deposits: Выписки и справки → PDF (Russian or English), uploaded as is.',
  Alfa: 'Alfa-Online → statements of the current, salary and Alfa-Account (PDF), uploaded as is; broker account: Alfa-Investments → broker report (XML), uploaded as is.',
  'Yandex Bank': 'Yandex Bank app → statement for each contract (current account, «Сейв») (PDF) → to Claude.',
  'Ozon Bank': 'Ozon Bank app → Ещё → Получить справку → О движении средств → language → основной / накопительный / кредитная карта (PDF, one each) → to Claude.',
  'TBC Bank': 'tbconline.ge → Transactions / the account → statement (CSV or PDF), one for each account and currency (GEL, EUR, My Safe); keep the file name of a CSV. Upload as is.',
  'Credo Bank': 'mycredo.ge → Transactions (screenshots or the statement) → to Claude, who builds the Credo Bank CSV (import-bank-csv).',
  Wise: 'Wise → balance statement, CSV, one per currency. Upload as is.',
  'Crypto.com': 'Crypto.com App → Accounts → History → Export → Crypto Wallet. Upload as is.',
  Binance: 'Checked every morning through a read-only API key (Binance automatic check, below the uploads) -- when the balances differ: Binance → Orders → Assets History → Export → Export Transaction Records; keep the file name (its time zone). Upload as is.',
  Telegram: 'Walt (ex. Wallet) in Telegram → History, and Earn → each coin → history (screenshots or copied text) → to Claude, who builds the Telegram wallet CSV.',
  Trust: 'On-chain wallet: synced from the blockchain by itself (Crypto tab), nothing to upload.',
  cash: 'statements/cash: cash.csv (exact), cash_estimated.csv, cash_extrapolated.csv -- kept by hand with Claude; the counts of cash on hand.',
};
// The accounts whose row opens, on a click, into its parts -- broker, cards
// and current accounts, credit card, deposits and savings, ЦФА -- each with
// its newest record (latest_data_per_part, migrations ...101, ...102):
// Russian banks and Revolut, one statement each part.
// Where a split account's part gets its statements (the part row's tooltip);
// a part not here shows its account's (MP_ACCOUNT_SOURCE).
const MP_OZON_STATEMENT = 'Ozon Bank app → Ещё → Получить справку → О движении средств → language';
const MP_PART_SOURCE = {
  'Ozon Bank|Cards & current accounts': `${MP_OZON_STATEMENT} → основной (PDF) → to Claude.`,
  'Ozon Bank|Credit card': `${MP_OZON_STATEMENT} → кредитная карта (PDF) → to Claude.`,
  'Ozon Bank|Deposits & savings': `${MP_OZON_STATEMENT} → накопительный, each (PDF) → to Claude.`,
  'T-Bank|Broker': 'Synced every morning through the T-Invest API (T-Bank broker automatic sync, below the uploads); or T-Investments → reports → broker report (.xlsx), upload as is.',
  'T-Bank|ЦФА (Atomyze)': 'Synced every morning through the T-Invest API; or the Atomyze report, upload as is.',
  'T-Bank|Cards & current accounts': '«Справка о движении средств» (PDF) for each card / current account contract, uploaded as is.',
  'T-Bank|Credit card': '«Справка о движении средств» (PDF) for the credit card contract, uploaded as is.',
  'T-Bank|Deposits & savings': '«Справка о движении средств» (PDF) for each deposit / savings contract, uploaded as is.',
  'T-Bank|Metals': '«Справка о движении средств» (PDF) for the metal account → to Claude.',
  'Sber|Broker': 'SberBank Online → Инвестиции → account → Отчёты и справки → broker report (.html, one per month), upload as is.',
  'Sber|Cards & current accounts': 'SberBank Online → card → Выписки и справки → PDF, uploaded as is (the credit card too).',
  'Sber|Deposits & savings': 'SberBank Online → savings account → Выписки и справки → PDF, uploaded as is.',
  'Alfa|Cards & current accounts': 'Alfa-Online → statements of the current, salary and Alfa-Account (PDF). Upload as is.',
  'Alfa|Broker': 'Alfa-Investments → broker report (XML). Upload as is.',
  'Yandex Bank|Cards & current accounts': 'Yandex Bank app → statement of the current account (PDF) → to Claude.',
  'Yandex Bank|Deposits & savings': 'Yandex Bank app → statement of «Сейв» (PDF) → to Claude.',
  'Revolut|Broker': 'Revolut app → avatar → Documents & statements → stocks: account statement, CSV (not P&L). Upload as is.',
  'Revolut|Crypto': 'Checked every morning through Revolut X (automatic check, below the uploads); or Revolut app → avatar → Documents & statements → crypto: account statement, CSV. Upload as is.',
  'Revolut|Metals': 'Revolut app → avatar → Documents & statements → gold (XAU): account statement, CSV. Upload as is.',
  'Revolut|Cards & current accounts': 'Revolut app → avatar → Documents & statements → account statement, CSV. Upload as is.',
  'Revolut|Flexible Cash Funds': 'Revolut app → avatar → Documents & statements → Flexible Cash Funds statement, CSV. Upload as is.',
  'Revolut|Deposits & savings': 'Revolut app → avatar → Documents & statements → savings statement, CSV. Upload as is.',
  'Telegram|Custodial wallet': 'Walt (ex. Wallet) in Telegram → History, and Earn → each coin → history (screenshots or copied text) → to Claude, who builds the Telegram wallet CSV.',
  'Telegram|Non-custodial wallet': 'On-chain TON wallet: synced from the blockchain by itself (Crypto tab), nothing to upload.',
};
const MP_SPLIT_ACCOUNTS = new Set(['T-Bank', 'Sber', 'Alfa', 'Yandex Bank', 'Ozon Bank', 'Finuslugi', 'Revolut']);
const MP_PART_ORDER = ['Broker', 'ЦФА (Atomyze)', 'Flexible Cash Funds', 'Crypto', 'Metals', 'Cards & current accounts', 'Credit card', 'Deposits & savings', 'Custodial wallet', 'Non-custodial wallet'];
const mpOpenAccounts = new Set();
// Accounts that could sync by themselves but don't yet (TODO.md, section 17):
// the part it would be, or '' for the whole account.
const MP_TODO_AUTO = { 'T-Bank': 'Broker', Revolut: 'Cards & current accounts', 'Bank of Cyprus': '', Wise: '', Binance: '' };
const todoAuto = '<span style="color:#8b949e">TODO auto</span>';
// Receipts needing attention (migration ...179, design: docs/items-design.
// md, not tracked in git): none yet or no table -- the panel stays empty.
// Waiting ones need nothing from the user (checked again after every
// import); ambiguous ones -- the total matched more than one transaction --
// need a pick.
async function mpRenderReceiptsPanel() {
  const wrap = document.getElementById('mp_receipts_panel');
  if (!wrap || !mpIsSignedIn) return;
  const { data: open } = await sb.from('receipts')
    .select('id, purchased_on, store_printed, chain, currency, total, match_state')
    // (Apple's orders with no charge -- from before the statements -- need nothing: left out)
    .in('match_state', ['waiting', 'ambiguous']).neq('source', 'apple').order('purchased_on', { ascending: false })
    .then(r => r, () => ({ data: [] }));
  const waiting = (open || []).filter(r => r.match_state === 'waiting');
  const ambiguous = (open || []).filter(r => r.match_state === 'ambiguous');
  if (!waiting.length && !ambiguous.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div class="section-title" style="margin-top:14px">Receipts needing attention</div>
    ${waiting.length ? `<p class="note">${waiting.length} receipt${waiting.length === 1 ? '' : 's'} waiting for a matching transaction -- checked again after every import, nothing to do here yet.</p>` : ''}
    ${ambiguous.length ? `<table class="data-table"><thead><tr><th>Date</th><th style="text-align:left">Store</th><th>Total</th><th style="text-align:left">​</th></tr></thead><tbody>${
      ambiguous.map(r => `<tr data-id="${r.id}"><td>${r.purchased_on}</td><td style="text-align:left">${mpEscapeHtml(r.chain || r.store_printed || '')}</td>
        <td>${mpFormatCurrency(r.total, r.currency, true)}</td><td class="receipt-pick" style="text-align:left;color:#58a6ff;cursor:pointer">matches more than one — choose…</td></tr>`).join('')}</tbody></table>` : ''}`;
  wrap.querySelectorAll('.receipt-pick').forEach(cell => cell.addEventListener('click', () => mpPickReceiptMatch(Number(cell.closest('tr').dataset.id))));
}
// The user's pick for an ambiguous receipt (match_receipts' own tie-break
// couldn't narrow it to one): match_state goes straight to 'manual_link',
// same as any other hand-resolved pick -- the matcher never revisits it.
async function mpPickReceiptMatch(receiptId) {
  const { data: cands, error } = await sb.rpc('receipt_match_candidates', { p_receipt_id: receiptId });
  if (error) { alert(error.message); return; }
  if (!cands?.length) { alert('No candidates left for this receipt (they may already be taken by another one) -- reload the page.'); return; }
  const form = mpDialog('Pick the transaction', `
    <select name="pick" size="${Math.min(cands.length, 8)}" style="${MP_FIELD}">
      ${cands.map((c, i) => `<option value="${i}">${mpEscapeHtml(c.account)} · ${c.date_dist} day${c.date_dist === 1 ? '' : 's'} away${c.chain_hit ? ' · chain match' : ''}</option>`).join('')}
    </select>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const c = cands[Number(form.pick.value)];
    const { error: upErr } = await sb.from('receipts')
      .update({ match_state: 'manual_link', tx_source: c.external_source, tx_external_id: c.external_id, updated_at: new Date().toISOString() })
      .eq('id', receiptId);
    if (upErr) { alert(upErr.message); return; }
    await sb.rpc('receipt_resolve_place', { p_receipt_id: receiptId, p_account: c.account }).catch(() => { /* best effort */ });
    form.closest('dialog').close();
    mpExpCache = null;
    mpRenderReceiptsPanel();
  });
}
// The shared product catalog with what this user paid (migrations ...179,
// ...180; design: docs/items-design.md, not tracked in git): every product
// not merged into another, its brand, size and description, and from this
// user's own receipts the purchases, shops and the last / lowest / highest
// price in dollars at each day's rate (other users' purchases aren't visible
// to this user, so a product only they bought shows no prices here). A click
// on a row opens the product's dialog. Sorted by name; the "Last price"
// header sorts by price, a second click on a header reverses it.
// Apple's purchases (receipts of source 'apple', migration ...211), apart from
// the products: each subscription or purchase -- its title and app -- with
// what it costs now, what it cost first, how often it was paid, and when it
// renews or ended (from the latest payment's period: "Renews 12 Dec 2026",
// "Expires: 29 Nov 2026", "12 Oct 2026 - 12 Nov 2026"). Prices in the
// currency Apple charged. A click on a subscription opens its price history:
// every change of price, with the month it came. Subscriptions still running
// first, by their next date; then the ended ones; the one-off purchases folded.
function mpAppleDay(s) {
  const m = String(s || '').match(/(\d{1,2}) ([A-Za-z]+)\.? (\d{4})/g);
  if (!m) return null;
  const last = m[m.length - 1].match(/(\d{1,2}) ([A-Za-z]+)\.? (\d{4})/);
  const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[last[2].slice(0, 3).toLowerCase()];
  return mon ? `${last[3]}-${String(mon).padStart(2, '0')}-${last[1].padStart(2, '0')}` : null;
}
// One Apple subscription's / purchase's price history (a click on it in a
// transaction's Items, or in the Products tab's Apple table): every payment
// with its day, price and period, the price's changes marked; a chart of the
// price over time, as a product's (mpOpenProductView), in the currency Apple
// charged or -- the toggle -- in dollars at each day's rate (the
// apple_purchase_prices view, migration ...212).
// The service an Apple purchase belongs to: its app's first word -- "Tinder Dating App:
// Meet & Date" and "Tinder: новые знакомства" are both Tinder's; Yandex's app is named
// in either language.
function mpAppleService(app, title) {
  const w = (app || title || '').toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] || '';
  return { яндекс: 'yandex' }[w] || w;
}
// How many months each payment of one Apple plan paid for (pays oldest first: day,
// price, ccy, note): the period it names ("12 Oct 2026 - 12 Nov 2026", "Renews 12 Dec
// 2026" from its day, "Monthly" / "Yearly"); else the title ("Annual", "3 months");
// else -- a payment from before Apple named periods (Tinder Gold, 2018) -- by the next
// payment: a month later, a month; a long gap, when its price is that much over the plan's
// cheapest (21.12.2018: 3,590 ₽ after months of 999 ₽, the next payment a year later: a
// year); else the period of the nearest payment of about its price; else a month.
function mpApplePeriods(pays, title) {
  const snap = d => (d > 300 ? 12 : d > 150 ? 6 : d > 80 ? 3 : 1);
  const named = pays.map(p => {
    const dates = [...(p.note || '').matchAll(/\d{1,2} [A-Za-z]+\.? \d{4}/g)].map(m => mpAppleDay(m[0]));
    let span = null;
    if (dates.length >= 2) span = (Date.parse(dates[1]) - Date.parse(dates[0])) / 864e5;
    else if (dates.length === 1 && /^(Renews|Expires)/i.test(p.note)) span = (Date.parse(dates[0]) - Date.parse(p.day)) / 864e5;
    else if (/^Monthly$/i.test(p.note)) span = 30;
    else if (/^Yearly$/i.test(p.note)) span = 365;
    return span > 0 ? snap(span) : null;
  });
  const byTitle = /year|annual|12[- ]month/i.test(title) ? 12 : /6[- ]month/i.test(title) ? 6 : /3[- ]month/i.test(title) ? 3 : null;
  return pays.map((p, i) => {
    if (named[i]) return named[i];
    if (byTitle) return byTitle;
    const next = pays[i + 1];
    if (next) {
      const m = snap((Date.parse(next.day) - Date.parse(p.day)) / 864e5);
      // paid again a month later: a month's (Yandex Plus, 229 ₽ every month of 2017)
      if (m === 1) return 1;
      const cheapest = Math.min(...pays.filter(q => q.ccy === p.ccy).map(q => q.price));
      if (p.price >= 2 * cheapest) return m;
    }
    // the last one, or one after a pause: the period of the nearest payment of about its price
    // (a year's 1,690 ₽ says nothing of a 229 ₽ payment)
    const like = q => q.ccy === p.ccy && Math.abs(q.price / p.price - 1) <= 0.3;
    for (let d = 1; d < pays.length; d++) {
      if (named[i - d] && like(pays[i - d])) return named[i - d];
      if (named[i + d] && like(pays[i + d])) return named[i + d];
    }
    return 1;
  });
}
const MP_APPLE_TERM = { 1: 'a month', 3: '3 months', 6: 'half a year', 12: 'a year' };
async function mpOpenAppleHistory(title, nameEn) {
  const app = (nameEn || '').includes(' · ') ? nameEn.split(' · ').slice(1).join(' · ') : (/^iCloud\+/.test(title) ? 'iCloud' : '');
  const appOf = r => (r.name_en || '').includes(' · ') ? r.name_en.split(' · ').slice(1).join(' · ') : (/^iCloud\+/.test(title) ? 'iCloud' : '');
  let res = await sb.from('apple_purchase_prices').select('day, currency, price, price_usd, name_en, note').eq('name_printed', title);
  // the view not there yet (migration ...212): the lines alone, no dollars
  if (res.error) {
    res = await sb.from('receipt_items').select('name_en, line_total, note, receipts!inner(purchased_on, currency, source)')
      .eq('receipts.source', 'apple').eq('name_printed', title);
    if (res.error) { alert(res.error.message); return; }
    res.data = (res.data || []).map(r => ({ day: r.receipts.purchased_on, currency: r.receipts.currency, price: r.line_total, price_usd: null, name_en: r.name_en, note: r.note }));
  }
  // the same plan of the same service, whatever the app called itself then and in whichever currency
  const pays = (res.data || []).filter(r => mpAppleService(appOf(r), title) === mpAppleService(app, title))
    .map(r => ({ day: r.day, ccy: r.currency, price: Number(r.price), usd: r.price_usd == null ? null : Number(r.price_usd), note: r.note || '' }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const hasUsd = pays.some(p => p.usd != null);
  const currencies = [...new Set(pays.map(p => p.ccy))];
  const dmy = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  const money = (v, c) => (c === 'USD' ? (v == null ? '—' : `$${v.toFixed(2)}`) : mpFormatCurrency(v, c, true));
  const pct = (a, b) => (b ? (a / b - 1) * 100 : null);
  const pctHtml = v => v == null || !Number.isFinite(v) || Math.abs(v) < 0.5 ? ''
    : `<span style="color:${v > 0 ? '#ff9500' : '#3fb950'}">${v > 0 ? '+' : ''}${v.toFixed(0)}%</span>`;
  const dlg = document.createElement('dialog');
  dlg.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:16px 18px;min-width:320px;width:min(92vw,720px)';
  dlg.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><b>${mpEscapeHtml(title)}${app && app !== title ? ` <span style="color:#8b949e;font-weight:normal">· ${mpEscapeHtml(app)}</span>` : ''}</b><button type="button" data-act="close">✕</button></div>
    <label${hasUsd ? '' : ' style="color:#6a7381" title="dollars come once the database is updated"'}><input type="checkbox" id="mp_apple_usd"${hasUsd ? ' checked' : ' disabled'}> show in USD</label>
    <div id="mp_apple_chart" style="height:280px"></div>
    <p class="note" style="margin:0" id="mp_apple_sum"></p>
    <div style="max-height:320px;overflow:auto"><table class="data-table"><thead><tr><th>Paid</th><th>Price</th><th>USD</th><th>For</th><th>A month</th><th>Change</th><th style="text-align:left">Period</th></tr></thead><tbody id="mp_apple_rows"></tbody></table></div>
  </div>`;
  document.body.appendChild(dlg);
  // opened before the chart is drawn (Plotly measures a closed dialog as empty); removed however it's closed
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  dlg.querySelector('[data-act=close]').onclick = () => dlg.close();
  // what each payment paid for -- a month, half a year, a year -- and so its price of a month:
  // the chart and the changes are of that (a year's price is no rise over a month's)
  const terms = mpApplePeriods(pays, title);
  pays.forEach((p, i) => { p.months = terms[i]; });
  const TERM_COLOR = { 1: '#58a6ff', 3: '#d2a8ff', 6: '#f0883e', 12: '#3fb950' };
  const draw = () => {
    const usd = dlg.querySelector('#mp_apple_usd').checked;
    const val = p => (usd ? p.usd : p.price);
    const perMonth = p => (val(p) == null ? null : val(p) / p.months);
    const unit = p => (usd ? 'USD' : p.ccy);
    const shown = usd ? pays.filter(p => p.usd != null) : pays;
    const groups = usd ? [['USD', shown]] : currencies.map(c => [c, pays.filter(p => p.ccy === c)]);
    const kinds = [...new Set(shown.map(p => p.months))].sort((a, b) => a - b);
    const traces = [];
    for (const [c, pts] of groups) {
      // the price of a month through time (a subscription's price holds until the next payment: steps)
      traces.push({ x: pts.map(p => p.day), y: pts.map(perMonth), name: c, mode: 'lines', type: 'scatter', hoverinfo: 'skip',
        line: { shape: usd ? 'linear' : 'hv', color: '#4c8bf5', width: 2 }, showlegend: false });
      // each payment, coloured by what it paid for
      for (const k of kinds) {
        const kp = pts.filter(p => p.months === k);
        if (!kp.length) continue;
        traces.push({ x: kp.map(p => p.day), y: kp.map(perMonth), type: 'scatter', mode: 'markers',
          name: `paid for ${MP_APPLE_TERM[k]}${groups.length > 1 ? ` (${c})` : ''}`, marker: { color: TERM_COLOR[k], size: k === 1 ? 7 : 11 },
          text: kp.map(p => `${dmy(p.day)}: paid ${money(val(p), unit(p)).replace(/<[^>]+>/g, '')} for ${MP_APPLE_TERM[k]}${k > 1 ? ` = ${money(perMonth(p), unit(p)).replace(/<[^>]+>/g, '')} a month` : ''}`),
          hovertemplate: '%{text}<extra></extra>' });
      }
    }
    Plotly.react(dlg.querySelector('#mp_apple_chart'), traces, {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#c9d1d9' },
      margin: { l: 50, r: 10, t: 10, b: 30 }, showlegend: kinds.length > 1 || groups.length > 1, legend: { orientation: 'h', y: 1.12 },
      yaxis: { rangemode: 'tozero', title: { text: `a month, ${usd ? 'USD' : currencies.join(' / ')}`, font: { size: 11 } } },
    }, { ...CONFIG, displayModeBar: false });
    // the whole way, a month's price first and last
    const first = shown[0], last = shown[shown.length - 1];
    dlg.querySelector('#mp_apple_sum').innerHTML = `${pays.length} payment(s), ${dmy(pays[0].day)} – ${dmy(last.day)}`
      + (first && last && unit(first) === unit(last) ? `; a month: ${money(perMonth(first), unit(first))} → ${money(perMonth(last), unit(last))} ${pctHtml(pct(perMonth(last), perMonth(first)))}` : '')
      + '. The chart: the price of a month; a payment for longer is its price over its months.';
    dlg.querySelector('#mp_apple_rows').innerHTML = shown.slice().reverse().map((p, i, arr) => {
      const prev = arr[i + 1];
      // both prices always; a month's price and its change in the one on the chart
      return `<tr><td>${dmy(p.day)}</td><td>${money(p.price, p.ccy)}</td><td>${money(p.usd, 'USD')}</td>
        <td style="color:${TERM_COLOR[p.months]}">${MP_APPLE_TERM[p.months]}</td><td>${money(perMonth(p), unit(p))}</td>
        <td>${prev && unit(prev) === unit(p) ? pctHtml(pct(perMonth(p), perMonth(prev))) : ''}</td>
        <td style="text-align:left;color:#8b949e">${mpEscapeHtml(p.note)}</td></tr>`;
    }).join('');
  };
  dlg.querySelector('#mp_apple_usd').addEventListener('change', draw);
  draw();
}
async function mpRenderApplePurchases() {
  const wrap = document.getElementById('mp_apple_panel');
  if (!wrap || !mpIsSignedIn) return;
  // with dollars at each day's rate (apple_purchase_prices, migration ...212); the view not
  // there yet: the lines alone
  const load = async (q, map) => {
    const { rows, error } = await mpFetchAllRows(q);
    if (error) throw error;
    return rows.map(map);
  };
  let rows;
  try {
    rows = await load(() => sb.from('apple_purchase_prices').select('name_printed, name_en, price, price_usd, note, day, currency').order('day'),
      r => ({ ...r, price: Number(r.price), usd: r.price_usd == null ? null : Number(r.price_usd) }));
  } catch {
    try {
      rows = await load(() => sb.from('receipt_items').select('name_printed, name_en, line_total, note, receipts!inner(purchased_on, currency, source)').eq('receipts.source', 'apple'),
        r => ({ name_printed: r.name_printed, name_en: r.name_en, note: r.note, price: Number(r.line_total), usd: null, day: r.receipts.purchased_on, currency: r.receipts.currency }));
    } catch { wrap.innerHTML = ''; return; }
  }
  if (!rows.length) { wrap.innerHTML = ''; return; }
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map();
  for (const r of rows) {
    const title = r.name_printed;
    const app = (r.name_en || '').includes(' · ') ? r.name_en.split(' · ').slice(1).join(' · ') : (/^iCloud\+/.test(title) ? 'iCloud' : '');
    // one plan of one service, whichever currency it was paid in (iCloud+ 200 GB in roubles, euros, lira)
    const key = `${mpAppleService(app, title)}|${title.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { title, app, pays: [] });
    groups.get(key).pays.push({ day: r.day, price: r.price, usd: r.usd, ccy: r.currency, app, note: r.note || '' });
  }
  const list = [...groups.values()].map(g => {
    g.pays.sort((a, b) => a.day.localeCompare(b.day));
    const last = g.pays[g.pays.length - 1];
    g.sub = g.pays.some(p => p.note);
    g.app = last.app;
    g.ccy = last.ccy;
    // the first price in the currency it's paid in now (a price in another currency is no comparison)
    g.first = g.pays.find(p => p.ccy === g.ccy).price;
    g.last = last.price;
    g.lastDay = last.day;
    // what it cost in all, in its currency when it was only ever one
    g.spent = g.pays.every(p => p.ccy === g.ccy) ? g.pays.reduce((s, p) => s + p.price, 0) : null;
    g.lastUsd = last.usd;
    g.spentUsd = g.pays.some(p => p.usd == null) ? null : g.pays.reduce((s, p) => s + p.usd, 0);
    // its period's end: the date the latest payment names, else a month / a year after it
    const named = mpAppleDay(last.note);
    const step = /year|annual|12[- ]month/i.test(`${last.note} ${g.title}`) ? 365 : 31;
    g.end = named || (g.sub ? new Date(Date.parse(last.day) + step * 864e5).toISOString().slice(0, 10) : null);
    g.renews = /^Renews/i.test(last.note);
    g.active = g.sub && g.end >= today;
    // the price's changes: each new price with the day it came
    g.changes = g.pays.filter((p, i) => i === 0 || p.price !== g.pays[i - 1].price || p.ccy !== g.pays[i - 1].ccy);
    // how long each payment lasted (mpApplePeriods); payments a year by the latest one's
    g.months = mpApplePeriods(g.pays, g.title);
    g.perYear = 12 / g.months[g.months.length - 1];
    // the first price against the price now, a month of each (a year's price is no rise
    // over a month's), in the currency it's paid in now
    const fi = g.pays.findIndex(p => p.ccy === g.ccy);
    g.firstMonths = g.months[fi];
    g.monthNow = g.last / g.months[g.months.length - 1];
    g.monthFirst = g.first / g.firstMonths;
    g.yearUsd = g.lastUsd == null ? null : g.lastUsd * g.perYear;
    return g;
  });
  // one service's subscriptions together (Tinder Gold, Platinum and Plus; a month's and a
  // year's plan): by the app's first word -- "Tinder Dating App: Meet & Date", "Tinder:
  // новые знакомства" are both Tinder's; Yandex's app is named in either language
  const serviceKey = g => mpAppleService(g.app, g.title);
  const serviceName = g => (g.app || g.title).split(/\s*(?::|\||–|—|-\s|,)\s*/)[0].trim();
  const subs = list.filter(g => g.sub);
  const services = new Map();
  for (const g of subs) {
    const k = serviceKey(g);
    if (!services.has(k)) services.set(k, []);
    services.get(k).push(g);
  }
  const svcList = [...services.values()].map(items => {
    items.sort((a, b) => (b.active - a.active) || b.lastDay.localeCompare(a.lastDay));
    const latest = [...items].sort((a, b) => b.lastDay.localeCompare(a.lastDay))[0];
    const active = items.filter(g => g.active);
    const ccys = new Set(items.map(g => g.ccy));
    return {
      items, name: serviceName(latest), active: active.length > 0, renews: active.some(g => g.renews), lastDay: latest.lastDay,
      end: active.length ? active.map(g => g.end).sort()[0] : latest.end,
      // a year of what runs now (each running plan at its price now); none running: the latest plan's
      yearUsd: active.length ? active.reduce((s, g) => s + (g.yearUsd ?? 0), 0) : latest.yearUsd,
      payments: items.reduce((s, g) => s + g.pays.length, 0),
      spent: ccys.size === 1 && items.every(g => g.spent != null) ? items.reduce((s, g) => s + g.spent, 0) : null, ccy: ccys.size === 1 ? latest.ccy : null,
      spentUsd: items.some(g => g.spentUsd == null) ? null : items.reduce((s, g) => s + g.spentUsd, 0),
    };
  }).sort((a, b) => (b.active - a.active) || (a.active ? a.end.localeCompare(b.end) : b.lastDay.localeCompare(a.lastDay)));
  const once = list.filter(g => !g.sub).sort((a, b) => b.lastDay.localeCompare(a.lastDay));
  const money = (v, c) => mpFormatCurrency(v, c, true);
  const usd = v => (v == null ? '—' : `$${v.toFixed(2)}`);
  const dmy = d => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '';
  const name = g => `${mpEscapeHtml(g.title)}${g.app && g.app !== g.title ? `<div style="font-size:0.85em;color:#6a7381">${mpEscapeHtml(g.app)}</div>` : ''}`;
  const change = g => {
    // a month of each: a year's price against a month's is no rise
    if (!g.monthFirst || Math.abs(g.monthNow - g.monthFirst) < 0.005) return '';
    const pct = (g.monthNow / g.monthFirst - 1) * 100;
    if (Math.abs(pct) < 0.5) return '';
    return `<span style="color:${pct > 0 ? '#ff9500' : '#3fb950'}">${pct > 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
  };
  const status = g => g.active ? `${g.renews ? 'renews' : 'until'} ${dmy(g.end)}` : `<span style="color:#6a7381">ended ${dmy(g.end)}</span>`;
  const every = n => ({ 12: 'a month', 4: 'a quarter', 2: 'half a year', 1: 'a year' }[n]);
  const renewingYear = subs.filter(g => g.active && g.renews).reduce((s, g) => s + (g.yearUsd ?? 0), 0);
  const runningYear = subs.filter(g => g.active).reduce((s, g) => s + (g.yearUsd ?? 0), 0);
  let n = 0;
  const flat = [];
  // a group's rows show while every group it's in is open (mpAppleOpen: closed at first, kept across re-draws)
  const shut = parents => parents.some(p => !mpAppleOpen.has(p));
  const subRow = (g, indent, parents = []) => {
    flat.push(g);
    return `<tr class="apple-sub" data-i="${n++}" data-in="${mpEscapeHtml(parents.join(' '))}"${shut(parents) ? ' hidden' : ''} style="cursor:pointer${g.active ? '' : ';color:#8b949e'}">
      <td style="text-align:left;padding-left:${12 + 22 * (indent || 0)}px">${name(g)}</td><td>${status(g)}</td><td>${money(g.last, g.ccy)}<div style="font-size:0.85em;color:#6a7381">${every(g.perYear)}</div></td><td>${usd(g.lastUsd)}</td>
      <td>${g.changes.length > 1 ? `${money(g.first, g.ccy)}<div style="font-size:0.85em;color:#6a7381">${MP_APPLE_TERM[g.firstMonths]}</div>` : ''}</td><td title="the price of a month, first and now">${change(g)}</td><td>${g.pays.length}</td><td>${money(g.spent, g.ccy)}</td><td>${usd(g.spentUsd)}</td><td>${usd(g.yearUsd)}</td><td>${dmy(g.lastDay)}</td></tr>`;
  };
  // a group's own row: its plans' sums (a year of what runs now, else of its latest plan)
  const sumOf = items => {
    const latest = [...items].sort((a, b) => b.lastDay.localeCompare(a.lastDay))[0];
    const active = items.filter(g => g.active);
    const ccys = new Set(items.map(g => g.ccy));
    return {
      items, active: active.length > 0, renews: active.some(g => g.renews), lastDay: latest.lastDay,
      end: active.length ? active.map(g => g.end).sort()[0] : latest.end,
      yearUsd: active.length ? active.reduce((s, g) => s + (g.yearUsd ?? 0), 0) : latest.yearUsd,
      payments: items.reduce((s, g) => s + g.pays.length, 0),
      spent: ccys.size === 1 && items.every(g => g.spent != null) ? items.reduce((s, g) => s + g.spent, 0) : null, ccy: latest.ccy,
      spentUsd: items.some(g => g.spentUsd == null) ? null : items.reduce((s, g) => s + g.spentUsd, 0),
    };
  };
  const groupRow = (label, sub, s, indent, id, parents = []) => `<tr class="apple-grp" data-grp="${mpEscapeHtml(id)}" data-in="${mpEscapeHtml(parents.join(' '))}"${shut(parents) ? ' hidden' : ''} style="cursor:pointer${s.active ? '' : ';color:#8b949e'}" title="Click to show or hide its plans"><td style="text-align:left;padding-left:${12 + 22 * indent}px"><span class="apple-tog" style="display:inline-block;width:14px">${mpAppleOpen.has(id) ? '▾' : '▸'}</span><b>${mpEscapeHtml(label)}</b><div style="font-size:0.85em;color:#6a7381;padding-left:14px">${sub}</div></td>
        <td>${s.active ? `${s.renews ? 'renews' : 'until'} ${dmy(s.end)}` : `<span style="color:#6a7381">ended</span>`}</td><td></td><td></td><td></td><td></td>
        <td><b>${s.payments}</b></td><td>${s.spent == null ? '' : `<b>${money(s.spent, s.ccy)}</b>`}</td><td><b>${usd(s.spentUsd)}</b></td><td><b>${usd(s.yearUsd)}</b></td><td>${dmy(s.lastDay)}</td></tr>`;
  // YouTube: its own plans (Premium), and the channels' memberships ("Политик", "Мэр" --
  // a channel's tiers, named by the channel) together under one row of their own
  const svcRow = s => {
    if (s.items.length === 1) return subRow(s.items[0], 0);
    const members = mpAppleService(s.items[0].app, s.items[0].title) === 'youtube' ? s.items.filter(g => !/youtube/i.test(g.title)) : [];
    const own = s.items.filter(g => !members.includes(g));
    const id = mpAppleService(s.items[0].app, s.items[0].title), sub = `${id}/members`;
    return groupRow(s.name, `${s.items.length} plans`, s, 0, id)
      + own.map(g => subRow(g, 1, [id])).join('')
      + (members.length > 1 ? groupRow('Channel memberships', `${members.length} tiers`, sumOf(members), 1, sub, [id]) + members.map(g => subRow(g, 2, [id, sub])).join('')
        : members.map(g => subRow(g, 1, [id])).join(''));
  };
  const body = svcList.map(svcRow).join('');
  wrap.innerHTML = `<div class="section-title" style="margin-top:22px">Apple purchases &amp; subscriptions</div>
    <p class="note">From Apple's purchase history (upload the text of reportaproblem.apple.com in My Portfolio). Prices in the currency Apple charged and in dollars at each day's rate;
      "Per year, USD": the price now times the payments in a year. One service's plans are grouped under it (click a group to open it).
      ${subs.filter(g => g.active).length} subscription(s) running: <b>${usd(runningYear)} a year</b>, of it renewing by itself ${usd(renewingYear)}. Click one for its price history.</p>
    <div style="max-height:620px;overflow:auto"><table class="data-table"><thead><tr><th style="text-align:left">Subscription</th><th>Status</th><th>Price now</th><th>Now, USD</th>
      <th>First price</th><th>Change</th><th>Payments</th><th>Spent</th><th>Spent, USD</th><th>Per year, USD</th><th>Last paid</th></tr></thead>
      <tbody>${body}</tbody></table></div>
    <details style="margin-top:10px"><summary class="note" style="cursor:pointer">One-off purchases: ${once.length} (apps, games, in-app purchases, films)</summary>
      <div style="max-height:420px;overflow:auto"><table class="data-table"><thead><tr><th style="text-align:left">Item</th><th>Price</th><th>USD</th><th>Times</th><th>Spent</th><th>Spent, USD</th><th>Last bought</th></tr></thead>
      <tbody>${once.map(g => `<tr><td style="text-align:left">${name(g)}</td><td>${money(g.last, g.ccy)}</td><td>${usd(g.lastUsd)}</td><td>${g.pays.length}</td><td>${money(g.spent, g.ccy)}</td><td>${usd(g.spentUsd)}</td><td>${dmy(g.lastDay)}</td></tr>`).join('')}</tbody></table></div>
    </details>`;
  wrap.querySelectorAll('tr.apple-sub').forEach(tr => tr.addEventListener('click', () => {
    const g = flat[Number(tr.dataset.i)];
    mpOpenAppleHistory(g.title, g.app ? `${g.title} · ${g.app}` : g.title);
  }));
  wrap.querySelectorAll('tr.apple-grp').forEach(tr => tr.addEventListener('click', () => {
    const id = tr.dataset.grp;
    if (mpAppleOpen.has(id)) mpAppleOpen.delete(id); else mpAppleOpen.add(id);
    tr.querySelector('.apple-tog').textContent = mpAppleOpen.has(id) ? '▾' : '▸';
    for (const r of wrap.querySelectorAll('tr[data-in]')) {
      const parents = r.dataset.in ? r.dataset.in.split(' ') : [];
      if (parents.length) r.hidden = shut(parents);
    }
  }));
}
const mpAppleOpen = new Set();
let mpProductSort = { key: 'name', dir: 1 };
async function mpRenderProductList() {
  const wrap = document.getElementById('mp_products_panel');
  if (!wrap || !mpIsSignedIn) return;
  const page = mpFetchAll;
  let products, prices;
  try {
    products = await page(() => sb.from('products').select('id, name_en, brand, size_value, size_unit, note').is('merged_into', null).order('name_en').order('id'));
    // product_prices comes by day then item, so the last row of a product is its latest purchase;
    // migration ...180's `store` column not there yet: the older `chain`
    prices = await page(() => sb.from('product_prices').select('product_id, day, item_id, store, unit_price_usd').order('day').order('item_id'))
      .catch(() => page(() => sb.from('product_prices').select('product_id, day, item_id, chain, unit_price_usd').order('day').order('item_id')));
  } catch { wrap.innerHTML = ''; return; }   // none yet or no table: nothing to show
  if (!products.length) { wrap.innerHTML = ''; return; }
  const by = new Map();
  for (const p of prices) {
    const a = by.get(p.product_id) || { n: 0, shops: new Set(), min: null, max: null, last: null, lastDay: '' };
    const usd = p.unit_price_usd == null ? null : Number(p.unit_price_usd);
    a.n++;
    const shop = p.store ?? p.chain;
    if (shop) a.shops.add(shop);
    if (usd != null && Number.isFinite(usd)) {
      a.min = a.min == null ? usd : Math.min(a.min, usd);
      a.max = a.max == null ? usd : Math.max(a.max, usd);
    }
    a.last = usd != null && Number.isFinite(usd) ? usd : null;   // the latest purchase's, none if it had no rate
    a.lastDay = p.day;
    by.set(p.product_id, a);
  }
  const list = products.map(p => ({ ...p, ...(by.get(p.id) || { n: 0, shops: new Set(), min: null, max: null, last: null, lastDay: '' }) }));
  const { key, dir } = mpProductSort;
  list.sort((x, y) => {
    if (key === 'last') {   // no price last, whichever way it's sorted
      if (x.last == null || y.last == null) return (x.last == null) - (y.last == null) || x.name_en.localeCompare(y.name_en);
      return (x.last - y.last) * dir || x.name_en.localeCompare(y.name_en);
    }
    return x.name_en.localeCompare(y.name_en) * dir;
  });
  const usd = v => (v == null ? '—' : `$${v.toFixed(2)}`);
  const arrow = k => (key === k ? (dir === 1 ? ' ▲' : ' ▼') : '');
  const head = (k, label, left) => `<th data-sort="${k}" style="cursor:pointer${left ? ';text-align:left' : ''}">${label}${arrow(k)}</th>`;
  wrap.innerHTML = `<div class="section-title" style="margin-top:14px">Products</div>
    <p class="note">${list.length} product${list.length === 1 ? '' : 's'}. Prices are in dollars at each day's rate, from your own receipts. Click a row for its history, brand, size and description.</p>
    <div style="max-height:420px;overflow:auto"><table class="data-table"><thead><tr>
      ${head('name', 'Product', true)}<th style="text-align:left">Brand</th><th>Size</th><th style="text-align:left">Description</th>
      <th>Purchases</th><th style="text-align:left">Shops</th>${head('last', 'Last price')}<th>Lowest</th><th>Highest</th><th>Last purchase</th></tr></thead>
      <tbody>${list.map(p => `<tr data-id="${p.id}" style="cursor:pointer">
        <td style="text-align:left">${mpEscapeHtml(p.name_en)}</td><td style="text-align:left">${mpEscapeHtml(p.brand || '')}</td>
        <td>${p.size_value != null ? `${Number(p.size_value)} ${mpEscapeHtml(p.size_unit || '')}` : ''}</td>
        <td style="text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${mpEscapeHtml(p.note || '')}">${mpEscapeHtml(p.note || '')}</td>
        <td>${p.n}</td><td style="text-align:left">${mpEscapeHtml([...p.shops].join(', '))}</td>
        <td>${usd(p.last)}</td><td>${usd(p.min)}</td><td>${usd(p.max)}</td><td>${p.lastDay}</td></tr>`).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    mpProductSort = { key: k, dir: mpProductSort.key === k ? -mpProductSort.dir : 1 };
    mpRenderProductList();
  }));
  wrap.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => mpOpenProductView(Number(tr.dataset.id))));
}
async function mpRenderLatestSources() {
  const wrap = document.getElementById('mp_latest_sources');
  try {
    // the dates come worked out by the database (latest_data_per_account, 057)
    const { data: lat, error: e1 } = await sb.rpc('latest_data_per_account');
    if (e1) throw e1;
    const acc = new Map();
    for (const r of lat || []) {
      const days = [r.bank_day, r.trade_day, r.exchange_day, r.synced_day].filter(Boolean).sort();
      if (!days.length) continue;
      acc.set(r.account, {
        day: days[days.length - 1], bankDay: r.bank_day || '', bankRows90: r.bank_rows_90d || 0,
        // an on-chain wallet syncs by itself -- dated by the last sync, no reminder
        auto: !r.bank_day && !r.trade_day && !r.exchange_day && !!r.synced_day,
      });
    }
    // the latest upload of a statement for the account counts too
    // -- by the end of the period it covers where that's known (an old
    // statement uploaded today doesn't make the account fresh)
    const { data: ups } = await sb.from('statement_uploads').select('account, kind, file_name, uploaded_at, period_from, period_to')
      .order('uploaded_at', { ascending: false }).limit(5000);
    for (const u of ups || []) {
      const a = acc.get(u.account);
      if (!a) continue;
      const day = u.period_to || u.uploaded_at.slice(0, 10);
      if (!a.uploaded || day > a.uploaded) a.uploaded = day;
    }
    // IBKR synced by itself (sync-ibkr): its last good run's period end counts
    // as a statement's, and the row tells when the token runs out
    const { data: flex } = await sb.rpc('ibkr_flex_status');
    const ibkrFlex = (flex || [])[0];
    if (ibkrFlex?.token_set && acc.has('IBKR')) {
      const a = acc.get('IBKR');
      let last = {};
      try { last = JSON.parse(ibkrFlex.last_sync_result || '{}'); } catch { /* not JSON */ }
      const to = (last.period || '').split('..')[1];
      if (to && (!a.uploaded || to > a.uploaded)) a.uploaded = to;
      a.flex = { expires: ibkrFlex.token_expires, error: last.error || '' };
    }
    // Bybit likewise (sync-bybit): its key's end date comes from Bybit
    const { data: bst } = await sb.rpc('bybit_api_status');
    const bybitApi = (bst || [])[0];
    if (bybitApi?.secret_set && acc.has('Bybit')) {
      const a = acc.get('Bybit');
      let last = {};
      try { last = JSON.parse(bybitApi.last_sync_result || '{}'); } catch { /* not JSON */ }
      const to = (last.period || '').split('..')[1];
      if (to && (!a.uploaded || to > a.uploaded)) a.uploaded = to;
      a.flex = { expires: bybitApi.key_expires, error: last.error || '', label: 'key' };
    }
    // Freedom24 likewise (sync-freedom24): its keys don't end
    const { data: fst } = await sb.rpc('freedom24_api_status');
    const f24Api = (fst || [])[0];
    if (f24Api?.secret_set && acc.has('Freedom24')) {
      const a = acc.get('Freedom24');
      let last = {};
      try { last = JSON.parse(f24Api.last_sync_result || '{}'); } catch { /* not JSON */ }
      const to = (last.period || '').split('..')[1];
      if (to && (!a.uploaded || to > a.uploaded)) a.uploaded = to;
      a.flex = { expires: null, error: last.error || '', label: 'key', perpetual: true };
    }
    // T-Bank's broker part synced by itself (sync-tbank): "auto" on that part
    // only -- the cards and deposits are still statements
    const { data: tst } = await sb.rpc('tbank_api_status');
    const tbankApi = (tst || [])[0];
    const partAuto = new Map();   // "account|part" -> { error, to }
    if (tbankApi?.token_set && tbankApi.last_sync_at) {
      let last = {};
      try { last = JSON.parse(tbankApi.last_sync_result || '{}'); } catch { /* not JSON */ }
      partAuto.set('T-Bank|Broker', { error: last.error || '', to: last.period_to || '' });
      partAuto.set('T-Bank|ЦФА (Atomyze)', { error: last.error || '', to: last.period_to || '' });
    }
    // Binance checked by itself (sync-binance): balances only -- the history is
    // current (dated by the check) while they agree with the stored export;
    // when they don't, the export is due (orange)
    const { data: bst2 } = await sb.rpc('binance_api_status');
    const binanceApi = (bst2 || [])[0];
    if (binanceApi?.secret_set && binanceApi.last_sync_at && acc.has('Binance')) {
      const a = acc.get('Binance');
      let last = {};
      try { last = JSON.parse(binanceApi.last_sync_result || '{}'); } catch { /* not JSON */ }
      const differ = last.differences || [];
      if (!last.error && !differ.length && last.checked_at && (!a.uploaded || last.checked_at > a.uploaded)) a.uploaded = last.checked_at;
      a.flex = { expires: null, error: last.error || '', label: 'key', perpetual: true, check: true,
        warning: differ.length ? `balances differ: ${differ.join('; ')} -- upload a new export` : '' };
    }
    // Revolut's crypto checked by itself (sync-revolutx), as Binance's: its
    // Crypto part current (dated by the check) while it agrees with the
    // stored statement, orange when not
    const { data: rxs } = await sb.rpc('revolutx_api_status');
    const revxApi = (rxs || [])[0];
    if (revxApi?.secret_set && revxApi.last_sync_at) {
      let last = {};
      try { last = JSON.parse(revxApi.last_sync_result || '{}'); } catch { /* not JSON */ }
      const differ = last.differences || [];
      partAuto.set('Revolut|Crypto', { error: last.error || '', to: !last.error && !differ.length ? last.checked_at || '' : '',
        perpetual: true, check: true, warning: differ.length ? `balances differ: ${differ.join('; ')} -- upload a new crypto statement` : '' });
    }
    // Revolut, Bank of Cyprus, Wise through Open Banking (sync-openbanking):
    // the consent's end as the key's; Revolut on its accounts part only (its
    // funds, savings, Invest, metals are statements)
    const { data: ebRows } = await sb.rpc('enablebanking_status');
    for (const [bank, name] of Object.entries(MP_EB_BANKS)) {
      const s = (ebRows || []).find(r => r.broker === `eb:${bank}`);
      if (!s?.session_set || !s.last_sync_at || !acc.has(name)) continue;
      let last = {};
      try { last = JSON.parse(s.last_sync_result || '{}'); } catch { /* not JSON */ }
      // the data is good up to the last good run's day, a failed run's too (last_ok)
      const flex = { expires: s.valid_until, error: last.error || '', label: 'consent', to: last.period_to || last.last_ok || '' };
      if (bank === 'revolut') { partAuto.set('Revolut|Cards & current accounts', flex); continue; }
      const a = acc.get(name);
      if (flex.to && (!a.uploaded || flex.to > a.uploaded)) a.uploaded = flex.to;
      a.flex = flex;
    }
    for (const a of acc.values()) a.record = a.day, a.day = a.uploaded && a.uploaded > a.day ? a.uploaded : a.day;
    if (!acc.size) { wrap.innerHTML = '<div class="empty-note">Nothing imported yet.</div>'; return; }
    const dayMs = 86400000;
    for (const [name, a] of acc) {
      const fixed = MP_ACCOUNT_SCHEDULE[name];
      a.every = a.auto || a.flex ? 'auto' : fixed !== undefined ? fixed
        : a.bankDay && a.bankRows90 >= 12 ? 7   // a bank in active use
        : 30;                                     // a broker, or a bank in little use
    }
    // today's local date: in UTC it's still yesterday in the small hours east of
    // Greenwich, and a statement dated today showed -1 days ago (02.11.2026, Tbilisi)
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const ago = a => Math.round((today - Date.parse(a.day + 'T00:00:00Z')) / dayMs);
    // the split accounts' parts, in a fixed order
    const { data: partRows } = await sb.rpc('latest_data_per_part');
    const parts = new Map();
    for (const p of partRows || []) {
      if (!MP_SPLIT_ACCOUNTS.has(p.account)) continue;
      if (!parts.has(p.account)) parts.set(p.account, []);
      parts.get(p.account).push(p);
    }
    // An account with both an exchange-held wallet and an on-chain one
    // (Telegram: Walt and the TON wallet, 16.11.2026) splits into the two: the
    // custodial one is a statement (its export, on the account's period), the
    // non-custodial one syncs from the blockchain by itself ("auto")
    const { data: wallets } = await sb.from('crypto_wallets').select('id, account, chain, last_synced_at');
    const walletsOf = new Map();
    for (const w of wallets || []) if (w.account) (walletsOf.get(w.account) || walletsOf.set(w.account, []).get(w.account)).push(w);
    for (const [name, ws] of walletsOf) {
      const cust = ws.filter(w => MP_EXCHANGE_CHAINS.has(w.chain)), own = ws.filter(w => !MP_EXCHANGE_CHAINS.has(w.chain));
      if (!cust.length || !own.length || parts.has(name)) continue;
      const lastTx = async list => {
        const { data } = await sb.from('wallet_transactions').select('tx_time').in('wallet_id', list.map(w => w.id))
          .eq('estimated', false).order('tx_time', { ascending: false }).limit(1);
        return (data?.[0]?.tx_time || '').slice(0, 10);
      };
      const chains = list => [...new Set(list.map(w => MP_CHAIN_LABELS[w.chain] || w.chain))].join(', ');
      const synced = own.map(w => (w.last_synced_at || '').slice(0, 10)).sort().pop() || '';
      parts.set(name, [
        { account: name, part: 'Custodial wallet', label: `Custodial: ${chains(cust)}`, last_day: await lastTx(cust),
          period: MP_ACCOUNT_SCHEDULE[name] ?? 30 },
        { account: name, part: 'Non-custodial wallet', label: `Non-custodial: ${chains(own)}`, last_day: await lastTx(own) || synced,
          onchain: { error: '', to: synced, onchain: true } },
      ]);
    }
    for (const ps of parts.values()) ps.sort((x, y) => MP_PART_ORDER.indexOf(x.part) - MP_PART_ORDER.indexOf(y.part));
    // Each part's statements: the upload's kind and file name tell the part
    // (tbank_credit_card_*.csv, revolut_fund, *broker*, ...); a file naming
    // none (yandex_combined.csv) covers them all.
    const partOfUpload = u => {
      const k = u.kind || '', f = (u.file_name || '').toLowerCase();
      if (k === 'telegram_wallet') return 'Custodial wallet';
      if (k === 'revolut_account') return 'Cards & current accounts';
      if (k === 'revolut_metal') return 'Metals';
      if (k === 'revolut_fund') return 'Flexible Cash Funds';
      if (k === 'revolut_deposit') return 'Deposits & savings';
      if (/crypto/.test(k + f)) return 'Crypto';
      if (/metal/.test(k + f)) return 'Metals';
      if (/atomyze/.test(k + f)) return 'ЦФА (Atomyze)';
      if (/broker|invest|брокер/.test(k + f)) return 'Broker';
      if (/credit/.test(f)) return 'Credit card';
      if (/saving|deposit|вклад/.test(f)) return 'Deposits & savings';
      if (/debit|card|salary|current|account/.test(f)) return 'Cards & current accounts';
      return null;
    };
    const partUploaded = new Map();   // "account|part" -> the latest period end
    for (const u of ups || []) {
      if (!parts.has(u.account)) continue;
      const day = u.period_to || u.uploaded_at.slice(0, 10);
      const one = partOfUpload(u);
      for (const p of parts.get(u.account)) {
        if (one && one !== p.part) continue;
        const key = `${u.account}|${p.part}`;
        if (!partUploaded.has(key) || day > partUploaded.get(key)) partUploaded.set(key, day);
      }
    }
    // each part: its newest record / statement end, its period, its days left
    const daysAgo = day => Math.round((today - Date.parse(day + 'T00:00:00Z')) / dayMs);
    // a synced one's: its key's end less today less a week (renew it a week
    // ahead), 0 after a failed run, none for a key without an end
    const keyLeft = f => f.error || f.warning ? 0 : f.expires ? Math.round((Date.parse(f.expires + 'T00:00:00Z') - today) / dayMs) - 7 : null;
    for (const [name, ps] of parts) for (const p of ps) {
      p.auto = p.onchain || partAuto.get(`${name}|${p.part}`);
      p.up = partUploaded.get(`${name}|${p.part}`) || '';
      if (p.auto && p.auto.to > p.up) p.up = p.auto.to;   // (a failed run's to: its last good day)
      p.day = p.up > p.last_day ? p.up : p.last_day;
      // an account set yearly (emptied, left for now: Yandex Bank, 16.11.2026)
      // takes its parts with it, however busy they were before
      p.every = p.auto ? 'auto' : p.period ?? (MP_ACCOUNT_SCHEDULE[name] === 365 ? 365 : mpPartPeriod(p));
      p.left = p.auto ? keyLeft(p.auto) : typeof p.every === 'number' ? p.every - daysAgo(p.day) : null;
    }
    // a split account: labelled by its most frequent part
    for (const [name, ps] of parts) {
      const a = acc.get(name);
      if (!a || a.every === 'closed' || ps.length < 2) continue;
      const periods = ps.map(p => p.every).filter(x => typeof x === 'number');
      if (periods.length && !a.flex) a.every = Math.min(...periods);
    }
    // "Days to check" of each account -- the days until the user has to act:
    // a statement due (its period less the days since its newest record /
    // statement end; below 0 overdue), a key's end, 0 after a failed run; a
    // split account the least of its parts' and its own; none for a key
    // without an end, an on-chain wallet, a closed account.
    for (const [name, a] of acc) {
      const ps = (parts.get(name) || []).length > 1 ? parts.get(name) : [];
      const own = a.flex ? keyLeft(a.flex) : ps.length ? null : typeof a.every === 'number' ? a.every - ago(a) : null;
      const all = [own, ...ps.map(p => p.left)].filter(x => x !== null && x !== undefined);
      a.toCheck = a.every === 'closed' || !all.length ? null : Math.min(...all);
    }
    // sorted by it; without one after the rest, closed accounts at the bottom
    const actIn = a => a.every === 'closed' ? 2e9 : a.toCheck ?? 1e9;
    const rows = [...acc].sort(([an, a], [bn, b]) => actIn(a) - actIn(b) || an.localeCompare(bn));
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const label = e => ({ 7: 'weekly', 14: 'every 2 weeks', 30: 'monthly', 60: 'every 2 months', 365: 'yearly' }[e] ?? (typeof e === 'number' ? `every ${e} days` : e));
    // the "Days to check" cell: orange when overdue (a key: within a week of its end)
    const toCheckCell = n => n === null || n === undefined ? '<td></td>'
      : `<td${n < 0 ? ' style="color:#ff9500"' : ''}>${n}</td>`;
    const partRowsHtml = (name, closed) => (parts.get(name) || []).map(p => {
      const auto = p.auto, up = p.up;
      const d = daysAgo(p.day);
      const what = MP_PART_SOURCE[`${name}|${p.part}`] || MP_ACCOUNT_SOURCE[name] || '';
      const mode = auto?.check ? 'auto check' : 'auto';
      const update = auto ? (auto.error ? `<span style="color:#ff9500" title="${esc(auto.error)}">${mode} · last ${auto.check ? 'check' : 'sync'} failed</span>`
        : auto.warning ? `<span style="color:#ff9500" title="${esc(auto.warning)}">${mode} · statement due</span>` : mode)
        : esc(label(p.every)) + (MP_TODO_AUTO[name] === p.part ? ` · ${todoAuto}` : '');
      const late = !closed && p.left !== null && p.left < 0 && !auto;
      return `<tr class="mp-part" data-acc="${esc(name)}"${mpOpenAccounts.has(name) ? '' : ' hidden'} style="color:${late ? '#ff9500' : '#8b949e'}${closed ? ';opacity:.7' : ''}">`
        + `<td><span style="display:inline-block;width:32px"></span><span class="mp-src" data-src="${esc(what)}">${esc(p.label || p.part)}</span></td>`
        + `<td>${update}</td><td>${!auto || auto.onchain ? '' : auto.perpetual ? 'no end' : auto.expires ? `<span${Math.round((Date.parse(auto.expires + 'T00:00:00Z') - today) / dayMs) <= 7 ? ' style="color:#ff9500"' : ''}>${auto.expires}</span>` : 'renews'}</td><td>${p.last_day}</td><td>${up || '—'}</td><td>${d}</td>${closed ? '<td></td>' : toCheckCell(p.left)}</tr>`;
    }).join('');
    wrap.innerHTML = `<table class="data-table"><thead><tr><th>Account</th><th>Update</th><th>Key valid until</th><th>Latest record</th><th>Statements to</th><th>Days ago</th><th>Days to check</th></tr></thead><tbody>${
      rows.map(([name, a]) => {
        const d = ago(a);
        const late = a.toCheck !== null && a.toCheck < 0;
        const style = a.every === 'closed' ? ' style="color:#6a7381"' : late ? ' style="color:#ff9500"' : '';
        // where the statements come from: a popup drawn by the page on hover
        // (the browser's own title tooltip didn't show)
        const src = MP_ACCOUNT_SOURCE[name];
        // a synced account: "auto" (orange after a failed run) and its key's
        // end in a column of its own -- orange within a week of it or past it;
        // one that could sync by itself but doesn't yet: "TODO auto"
        let update = esc(label(a.every)), expires = '';
        if (a.flex) {
          const left = a.flex.expires ? Math.round((Date.parse(a.flex.expires + 'T00:00:00Z') - today) / dayMs) : null;
          // Binance's balances only checked, the history not pulled: "auto check"
          const mode = a.flex.check ? 'auto check' : 'auto';
          update = a.flex.error ? `<span style="color:#ff9500" title="${esc(a.flex.error)}">${mode} · last ${a.flex.check ? 'check' : 'sync'} failed</span>`
            : a.flex.warning ? `<span style="color:#ff9500" title="${esc(a.flex.warning)}">${mode} · export due</span>` : mode;
          expires = a.flex.perpetual ? 'no end' : a.flex.expires
            ? `<span${left <= 7 ? ' style="color:#ff9500"' : ''}>${a.flex.expires}</span>` : '?';
        } else if (name in MP_TODO_AUTO && !partAuto.has(`${name}|${MP_TODO_AUTO[name]}`)) {
          update += ` · ${MP_TODO_AUTO[name] ? `${todoAuto}: ${esc(MP_TODO_AUTO[name].toLowerCase())}` : todoAuto}`;
        }
        // a split account: a toggle before its name opens its parts; its
        // "Days ago" is its stalest part's, its "Days to check" the least of theirs
        const split = (parts.get(name) || []).length > 1;
        // (the others keep its place empty, so every name starts in one line)
        const toggle = split ? `<span class="mp-toggle" data-acc="${esc(name)}" style="cursor:pointer;display:inline-block;width:16px;user-select:none">${mpOpenAccounts.has(name) ? '▾' : '▸'}</span>`
          : '<span style="display:inline-block;width:16px"></span>';
        return `<tr${style}><td>${toggle}${src ? `<span class="mp-src" data-src="${esc(src)}">${esc(name)}</span>` : esc(name)}</td><td>${update}</td><td>${expires}</td><td>${a.record}</td><td>${a.uploaded || '—'}</td><td>${split ? Math.max(...parts.get(name).map(p => daysAgo(p.day))) : d}</td>${toCheckCell(a.toCheck)}</tr>`
          + (split ? partRowsHtml(name, a.every === 'closed') : '');
      }).join('')}</tbody></table>`;
    for (const t of wrap.querySelectorAll('.mp-toggle')) {
      t.addEventListener('click', () => {
        const name = t.dataset.acc, open = !mpOpenAccounts.has(name);
        if (open) mpOpenAccounts.add(name); else mpOpenAccounts.delete(name);
        t.textContent = open ? '▾' : '▸';
        for (const r of wrap.querySelectorAll('tr.mp-part')) if (r.dataset.acc === name) r.hidden = !open;
      });
    }
  } catch (error) {
    wrap.innerHTML = '';
    const d = document.createElement('div'); d.className = 'empty-note'; d.textContent = error.message; wrap.appendChild(d);
  }
}

// Which account a successful upload refreshed -- kept in statement_uploads
// for the "Latest data per account" table (an account with no movements is
// still up to date once its statement is in). Snowball is no statement.
const MP_UPLOAD_ACCOUNT = {
  revolut_account: 'Revolut', revolut_fund: 'Revolut', revolut_deposit: 'Revolut', revolut_crypto: 'Revolut',
  revolut_invest: 'Revolut', boc_account: 'Bank of Cyprus', ziraat_xlsx: 'Ziraat Bank', ziraat_pdf: 'Ziraat Bank', raiffeisen_account: 'Raiffeisen',
  bybit_log: 'Bybit', cryptocom: 'Crypto.com', telegram_wallet: 'Telegram', binance: 'Binance', sber_broker: 'Sber',
  wise: 'Wise', ibkr: 'IBKR', freedom24_xlsx: 'Freedom24', freedom24_json: 'Freedom24', tbank_broker_xlsx: 'T-Bank',
  atomyze_xlsx: 'T-Bank',
};
// The period a statement covers: what the importer reports (Sber, T-Bank
// broker reports), else two dates in the file name (Revolut
// account-statement_2026-09-01_2026-10-06, Freedom24 <id>_2026-04-28 ..._2026-09-26
// ..._all.json, T-Bank broker-report-2026-09-01-2026-10-01, Sber
// 422XX2Y_01092026_30092026 or one day 422XX2Y_24092026; one ISO date alone --
// boc_combined_2026-10-17.csv -- is the day it runs to), else the first and
// last date of the file's rows (yyyy-mm-dd, dd/mm/yyyy, dd.mm.yyyy).
function mpUploadPeriod(fileName, text, result) {
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (ok(result?.period_start) && ok(result?.period_end)) return [result.period_start, result.period_end];
  const iso = [...fileName.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]);
  if (iso.length >= 2) return [iso[0], iso[iso.length - 1]];
  // one date in the name: the day the statement runs to (boc_combined_2026-10-17.csv),
  // the start from the rows
  if (iso.length === 1) {
    const rows = text ? mpUploadPeriod('', text, null) : null;
    return [rows && rows[0] <= iso[0] ? rows[0] : iso[0], iso[0]];
  }
  // eight digits: IBKR's yyyymmdd (U…_20260831_20261016) or Sber's ddmmyyyy
  // (422XX2Y_01092026_30092026) -- whichever reads as a real date
  const real = d => /^(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d);
  const eight = [...fileName.matchAll(/(?:^|[_ -])(\d{8})(?=[_. -]|$)/g)].map(m => {
    const g = m[1], ymd = `${g.slice(0, 4)}-${g.slice(4, 6)}-${g.slice(6)}`, dmy = `${g.slice(4)}-${g.slice(2, 4)}-${g.slice(0, 2)}`;
    return real(ymd) ? ymd : real(dmy) ? dmy : null;
  }).filter(Boolean);
  if (eight.length) return [eight[0], eight[eight.length - 1]];
  if (!text) return null;
  const days = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{2})[/.](\d{2})[/.](\d{4})\b/g)) {
    const d = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[5]}-${m[4]}`;
    if (d >= '2000-01-01' && d <= '2099-12-31') days.push(d);
  }
  if (!days.length) return null;
  days.sort();
  return [days[0], days[days.length - 1]];
}
async function mpLogUpload(kind, fileName, csvText, result) {
  let accounts = MP_UPLOAD_ACCOUNT[kind] ? [MP_UPLOAD_ACCOUNT[kind]] : [];
  const period = mpUploadPeriod(fileName, csvText, result);
  const rows = [];
  // items within a purchase (migration ...179): the account isn't in the
  // CSV's own columns (a store isn't a bank account) -- it's the linked
  // transaction's, decided server-side; a receipt still waiting for one
  // logs under 'receipts' rather than not at all
  if (kind === 'receipt_csv') {
    const by = new Map();
    for (const r of result.receipts || []) {
      const a = r.account || 'receipts';
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(r.date);
    }
    for (const [a, dates] of by) {
      dates.sort();
      rows.push({ account: a, kind, file_name: fileName, period_from: dates[0], period_to: dates[dates.length - 1] });
    }
  } else if ((kind === 'bank_csv' || kind === 'broker_csv') && csvText) {
    const lines = csvText.split(/\r?\n/).slice(1).filter(Boolean);
    const by = new Map();
    for (const l of lines) {
      const a = l.split(',')[0].trim();
      if (!a) continue;
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(l);
    }
    // a date in the file's name is the day its statements run to
    // (ozon_current_account_2026-10-26.csv: no move since August, but checked to 26.10)
    for (const [a, ls] of by) {
      const p = mpUploadPeriod(fileName, ls.join('\n'), null);
      rows.push({ account: a, kind, file_name: fileName, period_from: p?.[0] ?? null, period_to: p?.[1] ?? null });
    }
  } else {
    // Revolut's metal pocket comes as an account statement of its own, every
    // row in XAU (XAG, ...): logged as the metal's, not as the current
    // account's -- sync-openbanking takes the account's statement end from the log
    let logged = kind;
    if (kind === 'revolut_account' && csvText) {
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      const ci = (lines[0] || '').split(',').indexOf('Currency');
      const ccys = lines.slice(1).map(l => l.split(',')[ci]);
      if (ci >= 0 && ccys.length && ccys.every(c => /^X(AU|AG|PT|PD)$/.test(c))) logged = 'revolut_metal';
    }
    for (const a of accounts) rows.push({ account: a, kind: logged, file_name: fileName, period_from: period?.[0] ?? null, period_to: period?.[1] ?? null });
  }
  if (!rows.length) return;
  try {
    await sb.from('statement_uploads').insert(rows);
  } catch { /* the log is a convenience -- an import stays done without it */ }
}

// TBC Bank (Georgia): tbconline.ge → account → statement, CSV. One file per
// account and currency, named account_statement_<n>_<ddmmyyyy>_<ddmmyyyy>.csv.
// The rows carry no currency and don't say which account they are, and <n>
// is the export's, not the account's -- every export gives the same accounts
// new numbers (19475881, then 19526745, then 19540649, ... for the same GEL
// account). So the account is told from its rows (tbcKindOf): its currency
// and whether it's the savings account, and its rows are kept under the
// number that kind of account had first (TBC_ACCOUNTS) -- a statement of the
// same days again is the same rows, not new ones. A kind not there yet is a
// new account: it goes in here with the number its first export had.
const TBC_ACCOUNTS = {
  // iban: the account's own number, which the PDF statement names (mpTbcPdfCsvs)
  19475881: { currency: 'GEL', product: 'current_account', iban: 'GE40TB7046445064400014' },
  19475897: { currency: 'EUR', product: 'current_account' },
  19475906: { currency: 'GEL', product: 'savings_account', iban: 'GE82TB7046436515100073' },   // My Safe
  19526746: { currency: 'USD', product: 'current_account' },
};
// The account's kind from its rows: the savings account takes deposits in
// ("დეპოზიტზე თანხის ჩარიცხვა") and pays interest ("დარიცხული პროცენტის
// რეალიზაცია"); a cash-in names its currency (",ანგარიშზე თანხის შეტანა,EUR"),
// and a currency exchange ("1 EUR = 2.8560 GEL") leaves the foreign account
// and comes into the lari one.
function tbcKindOf(rows) {
  const product = rows.some(r => (r.amount > 0 && /დეპოზიტზე თანხის ჩარიცხვა/.test(r.description)) || /დარიცხული პროცენტის რეალიზაცია/.test(r.description))
    ? 'savings_account' : 'current_account';
  let currency = null;
  for (const r of rows) {
    const cash = r.description.match(/ანგარიშზე თანხის შეტანა,\s*([A-Z]{3})\b/);
    const fx = r.description.match(/\b1 ([A-Z]{3}) = [\d.]+ GEL\b/);
    currency = cash ? cash[1] : fx ? (r.amount < 0 ? fx[1] : 'GEL') : null;
    if (currency) break;
  }
  // no exchange and no cash-in: the currency is named by a card payment ("POS ..., 13.60 GEL, ...")
  if (!currency) for (const r of rows) {
    const pos = r.description.match(/\b\d[\d,.]* ([A-Z]{3}),/);
    if (pos) { currency = pos[1]; break; }
  }
  if (!currency && product === 'savings_account') currency = 'GEL';
  // only transfers between one's own accounts (no card payments, no deposit, no exchange): the savings
  // account, which sends its money to the lari current account; the current accounts have card payments
  if (!currency && rows.length && rows.every(r => /Transfer between your accounts/.test(r.description))) return { product: 'savings_account', currency: 'GEL' };
  return currency ? { product, currency } : null;
}
function mpParseCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQuotes = false; else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells;
}
// The bank's CSV (a Georgian header row, then an English one; dd/mm/yyyy,
// Paid Out / Paid In unsigned, the running Balance) turned into this
// project's generic bank CSV for import-bank-csv; the bank's Type
// ("Transfer Between Own Accounts", "Currency Exchange", ...) goes in as its
// category.
// The account a statement is of, by its rows: the stored rows (bank_transactions, tbc_bank_csv:<number>)
// that have the same day and amount as the statement's rows; the account with most of them.
async function tbcMatchAccount(rows) {
  const days = rows.map(r => r.date).sort();
  if (!days.length) return null;
  const { data, error } = await sb.from('bank_transactions').select('external_source, tx_date, amount, currency')
    .like('external_source', 'tbc_bank_csv:%').gte('tx_date', `${days[0]}T00:00:00Z`).lte('tx_date', `${days[days.length - 1]}T23:59:59Z`);
  if (error) throw new Error(error.message);
  const key = (d, a) => `${d}|${Math.round(Number(a) * 100)}`;
  const want = new Set(rows.map(r => key(r.date, r.amount)));
  const hits = new Map();
  for (const r of data ?? []) {
    const num = String(r.external_source).split(':')[1];
    if (!num || num === 'pending' || !want.has(key(String(r.tx_date).slice(0, 10), r.amount))) continue;
    const h = hits.get(num) ?? { n: 0, currency: r.currency };
    h.n++;
    hits.set(num, h);
  }
  let best = null;
  for (const [num, h] of hits) if (!best || h.n > best.h.n) best = { num, h };
  if (!best) return null;
  return { num: best.num, currency: best.h.currency, product: TBC_ACCOUNTS[best.num]?.product ?? 'current_account' };
}
function tbcToBankCsv(text, fileName, pick = null) {
  const fileNumber = fileName.match(/account_statement_(\d+)_/)?.[1];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines.findIndex(l => l.startsWith('Date,Description,Additional Information,'));
  const header = mpParseCsvLine(lines[head]);
  const col = name => header.indexOf(name);
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = lines.slice(head + 1).map(mpParseCsvLine).map(c => {
    const [d, m, y] = (c[col('Date')] || '').split('/');
    const n = v => Number(v || 0);
    return {
      date: `${y}-${m}-${d}`,
      // a cash-in reads ",28/10/2026,ანგარიშზე თანხის შეტანა,EUR, ..." -- the leading comma and date dropped
      description: (c[col('Description')] || '').replace(/^,\d{2}\/\d{2}\/\d{4},/, '').trim() || c[col('Type')],
      amount: Math.round((n(c[col('Paid In')]) - n(c[col('Paid Out')])) * 100) / 100,
      balance: c[col('Balance')],
      type: c[col('Type')] || '',
    };
  }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  // oldest first: import-bank-csv orders a day's untimed rows as they come
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();
  // the account: by its number if listed, else by its kind (see TBC_ACCOUNTS)
  // no number listed and no kind told from the rows: the account the rows match in the database (tbcMatchAccount)
  const told = TBC_ACCOUNTS[fileNumber] || tbcKindOf(rows);
  if (!told && !pick) {
    const err = new Error(`TBC statement ${fileName}: which account it is can't be told from its rows`);
    err.tbcRows = rows;
    throw err;
  }
  const kind = told || { product: pick.product, currency: pick.currency };
  // a listed number with sameAs is another export of that account (its rows go under it)
  const accountNumber = pick ? pick.num : TBC_ACCOUNTS[fileNumber]?.sameAs ?? (TBC_ACCOUNTS[fileNumber] ? fileNumber
    : Object.keys(TBC_ACCOUNTS).find(n => TBC_ACCOUNTS[n].product === kind.product && TBC_ACCOUNTS[n].currency === kind.currency) || fileNumber);
  return ['bank,account_number,product,currency,date,time,card,description,amount,balance,category_bank,source_file',
    ...rows.map(r => ['TBC Bank', accountNumber, kind.product, kind.currency, r.date, '', '', r.description, r.amount, r.balance, r.type, fileName].map(v => q(String(v))).join(','))].join('\n');
}

// Alfa-Investments' broker report as XML (06.11.2026: the cabinet's
// "Отчёт брокера" -> XML, namespace MyBroker) turned into this project's
// two CSVs: the brokerage cash (import-bank-csv, product brokerage_cash --
// every money movement, a deal's own ones dated by the deal) and the deals
// and payouts (import-broker-csv -- a deal's side by its cash's sign, a bond's
// price in money, coupons / dividends by the issue's registration number,
// per unit held). Tickers as MOEX's secid (MOEX ISS, from the browser).
const mpMoexIds = new Map();
async function mpMoexBy(q, field) {
  const key = `${field}:${q}`;
  if (mpMoexIds.has(key)) return mpMoexIds.get(key);
  const res = await fetch(`https://iss.moex.com/iss/securities.json?iss.meta=off&q=${encodeURIComponent(q)}&securities.columns=secid,isin,regnumber,shortname,type,is_traded`)
    .then(r => r.json()).catch(() => null);
  const rows = (res?.securities?.data || []).map(([secid, isin, regnumber, shortname, type, traded]) => ({ secid, isin, regnumber, shortname, type, traded }));
  const exact = rows.filter(r => r[field] === q);
  const hit = exact.find(r => r.traded) || exact[0] || null;
  mpMoexIds.set(key, hit);
  return hit;
}
async function alfaXmlToCsvs(text, fileName) {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${fileName}: not readable as XML`);
  const all = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
  const iso = d => { const [dd, mm, yy] = d.trim().slice(0, 10).split('.'); return `${yy}-${mm}-${dd}`; };
  const num = v => Number(String(v ?? '').replace(',', '.')) || 0;
  const r2 = x => Math.round(x * 100) / 100;
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const tradesEl = all(doc, 'Trades')[0];
  const deals = (tradesEl ? all(tradesEl, 'Details') : []).map(d => ({
    no: (d.getAttribute('trade_no') || '').trim().split(/\s+/)[0], date: iso(d.getAttribute('db_time') || ''),
    acct: (d.getAttribute('acc_code') || '').split('-')[0], isin: d.getAttribute('isin_reg'), name: d.getAttribute('p_name'),
    qty: num(d.getAttribute('qty')), price: num(d.getAttribute('Price')), sum: num(d.getAttribute('summ_trade')),
    nkd: num(d.getAttribute('summ_nkd')), fee: num(d.getAttribute('bank_tax')), ccy: d.getAttribute('curr_calc') || 'RUB',
  }));
  const acct = deals[0]?.acct || all(doc, 'Textbox11').map(e => (e.getAttribute('acc_code') || '').split('-')[0]).find(Boolean)
    || fileName.match(/\d{6,}/)?.[0];
  if (!acct) throw new Error(`${fileName}: the account number isn't in the report`);
  const dealOf = new Map(deals.map(d => [d.no, d]));
  // the money: per settlement day, each operation's amount by currency
  const ops = [];
  for (const sd of all(doc, 'settlement_date')) {
    const day = (sd.getAttribute('settlement_date') || '').slice(0, 10);
    for (const ot of all(sd, 'oper_type')) {
      const type = (ot.getAttribute('oper_type') || '').trim();
      for (const cm of all(ot, 'comment')) {
        const comment = (cm.getAttribute('comment') || '').trim();
        for (const pc of all(cm, 'p_code').filter(e => e.hasAttribute('volume')))
          ops.push({ day, type, comment, ccy: pc.getAttribute('p_code') || 'RUB', amount: r2(num(pc.getAttribute('volume'))) });
      }
    }
  }
  // a deal's money on the deal's day (as its trade); its accrued interest
  // follows the deal of the same paper that day
  let lastDeal = new Map();
  for (const o of ops) {
    const no = o.type.match(/по сделке (\d+)/)?.[1];
    if (no && dealOf.has(no)) { o.date = dealOf.get(no).date; if (/^Расчеты/.test(o.type)) { lastDeal.set(`${o.day}|${o.comment}`, o.date); dealOf.get(no).sign = Math.sign(o.amount); } }
    else if (/^НКД по сделке/.test(o.type)) o.date = lastDeal.get(`${o.day}|${o.comment}`) || o.day;
    else o.date = o.day;
  }
  const opsSorted = ops.map((o, i) => ({ ...o, i })).sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i);
  const begin = {};
  for (const pc of all(doc, 'money_volume_begin_Collection').flatMap(e => all(e, 'p_code')).filter(e => e.hasAttribute('volume')))
    begin[pc.getAttribute('p_code') || 'RUB'] = num(pc.getAttribute('volume'));
  const bal = { ...begin };
  const cash = ['bank,account_number,product,currency,date,time,card,description,amount,balance,source_file',
    ...opsSorted.map(o => {
      bal[o.ccy] = r2((bal[o.ccy] || 0) + o.amount);
      return ['Alfa', acct, 'brokerage_cash', o.ccy, o.date, '', '', `${o.type}: ${o.comment}`, o.amount.toFixed(2), bal[o.ccy].toFixed(2), fileName].map(q).join(',');
    })].join('\n');
  // the deals, then the payouts per unit held that day
  const out = [];
  const held = {};
  for (const d of [...deals].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!d.sign) continue;   // not settled within the report
    const m = await mpMoexBy(d.isin, 'isin');
    const ticker = m?.secid || d.isin, bond = /bond/.test(m?.type || '') || d.nkd > 0;
    // a sale's quantity comes negative; else the side by the deal's cash
    const side = d.qty < 0 || (!d.qty && d.sign > 0) ? 'sell' : d.qty > 0 ? 'buy' : d.sign < 0 ? 'buy' : 'sell';
    d.qty = Math.abs(d.qty);
    const price = bond ? r2((d.sum - d.nkd) / d.qty) : d.price;
    held[ticker] = (held[ticker] || 0) + (side === 'buy' ? d.qty : -d.qty);
    out.push({ date: d.date, row: ['Alfa', acct, d.date, side, ticker, d.name, d.qty, price, d.ccy, d.nkd ? r2(d.nkd / d.qty) : '', d.fee || '',
      (side === 'buy' ? -d.sum : d.sum).toFixed(2), '', fileName], ticker, side, qty: d.qty });
  }
  const heldOn = (ticker, date) => out.filter(t => t.ticker === ticker && t.date <= date && (t.side === 'buy' || t.side === 'sell'))
    .reduce((s, t) => s + (t.side === 'buy' ? t.qty : -t.qty), 0);
  const nameOf = ticker => out.find(t => t.ticker === ticker)?.row[5];
  let unknown = 0;
  for (const o of opsSorted) {
    if (o.amount <= 0 || o.type !== 'Перевод') continue;
    const coupon = o.comment.match(/погашение купона (\S+) .*?д\.ф\.(\d{2})\.(\d{2})\.(\d{2})/);
    const part = o.comment.match(/(частичное погашение|погашение номинала|погашение облигаций)\D*?(\d\S*)/i);
    const div = o.comment.match(/Дивиденды .*?по акциям .*\(([0-9A-Z-]+)\)\./);
    const reg = coupon?.[1] || div?.[1] || part?.[2];
    if (!reg) continue;
    const m = await mpMoexBy(reg, 'regnumber');
    if (!m) { unknown++; continue; }
    const units = heldOn(m.secid, o.date) || 1;
    const side = div || coupon ? 'dividend' : /частичное/i.test(part[1]) ? 'amortisation' : 'repayment';
    const label = div ? 'дивиденды' : coupon ? 'купон' : 'погашение';
    out.push({ date: o.date, row: ['Alfa', acct, o.date, side, m.secid, `${nameOf(m.secid) || m.shortname} (${label})`, o.amount,
      Math.round(o.amount / units * 1e6) / 1e6, o.ccy, '', '', o.amount.toFixed(2), coupon ? `20${coupon[4]}-${coupon[3]}-${coupon[2]}` : '', fileName] });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  const trades = ['broker,account_number,date,operation,ticker,name,quantity,price,currency,nkd,fee,amount,record_date,source_file',
    ...out.map(t => t.row.map(q).join(','))].join('\n');
  return { cash, trades, unsettled: deals.filter(d => !d.sign).length, unknown };
}

async function mpImportOneFile(file, statusEl, session) {
  try {
    // Ziraat Bank's own export is a real .xlsx, not CSV -- detected by
    // extension alone (reading it as text would be meaningless) and sent
    // as raw bytes; the Edge Function parses the workbook server-side.
    const isXlsx = /\.xlsx$/i.test(file.name);
    let kind, csvText;
    if (isXlsx) {
      // Any .xlsx goes to import-xlsx, which tells T-Bank / Freedom24 /
      // Ziraat apart by the file's content and returns which it was.
      kind = 'xlsx';
    } else {
      csvText = await file.text();
      // Alfa-Investments' broker report (XML): two of this project's CSVs, each to its importer
      if (/\.xml$/i.test(file.name) && /xmlns="MyBroker"/.test(csvText.slice(0, 2000))) {
        statusEl.textContent = 'Detected: Alfa-Investments broker report (XML). Converting…';
        const conv = await alfaXmlToCsvs(csvText, file.name);
        const post = async (fn, body) => {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: 'POST', body,
            headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'text/csv' } });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`${fn} (HTTP ${res.status}): ${out.error || out.message || res.statusText}`);
          return out;
        };
        const hasRows = csv => csv.split(/\r?\n/).slice(1).some(Boolean);
        // a report with no deals and no money (an account unused those days): nothing to
        // import -- noted as checked to its end, from the name's "(dd.mm.yy-dd.mm.yy)"
        if (!hasRows(conv.cash) && !hasRows(conv.trades)) {
          const days = [...file.name.matchAll(/(\d{2})\.(\d{2})\.(\d{2})(?!\d)/g)].map(m => `20${m[3]}-${m[2]}-${m[1]}`);
          if (days.length) await sb.from('statement_uploads').insert({ account: 'Alfa', kind: 'broker_csv', file_name: file.name, period_from: days[0], period_to: days[days.length - 1] });
          statusEl.textContent = `Detected: Alfa-Investments broker report (XML). No deals or money movements in it${days.length ? ` -- noted as checked to ${days[days.length - 1]}` : ''}.`;
          return;
        }
        statusEl.textContent = 'Detected: Alfa-Investments broker report (XML). Uploading the cash…';
        const cashRes = hasRows(conv.cash) ? await post('import-bank-csv', conv.cash) : { imported: 0 };
        statusEl.textContent = 'Detected: Alfa-Investments broker report (XML). Uploading the deals and payouts…';
        // ?replace=1: the report is the record of its days -- the app-screenshot rows it covers go
        const tradeRes = hasRows(conv.trades) ? await post('import-broker-csv?replace=1', conv.trades) : {};
        mpImportedSinceRefresh = true;
        mpLogUpload('bank_csv', file.name, conv.cash, cashRes);
        mpLogUpload('broker_csv', file.name, conv.trades, tradeRes);
        fetch(`${SUPABASE_URL}/functions/v1/sync-estimates`, { method: 'POST', body: '{}',
          headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } }).catch(() => { /* the daily run */ });
        statusEl.textContent = `Detected: Alfa-Investments broker report (XML). Cash: ${cashRes.imported ?? '?'} operations; `
          + `deals and payouts: ${tradeRes.trades ?? 0} deals, ${tradeRes.payouts ?? 0} payouts`
          + `${tradeRes.replaced ? `, ${tradeRes.replaced} older rows (app screenshots) replaced` : ''}`
          + `${conv.unsettled ? `; ${conv.unsettled} deal(s) not settled within the report left out` : ''}`
          + `${conv.unknown ? `; ${conv.unknown} payout(s) whose paper MOEX doesn't know left out` : ''}.`;
        mpRenderPortfolioPies();
        mpRenderBrokerCurrency();
        mpRenderBrokerAssetClass();
        mpRenderBondByType();
        return;
      }
      const headerLine = csvText.split(/\r\n|\r|\n/)[0] || '';
      // Apple's purchase history: reportaproblem.apple.com's page, its text copied as it is
      kind = /Report a Problem/.test(csvText.slice(0, 3000)) && /Apple Account/.test(csvText.slice(0, 3000)) && /^Total /m.test(csvText)
        ? 'apple_history' : mpDetectCsvKind(headerLine, csvText);
      if (kind === 'tbc_account') {
        try {
          csvText = tbcToBankCsv(csvText, file.name);
        } catch (err) {
          if (!err.tbcRows) throw err;
          const pick = await tbcMatchAccount(err.tbcRows);
          if (!pick) throw new Error(`${err.message} -- none of its rows is in the database yet`);
          csvText = tbcToBankCsv(csvText, file.name, pick);
        }
        kind = 'bank_csv';
      }
    }
    if (!kind) {
      statusEl.textContent = 'Unrecognized CSV format — expected a Snowball trades export, '
        + 'a Revolut account statement, a Revolut Flexible Cash Funds statement, a Revolut '
        + 'Instant Access Savings statement, a Wise balance statement, an IBKR Activity Statement, a Bank of Cyprus transaction history export, a TBC Bank account statement, or '
        + 'this project\'s own Raiffeisen Bank Serbia, generic bank transaction or broker operations CSV, a Bybit transaction log, '
        + 'a Crypto.com App export, a Binance transaction export, or this project\'s own Telegram wallet (Walt) CSV.';
      return;
    }
    if (kind === 'binance_aux') {
      statusEl.textContent = 'This is a Binance deposit / withdrawal history export — not needed: those movements are '
        + 'already in the Binance transaction export (Export Transaction Records). Upload that one instead.';
      return;
    }

    const endpoints = {
      snowball: { fn: 'import-trades-csv', label: 'broker trades (Snowball)' },
      revolut_account: { fn: 'import-revolut-statement', label: 'Revolut account statement' },
      revolut_report: { fn: 'sync-openbanking', label: 'Revolut combined report (all accounts)' },
      revolut_fund: { fn: 'import-revolut-fund-statement', label: 'Revolut Flexible Cash Funds statement' },
      revolut_deposit: { fn: 'import-revolut-deposit-statement', label: 'Revolut Instant Access Savings statement' },
      boc_account: { fn: 'import-boc-statement', label: 'Bank of Cyprus transaction history' },
      ziraat_xlsx: { fn: 'import-ziraat-statement', label: 'Ziraat Bank account activity' },
      ziraat_pdf: { fn: 'import-ziraat-statement', label: 'Ziraat Bank account activity (PDF)' },
      raiffeisen_account: { fn: 'import-raiffeisen-statement', label: 'Raiffeisen Bank Serbia transaction history' },
      bank_csv: { fn: 'import-bank-csv', label: 'bank transaction history (generic CSV)' },
      broker_csv: { fn: 'import-broker-csv', label: 'broker operations (generic CSV)' },
      bybit_log: { fn: 'import-bybit', label: 'Bybit transaction log' },
      cryptocom: { fn: 'import-crypto-com', label: 'Crypto.com App export' },
      telegram_wallet: { fn: 'import-telegram-wallet', label: 'Walt (ex. Wallet in Telegram) history' },
      binance: { fn: 'import-binance', label: 'Binance transaction export' },
      revolut_crypto: { fn: 'import-revolut-crypto', label: 'Revolut crypto statement' },
      revolut_invest: { fn: 'import-revolut-invest', label: 'Revolut brokerage (Invest) statement' },
      sber_broker: { fn: 'import-sber-broker', label: 'Sber broker report' },
      wise: { fn: 'import-wise-statement', label: 'Wise balance statement' },
      ibkr: { fn: 'import-ibkr-statement', label: 'IBKR Activity Statement' },
      freedom24_xlsx: { fn: 'import-freedom24-statement', label: 'Freedom24 cash-movement report' },
      freedom24_json: { fn: 'import-freedom24-statement', label: 'Freedom24 broker report (JSON)' },
      tbank_broker_xlsx: { fn: 'import-tbank-broker', label: 'T-Bank broker report' },
      atomyze_xlsx: { fn: 'import-atomyze', label: 'Atomyze (ЦФА) platform report' },
      xlsx: { fn: 'import-xlsx', label: 'spreadsheet (.xlsx)' },
      receipt_csv: { fn: 'import-receipts', label: 'receipt items (CSV)' },
      apple_history: { fn: 'import-apple-purchases', label: 'Apple purchase history' },
    };
    const { fn } = endpoints[kind];
    let { label } = endpoints[kind];
    // Binance writes times in the zone named in the file name, e.g.
    // "Binance-Transaction-History-202609261140(UTC+3)-part1-of1.csv".
    // (a CSV the page made from a Raiffeisen PDF carries its statement's period: only those days are replaced)
    const query = kind === 'binance' ? `?tz=${encodeURIComponent(file.name.match(/\(UTC([+-]\d+(?:\.\d+)?)\)/)?.[1] ?? '0')}`
      : kind === 'revolut_report' ? '?action=revolut_report' : (file.mpQuery || '');
    statusEl.textContent = `Detected: ${label}. Uploading and parsing on the server…`;
    // a receipt file's rows show in the Expenses tab at once, from the file itself
    if (kind === 'receipt_csv') mpShowPendingReceipts(csvText);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}${query}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': isXlsx
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : kind === 'ziraat_pdf' ? 'application/json' : 'text/csv',
      },
      body: isXlsx ? await file.arrayBuffer() : csvText,
    });
    const result = await res.json().catch(() => ({}));
    // import-xlsx says which source the spreadsheet turned out to be.
    if (kind === 'xlsx' && endpoints[result.detected]) {
      kind = result.detected;
      label = endpoints[kind].label;
    }
    // a Ziraat term deposit's statement doesn't give its rate: asked once, the file sent again with it
    if (res.status === 422 && result.needs_deposit_rate && !file.mpQuery) {
      const rate = prompt(`Ziraat term deposit ${result.account_no}, opened ${result.opened}`
        + `${result.end ? `, until ${result.end}` : ''}: its interest rate, % a year?`);
      if (rate && Number(rate.replace(',', '.')) > 0) {
        file.mpQuery = `?deposit_rate=${encodeURIComponent(rate.replace(',', '.').replace('%', '').trim())}`;
        return mpImportOneFile(file, statusEl, session);
      }
    }
    if (!res.ok) {
      // A function that crashed / hit a platform limit answers without an
      // `error` field (e.g. {code: 'WORKER_LIMIT', message: ...}).
      statusEl.textContent = `Error (HTTP ${res.status}): ${result.error || result.message || result.msg
        || result.code || res.statusText || 'no details'}`;
      mpDropPendingReceipts();
      return;
    }
    mpImportedSinceRefresh = true;
    mpLogUpload(kind, file.name, csvText, result);
    // Everything worked out on top of statements is rebuilt on the new one:
    // the estimated income (sync-estimates), and the source's own sync --
    // its API rows and stand-ins start again after the statement. In the
    // background; the daily runs catch up if one fails.
    const mpAfterUpload = {
      revolut_account: 'sync-openbanking', revolut_fund: 'sync-openbanking', revolut_deposit: 'sync-openbanking',
      revolut_invest: 'sync-openbanking', boc_account: 'sync-openbanking', wise: 'sync-openbanking',
      tbank_broker_xlsx: 'sync-tbank', atomyze_xlsx: 'sync-tbank', freedom24_xlsx: 'sync-freedom24', freedom24_json: 'sync-freedom24',
      bybit_log: 'sync-bybit', ibkr: 'sync-ibkr',
    };
    for (const fnName of ['sync-estimates', mpAfterUpload[kind]].filter(Boolean))
      fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
        method: 'POST', body: '{}',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json',
          ...(fnName === 'sync-bybit' ? { 'x-region': 'eu-west-1' } : {}) },
      }).catch(() => { /* the daily run catches up */ });

    if (kind === 'snowball') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} rows, removed `
        + `${result.removed} stale rows (${result.skipped} skipped, ${result.skipped_trust ?? 0} rows left `
        + `to their own sources — Trust, Bybit, Crypto.com, Telegram — ${result.total_rows} parsed).`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'revolut_report') {
      // not logged as a statement: it doesn't move the statement's end
      statusEl.textContent = `Detected: ${label}, ${result.report}. Added ${result.written} transactions in neither the statement `
        + `(to ${result.after_statement}) nor Open Banking; ${result.in_open_banking} already in Open Banking; `
        + `${result.metal_times} metal purchase times set; ${result.invest_deals ?? 0} Invest deals until the Invest statement; `
        + `checked against the statement: ${result.checked?.matched ?? 0} matched.`;
    } else if (kind === 'revolut_account') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} transactions `
        + `and ${result.imported_metal_trades ?? 0} gold/metal trades`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''} `
        + `(${result.total_rows} parsed, ${result.skipped_not_completed} not-completed, `
        + `${result.skipped_deposit} deposit rows skipped).`;
      if (result.imported_metal_trades) {
        mpRenderPortfolioPies();
      }
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'boc_account') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} transactions `
        + `(${result.total_rows} parsed, ${result.skipped_bad_date} skipped as bad date).`;
    } else if (kind === 'raiffeisen_account') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} transactions `
        + `(${result.total_rows} parsed).`;
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'cryptocom') {
      const bal = Object.entries(result.balances || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      const skipped = result.skipped_mirrored ? ` ${result.skipped_mirrored} conversion row(s) skipped — already in the Crypto Wallet export.` : '';
      statusEl.textContent = result.note
        ? `Detected: ${label}. ${result.note}.${skipped}`
        : `Detected: ${label}. Imported ${result.rows} rows (${result.total_rows_stored} stored in total).${skipped} `
          + `Crypto.com balance now: ${bal}.`;
      mpRefreshAfterWalletChange();
    } else if (kind === 'atomyze_xlsx') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'none';
      statusEl.textContent = `Detected: ${label}. Imported ${result.deals} deals, ${result.payouts} payouts`
        + `${result.adjustments ? `, ${result.adjustments} movements without a deal` : ''} and ${result.cash_rows} wallet operations`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `ЦФА held: ${h}. Wallet: RUB ${result.cash?.last ?? 0}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'tbank_broker_xlsx') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'none';
      // `computed` is what the listed operations add up to; where it differs
      // from the report's closing balance the importer has already recorded
      // the unlisted difference (`unlisted`), so the stored balance is the
      // reported one.
      const cash = Object.entries(result.cash || {}).filter(([, v]) => v.reported || v.computed || v.unlisted)
        .map(([c, v]) => `${c} ${v.reported}${v.unlisted
          ? ` (the report's operations add up to ${v.computed}; the unlisted ${v.unlisted} — e.g. the transfer of what was left when the agreement closed — is recorded as a balance snapshot)`
          : Math.abs(v.computed - v.reported) > 0.005 ? ` (operations add up to ${v.computed}!)` : ''}`).join(', ') || '0';
      statusEl.textContent = `Detected: ${label} (agreement ${result.agreement}). Imported ${result.deals} deals, `
        + `${result.payouts} payouts, ${result.adjustments} movements without a deal and ${result.cash_rows} cash operations`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `Holdings: ${h}. Cash: ${cash}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'freedom24_json') {
      statusEl.textContent = `Detected: ${label}. Shares credited without money: `
        + `${(result.securities_credited || []).join(', ') || 'none'}`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'freedom24_xlsx') {
      const cash = Object.entries(result.cash || {}).map(([c, q]) => `${c} ${Number(q).toFixed(2)}`).join(', ');
      statusEl.textContent = `Detected: ${label}. Imported ${result.trades} trades, ${result.dividends} dividends and `
        + `${result.cash_rows} cash movements`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `Freedom24 cash: ${cash || 'none'}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'ibkr') {
      const cash = Object.entries(result.cash || {}).map(([c, q]) => `${c} ${Number(q).toFixed(2)}`).join(', ');
      statusEl.textContent = `Detected: ${label}. Imported ${result.trades} trades, ${result.dividends} dividends and `
        + `${result.cash_rows} cash movements`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `IBKR cash at the end of this statement: ${cash || 'none'}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'wise') {
      statusEl.textContent = result.note
        ? `Detected: ${label}. ${result.note}.`
        : `Detected: ${label} (${result.currency}). Imported ${result.imported} transactions `
          + `(${result.total_rows} parsed). Wise ${result.currency} balance: ${result.balance}.`;
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'sber_broker') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'none';
      const cash = Object.entries(result.cash || {}).filter(([, v]) => v.reported || v.computed)
        .map(([c, v]) => `${c} ${v.reported}${Math.abs(v.computed - v.reported) > 0.005 ? ` (operations add up to ${v.computed}!)` : ''}`).join(', ') || '0';
      statusEl.textContent = `Detected: ${label} (agreement ${result.agreement}, ${result.period_start}..${result.period_end}). `
        + `Imported ${result.deals} deals, ${result.payouts} payouts`
        + `${result.adjustments ? `, ${result.adjustments} movements without a deal` : ''} and ${result.cash_rows} cash rows`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}`
        + `${result.removed_app_rows ? ` (replacing ${result.removed_app_rows} rows taken from the app's history)` : ''}. `
        + `Holdings at period end: ${h}. Cash: ${cash}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'broker_csv') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      statusEl.textContent = `Detected: ${label}. Imported ${result.trades} trades and ${result.payouts} payouts`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}`
        + `${result.covered_by_report ? `; ${result.covered_by_report} left out, a broker report already has them` : ''}. `
        + `Holdings from these operations: ${h}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'revolut_invest') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      const cash = Object.entries(result.cash || {}).map(([c, q]) => `${c} ${Number(q).toFixed(2)}`).join(', ') || 'none';
      statusEl.textContent = `Detected: ${label}. Imported ${result.trades} trades, ${result.dividends} dividends and `
        + `${result.cash_rows} cash movements`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `Revolut Invest now: ${h}; cash ${cash}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'revolut_crypto') {
      const h = Object.entries(result.holdings || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} crypto operations`
        + `${result.removed_snowball_duplicates ? ` (replacing ${result.removed_snowball_duplicates} Snowball rows)` : ''}. `
        + `Revolut crypto now: ${h}.`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'binance') {
      const bal = Object.entries(result.balances || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      statusEl.textContent = result.note
        ? `Detected: ${label}. ${result.note}.`
        : `Detected: ${label} (times in UTC${result.tz >= 0 ? '+' : ''}${result.tz}). Imported ${result.rows} rows `
          + `(${result.total_rows_stored} stored in total). Binance balance now: ${bal}.`;
      mpRefreshAfterWalletChange();
    } else if (kind === 'telegram_wallet') {
      const bal = Object.entries(result.balances || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      const unknown = result.unknown_balance?.length
        ? ` No balance for ${result.unknown_balance.join(', ')}: the history doesn't show how much of it exchanges spent.` : '';
      statusEl.textContent = `Detected: ${label}. Imported ${result.rows} rows from ${result.total_in_file} operations `
        + `(${result.total_rows_stored} stored in total). Telegram balance now: ${bal}.${unknown}`;
      mpRefreshAfterWalletChange();
    } else if (kind === 'bybit_log') {
      const bal = Object.entries(result.balances || {}).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing';
      statusEl.textContent = `Detected: ${label} (${result.source === 'fund' ? 'Funding' : 'Unified Trading'}). `
        + `Imported ${result.rows} rows (${result.total_rows_stored} stored for this account in total). `
        + `Bybit balance now: ${bal}.`;
      mpRefreshAfterWalletChange();
    } else if (kind === 'bank_csv') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} transactions and `
        + `${result.imported_deposit} savings-account / deposit trades (${result.total_rows} parsed)`
        + `${result.removed_snowball_duplicates ? `, replacing ${result.removed_snowball_duplicates} Snowball rows` : ''}`
        + `${result.covered_by_report ? `; ${result.covered_by_report} left out, a broker report already has them` : ''}`
        + `${result.dropped_stale ? `; ${result.dropped_stale} stored rows on these dates no longer in the file removed` : ''}`
        + `${result.settled_pending ? `; ${result.settled_pending} held payments replaced by the statement's rows (notes kept)` : ''}.`;
      // the statement takes over the rows receipts made themselves (match_receipts folds them
      // into its own rows, with their place and items): the Expenses tab re-reads, else it kept
      // showing the gone receipt rows -- "unknown", no place, no items, the account editable (14.11.2026)
      mpExpCache = null;
      mpPendingRerender();
      mpRenderReceiptsPanel();
      if (result.imported_deposit) {
        mpRenderPortfolioPies();
        mpRenderBondByType();
      }
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
    } else if (kind === 'ziraat_xlsx' || kind === 'ziraat_pdf') {
      statusEl.textContent = result.deposit
        ? `Detected: ${label}, term deposit ${result.deposit}${result.deposit_end ? ` until ${result.deposit_end}` : ''}. `
          + `Imported ${result.imported} deposit movements.`
        : `Detected: ${label} (${result.currency}). Imported ${result.imported} transactions `
          + `(${result.total_rows} parsed${result.already_in ? `, ${result.already_in} already in from the .xlsx` : ''}, ${result.skipped_bad_date} skipped as bad date).`;
      if (result.deposit) { mpRenderPortfolioPies(); mpRenderBondByType(); }
    } else if (kind === 'revolut_fund') {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} rows `
        + `(${result.total_rows} parsed, ${result.interest_rows} interest/fee rows, `
        + `${result.skipped_no_quantity_no_value} skipped as zero-value bookkeeping).`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    } else if (kind === 'apple_history') {
      statusEl.textContent = `Detected: ${label}. ${result.orders} paid order(s) (${result.free} free left out): ${result.new} new, ${result.already} already in; `
        + `${result.linked_this_run} linked to a card's charge now -- ${result.linked} linked in all, ${result.waiting} with no charge found`
        + `${result.warnings?.length ? `. Not adding up: ${result.warnings.join('; ')}` : ''}.`;
      mpExpCache = null;
      if (document.getElementById('expenses')?.offsetParent) mpRenderExpenses().catch(() => { /* the tab shows its own error */ });
      mpRenderApplePurchases();
    } else if (kind === 'receipt_csv') {
      const skipped = result.skipped?.length ? ` ${result.skipped.length} receipt(s) skipped (their own rows disagreed): ${result.skipped.map(s => s.reason).join('; ')}.` : '';
      const unmatched = result.unmatched_products ? ` ${result.unmatched_products} line(s) with no product yet -- resolve them from the Expenses tab's Items column.` : '';
      statusEl.textContent = `Detected: ${label}. ${result.accepted} receipt(s), ${result.total_lines} line(s): `
        + `${result.linked} linked to a transaction, ${result.waiting} waiting for one, ${result.ambiguous} matching more than one (resolve by hand).${skipped}${unmatched}`;
      // the Expenses tab's items re-load with the new receipts; the history already loaded stays (the forecast reads it)
      mpReloadPeriodKeepingHistory();
      // the tab on screen now re-reads its rows: a tab already open is not re-rendered by a tab switch
      if (document.getElementById('expenses')?.offsetParent) mpRenderExpenses().catch(() => { /* the tab shows its own error */ });
      mpRenderReceiptsPanel();
      mpRenderProductList();
    } else {
      statusEl.textContent = `Detected: ${label}. Imported ${result.imported} deposit trades `
        + `(${result.total_rows} parsed).`;
      mpRenderPortfolioPies();
      mpRenderBrokerCurrency();
      mpRenderBrokerAssetClass();
      mpRenderBondByType();
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    mpDropPendingReceipts();
  }
}

