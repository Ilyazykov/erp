// Supabase Edge Function: import-apple-purchases
//
// Apple's purchase history (reportaproblem.apple.com: the page's text,
// copied as it is into a .txt) -> receipts of source 'apple' (migration
// ...211): one per paid order, its key Apple's order ID, its lines the
// items (title, the app, the subscription's period), never products. Free
// orders are left out. An order already in is left as it is (Apple's
// history doesn't change), so the whole history can be uploaded again and
// only the new orders go in. Parsing: _shared/apple.js (tests/apple.test.mjs).
// The orders are then linked to the cards' Apple charges by
// match_apple_receipts; one with no charge waits (checked again after every
// import that calls match_receipts, and after every upload on the page).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseApplePurchases, isApplePurchaseHistory } from '../_shared/apple.js';

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
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await db.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const text = await req.text();
    if (!isApplePurchaseHistory(text)) return json({ error: 'Not Apple\'s purchase history (reportaproblem.apple.com, the page\'s text)' }, 400);
    const { orders, free } = parseApplePurchases(text);
    if (!orders.length) return json({ error: 'No paid orders found' }, 400);
    const bad = orders.filter(o => !o.date || !o.currency);
    if (bad.length) return json({ error: `Orders without a day or a currency: ${bad.map(o => o.orderId).join(', ')}` }, 400);

    // the orders already in stay as they are
    const have = new Set<string>();
    for (let i = 0; i < orders.length; i += 200) {
      const { data, error } = await db.from('receipts').select('receipt_key').eq('user_id', user.id).eq('source', 'apple')
        .in('receipt_key', orders.slice(i, i + 200).map(o => o.orderId));
      if (error) throw new Error(error.message);
      for (const r of data ?? []) have.add(r.receipt_key);
    }
    const fresh = orders.filter(o => !have.has(o.orderId));

    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const { data: ins, error } = await db.from('receipts').insert(chunk.map(o => ({
        user_id: user.id, source: 'apple', receipt_key: o.orderId, purchased_on: o.date,
        store_printed: 'Apple', chain: 'Apple', currency: o.currency, total: o.total, file_name: 'apple purchase history',
      }))).select('id, receipt_key');
      if (error) throw new Error(error.message);
      const idOf = new Map((ins ?? []).map(r => [r.receipt_key, r.id]));
      const lines = chunk.flatMap(o => o.items.map(it => ({
        user_id: user.id, receipt_id: idOf.get(o.orderId), line_no: it.lineNo,
        name_printed: it.title, name_en: it.app ? `${it.title} · ${it.app}` : it.title,
        qty: 1, unit: 'pcs', unit_price_paid: it.price, line_total: it.price, note: it.period,
      })));
      if (lines.length) {
        const { error: lErr } = await db.from('receipt_items').insert(lines);
        if (lErr) throw new Error(lErr.message);
      }
    }

    const { data: linkedNow, error: mErr } = await db.rpc('match_apple_receipts');
    if (mErr) throw new Error(mErr.message);

    const { data: states, error: sErr } = await db.from('receipts').select('match_state, purchased_on')
      .eq('user_id', user.id).eq('source', 'apple');
    if (sErr) throw new Error(sErr.message);
    const waiting = (states ?? []).filter(s => s.match_state === 'waiting');
    const days = orders.map(o => o.date).sort();
    return json({
      orders: orders.length, new: fresh.length, already: have.size, free,
      linked_this_run: linkedNow ?? 0,
      linked: (states ?? []).length - waiting.length, waiting: waiting.length,
      warnings: orders.filter(o => o.warnings.length).map(o => `${o.date} ${o.orderId}: ${o.warnings.join('; ')}`),
      period_start: days[0], period_end: days[days.length - 1],
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
