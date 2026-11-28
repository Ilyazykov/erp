// MOEX ISS for the page (28.11.2026): since 23.11.2026 iss.moex.com's certificate chains to the
// Russian Trusted Root CA, which no browser trusts -- every request of the page to it failed, and
// the bonds tab lost the bonds' dates and prices (the bonds gone from its charts, the tab slow).
// The page asks here instead (mpMoexFetch): a GET of an ISS path ("/iss/..." with its query, in
// "u"), fetched with that root trusted (ruFetch) and handed back as it came. ISS's paths only.
// The caller's JWT is checked by the gateway (deployed with verification on).
import { ruFetch } from '../_shared/russian_root_ca.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const u = new URL(req.url).searchParams.get('u') || '';
  if (!/^\/iss\/[A-Za-z0-9_./-]+(\?.*)?$/.test(u)) {
    return new Response(JSON.stringify({ error: 'Not an ISS path' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  try {
    const res = await ruFetch(`https://iss.moex.com${u}`);
    return new Response(res.body, {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
