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

function parseRows(sheet: XLSX.WorkSheet): { rows: ZiraatRow[]; currency: string | null; accountNo: string | null } {
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  let currency: string | null = null;
  let accountNo: string | null = null;
  let headerRowIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!currency && row[0] === 'Account Number' && typeof row[2] === 'string') {
      currency = detectCurrency(row[2]);
      // "1553-103119215-5004 MURATPAŞA/ANTALYA ŞUBESİ TL" -> "103119215-5004"
      accountNo = row[2].match(/^\s*\d+-(\d+-\d+)/)?.[1] ?? null;
    }
    if (row[0] === 'Date' && row[1] === 'Invoice No.') {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return { rows: [], currency, accountNo };

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
  return { rows, currency, accountNo };
}

// A term deposit (vadeli hesap) is an account of its own, opened from the drawing account:
// "103119215-5001 No.lu Vds. Hes.tan 103119215-5004 - Hes. Açılış, Hes. Aç. Tr: 23/11/2026
// VB: 23/11/2026 VS: 07/01/2027" -- from 5001, account 5004 opened on 23.11, its term to 07.01.
// The same row stands in both statements; it's the deposit's own when the account opened is
// the statement's. Loose about the dots and the letters OCR misreads in a PDF's ("Vds Hes tan",
// "VE: 07/01/2027"): the first date in it the opening, the last the term's end.
const OPENING_RE = /(\d+-\d+)\s+No\.?\s*lu\s+Vds\.?\s*Hes\.?\s*tan\s+(\d+-\d+)\s*-\s*Hes\.?\s*Açılış/i;
const dmy = (s: string | undefined) => s?.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$2-$1') ?? null;
function depositOpening(rows: ZiraatRow[], accountNo: string | null) {
  if (!accountNo) return null;
  for (const r of rows) {
    const m = r.description.match(OPENING_RE);
    if (!m || m[2] !== accountNo) continue;
    const days = r.description.match(/\d{2}\/\d{2}\/\d{4}/g) ?? [];
    return { opened: dmy(days[0]) ?? parseDate(r.date), end: days.length > 1 ? dmy(days[days.length - 1]) : null };
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

    // The .xlsx as is, or a PDF statement read on the page (Ziraat's PDF is a picture: OCR,
    // each amount checked against the balances and the totals there) as JSON -- { pdf: true,
    // accountNo, currency, rows: [{ date, invoiceNo, description, amount, balanceAfter }] }.
    let parsed: { rows: ZiraatRow[]; currency: string | null; accountNo: string | null };
    const fromPdf = /json/i.test(req.headers.get('Content-Type') ?? '');
    if (fromPdf) {
      const body = await req.json();
      parsed = { rows: body.rows ?? [], currency: body.currency ?? null, accountNo: body.accountNo ?? null };
    } else {
      const fileBytes = new Uint8Array(await req.arrayBuffer());
      const workbook = XLSX.read(fileBytes, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        return new Response(JSON.stringify({ error: 'No sheet found in workbook' }),
          { status: 400, headers: corsHeaders });
      }
      parsed = parseRows(sheet);
    }
    const { rows: ziraatRows, currency, accountNo } = parsed;
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

    // A term deposit's statement: its rows are the deposit's buys (opening, interest) and
    // sells (back to the drawing account), as T-Bank's and Sber's deposits are -- trades of
    // "DEPOSIT:Ziraat Bank TRY 34% 23.11.2026", the rate in the name (the capital history
    // accrues the interest from it). The statement doesn't give the rate: the page asks for
    // it (?deposit_rate=34) the first time; later statements of the account take the name
    // already stored.
    const depositSource = `ziraat_deposit_xlsx:${accountNo}`;
    const opening = depositOpening(ziraatRows, accountNo);
    const { data: prevDeposit } = accountNo
      ? await supabase.from('trades').select('ticker').eq('external_source', depositSource)
        .order('trade_date', { ascending: false }).limit(1)
      : { data: null };
    if (opening || prevDeposit?.length) {
      const rateParam = new URL(req.url).searchParams.get('deposit_rate')?.replace(',', '.');
      const rate = rateParam ? Number(rateParam) : NaN;
      let ticker = prevDeposit?.[0]?.ticker as string | undefined;
      if (!ticker) {
        if (!(rate > 0 && rate < 200)) {
          return new Response(JSON.stringify({
            error: `A term deposit (account ${accountNo}, opened ${opening!.opened}): its interest rate is needed`,
            needs_deposit_rate: true, account_no: accountNo, opened: opening!.opened, end: opening!.end,
          }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const [y, m, d] = opening!.opened!.split('-');
        ticker = `DEPOSIT:${account} ${currency} ${rate}% ${d}.${m}.${y}`;
      }
      // a movement already in (from the other of the PDF / the .xlsx): its id -- by day, side
      // and amount, the description differing between the two
      const { data: had } = await supabase.from('trades').select('external_id, trade_date, side, quantity')
        .eq('external_source', depositSource);
      const known = new Map<string, string[]>();
      for (const t of had ?? []) {
        const k = `${t.trade_date}|${t.side}|${Number(t.quantity).toFixed(2)}`;
        known.set(k, [...(known.get(k) ?? []), t.external_id]);
      }
      const trades = [];
      const seen = new Map<string, number>();
      for (const r of ziraatRows) {
        const isoDate = parseDate(r.date);
        if (!isoDate || r.amount === 0) continue;
        const side = r.amount < 0 ? 'sell' : 'buy';
        const prior = known.get(`${isoDate}|${side}|${Math.abs(r.amount).toFixed(2)}`)?.shift();
        if (prior && fromPdf) continue;   // the .xlsx's words stay
        const signature = fromPdf ? `pdf:${r.date}:${r.invoiceNo}:${r.amount}` : `${r.date}:${r.invoiceNo}:${r.description}:${r.amount}`;
        const occurrence = seen.get(signature) ?? 0;
        seen.set(signature, occurrence + 1);
        trades.push({
          user_id: user.id, ticker, side, quantity: Math.abs(r.amount), price: 1,
          trade_date: isoDate, currency, account, note: r.description,
          external_source: depositSource, external_id: prior ?? (occurrence === 0 ? signature : `${signature}:dup${occurrence}`),
        });
      }
      const { error: tErr, count } = trades.length ? await supabase.from('trades')
        .upsert(trades, { onConflict: 'user_id,external_source,external_id', count: 'exact' }) : { error: null, count: 0 };
      if (tErr) {
        return new Response(JSON.stringify({ error: tErr.message }), { status: 500, headers: corsHeaders });
      }
      // the term's end, for the Bonds & deposits tab (deposit_terms, otherwise set by hand)
      if (opening?.end) {
        await supabase.from('deposit_terms').upsert({ user_id: user.id, ticker, end_day: opening.end, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,ticker' });
      }
      return new Response(JSON.stringify({
        imported: count ?? trades.length, currency, total_rows: ziraatRows.length, skipped_bad_date: 0,
        deposit: ticker.replace(/^DEPOSIT:/, ''), deposit_end: opening?.end ?? null,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // a row already in (from the other of the PDF / the .xlsx of these days): its id -- by day,
    // amount and balance after, the description differing between the two. A PDF's row leaves
    // it as it is; an .xlsx's overwrites it (its words are the bank's own).
    const isoDays = ziraatRows.map(r => parseDate(r.date)).filter(Boolean).sort() as string[];
    const known = new Map<string, string[]>();
    if (isoDays.length) {
      const { data: had } = await supabase.from('bank_transactions').select('external_id, tx_date, amount, balance_after')
        .eq('external_source', 'ziraat_xlsx').eq('currency', currency)
        .gte('tx_date', `${isoDays[0]}T00:00:00Z`).lte('tx_date', `${isoDays[isoDays.length - 1]}T23:59:59Z`);
      for (const b of had ?? []) {
        const k = `${String(b.tx_date).slice(0, 10)}|${Number(b.amount).toFixed(2)}|${b.balance_after === null ? '' : Number(b.balance_after).toFixed(2)}`;
        known.set(k, [...(known.get(k) ?? []), b.external_id]);
      }
    }
    let alreadyIn = 0;
    const rows = [];
    const dupSeen = new Map<string, number>();
    for (const r of ziraatRows) {
      const isoDate = parseDate(r.date);
      if (!isoDate) { skippedBadDate++; continue; }
      const prior = known.get(`${isoDate}|${r.amount.toFixed(2)}|${r.balanceAfter === null ? '' : r.balanceAfter.toFixed(2)}`)?.shift();
      if (prior && fromPdf) { alreadyIn++; continue; }

      const signature = fromPdf ? `pdf:${r.date}:${r.invoiceNo}:${r.amount}` : `${r.date}:${r.invoiceNo}:${r.description}:${r.amount}`;
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
        external_id: prior ?? (occurrence === 0 ? signature : `${signature}:dup${occurrence}`),
      });
    }


    // Same-day rows (the statement has dates only) get 00:00:SS by the order
    // the bank applied them, so the day's last row -- the account's balance --
    // really is the latest by tx_date (see _shared/day_order.ts).
    const dates = rows.map(r => r.tx_date);
    const pos = orderWithinGroups(rows, r => `${r.currency} ${r.tx_date}`, r => r.amount, r => r.balance_after,
      dates.length > 1 && dates[0] > dates[dates.length - 1]);
    rows.forEach((r, i) => { r.tx_date = r.tx_date.replace('T00:00:00Z', `T${clockFor(pos[i])}Z`); });

    if (!rows.length && alreadyIn) {
      return new Response(JSON.stringify({ imported: 0, already_in: alreadyIn, currency, total_rows: ziraatRows.length, skipped_bad_date: skippedBadDate }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
      already_in: alreadyIn,
      currency,
      total_rows: ziraatRows.length,
      skipped_bad_date: skippedBadDate,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
