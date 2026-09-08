"""
Standalone experiment: computes both Earnings Yield and Revenue Yield (plus
a Revenue-Yield-based Z-score) for VKCO (VK Company, formerly Mail.ru
Group) — a loss-making, declining stock — purely to see how these metrics
behave on a falling/unprofitable company.

This does NOT touch the portfolio pipeline (composite_valuation.py,
erp_full.py, WEIGHTS, target_weights_base.json). VKCO is not, and should
not be, part of the actual portfolio. Output is a standalone CSV consumed
by the site's "VKCO" lines on the EY chart and the Revenue Yield chart,
both hidden behind the legend by default.

The Z-score is deliberately computed from Revenue Yield, not Earnings
Yield: VKCO's net income is negative most of the time, which would make an
EY-based Z-score mostly noise around a negative baseline rather than a
meaningful valuation signal -- the same reasoning already applied to
YDEX/OZON in the main pipeline. EY itself is still computed and reported
(just not Z-scored) so it can be plotted on the EY chart alongside the
other tickers.

Data sources (same as the rest of the project, no auth required):
    - Prices: MOEX ISS history API
    - Quarterly net income: Smart-Lab MSFO quarterly data (EY)
    - Annual revenue: Smart-Lab MSFO chart data (Revenue Yield)

Outputs:
    data/vkco_prices.csv        (date, close)
    data/vkco_quarterly_ni.csv  (quarter, net_income_bln)
    data/vkco_zscore.csv        (date, earnings_yield, revenue_yield, z_score,
                                 revenue_yield_v2, z_score_v2, revenue_v2_bln)
    data/vkco_revenue_predicted.json  ({"year": int, "revenue_bln": float})

revenue_yield_v2 / z_score_v2 are an EXPERIMENTAL alternate Revenue Yield
numerator: instead of holding the last reported annual revenue flat (a step
function that jumps on each report's publication date), a natural cubic
spline is fit through every real reported point plus one predicted point
(the next not-yet-reported year, via recency-weighted linear regression --
see predict_next_annual_revenue). The spline's value at each month becomes
the numerator, so the series moves smoothly instead of jumping. Once the
real report for a year is published, the predicted point is replaced by the
actual value and the whole spline is refit on the next run. Both the
original (v1) and this (v2) series are kept side by side for comparison.

Run:
    python erp_valuation/vkco_zscore_experiment.py
"""
from __future__ import annotations

import csv
import json
import math
import re
import time
import urllib.parse
import urllib.request
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from scipy.interpolate import CubicSpline

TICKER = "VKCO"
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
PRICES_PATH = DATA_DIR / "vkco_prices.csv"
REVENUE_PATH = DATA_DIR / "vkco_annual_revenue.csv"
QUARTERLY_NI_PATH = DATA_DIR / "vkco_quarterly_ni.csv"
OUT_PATH = DATA_DIR / "vkco_zscore.csv"
PREDICTED_REVENUE_PATH = DATA_DIR / "vkco_revenue_predicted.json"

QUARTER_END = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}

# Share count history. VK Company's 2023 redomiciliation from Cyprus-based
# Mail.ru Group Limited to a Russian MKPAO structure was a 1:1 legal-form
# conversion (no share-count change). The only material change to share
# count in the last several years is the 2025 additional share issuance
# (closed subscription, used to pay down debt):
#   - 239,375,040 shares from ~2019 through 2025-06-25
#   - 584,404,280 shares from 2025-06-26 (placement completion) onward
SHARES_CURRENT = 584_404_280
SHARES_HISTORY: list[tuple[date, int]] = [
    (date(2019, 1, 1), 239_375_040),
    (date(2025, 6, 26), 584_404_280),
]

ZSCORE_WINDOW = 36


def fetch_url(url: str, headers: dict | None = None) -> str:
    default_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9",
        "Referer": "https://smart-lab.ru/",
    }
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, headers=default_headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="replace")


def extract_json_object(s: str, start: int) -> str | None:
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if esc:
            esc = False
            continue
        if c == "\\" and in_str:
            esc = True
            continue
        if c == '"' and not esc:
            in_str = not in_str
            continue
        if not in_str:
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return s[start : i + 1]
    return None


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def update_prices() -> None:
    existing = read_csv(PRICES_PATH)
    existing_dates = {r["date"] for r in existing}
    last = max(existing_dates) if existing_dates else "2018-01-01"

    from_date = (date.fromisoformat(last) + timedelta(days=1)).isoformat()
    today = date.today().isoformat()
    if from_date > today:
        print(f"  {TICKER}: prices up to date ({last})")
        return

    new_rows = []
    start = 0
    while True:
        url = (
            f"https://iss.moex.com/iss/history/engines/stock/markets/shares"
            f"/boards/TQBR/securities/{TICKER}.json"
            f"?from={from_date}&till={today}&start={start}&limit=100"
        )
        try:
            html = fetch_url(url)
            data = json.loads(html)
            history = data["history"]
            cols = history["columns"]
            rows = history["data"]
            if not rows:
                break
            date_idx = cols.index("TRADEDATE")
            close_idx = cols.index("CLOSE")
            for row in rows:
                d = row[date_idx]
                c = row[close_idx]
                if d and c is not None and d not in existing_dates:
                    new_rows.append({"date": d, "close": c})
                    existing_dates.add(d)
            if len(rows) < 100:
                break
            start += 100
            time.sleep(0.1)
        except Exception as e:
            print(f"  {TICKER} prices error at start={start}: {e}")
            break

    if new_rows:
        all_rows = existing + new_rows
        all_rows.sort(key=lambda r: r["date"])
        write_csv(PRICES_PATH, ["date", "close"], all_rows)
        print(f"  {TICKER}: +{len(new_rows)} price rows (now through {max(r['date'] for r in new_rows)})")
    else:
        print(f"  {TICKER}: no new prices")


def fetch_annual_revenue() -> list[tuple[int, float | None]]:
    url = f"https://smart-lab.ru/q/{TICKER}/MSFO/revenue/"
    html = fetch_url(url)
    m = re.search(r"'diagram'\s*:\s*(\{)", html)
    if not m:
        return []
    raw = extract_json_object(html, m.start(1))
    if not raw:
        return []
    data = json.loads(raw)
    cats = data.get("categories", [])
    items = data.get("data", [])
    result = []
    for i, cat in enumerate(cats):
        val = items[i].get("y") if i < len(items) else None
        if re.match(r"^\d{4}$", str(cat)):
            result.append((int(cat), val))
    return result


def update_revenue() -> None:
    existing = read_csv(REVENUE_PATH)
    existing_years = {int(r["year"]) for r in existing}

    data = fetch_annual_revenue()
    new_rows = []
    for year, val in data:
        if year not in existing_years:
            new_rows.append({"year": year, "revenue_bln": val if val is not None else ""})
            existing_years.add(year)

    if new_rows:
        all_rows = existing + new_rows
        all_rows.sort(key=lambda r: int(r["year"]))
        write_csv(REVENUE_PATH, ["year", "revenue_bln"], all_rows)
        print(f"  {TICKER}/revenue: +{len(new_rows)} years")
    else:
        print(f"  {TICKER}/revenue: up to date")


def annual_report_date(year: int) -> date:
    return date(year + 1, 3, 1)


def quarter_str_to_report_date(qstr: str) -> date:
    year, q = int(qstr[:4]), int(qstr[5])
    if q == 4:
        return date(year + 1, 1, 1)
    qend = date(year, QUARTER_END[q][0], QUARTER_END[q][1])
    return qend + timedelta(days=45)


def fetch_quarterly_ni() -> list[tuple[str, float | None]]:
    """Returns list of (qstr, value) from Smart-Lab quarterly page (last 5 quarters)."""
    url = f"https://smart-lab.ru/q/{TICKER}/f/q/MSFO/"
    html = fetch_url(url)

    m = re.search(r'<tr class="header_row">(.*?)</tr>', html, re.DOTALL)
    if not m:
        return []
    header_cells = re.findall(r'<(?:th|td)[^>]*><strong>(\d{4}Q\d)</strong>', m.group(1))

    ni_m = re.search(r'<tr[^>]*field="net_income"[^>]*>(.*?)</tr>', html, re.DOTALL)
    if not ni_m:
        return []
    cells = re.findall(r"<td[^>]*>(.*?)</td>", ni_m.group(1), re.DOTALL)
    vals = [re.sub(r"<[^>]+>", "", c).strip().replace("\xa0", "").replace(" ", "") for c in cells]
    vals = [v for v in vals if v and v != "&nbsp;"]

    result = []
    for i, qstr in enumerate(header_cells):
        if i < len(vals):
            try:
                result.append((qstr, float(vals[i])))
            except ValueError:
                result.append((qstr, None))
    return result


def update_quarterly_ni() -> None:
    existing = read_csv(QUARTERLY_NI_PATH)
    existing_keys = {r["quarter"] for r in existing}

    quarters = fetch_quarterly_ni()
    new_rows = []
    for qstr, val in quarters:
        if qstr not in existing_keys:
            new_rows.append({"quarter": qstr, "net_income_bln": val if val is not None else ""})
            existing_keys.add(qstr)

    if new_rows:
        all_rows = existing + new_rows
        all_rows.sort(key=lambda r: r["quarter"])
        write_csv(QUARTERLY_NI_PATH, ["quarter", "net_income_bln"], all_rows)
        print(f"  {TICKER} quarterly NI: +{len(new_rows)} quarters")
    else:
        print(f"  {TICKER} quarterly NI: up to date")


def get_ttm_ni(quarterly: list[tuple[str, float | None, date]], as_of: date) -> float | None:
    available = [(q, ni, rd) for q, ni, rd in quarterly if rd <= as_of and ni is not None]
    if len(available) < 4:
        return None
    available.sort(key=lambda x: x[0])
    return sum(x[1] for x in available[-4:])


def get_shares(as_of: date) -> int:
    shares = SHARES_CURRENT
    for effective_from, count in SHARES_HISTORY:
        if as_of >= effective_from:
            shares = count
    if shares is None:
        raise ValueError("SHARES_CURRENT/SHARES_HISTORY not configured yet")
    return shares


def last_price_of_month(prices: dict[str, float], year: int, month: int) -> float | None:
    days_in_month = monthrange(year, month)[1]
    for day in range(days_in_month, 0, -1):
        ds = date(year, month, day).isoformat()
        if ds in prices:
            return prices[ds]
    return None


def get_latest_annual_revenue(revenue_data: list[tuple[int, float | None]], as_of: date) -> float | None:
    available = [(yr, val) for yr, val in revenue_data if annual_report_date(yr) <= as_of and val is not None]
    if not available:
        return None
    available.sort(key=lambda x: x[0])
    return available[-1][1]


# EXPERIMENTAL: alternate revenue numerator for Revenue Yield, proposed as a
# smoother replacement for the step function above. Two ingredients:
#   1. Weighted linear regression (recency-weighted OLS, weight = 0.75^(years
#      ago)) predicts the next not-yet-reported annual revenue figure.
#   2. A single natural cubic spline is fit through every REAL reported point
#      plus that one predicted point, and its value at any given date becomes
#      the numerator -- so the transition between reported years is smooth
#      instead of an instant jump on the report publication date.
# When the real report for that year is published, the predicted point is
# replaced by the actual value and the whole spline (and every derived
# monthly value) is recomputed from scratch on the next run.
REVENUE_SPLINE_WEIGHT_LAMBDA = 0.75


def predict_next_annual_revenue(revenue_data: list[tuple[int, float | None]]) -> tuple[int, float] | None:
    known = sorted((yr, val) for yr, val in revenue_data if val is not None)
    if len(known) < 2:
        return None
    years = np.array([yr for yr, _ in known], dtype=float)
    values = np.array([val for _, val in known], dtype=float)
    n = len(known)
    weights = np.array([REVENUE_SPLINE_WEIGHT_LAMBDA ** (n - 1 - i) for i in range(n)])
    w_sum = weights.sum()
    xw_mean = np.sum(weights * years) / w_sum
    yw_mean = np.sum(weights * values) / w_sum
    denom = np.sum(weights * (years - xw_mean) ** 2)
    if denom < 1e-9:
        return None
    slope = np.sum(weights * (years - xw_mean) * (values - yw_mean)) / denom
    intercept = yw_mean - slope * xw_mean
    next_year = int(years[-1]) + 1
    return next_year, float(slope * next_year + intercept)


def build_revenue_spline(revenue_data: list[tuple[int, float | None]]):
    """Returns (spline_fn, min_date, max_date) or None if too few points."""
    known = sorted((yr, val) for yr, val in revenue_data if val is not None)
    points = [(annual_report_date(yr), val) for yr, val in known]
    predicted = predict_next_annual_revenue(revenue_data)
    if predicted is not None:
        pred_year, pred_val = predicted
        points.append((annual_report_date(pred_year), pred_val))
    if len(points) < 4:
        return None
    points.sort()
    x0 = points[0][0]
    xs = np.array([(d - x0).days for d, _ in points], dtype=float)
    ys = np.array([v for _, v in points], dtype=float)
    cs = CubicSpline(xs, ys, bc_type="natural")

    def spline_fn(as_of: date) -> float:
        return float(cs((as_of - x0).days))

    return spline_fn, points[0][0], points[-1][0]


def get_smoothed_annual_revenue(
    revenue_data: list[tuple[int, float | None]],
    as_of: date,
    spline_bundle,
) -> float | None:
    """New (experimental) numerator: spline through real + predicted points.
    Falls back to linear interpolation between the two nearest known points
    (or the old step-function value) when too few points exist for a spline,
    and never extrapolates before the first known point or past the
    predicted point."""
    known = sorted(
        [(annual_report_date(yr), val) for yr, val in revenue_data if val is not None]
    )
    if not known:
        return None
    if as_of <= known[0][0]:
        return known[0][1]

    if spline_bundle is not None:
        spline_fn, min_date, max_date = spline_bundle
        clamped = min(max(as_of, min_date), max_date)
        return spline_fn(clamped)

    # Fewer than 4 known points: linear interpolation between neighbors.
    if as_of >= known[-1][0]:
        return known[-1][1]
    for (d0, v0), (d1, v1) in zip(known, known[1:]):
        if d0 <= as_of <= d1:
            span = (d1 - d0).days
            if span <= 0:
                return v1
            frac = (as_of - d0).days / span
            return v0 + (v1 - v0) * frac
    return known[-1][1]


def rolling_zscore(series: list[float | None], window: int = ZSCORE_WINDOW) -> list[float | None]:
    result: list[float | None] = []
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
        result.append(0.0 if std < 1e-9 else (series[i] - mean) / std)
    return result


def main() -> int:
    print(f"Updating {TICKER} prices...")
    update_prices()
    print(f"Updating {TICKER} annual revenue...")
    update_revenue()
    print(f"Updating {TICKER} quarterly net income...")
    update_quarterly_ni()

    prices_rows = read_csv(PRICES_PATH)
    prices = {r["date"]: float(r["close"]) for r in prices_rows}
    revenue_rows = read_csv(REVENUE_PATH)
    revenue_data = [
        (int(r["year"]), float(r["revenue_bln"]) if r["revenue_bln"] else None) for r in revenue_rows
    ]
    ni_rows = read_csv(QUARTERLY_NI_PATH)
    quarterly_ni = [
        (r["quarter"], float(r["net_income_bln"]) if r["net_income_bln"] else None,
         quarter_str_to_report_date(r["quarter"]))
        for r in ni_rows
    ]

    if not prices:
        print(f"No price data for {TICKER} yet; nothing to compute.")
        return 0

    today = date.today()
    months = []
    y, m = 2019, 1
    while (y, m) <= (today.year, today.month):
        months.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1

    spline_bundle = build_revenue_spline(revenue_data)
    predicted = predict_next_annual_revenue(revenue_data)
    if predicted is not None:
        print(f"  {TICKER}/revenue smoothed numerator: predicted {predicted[0]} = {predicted[1]:.1f} bln RUB")
        PREDICTED_REVENUE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with PREDICTED_REVENUE_PATH.open("w", encoding="utf-8") as f:
            json.dump({"year": predicted[0], "revenue_bln": round(predicted[1], 4)}, f)

    dates, rev_yields, ey_yields, rev_yields_v2, revenues_v2 = [], [], [], [], []
    for y, m in months:
        as_of = today if (y, m) == (today.year, today.month) else date(y, m, monthrange(y, m)[1])
        price = last_price_of_month(prices, y, m)
        dates.append(f"{y}-{m:02d}")
        if price is None:
            rev_yields.append(None)
            ey_yields.append(None)
            rev_yields_v2.append(None)
            revenues_v2.append(None)
            continue
        shares = get_shares(as_of)
        mcap = price * shares / 1e9

        revenue = get_latest_annual_revenue(revenue_data, as_of)
        rev_yields.append(revenue / mcap * 100 if (revenue is not None and mcap > 0) else None)

        revenue_v2 = get_smoothed_annual_revenue(revenue_data, as_of, spline_bundle)
        revenues_v2.append(revenue_v2)
        rev_yields_v2.append(revenue_v2 / mcap * 100 if (revenue_v2 is not None and mcap > 0) else None)

        ttm_ni = get_ttm_ni(quarterly_ni, as_of)
        ey_yields.append(ttm_ni / mcap * 100 if (ttm_ni is not None and mcap > 0) else None)

    zscores = rolling_zscore(rev_yields)
    zscores_v2 = rolling_zscore(rev_yields_v2)

    out_rows = [
        {
            "date": d,
            "earnings_yield": round(ey, 4) if ey is not None else "",
            "revenue_yield": round(rv, 4) if rv is not None else "",
            "z_score": round(z, 4) if z is not None else "",
            "revenue_yield_v2": round(rv2, 4) if rv2 is not None else "",
            "z_score_v2": round(z2, 4) if z2 is not None else "",
            "revenue_v2_bln": round(r2, 4) if r2 is not None else "",
        }
        for d, ey, rv, z, rv2, z2, r2 in zip(
            dates, ey_yields, rev_yields, zscores, rev_yields_v2, zscores_v2, revenues_v2
        )
    ]
    write_csv(
        OUT_PATH,
        [
            "date", "earnings_yield", "revenue_yield", "z_score",
            "revenue_yield_v2", "z_score_v2", "revenue_v2_bln",
        ],
        out_rows,
    )
    print(f"Saved {OUT_PATH}")

    populated = sum(1 for r in out_rows if r["z_score"] != "")
    print(f"Total months: {len(out_rows)}, with z-score: {populated}")
    if out_rows:
        last = out_rows[-1]
        print(
            f"Latest ({last['date']}): earnings_yield={last['earnings_yield']} "
            f"revenue_yield={last['revenue_yield']} z_score={last['z_score']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
