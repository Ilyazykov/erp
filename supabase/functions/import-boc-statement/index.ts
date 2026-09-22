// Supabase Edge Function: import-boc-statement
//
// Parses a Bank of Cyprus "Transaction History" CSV export (1Bank ->
// Accounts -> Transaction history -> Export) and inserts the resulting
// rows into `bank_transactions` for the authenticated caller -- same
// destination table and shape as import-revolut-statement, just a
// different source bank.
//
// CSV shape (confirmed from a real export):
//   5 metadata lines (Period:, Account number:, Account name:, Account
//   type:, Account currency:), then a header row:
//     Date,Description,Transaction type,Reference number,Debit,Credit,
//     Indicative balance,Value date,Bank reference number,Branch code
//   Dates are DD/MM/YYYY. Debit/Credit are separate columns (only one of
//   the two is populated per row) using European number formatting
//   ("1.234,56" -- "." as thousands separator, "," as decimal point).
//
// Bank of Cyprus's own web export only covers the trailing 12 months, so
// older history has to come from PDF statements instead; this importer
// only knows about the CSV shape -- older rows are hand-transcribed into
// the same CSV shape before upload (matching column-for-column), which is
// enough for this parser to treat them identically.
//
// amount is signed here (positive = Credit, negative = Debit) to match
// `bank_transactions.amount`'s documented convention -- unlike Revolut's
// CSV, which already carries a signed Amount column, Bank of Cyprus splits
// debit/credit into two unsigned columns that need combining.
//
// There's no per-row timestamp (just a plain calendar date), and Bank of
// Cyprus's own "Reference number" is often blank (e.g. plain card
// purchases carry no reference), so the dedup key is
// (date, description, transaction type, signed amount) with the same
// occurrence-counter tie-breaker used by the other importers for
// legitimate same-day duplicates (e.g. two identical Wolt orders).

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface BocRow {
  date: string;
  description: string;
  transactionType: string;
  amount: number;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
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
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// "31/08/2026" -> "2026-08-31".
function parseDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// "1.234,56" -> 1234.56. Bank of Cyprus's export uses European formatting
// ("." thousands, "," decimal) regardless of the value's own currency.
function parseEuroNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function parseRows(text: string): BocRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);

  let idx: { date: number; description: number; type: number; debit: number; credit: number } | null = null;
  const rows: BocRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (!idx) {
      const header = cells.map(h => h.trim());
      if (header[0] === 'Date' && header[1] === 'Description') {
        const col = (name: string) => header.indexOf(name);
        idx = {
          date: col('Date'), description: col('Description'), type: col('Transaction type'),
          debit: col('Debit'), credit: col('Credit'),
        };
      }
      continue;
    }

    const date = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    if (!date || !description) continue;

    const debit = parseEuroNumber(cells[idx.debit] || '');
    const credit = parseEuroNumber(cells[idx.credit] || '');
    if (debit === null && credit === null) continue;  // neither column parsed -- not a money row

    rows.push({
      date,
      description,
      transactionType: (cells[idx.type] || '').trim(),
      amount: credit !== null ? credit : -(debit as number),
    });
  }
  return rows;
}

// Best-effort keyword categorization, same style/purpose as
// import-revolut-statement's CATEGORY_RULES.
const CATEGORY_RULES: [RegExp, string][] = [
  [/instant access savings|flexible cash funds|net interest paid/i, 'internal_transfer'],
  [/wolt|bolt food|glovo|careem eat/i, 'food_delivery'],
  [/\bbolt\b|taxi|careem\b|cpt(cyprus)? public trans|public transport/i, 'transport'],
  [/mpe properties|rent for/i, 'rent'],
  [/^transfer$|^transfer\b/i, 'transfer'],
  [/tips inward|tips outward/i, 'p2p_transfer'],
  [/maintenance fees|card memb|certificate issue charges|commission/i, 'bank_fee'],
  [/payroll|>payroll|salary/i, 'salary'],
  [/premier cinemas|cinema/i, 'entertainment'],
  [/kiosk|bakery|mini market|supermarket|cyta\b/i, 'utilities_or_shopping'],
  [/revolut|wise\b/i, 'brokerage_funding'],
];

function categorize(type: string, description: string): string | null {
  const haystack = `${type} ${description}`;
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(haystack)) return cat;
  }
  return null;
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

    const csvText = await req.text();
    const csvRows = parseRows(csvText);
    if (!csvRows.length) {
      return new Response(JSON.stringify({ error: 'No parseable rows found (unrecognized CSV header?)' }),
        { status: 400, headers: corsHeaders });
    }

    const account = 'Bank of Cyprus';
    let skippedBadDate = 0;

    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of csvRows) {
      const isoDate = parseDate(r.date);
      if (!isoDate) { skippedBadDate++; continue; }

      // No per-row timestamp is available (unlike Revolut's Started
      // Date), so several genuinely distinct same-day transactions can
      // share the same (date, description, type, amount) signature (e.g.
      // two identical Wolt orders on one day) -- an occurrence counter
      // folded into external_id tells them apart instead of colliding.
      const signature = `${r.date}:${r.description}:${r.transactionType}:${r.amount}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        account,
        tx_date: `${isoDate}T00:00:00Z`,
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency: 'EUR',
        category: categorize(r.transactionType, r.description),
        balance_after: null,
        external_source: 'boc_csv',
        external_id: occurrence === 0 ? signature : `${signature}:dup${occurrence}`,
      });
    }

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
      total_rows: csvRows.length,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
