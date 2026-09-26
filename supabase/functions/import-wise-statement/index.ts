// Supabase Edge Function: import-wise-statement
//
// Parses a Wise balance statement CSV (open a balance -> Statement ->
// Balance statement, CSV; one file per currency balance, e.g.
// statement_131774402_EUR_2025-08-29_2026-09-26.csv) and upserts its rows
// into `bank_transactions` -- same destination and shape as
// import-boc-statement / import-revolut-statement, account 'Wise'.
//
// CSV shape (confirmed from a real export), newest first:
//   "TransferWise ID",Date,"Date Time",Amount,Currency,Description,
//   "Payment Reference","Running Balance","Exchange From","Exchange To",
//   "Exchange Rate","Payer Name","Payee Name","Payee Account Number",
//   Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,
//   "Total fees","Exchange To Amount","Transaction Type",
//   "Transaction Details Type"
// Amount is signed and already includes Wise's fee on a transfer out
// (Running Balance moves by exactly Amount); "Total fees" is kept in `note`.
// "Date Time" is "25-06-2026 17:29:31.374", taken as UTC.
//
// "TransferWise ID" (TRANSFER-..., CARD-...) is Wise's own unique id, so
// it's the dedup key as is -- re-uploading an overlapping period is harmless.
// balance_after = Running Balance, so the cash view takes the latest row per
// currency as that balance. A statement with no transactions (e.g. an unused
// CNY balance) is just a header -- accepted, nothing imported.

import { createClient } from 'jsr:@supabase/supabase-js@2';

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

// "25-06-2026 17:29:31.374" -> "2026-06-25T17:29:31.374Z".
function parseDateTime(s: string): string | null {
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}Z` : null;
}

const num = (s: string | undefined) => {
  const t = (s || '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
};

function categorize(detailsType: string, payee: string, holder: string, merchant: string): string | null {
  if (detailsType === 'MONEY_ADDED') return 'transfer';
  if (detailsType === 'CARD_ORDER_CHECKOUT') return 'bank_fee';
  if (detailsType === 'TRANSFER') return payee && holder && payee === holder ? 'internal_transfer' : 'p2p_transfer';
  if (detailsType === 'CARD') return /taxi|didi|bolt|uber|yandex go/i.test(merchant) ? 'transport' : null;
  return null;
}

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
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const lines = (await req.text()).replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
    const header = parseCsvLine(lines[0] || '').map(h => h.trim());
    const col = (n: string) => header.indexOf(n);
    const idx = {
      id: col('TransferWise ID'), dateTime: col('Date Time'), amount: col('Amount'), currency: col('Currency'),
      description: col('Description'), reference: col('Payment Reference'), balance: col('Running Balance'),
      payer: col('Payer Name'), payee: col('Payee Name'), merchant: col('Merchant'), holder: col('Card Holder Full Name'),
      note: col('Note'), fees: col('Total fees'), detailsType: col('Transaction Details Type'),
    };
    if ([idx.id, idx.dateTime, idx.amount, idx.currency, idx.description, idx.balance].some(i => i < 0)) {
      return json({ error: 'Not a Wise balance statement CSV (unrecognized header)' }, 400);
    }

    const holderOf = (c: string[]) => (c[idx.holder] || '').trim() || 'Ilya Zykov';
    let skippedBad = 0;
    const rows = [];
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const txDate = parseDateTime(c[idx.dateTime] || '');
      const amount = num(c[idx.amount]);
      const id = (c[idx.id] || '').trim();
      if (!txDate || amount === null || !id) { skippedBad++; continue; }
      const payee = (c[idx.payee] || '').trim();
      const payer = (c[idx.payer] || '').trim();
      const merchant = (c[idx.merchant] || '').trim();
      const fees = num(c[idx.fees]);
      const reference = (c[idx.reference] || '').trim();
      const noteParts = [
        reference && `reference: ${reference}`,
        fees ? `Wise fee ${fees.toFixed(2)} ${c[idx.currency]}` : '',
        idx.note >= 0 ? (c[idx.note] || '').trim() : '',
      ].filter(Boolean);
      rows.push({
        user_id: user.id,
        account: 'Wise',
        tx_date: txDate,
        description: (c[idx.description] || '').trim(),
        counterparty: payee || payer || merchant || null,
        amount,
        currency: (c[idx.currency] || '').trim(),
        category: categorize((c[idx.detailsType] || '').trim(), payee, holderOf(c), merchant),
        balance_after: num(c[idx.balance]),
        note: noteParts.length ? noteParts.join('; ') : null,
        external_source: 'wise_csv',
        external_id: id,
      });
    }

    if (!rows.length) {
      return json({ imported: 0, total_rows: 0, skipped_bad: skippedBad,
        note: 'The statement has no transactions for its period -- nothing to import' });
    }

    const { error: upsertErr, count } = await supabase.from('bank_transactions')
      .upsert(rows, { onConflict: 'user_id,external_source,external_id', count: 'exact' });
    if (upsertErr) return json({ error: upsertErr.message }, 500);

    const latest = rows.reduce((a, b) => (b.tx_date > a.tx_date ? b : a));
    return json({ imported: count ?? rows.length, total_rows: rows.length, skipped_bad: skippedBad,
      currency: latest.currency, balance: latest.balance_after });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
