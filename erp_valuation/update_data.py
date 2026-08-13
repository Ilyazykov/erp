"""
update_data.py — дозагружает только недостающие данные:
  - Цены акций с MOEX ISS (новые торговые дни)
  - OFZ 10Y с ЦБ РФ (новые месяцы)
  - Квартальную прибыль с Smart-Lab (последние 5 кварталов)
  - Годовые FCF/Revenue с Smart-Lab

Запуск: python3 update_data.py
"""
import csv, json, re, time, urllib.request, urllib.parse
from datetime import date, timedelta
from calendar import monthrange

DATA_DIR = "./data"

TICKERS = ['SBER', 'ROSN', 'VTBR', 'YDEX', 'T', 'OZON']
# Pre-redomicile tickers also need price updates (historical only, won't have new data)
EXTRA_TICKERS = ['YNDX', 'TCSG']

# ── Helpers ───────────────────────────────────────────────────────────────────

def read_csv(path):
    try:
        with open(path) as f:
            return list(csv.DictReader(f))
    except FileNotFoundError:
        return []

def write_csv(path, fieldnames, rows):
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

def last_date_in_csv(path, date_col='date'):
    rows = read_csv(path)
    dates = [r[date_col] for r in rows if r.get(date_col)]
    return max(dates) if dates else None

def first_workday_of_month(year, month):
    for day in range(1, 8):
        try:
            d = date(year, month, day)
            if d.weekday() < 5:  # Mon-Fri
                return d
        except ValueError:
            pass
    return None

def extract_json_object(s, start):
    depth = 0; in_str = False; esc = False
    for i in range(start, len(s)):
        c = s[i]
        if esc: esc = False; continue
        if c == '\\' and in_str: esc = True; continue
        if c == '"' and not esc: in_str = not in_str; continue
        if not in_str:
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: return s[start:i+1]
    return None

def fetch_url(url, headers=None):
    default_headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Referer': 'https://smart-lab.ru/',
    }
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, headers=default_headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8', errors='replace')

# ── 1. Prices from MOEX ISS ───────────────────────────────────────────────────

def update_prices(ticker):
    path = f"{DATA_DIR}/prices_{ticker}.csv"
    existing = read_csv(path)
    existing_dates = {r['date'] for r in existing}
    last = max(existing_dates) if existing_dates else '2018-01-01'

    # MOEX ISS pagination: fetch from day after last known
    from_date = (date.fromisoformat(last) + timedelta(days=1)).isoformat()
    today = date.today().isoformat()

    if from_date > today:
        print(f"  {ticker}: prices up to date ({last})")
        return 0

    new_rows = []
    start = 0
    while True:
        url = (f"https://iss.moex.com/iss/history/engines/stock/markets/shares"
               f"/boards/TQBR/securities/{ticker}.json"
               f"?from={from_date}&till={today}&start={start}&limit=100")
        try:
            html = fetch_url(url)
            data = json.loads(html)
            history = data['history']
            cols = history['columns']
            rows = history['data']
            if not rows:
                break
            date_idx  = cols.index('TRADEDATE')
            close_idx = cols.index('CLOSE')
            for row in rows:
                d = row[date_idx]
                c = row[close_idx]
                if d and c is not None and d not in existing_dates:
                    new_rows.append({'date': d, 'close': c})
                    existing_dates.add(d)
            if len(rows) < 100:
                break
            start += 100
            time.sleep(0.1)
        except Exception as e:
            print(f"  {ticker} prices error at start={start}: {e}")
            break

    if new_rows:
        all_rows = existing + new_rows
        all_rows.sort(key=lambda r: r['date'])
        write_csv(path, ['date', 'close'], all_rows)
        print(f"  {ticker}: +{len(new_rows)} price rows (now through {max(r['date'] for r in new_rows)})")
    else:
        print(f"  {ticker}: no new prices")
    return len(new_rows)

# ── 2. OFZ 10Y from CBR ZCYC ─────────────────────────────────────────────────

def fetch_ofz_for_date(d):
    """Fetch OFZ 10Y yield from CBR ZCYC for given date. Returns float or None."""
    url = "https://cbr.ru/hd_base/zcyc_params/zcyc/"
    date_str = d.strftime("%d.%m.%Y")
    data = urllib.parse.urlencode({
        'DateFrom': date_str,
        'DateTo':   date_str,
        'vintage':  '0',
    }).encode()
    req = urllib.request.Request(url, data=data, headers={
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://cbr.ru/',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode('utf-8', errors='replace')
        # Parse 10Y value from ZCYC table (maturity=10)
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            cells = [re.sub(r'<[^>]+>', '', c).strip().replace(',', '.') for c in cells]
            if len(cells) >= 2:
                try:
                    if abs(float(cells[0]) - 10.0) < 0.01:
                        return float(cells[1])
                except ValueError:
                    pass
        # Fallback: look for 10-year point in JSON-like structure
        m = re.search(r'"10[,\.]0+"?\s*[,:]?\s*"?([\d,\.]+)"?', html)
        if m:
            return float(m.group(1).replace(',', '.'))
    except Exception:
        pass
    return None

def update_ofz():
    path = f"{DATA_DIR}/ofz10y_monthly.csv"
    existing = read_csv(path)
    existing_dates = {r['date'] for r in existing}
    last = max(existing_dates) if existing_dates else '2019-01-01'

    last_date = date.fromisoformat(last)
    today = date.today()

    # Find months after last
    months_to_fetch = []
    y, m = last_date.year, last_date.month
    m += 1
    if m > 12: m, y = 1, y + 1
    while (y, m) <= (today.year, today.month):
        d = first_workday_of_month(y, m)
        if d and d <= today:
            months_to_fetch.append(d)
        m += 1
        if m > 12: m, y = 1, y + 1

    if not months_to_fetch:
        print(f"  OFZ: up to date ({last})")
        return 0

    new_rows = []
    for d in months_to_fetch:
        val = fetch_ofz_for_date(d)
        date_str = d.isoformat()
        if val:
            new_rows.append({'date': date_str, 'ofz10y_pct': round(val, 4)})
            print(f"  OFZ {date_str}: {val:.2f}%")
        else:
            new_rows.append({'date': date_str, 'ofz10y_pct': ''})
            print(f"  OFZ {date_str}: no data")
        time.sleep(0.4)

    if new_rows:
        all_rows = existing + new_rows
        write_csv(path, ['date', 'ofz10y_pct'], all_rows)
        print(f"  OFZ: +{len(new_rows)} months")
    return len(new_rows)

# ── 3. Quarterly NI from Smart-Lab ───────────────────────────────────────────

QUARTER_END = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}

def quarter_str_to_report_date(qstr):
    year, q = int(qstr[:4]), int(qstr[5])
    if q == 4:
        return date(year + 1, 1, 1)
    qend = date(year, QUARTER_END[q][0], QUARTER_END[q][1])
    return qend + timedelta(days=45)

def fetch_quarterly_ni(ticker):
    """Returns list of (qstr, value) from Smart-Lab quarterly page (last 5 quarters)."""
    url = f"https://smart-lab.ru/q/{ticker}/f/q/MSFO/"
    html = fetch_url(url)

    # Get column headers (quarter names)
    m = re.search(r'<tr class="header_row">(.*?)</tr>', html, re.DOTALL)
    if not m:
        return []
    header_cells = re.findall(r'<(?:th|td)[^>]*><strong>(\d{4}Q\d)</strong>', m.group(1))

    # Get net_income row
    ni_m = re.search(r'<tr[^>]*field="net_income"[^>]*>(.*?)</tr>', html, re.DOTALL)
    if not ni_m:
        return []
    cells = re.findall(r'<td[^>]*>(.*?)</td>', ni_m.group(1), re.DOTALL)
    vals = [re.sub(r'<[^>]+>', '', c).strip().replace('\xa0', '').replace(' ', '') for c in cells]
    # First cell is chart icon, skip it
    vals = [v for v in vals if v and v != '&nbsp;']

    result = []
    for i, qstr in enumerate(header_cells):
        if i < len(vals):
            try:
                result.append((qstr, float(vals[i])))
            except ValueError:
                result.append((qstr, None))
    return result

def update_quarterly_ni():
    path = f"{DATA_DIR}/quarterly_ni.csv"
    existing = read_csv(path)
    existing_keys = {(r['ticker'], r['quarter']) for r in existing}

    new_rows = []
    for ticker in TICKERS:
        print(f"  {ticker} quarterly NI...", end=' ', flush=True)
        try:
            quarters = fetch_quarterly_ni(ticker)
            added = 0
            for qstr, val in quarters:
                if (ticker, qstr) not in existing_keys:
                    v = str(val) if val is not None else ''
                    new_rows.append({'ticker': ticker, 'quarter': qstr, 'net_income_bln': v})
                    existing_keys.add((ticker, qstr))
                    added += 1
            print(f"+{added} quarters" if added else "up to date")
        except Exception as e:
            print(f"ERROR: {e}")
        time.sleep(0.5)

    if new_rows:
        all_rows = existing + new_rows
        write_csv(path, ['ticker', 'quarter', 'net_income_bln'], all_rows)
        print(f"  Quarterly NI: +{len(new_rows)} rows total")
    return len(new_rows)

# ── 4. Annual FCF / Revenue from Smart-Lab ───────────────────────────────────

ANNUAL_METRICS = {
    'ROSN': 'fcf',
    'YDEX': 'fcf',
    'OZON': 'revenue',
    'YDEX_revenue': ('YDEX', 'revenue'),  # YDEX also needs revenue for Layer 2
}

def fetch_annual_metric(ticker, metric):
    """Returns list of (year, value) — annual data from Smart-Lab chart page."""
    url = f"https://smart-lab.ru/q/{ticker}/MSFO/{metric}/"
    html = fetch_url(url)
    m = re.search(r"'diagram'\s*:\s*(\{)", html)
    if not m:
        return []
    raw = extract_json_object(html, m.start(1))
    if not raw:
        return []
    data = json.loads(raw)
    cats  = data.get('categories', [])
    items = data.get('data', [])
    result = []
    for i, cat in enumerate(cats):
        val = items[i].get('y') if i < len(items) else None
        if re.match(r'^\d{4}$', str(cat)):
            result.append((int(cat), val))
    return result

def update_annual_extra():
    path = f"{DATA_DIR}/annual_extra.csv"
    existing = read_csv(path)
    existing_keys = {(r['ticker'], r['metric'], r['year']) for r in existing}

    tasks = [
        ('ROSN', 'fcf'),
        ('YDEX', 'fcf'),
        ('YDEX', 'revenue'),
        ('OZON', 'revenue'),
    ]

    new_rows = []
    for ticker, metric in tasks:
        print(f"  {ticker}/{metric} annual...", end=' ', flush=True)
        try:
            data = fetch_annual_metric(ticker, metric)
            added = 0
            for year, val in data:
                key = (ticker, metric, str(year))
                if key not in existing_keys:
                    new_rows.append({
                        'ticker': ticker, 'metric': metric,
                        'year': year, 'value_bln': val if val is not None else ''
                    })
                    existing_keys.add(key)
                    added += 1
                else:
                    # Update most recent year in case it changed (LTM updated)
                    if year == max(y for t, met, y in existing_keys
                                   if t == ticker and met == metric):
                        for r in existing:
                            if r['ticker'] == ticker and r['metric'] == metric and int(r['year']) == year:
                                old_val = r['value_bln']
                                new_val = str(val) if val is not None else ''
                                if old_val != new_val:
                                    r['value_bln'] = new_val
                                    print(f"updated {year}: {old_val}→{new_val}", end=' ')
            print(f"+{added} years" if added else "up to date")
        except Exception as e:
            print(f"ERROR: {e}")
        time.sleep(0.5)

    if new_rows:
        all_rows = existing + new_rows
        write_csv(path, ['ticker', 'metric', 'year', 'value_bln'], all_rows)
        print(f"  Annual extra: +{len(new_rows)} rows total")
    elif existing:
        # Rewrite in case we updated in-place
        write_csv(path, ['ticker', 'metric', 'year', 'value_bln'], existing)
    return len(new_rows)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 50)
    print("Updating prices...")
    for ticker in TICKERS:
        update_prices(ticker)
    # YNDX and TCSG are historical only — skip unless they have recent data
    # update_prices('YNDX')
    # update_prices('TCSG')

    print("\nUpdating OFZ 10Y...")
    update_ofz()

    print("\nUpdating quarterly net income...")
    update_quarterly_ni()

    print("\nUpdating annual FCF/Revenue...")
    update_annual_extra()

    print("\n" + "=" * 50)
    print("Done. Now run composite_valuation.py to regenerate charts.")

if __name__ == '__main__':
    main()
