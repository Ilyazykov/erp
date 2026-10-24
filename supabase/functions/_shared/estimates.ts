// Income that comes on a known schedule, worked out for the days after each
// account's latest statement until the next one is uploaded (estimated:
// "ESTIMATED" in the note / description, estimated = true where the table has
// the column). sync-estimates rebuilds all of it -- every morning and right
// after any upload -- so a statement covering those days takes them back:
//   - bonds at Sber and Alfa: coupons, amortisations and redemptions by the
//     MOEX schedule (iss.moex.com bondization) x the bonds held on the record
//     date -- trades 'estimate_bond' (the dividend / amortisation /
//     repayment + sell-at-0 shape their broker reports have) and the money on
//     the brokerage account, bank_transactions 'estimate_broker:<contract>';
//   - shares at Sber and Alfa: the dividends declared (T-Invest API
//     GetDividends -- any MOEX share, through the user's T-Bank token) x the
//     shares held the day before the record date, after tax at the ratio the
//     account's own past dividends show (13% if none), on the payment date
//     (the record date + 14 days if not set) -- trades 'estimate_dividend' and
//     the money as above. A dividend postponed or cancelled drops out of
//     T-Invest's list and so out of the next rebuild;
//   - Russian banks' deposits and savings accounts: the monthly interest
//     capitalised as a buy of the deposit -- at the rate in its name
//     ("DEPOSIT:T-Bank RUB 16% 31.10.2025"), on the month's last day, accrued
//     daily on the balance; a savings account at the rate set for it by hand
//     (savings_rates, migration ...113) or else the one its latest payments
//     imply -- every day when the bank pays daily (Ozon, Yandex), else monthly
//     on the payment's day of the month (or the one set) -- trades
//     'estimate_deposit';
//   - Telegram Wallet's daily earn rewards (GRAM): the recent average every
//     day -- wallet_transactions estimated = true.

import { recomputeExchange, type ExchangeWallet } from './exchange_balances.ts';
import { money, tinvest } from './tinvest.ts';

// The Telegram Wallet's balance rules, shared with import-telegram-wallet.
export const TELEGRAM_RULES = {
  internalKinds: new Set(['earn_internal']),
  earnKinds: new Set<string>(),
  savingsTicker: 'SAVINGS:Telegram USD',
  unknownKinds: new Set(['trade_out_unknown']),
};
export const ESTIMATE_SOURCE = { bond: 'estimate_bond', dividend: 'estimate_dividend', deposit: 'estimate_deposit', brokerCash: 'estimate_broker:' };

const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const round2 = (x: number) => Math.round(x * 100) / 100;
const yearDays = (day: string) => { const y = Number(day.slice(0, 4)); return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365; };
const monthEnd = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10);

type Trade = { account: string; ticker: string; side: string; quantity: number; price: number; trade_date: string; currency: string; note: string | null; external_id: string | null };
type Cash = { account: string; contract: string; currency: string; day: string; amount: number; desc: string };

// deno-lint-ignore no-explicit-any
async function statementEnd(db: any, userId: string, account: string, kinds: string[]): Promise<string> {
  const { data, error } = await db.from('statement_uploads').select('period_to').eq('user_id', userId).eq('account', account)
    .in('kind', kinds).order('period_to', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.period_to ?? '';
}

// The statements' own trades (not Snowball's, not these estimates).
// deno-lint-ignore no-explicit-any
async function tradesOf(db: any, userId: string, accounts: string[]): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('trades').select('account, ticker, side, quantity::text, price::text, trade_date, currency, note, external_id')
      .eq('user_id', userId).in('account', accounts)
      .or(`external_source.is.null,external_source.not.in.(snowball_csv,${ESTIMATE_SOURCE.bond},${ESTIMATE_SOURCE.dividend},${ESTIMATE_SOURCE.deposit})`)
      .order('trade_date').range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ ...r, quantity: Number(r.quantity), price: Number(r.price) });
    if (!data || data.length < 1000) return out;
  }
}
const heldOn = (rows: Trade[], day: string) =>
  rows.filter(r => r.trade_date <= day).reduce((a, r) => a + (r.side === 'buy' ? r.quantity : r.side === 'sell' ? -r.quantity : 0), 0);

// MOEX's coupons and amortisations of a bond (its secid -- the ticker here).
const moexCache = new Map<string, { coupons: Record<string, unknown>[]; amortizations: Record<string, unknown>[] }>();
async function bondization(secid: string) {
  if (moexCache.has(secid)) return moexCache.get(secid)!;
  const res = await fetch(`https://iss.moex.com/iss/securities/${encodeURIComponent(secid)}/bondization.json?iss.meta=off&iss.only=coupons,amortizations&limit=unlimited`);
  if (!res.ok) throw new Error(`MOEX bondization ${secid}: HTTP ${res.status}`);
  const j = await res.json();
  const table = (t: { columns: string[]; data: unknown[][] }) => (t?.data ?? []).map(r => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
  const out = { coupons: table(j.coupons), amortizations: table(j.amortizations) };
  moexCache.set(secid, out);
  return out;
}
// a payment due on a weekend comes on the Monday
const workday = (day: string) => { const w = new Date(`${day}T00:00:00Z`).getUTCDay(); return w === 6 ? addDays(day, 2) : w === 0 ? addDays(day, 1) : day; };
const ccyOf = (unit: unknown) => { const u = String(unit ?? 'RUB').toUpperCase(); return u === 'SUR' ? 'RUB' : u; };

const BOND_ACCOUNTS = ['Sber', 'Alfa'];
// deno-lint-ignore no-explicit-any
async function bondEstimates(db: any, userId: string, until: string) {
  const trades: Record<string, unknown>[] = [];
  const cash: Cash[] = [];
  const skipped: string[] = [];
  for (const account of BOND_ACCOUNTS) {
    const end = await statementEnd(db, userId, account, ['broker_csv', 'sber_broker']);
    if (!end || end >= until) continue;
    const rows = (await tradesOf(db, userId, [account])).filter(r => /^(RU|SU)\d/.test(r.ticker));
    for (const ticker of new Set(rows.map(r => r.ticker))) {
      const own = rows.filter(r => r.ticker === ticker);
      if (heldOn(own, until) <= 0 && heldOn(own, end) <= 0) continue;
      // the brokerage contract: the one its latest row names
      const contract = contractOf(own);
      let moex;
      try { moex = await bondization(ticker); } catch (err) { skipped.push(String(err)); continue; }
      const due = (d: unknown) => typeof d === 'string' && workday(d) > end && workday(d) <= until;
      for (const c of moex.coupons) {
        const value = Number(c.value);
        if (!due(c.coupondate) || !(value > 0)) continue;
        const day = workday(String(c.coupondate));
        const n = heldOn(own, String(c.recorddate ?? addDays(String(c.coupondate), -1)));
        if (n <= 0) continue;
        const amount = round2(n * value), currency = ccyOf(c.faceunit);
        trades.push({ account, ticker, side: 'dividend', quantity: amount, price: value, trade_date: day, currency,
          note: `ESTIMATED: ${c.name} (coupon; ${n} bonds x ${value} ${currency}, MOEX schedule), until the broker report`,
          external_id: `est:${account}:${ticker}:${day}:coupon` });
        cash.push({ account, contract, currency, day, amount, desc: `ESTIMATED: coupon ${c.name}` });
      }
      for (const a of moex.amortizations) {
        const value = Number(a.value);
        if (!due(a.amortdate) || !(value > 0)) continue;
        const day = workday(String(a.amortdate));
        const n = heldOn(own, addDays(String(a.amortdate), -1));
        if (n <= 0) continue;
        const amount = round2(n * value), currency = ccyOf(a.faceunit);
        const maturity = a.data_source === 'maturity' || Number(a.facevalue) - value <= 0.0001;
        if (maturity) {
          trades.push({ account, ticker, side: 'repayment', quantity: amount, price: amount, trade_date: day, currency,
            note: `ESTIMATED: ${a.name} (redemption; ${n} bonds x ${value} ${currency}, MOEX schedule), until the broker report`,
            external_id: `est:${account}:${ticker}:${day}:repayment` });
          trades.push({ account, ticker, side: 'sell', quantity: n, price: 0, trade_date: day, currency,
            note: `ESTIMATED: ${a.name} redeemed, until the broker report`, external_id: `est:${account}:${ticker}:${day}:redeemed` });
        } else {
          trades.push({ account, ticker, side: 'amortisation', quantity: amount, price: value, trade_date: day, currency,
            note: `ESTIMATED: ${a.name} (amortisation; ${n} bonds x ${value} ${currency}, MOEX schedule), until the broker report`,
            external_id: `est:${account}:${ticker}:${day}:amortisation` });
        }
        cash.push({ account, contract, currency, day, amount, desc: `ESTIMATED: ${maturity ? 'redemption' : 'amortisation'} ${a.name}` });
      }
    }
  }
  return { trades, cash, skipped };
}

const contractOf = (rows: Trade[]) => String([...rows].reverse().find(r => r.external_id)?.external_id ?? '').split(':')[0];

// deno-lint-ignore no-explicit-any
async function dividendEstimates(db: any, userId: string, until: string) {
  const trades: Record<string, unknown>[] = [];
  const cash: Cash[] = [];
  const skipped: string[] = [];
  const { data: creds, error } = await db.rpc('tbank_api_credentials').eq('user_id', userId);
  if (error) throw new Error(error.message);
  const token = creds?.[0]?.token;
  if (!token) return { trades, cash, skipped: ['dividends: no T-Bank token (T-Invest lists the declared ones)'] };
  for (const account of BOND_ACCOUNTS) {
    const end = await statementEnd(db, userId, account, ['broker_csv', 'sber_broker']);
    if (!end || end >= until) continue;
    const rows = (await tradesOf(db, userId, [account])).filter(r => /^[A-Z][A-Z0-9]{0,5}$/.test(r.ticker));
    const declared = new Map<string, { record: string; pay: string; per: number; currency: string }[]>();
    for (const ticker of new Set(rows.map(r => r.ticker))) {
      const own = rows.filter(r => r.ticker === ticker);
      if (heldOn(own, until) <= 0 && heldOn(own, end) <= 0) continue;
      let uid: string | undefined;
      try {
        uid = (await tinvest(token, 'InstrumentsService/ShareBy', { idType: 'INSTRUMENT_ID_TYPE_TICKER', classCode: 'TQBR', id: ticker }))?.instrument?.uid;
      } catch { continue; }   // not a share (a fund, ...): no dividends
      if (!uid) continue;
      try {
        const r = await tinvest(token, 'InstrumentsService/GetDividends',
          { instrumentId: uid, from: `${addDays(end, -400)}T00:00:00Z`, to: `${addDays(until, 30)}T00:00:00Z` });
        // deno-lint-ignore no-explicit-any
        declared.set(ticker, (r.dividends ?? []).map((d: any) => {
          const record = String(d.recordDate ?? '').slice(0, 10);
          const paid = String(d.paymentDate ?? '').slice(0, 10);
          return { record, pay: paid > '1971' ? paid : addDays(record, 14), per: money(d.dividendNet), currency: String(d.dividendNet?.currency ?? 'rub').toUpperCase() };
        }).filter((d: { record: string; per: number }) => d.record > '1971' && d.per > 0));
      } catch (err) { skipped.push(`dividends ${ticker}: ${err}`); }
    }
    // the account's own dividends against the declared ones: the share left after tax
    const actualOf = (ticker: string, d: { record: string }) => rows.find(r => r.ticker === ticker && r.side === 'dividend'
      && r.trade_date >= d.record && daysBetween(d.record, r.trade_date) <= 45);
    const ratios: number[] = [];
    for (const [ticker, list] of declared) for (const d of list) {
      const a = actualOf(ticker, d);
      if (a && a.price > 0) ratios.push(a.price / d.per);
    }
    const ratio = ratios.length ? Number(ratios.at(-1)!.toFixed(4)) : 0.87;
    for (const [ticker, list] of declared) {
      const own = rows.filter(r => r.ticker === ticker);
      for (const d of list) {
        const day = workday(d.pay);
        if (day <= end || day > until || actualOf(ticker, d)) continue;
        const n = heldOn(own, addDays(d.record, -1));
        if (n <= 0) continue;
        const per = Math.round(d.per * ratio * 10000) / 10000;
        const amount = round2(n * per);
        trades.push({ account, ticker, side: 'dividend', quantity: amount, price: per, trade_date: day, currency: d.currency,
          note: `ESTIMATED: ${ticker} dividend ${d.per} ${d.currency} a share declared (record date ${d.record}, T-Invest) x ${ratio} after tax, ${n} shares, until the broker report`,
          external_id: `est:${account}:${ticker}:${d.record}:dividend` });
        cash.push({ account, contract: contractOf(own), currency: d.currency, day, amount, desc: `ESTIMATED: dividend ${ticker}` });
      }
    }
  }
  return { trades, cash, skipped };
}

const RU_BANKS = ['T-Bank', 'Sber', 'Alfa', 'Yandex Bank', 'Ozon Bank', 'Finuslugi'];
// deno-lint-ignore no-explicit-any
async function depositEstimates(db: any, userId: string, until: string) {
  const trades: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const rows = (await tradesOf(db, userId, RU_BANKS)).filter(r => /^(DEPOSIT|SAVINGS):/.test(r.ticker));
  const { data: rates, error } = await db.from('savings_rates').select('account, ticker, valid_from, rate, pay_day, ends').eq('user_id', userId);
  if (error) throw new Error(error.message);
  for (const key of new Set(rows.map(r => `${r.account}|${r.ticker}`))) {
    const [account, ticker] = key.split('|');
    const own = rows.filter(r => r.account === account && r.ticker === ticker);
    const end = await statementEnd(db, userId, account, ['bank_csv']);
    if (!end || end >= until || heldOn(own, end) <= 0) continue;
    const interest = own.filter(r => r.side === 'buy' && /interest|процент/i.test(r.note ?? ''));
    const currency = own[0].currency;
    // the rates set by hand, each from its valid_from on; the day's rate
    // (or, without one, the rate worked out below)
    type Set = { account: string; ticker: string; valid_from: string; rate: number | null; pay_day: number | null; ends: string | null };
    const sets = ((rates ?? []) as Set[]).filter(r => r.account === account && r.ticker === ticker && r.rate != null)
      .sort((p, q) => p.valid_from.localeCompare(q.valid_from));
    const set = ((rates ?? []) as Set[]).filter(r => r.account === account && r.ticker === ticker)
      .sort((p, q) => p.valid_from.localeCompare(q.valid_from)).at(-1);
    const setRate = (d: string) => { const r = sets.filter(x => x.valid_from <= d).at(-1) ?? sets[0]; return r ? Number(r.rate) / 100 : null; };
    // daily accrual on the balance of the day before, the estimated payments included
    const accrued = (from: string, to: string, rate: number, extra: number) => {
      let s = 0;
      for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) s += (heldOn(own, addDays(d, -1)) + extra) * (setRate(d) ?? rate) / yearDays(d);
      return s;
    };
    let rate = 0, next = (d: string) => d;
    let last = interest.at(-1)?.trade_date ?? own[0].trade_date;
    const ends: string = set?.ends ?? '';
    const named = /(\d+(?:[.,]\d+)?)%/.exec(ticker);
    if (named) {
      rate = Number(named[1].replace(',', '.')) / 100;
      next = d => monthEnd(addDays(monthEnd(d), 1));
    } else {
      const recent = interest.filter(r => daysBetween(r.trade_date, end) <= 45);
      const daily = recent.length >= 3 && recent.slice(-3).every((r, i, a) => i === 0 || daysBetween(a[i - 1].trade_date, r.trade_date) === 1);
      // a daily payer whose statement goes on without its interest has stopped paying
      if (daily && !sets.length && daysBetween(recent.at(-1)!.trade_date, end) > 3) continue;
      if (sets.length) rate = setRate(until)!;
      else if (daily) {
        // each day's interest on the day before's balance; the median of the
        // last ten, as a withdrawal the same day skews one
        const r = recent.slice(-10).map(x => { const b = heldOn(own, addDays(x.trade_date, -1)); return b > 0 ? x.quantity * yearDays(x.trade_date) / b : 0; })
          .filter(x => x > 0).sort((a, b) => a - b);
        rate = r.length ? r[Math.floor(r.length / 2)] : 0;
      } else if (recent.length) {
        const q = recent.at(-1)!;
        const before = interest[interest.indexOf(q) - 1]?.trade_date ?? own[0].trade_date;
        const base = accrued(before, q.trade_date, 1, 0);
        rate = base > 0 ? q.quantity / base : 0;
      }
      if (!(rate > 0) || rate > 0.5) {
        skipped.push(`${account} ${ticker}: rate unknown -- no recent interest; set it in savings_rates`);
        continue;
      }
      const dom = Number(set?.pay_day) || (interest.length ? Number(interest.at(-1)!.trade_date.slice(8, 10)) : 31);
      next = daily && !set?.pay_day ? (d => addDays(d, 1)) : (d => {
        const m = addDays(monthEnd(d), 1);
        const e = monthEnd(m);
        return `${m.slice(0, 8)}${String(Math.min(dom, Number(e.slice(8, 10)))).padStart(2, '0')}`;
      });
      // a monthly account with no payment yet: its first comes the month after it opened
      if (!interest.length && !daily) last = addDays(own[0].trade_date, -1);
    }
    let extra = 0;
    // up to the closing day, whose interest is the last
    const step = (d: string) => { const n = next(d); return ends && n > ends ? ends : n; };
    for (let pay = step(last); pay <= until && (!ends || last < ends); last = pay, pay = step(pay)) {
      if (pay <= end) continue;
      const amount = round2(accrued(last, pay, rate, extra));
      if (!(amount > 0)) continue;
      extra += amount;
      trades.push({ account, ticker, side: 'buy', quantity: amount, price: 1, trade_date: pay, currency,
        note: `ESTIMATED: Deposit interest (${((setRate(pay) ?? rate) * 100).toFixed(2)}% a year, accrued daily since ${last}), until the bank statement`,
        external_id: `est:${account}:${ticker}:${pay}:interest` });
    }
  }
  return { trades, skipped };
}

// deno-lint-ignore no-explicit-any
async function telegramEstimates(db: any, userId: string, until: string) {
  const { data: wallets, error } = await db.from('crypto_wallets').select('id, user_id, account, chain').eq('user_id', userId).eq('chain', 'telegram');
  if (error) throw new Error(error.message);
  let rewards = 0;
  for (const wallet of (wallets ?? []) as ExchangeWallet[]) {
    const { error: del } = await db.from('wallet_transactions').delete().eq('wallet_id', wallet.id).eq('estimated', true);
    if (del) throw new Error(del.message);
    const end = await statementEnd(db, userId, wallet.account, ['telegram_wallet']);
    const { data: recent, error: rErr } = await db.from('wallet_transactions').select('tx_time, symbol, amount::text')
      .eq('wallet_id', wallet.id).eq('estimated', false).eq('kind', 'interest').gte('tx_time', `${addDays(end || until, -14)}T00:00:00Z`)
      .order('tx_time');
    if (rErr) throw new Error(rErr.message);
    const out = [];
    for (const symbol of new Set((recent ?? []).map((r: { symbol: string }) => r.symbol))) {
      const own = (recent ?? []).filter((r: { symbol: string }) => r.symbol === symbol);
      const lastDay = String(own.at(-1).tx_time).slice(0, 10);
      // still paying: daily up to the export's end
      if (own.length < 5 || (end && daysBetween(lastDay, end) > 2)) continue;
      const tail = own.slice(-7).map((r: { amount: string }) => Number(r.amount));
      const amount = Number((tail.reduce((a: number, x: number) => a + x, 0) / tail.length).toFixed(9));
      const clock = String(own.at(-1).tx_time).slice(11, 19);
      for (let d = addDays(lastDay, 1); d <= until; d = addDays(d, 1))
        out.push({ wallet_id: wallet.id, user_id: userId, chain: 'telegram', contract: '', decimals: null, counterparty: null, seq: 0,
          estimated: true, kind: 'interest', symbol, amount, tx_time: `${d}T${clock}Z`, tx_hash: `estimated:telegram:${symbol}:${d}`,
          status: `ESTIMATED: Rewarded (average of the last ${tail.length} days), until the wallet export` });
    }
    for (let i = 0; i < out.length; i += 500) {
      const { error } = await db.from('wallet_transactions').insert(out.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }
    rewards += out.length;
    await recomputeExchange(db, wallet, TELEGRAM_RULES);
  }
  return rewards;
}

// One user's estimates, rebuilt from scratch.
// deno-lint-ignore no-explicit-any
export async function rebuildEstimates(db: any, userId: string, until = addDays(new Date().toISOString().slice(0, 10), -1)) {
  const bonds = await bondEstimates(db, userId, until);
  const dividends = await dividendEstimates(db, userId, until);
  const deposits = await depositEstimates(db, userId, until);

  const { error: tDel } = await db.from('trades').delete().eq('user_id', userId).in('external_source', [ESTIMATE_SOURCE.bond, ESTIMATE_SOURCE.dividend, ESTIMATE_SOURCE.deposit]);
  if (tDel) throw new Error(tDel.message);
  const { error: cDel } = await db.from('bank_transactions').delete().eq('user_id', userId).like('external_source', `${ESTIMATE_SOURCE.brokerCash}%`);
  if (cDel) throw new Error(cDel.message);

  const trades = [
    ...bonds.trades.map(t => ({ ...t, external_source: ESTIMATE_SOURCE.bond })),
    ...dividends.trades.map(t => ({ ...t, external_source: ESTIMATE_SOURCE.dividend })),
    ...deposits.trades.map(t => ({ ...t, external_source: ESTIMATE_SOURCE.deposit })),
  ].map(t => ({ user_id: userId, fee_tax: null, fee_currency: null, nkd: null, exchange: null, estimated: true, ...t }));
  for (let i = 0; i < trades.length; i += 500) {
    const { error } = await db.from('trades').insert(trades.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }

  // the coupons' / dividends' money on each brokerage account, a running balance per currency from 0
  const bal: Record<string, number> = {};
  const cash = [...bonds.cash, ...dividends.cash].sort((p, q) => p.day.localeCompare(q.day)).map((c, i) => {
    const src = `${ESTIMATE_SOURCE.brokerCash}${c.contract}`;
    const k = `${src}|${c.currency}`;
    bal[k] = round2((bal[k] ?? 0) + c.amount);
    const at = new Date(Date.parse(`${c.day}T12:00:00Z`) + i).toISOString();
    return { user_id: userId, account: c.account, tx_date: at, booked_at: at, description: c.desc, counterparty: null,
      amount: c.amount, currency: c.currency, category: null, balance_after: bal[k], synthetic: false, synthetic_kind: null,
      product: 'brokerage_cash', note: 'ESTIMATED: by the MOEX schedule / the declared dividend, until the broker report',
      external_source: src, external_id: `est:${c.day}:${c.currency}:${c.amount}:${c.desc}` };
  });
  if (cash.length) {
    const { error } = await db.from('bank_transactions').insert(cash);
    if (error) throw new Error(error.message);
  }

  const telegram = await telegramEstimates(db, userId, until);
  return {
    until, bond_payments: bonds.cash.length, dividends: dividends.cash.length, deposit_interest: deposits.trades.length, telegram_rewards: telegram,
    ...(bonds.skipped.length || dividends.skipped.length || deposits.skipped.length
      ? { skipped: [...bonds.skipped, ...dividends.skipped, ...deposits.skipped] } : {}),
  };
}
