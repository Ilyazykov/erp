"""
Composite Portfolio Valuation Indicator

Layer 1: Earnings Yield (TTM NI / mcap) for ALL tickers vs OFZ
  → Single comparable metric for stocks-vs-bonds allocation signal
  → YDEX/OZON have low/negative EY — correctly signals growth premium

Layer 2: Z-score per ticker vs own 36-month history
  → Each ticker uses best metric for its type
  → SBER/T/VTBR/DOMRF: Earnings Yield; ROSN: FCF Yield; YDEX/OZON: Revenue Yield
  → Z-score removes scale differences — all comparable
"""
import csv, re, math
from datetime import date, timedelta, datetime, timezone
from calendar import monthrange
from pathlib import Path

SCRATCHPAD = str(Path(__file__).resolve().parent.parent / "data")

def utc_timestamp():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

WEIGHTS = {
    'SBER': 0.4348, 'YDEX': 0.2609, 'T': 0.1522, 'DOMRF': 0.0761,
    'OZON': 0.0543, 'ROSN': 0.0109, 'VTBR': 0.0109,
}

SHARES = {
    'SBER': 21586948000, 'ROSN': 10598177817, 'VTBR': 12927766416,
    'YDEX': 396012957,   'T':    2682747860,   'OZON': 208992107,
    'DOMRF': 179900000,
}

YNDX_SHARES      = 326342270
YDEX_START       = date(2024, 7, 24)
TCSG_SHARES      = 199305492
T_START          = date(2024, 11, 28)
T_SPLIT_DATE     = date(2026, 4, 17)
T_PRE_SPLIT_SHARES = 268274786
VTBR_SPLIT_DATE  = date(2024, 7, 15)
VTBR_SPLIT_RATIO = 4664
DOMRF_START      = date(2025, 11, 20)
DOMRF_PRE_IPO_SHARES = 161800000

QUARTER_END = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}

# Annual report availability: year Y report available from Y+1-03-01
# (conservative: some publish Feb, some April — March is middle ground)
ANNUAL_REPORT_LAG_MONTHS = 3  # available from March of next year

def quarter_str_to_report_date(qstr):
    year, q = int(qstr[:4]), int(qstr[5])
    if q == 4:
        return date(year + 1, 1, 1)
    qend = date(year, QUARTER_END[q][0], QUARTER_END[q][1])
    return qend + timedelta(days=45)

def annual_report_date(year):
    """Annual report for year Y available from Y+1-03-01"""
    return date(year + 1, 3, 1)

def load_quarterly_ni():
    data = {}
    with open(f"{SCRATCHPAD}/quarterly_ni.csv") as f:
        for row in csv.DictReader(f):
            ticker = row['ticker']
            qstr = row['quarter']
            v = row['net_income_bln']
            ni = float(v) if v else None
            rdate = quarter_str_to_report_date(qstr)
            data.setdefault(ticker, []).append((qstr, ni, rdate))
    return data

def get_ttm_ni(quarterly_data, ticker, as_of):
    quarters = quarterly_data.get(ticker, [])
    available = [(q, ni, rd) for q, ni, rd in quarters if rd <= as_of and ni is not None]
    if len(available) < 4:
        return None
    available.sort(key=lambda x: x[0])
    return sum(x[1] for x in available[-4:])

def load_annual_extra():
    """Returns dict: (ticker, metric) -> list of (year, value, report_date)"""
    data = {}
    with open(f"{SCRATCHPAD}/annual_extra.csv") as f:
        for row in csv.DictReader(f):
            ticker = row['ticker']
            metric = row['metric']
            year = int(row['year'])
            v = row['value_bln']
            val = float(v) if v else None
            rdate = annual_report_date(year)
            key = (ticker, metric)
            data.setdefault(key, []).append((year, val, rdate))
    return data

def get_latest_annual(annual_data, ticker, metric, as_of):
    """Return most recent annual value published by as_of date."""
    entries = annual_data.get((ticker, metric), [])
    available = [(yr, val, rd) for yr, val, rd in entries
                 if rd <= as_of and val is not None]
    if not available:
        return None
    available.sort(key=lambda x: x[0])
    return available[-1][1]

def load_prices(ticker):
    prices = {}
    with open(f"{SCRATCHPAD}/prices_{ticker}.csv") as f:
        for row in csv.DictReader(f):
            prices[row['date']] = float(row['close'])
    if ticker == 'YDEX':
        try:
            with open(f"{SCRATCHPAD}/prices_YNDX.csv") as f:
                for row in csv.DictReader(f):
                    if row['date'] not in prices:
                        prices[row['date']] = float(row['close'])
        except FileNotFoundError:
            pass
    if ticker == 'T':
        try:
            with open(f"{SCRATCHPAD}/prices_TCSG.csv") as f:
                for row in csv.DictReader(f):
                    if row['date'] not in prices:
                        prices[row['date']] = float(row['close'])
        except FileNotFoundError:
            pass
    return prices

def last_price_of_month(prices, year, month):
    days_in_month = monthrange(year, month)[1]
    for day in range(days_in_month, 0, -1):
        ds = date(year, month, day).isoformat()
        if ds in prices:
            return prices[ds]
    return None

def load_ofz():
    ofz = {}
    with open(f"{SCRATCHPAD}/ofz10y_monthly.csv") as f:
        for row in csv.DictReader(f):
            if row['ofz10y_pct']:
                ofz[row['date']] = float(row['ofz10y_pct'])
    return ofz

def get_shares(ticker, as_of):
    shares = SHARES[ticker]
    if ticker == 'VTBR' and as_of < VTBR_SPLIT_DATE:
        shares = shares * VTBR_SPLIT_RATIO
    if ticker == 'YDEX' and as_of < YDEX_START:
        shares = YNDX_SHARES
    if ticker == 'T':
        if as_of < T_START:
            shares = TCSG_SHARES
        elif as_of < T_SPLIT_DATE:
            shares = T_PRE_SPLIT_SHARES
    if ticker == 'DOMRF' and as_of < DOMRF_START:
        shares = DOMRF_PRE_IPO_SHARES
    return shares

# Metric assignment per ticker
# 'ey': Earnings Yield (quarterly NI)
# 'fcf': FCF Yield (annual FCF)
# 'rev': Revenue Yield (annual Revenue)
# Layer 1: all tickers use Earnings Yield for apples-to-apples vs OFZ
LAYER1_METRIC = 'ey'  # same for all

# Layer 2: best metric per ticker for z-score relative valuation
LAYER2_METRIC = {
    'SBER': 'ey',
    'T':    'ey',
    'VTBR': 'ey',
    'DOMRF': 'ey',   # bank/development institution, same as SBER/T/VTBR
    'ROSN': 'fcf',   # FCF better for capex-heavy oil
    'YDEX': 'rev',   # Revenue Yield: FCF negative historically
    'OZON': 'rev',   # Revenue Yield: loss-making until 2025
}

def interpolate_nones(series):
    """Fill interior None gaps by linear interpolation; leave leading/trailing None."""
    result = list(series)
    n = len(result)
    i = 0
    while i < n:
        if result[i] is None:
            # find previous non-None
            prev_i = i - 1
            while prev_i >= 0 and result[prev_i] is None:
                prev_i -= 1
            # find next non-None
            next_i = i + 1
            while next_i < n and result[next_i] is None:
                next_i += 1
            # only interpolate if both sides exist
            if prev_i >= 0 and next_i < n:
                for j in range(prev_i + 1, next_i):
                    t = (j - prev_i) / (next_i - prev_i)
                    result[j] = result[prev_i] + t * (result[next_i] - result[prev_i])
            i = next_i
        else:
            i += 1
    return result

def rolling_zscore(series, window=36):
    """
    For each point i, compute z-score using mean/std of points [i-window, i).
    Skips None values in history. Returns None if fewer than 6 history points.
    """
    result = []
    for i in range(len(series)):
        if series[i] is None:
            result.append(None)
            continue
        start = max(0, i - window)
        hist = [v for v in series[start:i] if v is not None]
        if len(hist) < 6:
            result.append(None)
            continue
        mean = sum(hist) / len(hist)
        variance = sum((v - mean) ** 2 for v in hist) / len(hist)
        std = math.sqrt(variance)
        if std < 1e-9:
            result.append(0.0)
        else:
            result.append((series[i] - mean) / std)
    return result

def main():
    quarterly_ni = load_quarterly_ni()
    annual_extra = load_annual_extra()
    all_prices = {t: load_prices(t) for t in WEIGHTS}
    ofz_data = load_ofz()

    today = date.today()
    end_y, end_m = today.year, today.month

    months = []
    y, m = 2019, 1
    while (y, m) <= (end_y, end_m):
        months.append((y, m))
        m += 1
        if m > 12: m, y = 1, y + 1

    results = []
    for (y, m) in months:
        is_current_month = (y, m) == (end_y, end_m)
        as_of = today if is_current_month else date(y, m, monthrange(y, m)[1])
        month_str = f"{y}-{m:02d}"

        # OFZ
        ofz_val = None
        for day in range(1, 10):
            try:
                k = date(y, m, day).isoformat()
                if k in ofz_data:
                    ofz_val = ofz_data[k]
                    break
            except Exception:
                pass

        def compute_yield(ticker, mtype):
            price = last_price_of_month(all_prices[ticker], y, m)
            if price is None:
                return None
            shares = get_shares(ticker, as_of)
            mcap = price * shares / 1e9
            if mtype == 'ey':
                val = get_ttm_ni(quarterly_ni, ticker, as_of)
            elif mtype == 'fcf':
                val = get_latest_annual(annual_extra, ticker, 'fcf', as_of)
            else:  # rev
                val = get_latest_annual(annual_extra, ticker, 'revenue', as_of)
            return val / mcap * 100 if val is not None else None

        # Layer 1: Earnings Yield for all (comparable vs OFZ)
        l1_yields = {t: compute_yield(t, 'ey') for t in WEIGHTS}
        avail1 = [t for t in WEIGHTS if l1_yields[t] is not None]
        if avail1:
            tw = sum(WEIGHTS[t] for t in avail1)
            port_yield = sum(WEIGHTS[t] / tw * l1_yields[t] for t in avail1)
        else:
            port_yield = None
        erp = (port_yield - ofz_val) if (port_yield is not None and ofz_val is not None and ofz_val > 0) else None

        # Layer 2: best metric per ticker
        l2_yields = {t: compute_yield(t, LAYER2_METRIC[t]) for t in WEIGHTS}

        results.append({
            'date': month_str,
            'as_of': as_of,
            'l1_yields': l1_yields,
            'l2_yields': l2_yields,
            'port_yield': port_yield,
            'ofz10y': ofz_val,
            'erp': erp,
        })

    # Layer 2: rolling z-score per ticker (36-month window, using best metric)
    for ticker in WEIGHTS:
        series = [r['l2_yields'].get(ticker) for r in results]
        zscores = rolling_zscore(series, window=36)
        for i, r in enumerate(results):
            r[f'{ticker}_yield'] = series[i]
            r[f'{ticker}_z'] = zscores[i]

    # Portfolio z-score (weighted average of individual z-scores)
    for r in results:
        avail_z = [t for t in WEIGHTS if r.get(f'{t}_z') is not None]
        if not avail_z:
            r['port_z'] = None
        else:
            total_w = sum(WEIGHTS[t] for t in avail_z)
            r['port_z'] = sum(WEIGHTS[t] / total_w * r[f'{t}_z'] for t in avail_z)

    # OFZ z-score — interpolate the Mar-2022 gap before z-score so no break
    ofz_series_raw = [r['ofz10y'] for r in results]
    ofz_series_filled = interpolate_nones(ofz_series_raw)
    ofz_z = rolling_zscore(ofz_series_filled, window=36)
    for i, r in enumerate(results):
        r['ofz_z'] = ofz_z[i]

    # Composite ERP z-score = port_z - ofz_z; interpolate gaps for clean chart
    composite_raw = []
    for r in results:
        if r['port_z'] is not None and r['ofz_z'] is not None:
            composite_raw.append(r['port_z'] - r['ofz_z'])
        else:
            composite_raw.append(None)
    composite_filled = interpolate_nones(composite_raw)
    for i, r in enumerate(results):
        r['composite_erp_z'] = composite_filled[i]

    return results

rows = main()

# ── Print summary ──────────────────────────────────────────────────────────────
def fmt(v, w=7):
    return f"{v:{w}.2f}" if v is not None else " " * (w-4) + "None"

print(f"\nLayer 1 — Earnings Yield (все тикеры, сравнение с OFZ):")
print(f"{'Date':<8} {'SBER_EY':>8} {'YDEX_EY':>8} {'T_EY':>8} {'DOMRF_EY':>9} {'OZON_EY':>8} "
      f"{'ROSN_EY':>8} {'Port_EY':>8} {'OFZ':>7} {'ERP':>8}")
print("-" * 95)
shown = 0
for r in rows:
    if r['port_yield'] is not None:
        ly = r['l1_yields']
        print(f"{r['date']:<8} {fmt(ly.get('SBER'),8)} {fmt(ly.get('YDEX'),8)} "
              f"{fmt(ly.get('T'),8)} {fmt(ly.get('DOMRF'),9)} {fmt(ly.get('OZON'),8)} {fmt(ly.get('ROSN'),8)} "
              f"{fmt(r['port_yield'],8)} {fmt(r['ofz10y'],7)} {fmt(r['erp'],8)}")
        shown += 1
        if shown >= 30:
            break

print(f"\n{'Date':<8} {'SBER_Z':>7} {'YDEX_Z':>7} {'T_Z':>7} {'DOMRF_Z':>8} {'OZON_Z':>7} "
      f"{'ROSN_Z':>7} {'Port_Z':>7} {'OFZ_Z':>7} {'Comp_Z':>7}")
print("-" * 81)
shown2 = 0
for r in rows:
    if r.get('port_z') is not None:
        print(f"{r['date']:<8} {fmt(r['SBER_z'])} {fmt(r['YDEX_z'])} "
              f"{fmt(r['T_z'])} {fmt(r['DOMRF_z'],8)} {fmt(r['OZON_z'])} {fmt(r['ROSN_z'])} "
              f"{fmt(r['port_z'])} {fmt(r['ofz_z'])} {fmt(r['composite_erp_z'])}")
        shown2 += 1
        if shown2 >= 30:
            break

print(f"\nTotal: {len(rows)} months, "
      f"with yield data: {sum(1 for r in rows if r['port_yield'] is not None)}, "
      f"with z-score: {sum(1 for r in rows if r.get('port_z') is not None)}")

# ── Save CSV ───────────────────────────────────────────────────────────────────
import csv as csv_mod
out_csv = str(Path(SCRATCHPAD) / "composite_valuation.csv")
fields = ['date',
          'SBER_yield','YDEX_yield','T_yield','DOMRF_yield','OZON_yield','ROSN_yield','VTBR_yield',
          'portfolio_yield','ofz10y','erp',
          'SBER_z','YDEX_z','T_z','DOMRF_z','OZON_z','ROSN_z','VTBR_z',
          'portfolio_z','ofz_z','composite_erp_z']
with open(out_csv, 'w', newline='') as f:
    w = csv_mod.DictWriter(f, fieldnames=fields)
    w.writeheader()
    for r in rows:
        row_out = {'date': r['date']}
        for t in ['SBER','YDEX','T','DOMRF','OZON','ROSN','VTBR']:
            row_out[f'{t}_yield'] = round(r[f'{t}_yield'], 4) if r.get(f'{t}_yield') is not None else ''
            row_out[f'{t}_z']     = round(r[f'{t}_z'], 4)     if r.get(f'{t}_z')     is not None else ''
        row_out['portfolio_yield']   = round(r['port_yield'], 4)         if r['port_yield']         is not None else ''
        row_out['ofz10y']            = round(r['ofz10y'], 4)             if r['ofz10y']             is not None else ''
        row_out['erp']               = round(r['erp'], 4)                if r['erp']                is not None else ''
        row_out['portfolio_z']       = round(r['port_z'], 4)             if r.get('port_z')         is not None else ''
        row_out['ofz_z']             = round(r['ofz_z'], 4)              if r.get('ofz_z')          is not None else ''
        row_out['composite_erp_z']   = round(r['composite_erp_z'], 4)   if r.get('composite_erp_z') is not None else ''
        w.writerow(row_out)
print(f"\nCSV: {out_csv}")

# ── Charts ─────────────────────────────────────────────────────────────────────
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

def parse_dates(rows, key_check):
    return [datetime.strptime(r['date'], '%Y-%m') for r in rows if r.get(key_check) is not None]

# ── Chart 1: Layer 1 — Composite Yield vs OFZ (absolute %) ────────────────────
plot1 = [r for r in rows if r['port_yield'] is not None and r['ofz10y'] is not None]
d1 = [datetime.strptime(r['date'], '%Y-%m') for r in plot1]
ey1   = [r['port_yield'] for r in plot1]
ofz1  = [r['ofz10y']     for r in plot1]
erp1  = [r['erp']        for r in plot1]

fig, ax = plt.subplots(figsize=(16, 7))
fig.patch.set_facecolor('#0d1117')
ax.set_facecolor('#0d1117')

ax.plot(d1, ey1,  color='#4da8c8', linewidth=2,   label='Portfolio Composite Yield (EY/FCF/RevY)')
ax.plot(d1, ofz1, color='#f0b429', linewidth=2,   label='OFZ 10Y')
ax.plot(d1, erp1, color='#3dd68c', linewidth=2.5, label='Composite ERP (Yield − OFZ)')
ax.axhline(0, color='#6a7381', linewidth=1, linestyle='--', alpha=0.7)

ax.fill_between(d1, erp1, 0,
    where=[e >= 0 for e in erp1], alpha=0.12, color='#3dd68c', label='ERP > 0 (недооценка)')
ax.fill_between(d1, erp1, 0,
    where=[e < 0  for e in erp1], alpha=0.12, color='#e05252', label='ERP < 0 (переоценка)')

ax.set_title('Layer 1: Portfolio Composite Yield vs OFZ (аллокация акции/облигации)',
             color='#e6edf3', fontsize=12, pad=12)
ax.set_ylabel('%, годовых', color='#c9d1d9', fontsize=10)
ax.tick_params(colors='#6a7381', labelsize=8)
for spine in ax.spines.values(): spine.set_edgecolor('#1e2830')
ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
plt.xticks(rotation=45, ha='right')
ax.legend(facecolor='#13191f', edgecolor='#1e2830', labelcolor='#c9d1d9', fontsize=9)
ax.grid(axis='y', color='#1e2830', linewidth=0.5, alpha=0.7)
ax.grid(axis='x', color='#1e2830', linewidth=0.3, alpha=0.5)
fig.text(0.99, 0.01, f'Updated: {utc_timestamp()}', color='#6a7381', fontsize=7,
          ha='right', va='bottom')
CHARTS_DIR = Path(__file__).resolve().parent / "charts"
CHARTS_DIR.mkdir(parents=True, exist_ok=True)

plt.tight_layout()
plt.savefig(CHARTS_DIR / "composite_layer1.png", dpi=150,
            bbox_inches='tight', facecolor='#0d1117')
print(f"Chart 1 (Layer 1): {CHARTS_DIR / 'composite_layer1.png'}")

# ── Chart 2: Layer 2 — Z-scores per ticker ────────────────────────────────────
ticker_colors = {
    'SBER': '#4da8c8', 'YDEX': '#f0b429', 'T': '#3dd68c', 'DOMRF': '#22d3ee',
    'OZON': '#e05252', 'ROSN': '#a78bfa', 'VTBR': '#fb923c',
}
ticker_labels = {
    'SBER': 'SBER (EY)',  'YDEX': 'YDEX (Rev Yield)',
    'T':    'T (EY)',     'DOMRF': 'DOMRF (EY)',
    'OZON': 'OZON (Rev Yield)',
    'ROSN': 'ROSN (FCF)', 'VTBR': 'VTBR (EY)',
}

fig, (ax2, ax3) = plt.subplots(2, 1, figsize=(16, 12), sharex=True)
fig.patch.set_facecolor('#0d1117')

for ax_ in [ax2, ax3]:
    ax_.set_facecolor('#0d1117')
    for spine in ax_.spines.values(): spine.set_edgecolor('#1e2830')
    ax_.tick_params(colors='#6a7381', labelsize=8)
    ax_.grid(axis='y', color='#1e2830', linewidth=0.5, alpha=0.7)
    ax_.grid(axis='x', color='#1e2830', linewidth=0.3, alpha=0.5)
    ax_.axhline(0,    color='#6a7381', linewidth=1, linestyle='--', alpha=0.5)
    ax_.axhline(1.5,  color='#3dd68c', linewidth=0.8, linestyle=':', alpha=0.6)
    ax_.axhline(-1.5, color='#e05252', linewidth=0.8, linestyle=':', alpha=0.6)

# Top: individual tickers
all_dates_z = [datetime.strptime(r['date'], '%Y-%m') for r in rows]
for ticker in ['SBER', 'YDEX', 'T', 'DOMRF', 'OZON', 'ROSN', 'VTBR']:
    zvals = [r.get(f'{ticker}_z') for r in rows]
    cx, cy = [], []
    first_seg = True
    for d_, z_ in zip(all_dates_z, zvals):
        if z_ is not None:
            cx.append(d_); cy.append(z_)
        else:
            if cx:
                ax2.plot(cx, cy, color=ticker_colors[ticker], linewidth=1.5,
                         label=ticker_labels[ticker] if first_seg else '_nolegend_')
                first_seg = False; cx, cy = [], []
    if cx:
        ax2.plot(cx, cy, color=ticker_colors[ticker], linewidth=1.5,
                 label=ticker_labels[ticker] if first_seg else '_nolegend_')

ax2.set_ylabel('Z-score', color='#c9d1d9', fontsize=10)
ax2.set_title('Ребалансировка: каждая бумага дешевле (+) или дороже (−) своей нормы за последние 3 года',
              color='#e6edf3', fontsize=11, pad=8)
ax2.legend(facecolor='#13191f', edgecolor='#1e2830', labelcolor='#c9d1d9', fontsize=9)
ax2.autoscale(axis='y')
ax2.margins(y=0.08)

# Right-side labels for zones
ax2.text(0.01, 1.55, 'линия выше → эта бумага дешевле своей нормы → докупать',
         transform=ax2.get_yaxis_transform(),
         color='#3dd68c', fontsize=7.5, va='bottom', alpha=0.85)
ax2.text(0.01, -1.55, 'линия ниже → эта бумага дороже своей нормы → сокращать',
         transform=ax2.get_yaxis_transform(),
         color='#e05252', fontsize=7.5, va='top', alpha=0.85)

# Bottom: portfolio z vs OFZ z vs composite
for r in rows:
    pass

pz = [r.get('port_z') for r in rows]
oz = [r.get('ofz_z') for r in rows]
cz = [r.get('composite_erp_z') for r in rows]

def plot_series(ax_, dates, vals, color, label, lw=1.5):
    cx, cy = [], []
    first = True
    for d_, v_ in zip(dates, vals):
        if v_ is not None:
            cx.append(d_); cy.append(v_)
        else:
            if cx:
                lbl = label if first else '_nolegend_'
                ax_.plot(cx, cy, color=color, linewidth=lw, label=lbl)
                first = False; cx, cy = [], []
    if cx:
        lbl = label if first else '_nolegend_'
        ax_.plot(cx, cy, color=color, linewidth=lw, label=lbl)

plot_series(ax3, all_dates_z, pz, '#4da8c8', 'Portfolio Z', lw=1.5)
plot_series(ax3, all_dates_z, oz, '#f0b429', 'OFZ Z', lw=1.5)
plot_series(ax3, all_dates_z, cz, '#3dd68c', 'Composite ERP Z (Port − OFZ)', lw=2.5)

# Fill composite
cz_clean_x = [d_ for d_, v_ in zip(all_dates_z, cz) if v_ is not None]
cz_clean_y = [v_ for v_ in cz if v_ is not None]
if cz_clean_x:
    ax3.fill_between(cz_clean_x, cz_clean_y, 0,
        where=[v >= 0 for v in cz_clean_y], alpha=0.12, color='#3dd68c')
    ax3.fill_between(cz_clean_x, cz_clean_y, 0,
        where=[v < 0  for v in cz_clean_y], alpha=0.12, color='#e05252')

ax3.set_title('Аллокация: портфель дешевле (+) или дороже (−) своей нормы с поправкой на ставки',
              color='#e6edf3', fontsize=11, pad=8)
ax3.set_ylabel('Z-score', color='#c9d1d9', fontsize=10)
ax3.set_xlabel('')
ax3.legend(facecolor='#13191f', edgecolor='#1e2830', labelcolor='#c9d1d9', fontsize=9)
ax3.autoscale(axis='y')
ax3.margins(y=0.08)
ax3.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
ax3.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
plt.xticks(rotation=45, ha='right')

ax3.text(0.01, 1.55, 'зелёная выше → акции дёшевы vs ставки → больше акций',
         transform=ax3.get_yaxis_transform(),
         color='#3dd68c', fontsize=7.5, va='bottom', alpha=0.85)
ax3.text(0.01, -1.55, 'зелёная ниже → ставки высоки vs акции → больше ОФЗ',
         transform=ax3.get_yaxis_transform(),
         color='#e05252', fontsize=7.5, va='top', alpha=0.85)

fig.text(0.99, 0.01, f'Updated: {utc_timestamp()}', color='#6a7381', fontsize=7,
          ha='right', va='bottom')

plt.tight_layout()
plt.savefig(CHARTS_DIR / "composite_layer2.png", dpi=150,
            bbox_inches='tight', facecolor='#0d1117')
print(f"Chart 2 (Layer 2): {CHARTS_DIR / 'composite_layer2.png'}")
plt.close('all')
