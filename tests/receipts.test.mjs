// Checks the receipt-items feature's pure logic (supabase/functions/_shared/
// receipts.js, design: docs/items-design.md, not tracked in git): the CSV
// parser and its warnings, note carry-over when a receipt's lines are
// replaced, and match_receipts' tie-break rule (its SQL twin is migration
// ...179's match_receipts / receipt_match_candidates).
// Run: node tests/receipts.test.mjs
import { parseReceiptCsv, receiptNorm, carryOverNotes, pickMatch } from '../supabase/functions/_shared/receipts.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// ---- the real SPAR receipt (07.11.2026, see the chat history) ----
const HEADER = 'receipt,date,time,store,chain,city,country,currency,total,line,item,item_en,qty,unit,unit_price_list,unit_price_paid,line_total,barcode,note';
const spar = [
  HEADER,
  '436041659,2026-11-07,16:52,S146 Tbilisi Kostava 20,SPAR,Tbilisi,GE,GEL,23.18,1,"თევზის კონსერვი /Dardanel/ თინუსი სალათი მექსიკური ლობიოთი 160 გრ",Dardanel tuna salad with Mexican beans 160 g,2,pcs,12.90,11.49,22.98,,',
  '436041659,2026-11-07,16:52,S146 Tbilisi Kostava 20,SPAR,Tbilisi,GE,GEL,23.18,2,"პოლიეთილენის პარკი /54 X 70/ (სალაროსთვის დიდი სპარი)",Polyethylene bag 54x70 (large cashier bag),1,pcs,0.20,0.20,0.20,,',
].join('\n');

{
  const out = parseReceiptCsv(spar);
  check(!('error' in out), `the SPAR receipt parses without a file-level error${'error' in out ? `: ${out.error}` : ''}`);
  check(out.receipts?.length === 1, `one receipt (got ${out.receipts?.length})`);
  const r = out.receipts[0];
  check(r?.lines.length === 2, `two lines (got ${r?.lines.length})`);
  check(r?.receiptKey === '2026-11-07|436041659|23.18', `key 2026-11-07|436041659|23.18 (got ${r?.receiptKey})`);
  check(near(r?.lines.reduce((a, l) => a + l.lineTotal, 0), 23.18), 'lines sum to the receipt total');
  check(near(r?.otherAmount, 0), `no "Other" gap (got ${r?.otherAmount})`);
  check(r?.warnings.length === 0, `no warnings (got ${JSON.stringify(r?.warnings)})`);
  check(r?.chain === 'SPAR', 'chain read as SPAR');
  check(r?.purchasedAt === '2026-11-07T16:52:00Z', `purchasedAt 2026-11-07T16:52:00Z (got ${r?.purchasedAt})`);
}

// ---- missing required column -> the whole file is rejected ----
{
  const noTotal = HEADER.replace(',total,', ',').replace(/,23\.18,/g, ',');
  const out = parseReceiptCsv([noTotal, spar.split('\n')[1].replace(',23.18,', ',')].join('\n'));
  check('error' in out && /total/.test(out.error), `a file without "total" is rejected (got ${JSON.stringify(out)})`);
}

// ---- a bad required value names its row ----
{
  const bad = spar.replace('2026-11-07,16:52', '07.11.2026,16:52');   // first row's date only
  const out = parseReceiptCsv(bad);
  check('error' in out && /Row 2/.test(out.error) && /date/.test(out.error), `a bad date on row 2 is rejected by row (got ${JSON.stringify(out)})`);
}

// ---- rows of one receipt disagreeing on date/store/currency/total: that receipt is skipped, not the file ----
{
  const mixed = [HEADER, ...spar.split('\n').slice(1)];
  mixed.push('436041659,2026-11-08,16:52,S146 Tbilisi Kostava 20,SPAR,Tbilisi,GE,GEL,23.18,3,Something else,Something else,1,pcs,,,1.00,,');
  const out = parseReceiptCsv(mixed.join('\n'));
  check(!('error' in out), 'the file as a whole is still accepted');
  check(out.receipts.length === 0, `the disagreeing receipt is skipped, not accepted (got ${out.receipts.length})`);
  check(out.skipped.length === 1 && /disagree/.test(out.skipped[0].reason), `one skipped receipt, reason mentions disagreement (got ${JSON.stringify(out.skipped)})`);
}

// ---- a line total off qty × unit_price_paid warns, without rejecting anything ----
{
  const off = spar.replace('11.49,22.98', '11.49,25.00');   // 2 × 11.49 = 22.98, not 25.00
  const out = parseReceiptCsv(off);
  check(!('error' in out) && out.receipts.length === 1, 'still accepted');
  check(out.receipts[0].warnings.some(w => /qty × unit_price_paid/.test(w)), `a mismatch warning is raised (got ${JSON.stringify(out.receipts[0].warnings)})`);
}

// ---- lines not summing to the total: a warning, with the gap reported ----
{
  const short = spar.replace(/\n[^\n]*line 2[^\n]*$/s, '');   // drop the bag line entirely (keep header+line1)
  const oneLine = [spar.split('\n')[0], spar.split('\n')[1]].join('\n');
  const out = parseReceiptCsv(oneLine);
  check(near(out.receipts[0].otherAmount, 0.20), `the gap left by the dropped line is 0.20 (got ${out.receipts[0].otherAmount})`);
  check(out.receipts[0].warnings.some(w => /Other/.test(w)), 'a warning mentions the gap');
}

// ---- duplicate line numbers are renumbered, not rejected ----
{
  const dup = spar.replace(',2,"', ',1,"');   // line 2's own "line" column set to 1 too
  const out = parseReceiptCsv(dup);
  check(!('error' in out), 'still accepted');
  check(out.receipts[0].warnings.some(w => /duplicate/.test(w)), 'a duplicate-line-number warning is raised');
  check(new Set(out.receipts[0].lines.map(l => l.lineNo)).size === 2, 'the two lines end up with different line numbers');
}

// ---- receiptNorm: case, punctuation, digits kept ----
check(receiptNorm('Dardanel/ 160 გრ!!') === receiptNorm('dardanel 160 გრ'), 'receiptNorm ignores case and punctuation, keeps digits');

// ---- note carry-over: same line number, else same normalized name, else left over ----
{
  const oldLines = [
    { lineNo: 1, namePrinted: 'Tuna salad', note: 'bought for the trip' },
    { lineNo: 2, namePrinted: 'Bag', note: 'reusable, keep' },
  ];
  // the new upload renumbers the bag to line 3 but keeps its printed name
  const newLines = [
    { lineNo: 1, namePrinted: 'Tuna salad', note: null },
    { lineNo: 3, namePrinted: 'Bag', note: null },
  ];
  const { lines, leftover } = carryOverNotes(oldLines, newLines);
  check(lines[0].note === 'bought for the trip', 'line 1 keeps its note by line number');
  check(lines[1].note === 'reusable, keep', 'the bag keeps its note by matching printed name across the renumbering');
  check(leftover.length === 0, 'nothing left over when every note found a home');
}
{
  // the item a note was on is gone from the new upload -> the note is leftover, not dropped
  const oldLines = [{ lineNo: 1, namePrinted: 'Tuna salad', note: 'for the trip' }, { lineNo: 2, namePrinted: 'Discontinued item', note: 'odd one' }];
  const newLines = [{ lineNo: 1, namePrinted: 'Tuna salad', note: null }];
  const { leftover } = carryOverNotes(oldLines, newLines);
  check(leftover.length === 1 && leftover[0].namePrinted === 'Discontinued item', 'a note whose line vanished is reported as leftover, not silently dropped');
}

// ---- pickMatch: the tie-break rule (chain, then nearest date) ----
{
  const c = (externalId, chainHit, dateDist) => ({ externalSource: 'tbc_bank_csv:x', externalId, account: 'TBC Bank', chainHit, dateDist });
  check(pickMatch([]).state === 'waiting', 'no candidates -> waiting');
  check(pickMatch([c('a', false, 0)]).state === 'linked', 'one candidate -> linked');
  {
    const r = pickMatch([c('a', false, 2), c('b', true, 1), c('c', false, 0)]);
    check(r.state === 'linked' && r.pick.externalId === 'b', `the chain hit wins over a closer date (got ${r.state} ${r.pick?.externalId})`);
  }
  {
    const r = pickMatch([c('a', false, 0), c('b', false, 2)]);
    check(r.state === 'linked' && r.pick.externalId === 'a', `with no chain hits, the nearest date wins (got ${r.state} ${r.pick?.externalId})`);
  }
  {
    const r = pickMatch([c('a', true, 0), c('b', true, 0)]);
    check(r.state === 'ambiguous' && r.pick === null, `a true tie (same chain hit, same date) stays ambiguous (got ${r.state})`);
  }
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
