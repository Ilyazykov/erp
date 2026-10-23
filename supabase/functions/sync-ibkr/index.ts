// Supabase Edge Function: sync-ibkr
//
// Pulls the Interactive Brokers account through the Flex Web Service, so no
// one has to download and upload the Activity Statement CSV by hand
// (import-ibkr-statement). The Flex Query -- Client Portal -> Performance &
// Reports -> Flex Queries -> Activity Flex Query -- needs:
//   sections: Trades (Execution or Order), Cash Transactions, Cash Report;
//   format XML; period "Last 365 Calendar Days";
//   date / time any of IBKR's (yyyyMMdd or yyyy-MM-dd, HHmmss or HH:mm:ss).
// and Flex Web Service turned on there (Flex Queries -> Flex Web Service
// Configuration), which gives the token. Both are entered on the page
// (My portfolio -> IBKR automatic sync) into broker_credentials (migration
// ...096, ...097); the function's secrets IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID are
// the fallback when no one has entered them.
//
// Written as import-ibkr-statement writes the CSV, account 'IBKR', source
// 'ibkr_csv':
//   trades -- buys / sells of stocks (price, commission, listing exchange
//     LSEETF -> LSE), dividends (quantity = amount, price = the rate in
//     "USD 0.21 per Share");
//   bank_transactions -- the cash per currency: every trade's proceeds +
//     commission, both legs of a conversion (EUR.USD) and its commission,
//     deposits / withdrawals, dividends, withholding tax, interest, fees;
//     balance_after running from the Cash Report's starting cash, so the
//     last row of a currency is its ending cash.
// The statement is the record of its period: IBKR's rows dated within it
// are replaced (deleted, then written) -- however an earlier upload worded
// them, nothing is in twice.
//
// Two ways in, as sync-crypto-wallets: the page's "Sync now" (the user's
// JWT -> that user), or the daily pg_cron job (no JWT, deployed with
// --no-verify-jwt -> every user with a Query ID and token; with the secrets
// instead, the user IBKR_USER_ID names, or else the one with IBKR rows).
// Each run's result is kept in broker_credentials.last_sync_*. The response
// carries counts and cash totals only; the daily job's, counts of users.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fromCron, notFromCron } from '../_shared/cron_auth.ts';
import { removeCoveredSnowball } from '../_shared/statement_priority.ts';

const ACCOUNT = 'IBKR';
const SOURCE = 'ibkr_csv';
const EXCHANGE_NAMES: Record<string, string> = { LSEETF: 'LSE' };
const FLEX = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
// IBKR's error codes for a token it won't take: 1012 expired, 1015 invalid.
const TOKEN_REFUSED = /IBKR SendRequest: 101[25]\b/;
const round = (x: number, d = 9) => Math.round(x * 10 ** d) / 10 ** d;
// The daily job's slots (migration ...095): 24 runs, 10 minutes apart, from 04:00 UTC.
const SLOT_START_MIN = 4 * 60, SLOT_MINUTES = 10, SLOTS = 24, RUN_USERS = 2;
// A user's slot: a hash of their id, the same every day.
function slotOf(userId: string): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SLOTS;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The attributes of every <Tag .../> in the XML (Flex elements are
// attribute-only).
function elements(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[a[1]] = a[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
    out.push(attrs);
  }
  return out;
}
const tagText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';

// "20250828;093012" / "2025-08-28;09:30:12" / "20250828" -> "2025-08-28T09:30:12"
function isoTime(s: string | undefined): string | null {
  const m = (s || '').match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[;, T]+(\d{2}):?(\d{2}):?(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}` : null;
}

async function fetchStatement(token: string, queryId: string): Promise<string> {
  const headers = { 'User-Agent': 'erp-sync-ibkr/1.0' };
  const sent = await (await fetch(`${FLEX}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`, { headers })).text();
  if (tagText(sent, 'Status') !== 'Success') {
    const code = tagText(sent, 'ErrorCode');
    const hint = code === '1012' ? ' -- generate a new token (Flex Web Service Configuration) and save it on the page'
      : code === '1015' ? ' -- check the token saved on the page' : '';
    throw new Error(`IBKR SendRequest: ${code} ${tagText(sent, 'ErrorMessage')}${hint}`.trim());
  }
  const ref = tagText(sent, 'ReferenceCode');
  const url = tagText(sent, 'Url') || `${FLEX}/GetStatement`;
  // The statement takes a few seconds to generate (ErrorCode 1019 meanwhile).
  for (let i = 0; i < 20; i++) {
    await sleep(i ? 5000 : 3000);
    const got = await (await fetch(`${url}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(ref)}&v=3`, { headers })).text();
    if (got.includes('<FlexQueryResponse')) return got;
    const code = tagText(got, 'ErrorCode');
    if (code !== '1019' && code !== '1018') throw new Error(`IBKR GetStatement: ${code} ${tagText(got, 'ErrorMessage')}`.trim());
  }
  throw new Error('IBKR GetStatement: still generating after 100 s');
}

interface CashMove { time: string; currency: string; amount: number; description: string }

function parse(xml: string) {
  const stmt = elements(xml, 'FlexStatement')[0];
  const from = isoTime(stmt?.fromDate)?.slice(0, 10), to = isoTime(stmt?.toDate)?.slice(0, 10);
  if (!from || !to) throw new Error('No FlexStatement period in the response');
  // The period's rows are replaced by these: a query without one of the
  // sections would wipe what it doesn't give.
  const missing = ['Trades', 'CashTransactions', 'CashReport'].filter(s => !new RegExp(`<${s}[\\s>/]`).test(xml));
  if (missing.length) throw new Error(`The Flex Query lacks ${missing.join(', ')} -- add the section(s); nothing was changed`);

  const starting: Record<string, number> = {};
  const ending: Record<string, number> = {};
  for (const c of elements(xml, 'CashReportCurrency')) {
    if (!c.currency || c.currency === 'BASE_SUMMARY') continue;
    starting[c.currency] = Number(c.startingCash || 0);
    ending[c.currency] = Number(c.endingCash || 0);
  }

  const trades = [];
  const cash: CashMove[] = [];
  const all = elements(xml, 'Trade');
  // One row per order where the query gives orders, else per execution.
  const level = all.some(t => t.levelOfDetail === 'ORDER') ? 'ORDER' : 'EXECUTION';
  for (const t of all) {
    if (t.levelOfDetail && t.levelOfDetail !== level) continue;
    const time = isoTime(t.dateTime || t.tradeDate);
    if (!time) continue;
    const qty = Number(t.quantity || 0);
    const comm = Number(t.ibCommission || 0);
    const commCcy = t.ibCommissionCurrency || t.currency;
    if (t.assetCategory === 'STK' || t.assetCategory === 'ETF') {
      const symbol = t.symbol;
      trades.push({
        ticker: symbol, side: qty >= 0 ? 'buy' : 'sell', quantity: Math.abs(qty), price: Number(t.tradePrice),
        trade_date: time.slice(0, 10), currency: t.currency, fee_tax: Math.abs(comm), fee_currency: commCcy,
        exchange: EXCHANGE_NAMES[t.listingExchange] ?? (t.listingExchange || null), note: null,
        external_id: `trade:${time}:${symbol}:${qty}:${t.tradePrice}`,
      });
      // proceeds + commission + the deal's taxes (a stamp duty), as the CSV
      // import books a trade's money
      const desc = `${qty >= 0 ? 'Buy' : 'Sell'} ${Math.abs(qty)} ${symbol} @ ${t.tradePrice}`;
      const sameCcy = commCcy === t.currency;
      cash.push({ time, currency: t.currency, amount: Number(t.proceeds || 0) + (sameCcy ? comm : 0) + Number(t.taxes || 0), description: desc });
      if (comm && !sameCcy) cash.push({ time, currency: commCcy, amount: comm, description: `${desc} -- commission` });
    } else if (t.assetCategory === 'CASH') {
      const [base, quote] = (t.symbol || '').split('.');
      const desc = `Forex ${t.symbol} ${qty} @ ${t.tradePrice}`;
      cash.push({ time, currency: base, amount: qty, description: desc });
      cash.push({ time, currency: quote, amount: Number(t.proceeds || 0), description: desc });
      if (comm) cash.push({ time, currency: commCcy, amount: comm, description: `${desc} -- commission` });
    }
  }

  for (const c of elements(xml, 'CashTransaction')) {
    if (c.levelOfDetail && c.levelOfDetail !== 'DETAIL') continue;
    const deposit = /deposit|withdraw/i.test(c.type || '');
    const time = isoTime(deposit ? (c.settleDate || c.dateTime) : (c.dateTime || c.settleDate));
    if (!time) continue;
    const amount = Number(c.amount || 0);
    const description = c.description || c.type || '';
    cash.push({ time: deposit ? `${time.slice(0, 10)}T00:00:00` : time, currency: c.currency, amount, description });
    if (/^dividends$|payment in lieu/i.test(c.type || '') && c.symbol) {
      const rate = description.match(/ ([\d.]+) per Share/)?.[1];
      const date = time.slice(0, 10);
      trades.push({
        ticker: c.symbol, side: 'dividend', quantity: amount, price: rate ? Number(rate) : amount,
        trade_date: date, currency: c.currency, fee_tax: null, fee_currency: null,
        exchange: EXCHANGE_NAMES[c.listingExchange] ?? (c.listingExchange || null), note: description,
        external_id: `dividend:${date}:${c.symbol}:${c.amount}`,
      });
    }
  }

  // Running balance per currency, from the period's starting cash; rows that
  // share a time a millisecond apart in order.
  cash.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const balance: Record<string, number> = { ...starting };
  const seenTime = new Map<string, number>();
  const occ = new Map<string, number>();
  const bank = cash.filter(m => m.currency && m.amount).map(m => {
    balance[m.currency] = round((balance[m.currency] ?? 0) + m.amount);
    const n = seenTime.get(m.time) ?? 0; seenTime.set(m.time, n + 1);
    const sig = `${m.time}:${m.currency}:${round(m.amount)}:${m.description}`;
    const o = occ.get(sig) ?? 0; occ.set(sig, o + 1);
    return {
      tx_date: new Date(Date.parse(`${m.time}Z`) + n).toISOString(), currency: m.currency, amount: round(m.amount),
      description: m.description, balance_after: balance[m.currency], external_id: o === 0 ? sig : `${sig}:dup${o}`,
    };
  });
  const tOcc = new Map<string, number>();
  for (const t of trades) {
    const o = tOcc.get(t.external_id) ?? 0; tOcc.set(t.external_id, o + 1);
    if (o) t.external_id = `${t.external_id}:dup${o}`;
  }
  return { from, to, trades, bank, balance, ending };
}

// Pulls one user's statement and replaces the period's IBKR rows with it.
// deno-lint-ignore no-explicit-any
async function syncUser(db: any, userId: string, token: string, queryId: string) {
  const p = parse(await fetchStatement(token, queryId));

  // The period's rows are replaced.
  const { error: dT } = await db.from('trades').delete().eq('user_id', userId).eq('account', ACCOUNT)
    .eq('external_source', SOURCE).gte('trade_date', p.from).lte('trade_date', p.to);
  if (dT) throw new Error(dT.message);
  const { error: dB } = await db.from('bank_transactions').delete().eq('user_id', userId).eq('account', ACCOUNT)
    .eq('external_source', SOURCE).gte('tx_date', `${p.from}T00:00:00Z`).lte('tx_date', `${p.to}T23:59:59.999Z`);
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
  // Statement over Snowball, as the CSV import: Snowball rows of these operations go.
  const removedSnowball = await removeCoveredSnowball(db, userId, trades);
  // Pairs and capital rebuilt by the queue.
  const { error: rq } = await db.rpc('request_capital_refresh', { p_user: userId });
  if (rq) throw new Error(rq.message);

  return {
    period: `${p.from}..${p.to}`,
    trades: trades.filter(t => t.side !== 'dividend').length,
    dividends: trades.filter(t => t.side === 'dividend').length,
    cash_rows: bank.length,
    removed_snowball_duplicates: removedSnowball,
    cash: p.balance,
    statement_ending_cash: p.ending,
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

    // Who to sync with what: the Query ID / token entered on the page
    // (broker_credentials), else the function's secrets IBKR_FLEX_TOKEN /
    // IBKR_FLEX_QUERY_ID for IBKR_USER_ID or the one user with IBKR rows.
    // (the token decrypted from Vault, migration ...097)
    let q = db.rpc('ibkr_flex_credentials');
    if (userId) q = q.eq('user_id', userId);
    const { data: creds, error: cErr } = await q;
    if (cErr) throw new Error(cErr.message);
    type Cred = { user_id: string; token: string; query_id: string; last_sync_at: string | null; last_sync_result: string | null };
    let picked = (creds ?? []) as Cred[];
    // The daily job (every 10 minutes, 04:00-07:50 UTC -- migration ...095)
    // spreads the users over its 24 runs: each has a slot from its id, and a
    // run takes at most RUN_USERS whose slot has come and who aren't synced
    // today -- a missed or failed run is made up by the next.
    const nowSlot = Math.floor((new Date().getUTCHours() * 60 + new Date().getUTCMinutes() - SLOT_START_MIN) / SLOT_MINUTES);
    if (!userId) {
      const today = new Date().toISOString().slice(0, 10);
      // a failed run is retried -- but not a token IBKR refuses (expired /
      // invalid): that waits for a new one on the page
      const syncedToday = (c: Cred) => !!c.last_sync_at && c.last_sync_at.slice(0, 10) >= today
        && (!(c.last_sync_result || '').startsWith('{"error"') || TOKEN_REFUSED.test(c.last_sync_result || ''));
      picked = picked.filter(c => slotOf(c.user_id) <= nowSlot && !syncedToday(c))
        .sort((a, b) => slotOf(a.user_id) - slotOf(b.user_id)).slice(0, RUN_USERS);
    }
    const jobs: { user_id: string; token: string; query_id: string; stored: boolean }[] =
      picked.map(c => ({ user_id: c.user_id, token: c.token, query_id: c.query_id, stored: true }));
    const envToken = Deno.env.get('IBKR_FLEX_TOKEN'), envQuery = Deno.env.get('IBKR_FLEX_QUERY_ID');
    // The secrets have no record of a run: the daily job uses them in its first run only.
    if (!jobs.length && !(creds ?? []).length && envToken && envQuery && (userId || nowSlot === 0)) {
      let owner = userId ?? Deno.env.get('IBKR_USER_ID') ?? null;
      if (!owner) {
        const { data, error } = await db.from('trades').select('user_id').eq('account', ACCOUNT).limit(1000);
        if (error) throw new Error(error.message);
        const owners = [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
        if (owners.length === 1) owner = owners[0];
      }
      if (owner) jobs.push({ user_id: owner, token: envToken, query_id: envQuery, stored: false });
    }
    if (!jobs.length) {
      if (!userId && (creds ?? []).length) return json({ users: 0, slot: nowSlot });   // no one's turn in this run
      return json({ error: 'No IBKR Flex Query ID / token: enter them on the page (My portfolio -> IBKR automatic sync)' }, 400);
    }

    const results = [];
    for (const j of jobs) {
      let result: Record<string, unknown>;
      try {
        result = await syncUser(db, j.user_id, j.token, j.query_id);
      } catch (err) {
        result = { error: String(err) };
      }
      if (j.stored) {
        await db.from('broker_credentials').update({ last_sync_at: new Date().toISOString(), last_sync_result: JSON.stringify(result).slice(0, 2000) })
          .eq('user_id', j.user_id).eq('broker', 'ibkr');
      }
      results.push(result);
    }
    // The page gets its own result; the daily job counts only.
    if (userId) return json(results[0], results[0].error ? 500 : 200);
    return json({ users: results.length, errors: results.filter(r => r.error).length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
