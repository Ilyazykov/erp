// Pure logic for the receipt-items feature (design: docs/items-design.md,
// not tracked in git) -- parsing the receipt CSV, carrying notes over when a
// receipt's lines are replaced, and the match_receipts tie-break rule that
// the SQL function (migration ...179) also implements. Plain JS, no Deno
// APIs: import-receipts/index.ts imports it as is, and
// tests/receipts.test.mjs runs the exact same file under Node -- nothing
// here is duplicated by hand between the two.

// A quoted CSV line splitter, same shape as import-bank-csv's parseCsvLine.
export function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// The SQL function receipt_norm's exact JS mirror (migration ...179): lower
// case, punctuation collapsed to a space, repeated spaces trimmed, digits kept.
export function receiptNorm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REQUIRED_COLUMNS = ['receipt', 'date', 'store', 'currency', 'total', 'line', 'item', 'item_en', 'qty', 'line_total'];

function parseNum(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Parses the receipt CSV (design section 4). Returns { error } for a
// whole-file problem (a required column missing, or a required value that
// doesn't parse -- the row is named), or { receipts, skipped } where
// `receipts` is each accepted receipt with its lines and warnings, and
// `skipped` lists receipts whose rows disagreed with each other (date,
// store, currency or total) -- the rest of the file still goes in.
export function parseReceiptCsv(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return { error: 'Empty file' };

  const header = parseCsvLine(lines[0]).map(h => h.trim().replace(/^﻿/, ''));
  const col = name => header.indexOf(name);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = REQUIRED_COLUMNS.filter(c => col(c) < 0);
  if (missing.length) return { error: `Missing required column(s): ${missing.join(', ')}` };

  const cell = (cells, name) => (idx[name] >= 0 ? (cells[idx[name]] ?? '').trim() : '');

  const byReceipt = new Map();   // printed `receipt` value -> raw rows (in file order)
  for (let i = 1; i < lines.length; i++) {
    const rowNo = i + 1;   // 1-based, header is row 1
    const cells = parseCsvLine(lines[i]);
    const printedReceipt = cell(cells, 'receipt');
    const date = cell(cells, 'date');
    const store = cell(cells, 'store');
    const currency = cell(cells, 'currency');
    const total = parseNum(cell(cells, 'total'));
    const lineNo = parseNum(cell(cells, 'line'));
    const item = cell(cells, 'item');
    const itemEn = cell(cells, 'item_en');
    const qty = parseNum(cell(cells, 'qty'));
    const lineTotal = parseNum(cell(cells, 'line_total'));

    if (!printedReceipt) return { error: `Row ${rowNo}: empty "receipt"` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `Row ${rowNo}: "date" is not YYYY-MM-DD ("${date}")` };
    if (!store) return { error: `Row ${rowNo}: empty "store"` };
    if (!currency) return { error: `Row ${rowNo}: empty "currency"` };
    if (total === null || total <= 0) return { error: `Row ${rowNo}: "total" doesn't parse as a positive number ("${cell(cells, 'total')}")` };
    if (lineNo === null || lineNo <= 0 || !Number.isInteger(lineNo)) return { error: `Row ${rowNo}: "line" is not a positive integer ("${cell(cells, 'line')}")` };
    if (!item) return { error: `Row ${rowNo}: empty "item"` };
    if (!itemEn) return { error: `Row ${rowNo}: empty "item_en"` };
    if (qty === null || qty <= 0) return { error: `Row ${rowNo}: "qty" doesn't parse as a positive number ("${cell(cells, 'qty')}")` };
    if (lineTotal === null) return { error: `Row ${rowNo}: "line_total" doesn't parse as a number ("${cell(cells, 'line_total')}")` };

    const time = cell(cells, 'time');
    const row = {
      rowNo, printedReceipt, date, time: /^\d{2}:\d{2}$/.test(time) ? time : '',
      store, chain: cell(cells, 'chain'), city: cell(cells, 'city') || null, country: cell(cells, 'country') || null,
      currency, total, lineNo, item, itemEn, qty,
      unit: /^(pcs|kg|l|other)$/.test(cell(cells, 'unit')) ? cell(cells, 'unit') : 'pcs',
      unitPriceList: parseNum(cell(cells, 'unit_price_list')),
      unitPricePaid: parseNum(cell(cells, 'unit_price_paid')),
      lineTotal, barcode: cell(cells, 'barcode') || null, note: cell(cells, 'note') || null,
    };
    if (!byReceipt.has(printedReceipt)) byReceipt.set(printedReceipt, []);
    byReceipt.get(printedReceipt).push(row);
  }

  const receipts = [];
  const skipped = [];
  for (const [printedReceipt, rows] of byReceipt) {
    const first = rows[0];
    const disagrees = rows.find(r => r.date !== first.date || r.store !== first.store || r.currency !== first.currency || r.total !== first.total);
    if (disagrees) {
      skipped.push({ printedReceipt, reason: `rows ${first.rowNo} and ${disagrees.rowNo} disagree on date/store/currency/total` });
      continue;
    }

    // duplicate line numbers -> renumbered in file order (a warning, not an error)
    const warnings = [];
    const seenLineNo = new Set();
    let dupes = 0;
    const lines2 = rows.map((r, i) => {
      if (seenLineNo.has(r.lineNo)) { dupes++; return { ...r, lineNo: rows.length + i }; }
      seenLineNo.add(r.lineNo);
      return r;
    });
    if (dupes) warnings.push(`${dupes} duplicate line number(s) renumbered in file order`);

    for (const r of lines2) {
      if (r.unitPricePaid != null && Math.abs(r.qty * r.unitPricePaid - r.lineTotal) > 0.01) {
        warnings.push(`line ${r.lineNo} (${r.item.slice(0, 40)}): qty × unit_price_paid = ${(r.qty * r.unitPricePaid).toFixed(2)}, line_total = ${r.lineTotal.toFixed(2)}`);
      }
    }
    const linesSum = Math.round(lines2.reduce((a, r) => a + r.lineTotal, 0) * 100) / 100;
    const other = Math.round((first.total - linesSum) * 100) / 100;
    if (Math.abs(other) >= 0.005) warnings.push(`lines add up to ${linesSum.toFixed(2)}, the receipt's total is ${first.total.toFixed(2)} (shown as "Other": ${other.toFixed(2)})`);

    receipts.push({
      receiptKey: `${first.date}|${printedReceipt}|${first.total}`,
      printedReceipt, date: first.date, time: first.time,
      purchasedAt: first.time ? `${first.date}T${first.time}:00Z` : null,
      store: first.store, chain: first.chain || null, city: first.city, country: first.country,
      currency: first.currency, total: first.total,
      lines: lines2.map(r => ({
        lineNo: r.lineNo, namePrinted: r.item, nameEn: r.itemEn, qty: r.qty, unit: r.unit,
        unitPriceList: r.unitPriceList, unitPricePaid: r.unitPricePaid, lineTotal: r.lineTotal,
        barcode: r.barcode, note: r.note,
      })),
      warnings, otherAmount: other,
    });
  }

  return { receipts, skipped };
}

// When a receipt's lines are replaced (the same receipt_key uploaded again),
// a note the user wrote on a line survives: placed back on the new line with
// the same line_no, else the new line whose normalized printed name matches,
// else appended to the receipt's own note so it isn't lost silently.
export function carryOverNotes(oldLines, newLines) {
  const byLineNo = new Map(oldLines.filter(l => l.note).map(l => [l.lineNo, l]));
  const byName = new Map(oldLines.filter(l => l.note).map(l => [receiptNorm(l.namePrinted), l]));
  const placed = new Set();
  const out = newLines.map(nl => {
    if (nl.note) return nl;   // the new upload already brought its own note (receipt_csv rarely does, but don't overwrite)
    const byNo = byLineNo.get(nl.lineNo);
    if (byNo) { placed.add(byNo); return { ...nl, note: byNo.note }; }
    const byNm = byName.get(receiptNorm(nl.namePrinted));
    if (byNm && !placed.has(byNm)) { placed.add(byNm); return { ...nl, note: byNm.note }; }
    return nl;
  });
  const leftover = oldLines.filter(l => l.note && !placed.has(l));
  return { lines: out, leftover };
}

// match_receipts' tie-break rule (migration ...179, receipt_match_candidates
// + the narrowing in match_receipts itself), mirrored here so the rule can
// be unit-tested without a database. `candidates`: [{externalSource,
// externalId, account, chainHit, dateDist}]. Returns { state, pick }.
export function pickMatch(candidates) {
  if (!candidates.length) return { state: 'waiting', pick: null };
  const anyChain = candidates.some(c => c.chainHit);
  const narrowed = anyChain ? candidates.filter(c => c.chainHit) : candidates;
  const bestDist = Math.min(...narrowed.map(c => c.dateDist));
  const final = narrowed.filter(c => c.dateDist === bestDist);
  if (final.length === 1) return { state: 'linked', pick: final[0] };
  return { state: 'ambiguous', pick: null };
}
