// Supabase Edge Function: import-crypto-com
//
// Imports the Crypto.com App's own transaction export (Accounts -> History ->
// Export -> Crypto Wallet): crypto_transactions_record_<date>.csv
//   Timestamp (UTC),Transaction Description,Currency,Amount,To Currency,
//   To Amount,Native Currency,Native Amount,Native Amount (in USD),
//   Transaction Kind,Transaction Hash
// Each export may cover any period and be re-uploaded freely: rows are
// upserted by their own content. The Fiat Wallet export has the same header
// but repeats the crypto file's EUR <-> crypto conversions from the fiat
// side (different kinds, opposite signs), so it's refused rather than
// double-counted; the Card export is only needed if the card is used.
//
// Stored like the other exchange accounts (see _shared/exchange_balances.ts
// and migrations/20250101000018_crypto_com.sql): a crypto_wallets row
// (chain 'cryptocom', account 'Crypto.com'), every leg of every row in
// wallet_transactions, and the balances they add up to in wallet_balances.
// A row with a To Currency (an exchange: "USDC > TAO", "Sold CRO" -> EUR)
// is two legs -- seq 0 the Currency/Amount side, seq 1 the To side.
//
// Internal kinds (coins still owned, just moved into Earn / staking) stay out
// of the balance sum: crypto_earn_program_created / _withdrawn (Crypto Earn)
// and finance.dpos.staking / unstaking (DPoS staking, e.g. TAO). Checked
// against the app on 26.09.2026: BTC 0.02037346, TAO 0.14137146,
// USDC 26.467654.
//
// POST ?recompute=1 recomputes balances from what's stored, same contract as
// import-bybit (user JWT: that user's account and balances back; none --
// deployed with --no-verify-jwt -- every account, counts only).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { dec, recomputeExchange, type ExchangeWallet } from '../_shared/exchange_balances.ts';

const ACCOUNT = 'Crypto.com';
const ADDRESS = 'Crypto.com App';

function kindOf(k: string): string {
  if (k.startsWith('crypto_earn_program_')) return 'earn_internal';
  if (/^finance\.dpos\.(un)?staking/.test(k)) return 'staking_internal';
  if (/interest/.test(k)) return 'interest';
  if (k === 'crypto_deposit' || k.endsWith('_deposit')) return 'deposit';
  if (k === 'crypto_withdrawal' || k.endsWith('_withdrawal')) return 'withdrawal';
  if (/purchase|exchange|viban/.test(k)) return 'trade';
  if (/reward|bonus|cashback/.test(k)) return 'reward';
  return 'other';
}
const RULES = {
  internalKinds: new Set(['earn_internal', 'staking_internal']),
  earnKinds: new Set(['earn_internal']),
  savingsTicker: 'SAVINGS:Crypto.com USD',
};
const recompute = (db: any, w: ExchangeWallet) => recomputeExchange(db, w, RULES);

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

function parse(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  const header = parseCsvLine(lines[0] || '').map(h => h.trim());
  const col = (n: string) => header.indexOf(n);
  const [t, d, c, a, tc, ta, k] = ['Timestamp (UTC)', 'Transaction Description', 'Currency', 'Amount',
    'To Currency', 'To Amount', 'Transaction Kind'].map(col);
  if ([t, d, c, a, tc, ta, k].some(i => i < 0)) return null;
  const body = lines.slice(1).map(parseCsvLine).filter(r => r[t]);
  // The Fiat Wallet export: crypto -> EUR shows up as kind "crypto_viban"
  // (the crypto file says "crypto_viban_exchange"), and an EUR -> crypto
  // purchase with a positive EUR amount (the crypto file has it negative).
  const fiat = body.some(r => r[k] === 'crypto_viban' || (r[k] === 'viban_purchase' && !r[a].startsWith('-')));
  const occ = new Map<string, number>();
  const rows = [];
  for (const r of body) {
    const sig = `cdc|${r[t]}|${r[d]}|${r[c]}|${dec(r[a])}|${r[tc]}|${dec(r[ta] || '')}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    const kind = kindOf(r[k]);
    const base = { tx_hash: sig, kind, tx_time: `${r[t].replace(' ', 'T')}Z`, status: `${r[k]} | ${r[d]}` };
    if (r[c] && r[a]) rows.push({ ...base, seq: n * 2, symbol: r[c], amount: dec(r[a]) });
    if (r[tc] && r[ta]) rows.push({ ...base, seq: n * 2 + 1, symbol: r[tc], amount: dec(r[ta]) });
  }
  return { fiat, rows };
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
    const authHeader = req.headers.get('Authorization');
    let user: { id: string } | null = null;
    let supabase: any = null;
    if (authHeader) {
      supabase = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      const { data } = await supabase.auth.getUser();
      user = data.user;
    }

    if (new URL(req.url).searchParams.get('recompute')) {
      const db = user ? supabase : createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: wallets, error } = await db.from('crypto_wallets').select('id, user_id, account, chain').eq('chain', 'cryptocom');
      if (error) throw new Error(error.message);
      const results = [];
      for (const w of wallets as ExchangeWallet[]) results.push(await recompute(db, w));
      return json(user ? { accounts: results.length, results } : { accounts: results.length });
    }

    if (!user) return json({ error: 'Not authenticated' }, 401);

    const parsed = parse(await req.text());
    if (!parsed || !parsed.rows.length) return json({ error: 'Not a Crypto.com App transaction export' }, 400);
    if (parsed.fiat) {
      return json({ error: 'This is the Fiat Wallet export -- its conversions are already in the Crypto Wallet export '
        + '(crypto_transactions_record_*.csv); upload that one instead.' }, 400);
    }

    let { data: wallet, error: wErr } = await supabase.from('crypto_wallets')
      .select('id, user_id, account, chain').eq('chain', 'cryptocom').eq('address', ADDRESS).maybeSingle();
    if (wErr) throw new Error(wErr.message);
    if (!wallet) {
      const ins = await supabase.from('crypto_wallets')
        .insert({ user_id: user.id, chain: 'cryptocom', address: ADDRESS, account: ACCOUNT })
        .select('id, user_id, account, chain').single();
      if (ins.error) throw new Error(ins.error.message);
      wallet = ins.data;
    }

    const rows = parsed.rows.map(r => ({
      ...r, wallet_id: wallet!.id, user_id: user!.id, chain: 'cryptocom', contract: '', decimals: null, counterparty: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('wallet_transactions')
        .upsert(rows.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq' });
      if (error) throw new Error(error.message);
    }

    const r = await recompute(supabase, wallet as ExchangeWallet);
    return json({ rows: rows.length, total_rows_stored: r.rows, balances: r.balances });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
