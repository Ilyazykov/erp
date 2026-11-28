// Supabase Edge Function: update-moex-bonds
//
// What the Bonds & deposits tab needs from MOEX, worked out ahead (28.11.2026, the user's way:
// the page only reads it): the tab asked iss.moex.com itself on every opening -- two requests a
// bond held, the lists, the figures -- slow, and since 23.11.2026 failing in the browser (the
// Russian root's certificate). Daily, with the cron secret:
//   1. the lists (moex_bond_lists): 'ofz' -- the OFZ on the main board (TQOB) in roubles; 'cny' --
//      the yuan corporates of the reliable issuers on TQCB, a yield of 3-12% (as the tab had them);
//   2. per bond (moex_bonds.info): the name, maturity, next offer, face currency, the coupons and
//      amortisations to come and all of them, floating or not, the coupon's rate now -- for every
//      bond anyone holds (trades) and the new OFZ-PK (29014 on: the buy plan's floaters);
//   3. per bond (moex_bonds.market): the main board's coupon, its period, the last price, the day's
//      weighted price, yield and duration -- the bonds held, the OFZ and the yuan list.
// A bond MOEX didn't answer for keeps what it had. The page falls back to asking MOEX (through
// moex-iss) only for a bond not here yet.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ruFetch } from '../_shared/russian_root_ca.ts';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';

const ISS = 'https://iss.moex.com/iss';
const BOND_RE = /^(SU|RU)[0-9A-Z]{10}$/;
const CNY_ISSUERS = /^(ГазКап|РЖД|НорНик|Полюс|ФосАгро|Атомэнпр|Роснфт|МЕТАЛИН|ЕАБР)/;
// deno-lint-ignore no-explicit-any
type J = any;

// (a try's time: 20 s for a bond's own page; a whole board's list takes MOEX a minute or two, 28.11.2026)
async function iss(path: string, ms = 20000, tries = 3): Promise<J> {
  let last: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await ruFetch(`${ISS}${path}`, { signal: AbortSignal.timeout(ms) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      await res.body?.cancel();
    } catch (err) { last = err; }
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`MOEX ${path.split('?')[0]}: ${last}`);
}
const rowsOf = (j: J, t: string) => {
  const c: string[] = j?.[t]?.columns || [];
  return ((j?.[t]?.data || []) as unknown[][]).map(r => Object.fromEntries(c.map((k, i) => [k, r[i]])));
};

// 1. the lists
async function ofzList() {
  const j = await iss('/engines/stock/markets/bonds/boards/TQOB/securities.json?iss.meta=off&iss.only=securities,marketdata'
    + '&securities.columns=SECID,SHORTNAME,MATDATE,FACEVALUE,PREVPRICE,ACCRUEDINT,FACEUNIT&marketdata.columns=SECID,YIELD,VALTODAY', 130000, 1);
  const md = new Map(rowsOf(j, 'marketdata').map(m => [m.SECID, m]));
  return rowsOf(j, 'securities').filter(r => r.MATDATE && (r.FACEUNIT || 'SUR') === 'SUR').map(r => ({
    secid: r.SECID, name: r.SHORTNAME, mat: r.MATDATE, face: Number(r.FACEVALUE), price: Number(r.PREVPRICE), accrued: Number(r.ACCRUEDINT),
    yield: Number(md.get(r.SECID)?.YIELD) || 0, turnover: Number(md.get(r.SECID)?.VALTODAY) || 0,
    pd: /^SU2[56]\d{3}/.test(r.SECID), pk: /^SU29\d{3}/.test(r.SECID) }));
}
// (the whole corporate board doesn't come from MOEX in 130 s, not even its reference columns alone,
// 28.11.2026: each issuer's bonds found by MOEX's search instead, then their figures 20 a request)
const CNY_SEARCH = ['ГазКап', 'РЖД', 'НорНик', 'Полюс', 'ФосАгро', 'Атомэнпр', 'Роснфт', 'МЕТАЛИН', 'ЕАБР'];
async function cnyList(errors: string[]) {
  const ids = new Set<string>();
  await Promise.all(CNY_SEARCH.map(async q => {
    for (let start = 0; start < 500; start += 100) {
      const j = await iss(`/securities.json?iss.meta=off&q=${encodeURIComponent(q)}&engine=stock&market=bonds&is_trading=1&limit=100&start=${start}`
        + '&securities.columns=secid,shortname,primary_boardid').catch(e => { errors.push(String(e)); return null; });
      const rows = rowsOf(j, 'securities');
      for (const r of rows) if (r.primary_boardid === 'TQCB' && CNY_ISSUERS.test(r.shortname || '')) ids.add(r.secid);
      if (rows.length < 100) break;
    }
  }));
  const all = [...ids], picked: J[] = [];
  for (let i = 0; i < all.length; i += 20) {
    const j = await iss(`/engines/stock/markets/bonds/securities.json?iss.meta=off&iss.only=securities,marketdata&securities=${all.slice(i, i + 20).join(',')}`
      + '&securities.columns=SECID,BOARDID,SHORTNAME,MATDATE,OFFERDATE,FACEUNIT,FACEVALUE,PREVPRICE,ACCRUEDINT&marketdata.columns=SECID,BOARDID,YIELD,VALTODAY')
      .catch(e => { errors.push(String(e)); return null; });
    const md = new Map(rowsOf(j, 'marketdata').map(m => [`${m.SECID}|${m.BOARDID}`, m]));
    for (const r of rowsOf(j, 'securities')) if (r.BOARDID === 'TQCB' && r.FACEUNIT === 'CNY' && r.MATDATE) picked.push({ ...r, md: md.get(`${r.SECID}|TQCB`) || {} });
  }
  return picked.map(r => ({
    secid: r.SECID, name: r.SHORTNAME, mat: r.MATDATE, offer: r.OFFERDATE, due: r.OFFERDATE || r.MATDATE, face: Number(r.FACEVALUE),
    price: Number(r.PREVPRICE) || 100, accrued: Number(r.ACCRUEDINT) || 0,
    yield: Number(r.md.YIELD) || 0, turnover: Number(r.md.VALTODAY) || 0 }))
    .filter(b => b.yield >= 3 && b.yield <= 12);
}

// 2. a bond's dates and payments (the page's mpMoexBondDates, as it was)
async function bondInfo(secid: string, today: string) {
  const base = `/securities/${encodeURIComponent(secid)}`;
  const [d, o] = await Promise.all([
    iss(`${base}.json?iss.meta=off&iss.only=description&description.columns=name,value`),
    iss(`${base}/bondization.json?iss.meta=off&iss.only=offers,coupons,amortizations&limit=unlimited`),
  ]);
  if (!d?.description?.data?.length) throw new Error(`MOEX ${secid}: no description`);
  const desc: Record<string, string> = Object.fromEntries(d.description.data.map(([k, v]: [string, string]) => [k, v]));
  const offers = rowsOf(o, 'offers').map(r => r.offerdate).filter(x => x && x >= today).sort();
  const raw = rowsOf(o, 'coupons');
  // floating: by MOEX's COUPON_DETAILS ('Ключевая ставка', 'Ставка RUONIA'...; not
  // 'Фиксированный с неизвестными купонами'); without it, if the future rates aren't one known rate
  const details = desc.COUPON_DETAILS || '';
  const rates = new Set(raw.filter(c => c.coupondate > today).map(c => Number(c.valueprc) || 0));
  const floating = /ОФЗ-ПК/.test(desc.NAME || '') || (details ? !/^Фиксированный/i.test(details) : rates.size > 1 || rates.has(0));
  let lastCoupon = 0;
  const coupons = raw.map(c => { if (c.value) lastCoupon = Number(c.value); return { day: c.coupondate, value: c.value ? Number(c.value) : lastCoupon }; })
    .filter(c => c.day > today && c.value > 0);
  const amort = rowsOf(o, 'amortizations');
  const face = amort.filter(a => a.amortdate > today).map(a => ({ day: a.amortdate, value: Number(a.value) }));
  const set = raw.filter(c => c.value || c.valueprc).pop();
  const rate = !set ? null : Number(set.valueprc) || Number(set.value) / Number(set.facevalue)
    * 365 / Math.max(1, (Date.parse(set.coupondate) - Date.parse(set.startdate)) / 86400000) * 100;
  return {
    at: today, name: desc.NAME || desc.SHORTNAME || secid, mat: desc.MATDATE || null, offer: offers[0] || null,
    unit: (desc.FACEUNIT || 'RUB').replace('SUR', 'RUB'), coupons, face, floating, rate,
    allC: raw.map(c => [c.coupondate, c.value ? Number(c.value) : null]), allA: amort.map(a => [a.amortdate, Number(a.value)]),
  };
}

// 3. the main board's figures, 20 bonds a request
async function marketOf(secids: string[], errors: string[]) {
  const out = new Map<string, J>();
  for (let i = 0; i < secids.length; i += 20) {
    // (a batch MOEX didn't answer for: those keep what they had)
    const j = await iss(`/engines/stock/markets/bonds/securities.json?iss.meta=off&iss.only=securities,marketdata&securities=${secids.slice(i, i + 20).join(',')}`
      + '&securities.columns=SECID,BOARDID,COUPONPERCENT,COUPONPERIOD,PREVPRICE,PREVWAPRICE&marketdata.columns=SECID,BOARDID,YIELD,DURATION,VALTODAY')
      .catch(e => { errors.push(String(e)); return null; });
    if (!j) continue;
    const md = new Map(rowsOf(j, 'marketdata').map(m => [`${m.SECID}|${m.BOARDID}`, m]));
    for (const s of rowsOf(j, 'securities')) {
      if (!['TQOB', 'TQCB', 'TQIR'].includes(s.BOARDID)) continue;
      const m = md.get(`${s.SECID}|${s.BOARDID}`) || {};
      out.set(s.SECID, { coupon: s.COUPONPERCENT != null ? Number(s.COUPONPERCENT) : null, period: Number(s.COUPONPERIOD) || null,
        price: Number(s.PREVPRICE) || null, wap: Number(s.PREVWAPRICE) || null, yield: Number(m.YIELD) || 0, dur: Number(m.DURATION) || 0, turnover: Number(m.VALTODAY) || 0 });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (!(await fromCron(req))) return notFromCron();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const errors: string[] = [];

    // the lists (slow at MOEX) alongside the bonds' own pages: the bonds to work out from the
    // lists stored last time, the new ones written as they come
    const listsDone = Promise.all([
      ofzList().catch(e => { errors.push(String(e)); return null; }),
      cnyList(errors).catch(e => { errors.push(String(e)); return null; }),
    ]).then(async ([ofz, cny]) => {
      const lists = [...(ofz?.length ? [{ name: 'ofz', list: ofz, at: today, updated_at: now }] : []),
        ...(cny?.length ? [{ name: 'cny', list: cny, at: today, updated_at: now }] : [])];
      if (lists.length) { const { error } = await db.from('moex_bond_lists').upsert(lists); if (error) errors.push(error.message); }
      console.log(`lists: ofz ${ofz?.length}, cny ${cny?.length}`);
      return { ofz: ofz?.length ?? null, cny: cny?.length ?? null };
    });
    const { data: stored } = await db.from('moex_bond_lists').select('name, list');
    const listOf = (n: string): J[] => (stored || []).find(l => l.name === n)?.list || [];

    // the bonds held, anyone's: buys less sales, by ticker
    const net = new Map<string, number>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await db.from('trades').select('ticker, side, quantity').in('side', ['buy', 'sell', 'stock_as_dividend'])
        .or('ticker.like.SU*,ticker.like.RU*').order('id').range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const t of data || []) if (BOND_RE.test(t.ticker)) net.set(t.ticker, (net.get(t.ticker) || 0) + (t.side === 'sell' ? -1 : 1) * Number(t.quantity));
      if (!data || data.length < 1000) break;
    }
    const held = [...net].filter(([, q]) => q > 1e-9).map(([t]) => t);
    const pk = listOf('ofz').filter(b => b.pk && Number(String(b.secid).slice(2, 7)) >= 29014).map(b => b.secid);
    const dated = [...new Set([...held, ...pk])];
    console.log(`held ${held.length}, to date ${dated.length}`);

    const datesDone = (async () => {
      const infos: { secid: string; info: J; updated_at: string }[] = [];
      for (let i = 0; i < dated.length; i += 6) {
        await Promise.all(dated.slice(i, i + 6).map(s => bondInfo(s, today)
          .then(info => { infos.push({ secid: s, info, updated_at: now }); }, e => { errors.push(String(e)); })));
      }
      if (infos.length) { const { error } = await db.from('moex_bonds').upsert(infos); if (error) errors.push(error.message); }
      console.log(`dated ${infos.length}`);
      return infos.length;
    })();
    const marketDone = (async () => {
      const priced = [...new Set([...held, ...listOf('ofz').map(b => b.secid), ...listOf('cny').map(b => b.secid)])];
      const market = await marketOf(priced, errors);
      const mrows = [...market].map(([secid, m]) => ({ secid, market: m, updated_at: now }));
      if (mrows.length) { const { error } = await db.from('moex_bonds').upsert(mrows); if (error) errors.push(error.message); }
      console.log(`market ${mrows.length}`);
      return mrows.length;
    })();
    const [lists, datedN, marketN] = await Promise.all([listsDone, datesDone, marketDone]);
    return json({ ...lists, held: held.length, dated: datedN, of_dated: dated.length, market: marketN, errors });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
