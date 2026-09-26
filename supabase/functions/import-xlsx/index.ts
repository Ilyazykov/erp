// Supabase Edge Function: import-xlsx
//
// One entry point for every .xlsx upload: the file's own content says what
// it is -- the name never matters -- and it's handed, unchanged, to the
// importer for that source (same caller's Authorization):
//   - "Отчет о сделках и операциях" by АО «ТБанк"   -> import-tbank-broker
//   - header "Операция №" ... "Комментарий"         -> import-freedom24-statement
//     (Freedom24 / Tradernet cash-movement report)
//   - "Account Number" / "IBAN" / "Account Activities" -> import-ziraat-statement
// The importer's response comes back with `detected` added, so the page
// knows which status line to show.

import { xlsxRows } from '../_shared/xlsx_rows.ts';

const ROUTES: { detected: string; fn: string; test: (text: string) => boolean }[] = [
  { detected: 'tbank_broker_xlsx', fn: 'import-tbank-broker',
    test: t => /Отчет о сделках и операциях/.test(t) && /ТБАНК|ТБанк/.test(t) },
  { detected: 'freedom24_xlsx', fn: 'import-freedom24-statement',
    test: t => /Операция №/.test(t) && /Комментарий/.test(t) },
  { detected: 'ziraat_xlsx', fn: 'import-ziraat-statement',
    test: t => /Account Number/.test(t) && /IBAN/.test(t) && /Account Activities/.test(t) },
];

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return json({ error: 'Missing Authorization header' }, 401);
    const bytes = new Uint8Array(await req.arrayBuffer());

    // The first rows are enough to tell the sources apart.
    const text = xlsxRows(bytes, 40).map(r => Object.values(r).join(',')).join('\n');
    const route = ROUTES.find(r => r.test(text));
    if (!route) {
      return json({ error: 'Unrecognized .xlsx -- expected a T-Bank broker report, a Freedom24 cash-movement report or a Ziraat Bank account activity export' }, 400);
    }

    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${route.fn}`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      body: bytes,
    });
    const body = await res.json().catch(() => ({ error: `${route.fn} returned ${res.status}` }));
    return json({ ...body, detected: route.detected }, res.status);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
