// The Expenses tab's editing: a purchase's items and products, category,
// account, transfers, income type; totals by month; pending receipts.

// ---- Items within a purchase (migration ...179, design: docs/items-design.md, not tracked in git) ----
// JS mirrors of the SQL receipt_norm / the store-key it's built from
// (receipt_resolve_place) -- punctuation collapsed to a space, digits kept.
function mpReceiptNorm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function mpStoreKey(chain, storePrinted) {
  return mpReceiptNorm(chain || '') || mpReceiptNorm(String(storePrinted || '').replace(/[0-9]+/g, ''));
}
// A row's items: a receipt in force (receipt_csv > statement > manual, same
// rank as receipts_active) shows its lines read-only, its own note, and a
// "resolve" control on any line with no product yet; a row with none offers
// a small editable table to add items by hand (source 'manual',
// match_state 'manual_link' -- tied to this row directly, never touched by
// match_receipts). Editing a manual receipt again replaces all its lines.
async function mpEditItems(src, xid) {
  const rows = mpExpRowsOf(src, xid);
  const r = rows.find(x => !x.split) || rows[0];
  if (!r) return;
  const receipt = mpExpCache?.receiptOf?.get(`${src}|${xid}`);
  // The lines come fresh from the database every time the dialog opens: the
  // tab's cache is behind a product just resolved (or merged), and a stale line
  // showed "resolve" again -- a second click made a second product. The row's
  // Items cell is brought up to date with them.
  if (receipt) {
    const { data: fresh, error: freshErr } = await sb.from('receipt_lines').select(MP_RECEIPT_LINE_COLS).eq('receipt_id', receipt.id).order('line_no');
    if (!freshErr && fresh) {
      receipt.lines = fresh;
      document.querySelectorAll('#expenses .exp-items').forEach(c => {
        if (c.dataset.src === src && c.dataset.xid === xid) c.innerHTML = mpItemsHtml(receipt);
      });
    }
  }
  const unit = v => ` <select name="u" style="width:auto;display:inline">${['pcs', 'kg', 'l', 'other'].map(u => `<option${u === v ? ' selected' : ''}>${u}</option>`).join('')}</select>`;

  if (receipt && receipt.source !== 'manual') {
    const real = receipt.lines.filter(l => !l.is_other);
    const other = receipt.lines.find(l => l.is_other);
    // dollars at the purchase day's rate: the row's own dollars over its own amount (the receipt's currency)
    const usdPer = (receipt.currency || r.ccy) === r.ccy && r.amt ? r.usd / r.amt : NaN;
    const usdOf = gel => (Number.isFinite(usdPer) ? `$${(gel * usdPer).toFixed(2)}` : '—');
    const lineRow = l => `<tr data-item="${l.line_no}">
        <td style="text-align:left">${l.product_id != null
          ? `<a href="#" class="item-product" data-pid="${l.product_id}" style="color:#58a6ff">${mpEscapeHtml(l.name_en || l.name_printed)}</a>`
          : receipt.source === 'apple' ? `<a href="#" class="item-apple" data-item="${l.line_no}" style="color:#58a6ff" title="Price history">${mpEscapeHtml(l.name_en || l.name_printed)}</a>`
          : `${mpEscapeHtml(l.name_en || l.name_printed)} <a href="#" class="item-resolve" data-item="${l.line_no}" style="color:#d29922">resolve</a>`}
          <div style="font-size:0.85em;color:#6a7381">${mpEscapeHtml(l.name_printed)}</div></td>
        <td>${l.qty} ${l.unit}</td>
        <td>${l.unit_price_paid != null ? mpFormatCurrency(l.unit_price_paid, receipt.currency || r.ccy, true) : '—'}</td>
        <td>${mpFormatCurrency(l.line_total, receipt.currency || r.ccy, true)}</td>
        <td>${usdOf(Number(l.line_total))}</td>
        <td style="text-align:left">${l.is_other || receipt.source === 'apple' ? '' : `<select class="item-cat" data-item="${l.line_no}" title="The line's category; none: the purchase's" style="width:auto;color:${l.category ? '#c9d1d9' : '#6a7381'}"><option value="">${mpEscapeHtml(r.cat || '—')}</option>${MP_EXP_CATS.map(([name]) => `<option${name === l.category ? ' selected' : ''}>${mpEscapeHtml(name)}</option>`).join('')}</select>`}</td>
        <td class="item-note" data-item="${l.line_no}" style="cursor:pointer;color:#8b949e">${mpNoteHtml(l.note)}</td></tr>`;
    const form = mpDialog(`Items · ${r.day} · ${mpShortDesc(r.description)}`, `
      <p class="note" style="margin:0">${receipt.source === 'apple'
        ? `From Apple's purchase history · order ${mpEscapeHtml(receipt.key || '')}, ${mpEscapeHtml(receipt.day || '')}`
        : `${mpEscapeHtml(receipt.source === 'receipt_csv' ? 'From a receipt' : 'From the statement')}${receipt.chain ? ` · ${mpEscapeHtml(receipt.chain)}` : ''}${receipt.store ? ` · ${mpEscapeHtml(receipt.store)}` : ''}`}</p>
      <table class="data-table"><thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Price</th><th>Line</th><th>USD</th><th style="text-align:left">Category</th><th style="text-align:left">Note</th></tr></thead>
        <tbody>${real.map(lineRow).join('')}${other ? lineRow(other) : ''}</tbody></table>
      <label>Receipt note <input name="rnote" value="${mpEscapeHtml(receipt.note || '')}" style="${MP_FIELD}"></label>`);
    form.querySelector('[data-act=save]').textContent = 'Close';
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (form.rnote.value.trim() !== (receipt.note || '')) {
        await sb.from('receipts').update({ note: form.rnote.value.trim() || null }).eq('id', receipt.id);
        receipt.note = form.rnote.value.trim() || null;
      }
      form.closest('dialog').close();
    });
    // a line's own category (migration ...255): its share of the purchase moves there at once --
    // the database splits that one purchase again on the change (migration ...260)
    form.querySelectorAll('.item-cat').forEach(sel => sel.addEventListener('change', async () => {
      const lineNo = Number(sel.dataset.item);
      const line = receipt.lines.find(l => l.line_no === lineNo);
      const cat = sel.value || null;
      const { error } = await sb.from('receipt_items').update({ category: cat }).eq('receipt_id', receipt.id).eq('line_no', lineNo);
      if (error) { alert(error.message); sel.value = line?.category || ''; return; }
      if (line) line.category = cat;
      sel.style.color = cat ? '#c9d1d9' : '#6a7381';
      sel.title = 'Saved';
      mpReloadPeriodKeepingHistory();
    }));
    form.querySelectorAll('.item-note').forEach(cell => cell.addEventListener('click', async () => {
      const lineNo = Number(cell.dataset.item);
      const line = receipt.lines.find(l => l.line_no === lineNo);
      const text = prompt('Note', line?.note || '');
      if (text === null) return;
      const { error } = await sb.from('receipt_items').update({ note: text.trim() || null }).eq('receipt_id', receipt.id).eq('line_no', lineNo);
      if (error) { alert(error.message); return; }
      line.note = text.trim() || null;
      cell.innerHTML = mpNoteHtml(line.note);
    }));
    form.querySelectorAll('.item-resolve').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const lineNo = Number(a.dataset.item);
      const line = receipt.lines.find(l => l.line_no === lineNo);
      mpResolveProduct(receipt.id, lineNo, line.name_printed, line.name_en, receipt.chain, async () => {
        // the Resolve dialog has closed itself; the tab's data is re-read before the Items dialog
        // opens again, so the line shows its product and not "resolve"
        mpExpCache = null;
        const y = window.scrollY;
        await mpRenderExpenses();
        window.scrollTo(0, y);
        mpRenderProductList();
        mpEditItems(src, xid);
      });
    }));
    form.querySelectorAll('.item-product').forEach(a => a.addEventListener('click', e => { e.preventDefault(); mpOpenProductView(Number(a.dataset.pid)); }));
    form.querySelectorAll('.item-apple').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const line = receipt.lines.find(l => l.line_no === Number(a.dataset.item));
      if (line) mpOpenAppleHistory(line.name_printed, line.name_en);
    }));
    return;
  }

  // manual: an editable table, one row per line, kept in `draft` until Save.
  // No per-line notes here (those are only shown/edited on an already-saved
  // receipt's read-only view above) -- a manual re-save is a direct edit by
  // the user, not an import, so there's nothing that could silently clobber one.
  // the shared catalog offers its names as the item's suggestions (datalist);
  // a name typed exactly as a product's links the line to it
  const { data: catalogRows } = await sb.from('products').select('id, name_en').is('merged_into', null).order('name_en');
  const catalog = catalogRows || [];
  const productOf = name => catalog.find(c => c.name_en.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
  // what this user paid for each product (product_prices), newest first
  const { data: priceRows } = await sb.from('product_prices').select('product_id, day, store, currency, unit_price_paid').order('day', { ascending: false });
  // the price paid nearest in time to this row's day, in its own currency: the same shop first, else any shop
  const shopHere = (r.place?.name || '').split(' · ')[0].split(' ')[0].toLowerCase();
  const dayOf = Date.parse(r.day);
  const nearestPaid = pid => {
    const rows = (priceRows || []).filter(p => p.product_id === pid && p.currency === r.ccy)
      .sort((a, b) => Math.abs(Date.parse(a.day) - dayOf) - Math.abs(Date.parse(b.day) - dayOf));
    return rows.find(p => shopHere && (p.store || '').toLowerCase() === shopHere) || rows[0] || null;
  };
  // the computed "Other" line is not an item: it's the difference, not a row to save
  const draft = (receipt?.lines || []).filter(l => !l.is_other).map(l => ({ name: l.name_printed, productId: l.product_id ?? null, qty: l.qty, unit: l.unit, total: l.line_total }));
  const renderDraft = () => draft.map((d, i) => `<tr data-i="${i}">
      <td><input name="n" value="${mpEscapeHtml(d.name)}" placeholder="start typing a product…" autocomplete="off" style="${MP_FIELD}" required></td>
      <td style="white-space:nowrap"><input name="q" type="number" step="any" min="0.001" value="${d.qty}" style="${MP_FIELD};width:60px">${unit(d.unit)}</td>
      <td><input name="t" type="number" step="0.01" min="0" value="${d.total}" style="${MP_FIELD};width:80px"></td>
      <td><button type="button" class="item-del" data-i="${i}">✕</button></td></tr>`).join('');
  const form = mpDialog(`Items · ${r.day} · ${mpShortDesc(r.description)}`, `
    <p class="note" style="margin:0">No items yet -- add them by hand, or upload a receipt CSV (My Portfolio tab) made from the receipt's photo.</p>
    <table class="data-table"><thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Line total, ${r.ccy}</th><th></th></tr></thead>
      <tbody id="mp_items_draft">${renderDraft()}</tbody></table>
    <div id="mp_items_suggest" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    <button type="button" data-act="add-line">+ line</button>
    <p class="note" style="margin:0" id="mp_items_hint"></p>
    <p class="note" style="margin:0" id="mp_items_sum"></p>`);
  const body = form.querySelector('#mp_items_draft');
  const sumEl = form.querySelector('#mp_items_sum');
  const syncDraft = () => {
    draft.length = 0;
    body.querySelectorAll('tr').forEach(tr => {
      const name = tr.querySelector('[name=n]').value.trim();
      draft.push({
        name, productId: productOf(name), qty: Number(tr.querySelector('[name=q]').value) || 1,
        unit: tr.querySelector('[name=u]').value, total: Number(tr.querySelector('[name=t]').value) || 0,
      });
    });
    const sum = draft.reduce((a, d) => a + d.total, 0);
    const gap = r.amt - sum;
    sumEl.textContent = `Lines: ${sum.toFixed(2)} ${r.ccy} · transaction: ${Math.abs(r.amt).toFixed(2)} ${r.ccy}`
      + `${Math.abs(gap) >= 0.005 ? ` · left as "Other": ${(-gap).toFixed(2)}` : ''}`;
  };
  body.addEventListener('input', syncDraft);
  syncDraft();
  // a product picked from the suggestions: the nearest-in-time price in the hint, and the line
  // total as qty x that price -- only while the total is still empty or 0 (never over a typed one)
  const hintEl = form.querySelector('#mp_items_hint');
  const suggest = tr => {
    const pid = productOf(tr.querySelector('[name=n]').value);
    const near = pid ? nearestPaid(pid) : null;
    if (!near) { hintEl.textContent = ''; return; }
    const qty = Number(tr.querySelector('[name=q]').value) || 1;
    const price = Number(near.unit_price_paid);
    hintEl.textContent = `Paid nearest to this day: ${price.toFixed(2)} ${near.currency} per unit at ${near.store} (${near.day}).`;
    // the total is ours while it's empty, 0, or still the suggestion we last wrote (so a new qty recounts it);
    // a total the user typed is never touched
    const total = tr.querySelector('[name=t]');
    if (!total.value || Number(total.value) === 0 || total.value === total.dataset.suggested) {
      total.value = (qty * price).toFixed(2);
      total.dataset.suggested = total.value;
    }
    syncDraft();
  };
  body.addEventListener('input', e => { if (e.target.name === 'n') suggest(e.target.closest('tr')); });
  body.addEventListener('input', e => { if (e.target.name === 'q') suggest(e.target.closest('tr')); });
  // the catalog's names for the row being typed in, as buttons under the table (not a browser popup,
  // which covered the rows below and swallowed the clicks on their ✕)
  const suggestEl = form.querySelector('#mp_items_suggest');
  let activeTr = null;
  const showSuggestions = () => {
    if (!activeTr) { suggestEl.innerHTML = ''; return; }
    const typed = activeTr.querySelector('[name=n]').value.trim().toLowerCase();
    const found = catalog.filter(c => !typed || c.name_en.toLowerCase().includes(typed)).slice(0, 8);
    suggestEl.innerHTML = found.map(c => `<button type="button" class="item-suggest" data-name="${mpEscapeHtml(c.name_en)}" style="background:#13191f;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 8px;cursor:pointer">${mpEscapeHtml(c.name_en)}</button>`).join('');
  };
  body.addEventListener('focusin', e => { if (e.target.name === 'n') { activeTr = e.target.closest('tr'); showSuggestions(); } });
  body.addEventListener('input', e => { if (e.target.name === 'n') { activeTr = e.target.closest('tr'); showSuggestions(); } });
  suggestEl.addEventListener('click', e => {
    const pick = e.target.closest('.item-suggest');
    if (!pick || !activeTr) return;
    activeTr.querySelector('[name=n]').value = pick.dataset.name;
    suggest(activeTr);
    activeTr = null;
    suggestEl.innerHTML = '';
  });
  form.querySelector('[data-act=add-line]').addEventListener('click', () => {
    draft.push({ name: '', qty: 1, unit: 'pcs', total: 0, note: null });
    body.innerHTML = renderDraft();
    syncDraft();
  });
  // ✕ takes the row out of the table itself; the sums are then counted from the rows left on screen
  body.addEventListener('click', e => {
    const del = e.target.closest('.item-del');
    if (!del) return;
    del.closest('tr').remove();
    syncDraft();
  });
  const saveBtn = form.querySelector('[data-act=save]');
  let busy = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;   // a second click while the first is still writing would make a second receipt
    busy = true;
    saveBtn.disabled = true;
    let done = false;
    try {
      syncDraft();
      const lines = draft.filter(d => d.name && d.total > 0);
      if (!lines.length) {
        // every row taken out: a manual receipt goes (its lines with it); nothing was saved to remove
        // otherwise, and the rows came back on the next open
        if (receipt?.source === 'manual') {
          const { error: dErr } = await sb.from('receipts').delete().eq('id', receipt.id);
          if (dErr) { alert(dErr.message); return; }
          if (mpExpCache) mpExpCache.receiptOf.delete(`${src}|${xid}`);
          document.querySelectorAll('#expenses .exp-items').forEach(c => {
            if (c.dataset.src === src && c.dataset.xid === xid) c.innerHTML = mpItemsHtml(undefined);
          });
        }
        done = true;
        form.closest('dialog').close();
        return;
      }
      const total = Math.abs(r.amt);
      let receiptId = receipt?.id;
      if (receiptId) {
        await sb.from('receipts').update({ purchased_on: r.day, currency: r.ccy, total, updated_at: new Date().toISOString() }).eq('id', receiptId);
        await sb.from('receipt_items').delete().eq('receipt_id', receiptId);
      } else {
        const { data, error } = await sb.from('receipts').insert({
          source: 'manual', receipt_key: crypto.randomUUID(), tx_source: src, tx_external_id: xid,
          match_state: 'manual_link', purchased_on: r.day, currency: r.ccy, total,
        }).select('id').single();
        if (error) { alert(error.message); return; }
        receiptId = data.id;
      }
      // a typed name with no product picked: the product of the same English name, if there is one
      const { data: known } = await sb.from('products').select('id, name_en').is('merged_into', null);
      const byName = new Map((known || []).map(p => [mpReceiptNorm(p.name_en), p.id]));
      const { error: itemsErr } = await sb.from('receipt_items').insert(lines.map((d, i) => ({
        receipt_id: receiptId, line_no: i + 1, name_printed: d.name, name_en: d.name,
        product_id: d.productId ?? byName.get(mpReceiptNorm(d.name)) ?? null, qty: d.qty, unit: d.unit, line_total: d.total,
      })));
      if (itemsErr) { alert(itemsErr.message); return; }
      done = true;
      // the row shows the saved items at once; the tab's data re-loads in the background (the full
      // load is slow, and the dialog and the row must not wait for it)
      if (mpExpCache) {
        mpExpCache.receiptOf.set(`${src}|${xid}`, {
          id: receiptId, source: 'manual', chain: null, store: null, currency: r.ccy, note: receipt?.note ?? null,
          lines: lines.map((d, i) => ({ line_no: i + 1, name_printed: d.name, name_en: d.name, product_id: d.productId ?? null,
            qty: d.qty, unit: d.unit, unit_price_paid: null, line_total: d.total, note: null, is_other: false })),
        });
      }
      document.querySelectorAll('#expenses .exp-items').forEach(c => {
        if (c.dataset.src === src && c.dataset.xid === xid) c.innerHTML = mpItemsHtml(mpExpCache?.receiptOf?.get(`${src}|${xid}`));
      });
      form.closest('dialog').close();
      mpExpCache = null;   // the next render re-loads the tab; the row above is already right
      mpRenderExpenses().catch(() => { /* the tab shows its own error */ });
    } finally {
      if (!done) { busy = false; saveBtn.disabled = false; }
    }
  });
}
// A product of this English name: an existing one (any case, not merged) is
// reused rather than made twice; a new one gets the barcode only if no product
// has it yet -- one barcode, one product (migration ...180's unique index).
async function mpFindOrCreateProduct(name, barcode) {
  // ilike's wildcards escaped; the exact lower-case comparison below drops anything a stray "*" widened
  const like = name.replace(/[\\%_]/g, '\\$&');
  const { data: same, error: fErr } = await sb.from('products').select('id, name_en').ilike('name_en', like).is('merged_into', null).order('id').limit(20);
  if (fErr) throw new Error(fErr.message);
  const found = (same || []).find(p => p.name_en.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  let code = barcode || null;
  if (code) {
    const { data: used, error: bErr } = await sb.from('products').select('id').eq('barcode', code).is('merged_into', null).limit(1);
    if (bErr) throw new Error(bErr.message);
    if (used?.length) code = null;
  }
  let { data, error } = await sb.from('products').insert(code ? { name_en: name, barcode: code } : { name_en: name }).select('id').single();
  // someone took the barcode between the check and the insert: the product is made without it
  if (error && code && error.code === '23505') ({ data, error } = await sb.from('products').insert({ name_en: name }).select('id').single());
  if (error) throw new Error(error.message);
  return data.id;
}
// Candidates for a line with no product yet (suggest_products: aliases and
// product names close to what's printed, never linking by itself). Picking
// one, or typing a new product's name, writes a confirmed alias (so the
// same printed name links by itself next time) and the line's product_id.
// Save is locked while it writes and a second submit is ignored (two quick
// clicks made two products); onDone runs after the dialog has closed.
async function mpResolveProduct(receiptId, lineNo, namePrinted, nameEn, chain, onDone) {
  const { data: suggestions, error } = await sb.rpc('suggest_products', { p_name: namePrinted, p_name_en: nameEn, p_chain: chain || null });
  if (error) { alert(error.message); return; }
  // the line's own barcode (receipt_lines has none): kept on a product made here
  const { data: lineRow } = await sb.from('receipt_items').select('barcode').eq('receipt_id', receiptId).eq('line_no', lineNo).maybeSingle();
  const barcode = (lineRow?.barcode || '').trim() || null;
  const seen = new Set();
  const uniq = (suggestions || []).filter(s => (seen.has(s.product_id) ? false : (seen.add(s.product_id), true)));
  const form = mpDialog(`Resolve · ${nameEn || namePrinted}`, `
    <p class="note" style="margin:0">${mpEscapeHtml(namePrinted)}</p>
    <select name="pick" style="${MP_FIELD}">
      <option value="new">+ new product…</option>
      ${uniq.map(s => `<option value="${s.product_id}">${mpEscapeHtml(s.name_en)} (${Math.round(s.score * 100)}% match, ${s.via})</option>`).join('')}
    </select>
    <input name="newname" placeholder="new product's English name" value="${mpEscapeHtml(nameEn || namePrinted)}" style="${MP_FIELD}">`);
  const saveBtn = form.querySelector('[data-act=save]');
  let busy = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    saveBtn.disabled = true;
    let done = false;
    try {
      let productId = form.pick.value === 'new' ? null : Number(form.pick.value);
      if (!productId) {
        const name = form.newname.value.trim();
        if (!name) return;
        productId = await mpFindOrCreateProduct(name, barcode);
      }
      const { error: aErr } = await sb.from('product_aliases')
        .upsert({ product_id: productId, name_printed: namePrinted, name_norm: mpReceiptNorm(namePrinted), chain: chain || '' }, { onConflict: 'name_norm,chain' });
      if (aErr) throw new Error(aErr.message);
      const { error: iErr } = await sb.from('receipt_items').update({ product_id: productId }).eq('receipt_id', receiptId).eq('line_no', lineNo);
      if (iErr) throw new Error(iErr.message);
      done = true;
    } catch (err) {
      alert(err.message);
    } finally {
      if (!done) { busy = false; saveBtn.disabled = false; }
    }
    if (!done) return;
    form.closest('dialog').close();
    await onDone();
  });
}
// A product's own dialog (migration ...179, ...180): its brand, size and
// description to edit; the price history -- the comparison by country, city
// and shop in dollars at each day's rate, a line per shop on the chart, in
// its own currency with a USD toggle; and merge/undo at the bottom -- two
// products found to be the same point one at the other (merged_into), never
// rewriting their lines, so undoing it (merged_into back to null) restores
// the history exactly as it was.
async function mpOpenProductView(productId) {
  const baseCols = 'day, place_id, chain, currency, qty, unit, unit_price_paid, unit_price_usd';
  const priceQ = cols => sb.from('product_prices').select(cols).eq('product_id', productId).order('day');
  const [{ data: product }, priced, cmp] = await Promise.all([
    sb.from('products').select('id, name_en, brand, size_value, size_unit, note, category, merged_into').eq('id', productId).single(),
    priceQ(`${baseCols}, country, city, store`),
    sb.from('product_price_compare').select('country, city, store, purchases, min_usd, max_usd, last_usd, last_day').eq('product_id', productId).order('last_usd'),
  ]);
  // migration ...180 (country, city, store, the comparison view) not applied yet: the older columns alone
  const rows = priced.error ? ((await priceQ(baseCols)).data || []) : (priced.data || []);
  const compare = cmp.error ? [] : (cmp.data || []);
  const dlg = document.createElement('dialog');
  dlg.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:16px 18px;min-width:320px;max-width:min(92vw,720px)';
  const usdToggle = `<label><input type="checkbox" id="mp_prod_usd"> show in USD</label>`;
  const currencies = [...new Set(rows.map(r => r.currency))];
  const sizeUnits = ['g', 'kg', 'ml', 'l', 'pcs'];
  dlg.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b>${mpEscapeHtml(product?.name_en || '?')}</b><button type="button" data-act="close">✕</button></div>
    <div style="display:flex;gap:8px">
      <label style="flex:1">Brand <input name="brand" value="${mpEscapeHtml(product?.brand || '')}" style="${MP_FIELD}"></label>
      <label style="flex:1">Size <span style="display:flex;gap:6px"><input name="size" type="number" step="any" min="0" value="${product?.size_value != null ? Number(product.size_value) : ''}" style="${MP_FIELD}">
        <select name="sunit" style="${MP_FIELD};width:auto"><option value="">—</option>${sizeUnits.map(u => `<option${u === product?.size_unit ? ' selected' : ''}>${u}</option>`).join('')}</select></span></label>
    </div>
    <label>Category <select name="category" style="${MP_FIELD}"><option value="">—</option>${MP_EXP_CATS.map(([name]) => `<option${name === product?.category ? ' selected' : ''}>${mpEscapeHtml(name)}</option>`).join('')}</select></label>
    <label>Description <textarea name="note" rows="2" style="${MP_FIELD}">${mpEscapeHtml(product?.note || '')}</textarea></label>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-act="details">Save details</button></div>
    ${usdToggle}
    <div id="mp_prod_chart" style="height:280px"></div>
    <p class="note" style="margin:0">Compared in dollars at each day's rate: the last price paid in each shop, by country and city.</p>
    <table class="data-table"><thead><tr><th style="text-align:left">Country</th><th style="text-align:left">City</th><th style="text-align:left">Shop</th><th>Last</th><th>Lowest</th><th>Highest</th><th>Purchases</th></tr></thead>
      <tbody>${compare.map(c => `<tr><td style="text-align:left">${mpEscapeHtml(c.country || '—')}</td><td style="text-align:left">${mpEscapeHtml(c.city || '—')}</td><td style="text-align:left">${mpEscapeHtml(c.store || '—')}</td>
        <td>$${Number(c.last_usd).toFixed(2)}</td><td>$${Number(c.min_usd).toFixed(2)}</td><td>$${Number(c.max_usd).toFixed(2)}</td><td>${c.purchases}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-note">No purchases yet.</td></tr>'}</tbody></table>
    <table class="data-table"><thead><tr><th>Date</th><th style="text-align:left">Shop</th><th style="text-align:left">Where</th><th>Qty</th><th>Price</th><th>USD</th></tr></thead>
      <tbody>${rows.slice().reverse().map(r => `<tr><td>${r.day}</td><td style="text-align:left">${mpEscapeHtml(r.store || r.chain || '')}</td><td style="text-align:left">${mpEscapeHtml([r.city, r.country].filter(Boolean).join(', '))}</td><td>${r.qty} ${r.unit}</td>
        <td>${mpFormatCurrency(r.unit_price_paid, r.currency, true)}</td><td>$${Number(r.unit_price_usd).toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-note">No purchases yet.</td></tr>'}</tbody></table>
    <label>Merge into product id <input name="mergeInto" type="number" style="${MP_FIELD};width:120px" value="${product?.merged_into ?? ''}"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-act="merge">Save merge</button></div>
  </div>`;
  document.body.appendChild(dlg);
  // opened before the chart is drawn (Plotly measures a closed dialog as empty); removed however it's closed (Esc too)
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  dlg.querySelector('[data-act=close]').onclick = () => dlg.close();
  const draw = () => {
    const usd = dlg.querySelector('#mp_prod_usd').checked;
    const traces = (currencies.length > 1 || usd ? currencies : [currencies[0]]).filter(Boolean).map(c => {
      const pts = rows.filter(r => usd || r.currency === c);
      return { x: pts.map(r => r.day), y: pts.map(r => usd ? r.unit_price_usd : r.unit_price_paid),
        name: usd ? 'USD' : c, mode: 'lines+markers', type: 'scatter' };
    });
    Plotly.react(dlg.querySelector('#mp_prod_chart'), usd ? [traces[0] || { x: [], y: [] }] : traces, {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#c9d1d9' },
      margin: { l: 45, r: 10, t: 10, b: 30 }, showlegend: traces.length > 1,
    }, { ...CONFIG, displayModeBar: false });
  };
  dlg.querySelector('#mp_prod_usd').addEventListener('change', draw);
  draw();
  // brand, size (value + unit, both or neither) and description: any signed-in
  // user may edit the shared catalog (migration ...180's update policy)
  const detailsBtn = dlg.querySelector('[data-act=details]');
  detailsBtn.addEventListener('click', async () => {
    const sizeRaw = dlg.querySelector('[name=size]').value.trim();
    const unit = dlg.querySelector('[name=sunit]').value || null;
    const size = sizeRaw === '' ? null : Number(sizeRaw);
    if (size !== null && (!Number.isFinite(size) || size <= 0)) { alert('The size must be a number above zero.'); return; }
    if (size !== null && !unit) { alert('Pick the size\'s unit.'); return; }
    detailsBtn.disabled = true;
    const { error } = await sb.from('products').update({
      brand: dlg.querySelector('[name=brand]').value.trim() || null,
      size_value: size, size_unit: size === null ? null : unit,
      category: dlg.querySelector('[name=category]').value || null,
      note: dlg.querySelector('[name=note]').value.trim() || null,
    }).eq('id', productId);
    detailsBtn.disabled = false;
    if (error) { alert(error.message); return; }
    detailsBtn.textContent = 'Saved ✓';
    setTimeout(() => { detailsBtn.textContent = 'Save details'; }, 1500);
    mpRenderProductList();
  });
  dlg.querySelector('[data-act=merge]').addEventListener('click', async () => {
    const v = dlg.querySelector('[name=mergeInto]').value.trim();
    const mergedInto = v ? Number(v) : null;
    if (mergedInto === productId) { alert("A product can't merge into itself."); return; }
    // the database refuses a chain or a loop (migration ...180's trigger): its message is shown as it is
    const { error } = await sb.from('products').update({ merged_into: mergedInto }).eq('id', productId);
    if (error) { alert(error.message); return; }
    mpExpCache = null;
    mpRenderProductList();
    dlg.close();
  });
}
// The category of a row, set by hand (expense_manual): it stays on re-uploads (manual_categories).
function mpEditCategory(src, xid) {
  // the purchase's own rows: not its lines split off by category (migration ...255), not what
  // the exchange lost on it (Fees), not a refund of it -- those keep theirs
  const rows = mpExpRowsOf(src, xid).filter(x => x.id != null && !x.split && !/^(Lost on the exchange|Refund): /.test(x.description || ''));
  const r = rows[0];
  if (!r) return;
  const opts = MP_EXP_CATS.map(([name]) => `<option${name === r.cat ? ' selected' : ''}>${mpEscapeHtml(name)}</option>`).join('');
  const form = mpDialog(`Category · ${r.day} · ${mpShortDesc(r.description)}`, `
    <select name="cat" size="10" style="${MP_FIELD}">${opts}</select>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const cat = form.cat.value;
    const { error } = await sb.from('bank_transactions').update({ expense_category: cat, expense_manual: true })
      .eq('external_source', src).eq('external_id', xid);
    if (error) { alert(error.message); return; }
    // the expenses tab's own copy too (refresh_expenses sets it the same way): without it
    // a reload showed the old category until the next run (16.11.2026)
    const { error: eErr } = await sb.from('expenses').update({ category: cat }).in('id', rows.map(x => x.id));
    if (eErr) { alert(eErr.message); return; }
    rows.forEach(x => { x.cat = cat; });
    form.closest('dialog').close();
    // the rows already on screen take the new category; the tab's totals re-count from the cache
    await mpRenderExpenses();
  });
}
// The account of a purchase that didn't come from a bank statement (a receipt's
// own row, account '<unknown>' until set): the accounts the tab already has.
// A statement's row keeps its bank's account.
function mpEditAccount(src, xid) {
  const rows = mpExpRowsOf(src, xid);
  const r = rows[0];
  if (!r) return;
  const accounts = [...new Set([...(mpExpCache?.spent || []), ...(mpExpCache?.skipped || [])].map(x => x.account).filter(a => a && a !== '<unknown>'))].sort();
  const opts = ['<unknown>', ...accounts].map(a => `<option${a === r.account ? ' selected' : ''}>${mpEscapeHtml(a)}</option>`).join('');
  const form = mpDialog(`Account · ${r.day} · ${mpShortDesc(r.description)}`, `
    <select name="account" size="10" style="${MP_FIELD}">${opts}</select>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const account = form.account.value;
    const { error } = await sb.from('bank_transactions').update({ account }).eq('external_source', src).eq('external_id', xid);
    if (error) { alert(error.message); return; }
    // the expenses tab's own copy of the account (refresh_expenses sets it the same way)
    const { error: eErr } = await sb.from('expenses').update({ account }).eq('external_source', src).eq('external_id', xid);
    if (eErr) { alert(eErr.message); return; }
    rows.forEach(x => { x.account = account; });
    form.closest('dialog').close();
    await mpRenderExpenses();
  });
}
// A transfer linked by hand: one row out with the rows in it was given back in
// (several in rows for one out, as the manual pairs of migration ...187 allow).
// The link icon on a row opens the rows opposite to it within 7 days.
function mpLinkHtml(r) {
  return r.src ? `<span class="exp-link" data-src="${mpEscapeHtml(r.src)}" data-xid="${mpEscapeHtml(r.xid || '')}" title="Link a transfer" style="cursor:pointer;color:#8b949e">🔗</span>` : '';
}
async function mpLinkTransfer(src, xid) {
  // the expenses' amounts are money out, positive (legRow shows them with a minus); the income's are in
  const all = [...(mpExpCache?.spent || []).map(r => [r, -1]), ...(mpExpCache?.skipped || []).map(r => [r, -1]),
    ...(mpExpCache?.incomeRows || []).map(r => [r, 1])];
  const seen = new Map();
  for (const [r, sign] of all) {
    const key = `${r.src}|${r.xid}`;
    if (!seen.has(key)) seen.set(key, { ref: r, src: r.src, xid: r.xid, day: r.day, desc: r.description || '', amt: sign * Math.abs(Number(r.amt ?? r.amount)),
      usd: sign * Math.abs(Number(r.usd)), ccy: r.ccy ?? r.currency, at: r.at || '' });
  }
  const me = seen.get(`${src}|${xid}`);
  if (!me) return;
  // linked in rows are taken; out rows may take several in rows
  const takenIn = new Set((mpExpCache?.pairs || []).map(p => `${p.in_source}|${p.in_id}`));
  const dayNum = d => Date.parse(`${d}T00:00:00Z`);
  const cands = [...seen.values()].filter(c => c.src !== me.src || c.xid !== me.xid)
    .filter(c => (c.amt < 0 || !takenIn.has(`${c.src}|${c.xid}`))
      && Math.abs(dayNum(c.day) - dayNum(me.day)) <= 7 * 86400000)
    .sort((a, b) => Math.abs(dayNum(a.day) - dayNum(me.day)) - Math.abs(dayNum(b.day) - dayNum(me.day)));
  const list = cands.map((c, i) => `<label style="display:flex;gap:8px;align-items:center">
    <input type="checkbox" name="pick" value="${i}"><span>${c.day} ${mpEscapeHtml(mpShortDesc(c.desc))} · ${c.amt.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${mpEscapeHtml(c.ccy || '')}</span></label>`).join('')
    || '<p class="empty-note">No rows within 7 days.</p>';
  const form = mpDialog(`Link · ${me.day} · ${mpShortDesc(me.desc)} · ${me.amt.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${mpEscapeHtml(me.ccy || '')}`,
    `<div style="max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:6px">${list}</div>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    // the group: this row and the picked ones -- every money out with every money in
    // (a pair per combination; each pair is one out row and one in row)
    const group = [me, ...[...form.querySelectorAll('input[name=pick]:checked')].map(box => cands[Number(box.value)])];
    const outs = group.filter(r => r.amt < 0), ins = group.filter(r => r.amt > 0);
    if (!outs.length || !ins.length) { alert('Pick at least one row out and one row in.'); return; }
    const { data: { session: s } } = await sb.auth.getSession();
    const when = r => (r.at ? `${r.day}T${r.at}:00Z` : `${r.day}T00:00:00Z`);
    const payload = outs.flatMap(o => ins.map(i => ({ user_id: s.user.id, out_source: o.src, out_id: o.xid, in_source: i.src, in_id: i.xid,
        amount: Math.abs(o.amt), currency: o.ccy, out_at: when(o), in_at: when(i), matched_by: 'manual', kind: 'transfer' })));
    const { error } = await sb.from('internal_transfers').insert(payload);
    if (error) { alert(error.message); return; }
    // a linked money out is not spending: its category becomes "Own accounts" (as the pairs' own), so it leaves the expenses
    for (const o of outs) {
      const { error: cErr } = await sb.from('bank_transactions').update({ expense_category: 'Own accounts', expense_manual: true })
        .eq('external_source', o.src).eq('external_id', o.xid);
      if (cErr) { alert(cErr.message); return; }
      const { error: eErr } = await sb.from('expenses').update({ category: 'Own accounts' }).eq('external_source', o.src).eq('external_id', o.xid);
      if (eErr) { alert(eErr.message); return; }
    }
    form.closest('dialog').close();
    // on screen at once: the group's rows leave the expenses and the income and
    // show as pairs under "Not counted" (the cache; the rebuild brings the same from the database)
    const gone = new Set(group.map(g => `${g.src}|${g.xid}`));
    const keep = list => list.filter(r => !gone.has(`${r.src}|${r.xid}`));
    if (mpExpCache) {
      mpExpCache.spent = keep(mpExpCache.spent || []);
      mpExpCache.skipped = keep(mpExpCache.skipped || []);
      mpExpCache.incomeRows = keep(mpExpCache.incomeRows || []);
      mpExpCache.pairs = [...(mpExpCache.pairs || []), ...outs.flatMap(o => ins.map((i, k) => ({
        pair_id: -(Date.now() + k), kind: 'transfer', category: o.ref?.cat || 'Own accounts',
        out_source: o.src, out_id: o.xid, out_day: o.day, out_account: o.ref?.account || '', out_description: o.desc,
        out_amount: o.amt, out_currency: o.ccy, out_usd: o.usd,
        in_source: i.src, in_id: i.xid, in_day: i.day, in_account: i.ref?.account || '', in_description: i.desc,
        in_amount: i.amt, in_currency: i.ccy, in_usd: i.usd,
      })))];
    }
    await sb.rpc('request_my_capital_refresh');
    await mpRenderExpenses();
  });
}
// The type of one's own money coming in (bank_transactions.income_category): set by
// hand it is kept through the rules' rebuilds (income_manual), like an expense's category.
function mpEditIncomeType(src, xid) {
  const rows = (mpExpCache?.incomeRows || []).filter(r => r.src === src && r.xid === xid);
  const r = rows[0];
  if (!r) return;
  const opts = Object.keys(MP_INCOME_COLORS).map(name => `<option${name === r.category ? ' selected' : ''}>${mpEscapeHtml(name)}</option>`).join('');
  const form = mpDialog(`Type · ${r.day} · ${mpShortDesc(r.description)}`, `
    <select name="type" size="6" style="${MP_FIELD}">${opts}</select>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const type = form.type.value;
    const { error } = await sb.from('bank_transactions').update({ income_category: type, income_manual: true })
      .eq('external_source', src).eq('external_id', xid);
    if (error) { alert(error.message); return; }
    rows.forEach(x => { x.category = type; });
    form.closest('dialog').close();
    // the income table is rebuilt by the next capital refresh (the rules' step)
    await sb.rpc('request_my_capital_refresh');
    await mpRenderExpenses();
  });
}
document.getElementById('expenses').addEventListener('click', e => {
  if (!mpIsSignedIn || e.target.closest('a')) return;
  const catCell = e.target.closest('.exp-cat-set');
  if (catCell?.dataset.split) { e.stopPropagation(); mpEditItems(catCell.dataset.src, catCell.dataset.xid); return; }
  if (catCell?.dataset.src) { e.stopPropagation(); mpEditCategory(catCell.dataset.src, catCell.dataset.xid); return; }
  const link = e.target.closest('.exp-link');
  if (link?.dataset.src) { e.stopPropagation(); mpLinkTransfer(link.dataset.src, link.dataset.xid); return; }
  const incCell = e.target.closest('.inc-cat-set');
  if (incCell?.dataset.src) { e.stopPropagation(); mpEditIncomeType(incCell.dataset.src, incCell.dataset.xid); return; }
  const time = e.target.closest('.exp-time');
  if (time) { e.stopPropagation(); mpEditTime(time.dataset.src, time.dataset.xid); return; }
  const place = e.target.closest('.exp-place');
  if (place?.dataset.src) { e.stopPropagation(); mpEditPlace(place.dataset.src, place.dataset.xid); }
  const items = e.target.closest('.exp-items');
  if (items?.dataset.src) { e.stopPropagation(); mpEditItems(items.dataset.src, items.dataset.xid); }
  const account = e.target.closest('.exp-account');
  if (account?.dataset.src) { e.stopPropagation(); mpEditAccount(account.dataset.src, account.dataset.xid); }
});
// A note on a row out or in, written in the expenses tab's tables: saved to the row
// itself (bank_transactions.expense_note) and kept in the tab's cache.
document.getElementById('expenses').addEventListener('click', async e => {
  if (e.target.closest('.exp-note a')) return;
  const cell = e.target.closest('.exp-note');
  if (!cell || !cell.dataset.src || !mpIsSignedIn) return;
  e.stopPropagation();
  const { src, xid } = cell.dataset;
  const all = [...(mpExpCache?.spent || []), ...(mpExpCache?.skipped || []), ...(mpExpCache?.incomeRows || [])].filter(r => r.src === src && r.xid === xid);
  const text = prompt('Note', all[0]?.note || '');
  if (text === null) return;
  // a Google Maps link in it is the row's place, taken out of the note's text
  const link = text.match(/https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\/[^\s)]+/);
  const found = link && mpPlaceFromLink(link[0]);
  const note = (found ? text.replace(`(${link[0]})`, '').replace(link[0], '').replace(/\s{2,}/g, ' ') : text).trim() || null;
  const patch = { expense_note: note };
  if (found) {
    // the same place again (by Google's id) is the same row of places
    const { data: place, error: pErr } = found.google_id
      ? await sb.from('places').upsert(found, { onConflict: 'user_id,google_id' }).select('id').single()
      : await sb.from('places').insert(found).select('id').single();
    if (pErr) { alert(pErr.message); return; }
    patch.place_id = place.id;
  }
  const { error } = await sb.from('bank_transactions').update(patch).eq('external_source', src).eq('external_id', xid);
  if (error) { alert(error.message); return; }
  all.forEach(r => { r.note = note; if (found) r.place = { name: found.name, url: found.url }; });
  document.querySelectorAll('#expenses .exp-note, #expenses .exp-place').forEach(c => {
    if (c.dataset.src === src && c.dataset.xid === xid) c.innerHTML = c.classList.contains('exp-place') ? mpPlaceHtml(all[0]?.place, all[0]?.deliveredTo) : mpNoteHtml(note);
  });
});
document.getElementById('exp_life').addEventListener('change', e => {
  const p = mpExpCache?.periods[e.target.value];
  if (!p) return;
  const end = p.end_day ?? new Date().toISOString().slice(0, 10);
  document.getElementById('exp_period').value = 'custom';
  document.getElementById('exp_from').value = p.start_day;
  document.getElementById('exp_to').value = end;
  mpRenderExpenses();
});
let mpExpFull = false;
// the rest of the history, in a few spans of years, after the period on screen is
// shown: each span is merged into the cache and the page drawn again, so the charts
// fill in as the rows come (the figures are the same as one whole load gives)
// The latest years first: this month's forecast on the chart over time reads its
// rows by day. The last span runs on past this year -- rent paid ahead is booked
// in the months it's for (day), next year's too.
// how many months back are loaded one by one after the current one
const MP_EXP_MONTH_SPANS = 3;
async function mpExpLoadRest() {
  const cache = mpExpCache;
  try {
    // the months back from the current one, one by one (the previous month first: it is
    // the one a person looks at next), then the older history by spans of three years
    const now = new Date();
    const monthStart = k => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    const iso = d => d.toISOString().slice(0, 10);
    const spans = [];
    // this month on, to the end: the forecast of this month reads its rows up to the end (rows paid ahead)
    spans.push([iso(monthStart(0)), '9999-12-31']);
    for (let k = 1; k <= MP_EXP_MONTH_SPANS; k++) spans.push([iso(monthStart(k)), iso(new Date(monthStart(k - 1) - 86400000))]);
    // the older history, up to the day before the last month span, by spans of three years, the newer first
    let end = new Date(monthStart(MP_EXP_MONTH_SPANS) - 86400000);
    while (end.getUTCFullYear() >= 1900) {
      const y = end.getUTCFullYear();
      spans.push([`${Math.max(1900, y - 2)}-01-01`, iso(end)]);
      end = new Date(Date.UTC(y - 3, 11, 31));
    }
    for (const [from, to] of spans) {
      const part = await mpExpLoadFresh({ from, to });
      // the tab re-loaded meanwhile (an upload, a category set): this load is over
      if (mpExpCache !== cache) return;
      mpMergeExpCache(part);
      // drawn again only while the period on screen still has parts not loaded
      const want = { from: document.getElementById('exp_from').value, to: document.getElementById('exp_to').value };
      if (!mpExpCovers(want)) await mpRenderExpenses();
    }
    mpExpFull = true;
    // the calendar modes are drawn already and do not change with the history: only the note goes
    if (/_td$/.test(document.getElementById('exp_step').value)) await mpRenderExpenses();
    else document.getElementById('exp_status').textContent = '';
  } catch (error) {
    document.getElementById('exp_status').textContent = error.message;
  }
}
// The chart over time's monthly sums (month_totals, migration ...190: kept by the
// edge function month_totals every 5 minutes), the whole history -- a few
// thousand rows. Expenses by month of day ('day') and of paid_day ('paid'), the
// income by month as mpExpIncomeDays spreads it, in dollars, euros and roubles
// (each row at its own day's rate), each group's first day.
async function mpExpLoadTotals() {
  return mpFetchAll(() => sb.from('month_totals')
    .select('kind, basis, month, category, account, counted, extrapolated, usd, eur, rub, first_day')
    .order('kind').order('basis').order('month').order('category').order('account').order('counted').order('extrapolated'));
}
// adds one span's rows to the cache: rows already there (the period on screen) are kept once
// The periods re-read after an upload. refresh_expenses rebuilds the expenses table, so its
// rows come back with new ids: a load begun before the upload (the rest of the history in the
// background) has the old ids, and merged by id they showed every row of the period twice
// (26.11.2026). Such a load leaves out the days re-read since it began: they are fresh already.
const mpExpReloaded = [];
function mpExpLoadFresh(range) {
  const seen = mpExpReloaded.length;
  return mpExpLoad(range).then(part => {
    const since = mpExpReloaded.slice(seen);
    if (!since.length) return part;
    const fresh = r => since.some(p => r.day >= p.from && r.day <= p.to);
    return { ...part, spent: part.spent.filter(r => !fresh(r)), skipped: part.skipped.filter(r => !fresh(r)),
      incomeRows: (part.incomeRows || []).filter(r => !fresh(r)) };
  });
}
function mpMergeExpCache(part) {
  const cur = mpExpCache;
  const union = (a, b, key) => {
    const m = new Map();
    for (const r of [...a, ...b]) m.set(key(r), r);
    return [...m.values()];
  };
  const byDay = (x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0);
  const rowKey = r => `${r.src}|${r.xid}`;
  // expenses by their id: a payment and its fee, the shares of a rent paid ahead
  // have one src|xid (268 payments) -- by it one of them was lost
  cur.spent = union(cur.spent, part.spent, r => r.id).sort(byDay);
  cur.skipped = union(cur.skipped, part.skipped, r => r.id).sort(byDay);
  cur.incomeRows = union(cur.incomeRows, part.incomeRows, rowKey).sort(byDay);
  cur.incomeDays = mpExpIncomeDays(cur.incomeRows);
  cur.pairs = union(cur.pairs, part.pairs, p => `${p.pair_id}`);
  cur.unpairedIn = union(cur.unpairedIn || [], part.unpairedIn || [], r => `${r.external_source}|${r.external_id}`);
  cur.clockOf = new Map([...(cur.clockOf || []), ...(part.clockOf || [])]);
  cur.usdPer = part.usdPer;
  cur.periods = part.periods;
  cur.placeList = part.placeList;
  cur.receiptOf = part.receiptOf;
  cur.incomeExpect = part.incomeExpect;
  cur.chainOf = part.chainOf;
  // the spans of rows loaded: this month's forecast reads its days' rows only once they're all there
  cur.loaded = [...(cur.loaded || [cur.range]), part.range];
}
// whether the rows of a period are in the cache: the period of the first load or a loaded span
function mpExpCovers(w) {
  return [mpExpCache.range, ...(mpExpCache.loaded || [])].some(s => s && s.from <= w.from && s.to >= w.to);
}
// A receipt CSV's rows, read in the browser while the server still writes them: the
// Expenses tab shows them at once (pending, no id yet); the server's answer reloads the
// tab from the database, and a failed upload takes them off again (mpDropPendingReceipts).
function mpCsvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, '').trim().toLowerCase());
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i].trim()])));
}
function mpPendingRerender() {
  if (document.getElementById('expenses')?.offsetParent) mpRenderExpenses().catch(() => { /* the tab shows its own error */ });
}
function mpShowPendingReceipts(text) {
  if (!mpExpCache) return;   // the tab not loaded yet: its first load reads the database
  const byId = new Map();
  for (const r of mpCsvRows(text)) {
    if (!r.receipt || !r.date) continue;
    const xid = `${r.date}|${r.receipt}|${Number(r.total)}`;   // the same key the server stores
    if (byId.has(xid)) continue;
    const amt = Number(r.total);
    const usd = typeof mpExpCache.usdPer === 'function' ? mpExpCache.usdPer(r.currency, r.date) * amt : NaN;
    byId.set(xid, { id: null, day: r.date, paid_day: r.date, tx_date: r.date, at: r.time || '', ts: r.date,
      account: '<unknown>', description: r.chain || r.store, amt, ccy: r.currency, usd, cat: null,
      counted: true, extrapolated: false, note: null, src: 'receipt_csv', xid, pending: true });
  }
  const kept = mpExpCache.spent.filter(x => !x.pending);
  mpExpCache.spent = [...kept, ...byId.values()].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  mpPendingRerender();
}
// Re-reads the period on screen after a receipt upload and puts its rows in place of the
// cached ones; the rest of the loaded history stays, so the forecast isn't waiting for a full reload.
async function mpReloadPeriodKeepingHistory() {
  const cache = mpExpCache;
  if (!cache) return;   // not loaded yet: the tab's first load reads the database
  const from = document.getElementById('exp_from').value, to = document.getElementById('exp_to').value;
  const inPeriod = r => r.day >= from && r.day <= to;
  mpExpReloaded.push({ from, to });
  try {
    const part = await mpExpLoad({ from, to });
    if (mpExpCache !== cache) return;   // the tab re-loaded meanwhile
    cache.spent = cache.spent.filter(r => !inPeriod(r) && !r.pending);
    cache.skipped = cache.skipped.filter(r => !inPeriod(r));
    cache.incomeRows = (cache.incomeRows || []).filter(r => !inPeriod(r));
    mpMergeExpCache(part);
    // the monthly sums the chart and the forecast's actuals read: re-read with the rows
    cache.totals = await mpExpLoadTotals().catch(() => cache.totals);
    mpPendingRerender();
  } catch (error) {
    document.getElementById('exp_status').textContent = error.message;
  }
}
function mpDropPendingReceipts() {
  if (!mpExpCache?.spent?.some(x => x.pending)) return;
  mpExpCache.spent = mpExpCache.spent.filter(x => !x.pending);
  mpPendingRerender();
}
// This period so far against the period before it, of the same length: the spending summed day by day.
// The length is set by exp_cmp_span (week, month, half a year, year); the periods run back from today. USD.
let mpCmpKey = '';
const MP_CMP_STEP = { month: 1, quarter: 3, half: 6, year: 12 };   // months back to the period before
// the first day of the period today is in
function mpCmpStart(span, today) {
  if (span === 'week') { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; return mpCmpDay(today, -dow); }
  const [y, m] = today.split('-').map(Number);
  if (span === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  if (span === 'quarter') return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (span === 'half') return m <= 6 ? `${y}-01-01` : `${y}-07-01`;
  return `${y}-01-01`;
}
const MP_CMP_NAME = { week: 'week', month: 'month', quarter: 'quarter', half: 'half a year', year: 'year' };
const MP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// the x-axis labels of a longer period: a month: each week from its first day ("1 Nov", "8 Nov"...);
// a quarter, half a year, a year: each month at its first day. The first day of the period is x = 1.
function mpCmpTicks(span, curFrom, curFull) {
  if (span === 'week') return { tickmode: 'array', tickvals: [1, 2, 3, 4, 5, 6, 7], ticktext: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
  const xs = Array.from({ length: curFull }, (_, i) => i + 1);
  const at = span === 'month' ? xs.filter(i => (i - 1) % 7 === 0) : xs.filter(i => i === 1 || mpCmpDay(curFrom, i - 1).endsWith('-01'));
  const label = i => {
    const d = mpCmpDay(curFrom, i - 1);
    return span === 'month' ? `${Number(d.slice(8, 10))} ${MP_MONTHS[Number(d.slice(5, 7)) - 1]}` : MP_MONTHS[Number(d.slice(5, 7)) - 1];
  };
  return { tickmode: 'array', tickvals: at, ticktext: at.map(label) };
}
function mpCmpDay(day, k) { return mpDayShift(day, k); }
function mpCmpMonths(day, k) { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, d)).toISOString().slice(0, 10); }
// The spending rows of the days from..to: the day and the dollars, the rows the tab counts (counted).
// Two years for the 'year' comparison, some 4 000 rows: pages of 1 000, four at a time.
async function mpExpDaySums(from, to) {
  const out = [];
  for (let at = 0; ; at += 4000) {
    const parts = await Promise.all([0, 1, 2, 3].map(i => sb.from('expenses').select('day, usd')
      .eq('counted', true).gte('day', from).lte('day', to).order('day').order('id')
      .range(at + i * 1000, at + i * 1000 + 999)));
    for (const { data, error } of parts) {
      if (error) throw new Error(error.message);
      out.push(...data.map(r => ({ day: r.day, usd: r.usd == null ? NaN : Number(r.usd) })));
      if (data.length < 1000) return out;
    }
  }
}
async function mpRenderCumulative() {
  const el = document.getElementById('plot_exp_cumulative');
  if (!el) return;
  const span = document.getElementById('exp_cmp_span').value;
  const today = new Date().toISOString().slice(0, 10);
  const key = `${span}|${today}`;
  if (key === mpCmpKey) return;
  mpCmpKey = key;
  const note = document.getElementById('exp_cumulative_note');
  // the current period (its first day, the Monday, the 1st of the month, of the half year, of the year) and its
  // whole length; so far it runs to today; the period before, whole
  const curFrom = mpCmpStart(span, today);
  const soFar = Math.round((Date.parse(today) - Date.parse(curFrom)) / 86400000) + 1;
  const curNext = span === 'week' ? mpCmpDay(curFrom, 7) : mpCmpMonths(curFrom, MP_CMP_STEP[span] || 1);
  const curFull = Math.round((Date.parse(curNext) - Date.parse(curFrom)) / 86400000);
  const prevFrom = span === 'week' ? mpCmpDay(curFrom, -7) : mpCmpMonths(curFrom, -MP_CMP_STEP[span]);
  const prevTo = mpCmpDay(curFrom, -1);
  note.textContent = 'Loading…';
  // the day and the dollars of the spending rows only (the tab's own loads read notes, places and
  // rates of all the history twice over: the chart waited for them)
  const rows = await mpExpDaySums(prevFrom, today);
  const cur = { spent: rows.filter(r => r.day >= curFrom) }, prev = { spent: rows.filter(r => r.day <= prevTo) };
  const prevDays = Math.round((Date.parse(prevTo) - Date.parse(prevFrom)) / 86400000) + 1;
  const xMax = Math.max(curFull, prevDays);
  const running = (part, from, n) => {
    const per = new Array(n).fill(0);
    for (const r of part.spent) {
      if (!Number.isFinite(r.usd)) continue;
      const k = Math.round((Date.parse(r.day) - Date.parse(from)) / 86400000);
      if (k >= 0 && k < n) per[k] += r.usd;
    }
    let run = 0;
    return per.map(v => (run += v));
  };
  // this period's line stops at today; the axis runs over the whole length of both periods
  const c = running(cur, curFrom, curFull).map((v, i) => (i < soFar ? v : null)), p = running(prev, prevFrom, prevDays);
  // green while this period is at or below the one before on the same day, red when above it
  const sameDay = Math.min(soFar, prevDays);
  const above = (c[soFar - 1] ?? 0) > (p[sameDay - 1] ?? 0);
  const nowColor = above ? '#f85149' : '#3fb950';
  const traces = [
    // each line starts at 0 before the period's first day (x = 0)
    { x: [0, ...c.map((_, i) => i + 1)], y: [0, ...c], name: 'this period', type: 'scatter', mode: 'lines', line: { color: nowColor, width: 2 },
      customdata: ['', ...c.map((_, i) => mpCmpDay(curFrom, i))], hovertemplate: ['<extra></extra>', ...c.map(() => '%{customdata}: $%{y:,.0f}<extra></extra>')] },
    { x: [0, ...p.map((_, i) => i + 1)], y: [0, ...p], name: 'the period before', type: 'scatter', mode: 'lines', line: { color: '#8b949e', width: 2, dash: 'dot' },
      customdata: ['', ...p.map((_, i) => mpCmpDay(prevFrom, i))], hovertemplate: ['<extra></extra>', ...p.map(() => '%{customdata}: $%{y:,.0f}<extra></extra>')] },
  ];
  Plotly.react(el, traces, {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: '#c9d1d9' },
    margin: { l: 60, r: 20, t: 20, b: 50 }, hovermode: 'x unified', legend: { orientation: 'h', y: -0.25 },
    xaxis: { title: span === 'week' ? 'day of the week' : span === 'month' ? 'week' : 'month', range: [0, xMax + 0.5],
      dtick: span === 'week' ? 1 : undefined, ...mpCmpTicks(span, curFrom, curFull) },
    yaxis: { tickprefix: '$', separatethousands: true, gridcolor: '#30363d' },
  }, { displayModeBar: false, responsive: true });
  // the same day of each period: where the spending stands on it
  const onDay = Math.min(soFar, prevDays);
  const now = c[soFar - 1] ?? 0, before = p[onDay - 1] ?? 0;
  const pct = before ? Math.round((now / before - 1) * 100) : null;
  note.textContent = `Day ${soFar} of ${curFull}: $${Math.round(now)} this ${MP_CMP_NAME[span]}, $${Math.round(before)} the ${MP_CMP_NAME[span]} before`
    + (pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`);
  note.style.color = nowColor;
}
