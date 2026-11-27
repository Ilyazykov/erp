// A short Google Maps link (maps.app.goo.gl/..., goo.gl/maps/...) opened to the full one
// (google.com/maps/place/<name>/@lat,lng...!3d..!4d..), which mpPlaceFromLink reads. The
// browser can't follow the redirect itself (no CORS on goo.gl), so the place form asks here
// (27.11.2026: a pasted maps.app.goo.gl link filled nothing). Google's hosts only.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SHORT = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl)\//;
const GOOGLE = /^https:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl)(\/|$)/;

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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const { url } = await req.json();
    if (typeof url !== 'string' || !SHORT.test(url)) return json({ error: 'Not a short Google Maps link' }, 400);

    let cur = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(cur, { redirect: 'manual' });
      await res.body?.cancel();
      const loc = res.headers.get('location');
      if (!loc) break;
      let next = new URL(loc, cur).toString();
      // the EU consent page holds the place's link in "continue"
      const u = new URL(next);
      if (u.hostname === 'consent.google.com' && u.searchParams.get('continue')) next = u.searchParams.get('continue')!;
      if (!GOOGLE.test(next)) return json({ error: `Redirected off Google: ${new URL(next).hostname}` }, 400);
      cur = next;
      if (!SHORT.test(cur)) break;
    }
    if (SHORT.test(cur)) return json({ error: 'The link did not open' }, 400);
    return json({ url: cur });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
