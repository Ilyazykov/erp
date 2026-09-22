// Supabase Edge Function: import-revolut-statement
//
// Parses a Revolut "Account statement" CSV export (Profile -> Statements ->
// Account statement -> CSV) and inserts the resulting rows into
// `bank_transactions` for the authenticated caller. The browser uploads the
// CSV text as-is (see import-trades-csv for the same pattern); all parsing
// happens here, server-side.
//
// CSV header (confirmed from a real export):
//   Type,Product,Started Date,Completed Date,Description,Amount,Fee,
//   Currency,State,Balance
//
// One file can contain many currencies/products back to back (Current EUR,
// Current GBP, Current AED, Deposit USD, Deposit EUR, ...) -- each block's
// Balance column restarts at its own running total. `currency` comes
// straight from the CSV's own Currency column per row, so blocks don't need
// to be separated explicitly; `account` is a flat 'Revolut' for every row
// (per-currency/product breakdowns are still recoverable later by grouping
// on `currency`, since that's stored per row).
//
// `Product=Deposit` rows (Instant Access Savings) are skipped entirely --
// same reasoning as Flexible Cash Funds: a savings "pot" accrues its own
// daily interest and is conceptually a separate balance, not a same-day
// spend/income event on the main account. Its own transfers in/out of the
// Current account (e.g. "From Instant Access Savings") DO still appear as
// Product=Current rows in this same file and are imported normally (see
// below on internal transfers).
//
// Internal transfers ("To/From Flexible Cash Funds", "To/From Instant
// Access Savings", "Net Interest Paid to ...") are still imported as
// ordinary rows -- NOT skipped -- because the user needs every row present
// to reconcile the account's own running balance; they're just tagged with
// category 'internal_transfer' so they can be excluded from spend reports
// later without needing to be dropped from the ledger now.
//
// State: only 'COMPLETED' rows are imported. 'REVERTED' rows never
// actually settled (a reversed card auth), and 'PENDING' rows aren't final
// yet -- both would double-count or later conflict with the eventual
// completed row for the same purchase.
//
// Every row lands in `bank_transactions`, never in `trades` -- see
// 20250101000008_bank_transactions.sql for why (trades is shaped around
// ticker+quantity+price asset transactions; a Wolt payment has neither).

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface CsvRow {
  type: string;
  product: string;
  startedDate: string;
  completedDate: string;
  description: string;
  amount: number;
  fee: number;
  currency: string;
  state: string;
  balance: string;
}

// RFC 4180-ish CSV line splitter -- handles quoted fields with embedded
// commas (e.g. "Net Interest Paid to 'Instant Access Savings' for Aug 30,
// 2025" contains a comma inside quotes) and "" as an escaped quote.
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

// "2025-10-11 01:16:36" -> "2025-10-11T01:16:36Z". Revolut's CSV export
// gives naive local-ish timestamps with no timezone marker; treated as UTC
// here (Revolut's own statements are UTC-based) so Postgres parses them as
// an unambiguous instant rather than guessing the session timezone.
function toIsoTimestamp(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}T${m[2]}Z` : null;
}

function parseRows(text: string): CsvRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map(h => h.trim());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    type: col('Type'), product: col('Product'), started: col('Started Date'),
    completed: col('Completed Date'), description: col('Description'),
    amount: col('Amount'), fee: col('Fee'), currency: col('Currency'),
    state: col('State'), balance: col('Balance'),
  };
  if (idx.type < 0 || idx.started < 0 || idx.amount < 0 || idx.currency < 0 || idx.state < 0) {
    return [];
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const amount = parseFloat((cells[idx.amount] || '').replace(/,/g, ''));
    if (Number.isNaN(amount)) continue;
    rows.push({
      type: (cells[idx.type] || '').trim(),
      product: (cells[idx.product] || '').trim(),
      startedDate: (cells[idx.started] || '').trim(),
      completedDate: (cells[idx.completed] || '').trim(),
      description: (cells[idx.description] || '').trim(),
      amount,
      fee: parseFloat((cells[idx.fee] || '0').replace(/,/g, '')) || 0,
      currency: (cells[idx.currency] || '').trim(),
      state: (cells[idx.state] || '').trim(),
      balance: (cells[idx.balance] || '').trim(),
    });
  }
  return rows;
}

// Best-effort keyword categorization -- not authoritative, just a starting
// bucket for future reporting. Internal transfers are tagged distinctly so
// they can be excluded from "how much did I spend" views without being
// dropped from the ledger (see module docstring).
const CATEGORY_RULES: [RegExp, string][] = [
  [/flexible cash funds|instant access savings|net interest paid/i, 'internal_transfer'],
  [/wolt|bolt food|glovo|careem eat/i, 'food_delivery'],
  [/\bbolt\b|\buber\b|taxi|careem\b|transport for london|\blner\b|luton dart|stansted express|great western railway/i, 'transport'],
  [/mpe properties|rent for/i, 'rent'],
  [/^transfer (to|from)/i, 'transfer'],
  [/exchanged to/i, 'fx_exchange'],
  [/\bibkr\b|to investment account|freedom finance/i, 'brokerage_funding'],
  [/apple pay top-up|^topup$/i, 'top_up'],
  [/salary|payroll/i, 'salary'],
  [/wizzair|ryanair|easyjet|airline|hotel|booking\.com|airbnb|trip\.com|kiwi\.com/i, 'travel'],
  [/cinema|premier cinemas/i, 'entertainment'],
  [/kiosk|bakery|mini market|supermarket|cyta|municipality|sainsbury|co-op\b/i, 'utilities_or_shopping'],
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

    const account = 'Revolut';
    let skippedNotCompleted = 0;
    let skippedDeposit = 0;
    let skippedBadDate = 0;

    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of csvRows) {
      if (r.state !== 'COMPLETED') { skippedNotCompleted++; continue; }
      // Deposit-product rows (Instant Access Savings) are their own
      // interest-bearing pot, not same-day spend/income on the main
      // account -- see module docstring.
      if (/^deposit$/i.test(r.product)) { skippedDeposit++; continue; }

      const isoDate = toIsoTimestamp(r.startedDate);
      if (!isoDate) { skippedBadDate++; continue; }

      // Two rows can share the same second/description/amount/currency
      // (e.g. two identical transfers) -- an occurrence counter folded
      // into external_id tells them apart instead of colliding on upsert.
      const signature = `${r.startedDate}:${r.description}:${r.amount}:${r.currency}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        account,
        tx_date: isoDate,
        description: r.description || r.type,
        counterparty: null,
        amount: r.amount,
        currency: r.currency,
        category: categorize(r.type, r.description),
        balance_after: r.balance ? parseFloat(r.balance.replace(/,/g, '')) : null,
        external_source: 'revolut_csv',
        // Started Date already carries a full timestamp (to the second),
        // so (date, description, amount, currency) is a real, content-
        // derived identity for the transaction -- unlike the old PDF-based
        // parser, which only had a bare date and had to fall back to a
        // full date-range replace. Re-uploading the same or an overlapping
        // export produces the identical key, so the upsert below quietly
        // no-ops on rows already present instead of duplicating them.
        external_id: occurrence === 0 ? signature : `${signature}:dup${occurrence}`,
      });
    }

    if (!rows.length) {
      return new Response(JSON.stringify({
        error: 'No importable COMPLETED, non-Deposit rows found',
        skipped_not_completed: skippedNotCompleted,
        skipped_deposit: skippedDeposit,
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
      skipped_not_completed: skippedNotCompleted,
      skipped_deposit: skippedDeposit,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
