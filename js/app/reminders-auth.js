// Reminders over the tabs (credit card payments, stale data, Earn terms) and
// what changes on sign-in / sign-out (mpUpdateAuthUi).

// ---- Credit card payment reminder ----
// A card in credit_card_reminders (migration ...123): its statement comes on
// statement_day, the payment is due on the next due_day after it. From
// remind_days before the due date a banner on top says what the grace period
// wants paid -- from the card's statement rows, so as fresh as the last
// upload -- until the statements show it paid. A transfer can't be made on
// a day off: a due date at the weekend or on a Russian public holiday wants the
// money by the working day before, and the banner turns red with 3 working days
// or fewer left. The days off come from the Russian work calendar (isdayoff.ru:
// a digit a day, 1 = off, holidays and moved days included); without it, the
// weekends alone.
const mpIsoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// the day in a month, or its last day when the month is shorter
const mpDayIn = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));

const mpRuDaysOff = new Map();   // year -> its calendar string, or null when it didn't load
async function mpLoadRuDaysOff(year) {
  if (!mpRuDaysOff.has(year)) {
    let cal = null;
    try {
      const res = await fetch(`https://isdayoff.ru/api/getdata?year=${year}&cc=ru`);
      const txt = res.ok ? (await res.text()).trim() : '';
      if (/^[0-9]{365,366}$/.test(txt)) cal = txt;
    } catch (_) { /* the weekends alone */ }
    mpRuDaysOff.set(year, cal);
  }
  return mpRuDaysOff.get(year);
}
const mpIsDayOff = d => {
  const cal = mpRuDaysOff.get(d.getFullYear());
  if (!cal) return d.getDay() === 0 || d.getDay() === 6;
  return cal[Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 1)) / 86400000)] === '1';
};

async function mpRenderCardReminders() {
  const box = document.getElementById('card_reminders');
  const { data: rules, error } = await sb.from('credit_card_reminders').select('*');
  const out = [...await mpStaleDataReminders(), ...await mpEarnReminders(), ...await mpDepositEndReminders()];
  if (error || !rules?.length) { box.innerHTML = out.join(''); return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const r of rules) {
    if (r.grace_months) { out.push(...await mpGraceMonthsReminder(r, today)); continue; }
    // the latest statement day not after today, and the due date after it
    let st = mpDayIn(today.getFullYear(), today.getMonth(), r.statement_day);
    if (st > today) st = mpDayIn(today.getFullYear(), today.getMonth() - 1, r.statement_day);
    let due = mpDayIn(st.getFullYear(), st.getMonth(), r.due_day);
    if (due <= st) due = mpDayIn(st.getFullYear(), st.getMonth() + 1, r.due_day);
    // the last working day for the transfer, and the working days left till it, today included
    await Promise.all([...new Set([today.getFullYear(), due.getFullYear()])].map(mpLoadRuDaysOff));
    const pay = new Date(due);
    while (mpIsDayOff(pay)) pay.setDate(pay.getDate() - 1);
    const left = Math.round((pay - today) / 86400000);
    let work = 0;
    for (const d = new Date(today); d <= pay; d.setDate(d.getDate() + 1)) if (!mpIsDayOff(d)) work++;
    if (left > r.remind_days) continue;
    // the grace period's payment, as the bank counts it: the debt the statement
    // shows (the balance at the end of the day before statement_day) less all
    // that came onto the card since; the card's own debt now besides
    const { data: rows } = await sb.from('bank_transactions').select('tx_date, amount, balance_after')
      .eq('account', r.account).eq('product', 'credit_card').is('synthetic_kind', null).not('balance_after', 'is', null)
      .gte('tx_date', mpIsoDay(new Date(st.getFullYear(), st.getMonth() - 3, 1)))
      .order('tx_date', { ascending: true });
    const stDay = mpIsoDay(st);
    const lastOf = list => {   // of rows at one minute, the one after the others: no other row starts from its balance
      const top = list.filter(x => x.tx_date === list[list.length - 1].tx_date);
      return top.find(x => !top.some(y => y !== x && Number(y.balance_after) - Number(y.amount) === Number(x.balance_after))) || top[top.length - 1];
    };
    const before = (rows || []).filter(x => x.tx_date.slice(0, 10) < stDay);
    const since = (rows || []).filter(x => x.tx_date.slice(0, 10) >= stDay);
    const owedAtStatement = before.length ? Math.max(0, -Number(lastOf(before).balance_after)) : null;
    const paidSince = since.reduce((t, x) => t + Math.max(0, Number(x.amount)), 0);
    const grace = owedAtStatement === null ? null : Math.max(0, owedAtStatement - paidSince);
    const debt = rows?.length ? -Number(lastOf(rows).balance_after) : null;
    const asOf = rows?.length ? rows[rows.length - 1].tx_date.slice(0, 10) : null;
    const stale = !asOf || asOf < stDay;
    if (grace === 0 && !stale) continue;   // the grace period's payment made
    const fmt = d => d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
    const when = fmt(due);
    const daysTxt = (pay < due ? `перевести до ${fmt(pay)} — срок в нерабочий день; ` : '')
      + (left < 0 ? 'последний рабочий день прошёл' : left === 0 ? 'перевести сегодня' : `рабочих дней: ${work}`);
    const money = v => `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${r.currency}`;
    const amount = grace !== null ? `<b>${money(grace)}</b>${debt > 0 ? ` (весь долг ${money(debt)})` : ''}` : 'сумма неизвестна';
    out.push(`<div class="card-reminder${work <= 3 ? ' urgent' : ''}">
      <span>💳 <b>${mpEscapeHtml(r.account)}</b>: погасить кредитку до <b>${when}</b> (${daysTxt}) — ${amount}</span>
      <span class="note">${asOf ? `по выписке на ${asOf.split('-').reverse().join('.')}` : 'выписок нет'}${stale ? ' — загрузите свежую' : ''}</span>
    </div>`);
  }
  // the credit cards first, then the fainter Earn ones
  box.innerHTML = [...out.filter(h => !h.includes('faint')), ...out.filter(h => h.includes('faint'))].join('');
}

// A card whose purchases of a month are interest free until the end of the
// grace_months-th month after it (Sber's "до 120 дней": November's by 28
// February). What came onto the card pays the oldest month's purchases first;
// the banner names the oldest month still owing and its last day (the working
// day before when it falls on a day off), from remind_days before it.
// Besides, every month the statement (on the 1st) shows a debt, a minimum
// payment is due -- miss it and the grace period is gone. Its day (due_day)
// the app shows after the statement; until it's set the banner says so, from
// the 1st on. Paid once what came onto the card since the 1st is a tenth of
// the statement's debt ("до 10%" -- the most the minimum payment is).
async function mpGraceMonthsReminder(r, today) {
  const banners = [];
  const from = new Date(today.getFullYear(), today.getMonth() - r.grace_months - 1, 1);
  const q = () => sb.from('bank_transactions').select('tx_date, amount, balance_after')
    .eq('account', r.account).eq('product', 'credit_card').is('synthetic_kind', null).not('balance_after', 'is', null);
  const [{ data: prev }, { data: rows }] = await Promise.all([
    q().lt('tx_date', mpIsoDay(from)).order('tx_date', { ascending: false }).limit(1),
    q().gte('tx_date', mpIsoDay(from)).order('tx_date', { ascending: true }),
  ]);
  // what's owed, by the month it was spent in (the debt before the window: its first month)
  const owed = [];   // [first day of the month, amount]
  const start = prev?.length ? Math.max(0, -Number(prev[0].balance_after)) : 0;
  if (start > 0) owed.push([new Date(from.getFullYear(), from.getMonth() - 1, 1), start]);
  for (const x of rows || []) {
    const a = Number(x.amount), d = new Date(x.tx_date.slice(0, 10) + 'T00:00:00');
    if (a < 0) {
      const m = new Date(d.getFullYear(), d.getMonth(), 1);
      const last = owed[owed.length - 1];
      if (last && last[0].getTime() === m.getTime()) last[1] -= a; else owed.push([m, -a]);
    } else {
      let left = a;
      for (const o of owed) { const p = Math.min(o[1], left); o[1] -= p; left -= p; if (left <= 0) break; }
    }
  }
  const fmt = d => d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  const money = v => `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${r.currency}`;
  const debt = rows?.length ? -Number(rows[rows.length - 1].balance_after) : start;
  const asOf = rows?.length ? rows[rows.length - 1].tx_date.slice(0, 10) : null;
  const note = `<span class="note">${asOf ? `по выписке на ${asOf.split('-').reverse().join('.')}` : 'выписок нет'}</span>`;
  // the last working day for a due date, the days and working days till it
  const until = async due => {
    await Promise.all([...new Set([today.getFullYear(), due.getFullYear()])].map(mpLoadRuDaysOff));
    const pay = new Date(due);
    while (mpIsDayOff(pay)) pay.setDate(pay.getDate() - 1);
    const left = Math.round((pay - today) / 86400000);
    let work = 0;
    for (const d = new Date(today); d <= pay; d.setDate(d.getDate() + 1)) if (!mpIsDayOff(d)) work++;
    const txt = (pay < due ? `перевести до ${fmt(pay)} — срок в нерабочий день; ` : '')
      + (left < 0 ? 'последний рабочий день прошёл' : left === 0 ? 'перевести сегодня' : `рабочих дней: ${work}`);
    return { left, work, txt };
  };

  // the minimum payment of this month's statement
  const monthStart = mpIsoDay(new Date(today.getFullYear(), today.getMonth(), 1));
  const before = (rows || []).filter(x => x.tx_date.slice(0, 10) < monthStart);
  const atStatement = before.length ? Math.max(0, -Number(before[before.length - 1].balance_after)) : start;
  const paidSince = (rows || []).filter(x => x.tx_date.slice(0, 10) >= monthStart).reduce((t, x) => t + Math.max(0, Number(x.amount)), 0);
  if (atStatement > 0.005 && paidSince < atStatement * 0.1 - 0.005) {
    const due = r.due_day ? mpDayIn(today.getFullYear(), today.getMonth(), r.due_day) : null;
    const u = due ? await until(due) : null;
    if (!u || u.left <= r.remind_days) {
      banners.push(`<div class="card-reminder${u && u.work <= 3 ? ' urgent' : ''}">
      <span>💳 <b>${mpEscapeHtml(r.account)}</b>: минимальный платёж по выписке на 1-е — ${due ? `до <b>${fmt(due)}</b> (${u.txt})` : '<b>дату смотрите в СберБанк Онлайн</b>'}; долг на 1-е <b>${money(atStatement)}</b>, внесённое целиком снимает вопрос</span>
      ${note}
    </div>`);
    }
  }

  // the oldest month's purchases, due at the end of the grace period
  const oldest = owed.find(o => o[1] > 0.005);
  if (!oldest) return banners;
  const due = new Date(oldest[0].getFullYear(), oldest[0].getMonth() + r.grace_months + 1, 0);
  const u = await until(due);
  if (u.left > r.remind_days) return banners;
  const month = oldest[0].toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  banners.push(`<div class="card-reminder${u.work <= 3 ? ' urgent' : ''}">
      <span>💳 <b>${mpEscapeHtml(r.account)}</b>: погасить покупки за ${month} до <b>${fmt(due)}</b> (${u.txt}) — <b>${money(oldest[1])}</b>${debt > oldest[1] + 0.005 ? ` (весь долг ${money(debt)})` : ''}</span>
      ${note}
    </div>`);
  return banners;
}

// The nightly job (update-capital-history) stood still from 26.10.2026 to
// 05.11.2026 -- killed by the platform's time limit, with no report -- and the
// capital was counted at 26.10 prices with nothing to show it. A red banner
// when a held security's prices or the capital history are more than a few
// days behind.
async function mpStaleDataReminders() {
  const out = [];
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  try {
    const { data: cap } = await sb.from('capital_daily_total').select('day').order('day', { ascending: false }).limit(1);
    if (cap?.[0] && cap[0].day < ago(2)) out.push(`<div class="card-reminder urgent">⚠️ История капитала не обновлялась с <b>${fmt(cap[0].day)}</b> — ночной пересчёт (update-capital-history) не проходит</div>`);
    // held now, with a price source (deposits, cash and the like have none)
    const { data: held } = await sb.from('portfolio_value_usd').select('ticker, quantity');
    const tickers = [...new Set((held || []).filter(h => Number(h.quantity) > 0).map(h => h.ticker))];
    if (!tickers.length) return out;
    const { data: srcs } = await sb.from('price_sources').select('ticker').in('ticker', tickers).neq('source', 'none');
    const priced = (srcs || []).map(x => x.ticker);
    if (!priced.length) return out;
    // 4 days: a weekend and a holiday without a close are fine
    const { data: recent } = await sb.from('price_history').select('ticker').in('ticker', priced).gte('day', ago(4));
    const fresh = new Set((recent || []).map(r => r.ticker));
    const stale = priced.filter(t => !fresh.has(t)).sort();
    if (stale.length) out.push(`<div class="card-reminder urgent">⚠️ Цены не обновлялись больше 4 дней: <b>${stale.slice(0, 8).map(mpEscapeHtml).join(', ')}</b>${stale.length > 8 ? ` и ещё ${stale.length - 8}` : ''} — графики считаются по старым ценам</div>`);
  } catch { /* a check that can't run shows nothing */ }
  return out;
}

// Crypto.com's Earn terms don't renew: 90 days after it's opened a term's BTC
// goes back to the wallet and earns nothing until a new one is opened by hand.
// A faint banner from a week before a term's end to 3 days after it (by then
// it's reopened, or the next export shows it isn't), and for a withdrawal the
// export shows with no new term after it, for 2 weeks.
async function mpEarnReminders() {
  const { data: wallets } = await sb.from('crypto_wallets').select('id').eq('chain', 'cryptocom');
  if (!wallets?.length) return [];
  const { data: moves } = await sb.from('wallet_transactions').select('tx_time, symbol, amount')
    .in('wallet_id', wallets.map(w => w.id)).eq('kind', 'earn_internal').eq('estimated', false).order('tx_time');
  if (!moves?.length) return [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayOf = t => { const d = new Date(t.slice(0, 10) + 'T00:00:00'); return d; };
  const fmt = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const days = d => Math.round((d - today) / 86400000);
  const amt = x => Math.abs(Number(x.amount));
  // the open terms: allocations no withdrawal of the same amount has closed
  const withdrawals = moves.filter(m => Number(m.amount) > 0);
  const left = withdrawals.map(amt);
  const open = moves.filter(m => Number(m.amount) < 0).filter(m => {
    const i = left.findIndex(x => Math.abs(x - amt(m)) < 1e-12);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  const out = [];
  for (const m of open) {
    const end = dayOf(m.tx_time); end.setDate(end.getDate() + 90);
    const n = days(end);
    if (n > 7 || n < -3) continue;
    out.push(`<div class="card-reminder faint">🔒 Crypto.com Earn: вклад ${amt(m)} ${m.symbol} ${n > 0 ? `закрывается ${fmt(end)} (через ${n} дн.)` : n === 0 ? 'закрывается сегодня' : `закрылся ${fmt(end)}`} — открыть заново</div>`);
  }
  for (const w of withdrawals) {
    const d = dayOf(w.tx_time), n = days(d);
    if (n < -14 || moves.some(m => Number(m.amount) < 0 && m.symbol === w.symbol && m.tx_time > w.tx_time)) continue;
    out.push(`<div class="card-reminder faint">🔒 Crypto.com Earn: вклад ${amt(w)} ${w.symbol} закрылся ${fmt(d)} и не открыт заново — открыть</div>`);
  }
  return out;
}

// A term deposit's end (deposit_terms, set from the statement or by hand): a faint banner from a week
// before it to 3 days after, while it's still held. A Ziraat lira deposit's money is changed back in
// Ziraat's app, whose rate is ~1% off the market in the Turkish market's hours on a weekday and ~3% off
// on an evening, a night or a weekend (its receipts' times, 23.11.2026): the hours, and which it is now.
async function mpDepositEndReminders() {
  const { data: terms } = await sb.from('deposit_terms').select('ticker, end_day');
  if (!terms?.length) return [];
  const { data: held } = await sb.from('portfolio_value_usd').select('ticker, quantity').in('ticker', terms.map(t => t.ticker));
  const qty = new Map((held || []).map(h => [h.ticker, Number(h.quantity)]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmt = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  // Istanbul's clock now (UTC+3, no summer time): a weekday 10:00-16:30 is the narrow spread
  const ist = new Date(Date.now() + 3 * 3600000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = ist.getUTCDay() >= 1 && ist.getUTCDay() <= 5 && mins >= 600 && mins < 990;
  const out = [];
  for (const t of terms) {
    const left = qty.get(t.ticker);
    if (!(left > 0)) continue;
    const end = new Date(t.end_day + 'T00:00:00');
    const n = Math.round((end - today) / 86400000);
    if (n > 7 || n < -3) continue;
    const name = t.ticker.replace(/^DEPOSIT:/, '');
    const when = n > 0 ? `закрывается ${fmt(end)} (через ${n} дн.)` : n === 0 ? 'закрывается сегодня' : `закрылся ${fmt(end)}`;
    const fx = /^Ziraat Bank TRY /.test(name)
      ? ` — лиры менять в будни с 11:00 до 17:30 по Тбилиси: наценка Ziraat ~1%, вечером, ночью и в выходные ~3%. Сейчас ${open ? '<b>~1%</b>' : '<b>~3%</b>, лучше подождать'}`
      : '';
    out.push(`<div class="card-reminder faint">🏦 Вклад ${mpEscapeHtml(name)} ${when}${fx}</div>`);
  }
  return out;
}

let mpStartTabCounted = false;
// Every tab's two panes: the one for the signed in, the one asking to sign in
const MP_AUTH_PANES = ['mp', 'auto', 'crypto', 'lookthrough', 'charts', 'capital', 'capitalbrokers', 'invested', 'expenses', 'products'];
function mpShowSignedIn(signedIn) {
  for (const p of MP_AUTH_PANES) {
    document.getElementById(`${p}_signed_out`).style.display = signedIn ? 'none' : '';
    document.getElementById(`${p}_signed_in`).style.display = signedIn ? '' : 'none';
  }
}
function mpUpdateAuthUi(session) {
  const btn = document.getElementById('btn_login');
  mpIsSignedIn = !!session;
  if (session) {
    // the tab shown first counts as opened, once per page load (tab_opens, migration ...184)
    if (!mpStartTabCounted) {
      mpStartTabCounted = true;
      sb.rpc('record_tab_open', { p_tab: document.querySelector('.tab.active')?.dataset.tab || 'myportfolio' }).then(() => {}, () => {});
    }
    btn.textContent = `Sign out (${session.user.email})`;
    mpShowSignedIn(true);
    mpRenderCardReminders();
    mpRenderPortfolioPies();
    mpRenderLatestSources();
    mpRenderReceiptsPanel();
    mpRenderProductList();
    mpRenderBrokerCurrency();
    mpRenderBrokerAssetClass();
    mpRenderBondByType();
    mpRenderWallets();
    mpIbkrFlexLoad();
    mpBybitApiLoad();
    mpF24ApiLoad();
    mpTbankApiLoad();
    mpBinanceApiLoad();
    mpRevxApiLoad();
    mpWiseApiLoad();
    mpEbLoad().then(mpEbReturn);
    mpRenderRealEstate();
    mpRenderLookThrough();
    mpRenderCharts();
    if (document.getElementById('capital').classList.contains('active')) mpRenderCapital();
    if (document.getElementById('capitalbrokers').classList.contains('active')) mpRenderCapitalBrokers();
    if (document.getElementById('invested').classList.contains('active')) mpRenderInvested();
  } else {
    btn.textContent = 'Sign in with Google';
    document.getElementById('card_reminders').innerHTML = '';
    mpShowSignedIn(false);
    mpExpCache = null;
    mpCapitalBrokerRows = null;
    mpAccountSeries.clear();
    mpExactMask = null;
    mpEverHeldRows = null;
    mpProvenCash = null;
    Plotly.purge('plot_capital_brokers');
    mpCapitalRows = null;
    mpCapitalTypeRows = null;
    mpInvestedRows = null;
    mpInvestedAssetsKey = '';
    Plotly.purge('plot_capital');
    Plotly.purge('plot_capital_types');
    Plotly.purge('plot_invested_earned');
    document.getElementById('mp_charts_grid').innerHTML = '';
    document.getElementById('mp_lookthrough_wrap').innerHTML = '';
    ['plot_mp_pie_us_stocks', 'plot_mp_pie_us_sectors', 'plot_mp_pie_ru_stocks', 'plot_mp_pie_ru_sectors', 'plot_mp_pie_stocksbonds', 'plot_mp_pie_deposits']
      .forEach(id => { document.getElementById(id).style.display = 'none'; });
    ['mp_pie_us_stocks_note', 'mp_pie_ru_stocks_note', 'mp_pie_stocksbonds_note', 'mp_pie_deposits_note',
     'mp_pie_us_stocks_title', 'mp_pie_ru_stocks_title', 'mp_pie_stocksbonds_title', 'mp_pie_deposits_title']
      .forEach(id => { document.getElementById(id).style.display = 'none'; });
    ['mp_pie_us_stocks_table_wrap', 'mp_pie_ru_stocks_table_wrap', 'mp_pie_stocksbonds_table_wrap', 'mp_pie_deposits_table_wrap',
     'mp_broker_currency_wrap', 'mp_broker_assetclass_wrap', 'mp_bond_subtype_wrap']
      .forEach(id => { document.getElementById(id).innerHTML = ''; });
    document.getElementById('mp_ru_stocks_invest_row').style.display = 'none';
    document.getElementById('mp_us_stocks_invest_row').style.display = 'none';
  }
}

['mp_ru_stocks_invest_amount', 'mp_us_stocks_invest_amount'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => { mpRenderPortfolioPies(); });
});
['mp_ru_stocks_respect_lots', 'mp_ru_stocks_prefer_expensive', 'mp_us_stocks_respect_lots', 'mp_us_stocks_use_sectors', 'mp_us_stocks_prefer_expensive'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { mpRenderPortfolioPies(); });
});

