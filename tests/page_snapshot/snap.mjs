// Page snapshot: loads index.html from a folder in headless Chrome with a fake
// Supabase (fake_supabase.js answering from make_fixture.mjs's data), a fixed
// clock and a seeded Math.random, then step by step: opens every tab (and the
// price chart of the first few [data-chart] cells in it), flips each visible
// checkbox and select one by one, and opens the price chart window of assets
// of every kind. Each step's DOM, Plotly calls, errors and form values go to
// <out>/<step>.*. Used by compare.mjs.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png' };
// assets of every kind for the price chart window: Russian share, crypto, a fund, a yuan bond fund,
// a money market fund, a bond, a US share, gold, a fund's constituent only
const PRICE_ASSETS = ['SBER', 'BTC', 'ETH', 'VWRA', 'TLCB', 'SBMM', 'RU000A10C5L7', 'GOOGL', 'XAU', 'C3'];

// before the page's own scripts: a fixed clock, a seeded Math.random, errors and Plotly calls logged
const PRELUDE = `(() => {
  const FIXED = Date.parse('2026-11-21T12:00:00+04:00');
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
  window.Date = FakeDate;
  let s = 42;
  Math.random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  window.__log = [];
  window.__errors = [];
  addEventListener('error', e => __errors.push('error: ' + (e.message || e.target?.src || e.target?.href || '?')), true);
  addEventListener('unhandledrejection', e => __errors.push('rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  const ser = v => { try { return JSON.stringify(v, (k, x) => (x instanceof HTMLElement ? '<' + x.tagName + '#' + x.id + '>' : ArrayBuffer.isView(x) ? Array.from(x) : typeof x === 'function' ? 'fn' : x)); } catch (e) { return 'unserializable'; } };
  let P;
  Object.defineProperty(window, 'Plotly', { configurable: true, get: () => P, set: v => {
    P = v;
    for (const m of ['newPlot', 'react', 'restyle', 'relayout', 'update', 'addTraces', 'deleteTraces', 'extendTraces', 'purge']) {
      const f = v[m]; if (typeof f !== 'function') continue;
      v[m] = function (gd, ...rest) {
        const id = typeof gd === 'string' ? gd : gd && gd.id;
        __log.push(m + ' ' + id + ' ' + rest.map(ser).join(' | '));
        return f.call(this, gd, ...rest);
      };
    }
  } });
})();`;

// quiet: no DOM change for 700 ms (at most 20 s)
async function settle(page) {
  await page.evaluate(() => new Promise(res => {
    let t; const done = () => { obs.disconnect(); res(); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 700); });
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    t = setTimeout(done, 700); setTimeout(done, 20000);
  }));
}

export async function snapshot(root, out, fixture) {
  mkdirSync(out, { recursive: true });
  const fakeSb = `{const F=${JSON.stringify(fixture)};window.__FIXTURE=F.T;window.__FIXTURE_RPC=F.RPC;}\n`
    + readFileSync(join(HERE, 'fake_supabase.js'), 'utf8');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1400,1000', '--lang=en-US', '--font-render-hinting=none'] });

  // a fresh page (empty storage) on the folder's index.html
  async function openPage() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.emulateTimezone('Asia/Tbilisi');
    await page.evaluateOnNewDocument(PRELUDE);
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = new URL(req.url());
      const reply = (body, type = 'application/json', status = 200) => req.respond({ status, contentType: type, body, headers: { 'access-control-allow-origin': '*' } });
      if (u.hostname === 'erp.test') {
        let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
        const f = join(root, p);
        if (!existsSync(f)) return reply('not found', 'text/plain', 404);
        if (req.method() === 'HEAD') return reply('', TYPES[extname(f)] || 'application/octet-stream');
        return reply(readFileSync(f), TYPES[extname(f)] || 'application/octet-stream');
      }
      if (u.hostname === 'cdn.plot.ly') return req.continue();   // the pinned version, as the page loads it
      if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('supabase')) return reply(fakeSb, 'text/javascript');
      if (u.hostname.endsWith('supabase.co')) return reply('{}');
      if (u.hostname === 'isdayoff.ru') return reply('0'.repeat(366), 'text/plain');
      if (u.hostname === 'iss.moex.com') return reply('{}');
      return req.abort();
    });
    page.__console = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') page.__console.push(m.type() + ': ' + m.text()); });
    await page.goto('http://erp.test/index.html', { waitUntil: 'load' });
    await settle(page);
    return { page, ctx };
  }

  async function snap(page, name) {
    const s = await page.evaluate(() => {
      const log = __log.splice(0), errors = __errors.splice(0);
      // the DOM without Plotly's own SVG (its random clip ids and sizes: the calls are logged) or the code
      const clone = document.documentElement.cloneNode(true);
      for (const el of clone.querySelectorAll('.plot-container, .svg-container, .js-plotly-plot style, script, head > style, head > link')) el.remove();
      const vals = [...document.querySelectorAll('input, select, textarea')].map(el => `${el.id || el.name}=${el.type === 'checkbox' ? el.checked : el.value}`);
      return { html: clone.outerHTML, log, errors, vals };
    });
    s.errors.push(...page.__console.splice(0));
    writeFileSync(join(out, name + '.html'), s.html.replace(/></g, '>\n<').split('\n').filter(l => l.trim()).join('\n'));
    writeFileSync(join(out, name + '.plotly.txt'), s.log.join('\n'));
    writeFileSync(join(out, name + '.errors.txt'), s.errors.join('\n'));
    writeFileSync(join(out, name + '.inputs.txt'), s.vals.join('\n'));
  }

  try {
    const first = await openPage();
    const tabs = await first.page.$$eval('.tab', ts => ts.map(t => t.dataset.tab));
    await snap(first.page, '00_load');
    await first.ctx.close();

    let n = 1;
    for (const tab of tabs) {
      const { page, ctx } = await openPage();
      await page.evaluate(() => { __log.length = 0; });
      await page.click(`.tab[data-tab="${tab}"]`);
      await settle(page);
      const id = String(n++).padStart(2, '0');
      await snap(page, `${id}_${tab}`);
      for (let i = 0; i < 3; i++) {
        const c = (await page.$$(`#${tab} [data-chart]`))[i];
        if (!c) break;
        await c.evaluate(el => { el.scrollIntoView(); el.click(); });
        await settle(page);
        await snap(page, `${id}_${tab}_chart${i}`);
        await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
        await settle(page);
      }
      // every visible checkbox flipped and every visible select moved to its next option, one by one
      const sel = `#${tab} input[type=checkbox], #${tab} select`;
      const ctrls = await page.$$eval(sel, els => els.map((el, i) => (el.offsetParent !== null && !el.disabled ? i : -1)).filter(i => i >= 0));
      let k = 0;
      for (const i of ctrls.slice(0, 14)) {
        await page.$$eval(sel, (els, i) => {
          const el = els[i];
          if (el.tagName === 'SELECT') { if (el.options.length < 2) return; el.selectedIndex = (el.selectedIndex + 1) % el.options.length; }
          else el.checked = !el.checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, i);
        await settle(page);
        await snap(page, `${id}_${tab}_ctrl${String(k++).padStart(2, '0')}`);
      }
      await ctx.close();
    }

    // the price chart window, opened straight, each also with its checkboxes flipped
    const { page, ctx } = await openPage();
    for (const t of PRICE_ASSETS) {
      await page.evaluate(t => { __log.length = 0; mpOpenPriceDialog(t, t); }, t);
      await settle(page);
      await snap(page, `90_price_${t}`);
      const boxes = await page.$$eval('dialog[open] input[type=checkbox]', b => b.length);
      for (let b = 0; b < boxes; b++) {
        await page.$$eval('dialog[open] input[type=checkbox]', (els, b) => { els[b].click(); }, b);
        await settle(page);
        await snap(page, `90_price_${t}_box${b}`);
      }
      await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) { d.close(); d.remove(); } });
      await settle(page);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
}
