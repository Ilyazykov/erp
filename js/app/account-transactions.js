// The transactions feed to the right of an account's chart (mpOpenAccountChart):
// newest first, ten at a time as it's scrolled, all of them or one chart layer's.
// A purchase shows twice on purpose: its money (bank_transactions) and its paper (trades).
// A deal shows quantity @ price, not a sum: bond prices are stored in % of face or in
// currency depending on the import. Synthetic bank rows (estimates, snapshots) are left out.
const MP_TX_STEP = 10, MP_TX_FETCH = 30;
const MP_TX_PAYOUTS = new Set(['dividend', 'amortisation']);   // their `quantity` is the money paid

// The feed's account types. Each operation is of exactly one: the bank rows by product and source, the deals
// by what was traded, the wallets' moves are crypto. An IIS is known by its contract.
const MP_TX_KINDS = [['current', 'Current account'], ['savings', 'Savings account'], ['deposit', 'Deposit'], ['credit', 'Credit card'],
  ['broker', 'Brokerage'], ['iis', 'IIS'], ['crypto', 'Crypto'], ['gold', 'Gold'], ['cash', 'Cash']];
const MP_TX_IIS = ['S23188F'];
const MP_TX_BROKER_SOURCES = ['tbank_broker_xlsx', 'sber_broker_html', 'tbank_api', 'atomyze_xlsx', 'ibkr_csv', 'freedom24_xlsx', 'revolut_invest_csv', 'openbanking_revolut_invest'];
const MP_TX_FUND_SOURCES = '(revolut_fund_csv,openbanking_revolut_fund)';
const mpTxIisSources = () => `(${MP_TX_IIS.map(c => `"sber_broker_html:${c}"`).join(',')})`;
const MP_TX_MONEY_KINDS = {
  current: q => MP_TX_BROKER_SOURCES.reduce((x, s) => x.not('external_source', 'like', `${s}%`), q)
    .or('product.is.null,product.not.in.(credit_card,cash,brokerage_cash)').neq('currency', 'XAU'),
  credit: q => q.eq('product', 'credit_card'),
  cash: q => q.eq('product', 'cash'),
  gold: q => q.eq('currency', 'XAU'),
  iis: q => q.in('external_source', MP_TX_IIS.map(c => `sber_broker_html:${c}`)),
  broker: q => q.or(`${MP_TX_BROKER_SOURCES.map(s => `external_source.like.${s}*`).join(',')},product.eq.brokerage_cash`)
    .not('external_source', 'in', mpTxIisSources()).neq('currency', 'XAU'),
};
const mpTxNotIis = q => MP_TX_IIS.reduce((x, c) => x.not('external_id', 'like', `${c}:%`), q);
const MP_TX_DEAL_KINDS = {
  savings: q => q.or(`ticker.like.SAVINGS*,external_source.in.${MP_TX_FUND_SOURCES}`),
  deposit: q => q.like('ticker', 'DEPOSIT:%'),
  gold: q => q.in('ticker', ['XAU', 'XAUT', 'TGLD']),
  crypto: q => q.eq('external_source', 'revolut_crypto_csv'),
  iis: q => q.or(MP_TX_IIS.map(c => `external_id.like.${c}*`).join(',')).not('ticker', 'in', '(XAU,XAUT,TGLD)'),
  broker: q => mpTxNotIis(q.not('ticker', 'like', 'SAVINGS%').not('ticker', 'like', 'DEPOSIT:%').not('ticker', 'in', '(XAU,XAUT,TGLD)')
    .not('external_source', 'in', '(revolut_fund_csv,openbanking_revolut_fund,revolut_crypto_csv)')),
};

// What a chart layer holds, for the queries. (byDay.codes / .tickers: mpAccountByLabel)
function mpTxLayerFilter(layer) {
  const codes = [...(layer.byDay.codes || [])], tickers = [...(layer.byDay.tickers || [])];
  const fiat = mpIsFiatLabel(layer.label) || layer.label === 'other';
  return { label: layer.label, fiat, codes, tickers, any: [...new Set([...codes, ...tickers])] };
}

// A PlayStation purchase's name, the platform once and at the end: "Outer Wilds (PS5)".
const mpTxPs5 = name => `${String(name).replace(/\s*\(?PS4™? & PS5®?\)?|\s+PS5\b/g, '').trim()} (PS5)`;
// A bank row's name in plain words: the shop out of the statement's line; a game store's purchase by the
// note that names the game (any other note goes under the name).
function mpTxNamed(description, note) {
  const shop = description.match(/İŞYERİ:\s*(.*?)\s+MUTABAKAT/)?.[1] ?? mpShortDesc(description).replace(/^Payment in /, '');
  const name = /^PLAYSTATION/i.test(shop) ? 'PlayStation' : /^STEAM/i.test(shop) ? 'Steam'
    : /APPLE\.COM\/BILL|ITUNES\.COM/i.test(shop) ? 'Apple' : shop;
  const game = (name === 'PlayStation' || name === 'Steam') && !!note;
  return { text: game ? (name === 'PlayStation' ? mpTxPs5(note) : note) : name, ps: name === 'PlayStation', full: description, noteLine: game ? '' : note || '', store: ['Apple', 'PlayStation', 'Steam'].includes(name) };
}
// Apple's and the game stores' charges by what they paid for (their purchase history, imported as receipts):
// "YouTube Premium", a subscription; a game's name over a note that guessed it.
async function mpTxAddStoreNames(rows) {
  const bought = rows.filter(r => r.xid && r.store);
  const ids = [...new Set(bought.map(r => r.xid))];
  if (!ids.length) return;
  const orders = [];
  for (let i = 0; i < ids.length; i += 10) {
    const { data, error } = await sb.from('receipts_active').select('id, tx_source, tx_external_id')
      .in('source', ['apple', 'receipt_csv']).in('tx_external_id', ids.slice(i, i + 10));
    if (error) return;
    orders.push(...data);
  }
  if (!orders.length) return;
  const { data: lines, error } = await sb.from('receipt_lines').select('receipt_id, name_printed, note, is_other, line_no, unit_price_list, line_total')
    .in('receipt_id', orders.map(o => o.id)).order('line_no');
  if (error) return;
  for (const r of bought) {
    const order = orders.find(o => o.tx_source === r.src && o.tx_external_id === r.xid);
    const items = (lines || []).filter(l => l.receipt_id === order?.id && !l.is_other);
    if (!items.length) continue;
    r.text = items.slice(0, 2).map(l => l.name_printed).join(', ') + (items.length > 2 ? ` +${items.length - 2}` : '');
    if (r.ps) r.text = mpTxPs5(r.text);
    if (items.some(l => /^(\d{1,2} [A-Za-z]+\.? \d{4} - |Renews|Renewed|Expires|Expired)/.test(l.note || ''))) r.type = 'subscription';
    // bought on sale: the list price is on the receipt
    const full = items.reduce((s, l) => s + Number(l.unit_price_list ?? l.line_total), 0), paid = items.reduce((s, l) => s + Number(l.line_total), 0);
    if (full > paid + 0.005) r.saleLine = `−${Math.round((1 - paid / full) * 100)}% from ${full.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${r.unit}`;
  }
}

// One source's next rows: [{day, at, ...}], from `offset`.
function mpTxSources(account, filter, wallets, edge = null, kind = null) {
  // edge {day, newer}: only what's before that day, newest first; newer: from that day on, oldest first
  const ascending = !!edge?.newer;
  const bounded = (q, col, dateOnly) => {
    if (!edge) return q;
    const at = dateOnly ? edge.day : `${edge.day}T00:00:00Z`;
    return edge.newer ? q.gte(col, at) : q.lt(col, at);
  };
  const all = account === MP_ALL_ACCOUNTS;
  const scoped = q => (all ? q : q.eq('account', account));
  const plain = s => String(s || '').replace(/^ESTIMATED:\s*/, '');
  const page = async (q, offset) => {
    const { data, error } = await q.range(offset, offset + MP_TX_FETCH - 1);
    if (error) throw new Error(error.message);
    return data;
  };
  const money = async offset => {
    let q = scoped(sb.from('bank_transactions').select('id, account, tx_date, description, counterparty, amount, currency, amount_approximate, expense_category, income_category, balance_after, product, external_source, external_id, expense_note'))
      .or('synthetic.is.null,synthetic.eq.false');
    if (filter) q = q.in('currency', filter.any);
    if (kind) q = MP_TX_MONEY_KINDS[kind](q);
    return (await page(bounded(q, 'tx_date').order('tx_date', { ascending }).order('id'), offset)).map(r => ({
      day: r.tx_date.slice(0, 10), at: r.tx_date, account: r.account, ...mpTxNamed(plain(r.description) || r.counterparty || '', r.expense_note), type: '',
      src: r.external_source, xid: r.external_id,
      amount: Number(r.amount), unit: r.currency, approx: !!r.amount_approximate || /^ESTIMATED:/.test(r.description || ''),
      balance: r.balance_after == null ? null : Number(r.balance_after), chain: `${r.account}|${r.currency}|${r.product || ''}|${r.external_source}`,
      category: r.income_category || r.expense_category || '', meta: r.income_category ? mpIncomeMeta(r.income_category) : mpExpMeta(r.expense_category) }));
  };
  const deals = async offset => {
    let q = scoped(sb.from('trades').select('id, account, trade_date, side, ticker, quantity, price, currency, note, estimated'));
    if (filter) q = filter.fiat ? q.in('currency', filter.codes) : q.in('ticker', filter.tickers);
    if (kind) q = MP_TX_DEAL_KINDS[kind](q);
    return (await page(bounded(q, 'trade_date', true).order('trade_date', { ascending }).order('id'), offset)).map(r => {
      const payout = MP_TX_PAYOUTS.has(r.side);
      return { day: r.trade_date, at: r.trade_date, account: r.account, text: MP_SHORT_NAMES[r.ticker] || r.ticker, type: r.side.replace(/_/g, ' '), side: r.side, bond: /^RU[A-Z0-9]{10}$/.test(r.ticker),
        amount: payout ? Number(r.quantity) : null, qty: payout ? null : Number(r.quantity), price: payout ? null : Number(r.price), unit: r.currency, approx: !!r.estimated };
    });
  };
  const crypto = async offset => {
    let q = sb.from('wallet_transactions').select('wallet_id, tx_hash, seq, kind, tx_time, symbol, amount, status, estimated').in('wallet_id', [...wallets.keys()]);
    if (filter) q = q.in('symbol', filter.any);
    return (await page(bounded(q, 'tx_time').order('tx_time', { ascending }).order('tx_hash').order('seq').order('kind'), offset)).map(r => ({
      day: r.tx_time.slice(0, 10), at: r.tx_time, account: wallets.get(r.wallet_id), text: ['ok', 'confirmed'].includes(r.status) ? r.symbol : r.status || r.symbol, type: r.kind.replace(/_/g, ' '),
      amount: Number(r.amount), unit: r.symbol, approx: !!r.estimated, coin: true }));
  };
  const loads = [...(!kind || MP_TX_MONEY_KINDS[kind] ? [money] : []), ...(!kind || MP_TX_DEAL_KINDS[kind] ? [deals] : []),
    ...(wallets.size && (!kind || kind === 'crypto') ? [crypto] : [])];
  return loads.map(load => ({ load, buf: [], offset: 0, done: false }));
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

// An exchange's two legs: the same line in two currencies on one account, worth about the same at the day's
// rates (the rule of the currency_exchanges view). Several in a day: the closest in value pair up first.
// They stand side by side, the currency sold first, then the one bought.
function mpTxPairExchanges(line) {
  const key = r => `${r.account}|${String(r.src).split(':')[0]}|${String(r.full || '').replace(/\s+/g, '')}`;
  const ms = r => Date.parse(r.at);
  const gap = (sold, bought) => {
    const a = mpTxUnitUsd(sold), b = mpTxUnitUsd(bought);
    if (a && b) return Math.abs(Math.log(Math.abs(sold.amount) * a / (bought.amount * b)));
    return sold.category === 'Currency exchange' ? 0.01 : Infinity;   // no rate: only what's labelled an exchange
  };
  const options = [];
  for (const sold of line.filter(r => r.chain && r.amount < 0)) {
    for (const bought of line.filter(r => r.chain && r.amount > 0 && r.unit !== sold.unit && key(r) === key(sold))) {
      const g = gap(sold, bought);
      if (g < 0.08) options.push({ sold, bought, g, dt: Math.abs(ms(sold) - ms(bought)) });
    }
  }
  options.sort((x, y) => x.g - y.g || x.dt - y.dt);
  const used = new Set(), boughtOf = new Map(), soldOf = new Map();
  for (const { sold, bought } of options) {
    if (used.has(sold) || used.has(bought)) continue;
    used.add(sold);
    used.add(bought);
    boughtOf.set(sold, bought);
    soldOf.set(bought, sold);
    const from = line.indexOf(sold), to = line.indexOf(bought);
    const between = from > to ? line.slice(to + 1, from) : [];
    if (between.some(r => r.chain === sold.chain && r.amount > 0) && !between.some(r => r.chain === bought.chain && r.amount < 0)) {
      // the sale needs an income that came in between: the purchase moves down to it instead
      line.splice(to, 1);
      line.splice(line.indexOf(sold) + 1, 0, bought);
    } else {
      line.splice(from, 1);
      line.splice(line.indexOf(bought), 0, sold);
    }
  }
  return { boughtOf, soldOf };
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
  const { boughtOf, soldOf } = mpTxPairExchanges(line);
  const before = new Map(), after = new Map(), alone = [];
  const taken = new Set();
  for (const d of rows.filter(isDeal)) {
    const sum = d.amount != null ? Math.abs(d.amount) : Math.abs(d.qty * d.price);
    const wantIn = d.side === 'buy' ? false : d.amount != null ? d.amount > 0 : true;
    const money = line.find(r => !taken.has(r) && r.chain && r.account === d.account && r.unit === d.unit
      && r.amount > 0 === wantIn && Math.abs(Math.abs(r.amount) - sum) < 0.01);
    if (!money) { alone.push(d); continue; }
    taken.add(money);
    // (outside an exchange's two legs, never between them)
    const side = d.side === 'buy' ? after : before;
    const anchor = d.side === 'buy' ? boughtOf.get(money) || money : soldOf.get(money) || money;
    side.set(anchor, [...(side.get(anchor) || []), d]);
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
// newer: the sources run oldest first, towards today; the rows still come back newest on top.
async function mpTxNext(sources, n, newer = false) {
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
    const later = (x, y) => x.day > y.day || (x.day === y.day && x.at > y.at);
    const next = ready.reduce((a, b) => ((newer ? later(a.buf[0], b.buf[0]) : later(b.buf[0], a.buf[0])) ? b : a));
    if (out.length >= n && next.buf[0].day !== out[out.length - 1].day) break;
    out.push(next.buf.shift());
  }
  await mpTxEnsureRates(out, true);   // the exchanges' legs are told by their value
  const days = new Map();
  for (const r of out) days.set(r.day, [...(days.get(r.day) || []), r]);
  return (newer ? [...days.values()].reverse() : [...days.values()]).flatMap(mpTxArrangeDay);
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
  const sub = [r.type, r.saleLine, r.noteLine, withAccount ? MP_BROKER_SHORT_NAMES[r.account] || r.account : ''].filter(Boolean).join(' · ');
  // (a deal or a coin move has no spending category: the grey mark, to keep the column)
  return `<div class="mp-tx-row${r.approx ? ' approx' : ''}" data-day="${r.day}"><span title="${mpEscapeHtml(r.category || '')}">${mpExpDot(r.meta || mpExpMeta())}</span><div class="mp-tx-body"><div class="mp-tx-main"><span class="mp-tx-name" title="${mpEscapeHtml(r.full || r.text)}">${mpEscapeHtml(r.text)}</span>${right}</div>${sub ? `<div class="mp-tx-sub">${mpEscapeHtml(sub)}</div>` : ''}</div></div>`;
}

// Puts the feed beside `plot`. display: {code, conv(day, usd)} to show amounts in, null: each in its own currency.
// Returns { scrollToDay(day), setLayers(chart layers), onRowDay(fn), setDisplay(display) }.
function mpAccountTxFeed(dlg, plot, account, startDisplay = null) {
  const body = document.createElement('div');
  body.className = 'mp-account-body';
  plot.before(body);
  body.appendChild(plot);
  const feed = document.createElement('div');
  feed.className = 'mp-tx-feed';
  feed.innerHTML = '<div class="mp-tx-head"><b>Transactions</b><select data-tx-kind title="Account type" style="display:none"></select><select data-tx-ccy title="Currency" style="display:none"></select></div><div class="mp-tx-list" data-tx-list></div>';
  body.appendChild(feed);
  const list = feed.querySelector('[data-tx-list]'), ccy = feed.querySelector('[data-tx-ccy]'), kindBox = feed.querySelector('[data-tx-kind]');
  const end = document.createElement('p');
  end.className = 'note mp-tx-end';
  let filter = null, sources = null, wallets = null, busy = false, finished = false, lastDay = null, ticket = 0;
  let display = startDisplay, shownRows = [], layers = [], kind = null;
  // after a jump to a day: the older rows go on below, the newer ones are loaded above
  let startEdge = null, upSources = null, upBusy = false, topDone = true;
  // the row under the mouse: its day, for the mark on the chart
  let onDay = () => {};
  // (not while scrolling: rows passing under a still mouse would make the line jump and blink)
  let scrolling = null;
  list.addEventListener('mouseover', e => { if (!scrolling) onDay(e.target.closest('[data-day]')?.dataset.day || null); });
  list.addEventListener('scroll', () => {
    if (!scrolling) onDay(null);
    clearTimeout(scrolling);
    scrolling = setTimeout(() => { scrolling = null; }, 150);
  }, { passive: true });
  list.addEventListener('mouseleave', () => onDay(null));
  const rowsHtml = rows => {
    let html = '';
    for (const r of rows) {
      if (r.day !== lastDay) {
        lastDay = r.day;
        html += `<div class="mp-tx-day" data-day="${r.day}">${new Date(`${r.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</div>`;
      }
      html += mpTxRowHtml(r, account === MP_ALL_ACCOUNTS, display);
    }
    return html;
  };

  const loadWallets = async () => {
    if (wallets) return;
    let q = sb.from('crypto_wallets').select('id, account');
    if (account !== MP_ALL_ACCOUNTS) q = q.eq('account', account);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    wallets = new Map(data.map(w => [w.id, w.account]));
  };
  const more = async () => {
    if (busy || finished) return;
    busy = true;
    const mine = ticket;
    end.textContent = 'Loading…';
    try {
      await loadWallets();
      sources ||= mpTxSources(account, filter, wallets, startEdge && { day: startEdge, newer: false }, kind);
      const rows = await mpTxNext(sources, MP_TX_STEP);
      await mpTxAddStoreNames(rows).catch(() => {});   // without them: "Apple", "PlayStation"
      for (let asked; asked !== display;) { asked = display; await mpTxEnsureRates(rows, asked); }
      if (mine !== ticket) return;
      shownRows.push(...rows);
      end.insertAdjacentHTML('beforebegin', rowsHtml(rows));
      finished = rows.length < MP_TX_STEP;
      end.textContent = !finished ? '' : list.querySelector('.mp-tx-row') ? 'That is all.' : topDone ? 'No transactions.' : '';
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
  // the newer days, put above what's on screen without moving it
  const moreUp = async () => {
    if (upBusy || topDone) return;
    upBusy = true;
    const mine = ticket;
    try {
      await loadWallets();
      upSources ||= mpTxSources(account, filter, wallets, { day: startEdge, newer: true }, kind);
      const rows = await mpTxNext(upSources, MP_TX_STEP, true);
      await mpTxAddStoreNames(rows).catch(() => {});
      for (let asked; asked !== display;) { asked = display; await mpTxEnsureRates(rows, asked); }
      if (mine !== ticket) return;
      topDone = rows.length < MP_TX_STEP;
      if (rows.length) {
        const top = list.scrollTop, height = list.scrollHeight, bottomDay = lastDay;
        lastDay = null;
        const html = rowsHtml(rows);
        lastDay = bottomDay ?? rows[rows.length - 1].day;
        list.insertAdjacentHTML('afterbegin', html);
        shownRows.unshift(...rows);
        list.scrollTop = top + list.scrollHeight - height;
        if (finished && !end.textContent) end.textContent = 'That is all.';
      }
    } catch { /* the rows below stay; the next scroll up asks again */ } finally {
      if (mine === ticket) {
        upBusy = false;
        nearTop();
      }
    }
  };
  const nearTop = () => { if (list.scrollTop < 200) moreUp(); };
  list.addEventListener('scroll', nearTop, { passive: true });
  // a loaded day at the top of the column (the day itself, or the nearest before it)
  const showLoaded = day => {
    const head = [...list.querySelectorAll('.mp-tx-day')].find(h => h.dataset.day <= day);
    if (!head) { list.scrollTop = list.scrollHeight; return; }
    // (by the row under it: a stuck header reports where it's stuck, not its place)
    list.scrollTop += head.nextElementSibling.getBoundingClientRect().top - list.getBoundingClientRect().top - head.offsetHeight;
  };
  const restart = (edge = null) => {
    ticket++;
    sources = null; busy = false; finished = false; lastDay = null; shownRows = [];
    startEdge = edge; upSources = null; upBusy = false; topDone = !edge;
    list.replaceChildren(end);
    list.scrollTop = 0;
    end.textContent = '';
    return more();
  };
  ccy.onchange = () => {
    filter = ccy.value === '' ? null : mpTxLayerFilter(layers[Number(ccy.value)]);
    restart();
  };
  kindBox.onchange = () => { kind = kindBox.value || null; restart(); };
  // only the types this account has (asked one by one, after the first rows; a failed question keeps the type)
  const findKinds = async () => {
    try { await loadWallets(); } catch { return; }
    const found = [];
    for (const [key, label] of MP_TX_KINDS) {
      if (!dlg.open) return;
      let has = false;
      for (const s of mpTxSources(account, null, wallets, null, key)) {
        try { has = (await s.load(0)).length > 0; } catch { has = true; }
        if (has) break;
      }
      if (has) found.push([key, label]);
    }
    if (!dlg.open) return;
    kindBox.innerHTML = `<option value="">All types</option>${found.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}`;
    kindBox.style.display = found.length > 1 ? '' : 'none';
  };
  dlg.addEventListener('close', () => { ticket++; });
  Promise.resolve(restart()).finally(findKinds);
  return {
    // a click on the chart: the feed moves to that day (or the nearest before it), loading it if it isn't yet
    async scrollToDay(day) {
      const newest = shownRows[0]?.day, oldest = shownRows[shownRows.length - 1]?.day;
      if (newest && day > newest && topDone) { list.scrollTop = 0; return; }
      if (newest && day <= newest && (day >= oldest || finished)) { showLoaded(day); return; }
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
      await restart(next);
      moreUp();
    },
    // the chart's currencies, for the list in the header
    setLayers(list) {
      layers = list || [];
      ccy.innerHTML = `<option value="">All currencies</option>${layers.map((l, i) => `<option value="${i}">${mpEscapeHtml(l.label)}</option>`).join('')}`;
      ccy.style.display = layers.length > 1 ? '' : 'none';
      const kept = layers.findIndex(l => l.label === filter?.label);
      ccy.value = kept < 0 ? '' : String(kept);
      if (filter && kept < 0) { filter = null; restart(); }
    },
    onRowDay(fn) { onDay = fn; },
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
