// Supabase Edge Function: import-revolut-deposit-statement
//
// Parses a Revolut "Instant Access Savings" statement CSV export -- a plain
// interest-bearing deposit (not a fund with a share price; see
// import-revolut-fund-statement for that separate product). Writes rows
// into `trades` using the same synthetic-ticker convention already used
// for a bank deposit imported from Snowball (ticker "DEPOSIT:<bank>",
// quantity = the balance itself, not a unit count -- see DEPOSIT_PREFIX
// and fetchDepositCurrencies in update-market-prices/index.ts), so this
// deposit shows up in current_holdings/portfolio_value_usd the same way,
// with no separate UI or view needed.
//
// CSV header (confirmed from a real export):
//   Date,Description,Interest rate (net of Lithuanian tax),Money in,Money out,Balance
// One file can contain more than one currency's statement back to back
// (e.g. a EUR block, then a USD block), each restarting its own Balance
// from scratch -- currency is read per-row from the Money in/out cell's
// own symbol (€/$/£), not assumed from file position.
//
// Row types:
//   "Deposit to 'Instant Access Savings'"   -> buy  (money added to the pot)
//   "Withdrawal from 'Instant Access Savings'" -> sell (money taken out)
//   "Net Interest Paid to ..."              -> buy  (interest capitalizes
//                                               into the balance itself,
//                                               same as a deposit)
// All three change the balance and are imported -- including the daily
// interest, however small, since it's still money added to the ticker's
// running quantity (unlike Flexible Cash Funds' Service Fee/Return PAID
// rows, which net to a *separate* reinvestment purchase there instead).

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface DepositRow {
  startedDate: string;
  description: string;
  amount: number;
  currency: string;
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

// "€1,234.56" / "$5.00" / "£12.34" -> { amount: 1234.56, currency: 'EUR' }.
// The mojibake byte sequences below are what "€"/"£" decode to when a
// UTF-8 file gets misread as Latin-1 somewhere upstream (observed in the
// real export) -- matched literally so the parser is robust to either
// encoding rather than silently dropping every row with a currency symbol.
function parseMoney(s: string): { amount: number; currency: string } | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(€|£|\$|â¬|Â£)\s?([\d,]+\.\d{2})$/);
  if (!m) return null;
  const symbol = m[1];
  const currency = symbol === '$' ? 'USD' : symbol === '£' || symbol === 'Â£' ? 'GBP' : 'EUR';
  return { amount: parseFloat(m[2].replace(/,/g, '')), currency };
}

// "Aug 29, 2025" -> "2025-08-29".
const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};
function parseDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

function parseRows(text: string): DepositRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  const rows: DepositRow[] = [];

  let idx: { date: number; description: number; moneyIn: number; moneyOut: number } | null = null;
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (cells[0]?.trim() === 'Date' && cells[1]?.trim() === 'Description') {
      const header = cells.map(h => h.trim());
      const col = (name: string) => header.indexOf(name);
      idx = { date: col('Date'), description: col('Description'), moneyIn: col('Money in'), moneyOut: col('Money out') };
      continue;
    }
    if (!idx) continue;

    const dateStr = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    if (!dateStr || !description) continue;

    const moneyIn = parseMoney(cells[idx.moneyIn] || '');
    const moneyOut = parseMoney(cells[idx.moneyOut] || '');
    const flow = moneyIn ?? moneyOut;
    if (!flow) continue;  // neither column parsed as money -- not a row we can act on

    rows.push({ startedDate: dateStr, description, amount: flow.amount, currency: flow.currency });
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
    const depositRows = parseRows(csvText);
    if (!depositRows.length) {
      return new Response(JSON.stringify({ error: 'No parseable rows found (unrecognized CSV header?)' }),
        { status: 400, headers: corsHeaders });
    }

    let skippedBadDate = 0;
    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of depositRows) {
      const tradeDate = parseDate(r.startedDate);
      if (!tradeDate) { skippedBadDate++; continue; }

      // Withdrawal reduces the balance; a Deposit or Net Interest Paid
      // both add to it -- interest capitalizes straight into the same
      // running balance, it isn't a separate cash payout the way Flexible
      // Cash Funds' "Return PAID" is (that one nets against a Service Fee
      // and gets reinvested as its own purchase; this deposit has no such
      // separate accounting -- the interest row IS the balance increase).
      const side = /^withdrawal/i.test(r.description) ? 'sell' : 'buy';

      // Two rows on the same day can legitimately share date/description/
      // amount/currency (e.g. interest paid twice in identical amounts) --
      // an occurrence counter folded into external_id tells them apart.
      const signature = `${r.startedDate}:${r.description}:${r.amount}:${r.currency}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        // Currency is part of the ticker itself (not just the `currency`
        // column) because a single Revolut user can hold this deposit in
        // more than one currency at once (the CSV export contains a
        // separate EUR block and a separate USD block, each with its own
        // running balance) -- one shared ticker would mix two currencies'
        // balances into a single quantity and give fetchDepositCurrencies
        // in update-market-prices no way to know which FX rate applies.
        // SAVINGS: (not DEPOSIT:) -- instant access, withdrawable any time
        // without loss; see 20250101000012_savings_and_credit_classes.sql
        ticker: `SAVINGS:Revolut ${r.currency}`,
        side,
        quantity: r.amount,
        price: 1,
        trade_date: tradeDate,
        currency: r.currency,
        account: 'Revolut',
        note: r.description,
        external_source: 'revolut_deposit_csv',
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
      .from('trades')
      .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });

    if (upsertErr) {
      return new Response(JSON.stringify({ error: upsertErr.message }),
        { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      imported: count ?? rows.length,
      total_rows: depositRows.length,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
