// Supabase Edge Function: sync-crypto-wallets
//
// Reads non-custodial wallet addresses from `crypto_wallets` and pulls their
// current balances and full transaction history straight from public,
// keyless blockchain explorer APIs:
//   ethereum -- Blockscout (eth.blockscout.com/api/v2): ETH balance, every
//               token balance (with the explorer's USD price when it has
//               one), native / internal / token transfers
//   tron     -- TronGrid (api.trongrid.io/v1): TRX balance (staked and
//               unstaking TRX included -- still owned), TRC-20 balances,
//               native and TRC-20 transfers
// and writes them to `wallet_balances` / `wallet_transactions` (see
// migrations/20250101000013_crypto_wallets.sql for what each column means
// and how balances feed the holdings views).
//
// Two ways in:
//   * from the page, with the signed-in user's JWT -> syncs that user's
//     wallets only
//   * from the daily pg_cron job (no user JWT, just the publishable apikey;
//     deployed with --no-verify-jwt like update-market-prices) -> syncs
//     every wallet
// Either way the response carries counts only -- never an address -- since
// anyone holding the publishable key can call it.
//
// The address never leaves the server side: the browser only ever sees
// balances/transactions keyed by wallet id. DB writes use the service-role
// client, but in user mode only for wallets whose user_id is the caller's.
//
// History is incremental: newest-first pages are fetched until a page holds
// nothing not already stored, so the first sync walks the whole history and
// later ones only the new tail.
//
// Pricing: 'ETH' / 'TRX' / 'USDT' / 'USDC' tickers are priced by
// update-market-prices like any other crypto. Any other token the explorer
// prices (and which has a real market -- market cap or 24h volume, to keep
// airdropped scam tokens with made-up prices out) gets a
// 'TOKEN:<chain>:<contract>' ticker whose market_prices row this function
// writes itself. Tokens with no price are stored with ticker null -- kept
// for the record, never valued.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const TRONGRID = 'https://api.trongrid.io';
const MAX_PAGES = 200;

// Canonical stablecoin contracts -> the plain ticker update-market-prices
// already prices. Keyed by contract, never by symbol: scam tokens copy the
// "USDT" symbol all the time.
const STABLECOINS: Record<string, Record<string, string>> = {
  ethereum: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  },
  tron: {
    TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: 'USDT',
    TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: 'USDC',
  },
};

interface Wallet { id: string; user_id: string; chain: string; address: string; account: string }
interface Balance {
  contract: string; symbol: string | null; name: string | null; decimals: number | null;
  quantity: string; price_usd: number | null; ticker: string | null;
}
interface Tx {
  tx_hash: string; seq: number; kind: string; tx_time: string; contract: string;
  symbol: string | null; decimals: number | null; amount: string; counterparty: string | null; status: string | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Public explorers throttle and occasionally time out: retry network errors,
// 429 and 5xx a few times with backoff.
async function getJson(url: string, init?: RequestInit, retries = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`${new URL(url).host}: ${err}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`${new URL(url).host} ${res.status}`);
  }
}

// "1234500" with 4 decimals -> "123.45" -- exact, no floats.
function formatUnits(raw: string | number | bigint, decimals: number | null): string {
  const neg = String(raw).startsWith('-');
  const digits = String(raw).replace('-', '');
  const d = decimals ?? 0;
  const padded = digits.padStart(d + 1, '0');
  const int = padded.slice(0, padded.length - d);
  const frac = d ? padded.slice(padded.length - d).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}
const neg = (s: string) => (s.startsWith('-') ? s.slice(1) : s === '0' ? s : '-' + s);

// ---------------------------------------------------------------------------
// base58check (TRON addresses): TronGrid's native-transaction payload uses
// hex ("41..."), its TRC-20 endpoint and the user's input use base58.
// ---------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decodeHex(s: string): string {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hex.slice(0, -8).toLowerCase(); // drop the 4-byte checksum
}
async function hexToB58(hex: string): Promise<string> {
  const bytes = new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16)));
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
  const full = new Uint8Array([...bytes, ...h2.slice(0, 4)]);
  let n = BigInt('0x' + [...full].map(b => b.toString(16).padStart(2, '0')).join(''));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of full) { if (b === 0) out = '1' + out; else break; }
  return out;
}

// ---------------------------------------------------------------------------
// Ethereum via Blockscout
// ---------------------------------------------------------------------------
// bestEffort: on a failing page keep what was fetched so far and report it
// in `warnings` instead of failing the whole sync (Blockscout's
// internal-transactions pages can be very slow for busy addresses).
async function blockscoutPages(path: string, known: Set<string>, keyOf: (it: any) => string,
                               warnings?: string[]): Promise<any[]> {
  const out: any[] = [];
  let params: Record<string, string> | null = {};
  for (let page = 0; params && page < MAX_PAGES; page++) {
    const qs = new URLSearchParams(params).toString();
    let d: any;
    try {
      d = await getJson(`${BLOCKSCOUT}${path}${qs ? (path.includes('?') ? '&' : '?') + qs : ''}`, undefined, warnings ? 0 : 4);
    } catch (err) {
      if (!warnings) throw err;
      warnings.push(`${path.split('/').pop()}: stopped after ${page} page(s) -- ${String(err).slice(0, 120)}`);
      break;
    }
    const items = d.items || [];
    out.push(...items);
    if (items.length && items.every((it: any) => known.has(keyOf(it)))) break;
    params = d.next_page_params
      ? Object.fromEntries(Object.entries(d.next_page_params).map(([k, v]) => [k, String(v)]))
      : null;
    await sleep(150);
  }
  return out;
}

function hasRealMarket(t: any): boolean {
  return !!t.exchange_rate && (!!t.circulating_market_cap || !!t.volume_24h);
}

async function syncEthereum(w: Wallet, knownTx: Set<string>, warnings: string[]): Promise<{ balances: Balance[]; txs: Tx[] }> {
  const a = w.address.toLowerCase();
  const info = await getJson(`${BLOCKSCOUT}/addresses/${w.address}`);
  const balances: Balance[] = [{
    contract: '', symbol: 'ETH', name: 'Ether', decimals: 18,
    quantity: formatUnits(info.coin_balance || '0', 18),
    price_usd: info.exchange_rate ? Number(info.exchange_rate) : null, ticker: 'ETH',
  }];
  const tokens = await getJson(`${BLOCKSCOUT}/addresses/${w.address}/token-balances`);
  for (const tb of tokens) {
    const t = tb.token || {};
    const contract = String(t.address_hash || t.address || '').toLowerCase();
    const decimals = t.decimals != null ? Number(t.decimals) : (t.type === 'ERC-20' ? 18 : 0);
    const stable = STABLECOINS.ethereum[contract];
    const priced = t.type === 'ERC-20' && hasRealMarket(t);
    balances.push({
      contract, symbol: t.symbol ?? null, name: t.name ?? null, decimals,
      quantity: formatUnits(tb.value || '0', decimals),
      price_usd: t.exchange_rate ? Number(t.exchange_rate) : null,
      ticker: stable ?? (priced ? `TOKEN:ethereum:${contract}` : null),
    });
  }

  const txs: Tx[] = [];
  const nativeTxs = await blockscoutPages(`/addresses/${w.address}/transactions`, knownTx, it => it.hash);
  for (const it of nativeTxs) {
    const from = it.from?.hash?.toLowerCase(), to = it.to?.hash?.toLowerCase();
    const ok = it.status === 'ok';
    const base = { tx_hash: it.hash, tx_time: it.timestamp, contract: '', symbol: 'ETH', decimals: 18, status: it.status ?? null };
    const value = formatUnits(it.value || '0', 18);
    if (ok && value !== '0' && from === a) txs.push({ ...base, seq: 0, kind: 'native', amount: neg(value), counterparty: it.to?.hash ?? null });
    if (ok && value !== '0' && to === a) txs.push({ ...base, seq: 1, kind: 'native', amount: value, counterparty: it.from?.hash ?? null });
    const fee = formatUnits(it.fee?.value || '0', 18);
    if (from === a && fee !== '0') txs.push({ ...base, seq: 0, kind: 'fee', amount: neg(fee), counterparty: null });
  }
  const internal = await blockscoutPages(`/addresses/${w.address}/internal-transactions`, knownTx, it => it.transaction_hash, warnings);
  for (const it of internal) {
    if (it.success === false) continue;
    const from = it.from?.hash?.toLowerCase(), to = it.to?.hash?.toLowerCase();
    const value = formatUnits(it.value || '0', 18);
    if (value === '0') continue;
    const base = { tx_hash: it.transaction_hash, tx_time: it.timestamp, kind: 'internal', contract: '', symbol: 'ETH', decimals: 18, status: 'ok' };
    const idx = Number(it.index ?? 0) * 2;
    if (from === a) txs.push({ ...base, seq: idx, amount: neg(value), counterparty: it.to?.hash ?? null });
    if (to === a) txs.push({ ...base, seq: idx + 1, amount: value, counterparty: it.from?.hash ?? null });
  }
  const tokenTxs = await blockscoutPages(`/addresses/${w.address}/token-transfers`, knownTx, it => it.transaction_hash);
  for (const it of tokenTxs) {
    const t = it.token || {};
    const decimals = it.total?.decimals != null ? Number(it.total.decimals) : (t.decimals != null ? Number(t.decimals) : 0);
    const value = formatUnits(it.total?.value ?? '1', decimals);
    const from = it.from?.hash?.toLowerCase(), to = it.to?.hash?.toLowerCase();
    const base = {
      tx_hash: it.transaction_hash, tx_time: it.timestamp, kind: 'token',
      contract: String(t.address_hash || t.address || '').toLowerCase(), symbol: t.symbol ?? null, decimals, status: 'ok',
    };
    const idx = Number(it.log_index ?? 0) * 2;
    if (from === a) txs.push({ ...base, seq: idx, amount: neg(value), counterparty: it.to?.hash ?? null });
    if (to === a) txs.push({ ...base, seq: idx + 1, amount: value, counterparty: it.from?.hash ?? null });
  }
  return { balances, txs };
}

// ---------------------------------------------------------------------------
// TRON via TronGrid
// ---------------------------------------------------------------------------
async function trongridPages(path: string, known: Set<string>, keyOf: (it: any) => string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = `${TRONGRID}${path}${path.includes('?') ? '&' : '?'}limit=200`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const d = await getJson(url);
    const items = d.data || [];
    out.push(...items);
    if (items.length && items.every((it: any) => known.has(keyOf(it)))) break;
    url = d.meta?.links?.next ?? null;
    await sleep(300);
  }
  return out;
}

async function trc20Meta(owner: string, contract: string): Promise<{ symbol: string | null; decimals: number | null }> {
  const call = async (selector: string) => {
    const d = await getJson(`${TRONGRID}/wallet/triggerconstantcontract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_address: owner, contract_address: contract, function_selector: selector, visible: true }),
    });
    return (d.constant_result && d.constant_result[0]) || '';
  };
  try {
    const decHex = await call('decimals()');
    const symHex = await call('symbol()');
    const decimals = decHex ? parseInt(decHex, 16) : null;
    let symbol: string | null = null;
    if (symHex.length >= 128) {
      const len = parseInt(symHex.slice(64, 128), 16);
      const bytes = symHex.slice(128, 128 + len * 2).match(/../g) || [];
      symbol = new TextDecoder().decode(new Uint8Array(bytes.map((h: string) => parseInt(h, 16)))) || null;
    }
    return { symbol, decimals };
  } catch {
    return { symbol: null, decimals: null };
  }
}

async function syncTron(w: Wallet, knownTx: Set<string>): Promise<{ balances: Balance[]; txs: Tx[] }> {
  const meHex = b58decodeHex(w.address);
  const acc = (await getJson(`${TRONGRID}/v1/accounts/${w.address}`)).data?.[0] || {};
  const sun = BigInt(acc.balance || 0)
    + (acc.frozenV2 || []).reduce((s: bigint, f: any) => s + BigInt(f.amount || 0), 0n)
    + (acc.unfrozenV2 || []).reduce((s: bigint, f: any) => s + BigInt(f.unfreeze_amount || 0), 0n);

  const txs: Tx[] = [];
  const meta: Record<string, { symbol: string | null; decimals: number | null }> = {};

  const trc20 = await trongridPages(`/v1/accounts/${w.address}/transactions/trc20`, knownTx, it => it.transaction_id);
  const seqInTx: Record<string, number> = {};
  for (const it of trc20) {
    if (it.type && it.type !== 'Transfer') continue;
    const ti = it.token_info || {};
    const contract = ti.address;
    meta[contract] = { symbol: ti.symbol ?? null, decimals: ti.decimals != null ? Number(ti.decimals) : null };
    const value = formatUnits(it.value || '0', meta[contract].decimals);
    const s = (seqInTx[it.transaction_id] = (seqInTx[it.transaction_id] ?? -1) + 1) * 2;
    const base = {
      tx_hash: it.transaction_id, tx_time: new Date(it.block_timestamp).toISOString(), kind: 'token',
      contract, symbol: meta[contract].symbol, decimals: meta[contract].decimals, status: 'SUCCESS',
    };
    if (it.from === w.address) txs.push({ ...base, seq: s, amount: neg(value), counterparty: it.to });
    if (it.to === w.address) txs.push({ ...base, seq: s + 1, amount: value, counterparty: it.from });
  }

  const native = await trongridPages(`/v1/accounts/${w.address}/transactions`, knownTx, it => it.txID);
  for (const it of native) {
    const c = it.raw_data?.contract?.[0];
    if (!c) continue;
    const v = c.parameter?.value || {};
    const ret = it.ret?.[0] || {};
    const base = {
      tx_hash: it.txID, tx_time: new Date(it.block_timestamp).toISOString(), contract: '',
      symbol: 'TRX', decimals: 6, status: ret.contractRet ?? null,
    };
    const owner = String(v.owner_address || '').toLowerCase();
    if (c.type === 'TransferContract' && ret.contractRet === 'SUCCESS') {
      const amount = formatUnits(v.amount || 0, 6);
      const to = String(v.to_address || '').toLowerCase();
      if (owner === meHex) txs.push({ ...base, seq: 0, kind: 'native', amount: neg(amount), counterparty: to ? await hexToB58(to) : null });
      if (to === meHex) txs.push({ ...base, seq: 1, kind: 'native', amount, counterparty: owner ? await hexToB58(owner) : null });
    }
    if (owner === meHex && Number(ret.fee || 0) > 0) {
      txs.push({ ...base, seq: 0, kind: 'fee', amount: neg(formatUnits(ret.fee, 6)), counterparty: null });
    }
  }

  const balances: Balance[] = [{
    contract: '', symbol: 'TRX', name: 'TRON', decimals: 6, quantity: formatUnits(sun, 6), price_usd: null, ticker: 'TRX',
  }];
  for (const entry of acc.trc20 || []) {
    const [contract, raw] = Object.entries(entry)[0] as [string, string];
    if (!meta[contract] || meta[contract].decimals == null) meta[contract] = await trc20Meta(w.address, contract);
    const m = meta[contract];
    balances.push({
      contract, symbol: m.symbol, name: null, decimals: m.decimals,
      quantity: formatUnits(raw, m.decimals), price_usd: null, ticker: STABLECOINS.tron[contract] ?? null,
    });
  }
  return { balances, txs };
}

// ---------------------------------------------------------------------------

async function syncWallet(db: any, w: Wallet) {
  const { data: existing, error: exErr } = await db.from('wallet_transactions').select('tx_hash').eq('wallet_id', w.id);
  if (exErr) throw new Error(exErr.message);
  const known = new Set<string>((existing || []).map((r: any) => r.tx_hash));

  const warnings: string[] = [];
  const { balances, txs } = w.chain === 'ethereum' ? await syncEthereum(w, known, warnings) : await syncTron(w, known);

  const now = new Date().toISOString();
  const { error: delErr } = await db.from('wallet_balances').delete().eq('wallet_id', w.id);
  if (delErr) throw new Error(delErr.message);
  const balRows = balances
    .filter(b => b.contract === '' || b.quantity !== '0')
    .map(b => ({ ...b, wallet_id: w.id, user_id: w.user_id, account: w.account, chain: w.chain, as_of: now }));
  if (balRows.length) {
    const { error } = await db.from('wallet_balances').insert(balRows);
    if (error) throw new Error(error.message);
  }

  // TOKEN:* tickers are priced here, from the explorer's own USD price.
  const today = now.slice(0, 10);
  const priceRows = balRows
    .filter(b => b.ticker?.startsWith('TOKEN:') && b.price_usd)
    .map(b => ({
      ticker: b.ticker, price_usd: b.price_usd, native_price: b.price_usd, currency: 'USD',
      asset_class: 'crypto', infra_region: 'foreign', instrument_type: 'crypto',
      underlying_currency: b.symbol, source: 'blockscout', as_of: today,
    }));
  if (priceRows.length) {
    const { error } = await db.from('market_prices').upsert(priceRows, { onConflict: 'ticker' });
    if (error) throw new Error(error.message);
  }

  const newTxs = txs.filter(t => !known.has(t.tx_hash))
    .map(t => ({ ...t, wallet_id: w.id, user_id: w.user_id, chain: w.chain }));
  for (let i = 0; i < newTxs.length; i += 500) {
    const { error } = await db.from('wallet_transactions')
      .upsert(newTxs.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return { assets: balRows.length, priced: balRows.filter(b => b.ticker).length, new_transactions: newTxs.length, warnings };
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // User mode when a real user JWT comes along; otherwise (cron) all wallets.
    let userId: string | null = null;
    const auth = req.headers.get('Authorization');
    if (auth) {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await asUser.auth.getUser();
      if (user) userId = user.id;
    }

    let q = db.from('crypto_wallets').select('id, user_id, chain, address, account');
    if (userId) q = q.eq('user_id', userId);
    const { data: wallets, error } = await q;
    if (error) throw new Error(error.message);

    const results = [];
    for (const w of (wallets || []) as Wallet[]) {
      try {
        const r = await syncWallet(db, w);
        await db.from('crypto_wallets').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', w.id);
        results.push({ wallet_id: userId ? w.id : undefined, chain: w.chain, ...r });
      } catch (err) {
        await db.from('crypto_wallets').update({ last_sync_error: String(err).slice(0, 500) }).eq('id', w.id);
        results.push({ wallet_id: userId ? w.id : undefined, chain: w.chain, error: String(err).slice(0, 200) });
      }
    }
    return new Response(JSON.stringify({ wallets: results.length, results }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
