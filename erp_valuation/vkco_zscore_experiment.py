"""
Standalone experiment: computes a Revenue Yield Z-score for VKCO (VK Company,
formerly Mail.ru Group) — a loss-making, declining stock — purely to see how
the Z-score metric behaves on a falling/unprofitable company.

This does NOT touch the portfolio pipeline (composite_valuation.py,
erp_full.py, WEIGHTS, target_weights_base.json). VKCO is not, and should
not be, part of the actual portfolio. Output is a standalone CSV consumed
only by the "VKCO (Rev Yield, experimental)" line on the site's Layer 2:
Rebalancing chart, hidden behind the legend by default.

Revenue Yield (not Earnings Yield) is used deliberately: VKCO's net income
is negative most of the time, which would make EY-based Z-scores mostly
noise around a negative baseline rather than a meaningful valuation signal
-- the same reasoning already applied to YDEX/OZON in the main pipeline.

Data sources (same as the rest of the project, no auth required):
    - Prices: MOEX ISS history API
    - Annual revenue: Smart-Lab MSFO chart data

Outputs:
    data/vkco_prices.csv        (date, close)
    data/vkco_zscore.csv        (date, revenue_yield, z_score)

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

TICKER = "VKCO"
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
PRICES_PATH = DATA_DIR / "vkco_prices.csv"
REVENUE_PATH = DATA_DIR / "vkco_annual_revenue.csv"
OUT_PATH = DATA_DIR / "vkco_zscore.csv"

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

    prices_rows = read_csv(PRICES_PATH)
    prices = {r["date"]: float(r["close"]) for r in prices_rows}
    revenue_rows = read_csv(REVENUE_PATH)
    revenue_data = [
        (int(r["year"]), float(r["revenue_bln"]) if r["revenue_bln"] else None) for r in revenue_rows
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

    dates, yields = [], []
    for y, m in months:
        as_of = today if (y, m) == (today.year, today.month) else date(y, m, monthrange(y, m)[1])
        price = last_price_of_month(prices, y, m)
        revenue = get_latest_annual_revenue(revenue_data, as_of)
        if price is None or revenue is None:
            dates.append(f"{y}-{m:02d}")
            yields.append(None)
            continue
        shares = get_shares(as_of)
        mcap = price * shares / 1e9
        dates.append(f"{y}-{m:02d}")
        yields.append(revenue / mcap * 100 if mcap > 0 else None)

    zscores = rolling_zscore(yields)

    out_rows = [
        {
            "date": d,
            "revenue_yield": round(y, 4) if y is not None else "",
            "z_score": round(z, 4) if z is not None else "",
        }
        for d, y, z in zip(dates, yields, zscores)
    ]
    write_csv(OUT_PATH, ["date", "revenue_yield", "z_score"], out_rows)
    print(f"Saved {OUT_PATH}")

    populated = sum(1 for r in out_rows if r["z_score"] != "")
    print(f"Total months: {len(out_rows)}, with z-score: {populated}")
    if out_rows:
        last = out_rows[-1]
        print(f"Latest ({last['date']}): revenue_yield={last['revenue_yield']} z_score={last['z_score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
