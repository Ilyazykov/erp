"""
US Equity Risk Premium (ERP) chart, mirroring the Russian portfolio's
Layer 1 (composite_valuation.py: Portfolio EY - OFZ 10Y) in spirit, but NOT
computed from our own 37-ticker basket. Rather than build a from-scratch
market-cap-weighted EY across the basket (a different methodology than the
Russian side, which uses TTM net income / market cap), this uses a
published, authoritative market-wide ERP proxy instead: Robert Shiller's
"Excess CAPE Yield" -- monthly, going back to 1871, still actively
maintained (updated through the file's own "last saved" date each month).

Excess CAPE Yield = (1 / CAPE) - real long-term interest rate
                   = cyclically-adjusted earnings yield of the S&P 500,
                     minus the real (inflation-adjusted) 10-year rate

This is conceptually the same idea as Portfolio EY - OFZ 10Y (an earnings
yield minus a risk-free rate = the market's compensation for holding
equities over bonds), just for the whole US market rather than this
specific 37-ticker basket, and using Shiller's cyclically-adjusted (CAPE)
earnings rather than trailing-twelve-month earnings, and a REAL rather than
nominal long rate. It is NOT the same number as Damodaran's annual
"Implied ERP" (a DCF/DDM-implied premium) -- both are reputable, published
ERP measures, but computed with different methodologies.

Data source (no auth required): Robert Shiller's own maintained spreadsheet
    https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/
    downloads/70fec4f5-727f-4e53-b5f1-179af109c5fa/ie_data.xls
    ("Data" sheet, monthly rows from 1871 to present; column "Excess CAPE
    Yield" is used directly, with no recomputation).

Z-score: rolling 36-month window, computed across the FULL available
history (1871-present) so it doesn't take 3 years for the site to start
showing any signal, mirroring the Russian portfolio's own Z-score window.
The chart itself is trimmed to display only from CHART_START_YEAR onward
(matching the site's other charts, which show 2019+/2021+), even though the
underlying Z-score calculation used the full history.

Outputs:
    data/us_erp.csv   (date, cape, excess_cape_yield_pct, z_score)

Run:
    python erp_valuation/us_erp.py
"""
from __future__ import annotations

import csv
import math
import urllib.request
from pathlib import Path

import xlrd

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
OUT_PATH = DATA_DIR / "us_erp.csv"

SHILLER_URL = (
    "https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/"
    "downloads/70fec4f5-727f-4e53-b5f1-179af109c5fa/ie_data.xls"
)

ZSCORE_WINDOW = 36
CHART_START_YEAR = 2019  # matches the rest of the site's visible date range


def fetch_shiller_xls() -> bytes:
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
    req = urllib.request.Request(SHILLER_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse_excess_cape_yield(xls_bytes: bytes) -> list[dict]:
    """Returns list of {date (YYYY-MM), cape, excess_cape_yield_pct}, sorted by date."""
    wb = xlrd.open_workbook(file_contents=xls_bytes)
    sheet = wb.sheet_by_name("Data")

    rows = []
    for r in range(8, sheet.nrows):
        raw_date = sheet.cell_value(r, 0)
        if not isinstance(raw_date, float) or raw_date <= 0:
            continue
        year = int(raw_date)
        month = round((raw_date - year) * 100)
        if month == 0:
            month = 12
            year -= 1
        cape = sheet.cell_value(r, 12)
        excess_yield = sheet.cell_value(r, 16)
        if not isinstance(cape, float) or not isinstance(excess_yield, float):
            continue
        rows.append({
            "date": f"{year:04d}-{month:02d}",
            "cape": cape,
            "excess_cape_yield_pct": excess_yield * 100,
        })
    rows.sort(key=lambda r: r["date"])
    return rows


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
    print("Fetching Shiller's ie_data.xls (Excess CAPE Yield)...")
    xls_bytes = fetch_shiller_xls()
    rows = parse_excess_cape_yield(xls_bytes)
    print(f"  Parsed {len(rows)} monthly rows ({rows[0]['date']} to {rows[-1]['date']})")

    series = [r["excess_cape_yield_pct"] for r in rows]
    zscores = rolling_zscore(series)

    out_rows = [
        {
            "date": r["date"],
            "cape": round(r["cape"], 4),
            "excess_cape_yield_pct": round(r["excess_cape_yield_pct"], 4),
            "z_score": round(z, 4) if z is not None else "",
        }
        for r, z in zip(rows, zscores)
    ]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "cape", "excess_cape_yield_pct", "z_score"])
        w.writeheader()
        w.writerows(out_rows)

    print(f"Saved {OUT_PATH}")
    populated = sum(1 for r in out_rows if r["z_score"] != "")
    print(f"Total rows: {len(out_rows)}, with z-score: {populated}")
    last = out_rows[-1]
    print(f"Latest ({last['date']}): CAPE={last['cape']}  ExcessCAPEYield={last['excess_cape_yield_pct']}%  Z={last['z_score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
