// Freedom24's (Tradernet) cash movements -> this project's rows, shared by
// import-freedom24-statement (the cash-movement report, .xlsx) and
// sync-freedom24 (the same table through the API, getUserCashFlows): one row
// per operation, with the broker's own id. See import-freedom24-statement
// for what is written.

export const ACCOUNT = 'Freedom24';
// The xlsx's source for the API's rows too: the same operations under the
// same ids, so an upload and a sync never double.
export const SOURCE = 'freedom24_xlsx';
export const EXCHANGE_BY_MARKET: Record<string, string> = { EU: 'XETRA' };

export const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;

// One operation: Операция № / id, the time (ISO, the broker's clock kept as
// is), Операция / type_code_name (+ the API's type_code), Комментарий, Сумма,
// Валюта.
export interface CashRow { id: string; time: string; op: string; code?: string; comment: string; amount: number; currency: string }

// Rows, oldest first -> bank rows (a running balance per currency from zero:
// the rows must cover the account from its opening), trades, dividends.
export function buildFromCashRows(rows: CashRow[]) {
  const isCommission = (r: CashRow) => /Комиссия|commission/i.test(`${r.op} ${r.code ?? ''}`);
  const commission = new Map<string, number>();   // trade id -> EUR commission
  for (const r of rows) {
    const id = isCommission(r) ? r.comment.match(/\(Trade (\d+) /)?.[1] : undefined;
    if (id) commission.set(id, (commission.get(id) ?? 0) + Math.abs(r.amount));
  }

  const balance: Record<string, number> = {};
  const seenTime = new Map<string, number>();
  const bank = rows.map(r => {
    balance[r.currency] = round((balance[r.currency] ?? 0) + r.amount);
    const n = seenTime.get(r.time) ?? 0; seenTime.set(r.time, n + 1);
    return {
      tx_date: new Date(Date.parse(r.time) + n).toISOString(), currency: r.currency, amount: r.amount,
      description: `${r.op}: ${r.comment}`.slice(0, 500), balance_after: balance[r.currency], external_id: r.id,
    };
  });

  const trades = [];
  for (const r of rows) {
    const date = r.time.slice(0, 10);
    // "Купить 4 VWCE.EU (сделка №656470312)" -- or the English "Buy ... (trade #...)"
    const t = r.comment.match(/(Купить|Продать|Buy|Sell) ([\d.]+) ([A-Z0-9.\-]+?)\.([A-Z]+) \((?:сделка|trade) [№#]?(\d+)\)/i);
    if (t && !isCommission(r)) {
      const qty = Number(t[2]);
      trades.push({
        ticker: t[3], side: /Купить|Buy/i.test(t[1]) ? 'buy' : 'sell', quantity: qty, price: round(Math.abs(r.amount) / qty, 6),
        trade_date: date, currency: r.currency, fee_tax: commission.get(t[5]) ?? null, fee_currency: 'EUR',
        exchange: EXCHANGE_BY_MARKET[t[4]] ?? null, note: r.comment, external_id: `trade:${t[5]}`,
      });
    }
    const isDividend = r.op === 'Дивиденды' || /^dividend/i.test(r.code ?? '') || /^Dividends on security/.test(r.comment);
    const d = isDividend ? r.comment.match(/\(([A-Z0-9.\-]+?)\.[A-Z]+\)\)/) : null;
    if (d) {
      const per = r.comment.match(/Per security ([\d.]+)/)?.[1];
      trades.push({
        ticker: d[1], side: 'dividend', quantity: r.amount, price: per ? Number(per) : r.amount,
        trade_date: date, currency: r.currency, fee_tax: null, fee_currency: null,
        exchange: null, note: r.comment, external_id: `dividend:${r.id}`,
      });
    }
  }
  return { bank, trades, balance };
}
