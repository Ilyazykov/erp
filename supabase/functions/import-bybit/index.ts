// Supabase Edge Function: import-bybit
//
// Imports Bybit's own Data Export transaction logs (Account -> Data Export ->
// Transaction Log -> Account Change Details), one CSV per upload:
//   AssetChangeDetails_fund_<uid>_<from>_<to>_0.csv  -- Funding account
//     Uid,Date & Time(UTC),Coin,QTY,Type,Account Balance,Description
//   AssetChangeDetails_uta_<uid>_<from>_<to>_0.csv   -- Unified Trading account
//     Uid,Currency,Contract,Type,Direction,Quantity,Position,Filled Price,
//     Funding,Fee Paid,Cash Flow,Change,Wallet Balance,Action,Time(UTC)
// (both start with a "UID: <uid>,Company Name: ,Country: " line). Every
// period's files can be uploaded in any order and re-uploaded freely: rows
// are upserted by their own content.
//
// Bybit is stored like a crypto wallet (see
// migrations/20250101000016_bybit.sql): a crypto_wallets row (chain
// 'bybit'), every log line in wallet_transactions -- nothing dropped, but
// each tagged with a kind -- and the per-coin balance they add up to in
// wallet_balances, which the holdings views count as account 'Bybit'.
//
// Balance per coin = the sum of every movement that changes what the user
// owns on Bybit; moves *between* Bybit's own sub-accounts are tagged
// internal and left out of the sum:
//   - Funding <-> Unified Trading transfers (both legs are in the logs)
//   - Earn subscriptions / redemptions (Funding "Easy Earn | ...
//     Subscription / Redemption", "Easy Earn card redemption", "Auto-Earn",
//     "On-chain Earn subscription"; Unified Trading rows of type "--" that
//     aren't one leg of a same-second conversion) -- the coins sit in Earn,
//     still owned
//   - the Bybit Card's USD bookkeeping rows (coin USD): what the card
//     actually spends is the crypto "Sale" row next to them
// With complete logs from the account's first deposit this reproduces
// Bybit's own Account Statement to the last digit (checked against the
// 24.09.2026 statement: BTC 0.01729905, SOL 1.46851659, USDC 35.9875).
// Balances are recomputed from *all* stored rows after every upload, so
// they're only complete once every period's Funding and Unified Trading
// logs are in.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface Row {
  tx_hash: string; seq: number; kind: string; tx_time: string; symbol: string;
  amount: string; status: string;
}

const INTERNAL_KINDS = new Set(['transfer_internal', 'earn_internal', 'card_usd']);

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

// "0.004800000000000000" / "1.2E-7" -> canonical decimal string, exact
// enough for amounts with at most 18 decimals.
function dec(s: string): string {
  const t = (s || '').trim();
  if (!/e/i.test(t)) return t.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0';
  const n = Number(t);
  return n.toFixed(18).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function fundKind(desc: string, type: string, coin: string): string {
  const d = desc.toLowerCase();
  if (coin === 'USD') return 'card_usd';
  if (/subscription|redemption|auto-earn/.test(d)) return 'earn_internal';
  if (/transfer (to|from) unified trading/.test(d)) return 'transfer_internal';
  if (/interest distribution|rewards distribution/.test(d)) return 'interest';
  if (type === 'Deposit') return 'deposit';
  if (type === 'Withdraw' || type === 'Withdrawal') return 'withdrawal';
  if (type === 'Bybit Card') return 'card';
  if (type === 'Convert') return 'convert';
  if (type === 'Airdrop' || type === 'Rewards') return 'reward';
  if (type === 'Transfer in' || type === 'Transfer out') return 'transfer';
  return 'other';
}

function parse(text: string): { uid: string; source: 'fund' | 'uta'; rows: Row[] } | null {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
  const uid = (lines[0] || '').match(/^UID:\s*(\d+)/)?.[1];
  if (!uid || lines.length < 2) return null;
  const header = parseCsvLine(lines[1]).map(h => h.trim());
  const col = (n: string) => header.indexOf(n);
  const body = lines.slice(2).map(parseCsvLine);
  const occ = new Map<string, number>();
  const seqOf = (sig: string) => { const n = occ.get(sig) ?? 0; occ.set(sig, n + 1); return n; };

  if (header[1] === 'Date & Time(UTC)' && col('Coin') >= 0) {
    const [t, c, q, ty, b, d] = ['Date & Time(UTC)', 'Coin', 'QTY', 'Type', 'Account Balance', 'Description'].map(col);
    const rows = body.filter(r => r[t]).map(r => {
      const sig = `fund|${r[t]}|${r[c]}|${dec(r[q])}|${dec(r[b])}|${r[d]}`;
      return {
        tx_hash: sig, seq: seqOf(sig), kind: fundKind(r[d] || '', r[ty] || '', r[c]),
        tx_time: `${r[t].replace(' ', 'T')}Z`, symbol: r[c], amount: dec(r[q]),
        status: `${r[ty]} | ${r[d]} | balance ${dec(r[b])}`,
      };
    });
    return { uid, source: 'fund', rows };
  }

  if (header[1] === 'Currency' && col('Change') >= 0 && col('Time(UTC)') >= 0) {
    const [cu, ct, ty, ch, wb, t] = ['Currency', 'Contract', 'Type', 'Change', 'Wallet Balance', 'Time(UTC)'].map(col);
    const valid = body.filter(r => r[t]);
    // A "--" row is a small-balance conversion leg when another "--" row in
    // a different coin shares its second; otherwise it's money moving to or
    // from Earn.
    const convertSeconds = new Map<string, Set<string>>();
    for (const r of valid) if (r[ty] === '--') {
      const s = convertSeconds.get(r[t]) ?? new Set();
      s.add(r[cu]); convertSeconds.set(r[t], s);
    }
    const rows = valid.map(r => {
      const type = r[ty];
      const kind = type === 'TRADE' ? 'trade'
        : type === 'TRANSFER_IN' || type === 'TRANSFER_OUT' ? 'transfer_internal'
        : type === '--' ? ((convertSeconds.get(r[t])?.size ?? 0) > 1 ? 'convert' : 'earn_internal')
        : type.toLowerCase();
      const sig = `uta|${r[t]}|${r[cu]}|${r[ct]}|${type}|${dec(r[ch])}|${dec(r[wb])}`;
      return {
        tx_hash: sig, seq: seqOf(sig), kind, tx_time: `${r[t].replace(' ', 'T')}Z`, symbol: r[cu],
        amount: dec(r[ch]), status: `${type}${r[ct] ? ' ' + r[ct] : ''} | balance ${dec(r[wb])}`,
      };
    });
    return { uid, source: 'uta', rows };
  }
  return null;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401, headers: corsHeaders });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: corsHeaders });
    }

    const parsed = parse(await req.text());
    if (!parsed || !parsed.rows.length) {
      return new Response(JSON.stringify({
        error: 'Not a Bybit Funding / Unified Trading transaction log (Data Export -> Transaction Log -> Account Change Details)',
      }), { status: 400, headers: corsHeaders });
    }

    // The account's crypto_wallets row, created on first import.
    const address = `UID ${parsed.uid}`;
    let { data: wallet, error: wErr } = await supabase.from('crypto_wallets')
      .select('id, account').eq('chain', 'bybit').eq('address', address).maybeSingle();
    if (wErr) throw new Error(wErr.message);
    if (!wallet) {
      const ins = await supabase.from('crypto_wallets')
        .insert({ user_id: user.id, chain: 'bybit', address, account: 'Bybit' }).select('id, account').single();
      if (ins.error) throw new Error(ins.error.message);
      wallet = ins.data;
    }

    const rows = parsed.rows.map(r => ({
      ...r, wallet_id: wallet!.id, user_id: user.id, chain: 'bybit', contract: '', decimals: null, counterparty: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('wallet_transactions')
        .upsert(rows.slice(i, i + 500), { onConflict: 'wallet_id,tx_hash,kind,seq' });
      if (error) throw new Error(error.message);
    }

    // Recompute balances from every stored row of this account.
    const sums = new Map<string, number>();
    const scale = 1e18;
    const all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('wallet_transactions')
        .select('kind, symbol, amount').eq('wallet_id', wallet!.id).range(from, from + 999);
      if (error) throw new Error(error.message);
      all.push(...data);
      if (data.length < 1000) break;
    }
    // BigInt fixed-point (18 decimals) so ~1600 tiny interest rows sum exactly.
    const big = new Map<string, bigint>();
    for (const r of all) {
      if (INTERNAL_KINDS.has(r.kind)) continue;
      const [i, f = ''] = String(r.amount).replace('-', '').split('.');
      let v = BigInt(i || '0') * BigInt(scale) + BigInt((f + '0'.repeat(18)).slice(0, 18));
      if (String(r.amount).startsWith('-')) v = -v;
      big.set(r.symbol, (big.get(r.symbol) ?? 0n) + v);
    }
    const balances = [...big.entries()].filter(([, v]) => v !== 0n).map(([coin, v]) => {
      const neg = v < 0n; const a = neg ? -v : v;
      const s = `${neg ? '-' : ''}${a / BigInt(scale)}.${(a % BigInt(scale)).toString().padStart(18, '0')}`.replace(/\.?0+$/, '');
      sums.set(coin, Number(s));
      return {
        wallet_id: wallet!.id, user_id: user.id, account: wallet!.account, chain: 'bybit',
        contract: coin, symbol: coin, name: null, decimals: null, quantity: s, price_usd: null,
        ticker: coin, as_of: new Date().toISOString(),
      };
    });
    const { error: delErr } = await supabase.from('wallet_balances').delete().eq('wallet_id', wallet!.id);
    if (delErr) throw new Error(delErr.message);
    if (balances.length) {
      const { error } = await supabase.from('wallet_balances').insert(balances);
      if (error) throw new Error(error.message);
    }
    await supabase.from('crypto_wallets').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', wallet!.id);

    return new Response(JSON.stringify({
      source: parsed.source, uid: parsed.uid, rows: rows.length, total_rows_stored: all.length,
      balances: Object.fromEntries(sums),
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
