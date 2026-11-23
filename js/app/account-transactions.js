// The transactions feed to the right of an account's chart (mpOpenAccountChart):
// newest first, ten at a time as it's scrolled, all of them or one chart layer's.
// A purchase shows twice on purpose: its money (bank_transactions) and its paper (trades).
// A deal shows quantity @ price, not a sum: bond prices are stored in % of face or in
// currency depending on the import. Synthetic bank rows (estimates, snapshots) are left out.
const MP_TX_STEP = 10, MP_TX_FETCH = 30;
const MP_TX_PAYOUTS = new Set(['dividend', 'amortisation']);   // their `quantity` is the money paid

// What a chart layer holds, for the queries. (byDay.codes / .tickers: mpAccountByLabel)
function mpTxLayerFilter(layer) {
  const codes = [...(layer.byDay.codes || [])], tickers = [...(layer.byDay.tickers || [])];
  const fiat = mpIsFiatLabel(layer.label) || layer.label === 'other';
  return { label: layer.label, fiat, codes, tickers, any: [...new Set([...codes, ...tickers])] };
}

// One source's next rows: [{day, at, ...}], from `offset`.
function mpTxSources(account, filter, wallets) {
  const all = account === MP_ALL_ACCOUNTS;
  const scoped = q => (all ? q : q.eq('account', account));
  const plain = s => String(s || '').replace(/^ESTIMATED:\s*/, '');
  const page = async (q, offset) => {
    const { data, error } = await q.range(offset, offset + MP_TX_FETCH - 1);
    if (error) throw new Error(error.message);
    return data;
  };
  const money = async offset => {
    let q = scoped(sb.from('bank_transactions').select('id, account, tx_date, description, counterparty, amount, currency, amount_approximate, expense_category, income_category, balance_after, product, external_source'))
      .or('synthetic.is.null,synthetic.eq.false');
    if (filter) q = q.in('currency', filter.any);
    return (await page(q.order('tx_date', { ascending: false }).order('id'), offset)).map(r => ({
      day: r.tx_date.slice(0, 10), at: r.tx_date, account: r.account, text: plain(r.description) || r.counterparty || '', type: '',
      amount: Number(r.amount), unit: r.currency, approx: !!r.amount_approximate || /^ESTIMATED:/.test(r.description || ''),
      balance: r.balance_after == null ? null : Number(r.balance_after), chain: `${r.account}|${r.currency}|${r.product || ''}|${r.external_source}`,
      category: r.income_category || r.expense_category || '', meta: r.income_category ? mpIncomeMeta(r.income_category) : mpExpMeta(r.expense_category) }));
  };
  const deals = async offset => {
    let q = scoped(sb.from('trades').select('id, account, trade_date, side, ticker, quantity, price, currency, note, estimated'));
    if (filter) q = filter.fiat ? q.in('currency', filter.codes) : q.in('ticker', filter.tickers);
    return (await page(q.order('trade_date', { ascending: false }).order('id'), offset)).map(r => {
      const payout = MP_TX_PAYOUTS.has(r.side);
      return { day: r.trade_date, at: r.trade_date, account: r.account, text: MP_SHORT_NAMES[r.ticker] || r.ticker, type: r.side.replace(/_/g, ' '), side: r.side, bond: /^RU[A-Z0-9]{10}$/.test(r.ticker),
        amount: payout ? Number(r.quantity) : null, qty: payout ? null : Number(r.quantity), price: payout ? null : Number(r.price), unit: r.currency, approx: !!r.estimated };
    });
  };
  const crypto = async offset => {
    let q = sb.from('wallet_transactions').select('wallet_id, tx_hash, seq, kind, tx_time, symbol, amount, status, estimated').in('wallet_id', [...wallets.keys()]);
    if (filter) q = q.in('symbol', filter.any);
    return (await page(q.order('tx_time', { ascending: false }).order('tx_hash').order('seq').order('kind'), offset)).map(r => ({
      day: r.tx_time.slice(0, 10), at: r.tx_time, account: wallets.get(r.wallet_id), text: ['ok', 'confirmed'].includes(r.status) ? r.symbol : r.status || r.symbol, type: r.kind.replace(/_/g, ' '),
      amount: Number(r.amount), unit: r.symbol, approx: !!r.estimated, coin: true }));
  };
  return [money, deals, ...(wallets.size ? [crypto] : [])].map(load => ({ load, buf: [], offset: 0, done: false }));
}

// One balance chain's rows of a day, earliest first: rows of the same moment in the order their balances
// follow, then an income pulled ahead of a spending the balance couldn't have covered without it.
function mpTxChainOrder(rows) {
  const cents = v => Math.round(v * 100);
  if (rows.some(r => r.balance == null)) return rows;
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].at === rows[i].at) j++;
    let block = rows.slice(i, j);
    if (block.length > 1) {
      const afters = new Set(block.map(r => cents(r.balance)));
      const starts = block.filter(r => !afters.has(cents(r.balance - r.amount)));
      if (starts.length === 1) {
        const walk = [starts[0]], left = new Set(block);
        left.delete(starts[0]);
        while (left.size) {
          const next = [...left].find(r => cents(r.balance - r.amount) === cents(walk[walk.length - 1].balance));
          if (!next) break;
          walk.push(next);
          left.delete(next);
        }
        if (!left.size) block = walk;
      }
    }
    out.push(...block);
    i = j;
  }
  let balance = out[0].balance - out[0].amount;
  if (balance < -0.005) return out;   // already in debt that morning: an overdraft, not an order to fix
  const rest = [...out], done = [];
  while (rest.length) {
    const income = balance + rest[0].amount < -0.005 ? rest.findIndex(r => r.amount > 0) : 0;
    const [r] = rest.splice(Math.max(income, 0), 1);
    balance += r.amount;
    done.push(r);
  }
  return done;
}

// A day's rows, newest first. A deal stands next to its money (same account, currency and sum):
// the sale before the money it brought, the purchase after the money it took.
function mpTxArrangeDay(rows) {
  const isDeal = r => r.side != null;
  const line = rows.filter(r => !isDeal(r)).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const chains = new Map();
  line.forEach((r, i) => { if (r.chain) chains.set(r.chain, [...(chains.get(r.chain) || []), i]); });
  for (const places of chains.values()) {
    const ordered = mpTxChainOrder(places.map(i => line[i]));
    places.forEach((i, k) => { line[i] = ordered[k]; });
  }
  const before = new Map(), after = new Map(), alone = [];
  const taken = new Set();
  for (const d of rows.filter(isDeal)) {
    const sum = d.amount != null ? Math.abs(d.amount) : Math.abs(d.qty * d.price);
    const wantIn = d.side === 'buy' ? false : d.amount != null ? d.amount > 0 : true;
    const money = line.find(r => !taken.has(r) && r.chain && r.account === d.account && r.unit === d.unit
      && r.amount > 0 === wantIn && Math.abs(Math.abs(r.amount) - sum) < 0.01);
    if (!money) { alone.push(d); continue; }
    taken.add(money);
    const side = d.side === 'buy' ? after : before;
    side.set(money, [...(side.get(money) || []), d]);
  }
  const chrono = [...alone];
  for (const r of line) chrono.push(...(before.get(r) || []), r, ...(after.get(r) || []));
  return chrono.reverse();
}

// One unit of a row's currency in dollars on its day (null: no rate known).
function mpTxUnitUsd(r) {
  const code = String(r.unit || '').toUpperCase();
  if (code === 'USD' || MP_USD_STABLES.has(code)) return 1;
  return mpUnitPriceOn(code, !r.coin && code !== 'XAU', mpDayNumber(r.day));
}
async function mpTxEnsureRates(rows, display) {
  if (!display) return;
  const seen = new Map();
  for (const r of rows) {
    const code = String(r.unit || '').toUpperCase();
    if (code && code !== 'USD' && !MP_USD_STABLES.has(code)) seen.set(code, { code, fiat: !r.coin && code !== 'XAU' });
  }
  await mpLoadUnitCodes([...seen.values()]).catch(() => {});
}
// A row's value in the chart's currency, or null: it's in that currency already, or there's no rate.
function mpTxConverted(v, r, display) {
  if (!display || String(r.unit || '').toUpperCase() === display.code) return null;
  const rate = mpTxUnitUsd(r);
  return rate ? display.conv(r.day, v * rate) : null;
}
function mpTxInDisplay(v, code) {
  const a = Math.abs(v), n = a.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 4 : 2 });
  return code === 'USD' ? `$${n}` : code === 'RUB' ? `${n} ₽` : `${n} ${code}`;
}

// The next rows over all sources, newest first: at least `n`, up to the end of a day (its order needs all of it).
async function mpTxNext(sources, n) {
  const out = [];
  for (;;) {
    await Promise.all(sources.filter(s => !s.buf.length && !s.done).map(async s => {
      const rows = await s.load(s.offset);
      s.offset += rows.length;
      s.buf.push(...rows);
      if (rows.length < MP_TX_FETCH) s.done = true;
    }));
    const ready = sources.filter(s => s.buf.length);
    if (!ready.length) break;
    const newest = ready.reduce((a, b) => (b.buf[0].day > a.buf[0].day || (b.buf[0].day === a.buf[0].day && b.buf[0].at > a.buf[0].at) ? b : a));
    if (out.length >= n && newest.buf[0].day !== out[out.length - 1].day) break;
    out.push(newest.buf.shift());
  }
  const days = new Map();
  for (const r of out) days.set(r.day, [...(days.get(r.day) || []), r]);
  return [...days.values()].flatMap(mpTxArrangeDay);
}

function mpTxRowHtml(r, withAccount, display) {
  const number = (v, digits) => Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: digits });
  const own = (v, digits) => `${number(v, digits)} ${mpEscapeHtml(r.unit || '')}`;
  // converted: the operation's own amount on hover. A bond's price can be % of face: left as it is
  const shown = (v, digits) => {
    const c = r.bond ? null : mpTxConverted(v, r, display);
    return c == null ? own(v, digits) : `<span title="${own(v, digits)}">${mpTxInDisplay(c, display.code)}</span>`;
  };
  const right = r.amount != null
    ? `<span class="${r.amount < 0 ? 'neg' : 'pos'}">${r.approx ? '≈ ' : ''}${r.amount < 0 ? '−' : '+'}${shown(r.amount, r.coin ? 8 : 2)}</span>`
    : `<span>${r.approx ? '≈ ' : ''}${r.qty < 0 ? '−' : ''}${number(r.qty, 8)}${r.price ? ` @ ${shown(r.price, 4)}` : ''}</span>`;
  const sub = [r.type, withAccount ? MP_BROKER_SHORT_NAMES[r.account] || r.account : ''].filter(Boolean).join(' · ');
  // (a deal or a coin move has no spending category: the grey mark, to keep the column)
  return `<div class="mp-tx-row${r.approx ? ' approx' : ''}"><span title="${mpEscapeHtml(r.category || '')}">${mpExpDot(r.meta || mpExpMeta())}</span><div class="mp-tx-body"><div class="mp-tx-main"><span class="mp-tx-name" title="${mpEscapeHtml(r.text)}">${mpEscapeHtml(r.text)}</span>${right}</div>${sub ? `<div class="mp-tx-sub">${mpEscapeHtml(sub)}</div>` : ''}</div></div>`;
}

// Puts the feed beside `plot`. display: {code, conv(day, usd)} to show amounts in, null: each in its own currency.
// Returns { toggle(layer) }: show only that chart layer, or all again; { setDisplay(display) }.
function mpAccountTxFeed(dlg, plot, account, startDisplay = null) {
  const body = document.createElement('div');
  body.className = 'mp-account-body';
  plot.before(body);
  body.appendChild(plot);
  const feed = document.createElement('div');
  feed.className = 'mp-tx-feed';
  feed.innerHTML = '<div class="mp-tx-head"><b>Transactions</b><span data-tx-filter></span></div><div class="mp-tx-list" data-tx-list></div>';
  body.appendChild(feed);
  const list = feed.querySelector('[data-tx-list]'), chip = feed.querySelector('[data-tx-filter]');
  const end = document.createElement('p');
  end.className = 'note mp-tx-end';
  let filter = null, sources = null, wallets = null, busy = false, finished = false, lastDay = null, ticket = 0;
  let display = startDisplay, shownRows = [];
  const rowsHtml = rows => {
    let html = '';
    for (const r of rows) {
      if (r.day !== lastDay) {
        lastDay = r.day;
        html += `<div class="mp-tx-day">${new Date(`${r.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</div>`;
      }
      html += mpTxRowHtml(r, account === MP_ALL_ACCOUNTS, display);
    }
    return html;
  };

  const more = async () => {
    if (busy || finished) return;
    busy = true;
    const mine = ticket;
    end.textContent = 'Loading…';
    try {
      if (!wallets) {
        let q = sb.from('crypto_wallets').select('id, account');
        if (account !== MP_ALL_ACCOUNTS) q = q.eq('account', account);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        wallets = new Map(data.map(w => [w.id, w.account]));
      }
      sources ||= mpTxSources(account, filter, wallets);
      const rows = await mpTxNext(sources, MP_TX_STEP);
      for (let asked; asked !== display;) { asked = display; await mpTxEnsureRates(rows, asked); }
      if (mine !== ticket) return;
      shownRows.push(...rows);
      end.insertAdjacentHTML('beforebegin', rowsHtml(rows));
      finished = rows.length < MP_TX_STEP;
      end.textContent = !finished ? '' : list.querySelector('.mp-tx-row') ? 'That is all.' : 'No transactions.';
    } catch (error) {
      if (mine === ticket) end.textContent = error.message;
    } finally {
      if (mine === ticket) {
        busy = false;
        // the portion didn't fill the column (a tall window): the next one, with no scroll to trigger it
        if (!end.textContent) nearEnd();
      }
    }
  };
  const nearEnd = () => { if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) more(); };
  list.addEventListener('scroll', nearEnd, { passive: true });
  const restart = () => {
    ticket++;
    sources = null; busy = false; finished = false; lastDay = null; shownRows = [];
    list.replaceChildren(end);
    list.scrollTop = 0;
    end.textContent = '';
    chip.innerHTML = filter ? `<button class="btn" type="button" title="Show all">${mpEscapeHtml(filter.label)} ✕</button>` : '<span class="muted">click a colour to filter</span>';
    const clear = chip.querySelector('button');
    if (clear) clear.onclick = () => { filter = null; restart(); };
    more();
  };
  dlg.addEventListener('close', () => { ticket++; });
  restart();
  return {
    toggle(layer) {
      filter = filter?.label === layer.label ? null : mpTxLayerFilter(layer);
      restart();
    },
    async setDisplay(next) {
      const same = (next?.code ?? null) === (display?.code ?? null);
      display = next;
      if (same) return;
      const mine = ticket;
      await mpTxEnsureRates(shownRows, next);
      if (mine !== ticket || display !== next) return;
      const top = list.scrollTop;
      lastDay = null;
      list.replaceChildren(end);
      end.insertAdjacentHTML('beforebegin', rowsHtml(shownRows));
      list.scrollTop = top;
    },
  };
}
