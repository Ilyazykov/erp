// Supabase Edge Function: import-ziraat-statement
//
// Parses a Ziraat Bank (Turkey) "Hesap Hareketleri" account-activity export
// and inserts the resulting rows into `bank_transactions` -- same
// destination table and shape as import-boc-statement, just a different
// source bank.
//
// Unlike every other importer in this project, the file is a real .xlsx
// (not CSV) -- Ziraat's own export tool doesn't offer a CSV option. Parsed
// here with the `xlsx` (SheetJS) library rather than pushing a client-side
// parser into index.html, to keep the browser side a single dumb "upload
// whatever file" flow and all format-specific logic server-side, matching
// every other importer.
//
// Ziraat splits a single customer relationship into one *separate* account
// per currency (TL/USD/EUR), each with its own IBAN, rather than one
// multi-currency account like Bank of Cyprus. The file itself never states
// its currency directly -- it has to be read off the last segment of the
// "Account Number" header cell (e.g. "...5001 ... TL", "...5002 ... USD",
// "...5003 ... EUR"). Three such files (one per currency) are expected to
// be uploaded separately; this function only knows how to handle one at a
// time, keyed off whatever currency its own header cell states.
//
// Known layout (first sheet, no header row at a fixed offset -- located by
// scanning for the literal "Date" cell that starts the real table):
//   Dear <name>
//   Account activities between <dd.mm.yyyy> - <dd.mm.yyyy> are listed.
//   Account Number | | <branch/name> <CCY>
//   IBAN | | <iban>
//   (blank rows)
//   Account Activities
//   Date | Invoice No. | Explanation | Transaction Amount | Balance
//   <dd.mm.yyyy> | <ref> | <description> | <signed amount> | <balance>
//   ...
//   (blank)
//   Amount Owed:... | Recipient:...          <- summary footer, not a row
//   <legal boilerplate>
//
// Amounts are already signed (negative = debit) and use plain dot-decimal
// numbers (unlike Bank of Cyprus's European "." thousands / "," decimal
// formatting) -- xlsx's own numeric cell type gives these back as JS
// numbers directly, no string parsing needed.
//
// No per-row timestamp, so the dedup key mirrors the Bank of Cyprus
// importer: (date, invoice no., description, signed amount) with an
// occurrence-counter tie-breaker for legitimate same-day duplicates (e.g.
// the two "İnternet Döviz Satış" / "İnternet Döviz Alış" rows sharing one
// invoice number for a single FX conversion, which do need to stay
// distinct rows -- they have different amounts).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clockFor, orderWithinGroups } from '../_shared/day_order.ts';
import * as XLSX from 'npm:xlsx@0.18.5';

interface ZiraatRow {
  date: string;
  invoiceNo: string;
  description: string;
  amount: number;
  balanceAfter: number | null;
}

// "16.09.2026" -> "2026-09-16".
function parseDate(s: string): string | null {
  const m = String(s).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Reads the currency off the "Account Number" header cell, e.g.
// "1553-103119215-5001 MURATPAŞA/ANTALYA ŞUBESİ TL" -> "TL" (normalized to
// "TRY", the ISO code) / "...5002 ... USD" -> "USD" / "...5003 ... EUR" -> "EUR".
// The currency is always the last whitespace-separated token.
function detectCurrency(accountNumberCell: string): string | null {
  const token = accountNumberCell.trim().split(/\s+/).pop();
  if (!token) return null;
  if (token === 'TL') return 'TRY';
  if (token === 'USD' || token === 'EUR' || token === 'GBP') return token;
  return null;
}

function parseRows(sheet: XLSX.WorkSheet): { rows: ZiraatRow[]; currency: string | null } {
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  let currency: string | null = null;
  let headerRowIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!currency && row[0] === 'Account Number' && typeof row[2] === 'string') {
      currency = detectCurrency(row[2]);
    }
    if (row[0] === 'Date' && row[1] === 'Invoice No.') {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return { rows: [], currency };

  const rows: ZiraatRow[] = [];
  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.length === 0 || row[0] == null) continue;  // blank separator row
    const dateCell = row[0];
    // The footer ("Amount Owed:...") reuses column A but never matches the
    // dd.mm.yyyy date shape, so this filter alone is enough to stop before it.
    if (typeof dateCell !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(dateCell.trim())) continue;

    const amount = row[3];
    if (typeof amount !== 'number') continue;

    rows.push({
      date: dateCell.trim(),
      invoiceNo: String(row[1] ?? ''),
      description: String(row[2] ?? '').trim(),
      amount,
      balanceAfter: typeof row[4] === 'number' ? row[4] : null,
    });
  }
  return { rows, currency };
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: corsHeaders });
    }

    const fileBytes = new Uint8Array(await req.arrayBuffer());
    const workbook = XLSX.read(fileBytes, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return new Response(JSON.stringify({ error: 'No sheet found in workbook' }),
        { status: 400, headers: corsHeaders });
    }

    const { rows: ziraatRows, currency } = parseRows(sheet);
    if (!currency) {
      return new Response(JSON.stringify({
        error: 'Could not detect account currency from the "Account Number" header cell '
          + '(expected it to end in TL, USD, or EUR)',
      }), { status: 400, headers: corsHeaders });
    }
    if (!ziraatRows.length) {
      return new Response(JSON.stringify({ error: 'No parseable rows found (unrecognized sheet layout?)' }),
        { status: 400, headers: corsHeaders });
    }

    const account = 'Ziraat Bank';
    let skippedBadDate = 0;

    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of ziraatRows) {
      const isoDate = parseDate(r.date);
      if (!isoDate) { skippedBadDate++; continue; }

      const signature = `${r.date}:${r.invoiceNo}:${r.description}:${r.amount}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        account,
        tx_date: `${isoDate}T00:00:00Z`,
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency,
        category: null,
        balance_after: r.balanceAfter,
        external_source: 'ziraat_xlsx',
        external_id: occurrence === 0 ? signature : `${signature}:dup${occurrence}`,
      });
    }


    // Same-day rows (the statement has dates only) get 00:00:SS by the order
    // the bank applied them, so the day's last row -- the account's balance --
    // really is the latest by tx_date (see _shared/day_order.ts).
    const dates = rows.map(r => r.tx_date);
    const pos = orderWithinGroups(rows, r => `${r.currency} ${r.tx_date}`, r => r.amount, r => r.balance_after,
      dates.length > 1 && dates[0] > dates[dates.length - 1]);
    rows.forEach((r, i) => { r.tx_date = r.tx_date.replace('T00:00:00Z', `T${clockFor(pos[i])}Z`); });

    if (!rows.length) {
      return new Response(JSON.stringify({
        error: 'No importable rows found',
        skipped_bad_date: skippedBadDate,
      }), { status: 400, headers: corsHeaders });
    }

    const { error: upsertErr, count } = await supabase
      .from('bank_transactions')
      .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });

    if (upsertErr) {
      return new Response(JSON.stringify({ error: upsertErr.message }),
        { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      imported: count ?? rows.length,
      currency,
      total_rows: ziraatRows.length,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
