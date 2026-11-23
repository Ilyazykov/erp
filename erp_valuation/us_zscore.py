"""
Standalone experiment: computes Yield (Earnings/Revenue/FCF, ticker-dependent)
and a Yield-based Z-score for a basket of US stocks. Purely an informational
overlay -- this basket is NOT part of the actual Russian-stock ERP portfolio
and does NOT touch the portfolio pipeline (composite_valuation.py,
erp_full.py, WEIGHTS, target_weights_base.json).

Mirrors the metric-selection logic of composite_valuation.py's LAYER2_METRIC
(SBER/T/VTBR/DOMRF/IRAO -> EY; ROSN/GMKN/PLZL -> FCF; YDEX/OZON -> Revenue),
and, like the Russian pipeline, EY is on the last twelve months' net income.
Yahoo's free endpoint gives only ~5 recent quarters, too few for a 36-month
Z-score, so the 12-month earnings come from two kinds of points: each fiscal
year's total (exact at its end) and the sum of four consecutive quarters.
    - EY: 12-month net income / market cap. A past month is interpolated between
      the points, 45 days back (the reporting lag); the current month takes the
      latest point already reported, so nothing unpublished gets in. A one-off
      quarter (far from the ticker's median) counts as that median.
    - Revenue Yield: latest annual revenue / market cap -- updates once a
      year. For unprofitable or volatile-earnings businesses.
    - FCF Yield: latest annual free cash flow / market cap -- updates once a
      year. For capital-intensive / cyclical businesses (energy, mining,
      REITs, utilities), regardless of net income sign.

Data source (no auth required): Yahoo Finance public endpoints
    - Prices: query1.finance.yahoo.com/v8/finance/chart
    - Annual revenue / net income / free cash flow / diluted shares:
      query2.finance.yahoo.com/ws/fundamentals-timeseries
      (this free endpoint only returns the ~4 most recent fiscal years,
      unlike the 9-18 years of annual history available for the Russian
      tickers via Smart-Lab). Quarterly net income / shares are saved to
      data/us_quarterly.csv; the net income feeds EY -- see above.

See TICKERS below for the full ticker -> metric assignment.

Outputs:
    data/us_prices.csv        (ticker, date, close)
    data/us_annual.csv        (ticker, year, end_date, revenue_bln, net_income_bln,
                                fcf_bln, diluted_shares_bln)  [USD, not RUB]
    data/us_quarterly.csv     (ticker, quarter, net_income_bln,
                                diluted_shares_bln)
    data/us_zscore.csv        (ticker, date, metric, yield_pct, z_score)

Run:
    python erp_valuation/us_zscore.py
"""
from __future__ import annotations

import csv
import json
import time
import urllib.request
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
PRICES_PATH = DATA_DIR / "us_prices.csv"
ANNUAL_PATH = DATA_DIR / "us_annual.csv"
QUARTERLY_PATH = DATA_DIR / "us_quarterly.csv"
# quarters recovered from this file's git history: Yahoo keeps only ~5, stored ones are never dropped
QUARTERLY_HISTORY_PATH = DATA_DIR / "us_quarterly_history.csv"
# a quarter this far from the ticker's median (share of it) counts as one-off
ONE_OFF_SHARE = 0.75
OUT_PATH = DATA_DIR / "us_zscore.csv"

ZSCORE_WINDOW = 36

# ticker -> (metric, weight_pct). metric in {"EY", "Revenue", "FCF"}.
TICKERS: dict[str, tuple[str, float]] = {
    "GOOGL": ("EY", 6),
    "NVDA": ("EY", 5),
    "LLY": ("EY", 5),
    "CAT": ("FCF", 5),
    "LIN": ("FCF", 5),
    "GE": ("FCF", 4),
    "AMZN": ("Revenue", 4),
    "WMT": ("EY", 4),
    "XOM": ("FCF", 4),
    "NEE": ("FCF", 4),
    "PLD": ("FCF", 4),
    "JPM": ("EY", 3),
    "BRK-B": ("Revenue", 3),
    "JNJ": ("EY", 3),
    "META": ("EY", 3),
    "V": ("EY", 2),
    "MA": ("EY", 2),
    "HOOD": ("Revenue", 2),
    "MSFT": ("EY", 2),
    "AAPL": ("EY", 2),
    "ABBV": ("EY", 2),
    "TSLA": ("EY", 2),
    "HD": ("EY", 2),
    "PG": ("EY", 2),
    "KO": ("EY", 2),
    "SHEL": ("FCF", 2),
    "CVX": ("FCF", 2),
    "SHW": ("EY", 2),
    "DUK": ("FCF", 2),
    "AMT": ("FCF", 2),
    "SOFI": ("Revenue", 1.5),
    "XYZ": ("Revenue", 1.5),
    "INTC": ("Revenue", 1),
    "SPCX": ("Revenue", 1),
    "FCX": ("FCF", 1),
    "SO": ("FCF", 1),
    "EQIX": ("FCF", 1),
}


def fetch_url(url: str) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="replace")


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


def fetch_daily_prices(ticker: str, range_str: str = "5y") -> list[tuple[str, float]]:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={range_str}&interval=1d"
    data = json.loads(fetch_url(url))
    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    out = []
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = date.fromtimestamp(ts).isoformat()
        out.append((d, c))
    return out


def fetch_annual_fundamentals(ticker: str) -> list[dict]:
    """Returns list of {year, revenue_bln, net_income_bln, fcf_bln, diluted_shares_bln}."""
    types = "annualTotalRevenue,annualNetIncome,annualFreeCashFlow,annualDilutedAverageShares"
    p1 = int(time.time()) - 10 * 365 * 24 * 3600
    p2 = int(time.time())
    url = (
        f"https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}"
        f"?symbol={ticker}&type={types}&period1={p1}&period2={p2}"
    )
    data = json.loads(fetch_url(url))
    by_year: dict[int, dict] = {}
    key_map = {
        "annualTotalRevenue": "revenue_bln",
        "annualNetIncome": "net_income_bln",
        "annualFreeCashFlow": "fcf_bln",
        "annualDilutedAverageShares": "diluted_shares_bln",
    }
    for series in data.get("timeseries", {}).get("result", []):
        stype = series["meta"]["type"][0]
        field = key_map.get(stype)
        if field is None or stype not in series:
            continue
        for item in series[stype]:
            year = int(item["asOfDate"][:4])
            raw = item["reportedValue"]["raw"]
            entry = by_year.setdefault(year, {"year": year, "end_date": item["asOfDate"]})
            entry[field] = raw / 1e9
    return sorted(by_year.values(), key=lambda r: r["year"])


def fetch_quarterly_fundamentals(ticker: str) -> list[dict]:
    """Returns list of {quarter (e.g. '2025Q2'), net_income_bln, diluted_shares_bln}."""
    types = "quarterlyNetIncome,quarterlyDilutedAverageShares"
    p1 = int(time.time()) - 5 * 365 * 24 * 3600
    p2 = int(time.time())
    url = (
        f"https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}"
        f"?symbol={ticker}&type={types}&period1={p1}&period2={p2}"
    )
    data = json.loads(fetch_url(url))
    by_quarter: dict[str, dict] = {}
    key_map = {
        "quarterlyNetIncome": "net_income_bln",
        "quarterlyDilutedAverageShares": "diluted_shares_bln",
    }
    for series in data.get("timeseries", {}).get("result", []):
        stype = series["meta"]["type"][0]
        field = key_map.get(stype)
        if field is None or stype not in series:
            continue
        for item in series[stype]:
            as_of = item["asOfDate"]
            y, m, d = int(as_of[:4]), int(as_of[5:7]), int(as_of[8:10])
            q = (m - 1) // 3 + 1
            qstr = f"{y}Q{q}"
            raw = item["reportedValue"]["raw"]
            entry = by_quarter.setdefault(qstr, {"quarter": qstr, "end_date": as_of})
            entry[field] = raw / 1e9
    return sorted(by_quarter.values(), key=lambda r: r["quarter"])


def update_prices() -> None:
    for ticker in TICKERS:
        existing = read_csv(PRICES_PATH)
        existing_for_ticker = {r["date"] for r in existing if r["ticker"] == ticker}
        try:
            fetched = fetch_daily_prices(ticker)
        except Exception as e:
            print(f"  {ticker} prices error: {e}")
            continue
        new_rows = [
            {"ticker": ticker, "date": d, "close": c}
            for d, c in fetched
            if d not in existing_for_ticker
        ]
        if new_rows:
            all_rows = [r for r in existing if r["ticker"] != ticker] + [
                {"ticker": ticker, "date": d, "close": c} for d, c in fetched
            ]
            all_rows.sort(key=lambda r: (r["ticker"], r["date"]))
            write_csv(PRICES_PATH, ["ticker", "date", "close"], all_rows)
            print(f"  {ticker}: {len(fetched)} price rows (through {fetched[-1][0]})")
        else:
            print(f"  {ticker}: no prices fetched")
        time.sleep(0.2)


def update_quarterly() -> None:
    all_rows = []
    for ticker in TICKERS:
        try:
            rows = fetch_quarterly_fundamentals(ticker)
        except Exception as e:
            print(f"  {ticker} quarterly fundamentals error: {e}")
            continue
        for r in rows:
            all_rows.append({
                "ticker": ticker,
                "quarter": r["quarter"],
                "end_date": r["end_date"],
                "net_income_bln": round(r.get("net_income_bln"), 4) if r.get("net_income_bln") is not None else "",
                "diluted_shares_bln": round(r.get("diluted_shares_bln"), 6) if r.get("diluted_shares_bln") is not None else "",
            })
        print(f"  {ticker}: {len(rows)} quarters")
        time.sleep(0.2)
    stored: dict[tuple[str, str], dict] = {}
    for path in (QUARTERLY_HISTORY_PATH, QUARTERLY_PATH):
        if path.exists():
            for r in read_csv(path):
                stored[(r["ticker"], r["end_date"])] = r
    for r in all_rows:
        key = (r["ticker"], r["end_date"])
        stored[key] = {**stored.get(key, {}), **{k: v for k, v in r.items() if v != ""}}
    all_rows = [{f: r.get(f, "") for f in ("ticker", "quarter", "end_date", "net_income_bln", "diluted_shares_bln")}
                for _, r in sorted(stored.items())]
    write_csv(
        QUARTERLY_PATH,
        ["ticker", "quarter", "end_date", "net_income_bln", "diluted_shares_bln"],
        all_rows,
    )
    print(f"Saved {QUARTERLY_PATH}")


def update_annual() -> None:
    all_rows = []
    for ticker in TICKERS:
        try:
            rows = fetch_annual_fundamentals(ticker)
        except Exception as e:
            print(f"  {ticker} annual fundamentals error: {e}")
            continue
        for r in rows:
            all_rows.append({
                "ticker": ticker,
                "year": r["year"],
                "end_date": r["end_date"],
                "revenue_bln": round(r.get("revenue_bln"), 4) if r.get("revenue_bln") is not None else "",
                "net_income_bln": round(r.get("net_income_bln"), 4) if r.get("net_income_bln") is not None else "",
                "fcf_bln": round(r.get("fcf_bln"), 4) if r.get("fcf_bln") is not None else "",
                "diluted_shares_bln": round(r.get("diluted_shares_bln"), 6) if r.get("diluted_shares_bln") is not None else "",
            })
        print(f"  {ticker}: {len(rows)} annual fiscal years")
        time.sleep(0.2)
    all_rows.sort(key=lambda r: (r["ticker"], r["year"]))
    write_csv(
        ANNUAL_PATH,
        ["ticker", "year", "end_date", "revenue_bln", "net_income_bln", "fcf_bln", "diluted_shares_bln"],
        all_rows,
    )
    print(f"Saved {ANNUAL_PATH}")


def annual_report_date(row: dict) -> date:
    # US 10-K filings finalize within ~3 months after the fiscal year-end
    # (Yahoo's asOfDate, stored as end_date); without it, a calendar fiscal year
    end = date.fromisoformat(row["end_date"]) if row.get("end_date") else date(row["year"], 12, 31)
    return end + timedelta(days=90)


def quarter_end_to_report_date(end_date_str: str) -> date:
    # US 10-Q filings are due ~45 days after quarter-end for most filers
    # (mirrors the 45-day lag used for Russian tickers in
    # composite_valuation.py's quarter_str_to_report_date).
    y, m, d = int(end_date_str[:4]), int(end_date_str[5:7]), int(end_date_str[8:10])
    return date(y, m, d) + timedelta(days=45)


def get_ttm_ni(quarterly_data: list[dict], as_of: date) -> float | None:
    available = [
        r for r in quarterly_data
        if r.get("net_income_bln") is not None
        and quarter_end_to_report_date(r["end_date"]) <= as_of
    ]
    if len(available) < 4:
        return None
    available.sort(key=lambda r: r["quarter"])
    return sum(r["net_income_bln"] for r in available[-4:])


def without_one_offs(quarters: list[tuple[date, float]]) -> list[tuple[date, float]]:
    """A quarter far from the ticker's median (a revaluation, a write-off) takes the median."""
    if len(quarters) < 4:
        return quarters
    values = sorted(v for _, v in quarters)
    mid = len(values) // 2
    median = values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
    if median <= 0:
        return quarters
    return [(d, median if abs(v - median) > ONE_OFF_SHARE * median else v) for d, v in quarters]


def ttm_points(annual_data: list[dict], quarterly_data: list[dict]) -> list[tuple[date, float]]:
    """(period end, 12-month net income): fiscal years, then sums of four
    consecutive quarters, which win on a shared date."""
    points = {
        date.fromisoformat(r["end_date"]): r["net_income_bln"]
        for r in annual_data
        if r.get("end_date") and r.get("net_income_bln") is not None
    }
    quarters = without_one_offs(sorted(
        (date.fromisoformat(r["end_date"]), r["net_income_bln"])
        for r in quarterly_data
        if r.get("net_income_bln") is not None
    ))
    for i in range(3, len(quarters)):
        window = quarters[i - 3:i + 1]
        if 240 <= (window[-1][0] - window[0][0]).days <= 300:
            points[window[-1][0]] = sum(v for _, v in window)
    return sorted(points.items())


def ttm_earnings_at(points: list[tuple[date, float]], as_of: date, current: bool) -> float | None:
    """12-month net income known 45 days before as_of. A past month is
    interpolated between the points; the current one takes the last reported."""
    known_by = as_of - timedelta(days=45)
    before = [p for p in points if p[0] <= known_by]
    if not before:
        return None
    d0, v0 = before[-1]
    after = [p for p in points if p[0] > known_by]
    if current or not after:
        return v0
    d1, v1 = after[0]
    return v0 + (v1 - v0) * (known_by - d0).days / (d1 - d0).days


def get_latest_quarterly_shares(quarterly_data: list[dict], as_of: date) -> float | None:
    available = [
        r for r in quarterly_data
        if r.get("diluted_shares_bln") is not None
        and quarter_end_to_report_date(r["end_date"]) <= as_of
    ]
    if not available:
        return None
    available.sort(key=lambda r: r["quarter"])
    return available[-1]["diluted_shares_bln"]


def last_price_of_month(prices: dict[str, float], year: int, month: int) -> float | None:
    days_in_month = monthrange(year, month)[1]
    for day in range(days_in_month, 0, -1):
        ds = date(year, month, day).isoformat()
        if ds in prices:
            return prices[ds]
    return None


def get_latest_annual(annual_data: list[dict], field: str, as_of: date) -> float | None:
    available = [
        (r["year"], r[field])
        for r in annual_data
        if annual_report_date(r) <= as_of and r.get(field) not in (None, "")
    ]
    if not available:
        return None
    available.sort(key=lambda x: x[0])
    return available[-1][1]


def rolling_zscore(series: list[float | None], window: int = ZSCORE_WINDOW) -> list[float | None]:
    import math
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
    print("Updating US ticker prices...")
    update_prices()
    print("Updating US quarterly fundamentals (the recent 12-month earnings for EY)...")
    update_quarterly()
    print("Updating US annual fundamentals (Revenue/Net Income/FCF)...")
    update_annual()

    prices_rows = read_csv(PRICES_PATH)
    prices_by_ticker: dict[str, dict[str, float]] = {}
    for r in prices_rows:
        prices_by_ticker.setdefault(r["ticker"], {})[r["date"]] = float(r["close"])

    annual_rows = read_csv(ANNUAL_PATH)
    annual_by_ticker: dict[str, list[dict]] = {}
    for r in annual_rows:
        annual_by_ticker.setdefault(r["ticker"], []).append({
            "year": int(r["year"]),
            "end_date": r.get("end_date") or None,
            "revenue_bln": float(r["revenue_bln"]) if r["revenue_bln"] else None,
            "net_income_bln": float(r["net_income_bln"]) if r["net_income_bln"] else None,
            "fcf_bln": float(r["fcf_bln"]) if r["fcf_bln"] else None,
            "diluted_shares_bln": float(r["diluted_shares_bln"]) if r["diluted_shares_bln"] else None,
        })

    quarterly_by_ticker: dict[str, list[dict]] = {}
    for r in read_csv(QUARTERLY_PATH):
        quarterly_by_ticker.setdefault(r["ticker"], []).append({
            "end_date": r["end_date"],
            "net_income_bln": float(r["net_income_bln"]) if r["net_income_bln"] else None,
        })

    annual_field = {"EY": "net_income_bln", "Revenue": "revenue_bln", "FCF": "fcf_bln"}

    today = date.today()
    months = []
    y, m = 2021, 10
    while (y, m) <= (today.year, today.month):
        months.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1

    out_rows = []
    for ticker, (metric, _weight) in TICKERS.items():
        prices = prices_by_ticker.get(ticker, {})
        annual_data = annual_by_ticker.get(ticker, [])
        if not prices or not annual_data:
            print(f"  {ticker}: no data, skipping")
            continue

        points = ttm_points(annual_data, quarterly_by_ticker.get(ticker, [])) if metric == "EY" else []
        yields = []
        dates_ = []
        for y, m in months:
            as_of = today if (y, m) == (today.year, today.month) else date(y, m, monthrange(y, m)[1])
            price = last_price_of_month(prices, y, m)
            dates_.append(f"{y}-{m:02d}")
            if price is None:
                yields.append(None)
                continue

            shares = get_latest_annual(annual_data, "diluted_shares_bln", as_of)
            if shares is None or shares <= 0:
                yields.append(None)
                continue
            mcap = price * shares  # bln USD

            numerator = (
                ttm_earnings_at(points, as_of, (y, m) == (today.year, today.month))
                if metric == "EY"
                else get_latest_annual(annual_data, annual_field[metric], as_of)
            )
            yields.append(numerator / mcap * 100 if (numerator is not None and mcap > 0) else None)

        zscores = rolling_zscore(yields)
        for d, y_val, z in zip(dates_, yields, zscores):
            out_rows.append({
                "ticker": ticker,
                "date": d,
                "metric": metric,
                "yield_pct": round(y_val, 4) if y_val is not None else "",
                "z_score": round(z, 4) if z is not None else "",
            })

    write_csv(OUT_PATH, ["ticker", "date", "metric", "yield_pct", "z_score"], out_rows)
    print(f"Saved {OUT_PATH}")
    populated = sum(1 for r in out_rows if r["z_score"] != "")
    print(f"Total rows: {len(out_rows)}, with z-score: {populated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
