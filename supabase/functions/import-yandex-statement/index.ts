// Supabase Edge Function: import-yandex-statement
//
// Parses this project's own combined Yandex Bank transaction CSV and
// inserts the resulting rows into `bank_transactions` -- same destination
// table and shape as import-raiffeisen-statement / import-boc-statement,
// just a different source bank.
//
// Like Raiffeisen, Yandex Bank offers no CSV export -- only PDF "Выписка по
// договору" statements, one per contract (the current account "Банковский
// счёт" and the "Сейв" on-demand savings deposit each get their own PDF).
// Those PDFs were extracted once, out of band, into this project's own flat
// CSV shape (see statements/yandex_combined.csv) -- this importer only has
// to parse that intermediate CSV, not a PDF.
//
// CSV shape (this project's own, not a bank export):
//   account_number,product,currency,date,time,card,description,amount,
//   balance,source_file
// Dates are ISO (YYYY-MM-DD); time is Moscow wall-clock HH:MM, present for
// the current account only (the Save statement carries no time of day).
// amount is already signed (positive = credit, negative = debit), matching
// `bank_transactions.amount`'s convention. balance is the per-account
// running balance after that row.
//
// Both accounts share one `account` label ("Yandex Bank") so they collapse
// into a single row in the broker pivot tables, same as Raiffeisen's two
// accounts -- but unlike Raiffeisen (RSD vs EUR) both are RUB, so the
// cash-balance view (mpFetchCashRows in index.html, which trusts the single
// most recent balance_after per (account, currency)) would otherwise only
// ever see whichever account moved last. balance_after is therefore stored
// as the combined balance across every account_number in the CSV as of
// that row, not the per-account CSV balance -- so upload both statements
// together in one CSV.
//
// tx_date carries the Moscow wall-clock time labelled as UTC (same "keep
// the calendar date intact" choice as the other importers' T00:00:00Z).
// Save rows have no time, so they get 00:00:SS with SS = row order within
// the day -- that keeps them ordered among themselves and ahead of every
// timed current-account row that day, which is also the order the
// combined balance is accumulated in.
//
// Dedup key is (account_number, date, time, description, amount) with the
// same occurrence-counter tie-breaker as the other importers for
// legitimate same-day duplicates (e.g. daily "Капитализация процентов"
// rows never collide, but same-day identical transfers can).

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface YandexRow {
  accountNumber: string;
  date: string;
  time: string;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
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

function parseNumber(s: string): number | null {
  const t = (s || '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

function parseRows(text: string): YandexRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);

  let idx: {
    accountNumber: number; date: number; time: number; description: number;
    amount: number; currency: number; balance: number;
  } | null = null;
  const rows: YandexRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (!idx) {
      const header = cells.map(h => h.trim());
      if (header[0] === 'account_number' && header[1] === 'product') {
        const col = (name: string) => header.indexOf(name);
        idx = {
          accountNumber: col('account_number'), date: col('date'), time: col('time'),
          description: col('description'), amount: col('amount'), currency: col('currency'),
          balance: col('balance'),
        };
      }
      continue;
    }

    const date = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    const amount = parseNumber(cells[idx.amount] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || amount === null) continue;

    const time = (cells[idx.time] || '').trim();
    rows.push({
      accountNumber: (cells[idx.accountNumber] || '').trim(),
      date,
      time: /^\d{2}:\d{2}$/.test(time) ? time : '',
      description,
      amount,
      currency: (cells[idx.currency] || '').trim(),
      balance: parseNumber(cells[idx.balance] || ''),
    });
  }
  return rows;
}

// Best-effort keyword categorization, same style/purpose as the other
// importers' CATEGORY_RULES.
const CATEGORY_RULES: [RegExp, string][] = [
  [/капитализация процентов|выплата процентов/i, 'interest'],
  [/перевод между счетами одного клиента/i, 'internal_transfer'],
  [/перевод сбп/i, 'transfer'],
  [/yandex\*\d+\*plus/i, 'utilities_or_shopping'],
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

    const account = 'Yandex Bank';

    // Assign each row its tx_date first (untimed Save rows -> 00:00:SS by
    // in-day order), then walk everything chronologically to build the
    // combined cross-account balance.
    const untimedSeq = new Map<string, number>();
    const timed = csvRows.map((r, i) => {
      let clock: string;
      if (r.time) {
        clock = `${r.time}:00`;
      } else {
        const key = `${r.accountNumber}:${r.date}`;
        const seq = untimedSeq.get(key) ?? 0;
        untimedSeq.set(key, seq + 1);
        clock = `00:00:${String(Math.min(seq, 59)).padStart(2, '0')}`;
      }
      return { ...r, txDate: `${r.date}T${clock}Z`, order: i };
    });
    timed.sort((a, b) => a.txDate.localeCompare(b.txDate) || a.order - b.order);

    const latestBalance = new Map<string, number>();
    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of timed) {
      let balanceAfter: number | null = null;
      if (r.balance !== null) {
        latestBalance.set(`${r.accountNumber}:${r.currency}`, r.balance);
        let sum = 0;
        for (const [k, v] of latestBalance) if (k.endsWith(`:${r.currency}`)) sum += v;
        balanceAfter = Math.round(sum * 100) / 100;
      }

      const signature = `${r.accountNumber}:${r.date}:${r.time}:${r.description}:${r.amount}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);

      rows.push({
        user_id: user.id,
        account,
        tx_date: r.txDate,
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency: r.currency,
        category: categorize(r.description),
        balance_after: balanceAfter,
        external_source: 'yandex_csv',
        external_id: occurrence === 0 ? signature : `${signature}:dup${occurrence}`,
      });
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
