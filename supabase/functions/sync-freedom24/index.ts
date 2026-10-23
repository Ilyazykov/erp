// Supabase Edge Function: sync-freedom24
//
// Pulls Freedom24's cash movements through the Tradernet API, so no one has
// to download the cash-movement report (tradernet_table.xlsx) and upload it
// (import-freedom24-statement). An API key pair (freedom24.com -> Tradernet
// API -> API key -> Generate a new key pair) is entered on the page (My
// portfolio -> Freedom24 automatic sync) into broker_credentials (migration
// ...099): the public key in the clear, the private one in Supabase Vault.
//
// Freedom24 has no read-only keys: a pair can trade (not withdraw -- that
// takes an SMS-confirmed session). This function only reads: getUserCashFlows
// (deposits, commissions, dividends, taxes -- no trades) and getTradesHistory
// (trades and currency conversions, made into the report's "Сделка" rows,
// TRADE-<id>-<ccy>).
//
// The whole history every run (the account is young and small; the rows'
// running balances start from zero, so they must cover it from its opening),
// turned into rows by the xlsx's own rules (_shared/freedom24.ts) under its
// source, which they replace: Freedom24's bank rows and trades -- all but the
// shares credited without money (in_out:..., from the broker report JSON,
// which takes a login session the keys don't give: still uploaded by hand).
// Every row stored from the report must come back with its id and amount,
// else nothing is replaced: the API answering differently shows up as an
// error with the differences, not as lost or changed rows.
//
// Two ways in, as sync-ibkr: the page's "Sync now" / Save ({"check": true}:
// only whether the keys work), or the daily pg_cron job (no JWT, deployed
// with --no-verify-jwt -> every user with keys, each in a slot of their own,
// at most RUN_USERS a run). Each run's result is kept in
// broker_credentials.last_sync_*.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';
import { ACCOUNT, buildFromCashRows, type CashRow, SOURCE } from '../_shared/freedom24.ts';

// Keys work only in the cabinet that issued them.
const API = 'https://freedom24.com/api/';
const PAGE = 500;
// The daily job's slots (migration ...099): 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
// Tradernet's answers that mean the keys themselves are no good -- not retried the same day.
const KEY_REFUSED = /Tradernet (12|13)\b|[Ii]nvalid credentials/;

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// A signed command (Tradernet API V3): POST /api/<cmd>, the params as
// compact JSON, signed with body + timestamp.
// deno-lint-ignore no-explicit-any
async function tradernet(pub: string, secret: string, cmd: string, params: Record<string, unknown>): Promise<any> {
  const body = Object.keys(params).length ? JSON.stringify(params) : '';
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(API + cmd, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-NtApi-PublicKey': pub, 'X-NtApi-Timestamp': ts,
      'X-NtApi-Sig': await hmac(secret, body + ts),
      // Russian operation names and comments, as the xlsx has them
      'Cookie': 'lang=ru',
    },
    body,
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`Tradernet ${cmd}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (out?.errMsg || out?.error) throw new Error(`Tradernet ${out.code ?? res.status} ${out.errMsg || out.error} (${cmd})`);
  if (!res.ok) throw new Error(`Tradernet ${cmd}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return out;
}

// "2026-06-12 14:50:37" / "2026-06-12" -> ISO, the broker's clock kept as is (as the xlsx's).
const isoOf = (d: string) => {
  const s = String(d || '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// deno-lint-ignore no-explicit-any
async function cashFlows(pub: string, secret: string, take = PAGE): Promise<{ total: number; list: any[] }> {
  const list = [];
  let total = 0;
  for (let skip = 0; skip < 20000; skip += take) {
    // sort: one { field, dir } -- an array, as the broker's docs show it, is
    // refused ("Incorrect request parameters")
    const r = await tradernet(pub, secret, 'getUserCashFlows', { take, skip, sort: { field: 'date', dir: 'ASC' } });
    const page = Array.isArray(r.cashflow) ? r.cashflow : Object.values(r.cashflow ?? {});
    total = Number(r.total ?? page.length);
    list.push(...page);
    if (page.length < take || list.length >= total || take === 1) break;
  }
  return { total, list };
}

// Every trade (getTradesHistory: the cash flows leave trades out), oldest first.
// deno-lint-ignore no-explicit-any
async function tradesHistory(pub: string, secret: string, from: string): Promise<any[]> {
  const r = await tradernet(pub, secret, 'getTradesHistory', { beginDate: from, endDate: new Date().toISOString().slice(0, 10) });
  const t = r?.trades?.trade ?? [];
  return Array.isArray(t) ? t : [t];
}

// The cash-movement report's names of the cash flows' kinds (the API's own
// come in English): the xlsx's descriptions kept.
const OP_RU: Record<string, string> = {
  bank: 'Банковский перевод', commission_for_trades: 'Комиссия за сделки', dividend: 'Дивиденды', tax: 'Налоги',
};
const num = (v: unknown) => Number(String(v ?? '').trim());

// A trade as the cash-movement report shows it: one row in its currency --
// "Купить 4 VWCE.EU (сделка №656470312)", id TRADE-<id>-<ccy> -- or, a
// currency conversion (instrument "EUR/USD"), a row for each currency.
// deno-lint-ignore no-explicit-any
function tradeRows(t: any, time: string): CashRow[] | null {
  const id = String(t.id ?? '').trim(), instr = String(t.instr_nm ?? '').trim(), ccy = String(t.curr_c ?? '').trim();
  const buy = String(t.type) === '1', q = num(t.q), sum = Math.abs(num(t.summ ?? t.v));
  if (!id || !Number.isFinite(q) || !Number.isFinite(sum)) return null;
  const pair = instr.match(/^([A-Z]{3})\/?([A-Z]{3})$/);
  if (pair) {
    // buying the base currency for the quote one, or selling it
    const [base, quote] = [pair[1], pair[2]];
    const fx = (a: number, c: string) => ({ id: `TRADE-${id}-${c}`, time, op: 'Сделка', code: 'trade', amount: a, currency: c,
      comment: buy ? `Конвертация валюты ${sum.toFixed(2)} ${quote} → ${Math.abs(q).toFixed(2)} ${base}, курс ${t.p} (сделка №${id})`
        : `Конвертация валюты ${Math.abs(q).toFixed(2)} ${base} → ${sum.toFixed(2)} ${quote}, курс ${t.p} (сделка №${id})` });
    return buy ? [fx(-sum, quote), fx(Math.abs(q), base)] : [fx(-Math.abs(q), base), fx(sum, quote)];
  }
  if (!/^[A-Z0-9.\-]+\.[A-Z]+$/.test(instr) || !ccy) return null;
  return [{ id: `TRADE-${id}-${ccy}`, time, op: 'Сделка', code: 'trade', amount: buy ? -sum : sum, currency: ccy,
    comment: `${buy ? 'Купить' : 'Продать'} ${Math.abs(q)} ${instr} (сделка №${id})` }];
}

// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, pub: string, secret: string) {
  const { list } = await cashFlows(pub, secret);
  const firstDay = list.map(x => String(x.date ?? '').slice(0, 10)).filter(Boolean).sort()[0] ?? '2000-01-01';
  const tradeList = await tradesHistory(pub, secret, firstDay);

  // The API's clock is a few hours off the report's: the rows the report
  // already gave keep their time, the shift between the two (the commonest,
  // in whole hours) is applied to the new ones.
  const { data: stored, error: sErr } = await db.from('bank_transactions').select('external_id, tx_date, amount::text, currency')
    .eq('user_id', userId).eq('account', ACCOUNT).eq('external_source', SOURCE);
  if (sErr) throw new Error(sErr.message);
  const storedById = new Map<string, { tx_date: string; amount: string; currency: string }>(
    (stored ?? []).map((s: { external_id: string; tx_date: string; amount: string; currency: string }) => [s.external_id, s]));

  const raw: CashRow[] = [];
  const odd: unknown[] = [];
  for (const x of list) {
    const code = String(x.type_code ?? '');
    raw.push({ id: String(x.id ?? '').trim(), time: isoOf(x.datetime || x.date) ?? '', op: OP_RU[code] ?? String(x.type_code_name ?? '').trim(),
      code, comment: String(x.comment ?? '').trim(), amount: num(x.sum), currency: String(x.currency ?? '').trim() });
  }
  for (const t of tradeList) {
    const rs = tradeRows(t, isoOf(t.date) ?? '');
    if (rs) raw.push(...rs); else odd.push(t);
  }
  const shifts = new Map<number, number>();
  for (const r of raw) {
    const s = storedById.get(r.id);
    if (!s || !r.time) continue;
    const h = Math.round((Date.parse(s.tx_date) - Date.parse(r.time)) / 3600000);
    shifts.set(h, (shifts.get(h) ?? 0) + 1);
  }
  const shiftH = [...shifts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -3;
  const rows = raw.map(r => {
    const s = storedById.get(r.id);
    // the stored time to the second (the report's same-second rows are a ms apart)
    const time = s ? new Date(Math.floor(Date.parse(s.tx_date) / 1000) * 1000).toISOString()
      : r.time ? new Date(Date.parse(r.time) + shiftH * 3600000).toISOString() : '';
    return { ...r, time };
  }).filter(r => r.id && r.time && Number.isFinite(r.amount) && r.currency);
  // oldest first; a trade's cash before its commission, as in the report
  rows.sort((a, b) => a.time.localeCompare(b.time) || (a.code === 'trade' ? -1 : 0) - (b.code === 'trade' ? -1 : 0));
  const p = buildFromCashRows(rows);

  // Every row the report gave must come back, same id, same amount: else the
  // API isn't understood -- nothing replaced, the differences back for a look.
  const built = new Map(p.bank.map(b => [b.external_id, b]));
  const diffs: string[] = [];
  for (const [id, s] of storedById) {
    const b = built.get(id);
    if (!b) diffs.push(`${id} missing (${s.amount} ${s.currency})`);
    else if (Math.abs(b.amount - Number(s.amount)) > 0.005 || b.currency !== s.currency) diffs.push(`${id}: ${b.amount} ${b.currency} vs stored ${s.amount} ${s.currency}`);
  }
  if (diffs.length || odd.length) {
    throw new Error(`Not understood -- nothing replaced. ${diffs.length} of ${storedById.size} stored rows differ: ${diffs.slice(0, 8).join('; ')}. `
      + `${odd.length} trades not read. ${tradeList.length} trades, e.g. ${JSON.stringify((odd.length ? odd : tradeList).slice(0, 2)).slice(0, 900)}`);
  }

  // Replaced: Freedom24's rows, all but the gifted shares.
  const { error: dT } = await db.from('trades').delete().eq('user_id', userId).eq('account', ACCOUNT)
    .eq('external_source', SOURCE).not('external_id', 'like', 'in_out:%');
  if (dT) throw new Error(dT.message);
  const { error: dB } = await db.from('bank_transactions').delete().eq('user_id', userId).eq('account', ACCOUNT).eq('external_source', SOURCE);
  if (dB) throw new Error(dB.message);
  const trades = p.trades.map(t => ({ ...t, user_id: userId, account: ACCOUNT, external_source: SOURCE }));
  const bank = p.bank.map(b => ({ ...b, user_id: userId, account: ACCOUNT, counterparty: null, category: null, external_source: SOURCE }));
  for (let i = 0; i < bank.length; i += 500) {
    const { error } = await db.from('bank_transactions').upsert(bank.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
    if (error) throw new Error(error.message);
  }
  for (let i = 0; i < trades.length; i += 500) {
    const { error } = await db.from('trades').upsert(trades.slice(i, i + 500), { onConflict: 'user_id,external_source,external_id' });
    if (error) throw new Error(error.message);
  }
  const removedSnowball = await removeCoveredSnowball(db, userId, trades);
  const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
  if (rq) throw new Error(rq.message);

  const first = rows[0]?.time.slice(0, 10), last = rows[rows.length - 1]?.time.slice(0, 10);
  return {
    period: `${first ?? '?'}..${new Date().toISOString().slice(0, 10)}`, last_operation: last ?? null,
    trades: trades.filter(t => t.side !== 'dividend').length, dividends: trades.filter(t => t.side === 'dividend').length,
    cash_rows: bank.length, removed_snowball_duplicates: removedSnowball, cash: p.balance,
  };
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
    const url = Deno.env.get('SUPABASE_URL')!;
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // The signed-in user (from the page), or -- the daily job -- everyone.
    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      userId = (await asUser.auth.getUser()).data.user?.id ?? null;
    }
    // Without a user: only the daily job, with the cron secret.
    if (!userId && !(await fromCron(req))) return notFromCron();

    let q = db.rpc('freedom24_api_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; public_key: string; private_key: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    if (!picked.length) {
      if (!userId) return json({ users: 0 });
      return json({ error: 'No Freedom24 API keys: enter them on the page (My portfolio -> Freedom24 automatic sync)' }, 400);
    }
    // The page's Save: whether the keys work, nothing pulled.
    const body = await req.json().catch(() => ({}));
    if (userId && body.check) {
      try {
        const { total } = await cashFlows(picked[0].public_key, picked[0].private_key, 1);
        return json({ operations: total });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }
    // The daily job: users whose slot has come and who aren't synced today; a
    // failed run is retried by the next, but not keys Tradernet refuses.
    const nowSlot = Math.floor((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() - SLOT_START_MIN) / SLOT_MINUTES);
    if (!userId) {
      const today = new Date().toISOString().slice(0, 10);
      const syncedToday = (c: Cred) => !!c.last_sync_at && c.last_sync_at.slice(0, 10) >= today
        && (!(c.last_sync_result || '').startsWith('{"error"') || KEY_REFUSED.test(c.last_sync_result || ''));
      picked = picked.filter(c => slotOf(c.user_id) <= nowSlot && !syncedToday(c))
        .sort((a, b) => slotOf(a.user_id) - slotOf(b.user_id)).slice(0, RUN_USERS);
      if (!picked.length) return json({ users: 0, slot: nowSlot });
    }

    const results = [];
    for (const c of picked) {
      let result: Record<string, unknown>;
      try {
        result = await syncUser(db, c.user_id, c.public_key, c.private_key);
      } catch (err) {
        result = { error: String(err) };
      }
      await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 2000) })
        .eq('user_id', c.user_id).eq('broker', 'freedom24');
      results.push(result);
    }
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
