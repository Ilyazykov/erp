// Supabase Edge Function: import-trades-csv
//
// Receives a raw broker CSV export (currently: Snowball format) as the request
// body, parses it on the server, and inserts the resulting rows into `trades`
// for the authenticated caller. The browser only uploads the file as-is; it
// never parses CSV itself.
//
// Expected CSV header (Snowball export):
// Event,Date,Symbol,Price,Quantity,Currency,FeeTax,Exchange,NKD,FeeCurrency,DoNotAdjustCash,Note
//
// CUSTOM_HOLDING_PRICE / CUSTOM_HOLDING_SETTINGS rows are historical price
// points, not trades, and are skipped.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const EVENT_TO_SIDE: Record<string, string> = {
  BUY: 'buy',
  SELL: 'sell',
  DIVIDEND: 'dividend',
  AMORTISATION: 'amortisation',
  REPAYMENT: 'repayment',
  STOCK_AS_DIVIDEND: 'stock_as_dividend',
};

const SKIPPED_EVENTS = new Set(['CUSTOM_HOLDING_PRICE', 'CUSTOM_HOLDING_SETTINGS']);

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
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s.replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function parseDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
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
    const lines = csvText.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      return new Response(JSON.stringify({ error: 'CSV has no data rows' }),
        { status: 400, headers: corsHeaders });
    }

    const header = parseCsvLine(lines[0]).map(h => h.trim());
    const col = (name: string) => header.indexOf(name);

    const idx = {
      event: col('Event'), date: col('Date'), symbol: col('Symbol'),
      price: col('Price'), quantity: col('Quantity'), currency: col('Currency'),
      feeTax: col('FeeTax'), exchange: col('Exchange'), nkd: col('NKD'),
      feeCurrency: col('FeeCurrency'), note: col('Note'),
    };
    if (idx.event < 0 || idx.date < 0 || idx.symbol < 0) {
      return new Response(JSON.stringify({ error: 'Unrecognized CSV header' }),
        { status: 400, headers: corsHeaders });
    }

    const rows = [];
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const event = (cells[idx.event] || '').trim();
      if (SKIPPED_EVENTS.has(event)) { skipped++; continue; }
      const side = EVENT_TO_SIDE[event];
      if (!side) { skipped++; continue; }

      const trade_date = parseDate(cells[idx.date] || '');
      const quantity = parseNumber(cells[idx.quantity]);
      const price = parseNumber(cells[idx.price]);
      if (!trade_date || quantity === null || price === null) { skipped++; continue; }

      rows.push({
        user_id: user.id,
        ticker: (cells[idx.symbol] || '').trim(),
        side,
        quantity,
        price,
        trade_date,
        currency: cells[idx.currency] || null,
        fee_tax: parseNumber(cells[idx.feeTax]),
        fee_currency: cells[idx.feeCurrency] || null,
        exchange: cells[idx.exchange] || null,
        nkd: parseNumber(cells[idx.nkd]),
        note: cells[idx.note] || null,
        external_source: 'snowball_csv',
        external_id: `${event}:${cells[idx.date]}:${cells[idx.symbol]}:${cells[idx.quantity]}:${cells[idx.price]}:${cells[idx.feeTax]}`,
      });
    }

    if (!rows.length) {
      return new Response(JSON.stringify({ imported: 0, skipped, error: 'No importable rows found' }),
        { status: 400, headers: corsHeaders });
    }

    // Full sync on every upload: this CSV is the source of truth for this
    // source, so wipe all previously-imported rows and reinsert fresh. This
    // is what makes deleted/edited Snowball trades disappear/update here too,
    // and stays correct even if external_id's format changes between deploys.
    const { error: deleteErr, count: deletedCount } = await supabase
      .from('trades')
      .delete({ count: 'exact' })
      .eq('user_id', user.id)
      .eq('external_source', 'snowball_csv');

    if (deleteErr) {
      return new Response(JSON.stringify({ error: deleteErr.message }),
        { status: 500, headers: corsHeaders });
    }

    const { error: insertErr, count: insertedCount } = await supabase
      .from('trades')
      .insert(rows, { count: 'exact' });

    if (insertErr) {
      return new Response(JSON.stringify({ error: insertErr.message }),
        { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      imported: insertedCount ?? rows.length,
      removed: deletedCount ?? 0,
      skipped,
      total_rows: rows.length,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders });
  }
});
