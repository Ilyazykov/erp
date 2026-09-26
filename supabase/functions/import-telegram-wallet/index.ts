// Supabase Edge Function: import-telegram-wallet
//
// Imports Telegram Wallet (@wallet, custodial). Wallet has no export, so its
// history is scraped from the web app (Transaction history of the wallet,
// and of each Earn product) and turned into this project's own CSV,
// oldest first:
//   timestamp_utc,section,title,amount,currency,status
//   2025-09-23 09:11,wallet,Exchanged USDT to XAUT,0.09,XAUT,Received
//   2025-09-23 09:11,wallet,Transfer to Earn,-0.09,XAUT,Sent
//   2025-09-25 07:15,earn,Rewarded,0.0141,GRAM,Received
// section 'wallet' = the main wallet's history, 'earn' = an Earn product's
// own history (deposits into it and rewards). Amounts signed. The
// file is the whole history each time, so re-uploading it is harmless (rows
// are upserted by their own content).
//
// Stored like the exchanges (see _shared/exchange_balances.ts): a
// crypto_wallets row (chain 'telegram', account 'Telegram'), every row in
// wallet_transactions, the balances they add up to in wallet_balances.
//
// What Wallet's history doesn't show, and how it's handled:
//   - An exchange ("Exchanged XAUT to USDT +3.81 USDT") lists only what was
//     received. When a non-dollar coin was exchanged, the whole of it in the
//     main wallet was sold every time (XAUT, BTC, FLR, XLM -- none left after
//     their sale), so that side is stored as kind 'trade_out': the coin's
//     entire main-wallet balance at that moment. When dollars (USDT) were
//     spent, how much is unknown (leftovers stayed), so a 'trade_out_unknown'
//     row with amount 0 marks it and USDT gets no balance -- the app shows 0.
//   - Earn: for a coin with an Earn history in the file ('earn' rows),
//     "Transfer to/from Earn" and "Deposited" are internal moves (the coins
//     are still owned) and its rewards are income -- GRAM (the app's own
//     Earn history) and XAUT (the app dropped it once withdrawn, so its
//     monthly rewards were taken from Snowball when building the CSV). For
//     any other coin (USDT, BTC, FLR, XLM: withdrawn from Earn in full long
//     ago) "Transfer to/from Earn" count as real moves out of / into the
//     wallet, so its rewards still arrive inside "Transfer from Earn".
// Checked against the app on 26.09.2026: XAUT 0.459574, GRAM 39.8496
// (in Earn), ADI 0.16, USDT 0.
//
// POST ?recompute=1 recomputes balances from what's stored, same contract as
// import-bybit (user JWT: that user's account and balances back; none --
// deployed with --no-verify-jwt -- every account, counts only).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { dec, STABLECOINS, recomputeExchange, type ExchangeWallet } from '../_shared/exchange_balances.ts';

const ACCOUNT = 'Telegram';
const ADDRESS = 'Telegram Wallet';
const HEADER = 'timestamp_utc,section,title,amount,currency,status';

function kindOf(section: string, title: string, hasEarnHistory: boolean): string {
  if (section === 'earn') return /^Deposited/.test(title) ? 'earn_internal' : 'interest';
  if (/^Transfer (to|from) Earn/.test(title)) return hasEarnHistory ? 'earn_internal' : 'earn_move';
  if (/^Exchanged /.test(title)) return 'trade';
  if (/^Crypto purchase/.test(title)) return 'purchase';
  if (/^Top-up/.test(title)) return 'deposit';
  if (/^Withdrew/.test(title)) return 'withdrawal';
  if (/^Gift/.test(title)) return 'reward';
  return 'other';
}
const RULES = {
  internalKinds: new Set(['earn_internal']),
  earnKinds: new Set<string>(),
  savingsTicker: 'SAVINGS:Telegram USD',
  unknownKinds: new Set(['trade_out_unknown']),
};
const recompute = (db: any, w: ExchangeWallet) => recomputeExchange(db, w, RULES);

// Fixed-point sum for the running main-wallet balance ('trade_out' amounts).
const SCALE = 10n ** 18n;
const toBig = (s: string) => {
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(i || '0') * SCALE + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return s.startsWith('-') ? -v : v;
};
const toStr = (v: bigint) => {
  const neg = v < 0n; const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / SCALE}.${(a % SCALE).toString().padStart(18, '0')}`.replace(/\.?0+$/, '');
};

function parse(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
  if ((lines[0] || '').trim() !== HEADER) return null;
  // No quoting needed: titles are "Withdrew to UQ...fDVO" and the like.
  const body = lines.slice(1).map(l => l.split(','));
  const earnCoins = new Set(body.filter(r => r[1] === 'earn').map(r => r[4]));
  const main = new Map<string, bigint>();   // main-wallet balance per coin, in file order
  const occ = new Map<string, number>();
  const rows = [];
  for (const [ts, section, title, amountRaw, symbol, status] of body) {
    const amount = dec(amountRaw);
    const kind = kindOf(section, title, earnCoins.has(symbol));
    const sig = `tg|${ts}|${section}|${title}|${symbol}|${amount}`;
    const n = occ.get(sig) ?? 0; occ.set(sig, n + 1);
    const tx_time = `${ts.replace(' ', 'T')}:00Z`;
    const base = { tx_hash: sig, tx_time, status: `${title}${status ? ` | ${status}` : ''}` };
    const counterparty = title.match(/^(?:Withdrew to|Top-up from) (\S+)/)?.[1] ?? null;
    rows.push({ ...base, kind, seq: n * 2, symbol, amount, counterparty });
    if (section === 'wallet') main.set(symbol, (main.get(symbol) ?? 0n) + toBig(amount));

    const src = kind === 'trade' ? title.match(/^Exchanged (\S+) to /)?.[1] : undefined;
    if (src && src !== symbol) {
      if (STABLECOINS.has(src)) {
        rows.push({ ...base, kind: 'trade_out_unknown', seq: n * 2 + 1, symbol: src, amount: '0', counterparty: null });
      } else {
        const all = main.get(src) ?? 0n;
        rows.push({ ...base, kind: 'trade_out', seq: n * 2 + 1, symbol: src, amount: toStr(-all), counterparty: null });
        main.set(src, 0n);
      }
    }
  }
  return { total: body.length, rows };
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
      const { data: wallets, error } = await db.from('crypto_wallets').select('id, user_id, account, chain').eq('chain', 'telegram');
      if (error) throw new Error(error.message);
      const results = [];
      for (const w of wallets as ExchangeWallet[]) results.push(await recompute(db, w));
      return json(user ? { accounts: results.length, results } : { accounts: results.length });
    }

    if (!user) return json({ error: 'Not authenticated' }, 401);

    const parsed = parse(await req.text());
    if (!parsed) return json({ error: `Not a Telegram Wallet CSV (expected header "${HEADER}")` }, 400);

    let { data: wallet, error: wErr } = await supabase.from('crypto_wallets')
      .select('id, user_id, account, chain').eq('chain', 'telegram').eq('address', ADDRESS).maybeSingle();
    if (wErr) throw new Error(wErr.message);
    if (!wallet) {
      const ins = await supabase.from('crypto_wallets')
        .insert({ user_id: user.id, chain: 'telegram', address: ADDRESS, account: ACCOUNT })
        .select('id, user_id, account, chain').single();
      if (ins.error) throw new Error(ins.error.message);
      wallet = ins.data;
    }

    const rows = parsed.rows.map(r => ({
      ...r, wallet_id: wallet!.id, user_id: user!.id, chain: 'telegram', contract: '', decimals: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('wallet_transactions')
        .upsert(rows.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq' });
      if (error) throw new Error(error.message);
    }

    const r = await recompute(supabase, wallet as ExchangeWallet);
    return json({ rows: rows.length, total_in_file: parsed.total, total_rows_stored: r.rows, balances: r.balances,
      unknown_balance: r.unknown_balance ?? [] });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
