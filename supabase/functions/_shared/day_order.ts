// Order of rows that share a timestamp in a statement -- same-day rows of a
// date-only statement (Bank of Cyprus, Raiffeisen, Ziraat), or Revolut rows
// completed in the same second. The latest balance of an account is the
// balance_after of its last row, so ties must be broken in the order the
// bank applied them, not arbitrarily (Ziraat's 16.09.2026 has three rows;
// picking the wrong one showed 2049.41 TRY instead of 600.16).
//
// The running balance says the order: a row's balance before it
// (balance_after - amount) is the previous row's balance_after. Rows are
// chained that way within each group; if the chain doesn't cover the group
// (missing balances, amounts that don't add up), the group falls back to the
// file's own order -- reversed when the file lists newest first.
//
// Returns each row's position within its group, 0 = earliest.

const cents = (x: number) => Math.round(x * 100);

export function orderWithinGroups<T>(
  rows: T[],
  groupKey: (r: T) => string,
  amount: (r: T) => number,
  balance: (r: T) => number | null,
  fileNewestFirst: boolean,
): number[] {
  const seq = new Array<number>(rows.length).fill(0);
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = groupKey(r);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });

  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const chained = chain(idx, i => amount(rows[i]), i => balance(rows[i]));
    const ordered = chained ?? (fileNewestFirst ? [...idx].reverse() : idx);
    ordered.forEach((i, pos) => { seq[i] = pos; });
  }
  return seq;
}

function chain(idx: number[], amount: (i: number) => number, balance: (i: number) => number | null): number[] | null {
  if (idx.some(i => balance(i) === null)) return null;
  const after = new Map(idx.map(i => [i, cents(balance(i)!)]));
  const before = new Map(idx.map(i => [i, cents(balance(i)! - amount(i))]));
  const afters = [...after.values()];
  // The first row's "before" is no other row's "after".
  const starts = idx.filter(i => !afters.some((a, j) => idx[j] !== i && a === before.get(i)));
  if (starts.length !== 1) return null;
  const order = [starts[0]];
  const used = new Set(order);
  while (order.length < idx.length) {
    const prevAfter = after.get(order[order.length - 1]);
    const next = idx.find(i => !used.has(i) && before.get(i) === prevAfter);
    if (next === undefined) return null;
    order.push(next);
    used.add(next);
  }
  return order;
}

// Position within a day -> a clock for a date-only row: "00:00:05",
// "00:01:07" (a minute holds 60 rows, an hour 3600).
export function clockFor(pos: number): string {
  const p = Math.min(pos, 86399);
  const hh = String(Math.floor(p / 3600)).padStart(2, '0');
  const mm = String(Math.floor((p % 3600) / 60)).padStart(2, '0');
  const ss = String(p % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
