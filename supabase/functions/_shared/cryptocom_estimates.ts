// Project Crypto.com App rewards after its last CSV export.  The App has no
// read-only API, therefore these are deliberately short-lived stand-ins:
// every run removes them and rebuilds them from actual history; importing a
// newer CSV consequently replaces, rather than duplicates, the projection.

const DAY = 86_400_000;
const dayOf = (time: string) => time.slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const atUtc = (day: string, clock: string) => `${day}T${clock}Z`;
const today = () => new Date().toISOString().slice(0, 10);
const abs = (x: unknown) => Math.abs(Number(x));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0;
const round18 = (x: number) => Number(x.toFixed(18));

type Row = { tx_hash: string; kind: string; tx_time: string; symbol: string; amount: string; status: string | null };
type Wallet = { id: string; user_id: string; account: string; chain: string };

async function allRows(db: any, walletId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('wallet_transactions')
      .select('tx_hash, kind, tx_time, symbol, amount::text, status')
      .eq('wallet_id', walletId).eq('estimated', false).order('tx_time').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data ?? []);
    if (!data || data.length < 1000) return out;
  }
}

// The balance rules of the Crypto.com wallet, shared by import-crypto-com and
// sync-crypto-com-estimates.
export const CRYPTOCOM_RULES = {
  internalKinds: new Set(['earn_internal', 'staking_internal']),
  earnKinds: new Set(['earn_internal']),
  savingsTicker: 'SAVINGS:Crypto.com USD',
};

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// Each BTC allocation is a separate 90-day Earn term. It pays weekly on its
// opening weekday (opened + 7, + 14, ...) the same amount, and on its last
// day, with the withdrawal, 6/7 of it; the next day it's renewed -- 91 days,
// so the renewed term keeps the weekday. Several terms overlap, each with its
// own stream. The open ones: allocations no withdrawal of the same amount
// has closed.
function btcRows(actual: Row[], through: string) {
  const rewards = actual.filter(r => r.symbol === 'BTC' && r.kind === 'interest' && /crypto_earn_interest_paid/i.test(r.status ?? ''));
  const moves = actual.filter(r => r.symbol === 'BTC' && r.kind === 'earn_internal');
  const closed = moves.filter(r => Number(r.amount) > 0).map(r => abs(r.amount));
  const open = moves.filter(r => Number(r.amount) < 0).filter(r => {
    const i = closed.findIndex(x => Math.abs(x - abs(r.amount)) < 1e-12);
    if (i < 0) return true;
    closed.splice(i, 1);
    return false;
  });
  const out: any[] = [];
  for (const allocation of open) {
    const opened = dayOf(allocation.tx_time);
    let ends = addDays(opened, 90);
    const stream = rewards.filter(r => { const n = daysBetween(opened, dayOf(r.tx_time)); return n > 0 && n < 90 && n % 7 === 0; });
    if (!stream.length) continue;
    // the latest payments are the current rate; a one-off rounding evens out
    const payout = round18(mean(stream.slice(-4).map(r => abs(r.amount))));
    let started = opened, principal = abs(allocation.amount), d = addDays(dayOf(stream.at(-1)!.tx_time), 7);
    // keep rolling terms, so an old export never stops the capital line
    while (started <= through) {
      for (; d < ends && d <= through; d = addDays(d, 7))
        out.push({ symbol: 'BTC', amount: payout, tx_time: atUtc(d, '00:15:00'), kind: 'interest',
          status: `ESTIMATED: Crypto Earn weekly reward; 90-day term opened ${started}, until CSV export` });
      if (ends > through) break;
      out.push({ symbol: 'BTC', amount: round18(payout * 6 / 7), tx_time: atUtc(ends, '00:15:00'), kind: 'interest',
        status: `ESTIMATED: Crypto Earn last reward of term opened ${started}, until CSV export` });
      out.push({ symbol: 'BTC', amount: principal, tx_time: atUtc(ends, '12:00:00'), kind: 'earn_internal',
        status: `ESTIMATED: Crypto Earn Withdrawal of term opened ${started}, until CSV export` });
      started = addDays(ends, 1);
      out.push({ symbol: 'BTC', amount: -principal, tx_time: atUtc(started, '12:00:00'), kind: 'earn_internal',
        status: `ESTIMATED: Crypto Earn Allocation renewed from term opened ${opened}, until CSV export` });
      ends = addDays(started, 90);
      d = addDays(started, 7);
    }
  }
  return out;
}

// DPoS rewards have no term: they come on fixed weekdays (Mon / Wed / Fri,
// Monday's covering the weekend). Continue each weekday of the last four
// weeks with the average of its last three, never inventing a reward when
// the export has too little evidence.
function dposRows(actual: Row[], through: string) {
  const out: any[] = [];
  for (const symbol of ['TAO', 'CRO']) {
    const rewards = actual.filter(r => r.symbol === symbol && r.kind === 'interest' && /finance\.dpos\.(?:compound|non_compound)_interest/i.test(r.status ?? ''));
    if (rewards.length < 3) continue;
    const lastDay = dayOf(rewards.at(-1)!.tx_time);
    const recent = rewards.filter(r => dayOf(r.tx_time) > addDays(lastDay, -28));
    const byWeekday = new Map<number, number>();
    for (const wd of new Set(recent.map(r => weekday(dayOf(r.tx_time)))))
      byWeekday.set(wd, round18(mean(recent.filter(r => weekday(dayOf(r.tx_time)) === wd).slice(-3).map(r => abs(r.amount)))));
    for (let d = addDays(lastDay, 1); d <= through; d = addDays(d, 1)) {
      const amount = byWeekday.get(weekday(d));
      if (amount) out.push({ symbol, amount, tx_time: atUtc(d, symbol === 'TAO' ? '05:30:00' : '03:00:00'), kind: 'interest',
        status: `ESTIMATED: Crypto.com DPoS ${symbol} reward, until CSV export` });
    }
  }
  return out;
}

export async function rebuildCryptoComEstimates(db: any, wallet: Wallet, until = addDays(today(), -1)) {
  const { error: del } = await db.from('wallet_transactions').delete().eq('wallet_id', wallet.id).eq('estimated', true);
  if (del) throw new Error(del.message);
  const actual = await allRows(db, wallet.id);
  const estimate = [...btcRows(actual, until), ...dposRows(actual, until)];
  // keyed by content, not position: the same row keeps its key from run to run
  // (estimate_archive, migration ...114)
  const seen = new Map<string, number>();
  const rows = estimate.map(r => {
    const key = `estimated:cryptocom:${r.symbol}:${r.kind}:${r.tx_time}:${r.amount}`;
    const n = seen.get(key) ?? 0; seen.set(key, n + 1);
    return { wallet_id: wallet.id, user_id: wallet.user_id, chain: 'cryptocom', contract: '', decimals: null, counterparty: null,
      tx_hash: n ? `${key}:${n}` : key, seq: 0, estimated: true, ...r };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('wallet_transactions').insert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  return { estimated_rewards: rows.filter(r => r.kind === 'interest').length, estimated_rollovers: rows.filter(r => r.kind === 'earn_internal').length };
}
