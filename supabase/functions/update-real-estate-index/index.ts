// Supabase Edge Function: update-real-estate-index
//
// Refreshes real_estate_index (see migrations/20250101000026_real_estate.sql):
// the monthly average offer price per m2 of ready housing, per city.
//
// Nizhny Novgorod -- gipernn.ru, "Аналитика рынка готового жилья"
// (https://www.gipernn.ru/analitika-gotovogo-zhilya). The page's chart data
// isn't in the HTML itself but in the analytics script it loads
// (/assets/<hash>/analytics.main.js, the hash changes over time -- read from
// the page): `var d = {color: ..., data: [[<ms>, <RUB per m2>], ...]}`, one
// point per month back to 1997. The whole series is upserted every run, so
// a revised month is picked up too.
//
// Called by pg_cron on the 1st of each month (deployed with --no-verify-jwt; it
// only ever writes public data, with the service role).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SOURCES: Record<string, { page: string; source: string }> = {
  nizhny_novgorod: { page: 'https://www.gipernn.ru/analitika-gotovogo-zhilya', source: 'gipernn.ru' },
};

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (erp-portfolio price index)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.text();
}

async function gipernnSeries(page: string) {
  const html = await fetchText(page);
  const script = html.match(/src="(\/assets\/[^"]*analytics\.main\.js[^"]*)"/)?.[1];
  if (!script) throw new Error('analytics.main.js not found on the page');
  const js = await fetchText(new URL(script, page).toString());
  const data = js.match(/var d\s*=\s*\{[^[]*data:\s*(\[\[[\s\S]*?\]\])\s*\}/)?.[1];
  if (!data) throw new Error('price series (var d) not found in analytics.main.js');
  return [...data.matchAll(/\[(\d{10,13}),\s*([\d.]+)\]/g)].map(m => {
    const d = new Date(Number(m[1]));
    // Points are at midnight of the 1st, Moscow time -- take the UTC+3 date.
    const msk = new Date(d.getTime() + 3 * 3600_000);
    return { month: `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, '0')}-01`, price: Number(m[2]) };
  });
}

Deno.serve(async () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const result: Record<string, unknown> = {};
    for (const [city, cfg] of Object.entries(SOURCES)) {
      const series = await gipernnSeries(cfg.page);
      const rows = series.map(p => ({
        city, month: p.month, price_per_m2: p.price, currency: 'RUB', source: cfg.source, updated_at: new Date().toISOString(),
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('real_estate_index').upsert(rows.slice(i, i + 500), { onConflict: 'city,month' });
        if (error) throw new Error(error.message);
      }
      result[city] = { months: rows.length, first: rows[0], latest: rows[rows.length - 1] };
    }
    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
