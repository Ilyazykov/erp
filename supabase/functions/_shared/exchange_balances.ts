// Shared by the custodial-exchange importers (import-bybit,
// import-crypto-com): an exchange account is a crypto_wallets row whose
// every log line sits in wallet_transactions (tagged with a kind), and whose
// per-coin balance -- recomputed here from all of them -- goes to
// wallet_balances, which the holdings views count under the account's name.
//
// Balance per coin = the sum of every row except the kinds the caller marks
// internal (moves between the exchange's own sub-accounts, into / out of
// Earn or staking: the coins are still owned). US-dollar stablecoins count
// as plain dollars (user's rule): what sits in Earn -- the negated sum of
// the caller's earn kinds -- goes under `savingsTicker` (a SAVINGS:<account>
// USD liquid asset), the rest keeps its own ticker (USDC, USDT, ...), which
// update-market-prices prices as 1 USD of cash. Other coins keep their own
// ticker wherever they sit.

export const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'BUSD', 'USDP']);
// Fiat left on an exchange (e.g. EUR between a sale and a purchase): kept
// with ticker null -- a bare "EUR" ticker would be looked up as a stock.
const FIAT = new Set(['EUR', 'USD', 'GBP', 'CHF', 'RUB', 'TRY', 'AUD', 'CAD', 'BRL', 'SGD']);

// "0.004800000000000000" / "1.2E-7" -> canonical decimal string, exact
// enough for amounts with at most 18 decimals.
export function dec(s: string): string {
  const t = (s || '').trim();
  if (!/e/i.test(t)) return t.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0';
  const n = Number(t);
  return n.toFixed(18).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const SCALE = 10n ** 18n;
function toBig(x: unknown): bigint {
  const amount = dec(String(x));  // also normalises any exponent form
  const [i, f = ''] = amount.replace('-', '').split('.');
  const v = BigInt(i || '0') * SCALE + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return amount.startsWith('-') ? -v : v;
}
function toStr(v: bigint): string {
  const neg = v < 0n; const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / SCALE}.${(a % SCALE).toString().padStart(18, '0')}`.replace(/\.?0+$/, '');
}

export interface ExchangeWallet { id: string; user_id: string; account: string; chain: string }
export interface BalanceRules { internalKinds: Set<string>; earnKinds: Set<string>; savingsTicker: string }

// Pure part: rows -> wallet_balances rows (and per-coin totals for reporting).
export function computeBalances(wallet: ExchangeWallet, rows: { kind: string; symbol: string; amount: unknown }[],
                                rules: BalanceRules) {
  const total = new Map<string, bigint>();
  const inEarn = new Map<string, bigint>();
  for (const r of rows) {
    if (rules.earnKinds.has(r.kind)) inEarn.set(r.symbol, (inEarn.get(r.symbol) ?? 0n) - toBig(r.amount));
    if (rules.internalKinds.has(r.kind)) continue;
    total.set(r.symbol, (total.get(r.symbol) ?? 0n) + toBig(r.amount));
  }
  const base = { wallet_id: wallet.id, user_id: wallet.user_id, account: wallet.account, chain: wallet.chain,
                 name: null, decimals: null, price_usd: null, as_of: new Date().toISOString() };
  const balances: Record<string, unknown>[] = [];
  const sums: Record<string, number> = {};
  for (const [coin, v] of total) {
    if (v === 0n) continue;
    sums[coin] = Number(toStr(v));
    if (!STABLECOINS.has(coin)) {
      balances.push({ ...base, contract: coin, symbol: coin, quantity: toStr(v), ticker: FIAT.has(coin) ? null : coin });
      continue;
    }
    const earn = inEarn.get(coin) ?? 0n;
    if (earn !== 0n) balances.push({ ...base, contract: `${coin}:earn`, symbol: `${coin} (Earn)`, name: 'Earn', quantity: toStr(earn), ticker: rules.savingsTicker });
    if (v - earn !== 0n) balances.push({ ...base, contract: coin, symbol: coin, quantity: toStr(v - earn), ticker: coin });
  }
  return { balances, sums };
}

// Recompute one account's wallet_balances from all its stored rows.
// deno-lint-ignore no-explicit-any
export async function recomputeExchange(db: any, wallet: ExchangeWallet, rules: BalanceRules) {
  const all: { kind: string; symbol: string; amount: unknown }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('wallet_transactions')
      // amount::text -- as JSON numbers, numeric values lose digits and
      // tiny ones come back in exponent form ("9e-8")
      .select('kind, symbol, amount::text').eq('wallet_id', wallet.id).range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }
  const { balances, sums } = computeBalances(wallet, all, rules);
  const { error: delErr } = await db.from('wallet_balances').delete().eq('wallet_id', wallet.id);
  if (delErr) throw new Error(delErr.message);
  if (balances.length) {
    const { error } = await db.from('wallet_balances').insert(balances);
    if (error) throw new Error(error.message);
  }
  await db.from('crypto_wallets').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', wallet.id);
  return { rows: all.length, balances: sums };
}
