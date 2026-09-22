// Supabase Edge Function: import-revolut-fund-statement
//
// Parses a Revolut "Flexible Cash Funds" (Savings) statement CSV export --
// a money-market fund (Fidelity Institutional Liquidity Fund, share price
// pinned near 1.00) that Revolut lets users sweep spare cash into. Writes
// BUY/SELL rows into `trades` as an ordinary asset -- ticker = the fund's
// own ISIN, quantity = shares, price = share price (~1.00) -- so it flows
// through the exact same current_holdings/portfolio_value_usd pipeline as
// any brokerage stock, no separate UI needed.
//
// This is NOT bank_transactions: a Flexible Cash Funds purchase/sale is a
// real asset transaction (you're buying/selling fund units), unlike a Wolt
// payment or a P2P transfer, which have no ticker or quantity at all -- see
// 20250101000008_bank_transactions.sql for that distinction. The Current-
// account side of moving money into/out of the fund ("To/From Flexible
// Cash Funds" in the account CSV, see import-revolut-statement) is still
// imported there too, tagged 'internal_transfer' -- so the same cash
// movement is deliberately visible from both sides: as a spend/income line
// on the Current account, and as a BUY/SELL of the fund itself here. This
// is not double-counting money, it's tracking two different things (a cash
// balance and a separate fund holding) that happen to move together.
//
// CSV shape: one file can contain multiple currency sub-statements back to
// back (USD, GBP, EUR, ...), each introduced by its own header row. Two
// header shapes have been observed:
//   Date,Description,"Value, <CCY>","Value, EUR",FX Rate,Price per share,Quantity of shares
//   Date,Description,"Value, EUR",Price per share,Quantity of shares            (EUR-native block, no FX Rate/dual value)
// Both are handled by locating columns by name rather than by fixed
// position.
//
// Only BUY and SELL rows carry a non-empty "Quantity of shares" in this
// export -- "Service Fee Charged", "Return PAID", "Return Reinvested", and
// "Return WITHDRAWN" all leave both Price per share and Quantity of shares
// blank (they're daily cash income/expense bookkeeping for the fund's own
// return, or -- for WITHDRAWN -- a side note attached to a SELL row for the
// same instant that already carries the actual share-count change) and are
// skipped by the empty-quantity check below.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface FundRow {
  description: string;
  startedDate: string;
  currency: string;
  pricePerShare: number | null;
  quantityOfShares: number | null;
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

// "Sep 22, 2026, 3:47:20 AM" (after stripping the narrow-no-break-space
// mangled as UTF-8 mojibake, e.g. "â¯") -> "2026-09-22T03:47:20Z".
const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};
function toIsoTimestamp(raw: string): string | null {
  const s = raw.replace(/[  ]|â¯/g, ' ').replace(/\s+/g, ' ').trim();
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  let hour = parseInt(m[4], 10);
  const isPm = /pm/i.test(m[7]);
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const day = m[2].padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  return `${m[3]}-${month}-${day}T${hh}:${m[5]}:${m[6]}Z`;
}

function parseNum(s: string | undefined): number | null {
  if (s === undefined || s === null || s.trim() === '') return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

// Extracts the fund's ISIN and share-class currency from a description
// like "BUY USD Class R IE000H9J0QX4" or "Service Fee Charged EUR Class
// IE000AZVL3K0" -- the ISIN is always the last whitespace-separated token
// and always starts with two letters followed by alphanumerics (ISIN
// format), and the currency is the token right after the leading verb.
function parseFundInstrument(description: string): { isin: string; currency: string } | null {
  const isinMatch = description.match(/\b([A-Z]{2}[A-Z0-9]{9}\d)\b/);
  const ccyMatch = description.match(/\b(USD|GBP|EUR)\b/);
  if (!isinMatch || !ccyMatch) return null;
  return { isin: isinMatch[1], currency: ccyMatch[1] };
}

function parseFundStatement(text: string): FundRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  const rows: FundRow[] = [];

  let idx: Record<string, number> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells[0]?.trim() === 'Date' && cells[1]?.trim() === 'Description') {
      // New header block -- currency sub-statements can use different
      // column sets (USD/GBP blocks have Value,<CCY>/Value,EUR/FX Rate;
      // the EUR-native block skips the dual-value/FX columns), so
      // columns are re-located by name every time a header line appears.
      const header = cells.map(h => h.trim());
      const col = (name: string) => header.indexOf(name);
      idx = {
        description: col('Description'),
        price: col('Price per share'),
        quantity: col('Quantity of shares'),
      };
      continue;
    }
    if (!idx || idx.description < 0) continue;

    const description = (cells[idx.description] || '').trim();
    if (!description) continue;

    const instrument = parseFundInstrument(description);
    if (!instrument) continue;

    rows.push({
      description,
      startedDate: (cells[0] || '').trim(),
      currency: instrument.currency,
      pricePerShare: parseNum(cells[idx.price]),
      quantityOfShares: parseNum(cells[idx.quantity]),
    });
  }
  return rows;
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
    const fundRows = parseFundStatement(csvText);
    if (!fundRows.length) {
      return new Response(JSON.stringify({ error: 'No parseable rows found (unrecognized CSV header?)' }),
        { status: 400, headers: corsHeaders });
    }

    let skippedNoQuantity = 0;
    let skippedBadDate = 0;
    const rows = [];

    for (const r of fundRows) {
      if (r.quantityOfShares === null || r.quantityOfShares === 0) { skippedNoQuantity++; continue; }
      const isoDate = toIsoTimestamp(r.startedDate);
      if (!isoDate) { skippedBadDate++; continue; }

      const instrument = parseFundInstrument(r.description)!;
      // Side comes from the description's own verb, NOT from the sign of
      // Quantity of shares -- Revolut's export prints Quantity as a plain
      // positive magnitude for BOTH BUY and SELL rows (the sign only shows
      // up in the Value column), so `quantity > 0 ? buy : sell` silently
      // mislabels every SELL as a BUY. By this point only BUY/SELL rows
      // remain (Service Fee Charged, Return PAID, and Return Reinvested
      // all leave Quantity of shares empty in the export and were already
      // filtered out above), so anything not starting with "SELL" is BUY.
      const side = /^sell\b/i.test(r.description) ? 'sell' : 'buy';
      const quantity = Math.abs(r.quantityOfShares);
      const price = r.pricePerShare ?? 1.0;  // fund share price is always ~1.00; CSV's own value used when present

      rows.push({
        user_id: user.id,
        ticker: instrument.isin,
        side,
        quantity,
        price,
        trade_date: isoDate.slice(0, 10),
        currency: r.currency,
        account: 'Revolut',
        note: r.description,
        external_source: 'revolut_fund_csv',
        external_id: `${r.startedDate}:${r.description}:${r.quantityOfShares}`,
      });
    }

    if (!rows.length) {
      return new Response(JSON.stringify({
        error: 'No importable rows found (all rows had an empty or zero share quantity)',
        skipped_no_quantity: skippedNoQuantity,
        skipped_bad_date: skippedBadDate,
      }), { status: 400, headers: corsHeaders });
    }

    const { error: upsertErr, count } = await supabase
      .from('trades')
      .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });

    if (upsertErr) {
      return new Response(JSON.stringify({ error: upsertErr.message }),
        { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      imported: count ?? rows.length,
      total_rows: fundRows.length,
      skipped_no_quantity: skippedNoQuantity,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
