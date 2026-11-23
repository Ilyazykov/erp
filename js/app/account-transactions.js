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
    let q = scoped(sb.from('bank_transactions').select('id, account, tx_date, description, counterparty, amount, currency, amount_approximate'))
      .or('synthetic.is.null,synthetic.eq.false');
    if (filter) q = q.in('currency', filter.any);
    return (await page(q.order('tx_date', { ascending: false }).order('id'), offset)).map(r => ({
      day: r.tx_date.slice(0, 10), at: r.tx_date, account: r.account, text: plain(r.description) || r.counterparty || '', type: '',
      amount: Number(r.amount), unit: r.currency, approx: !!r.amount_approximate || /^ESTIMATED:/.test(r.description || '') }));
  };
  const deals = async offset => {
    let q = scoped(sb.from('trades').select('id, account, trade_date, side, ticker, quantity, price, currency, note, estimated'));
    if (filter) q = filter.fiat ? q.in('currency', filter.codes) : q.in('ticker', filter.tickers);
    return (await page(q.order('trade_date', { ascending: false }).order('id'), offset)).map(r => {
      const payout = MP_TX_PAYOUTS.has(r.side);
      return { day: r.trade_date, at: r.trade_date, account: r.account, text: MP_SHORT_NAMES[r.ticker] || r.ticker, type: r.side.replace(/_/g, ' '),
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

// The next `n` rows over all sources, newest first.
async function mpTxNext(sources, n) {
  const out = [];
  while (out.length < n) {
    await Promise.all(sources.filter(s => !s.buf.length && !s.done).map(async s => {
      const rows = await s.load(s.offset);
      s.offset += rows.length;
      s.buf.push(...rows);
      if (rows.length < MP_TX_FETCH) s.done = true;
    }));
    const ready = sources.filter(s => s.buf.length);
    if (!ready.length) break;
    const newest = ready.reduce((a, b) => (b.buf[0].day > a.buf[0].day || (b.buf[0].day === a.buf[0].day && b.buf[0].at > a.buf[0].at) ? b : a));
    out.push(newest.buf.shift());
  }
  return out;
}

function mpTxRowHtml(r, withAccount) {
  const number = (v, digits) => Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: digits });
  const right = r.amount != null
    ? `<span class="${r.amount < 0 ? 'neg' : 'pos'}">${r.approx ? '≈ ' : ''}${r.amount < 0 ? '−' : '+'}${number(r.amount, r.coin ? 8 : 2)} ${mpEscapeHtml(r.unit || '')}</span>`
    : `<span>${r.approx ? '≈ ' : ''}${r.qty < 0 ? '−' : ''}${number(r.qty, 8)}${r.price ? ` @ ${number(r.price, 4)} ${mpEscapeHtml(r.unit || '')}` : ''}</span>`;
  const sub = [r.type, withAccount ? MP_BROKER_SHORT_NAMES[r.account] || r.account : ''].filter(Boolean).join(' · ');
  return `<div class="mp-tx-row${r.approx ? ' approx' : ''}"><div class="mp-tx-main"><span class="mp-tx-name" title="${mpEscapeHtml(r.text)}">${mpEscapeHtml(r.text)}</span>${right}</div>${sub ? `<div class="mp-tx-sub">${mpEscapeHtml(sub)}</div>` : ''}</div>`;
}

// Puts the feed beside `plot`. Returns { toggle(layer) }: show only that chart layer, or all again.
function mpAccountTxFeed(dlg, plot, account) {
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
      if (mine !== ticket) return;
      let html = '';
      for (const r of rows) {
        if (r.day !== lastDay) {
          lastDay = r.day;
          html += `<div class="mp-tx-day">${new Date(`${r.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</div>`;
        }
        html += mpTxRowHtml(r, account === MP_ALL_ACCOUNTS);
      }
      end.insertAdjacentHTML('beforebegin', html);
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
    sources = null; busy = false; finished = false; lastDay = null;
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
  };
}
