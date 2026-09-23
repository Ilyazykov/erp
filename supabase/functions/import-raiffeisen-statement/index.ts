// Supabase Edge Function: import-raiffeisen-statement
//
// Parses this project's own combined Raiffeisen Bank Serbia ("Izvod po
// tekućem računu") transaction CSV and inserts the resulting rows into
// `bank_transactions` -- same destination table and shape as
// import-boc-statement / import-ziraat-statement, just a different source
// bank.
//
// Unlike Bank of Cyprus or Ziraat, Raiffeisen doesn't offer a CSV export at
// all -- the source data is a pile of monthly PDF statements (Izvod broj 1
// through 12, restarting the numbering every calendar year -- so "br. 1"
// alone does NOT uniquely identify a statement) plus a few phone
// screenshots for months where the PDF was never generated. That PDF+
// screenshot extraction happened once, out of band, producing this
// project's own flat CSV shape (see statements/raif_<account>.csv) -- this
// importer only has to parse that intermediate CSV, not a PDF.
//
// CSV shape (this project's own, not a bank export):
//   account_number,currency,date_executed,date_received,card_number,
//   description,debit,credit,balance,amount_orig_value,amount_orig_currency,
//   exchange_rate,amount_ref_currency,source_file
// Dates are already ISO (YYYY-MM-DD). debit/credit are separate plain
// dot-decimal numbers (only one of the two is normally nonzero per row).
// account_number carries the bank's own account number (one CSV per
// account/currency), used only to label the `account` column below --
// account_number itself isn't stored.
//
// amount is signed here (positive = credit, negative = debit) to match
// `bank_transactions.amount`'s documented convention.
//
// balance_after comes straight from the CSV's own `balance` column -- this
// is what lets the cash-balance view (mpFetchCashRows in index.html) take
// the single most recent row per (account, currency) and trust it as the
// actual running balance, the same mechanism already relied on for Bank of
// Cyprus and Ziraat.
//
// There's no per-row timestamp, so the dedup key is
// (date, description, signed amount, balance) with the same
// occurrence-counter tie-breaker used by the other importers for
// legitimate same-day duplicates (e.g. the several identical "Yandex Go"
// rows a single day can carry).
//
// Both Raiffeisen accounts share one `account` label ("Raiffeisen") so
// they collapse into a single row in the broker x currency/asset-class
// pivot tables, with RSD and EUR as separate columns -- matching how a
// single real-world relationship with one bank reads, even though the
// bank itself splits it into two account numbers internally.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface RaifRow {
  date: string;
  description: string;
  amount: number;
  currency: string;
  balanceAfter: number | null;
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

// "2026-08-31" -> "2026-08-31" (already ISO; just validated).
function parseDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s.trim() : null;
}

function parseNumber(s: string): number | null {
  const t = (s || '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

function parseRows(text: string): RaifRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);

  let idx: {
    date: number; description: number; debit: number; credit: number;
    balance: number; currency: number;
  } | null = null;
  const rows: RaifRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (!idx) {
      const header = cells.map(h => h.trim());
      if (header[0] === 'account_number' && header[1] === 'currency') {
        const col = (name: string) => header.indexOf(name);
        idx = {
          date: col('date_executed'), description: col('description'), currency: col('currency'),
          debit: col('debit'), credit: col('credit'), balance: col('balance'),
        };
      }
      continue;
    }

    const date = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    if (!date || !description) continue;

    const debit = parseNumber(cells[idx.debit] || '');
    const credit = parseNumber(cells[idx.credit] || '');
    if (debit === null && credit === null) continue;  // neither column parsed -- not a money row

    rows.push({
      date,
      description,
      amount: (credit || 0) - (debit || 0),
      currency: (cells[idx.currency] || '').trim(),
      balanceAfter: idx.balance >= 0 ? parseNumber(cells[idx.balance] || '') : null,
    });
  }
  return rows;
}

// Best-effort keyword categorization, same style/purpose as the other
// importers' CATEGORY_RULES.
const CATEGORY_RULES: [RegExp, string][] = [
  [/otkup strane valute|prodaja strane valute|kupoprodaja efektive|menjacnica/i, 'fx_conversion'],
  [/naplata.*naknad|naknada za kori|osiguranje - paket/i, 'bank_fee'],
  [/yandex go|taxi|srbijavoz/i, 'transport'],
  [/maxi\b|mix markt|kombinat|mikromarket|market\b/i, 'groceries'],
  [/wolt|glovo/i, 'food_delivery'],
  [/smart atm|gotovinska isplata/i, 'cash_withdrawal'],
];

function categorize(description: string): string | null {
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(description)) return cat;
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

    const account = 'Raiffeisen';

    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of csvRows) {
      const isoDate = parseDate(r.date);
      if (!isoDate) continue;

      // No per-row timestamp, so several genuinely distinct same-day
      // transactions can share (date, description, amount) -- e.g.
      // several identical "Yandex Go" rides in one day. Fold balance in
      // too (cheap extra disambiguation since it's already known) and use
      // an occurrence counter for anything still colliding.
      const signature = `${r.date}:${r.description}:${r.amount}:${r.balanceAfter}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        account,
        tx_date: `${isoDate}T00:00:00Z`,
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency: r.currency,
        category: categorize(r.description),
        balance_after: r.balanceAfter,
        external_source: 'raiffeisen_csv',
        external_id: occurrence === 0 ? signature : `${signature}:dup${occurrence}`,
      });
    }

    if (!rows.length) {
      return new Response(JSON.stringify({ error: 'No importable rows found' }),
        { status: 400, headers: corsHeaders });
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
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
