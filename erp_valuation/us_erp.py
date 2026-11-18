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
import json
import math
import urllib.request
from datetime import date, datetime, timezone
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

# Shiller updates his file by hand, a month or two late (in Nov 2026 it
# still ended at Sept: "Sept price is Sept 1st close"). The user: "why do
# I need September when it's November" (18.11.2026). The months after his
# last one are estimated from what is known today, the same way he fills
# his own last rows, and marked estimated=1; his figures replace them as
# soon as he publishes:
#   CAPE = S&P 500 (the month's average close, so far) / E10, E10 -- the
#          10-year average real earnings -- grown from his last row at his
#          last month's pace (he extends the earnings himself, ~0.3%/month);
#   real rate = GS10 (the month's average of FRED's daily DGS10) minus the
#          10-year inflation his last row implies (it moves by hundredths);
#   CPI held at his last value, as he does himself.
GSPC_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=6mo&interval=1d"
DGS10_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"
TNX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=6mo&interval=1d"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def fetch_url(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def fetch_shiller_xls() -> bytes:
    return fetch_url(SHILLER_URL)


def monthly_means(points: list[tuple[str, float]]) -> dict[str, float]:
    """{YYYY-MM: the mean of that month's values} from (YYYY-MM-DD, value);
    the month not over yet (the last one) -- its latest value instead: a
    mean of the days so far would blur a drop of the last days, the very
    thing the Z-score is watched for (the user, 18.11.2026: "we may miss
    stocks getting cheaper"). Shiller does the same with his last month
    ("Sept price is Sept 1st close")."""
    acc: dict[str, list[float]] = {}
    for day, v in sorted(points):
        acc.setdefault(day[:7], []).append(v)
    out = {m: sum(vs) / len(vs) for m, vs in acc.items()}
    if acc and max(acc) == date.today().isoformat()[:7]:
        out[max(acc)] = acc[max(acc)][-1]
    return out


def fetch_yahoo_monthly(url: str) -> dict[str, float]:
    result = json.loads(fetch_url(url))["chart"]["result"][0]
    pts = [(datetime.fromtimestamp(ts, timezone.utc).date().isoformat(), c)
           for ts, c in zip(result["timestamp"], result["indicators"]["quote"][0]["close"]) if c is not None]
    return monthly_means(pts)


def fetch_gspc_monthly() -> dict[str, float]:
    return fetch_yahoo_monthly(GSPC_URL)


def fetch_dgs10_monthly() -> dict[str, float]:
    """FRED's DGS10 (what Shiller's GS10 is the monthly mean of); FRED
    unreachable -- Yahoo's ^TNX, the same 10-year yield in %."""
    try:
        pts = []
        for line in fetch_url(DGS10_URL).decode().splitlines()[1:]:
            day, _, v = line.partition(",")
            try:
                pts.append((day, float(v)))
            except ValueError:
                continue  # "." -- a holiday
        return monthly_means(pts)
    except Exception as e:
        print(f"  FRED DGS10 unreachable ({e}), using Yahoo ^TNX")
        return fetch_yahoo_monthly(TNX_URL)


def next_month(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{y + m // 12:04d}-{m % 12 + 1:02d}"


def estimate_after(shiller: list[dict], today: str) -> list[dict]:
    """The months from the one after Shiller's last to the current one."""
    last, prev = shiller[-1], shiller[-2]
    e10 = last["real_price"] / last["cape"]
    growth = e10 / (prev["real_price"] / prev["cape"])
    infl10 = last["gs10"] / 100 - (1 / last["cape"] - last["excess_cape_yield_pct"] / 100)
    gspc, dgs10 = fetch_gspc_monthly(), fetch_dgs10_monthly()
    out, month = [], next_month(last["date"])
    while month <= today[:7]:
        e10 *= growth
        if month not in gspc or month not in dgs10:
            break
        cape = gspc[month] / e10
        out.append({"date": month, "cape": cape, "estimated": True,
                    "excess_cape_yield_pct": (1 / cape - (dgs10[month] / 100 - infl10)) * 100})
        month = next_month(month)
    return out


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
            "real_price": sheet.cell_value(r, 7),
            "gs10": sheet.cell_value(r, 6),
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
    try:
        est = estimate_after(rows, date.today().isoformat())
        print(f"  Estimated after Shiller's last month: {', '.join(r['date'] for r in est) or 'none'}")
        rows += est
    except Exception as e:  # Yahoo / FRED down: Shiller's months alone, as before
        print(f"  No estimate for the months after Shiller's last: {e}")

    series = [r["excess_cape_yield_pct"] for r in rows]
    zscores = rolling_zscore(series)

    out_rows = [
        {
            "date": r["date"],
            "cape": round(r["cape"], 4),
            "excess_cape_yield_pct": round(r["excess_cape_yield_pct"], 4),
            "z_score": round(z, 4) if z is not None else "",
            "estimated": 1 if r.get("estimated") else "",
        }
        for r, z in zip(rows, zscores)
    ]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "cape", "excess_cape_yield_pct", "z_score", "estimated"])
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
