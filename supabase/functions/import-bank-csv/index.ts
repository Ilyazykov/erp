// Supabase Edge Function: import-bank-csv
//
// Parses this project's own flat bank-transaction CSV -- the shape PDF-only
// banks' statements get extracted into, out of band (Yandex Bank, T-Bank:
// neither offers a CSV export) -- and inserts the rows into
// `bank_transactions`, same destination table and shape as
// import-raiffeisen-statement / import-boc-statement. Unlike those, one
// importer serves several banks: the bank's display name travels in the
// CSV's own `bank` column instead of being hardcoded here.
//
// CSV shape (this project's own, not a bank export):
//   bank,account_number,product,currency,date,time,card,description,amount,
//   balance[,amount_orig_value,amount_orig_currency],source_file
// Dates are ISO (YYYY-MM-DD); time is Moscow wall-clock HH:MM where the
// statement gives one (Yandex's Save deposit statement doesn't). amount is
// already signed in the account currency (positive = credit, negative =
// debit), matching `bank_transactions.amount`'s convention. balance is the
// per-account running balance after that row -- negative for a credit
// card's outstanding debt, so the card correctly counts against the
// bank's total in the broker pivot tables. Extra columns (e.g. the
// original foreign-currency amount) are ignored.
//
// `bank` becomes the `account` label, so every account at one bank
// collapses into a single row in the broker pivot tables (same idea as
// Raiffeisen's two accounts sharing "Raiffeisen"). balance_after is the
// per-account CSV balance, and external_source is per account
// ('t_bank_csv:<account_number>') -- that's what lets the cash-balance view
// (mpFetchCashRows in index.html) take the latest balance per
// (account, currency, external_source) and sum those, so two same-currency
// accounts at one bank (T-Bank debit + credit card, Yandex current + Save)
// can be uploaded as separate CSVs and still both count.
//
// tx_date carries the Moscow wall-clock time labelled as UTC (same "keep
// the calendar date intact" choice as the other importers' T00:00:00Z).
// Untimed rows get 00:00:SS with SS = row order within the day -- that
// keeps them ordered among themselves and ahead of every timed row that
// day, so the day's last row really is the latest by tx_date.
//
// The dedup key is (account_number, date, time, description, amount) with
// the same occurrence-counter tie-breaker as the other importers for
// legitimate same-minute duplicates.
//
// Savings accounts (product 'savings_account' -- T-Bank's накопительный
// счёт, Yandex's "Сейв": interest-bearing on-demand deposits) are not cash
// and don't go to `bank_transactions` at all. They're written to `trades`
// exactly the way import-revolut-deposit-statement writes Revolut Instant
// Access Savings: synthetic ticker "DEPOSIT:<bank> <currency>", deposit or
// interest -> buy, withdrawal -> sell, quantity = the amount itself,
// price 1 -- so they show up as asset class 'deposit' (priced via FX by
// update-market-prices) instead of in the cash column.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface BankRow {
  bank: string;
  accountNumber: string;
  product: string;
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

function parseRows(text: string): BankRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);

  let idx: {
    bank: number; accountNumber: number; product: number; date: number; time: number; description: number;
    amount: number; currency: number; balance: number;
  } | null = null;
  const rows: BankRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (!idx) {
      const header = cells.map(h => h.trim());
      if (header[0] === 'bank' && header[1] === 'account_number' && header[2] === 'product') {
        const col = (name: string) => header.indexOf(name);
        idx = {
          bank: col('bank'), accountNumber: col('account_number'), product: col('product'), date: col('date'), time: col('time'),
          description: col('description'), amount: col('amount'), currency: col('currency'),
          balance: col('balance'),
        };
      }
      continue;
    }

    const date = (cells[idx.date] || '').trim();
    const description = (cells[idx.description] || '').trim();
    const amount = parseNumber(cells[idx.amount] || '');
    const bank = (cells[idx.bank] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || amount === null || !bank) continue;

    const time = (cells[idx.time] || '').trim();
    rows.push({
      bank,
      product: (cells[idx.product] || '').trim(),
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
  [/капитализация процентов|выплата процентов|interest on the balance/i, 'interest'],
  [/перевод между счетами одного клиента|внутрибанковский перевод между счетами|intrabank transfer from contract|internal transfer to contract/i, 'internal_transfer'],
  [/перевод сбп|систем\S* быстрых платежей|external bank transfer/i, 'transfer'],
  [/transfer fee/i, 'bank_fee'],
  [/taxi|siticard|metro|aeroexpress|rzd|russian\s+railways/i, 'transport'],
  [/delivery club|lavka|samokat|eda\.yandex|wolt/i, 'food_delivery'],
  [/pyaterochka|perekrestok|magnit|vkusvill|lenta/i, 'groceries'],
  [/yandex\*\d+\*plus/i, 'utilities_or_shopping'],
];

const DEPOSIT_PRODUCTS = new Set(['savings_account']);

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

    // Untimed rows (Yandex Save) -> 00:00:SS by in-day order.
    const untimedSeq = new Map<string, number>();
    const rows = [];
    const depositRows = [];
    const dupSeen = new Map<string, number>();
    for (const r of csvRows) {
      let clock: string;
      if (r.time) {
        clock = `${r.time}:00`;
      } else {
        const key = `${r.bank}:${r.accountNumber}:${r.date}`;
        const seq = untimedSeq.get(key) ?? 0;
        untimedSeq.set(key, seq + 1);
        clock = `00:00:${String(Math.min(seq, 59)).padStart(2, '0')}`;
      }

      const bankSlug = r.bank.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const signature = `${r.accountNumber}:${r.date}:${r.time}:${r.description}:${r.amount}`;
      const occurrence = dupSeen.get(signature) ?? 0;
      dupSeen.set(signature, occurrence + 1);
      const externalId = occurrence === 0 ? signature : `${signature}:dup${occurrence}`;

      if (DEPOSIT_PRODUCTS.has(r.product)) {
        if (r.amount === 0) continue;
        depositRows.push({
          user_id: user.id,
          ticker: `DEPOSIT:${r.bank} ${r.currency}`,
          side: r.amount < 0 ? 'sell' : 'buy',
          quantity: Math.abs(r.amount),
          price: 1,
          trade_date: r.date,
          currency: r.currency,
          account: r.bank,
          note: r.description,
          external_source: `${bankSlug}_deposit_csv:${r.accountNumber}`,
          external_id: externalId,
        });
        continue;
      }

      const externalSource = `${bankSlug}_csv:${r.accountNumber}`;

      rows.push({
        user_id: user.id,
        account: r.bank,
        tx_date: `${r.date}T${clock}Z`,
        description: r.description,
        counterparty: null,
        amount: r.amount,
        currency: r.currency,
        category: categorize(r.description),
        balance_after: r.balance,
        external_source: externalSource,
        external_id: externalId,
      });
    }

    let imported = 0;
    if (rows.length) {
      const { error: upsertErr, count } = await supabase
        .from('bank_transactions')
        .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });
      if (upsertErr) {
        return new Response(JSON.stringify({ error: upsertErr.message }),
          { status: 500, headers: corsHeaders });
      }
      imported = count ?? rows.length;
    }

    let importedDeposit = 0;
    if (depositRows.length) {
      const { error: upsertErr, count } = await supabase
        .from('trades')
        .upsert(depositRows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });
      if (upsertErr) {
        return new Response(JSON.stringify({ error: upsertErr.message }),
          { status: 500, headers: corsHeaders });
      }
      importedDeposit = count ?? depositRows.length;
    }

    return new Response(JSON.stringify({
      imported,
      imported_deposit: importedDeposit,
      total_rows: csvRows.length,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
