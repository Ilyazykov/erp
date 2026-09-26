// Supabase Edge Function: import-binance
//
// Imports Binance's own transaction export (Orders -> Assets History ->
// Export -> Export Transaction Records):
//   Binance-Transaction-History-<yyyymmddhhmm>(UTC+3)-part1-of1.csv
//   User ID,Time,Account,Operation,Coin,Change,Remark
// One row per coin movement (a trade is its Buy / Sell / Fee rows), so every
// coin's balance is the plain sum of its rows. Times are in the zone named
// in the file name ("(UTC+3)") -- the file itself doesn't say, so the page
// passes it as ?tz=+3 (default UTC). Deposit / withdrawal history exports
// aren't needed: those movements are rows of this file too. A long history
// comes in several parts / periods; any of them may be uploaded, in any
// order, again and again (rows are upserted by their own content).
//
// Stored like the other exchange accounts (see _shared/exchange_balances.ts):
// a crypto_wallets row (chain 'binance', address "UID <User ID>", account
// 'Binance'), every row in wallet_transactions, the balances in
// wallet_balances. No internal kinds: moves between Binance's own accounts
// (Spot / Funding / Earn ...) come as both of their rows, which cancel out.
// Checked against the account on 26.09.2026: BTC 0.00000783,
// ETH 0.00003332, DOGE 0.7.
//
// POST ?recompute=1 recomputes balances from what's stored, same contract as
// import-bybit (user JWT: that user's account and balances back; none --
// deployed with --no-verify-jwt -- every account, counts only).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { dec, recomputeExchange, type ExchangeWallet } from '../_shared/exchange_balances.ts';

const ACCOUNT = 'Binance';

function kindOf(op: string): string {
  if (/^(Buy|Sell|Transaction (Related|Sold|Revenue|Buy|Spend))$/.test(op)) return 'trade';
  if (/Fee$/.test(op)) return 'fee';
  if (/^Deposit$|Fiat Deposit/.test(op)) return 'deposit';
  if (/^Withdraw$|Fiat Withdraw/.test(op)) return 'withdrawal';
  if (/Transfer/.test(op)) return 'transfer';
  if (/Reward|Airdrop|Distribution|Interest|Cashback/.test(op)) return 'reward';
  return 'other';
}
const RULES = {
  internalKinds: new Set<string>(),
  earnKinds: new Set<string>(),
  savingsTicker: 'SAVINGS:Binance USD',
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

// "2020-11-20 14:19:56" in UTC<tz> -> ISO UTC.
function toUtc(local: string, tzHours: number): string {
  const d = new Date(`${local.trim().replace(' ', 'T')}Z`);
  return new Date(d.getTime() - tzHours * 3600_000).toISOString();
}

function parse(text: string, tzHours: number) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  const header = parseCsvLine(lines[0] || '').map(h => h.trim());
  const col = (n: string) => header.indexOf(n);
  const [u, t, acc, op, coin, ch, rem] = ['User ID', 'Time', 'Account', 'Operation', 'Coin', 'Change', 'Remark'].map(col);
  if ([u, t, acc, op, coin, ch].some(i => i < 0)) return null;
  const body = lines.slice(1).map(parseCsvLine).filter(r => r[t]);
  const uid = body[0]?.[u];
  const occ = new Map<string, number>();
  const rows = body.map(r => {
    const amount = dec(r[ch]);
    const remark = rem >= 0 ? r[rem] : '';
    const sig = `bn|${r[t]}|${r[acc]}|${r[op]}|${r[coin]}|${amount}|${remark}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    return { tx_hash: sig, seq: n, kind: kindOf(r[op]), tx_time: toUtc(r[t], tzHours), symbol: r[coin], amount,
             status: `${r[acc]} | ${r[op]}${remark ? ` | ${remark}` : ''}` };
  });
  return { uid, total: body.length, rows };
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

    const params = new URL(req.url).searchParams;
    if (params.get('recompute')) {
      const db = user ? supabase : createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: wallets, error } = await db.from('crypto_wallets').select('id, user_id, account, chain').eq('chain', 'binance');
      if (error) throw new Error(error.message);
      const results = [];
      for (const w of wallets as ExchangeWallet[]) results.push(await recompute(db, w));
      return json(user ? { accounts: results.length, results } : { accounts: results.length });
    }

    if (!user) return json({ error: 'Not authenticated' }, 401);

    const tz = Number(params.get('tz') ?? '0');
    if (!Number.isFinite(tz) || Math.abs(tz) > 14) return json({ error: `Bad tz "${params.get('tz')}"` }, 400);
    const parsed = parse(await req.text(), tz);
    if (!parsed) return json({ error: 'Not a Binance transaction export (Export Transaction Records)' }, 400);
    if (!parsed.rows.length || !parsed.uid) return json({ rows: 0, note: 'The file has no transactions for its period -- nothing to import' });

    const address = `UID ${parsed.uid}`;
    let { data: wallet, error: wErr } = await supabase.from('crypto_wallets')
      .select('id, user_id, account, chain').eq('chain', 'binance').eq('address', address).maybeSingle();
    if (wErr) throw new Error(wErr.message);
    if (!wallet) {
      const ins = await supabase.from('crypto_wallets')
        .insert({ user_id: user.id, chain: 'binance', address, account: ACCOUNT })
        .select('id, user_id, account, chain').single();
      if (ins.error) throw new Error(ins.error.message);
      wallet = ins.data;
    }

    const rows = parsed.rows.map(r => ({
      ...r, wallet_id: wallet!.id, user_id: user!.id, chain: 'binance', contract: '', decimals: null, counterparty: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('wallet_transactions')
        .upsert(rows.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq' });
      if (error) throw new Error(error.message);
    }

    const r = await recompute(supabase, wallet as ExchangeWallet);
    return json({ rows: rows.length, tz, total_rows_stored: r.rows, balances: r.balances });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
