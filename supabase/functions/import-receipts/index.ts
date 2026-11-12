// Supabase Edge Function: import-receipts
//
// Parses this project's own receipt-items CSV -- the shape a receipt photo
// is turned into by an LLM outside this app (no photo parsing and no paid
// model API in here) -- and writes receipts/receipt_items (migration
// ...179, design: docs/items-design.md, not tracked in git). One row per
// printed item line; several receipts (grouped by the `receipt` column) can
// be in one file.
//
// CSV shape (this project's own, not a bank or shop export):
//   receipt,date,time,store,chain,city,country,currency,total,line,item,
//   item_en,qty,unit,unit_price_list,unit_price_paid,line_total,barcode,note
// Parsing, per-receipt consistency, warnings and the idempotency key
// (`<date>|<printed receipt>|<total>`) all live in _shared/receipts.js,
// shared with tests/receipts.test.mjs so the rule is tested once, not
// twice by hand.
//
// A receipt uploaded again under the same key (same date/printed number/
// total: a corrected photo-to-CSV re-run) updates its store/chain/lines in
// place rather than making a second receipt; a line's note is carried over
// to the new line with the same line number, else the same printed name
// (receipts.js' carryOverNotes), and a note that can't be placed is
// appended to the receipt's own note instead of being dropped.
//
// A receipt with no bank transaction to link to makes one itself
// (account '<unknown>', external_source 'receipt_csv'), and a statement
// that later carries the same payment is folded into that row -- both in
// match_receipts (migration ...191), not here. Items never change expense
// categories.
//
// Items are linked to a transaction, resolved against the store's place and
// have their "Other" gap computed by match_receipts / the receipt_lines
// view (migration ...179) after this function writes them -- called once
// at the end, the same way import-bank-csv settles TBC's pending holds
// after writing its rows.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseReceiptCsv, receiptNorm, carryOverNotes } from '../_shared/receipts.js';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const csvText = await req.text();
    const parsed = parseReceiptCsv(csvText);
    if ('error' in parsed) return json({ error: parsed.error }, 400);
    const { receipts: fileReceipts, skipped } = parsed;
    if (!fileReceipts.length) {
      return json({ error: skipped.length ? `Every receipt in the file was skipped: ${skipped.map(s => s.reason).join('; ')}` : 'No rows found' }, 400);
    }

    const results: Array<{
      receiptKey: string; printedReceipt: string; date: string; store: string; lines: number;
      otherAmount: number; warnings: string[]; unmatchedProducts: number;
    }> = [];

    for (const r of fileReceipts) {
      const { data: existing, error: exErr } = await supabase.from('receipts')
        .select('id, note').eq('user_id', user.id).eq('source', 'receipt_csv').eq('receipt_key', r.receiptKey).maybeSingle();
      if (exErr) throw new Error(exErr.message);

      let receiptId: number;
      let leftoverNote = '';
      let lines = r.lines;
      if (existing) {
        receiptId = existing.id;
        const { data: oldLines, error: olErr } = await supabase.from('receipt_items')
          .select('line_no, name_printed, note').eq('receipt_id', receiptId);
        if (olErr) throw new Error(olErr.message);
        const carried = carryOverNotes(
          (oldLines ?? []).map(l => ({ lineNo: l.line_no, namePrinted: l.name_printed, note: l.note })),
          r.lines,
        );
        lines = carried.lines;
        if (carried.leftover.length) {
          leftoverNote = carried.leftover.map(l => `line ${l.lineNo} (${l.namePrinted}): ${l.note}`).join(' | ');
        }
        // a leftover note (one that couldn't be placed back on a line) is
        // appended, never replacing whatever the user already wrote here
        const note = leftoverNote ? [existing.note, leftoverNote].filter(Boolean).join(' | ') : undefined;
        const { error: upErr } = await supabase.from('receipts').update({
          store_printed: r.store, chain: r.chain, city: r.city, country: r.country,
          purchased_at: r.purchasedAt, note, updated_at: new Date().toISOString(),
        }).eq('id', receiptId);
        if (upErr) throw new Error(upErr.message);
        const { error: delErr } = await supabase.from('receipt_items').delete().eq('receipt_id', receiptId);
        if (delErr) throw new Error(delErr.message);
      } else {
        const { data: ins, error: insErr } = await supabase.from('receipts').insert({
          user_id: user.id, source: 'receipt_csv', receipt_key: r.receiptKey,
          purchased_at: r.purchasedAt, purchased_on: r.date,
          store_printed: r.store, chain: r.chain, city: r.city, country: r.country,
          currency: r.currency, total: r.total, note: leftoverNote || null,
        }).select('id').single();
        if (insErr) throw new Error(insErr.message);
        receiptId = ins.id;
      }

      // product linking: a barcode match first, else a confirmed alias for
      // this printed name (this receipt's chain, else one saved for "any shop")
      let unmatched = 0;
      const rows = [];
      for (const l of lines) {
        let productId: number | null = null;
        if (l.barcode) {
          const { data: byBarcode } = await supabase.from('products')
            .select('id').eq('barcode', l.barcode).is('merged_into', null).maybeSingle();
          productId = byBarcode?.id ?? null;
        }
        if (!productId) {
          const norm = receiptNorm(l.namePrinted);
          const { data: aliases } = await supabase.from('product_aliases')
            .select('product_id, chain').eq('name_norm', norm);
          // filtered here, not with .in('chain', [...]): for a receipt with no
          // chain that list is ['', ''], sent as in.(,) -- which matches nothing
          const best = (aliases ?? []).filter(a => a.chain === '' || a.chain === (r.chain || '')).sort((a, b) => (b.chain === (r.chain || '') ? 1 : 0) - (a.chain === (r.chain || '') ? 1 : 0))[0];
          productId = best?.product_id ?? null;
        }
        if (!productId) unmatched++;
        rows.push({
          user_id: user.id, receipt_id: receiptId, line_no: l.lineNo, name_printed: l.namePrinted, name_en: l.nameEn,
          product_id: productId, qty: l.qty, unit: l.unit, unit_price_list: l.unitPriceList, unit_price_paid: l.unitPricePaid,
          line_total: l.lineTotal, barcode: l.barcode, note: l.note,
        });
      }
      if (rows.length) {
        const { error: itemsErr } = await supabase.from('receipt_items').insert(rows);
        if (itemsErr) throw new Error(itemsErr.message);
      }

      results.push({
        receiptKey: r.receiptKey, printedReceipt: r.printedReceipt, date: r.date, store: r.store,
        lines: rows.length, otherAmount: r.otherAmount, warnings: r.warnings, unmatchedProducts: unmatched,
      });
    }

    const { data: linkedCount, error: mErr } = await supabase.rpc('match_receipts');
    if (mErr) throw new Error(mErr.message);

    // the final match_state / linked account per receipt, for the page's
    // status line and for statement_uploads (logged client-side, same as
    // every other importer -- mpLogUpload, index.html)
    const keys = fileReceipts.map(r => r.receiptKey);
    const { data: states } = await supabase.from('receipts')
      .select('receipt_key, match_state, tx_source, tx_external_id, last_match_candidates')
      .eq('user_id', user.id).eq('source', 'receipt_csv').in('receipt_key', keys);
    const accountsOf = new Map<string, string>();
    const bySrcXid = new Map((states ?? []).filter(s => s.tx_source).map(s => [`${s.tx_source}|${s.tx_external_id}`, s]));
    if (bySrcXid.size) {
      const { data: txs } = await supabase.from('bank_transactions').select('external_source, external_id, account')
        .eq('user_id', user.id).in('external_source', [...new Set([...bySrcXid.values()].map(s => s.tx_source))]);
      for (const t of txs ?? []) {
        const s = bySrcXid.get(`${t.external_source}|${t.external_id}`);
        if (s) accountsOf.set(s.receipt_key, t.account);
      }
    }
    const stateOf = new Map((states ?? []).map(s => [s.receipt_key, s]));
    const enriched = results.map(r => {
      const s = stateOf.get(r.receiptKey);
      return { ...r, matchState: s?.match_state ?? 'waiting', account: accountsOf.get(r.receiptKey) ?? null, candidates: s?.last_match_candidates ?? 0 };
    });

    return json({
      receipts: enriched,
      skipped,
      total_in_file: fileReceipts.length + skipped.length,
      accepted: fileReceipts.length,
      linked: enriched.filter(r => r.matchState === 'linked' || r.matchState === 'manual_link').length,
      waiting: enriched.filter(r => r.matchState === 'waiting').length,
      ambiguous: enriched.filter(r => r.matchState === 'ambiguous').length,
      total_lines: enriched.reduce((a, r) => a + r.lines, 0),
      unmatched_products: enriched.reduce((a, r) => a + r.unmatchedProducts, 0),
      linked_this_run: linkedCount ?? 0,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
