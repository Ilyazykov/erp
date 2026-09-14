"""
Damodaran's annual Implied ERP (FCFE), stepped across months for direct
visual comparison against Shiller's Excess CAPE Yield on the US ERP tab.

There is no independently-published MONTHLY Implied ERP series from
Damodaran -- his own site only publishes an ANNUAL figure (histimpl.xls,
updated once a year). finobservatory.org's "Monthly, ERP (T12m)" chart is
not independent monthly data either: it reuses the latest annual figure
unchanged for every month until the next annual update (confirmed: their
2026-08 "monthly" value equals the 2025 annual value exactly). This script
reproduces that same step-function approach explicitly, rather than
inventing a different one -- see the module's row construction below.

Source (no auth required): Damodaran's own NYU Stern page
    https://pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xls
    ("Historical Impl Premiums" sheet; "Implied ERP (FCFE)" column, one row
    per year, latest year = latest available annual figure)

Outputs:
    data/damodaran_erp.csv   (date [YYYY-MM, stepped monthly], year, implied_erp_pct)

Run:
    python erp_valuation/damodaran_erp.py
"""
from __future__ import annotations

import csv
import urllib.request
from datetime import date
from pathlib import Path

import xlrd

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
OUT_PATH = DATA_DIR / "damodaran_erp.csv"

DAMODARAN_URL = "https://pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xls"
SHEET_NAME = "Historical Impl Premiums"
YEAR_COL = 0
IMPLIED_ERP_FCFE_COL = 15


def fetch_damodaran_xls() -> bytes:
    headers = {"User-Agent": "curl/8.0"}
    req = urllib.request.Request(DAMODARAN_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse_annual_implied_erp(xls_bytes: bytes) -> list[tuple[int, float]]:
    """Returns list of (year, implied_erp_fraction), sorted by year."""
    wb = xlrd.open_workbook(file_contents=xls_bytes)
    sheet = wb.sheet_by_name(SHEET_NAME)

    rows = []
    for r in range(sheet.nrows):
        year_val = sheet.cell_value(r, YEAR_COL)
        if not isinstance(year_val, float):
            continue
        year = int(year_val)
        if year < 1900:
            continue
        erp_val = sheet.cell_value(r, IMPLIED_ERP_FCFE_COL)
        if not isinstance(erp_val, float):
            continue
        rows.append((year, erp_val))
    rows.sort(key=lambda x: x[0])
    return rows


def step_to_monthly(annual: list[tuple[int, float]], through: date) -> list[dict]:
    """Reproduces finobservatory's step-function: each month's value equals
    the most recently published annual figure at that point in time, held
    flat until the next annual update. Only emits months from the first
    available annual year through `through` (today, by default)."""
    if not annual:
        return []

    by_year = dict(annual)
    first_year = annual[0][0]
    last_year = annual[-1][0]

    out = []
    year, month = first_year, 1
    while (year, month) <= (through.year, through.month):
        # The figure for `year` isn't published until some point during
        # that year (Damodaran typically publishes in early January for
        # the prior year); we approximate "current annual figure" as the
        # latest year <= this year that has data, matching finobservatory's
        # pinned-to-latest-annual behavior.
        available_year = year if year in by_year else max(
            (y for y in by_year if y <= year), default=None
        )
        if available_year is not None:
            out.append({
                "date": f"{year:04d}-{month:02d}",
                "year": available_year,
                "implied_erp_pct": round(by_year[available_year] * 100, 4),
            })
        month += 1
        if month > 12:
            month = 1
            year += 1
    return out


def main() -> int:
    print("Fetching Damodaran's histimpl.xls (Implied ERP, annual)...")
    xls_bytes = fetch_damodaran_xls()
    annual = parse_annual_implied_erp(xls_bytes)
    print(f"  Parsed {len(annual)} annual rows ({annual[0][0]} to {annual[-1][0]})")

    monthly_rows = step_to_monthly(annual, date.today())

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "year", "implied_erp_pct"])
        w.writeheader()
        w.writerows(monthly_rows)

    print(f"Saved {OUT_PATH}")
    print(f"Total rows: {len(monthly_rows)}")
    last = monthly_rows[-1]
    print(f"Latest ({last['date']}, pinned to annual {last['year']}): Implied ERP (FCFE) = {last['implied_erp_pct']}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
