// A stand-in for MOEX ISS in the page snapshot test: the bonds of
// make_fixture.mjs's MOEX (held ones, OFZ, yuan corporates) answered the way
// ISS does -- { block: { columns, data } } with the columns the URL asks for
// (the page reads rows by position).
const ISO = t => new Date(t).toISOString().slice(0, 10);
const TODAY = Date.UTC(2026, 10, 21);
const addMonths = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return ISO(d); };

// a bond's every column ISS could be asked for
function row(b) {
  return {
    SECID: b.secid, SHORTNAME: b.name, NAME: b.name, MATDATE: b.mat, OFFERDATE: b.offer || null, FACEUNIT: b.unit === 'RUB' ? 'SUR' : b.unit,
    FACEVALUE: b.face, PREVPRICE: b.price, PREVWAPRICE: b.price, ACCRUEDINT: b.accrued, BOARDID: b.board,
    COUPONPERCENT: b.floating ? null : b.rate, COUPONPERIOD: 182, YIELD: b.yield, VALTODAY: b.turnover, DURATION: b.duration,
  };
}
const block = (rows, cols) => ({ columns: cols, data: rows.map(r => cols.map(c => r[c] ?? null)) });
const colsOf = (u, name, all) => (u.searchParams.get(`${name}.columns`) || all.join(',')).split(',');
const ALL = Object.keys(row({}));

export function moexReply(url, M) {
  const u = new URL(url);
  const p = u.pathname;
  const bonds = [...M.held, ...M.ofz, ...M.cny];
  const find = id => bonds.find(b => b.secid === id);
  let m;
  if ((m = p.match(/^\/iss\/securities\/([^/]+)\/bondization\.json$/))) {
    const b = find(decodeURIComponent(m[1]));
    if (!b) return {};
    // half-year coupons from a year and a half ago to maturity; a floater's future ones not set yet
    const coupons = [];
    for (let start = addMonths(ISO(TODAY), -18); start < b.mat; start = addMonths(start, 6)) {
      const end = addMonths(start, 6) > b.mat ? b.mat : addMonths(start, 6);
      const known = !b.floating || end <= addMonths(ISO(TODAY), 3);
      const value = known ? Math.round(b.face * b.rate / 200 * 100) / 100 : null;
      coupons.push({ coupondate: end, startdate: start, value, valueprc: known ? b.rate : null, facevalue: b.face });
    }
    const amort = b.amortised ? [{ amortdate: addMonths(b.mat, -12), value: b.face / 2 }, { amortdate: b.mat, value: b.face / 2 }] : [{ amortdate: b.mat, value: b.face }];
    return {
      coupons: block(coupons, ['coupondate', 'startdate', 'value', 'valueprc', 'facevalue']),
      offers: block(b.offer ? [{ offerdate: b.offer }] : [], ['offerdate']),
      amortizations: block(amort, ['amortdate', 'value']),
    };
  }
  if ((m = p.match(/^\/iss\/securities\/([^/]+)\.json$/))) {
    const b = find(decodeURIComponent(m[1]));
    if (!b) return {};
    const d = [['NAME', b.name], ['SHORTNAME', b.name], ['MATDATE', b.mat], ['FACEUNIT', b.unit === 'RUB' ? 'SUR' : b.unit], ['FACEVALUE', String(b.face)]];
    if (b.details) d.push(['COUPON_DETAILS', b.details]);
    return { description: { columns: ['name', 'value'], data: d } };
  }
  if ((m = p.match(/^\/iss\/engines\/stock\/markets\/bonds\/boards\/(TQOB|TQCB)\/securities\.json$/))) {
    const list = (m[1] === 'TQOB' ? M.ofz.concat(M.held.filter(b => b.board === 'TQOB')) : M.cny.concat(M.held.filter(b => b.board === 'TQCB'))).map(row);
    return { securities: block(list, colsOf(u, 'securities', ALL)), marketdata: block(list, colsOf(u, 'marketdata', ALL)) };
  }
  if (p === '/iss/engines/stock/markets/bonds/securities.json') {
    const ids = (u.searchParams.get('securities') || '').split(',');
    const list = bonds.filter(b => ids.includes(b.secid)).map(row);
    return { securities: block(list, colsOf(u, 'securities', ALL)), marketdata: block(list, colsOf(u, 'marketdata', ALL)) };
  }
  return {};
}
