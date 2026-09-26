// A broker's own statement has priority over Snowball's hand-entered rows of
// the same operations (import-ibkr-statement, import-freedom24-statement
// delete the Snowball rows they cover; import-trades-csv leaves them out of
// later uploads). Which Snowball rows are "the same operation":
//   - same side and ticker;
//   - dates at most a day apart (Snowball's date is the user's own; a
//     statement dates an evening US trade or a dividend by its own clock --
//     Freedom24's MU sale 2026-05-26 23:38 is 2026-05-27 in Snowball); for
//     shares credited without money (stock_as_dividend: gifts, bonuses) up
//     to three days -- Freedom24's welcome SNAP of 2026-05-04 is 2026-05-06
//     in Snowball;
//   - same total quantity on that date, summed per side -- a statement may
//     split what Snowball has as one row (Freedom24's VWCE 12 + 1 on
//     2026-05-26 is one Snowball buy of 13). Dividends match on ticker and
//     date alone: statements round the amount (0.25 vs Snowball's 0.248).
// Anything else -- the same ticker bought elsewhere (VWCE at Revolut), gift
// shares the statement has no trade for -- is left alone.

export interface Operation { side: string; ticker: string; trade_date: string; quantity: number }

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const groupKey = (o: Operation) => `${o.side}|${o.ticker.toUpperCase()}|${o.trade_date}`;

function groups<T extends Operation>(ops: T[]) {
  const g = new Map<string, { side: string; ticker: string; date: string; quantity: number; items: T[] }>();
  for (const o of ops) {
    const k = groupKey(o);
    const cur = g.get(k) ?? { side: o.side, ticker: o.ticker.toUpperCase(), date: o.trade_date, quantity: 0, items: [] };
    cur.quantity += Number(o.quantity);
    cur.items.push(o);
    g.set(k, cur);
  }
  return [...g.values()];
}

// The Snowball rows (of `snowball`) that `statement` covers.
export function coveredBySnowball<T extends Operation>(statement: Operation[], snowball: T[]): Set<T> {
  const covered = new Set<T>();
  const st = groups(statement);
  const used = new Set<number>();
  for (const s of groups(snowball)) {
    const i = st.findIndex((g, j) => !used.has(j) && g.side === s.side && g.ticker === s.ticker
      && Math.abs(day(g.date) - day(s.date)) <= (s.side === 'stock_as_dividend' ? 3 : 1)
      && (s.side === 'dividend' || Math.abs(g.quantity - s.quantity) < 1e-6));
    if (i < 0) continue;
    used.add(i);
    for (const it of s.items) covered.add(it);
  }
  return covered;
}

// Statement importers: delete the Snowball rows the just-written statement
// operations cover. Returns how many were removed.
// deno-lint-ignore no-explicit-any
export async function removeCoveredSnowball(db: any, userId: string, statement: Operation[]): Promise<number> {
  const tickers = [...new Set(statement.map(o => o.ticker))];
  if (!tickers.length) return 0;
  const { data, error } = await db.from('trades').select('id, side, ticker, trade_date, quantity')
    .eq('user_id', userId).eq('external_source', 'snowball_csv').in('ticker', tickers);
  if (error) throw new Error(error.message);
  const ids = [...coveredBySnowball(statement, (data ?? []) as (Operation & { id: string })[])].map(r => r.id);
  if (!ids.length) return 0;
  const { error: delErr } = await db.from('trades').delete().in('id', ids);
  if (delErr) throw new Error(delErr.message);
  return ids.length;
}
