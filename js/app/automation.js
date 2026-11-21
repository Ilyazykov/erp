// The Automation tab and the crypto wallets: the syncs' keys, status, Save and
// Sync buttons (IBKR, Bybit, Freedom24, Open Banking, Binance, Revolut X, Wise,
// T-Bank), the wallets' list and sync.

// ---- Crypto wallets (non-custodial, synced from the blockchain) ----
// The address itself is private (RLS on crypto_wallets) and only shown here,
// shortened; sync-crypto-wallets does all explorer requests server-side.
const mpShortAddress = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Wallets as last rendered -- used to flag an address that's already added.
let mpWallets = [];
const mpFindWallet = (chain, address) => mpWallets.find(w => w.chain === chain
  && (chain === 'ethereum' ? w.address.toLowerCase() === address.toLowerCase() : w.address === address));
const MP_CHAIN_LABELS = { ethereum: 'Ethereum', tron: 'TRON', bitcoin: 'Bitcoin', solana: 'Solana', binance: 'Binance', bybit: 'Bybit', cryptocom: 'Crypto.com', telegram: 'Walt (Telegram)', ton: 'TON (Gram)' };

// Which network an address belongs to, from its own format -- no picker:
//   0x + 40 hex                          -> Ethereum
//   bc1… (bech32)                         -> Bitcoin
//   EQ/UQ… (TON, 48 chars) or 0:<64 hex>  -> TON (Gram)
//   base58 decoding to 25 bytes with a valid double-SHA256 checksum:
//     version 0x41 -> TRON, 0x00 / 0x05 -> Bitcoin (legacy / P2SH)
//   base58 decoding to 32 bytes           -> Solana (an ed25519 public key)
// Returns null for anything else.
async function mpDetectChain(address) {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ethereum';
  if (/^bc1[02-9ac-hj-np-z]{11,71}$/.test(a)) return 'bitcoin';
  // TON: user-friendly (EQ/UQ/kQ/0Q + 46 base64url chars) or raw (workchain:64 hex)
  if (/^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(a) || /^-?\d:[0-9a-fA-F]{64}$/.test(a)) return 'ton';
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,44}$/.test(a)) return null;
  let n = 0n;
  for (const c of a) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of a) { if (c === '1') bytes.unshift(0); else break; }
  if (bytes.length === 32) return 'solana';
  if (bytes.length !== 25) return null;
  const body = new Uint8Array(bytes.slice(0, 21));
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
  if (!h2.slice(0, 4).every((b, i) => b === bytes[21 + i])) return null;
  if (bytes[0] === 0x41) return 'tron';
  if (bytes[0] === 0x00 || bytes[0] === 0x05) return 'bitcoin';
  return null;
}

document.getElementById('mp_wallet_address').addEventListener('input', async e => {
  const hint = document.getElementById('mp_wallet_detected');
  const value = e.target.value.trim();
  if (!value) { hint.textContent = ''; return; }
  const chain = await mpDetectChain(value);
  hint.textContent = !chain ? 'not a recognised address'
    : `→ ${MP_CHAIN_LABELS[chain]}${mpFindWallet(chain, value) ? ' · already added' : ''}`;
});

function mpFormatQty(q) {
  const n = Number(q);
  if (!isFinite(n)) return mpEscapeHtml(String(q));
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 8 });
}

// Custodial exchange accounts (chain 'bybit', filled by import-bybit) live in
// the same tables as on-chain wallets but get their own block: they aren't
// part of the blockchain sync.
const MP_EXCHANGE_CHAINS = new Set(['binance', 'bybit', 'cryptocom', 'telegram']);

async function mpRenderWallets() {
  const wrap = document.getElementById('mp_wallets_wrap');
  const exWrap = document.getElementById('mp_exchanges_wrap');
  const { data: wallets, error } = await sb.from('crypto_wallets')
    .select('id, chain, address, account, last_synced_at, last_sync_error').order('created_at');
  if (error) { wrap.innerHTML = exWrap.innerHTML = `<p class="empty-note">${mpEscapeHtml(error.message)}</p>`; return; }
  mpWallets = wallets;

  const { data: balances } = await sb.from('wallet_balances')
    .select('wallet_id, chain, contract, symbol, name, quantity, price_usd, ticker');
  const tickers = [...new Set((balances || []).map(b => b.ticker).filter(Boolean))];
  const prices = {};
  if (tickers.length) {
    const { data: mp } = await sb.from('market_prices').select('ticker, price_usd').in('ticker', tickers);
    for (const r of mp || []) prices[r.ticker] = r.price_usd;
  }
  const onchain = wallets.filter(w => !MP_EXCHANGE_CHAINS.has(w.chain));
  const exchanges = wallets.filter(w => MP_EXCHANGE_CHAINS.has(w.chain));
  await mpRenderWalletGroup(wrap, onchain, balances || [], prices, {
    empty: 'No wallets yet — add an address above.', noBalances: 'No balances yet — press Sync now.',
    head: ['Wallet', 'Chain', 'Address', 'Last sync', 'Status'], canDelete: true,
    cells: w => [MP_CHAIN_LABELS[w.chain] || w.chain, `<code>${mpEscapeHtml(mpShortAddress(w.address))}</code>`],
  });
  await mpRenderWalletGroup(exWrap, exchanges, balances || [], prices, {
    empty: 'No exchange accounts yet — upload a Bybit transaction log in Import CSV.',
    noBalances: 'No balances yet — upload both the Funding and the Unified Trading logs.',
    head: ['Account', 'Exchange', 'Account ID', 'Last import', 'Status'],
    cells: w => [MP_CHAIN_LABELS[w.chain] || w.chain, mpEscapeHtml(w.chain === 'bybit' || w.chain === 'binance' ? w.address.replace(/^UID\s*/, '') : '—')],
  });
}

async function mpRenderWalletGroup(wrap, wallets, allBalances, prices, opts) {
  if (!wallets.length) { wrap.innerHTML = `<p class="empty-note">${opts.empty}</p>`; return; }
  const ids = new Set(wallets.map(w => w.id));
  const balances = allBalances.filter(b => ids.has(b.wallet_id));
  const { data: txs } = await sb.from('wallet_transactions')
    .select('wallet_id, tx_time, kind, symbol, amount, counterparty, status')
    .in('wallet_id', [...ids]).order('tx_time', { ascending: false }).limit(30);
  const walletLabel = id => {
    const w = wallets.find(x => x.id === id);
    return w ? `${w.account} · ${MP_CHAIN_LABELS[w.chain] || w.chain}` : '';
  };

  const walletRows = wallets.map(w => `<tr>
    <td class="ticker">${mpEscapeHtml(w.account)}</td>
    ${opts.cells(w).map(c => `<td>${c}</td>`).join('')}
    <td>${w.last_synced_at ? new Date(w.last_synced_at).toLocaleString() : '<span class="muted">never</span>'}</td>
    <td>${w.last_sync_error ? `<span class="neg">${mpEscapeHtml(w.last_sync_error)}</span>` : '<span class="muted">ok</span>'}</td>
    ${opts.canDelete ? `<td><button class="icon-btn" data-wallet-delete="${w.id}" title="Remove">✕</button></td>` : ''}
  </tr>`).join('');

  const rows = balances.map(b => {
    const price = b.ticker ? (prices[b.ticker] ?? b.price_usd) : null;
    const value = price !== null && price !== undefined ? Number(b.quantity) * price : null;
    return { ...b, price, value };
  });
  const counted = rows.filter(r => r.ticker).sort((a, b) => (b.value || 0) - (a.value || 0));
  const uncounted = rows.filter(r => !r.ticker);
  const total = counted.reduce((s, r) => s + (r.value || 0), 0);
  const tokenRow = r => `<tr>
    <td class="ticker">${mpEscapeHtml(r.symbol || '?')}</td>
    <td>${mpEscapeHtml(walletLabel(r.wallet_id))}</td>
    <td>${mpFormatQty(r.quantity)}</td>
    <td>${mpFormatUsd(r.price ?? null)}</td>
    <td>${mpFormatUsd(r.value)}</td>
  </tr>`;

  wrap.innerHTML = `<table class="data-table"><thead><tr>
      ${opts.head.map(h => `<th>${h}</th>`).join('')}${opts.canDelete ? '<th></th>' : ''}
    </tr></thead><tbody>${walletRows}</tbody></table>
    <table class="data-table"><thead><tr>
      <th>Asset</th><th>${opts.head[0]}</th><th>Quantity</th><th>Price (USD)</th><th>Value (USD)</th>
    </tr></thead><tbody>${counted.map(tokenRow).join('') || `<tr><td colspan="5" class="muted">${opts.noBalances}</td></tr>`}
    <tr class="total-row"><td colspan="4"><b>Total</b></td><td><b>${mpFormatUsd(total)}</b></td></tr>
    </tbody></table>
    ${uncounted.length ? `<details class="note"><summary>${uncounted.length} token(s) without a market price — not counted</summary>
      <table class="data-table"><thead><tr><th>Asset</th><th>${opts.head[0]}</th><th>Quantity</th><th>Contract</th></tr></thead>
      <tbody>${uncounted.map(r => `<tr><td class="ticker">${mpEscapeHtml(r.symbol || '?')}</td>
        <td>${mpEscapeHtml(walletLabel(r.wallet_id))}</td><td>${mpFormatQty(r.quantity)}</td>
        <td><code>${mpEscapeHtml(mpShortAddress(r.contract || ''))}</code></td></tr>`).join('')}</tbody></table>
    </details>` : ''}
    ${(txs || []).length ? `<details class="note"><summary>Latest ${txs.length} transactions</summary>
      <table class="data-table"><thead><tr><th>Date</th><th>${opts.head[0]}</th><th>Type</th><th>Asset</th><th>Amount</th><th>Counterparty / details</th></tr></thead>
      <tbody>${txs.map(t => `<tr><td>${new Date(t.tx_time).toLocaleString()}</td>
        <td>${mpEscapeHtml(walletLabel(t.wallet_id))}</td><td>${mpEscapeHtml(t.kind)}</td>
        <td>${mpEscapeHtml(t.symbol || '?')}</td>
        <td class="${Number(t.amount) < 0 ? 'neg' : 'pos'}">${mpFormatQty(t.amount)}</td>
        <td>${t.counterparty ? `<code>${mpEscapeHtml(mpShortAddress(t.counterparty))}</code>`
          : t.status ? `<span class="muted">${mpEscapeHtml(t.status)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
      </tbody></table></details>` : ''}`;

  wrap.querySelectorAll('[data-wallet-delete]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Remove this account together with its balances and history?')) return;
    const { error: delErr } = await sb.from('crypto_wallets').delete().eq('id', btn.dataset.walletDelete);
    document.getElementById('mp_wallet_status').textContent = delErr ? `Error: ${delErr.message}` : 'Removed.';
    mpRefreshAfterWalletChange();
  }));
}

function mpRefreshAfterWalletChange() {
  mpRenderWallets();
  mpRenderPortfolioPies();
  mpRenderBrokerCurrency();
  mpRenderBrokerAssetClass();
}

// ---- IBKR automatic sync (supabase/functions/sync-ibkr) ----
// The Query ID shows; the token only as "saved" (ibkr_flex_status, migrations ...096, ...097).
async function mpIbkrFlexLoad() {
  const statusEl = document.getElementById('mp_ibkr_status');
  const { data, error } = await sb.rpc('ibkr_flex_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  document.getElementById('mp_ibkr_query_id').value = s?.query_id || '';
  document.getElementById('mp_ibkr_token').placeholder = s?.token_set ? 'saved — leave empty to keep' : 'not set';
  const expEl = document.getElementById('mp_ibkr_token_expires');
  expEl.value = expEl.dataset.saved = s?.token_expires || '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never synced';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last synced ${new Date(s.last_sync_at).toLocaleString()}: `
      + (r.error ? `error — ${r.error}` : `${r.trades} trades, ${r.dividends} dividends, ${r.cash_rows} cash rows for ${r.period}`);
  }
  // Days the token has left, red within a week of its end.
  let expiry = '';
  statusEl.style.color = '';
  if (s.token_set && s.token_expires) {
    const days = mpDaysUntil(s.token_expires);
    expiry = days < 0 ? ` (expired ${s.token_expires} — generate a new one)` : ` until ${s.token_expires} (${days} days left)`;
    if (days <= 7) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `Query ID ${s.query_id || '—'}, token ${s.token_set ? 'saved' : 'not set'}${expiry}; ${last}.`;
}

// The token's end date from its Activation Period as IBKR shows it --
// "2026-10-22, 20:18:28 EDT — 2027-09-23, 20:18:28 EDT": the last date in it
// (so a bare "2027-09-23" works too); null without one.
function mpIbkrExpiry(text) {
  const dates = String(text || '').match(/\d{4}-\d{2}-\d{2}/g);
  return dates ? dates[dates.length - 1] : null;
}

// A new token: a year from today, IBKR's longest, unless a date is typed in
// already -- to correct to its Activation Period when that says otherwise.
document.getElementById('mp_ibkr_token').addEventListener('input', e => {
  const exp = document.getElementById('mp_ibkr_token_expires');
  if (e.target.value && (!exp.value || exp.value === exp.dataset.saved)) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    exp.value = d.toISOString().slice(0, 10);
  }
});

document.getElementById('mp_ibkr_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_ibkr_status');
  const tokenEl = document.getElementById('mp_ibkr_token');
  const { error } = await sb.rpc('set_ibkr_flex', {
    p_query_id: document.getElementById('mp_ibkr_query_id').value, p_token: tokenEl.value,
    p_token_expires: mpIbkrExpiry(document.getElementById('mp_ibkr_token_expires').value),
  });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  tokenEl.value = '';
  await mpIbkrFlexLoad();
  mpRenderLatestSources();
});

document.getElementById('mp_ibkr_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_ibkr_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  statusEl.textContent = 'Asking IBKR for the statement… (it takes IBKR up to a minute to build it)';
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-ibkr`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const r = await res.json();
    if (!res.ok) { statusEl.textContent = `Error: ${r.error || res.statusText}`; return; }
    const fmt = o => Object.entries(o || {}).map(([c, v]) => `${c} ${Number(v).toFixed(2)}`).join(', ') || 'none';
    statusEl.textContent = `Synced ${r.period}: ${r.trades} trades, ${r.dividends} dividends, ${r.cash_rows} cash rows. `
      + `IBKR cash: ${fmt(r.cash)} (the statement's ending cash: ${fmt(r.statement_ending_cash)}). Capital is being rebuilt.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Bybit automatic sync (supabase/functions/sync-bybit) ----
// The key shows by its last characters, the secret only as "saved" (bybit_api_status, migration ...098).
async function mpBybitApiLoad() {
  const statusEl = document.getElementById('mp_bybit_status');
  const { data, error } = await sb.rpc('bybit_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  const keyEl = document.getElementById('mp_bybit_key');
  keyEl.value = '';
  keyEl.placeholder = s?.key_tail ? `saved …${s.key_tail} — leave empty to keep` : 'not set';
  document.getElementById('mp_bybit_secret').placeholder = s?.secret_set ? 'saved — leave empty to keep' : 'not set';
  statusEl.style.color = '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never synced';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last synced ${new Date(s.last_sync_at).toLocaleString()}: `
      + (r.error ? `error — ${r.error}` : `${r.funding_rows} Funding and ${r.unified_rows} Unified Trading rows for ${r.period}`);
    if (r.error) statusEl.style.color = 'var(--red, #f85149)';
  }
  // Days the key has left, red within a week of its end.
  let expiry = s.key_expires ? '' : ' (its end date comes with the first sync)';
  if (s.key_expires) {
    const days = mpDaysUntil(s.key_expires);
    expiry = days < 0 ? ` (expired ${s.key_expires} — create a new one)` : ` until ${s.key_expires} (${days} days left)`;
    if (days <= 7) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `API key …${s.key_tail || '—'}, secret ${s.secret_set ? 'saved' : 'not set'}${expiry}; ${last}.`;
}

document.getElementById('mp_bybit_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_bybit_status');
  const keyEl = document.getElementById('mp_bybit_key'), secretEl = document.getElementById('mp_bybit_secret');
  if (!keyEl.value.trim() && !keyEl.placeholder.startsWith('saved')) { statusEl.textContent = 'Enter the API key.'; return; }
  // An empty key or secret keeps the saved one (set_bybit_api).
  const { error } = await sb.rpc('set_bybit_api', { p_key: keyEl.value, p_secret: secretEl.value });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  secretEl.value = '';
  // Checked with Bybit at once: its end date, or why it won't do.
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the key with Bybit…';
  let problem = '';
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-bybit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json', 'x-region': 'eu-west-1' },
      body: JSON.stringify({ check: true }),
    });
    const r = await res.json();
    if (!res.ok) problem = r.error || res.statusText;
  } catch (err) {
    problem = err.message;
  }
  await mpBybitApiLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but Bybit refuses the key: ${problem}`;
  }
  mpRenderLatestSources();
});

document.getElementById('mp_bybit_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_bybit_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  statusEl.style.color = '';
  statusEl.textContent = 'Pulling the last 30 days from Bybit…';
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-bybit`, {
      method: 'POST',
      // Bybit refuses US addresses: the function runs in the project's region
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json', 'x-region': 'eu-west-1' },
      body: '{}',
    });
    const r = await res.json();
    if (!res.ok) { statusEl.textContent = `Error: ${r.error || res.statusText}`; return; }
    const fmt = o => Object.entries(o || {}).map(([c, v]) => `${c} ${v}`).join(', ') || 'none';
    statusEl.textContent = `Synced ${r.period}: ${r.funding_rows} Funding and ${r.unified_rows} Unified Trading rows. `
      + `Balances: ${fmt(r.balances)}. Key valid until ${r.key_expires || '?'}. Capital is being rebuilt.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Freedom24 automatic sync (supabase/functions/sync-freedom24) ----
// The public key shows by its last characters, the private one only as "saved" (freedom24_api_status, migration ...099).
async function mpF24ApiLoad() {
  const statusEl = document.getElementById('mp_f24_status');
  const { data, error } = await sb.rpc('freedom24_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  const pubEl = document.getElementById('mp_f24_public');
  pubEl.value = '';
  pubEl.placeholder = s?.key_tail ? `saved …${s.key_tail} — leave empty to keep` : 'not set';
  document.getElementById('mp_f24_private').placeholder = s?.secret_set ? 'saved — leave empty to keep' : 'not set';
  statusEl.style.color = '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never synced';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last synced ${new Date(s.last_sync_at).toLocaleString()}: `
      + (r.error ? `error — ${r.error}` : `${r.trades} trades, ${r.dividends} dividends, ${r.cash_rows} cash rows for ${r.period}`);
    if (r.error) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `Public key …${s.key_tail || '—'}, private key ${s.secret_set ? 'saved' : 'not set'} (no end date); ${last}.`;
}

function mpF24Call(body) { return mpCallEdge('sync-freedom24', body); }

document.getElementById('mp_f24_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_f24_status');
  const pubEl = document.getElementById('mp_f24_public'), privEl = document.getElementById('mp_f24_private');
  if (!pubEl.value.trim() && !pubEl.placeholder.startsWith('saved')) { statusEl.textContent = 'Enter the public key.'; return; }
  // An empty public or private key keeps the saved one (set_freedom24_api).
  const { error } = await sb.rpc('set_freedom24_api', { p_public: pubEl.value, p_private: privEl.value });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  privEl.value = '';
  // Checked with Freedom24 at once: do the keys work.
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the keys with Freedom24…';
  let problem = '', ops = null;
  try { ops = (await mpF24Call({ check: true })).operations; } catch (err) { problem = err.message; }
  await mpF24ApiLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but Freedom24 refuses the keys: ${problem}`;
  } else {
    statusEl.textContent += ` Keys work: ${ops} operations on the account.`;
  }
  mpRenderLatestSources();
});

document.getElementById('mp_f24_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_f24_status');
  statusEl.style.color = '';
  statusEl.textContent = 'Pulling the cash movements from Freedom24…';
  try {
    const r = await mpF24Call({});
    const fmt = o => Object.entries(o || {}).map(([c, v]) => `${c} ${Number(v).toFixed(2)}`).join(', ') || 'none';
    statusEl.textContent = `Synced ${r.period}: ${r.trades} trades, ${r.dividends} dividends, ${r.cash_rows} cash rows `
      + `(the last on ${r.last_operation}). Freedom24 cash: ${fmt(r.cash)}. Capital is being rebuilt.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Revolut & Bank of Cyprus through Enable Banking (supabase/functions/sync-openbanking) ----
// The application (key only as "set") and each bank's consent (enablebanking_status, migration ...107).
const MP_EB_BANKS = { revolut: 'Revolut', boc: 'Bank of Cyprus', wise: 'Wise' };
async function mpEbLoad() {
  const statusEl = document.getElementById('mp_eb_status');
  const { data, error } = await sb.rpc('enablebanking_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const app = (data || []).find(r => r.broker === 'enablebanking');
  const appEl = document.getElementById('mp_eb_app');
  appEl.value = app?.app_id || '';
  if (!mpEbKeyFile) document.getElementById('mp_eb_drop').innerHTML = app?.key_set
    ? 'Key saved — drop another <code>.pem</code> here (or click) only to replace it'
    : 'Drop the application\'s private key (<code>&lt;id&gt;.pem</code>) here, or click to choose it';
  statusEl.style.color = '';
  if (!app) { statusEl.textContent = 'Not set up.'; return; }
  const lines = [`Application ${app.app_id || '—'}, key ${app.key_set ? 'saved' : 'not set'}.`];
  for (const [bank, label] of Object.entries(MP_EB_BANKS)) {
    const s = (data || []).find(r => r.broker === `eb:${bank}`);
    if (!s?.session_set) { lines.push(`${label}: not connected.`); continue; }
    const days = s.valid_until ? mpDaysUntil(s.valid_until) : null;
    let last = 'not looked at yet';
    if (s.last_sync_at) {
      const r = mpSyncResult(s);
      last = `looked at ${new Date(s.last_sync_at).toLocaleString()}: ` + mpEbSummary(r);
    }
    lines.push(`${label}: connected until ${s.valid_until || '?'}${days !== null ? ` (${days} days left)` : ''}; ${last}.`);
    if (days !== null && days <= 7) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.innerHTML = lines.map(l => l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))).join('<br>');
}

function mpEbSummary(r) {
  if (r.error) return `error — ${r.error}`;
  const bal = Object.entries(r.balances || {}).filter(([, b]) => b.bank || b.expected).map(([c, b]) => `${c} ${b.bank ?? b.expected}`).join(', ');
  return `${r.written ?? 0} transactions after the statement of ${r.after_statement || '?'}`
    + (r.pending ? ` (${r.pending} of them pending)` : '')
    + (r.fund_savings_trades || r.fund_returns_estimated
      ? `; estimated until the fund / savings / Invest / metal statements: ${r.fund_savings_trades || 0} transfers, ${r.fund_returns_estimated || 0} daily return / fee rows` : '')
    + (r.checked ? `; checked against the statement ${r.checked.window}: ${r.checked.matched} paired` : '')
    + (bal ? `; balance ${bal} — agrees with the bank` : '');
}

function mpEbCall(body) { return mpCallEdge('sync-openbanking', body); }

// The key file, dropped or chosen: read in the browser, sent once with Save;
// the application's id is the file's name (the Control Panel names it <id>.pem).
let mpEbKeyFile = null;
function mpEbTakeKeyFile(file) {
  if (!file) return;
  mpEbKeyFile = file;
  const m = file.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) document.getElementById('mp_eb_app').value = m[1];
  document.getElementById('mp_eb_drop').textContent = `${file.name} — press Save`;
}
{
  const drop = document.getElementById('mp_eb_drop'), input = document.getElementById('mp_eb_key');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => mpEbTakeKeyFile(input.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); mpEbTakeKeyFile(e.dataTransfer.files[0]); });
}

document.getElementById('mp_eb_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_eb_status');
  const appEl = document.getElementById('mp_eb_app'), keyEl = document.getElementById('mp_eb_key');
  if (!appEl.value.trim()) { statusEl.textContent = 'Enter the application ID (or choose the .pem file).'; return; }
  const file = mpEbKeyFile;
  const key = file ? await file.text() : '';
  if (file && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) { statusEl.textContent = "That file isn't a private key (.pem)."; return; }
  // No file keeps the saved key (set_enablebanking_app).
  const { error } = await sb.rpc('set_enablebanking_app', { p_app_id: appEl.value, p_key: key });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  keyEl.value = '';
  mpEbKeyFile = null;
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the application with Enable Banking…';
  let problem = '', app = null;
  try { app = await mpEbCall({ check: true }); } catch (err) { problem = err.message; }
  await mpEbLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but Enable Banking refuses it: ${problem}`;
  } else {
    statusEl.innerHTML += `<br>Enable Banking: application "${String(app.name || '').replace(/[&<>]/g, '')}" ${app.active ? 'active' : 'not active'} (${app.environment || ''}).`;
  }
});

for (const bank of Object.keys(MP_EB_BANKS)) {
  document.getElementById(`mp_eb_connect_${bank}`).addEventListener('click', async () => {
    const statusEl = document.getElementById('mp_eb_status');
    statusEl.style.color = '';
    statusEl.textContent = `Asking Enable Banking for ${MP_EB_BANKS[bank]}'s consent page…`;
    try {
      const r = await mpEbCall({ action: 'connect', bank });
      window.location.href = r.url;   // the bank's consent page; it sends you back here
    } catch (err) {
      statusEl.style.color = 'var(--red, #f85149)';
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
}

// Back from the bank (?code=...&state=<bank>): the code becomes the bank's
// session; the address is cleaned so a reload doesn't use the code twice.
async function mpEbReturn() {
  const p = new URLSearchParams(window.location.search);
  const state = p.get('state');
  if (!state || !(state in MP_EB_BANKS)) return;
  history.replaceState(null, '', window.location.pathname + window.location.hash);
  showTab('automation');   // where the Open Banking block lives
  const statusEl = document.getElementById('mp_eb_status');
  if (p.get('error')) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `${MP_EB_BANKS[state]} not connected: ${p.get('error_description') || p.get('error')}`;
    return;
  }
  statusEl.textContent = `Connecting ${MP_EB_BANKS[state]}…`;
  try {
    const r = await mpEbCall({ action: 'session', code: p.get('code'), state });
    await mpEbLoad();
    statusEl.innerHTML += `<br>${r.bank} connected: ${r.accounts} accounts, until ${r.valid_until}.`;
    document.getElementById('mp_eb_status').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `${MP_EB_BANKS[state]} not connected: ${err.message}`;
  }
}

document.getElementById('mp_eb_debug').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_eb_status');
  statusEl.style.color = '';
  statusEl.textContent = "Saving Revolut's raw transactions for a look…";
  try {
    const r = await mpEbCall({ action: 'debug', bank: 'revolut' });
    statusEl.textContent = `Saved: ${r.accounts} accounts, ${r.api} API transactions, ${r.stored} statement rows -- tell Claude.`;
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById('mp_eb_fx').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_eb_status');
  statusEl.style.color = '';
  statusEl.textContent = "Fetching the rates Revolut converted card payments at…";
  try {
    const r = await mpEbCall({ action: 'fx_backfill', bank: 'revolut' });
    statusEl.textContent = `Revolut: ${r.api} transactions back to ${r.earliest || '—'}, ${r.with_fx} with an exchange rate, ${r.updated} matched to the rows here -- the expenses split them in a minute.`;
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById('mp_eb_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_eb_status');
  statusEl.style.color = '';
  statusEl.textContent = 'Looking at the connected banks…';
  try {
    await mpEbCall({});
    await mpEbLoad();
    mpRenderLatestSources();
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Binance automatic check (supabase/functions/sync-binance) ----
// The key shows by its last characters, the secret only as "saved" (binance_api_status, migration ...106).
async function mpBinanceApiLoad() {
  const statusEl = document.getElementById('mp_binance_status');
  const { data, error } = await sb.rpc('binance_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  const keyEl = document.getElementById('mp_binance_key');
  keyEl.value = '';
  keyEl.placeholder = s?.key_tail ? `saved …${s.key_tail} — leave empty to keep` : 'not set';
  document.getElementById('mp_binance_secret').placeholder = s?.secret_set ? 'saved — leave empty to keep' : 'not set';
  statusEl.style.color = '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never checked';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last checked ${new Date(s.last_sync_at).toLocaleString()}: ` + mpBinanceSummary(r);
    if (r.error || r.differences?.length) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `API key …${s.key_tail || '—'}, secret ${s.secret_set ? 'saved' : 'not set'} (no end date); ${last}.`;
}

// A balance check's coins, as "BTC 0.0123, USDT 15" ('nothing' when none)
function mpCoinList(balances) {
  return Object.entries(balances || {}).map(([c, v]) => `${c} ${Number(v).toLocaleString('en', { maximumFractionDigits: 8 })}`).join(', ') || 'nothing';
}
function mpBinanceSummary(r) {
  if (r.error) return `error — ${r.error}`;
  const coins = mpCoinList(r.balances);
  return r.differences?.length
    ? `the account differs from the stored export (${r.differences.join('; ')}) — upload a new Binance export`
    : `matches the stored export (${coins})`;
}

function mpBinanceCall(body) { return mpCallEdge('sync-binance', body, 'eu-west-1'); }

document.getElementById('mp_binance_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_binance_status');
  const keyEl = document.getElementById('mp_binance_key'), secretEl = document.getElementById('mp_binance_secret');
  if (!keyEl.value.trim() && !keyEl.placeholder.startsWith('saved')) { statusEl.textContent = 'Enter the API key.'; return; }
  // An empty key or secret keeps the saved one (set_binance_api).
  const { error } = await sb.rpc('set_binance_api', { p_key: keyEl.value, p_secret: secretEl.value });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  secretEl.value = '';
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the key with Binance…';
  let problem = '';
  try { await mpBinanceCall({ check: true }); } catch (err) { problem = err.message; }
  await mpBinanceApiLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but Binance refuses the key: ${problem}`;
  } else {
    statusEl.textContent += ' The key is read-only.';
  }
  mpRenderLatestSources();
});

document.getElementById('mp_binance_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_binance_status');
  statusEl.style.color = '';
  statusEl.textContent = 'Reading the balances from Binance…';
  try {
    const r = await mpBinanceCall({});
    if (r.differences?.length) statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Checked: ${mpBinanceSummary(r)}.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Revolut crypto automatic check (supabase/functions/sync-revolutx) ----
// The API key shows by its last characters, the private key only as "saved"
// (revolutx_api_status, migration ...116). The Ed25519 pair is made here: the
// public key to register at Revolut X, the private key sent once with Save.
let mpRevxPrivatePem = '', mpRevxSecretSaved = false;
const mpPem = (label, buf) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(buf))).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;

async function mpRevxApiLoad() {
  const statusEl = document.getElementById('mp_revx_status');
  const { data, error } = await sb.rpc('revolutx_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  mpRevxSecretSaved = !!s?.secret_set;
  const keyEl = document.getElementById('mp_revx_key');
  keyEl.value = '';
  keyEl.placeholder = s?.key_tail ? `saved …${s.key_tail} — leave empty to keep` : 'not set';
  statusEl.style.color = '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never checked';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last checked ${new Date(s.last_sync_at).toLocaleString()}: ` + mpRevxSummary(r);
    if (r.error || r.differences?.length) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `API key …${s.key_tail || '—'}, private key ${s.secret_set ? 'saved' : 'not set'} (no end date); ${last}.`;
}

function mpRevxSummary(r) {
  if (r.error) return `error — ${r.error}`;
  const coins = mpCoinList(r.balances);
  return r.differences?.length
    ? `Revolut's crypto differs from the stored statement (${r.differences.join('; ')}) — upload a new Revolut crypto statement`
    : `matches the stored statement (${coins})`;
}

function mpRevxCall(body) { return mpCallEdge('sync-revolutx', body, 'eu-west-1'); }

document.getElementById('mp_revx_pair').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_revx_status'), pubEl = document.getElementById('mp_revx_public');
  try {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    mpRevxPrivatePem = mpPem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    pubEl.value = mpPem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));
    pubEl.style.display = '';
    pubEl.select();
    statusEl.style.color = '';
    statusEl.textContent = 'Key pair made. Copy the public key above into Revolut X (Profile → API keys → read-only), '
      + 'then paste the API key it gives here and press Save — before leaving the page (the private key lives only in it until then).';
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `This browser can't make Ed25519 keys (${err.message}) — use a current Chrome, Safari or Firefox.`;
  }
});

document.getElementById('mp_revx_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_revx_status');
  const keyEl = document.getElementById('mp_revx_key');
  if (!keyEl.value.trim() && !keyEl.placeholder.startsWith('saved')) { statusEl.textContent = 'Enter the API key.'; return; }
  if (!mpRevxPrivatePem && !mpRevxSecretSaved) {
    statusEl.textContent = 'Make a key pair first: the API key works only with the private key of the public key you registered.';
    return;
  }
  // An empty key or private key keeps the saved one (set_revolutx_api).
  const { error } = await sb.rpc('set_revolutx_api', { p_key: keyEl.value, p_private_key: mpRevxPrivatePem });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  mpRevxPrivatePem = '';
  document.getElementById('mp_revx_public').style.display = 'none';
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the key with Revolut X…';
  let problem = '';
  try { await mpRevxCall({ check: true }); } catch (err) { problem = err.message; }
  await mpRevxApiLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but Revolut X refuses the key: ${problem}`;
  } else {
    statusEl.textContent += ' Revolut X accepts the key.';
  }
  mpRenderLatestSources();
});

document.getElementById('mp_revx_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_revx_status');
  statusEl.style.color = '';
  statusEl.textContent = 'Reading the balances from Revolut X…';
  try {
    const r = await mpRevxCall({});
    if (r.differences?.length) statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Checked: ${mpRevxSummary(r)}.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// ---- Wise API token, kept for later (set_wise_api / wise_api_status, migrations ...120, ...121) ----
async function mpWiseApiLoad() {
  const statusEl = document.getElementById('mp_wise_status');
  const { data, error } = await sb.rpc('wise_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  const tokenEl = document.getElementById('mp_wise_token');
  tokenEl.value = '';
  tokenEl.placeholder = s?.token_set ? `saved …${s.token_tail} — leave empty to keep` : 'not set';
  statusEl.textContent = s?.token_set ? `Token …${s.token_tail} saved (not used).` : 'No token saved.';
}

document.getElementById('mp_wise_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_wise_status');
  const tokenEl = document.getElementById('mp_wise_token');
  if (!tokenEl.value.trim()) { statusEl.textContent = 'Enter the API token.'; return; }
  const { error } = await sb.rpc('set_wise_api', { p_token: tokenEl.value, p_private_key: '' });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  await mpWiseApiLoad();
});

// ---- T-Bank broker automatic sync (supabase/functions/sync-tbank) ----
// The token only as "saved" (tbank_api_status, migration ...104).
async function mpTbankApiLoad() {
  const statusEl = document.getElementById('mp_tbank_status');
  const { data, error } = await sb.rpc('tbank_api_status');
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  const s = (data || [])[0];
  document.getElementById('mp_tbank_token').placeholder = s?.token_set ? 'saved — leave empty to keep' : 'not set';
  statusEl.style.color = '';
  if (!s) { statusEl.textContent = 'Not set up.'; return; }
  let last = 'never synced';
  if (s.last_sync_at) {
    const r = mpSyncResult(s);
    last = `last synced ${new Date(s.last_sync_at).toLocaleString()}: ` + (r.error ? `error — ${r.error}` : mpTbankSummary(r));
    if (r.error) statusEl.style.color = 'var(--red, #f85149)';
  }
  statusEl.textContent = `Token ${s.token_set ? 'saved' : 'not set'} (renewed by every sync); ${last}.`;
}

function mpTbankSummary(r) {
  if (!Array.isArray(r.synced)) return `up to ${r.period_to || '?'}`;
  return r.synced.map(a => `${a.agreement}: ${a.deals} deals, ${a.payouts} payouts, ${a.cash_rows} cash rows from ${a.from}`
    + (a.checked?.window ? ` (checked against the report ${a.checked.window}: ${a.checked.deals} deals, ${a.checked.payouts} payouts)` : ' (no report to check against)')).join('; ') || 'no open broker accounts';
}

function mpTbankCall(body) { return mpCallEdge('sync-tbank', body); }

document.getElementById('mp_tbank_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_tbank_status');
  const tokenEl = document.getElementById('mp_tbank_token');
  if (!tokenEl.value.trim() && !tokenEl.placeholder.startsWith('saved')) { statusEl.textContent = 'Enter the token.'; return; }
  // An empty token keeps the saved one (set_tbank_api).
  const { error } = await sb.rpc('set_tbank_api', { p_token: tokenEl.value });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  tokenEl.value = '';
  statusEl.style.color = '';
  statusEl.textContent = 'Saved; checking the token with T-Bank…';
  let problem = '', accounts = [];
  try { accounts = (await mpTbankCall({ check: true })).accounts || []; } catch (err) { problem = err.message; }
  await mpTbankApiLoad();
  if (problem) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Saved, but T-Bank refuses the token: ${problem}`;
  } else {
    statusEl.textContent += ` Accounts: ${accounts.map(a => `${a.id} ${a.name || ''} (${a.type}, ${a.status}, ${a.access})`).join('; ') || 'none'}.`;
  }
  mpRenderLatestSources();
});

document.getElementById('mp_tbank_sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_tbank_status');
  statusEl.style.color = '';
  statusEl.textContent = 'Pulling the broker accounts from T-Bank…';
  try {
    const r = await mpTbankCall({});
    statusEl.textContent = `Synced up to ${r.period_to}: ${mpTbankSummary(r)}. Capital is being rebuilt.`;
    mpRenderLatestSources();
  } catch (err) {
    statusEl.style.color = 'var(--red, #f85149)';
    statusEl.textContent = `Error: ${err.message}`;
  }
});

async function mpSyncWallets(prefix = '') {
  const statusEl = document.getElementById('mp_wallet_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  statusEl.textContent = `${prefix ? prefix + ' ' : ''}Syncing with the blockchain… (the first sync of a wallet walks its whole history and can take a minute or two)`;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-crypto-wallets`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await res.json();
    if (!res.ok) { statusEl.textContent = `Error: ${result.error || res.statusText}`; return; }
    statusEl.textContent = (prefix ? prefix + ' ' : '') + result.results.map(r => r.error
      ? `${r.chain}: error — ${r.error}`
      : `${r.chain}: ${r.assets} assets (${r.priced} counted), ${r.new_transactions} new transactions`
        + (r.warnings && r.warnings.length ? ` — ${r.warnings.join('; ')}` : '')).join(' · ') || 'No wallets to sync.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
  mpRefreshAfterWalletChange();
}

document.getElementById('mp_wallet_add').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_wallet_status');
  const address = document.getElementById('mp_wallet_address').value.trim();
  const account = document.getElementById('mp_wallet_account').value.trim() || 'Trust';
  const chain = await mpDetectChain(address);
  if (!chain) {
    statusEl.textContent = 'Not a recognised Ethereum (0x…), TRON (T…), Bitcoin (bc1…/1…/3…) or Solana address.';
    return;
  }
  if (mpFindWallet(chain, address)) {
    statusEl.textContent = `This ${MP_CHAIN_LABELS[chain]} wallet (${mpShortAddress(address)}) is already added.`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  const { error } = await sb.from('crypto_wallets').insert({ user_id: session.user.id, chain, address, account });
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
  document.getElementById('mp_wallet_address').value = '';
  document.getElementById('mp_wallet_detected').textContent = '';
  await mpRenderWallets();  // show it in the list right away, before the sync finishes
  const added = `Added ${MP_CHAIN_LABELS[chain]} wallet ${mpShortAddress(address)}.`;
  statusEl.textContent = `${added} Syncing with the blockchain…`;
  await mpSyncWallets(added);
});
document.getElementById('mp_wallet_sync').addEventListener('click', () => mpSyncWallets());

// Recompute exchange balances from the history already stored (no upload) --
// e.g. after the import's balance rules change.
document.getElementById('mp_exchange_recalc').addEventListener('click', async () => {
  const statusEl = document.getElementById('mp_exchange_status');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { statusEl.textContent = 'Sign in first.'; return; }
  statusEl.textContent = 'Recalculating…';
  try {
    const parts = [];
    for (const [fn, name] of [['import-binance', 'Binance'], ['import-bybit', 'Bybit'], ['import-crypto-com', 'Crypto.com'], ['import-telegram-wallet', 'Telegram']]) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}?recompute=1`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      const result = await res.json();
      if (!res.ok) { parts.push(`${name}: error — ${result.error || res.statusText}`); continue; }
      for (const r of result.results) parts.push(`${name}: ${Object.entries(r.balances).map(([c, q]) => `${c} ${q}`).join(', ') || 'nothing'} `
        + `(from ${r.rows} stored rows)`);
    }
    statusEl.textContent = parts.join(' · ') || 'No exchange accounts.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
  mpRefreshAfterWalletChange();
});

