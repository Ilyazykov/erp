"""
Fetches the US Federal Funds Rate (the Fed's policy rate, direct analog of
the CBR key rate used for the Russian portfolio's stock/bond allocation)
via FRED's public, key-free CSV export endpoint and keeps
data/fed_funds_rate.csv up to date.

Series: DFF (Daily Federal Funds Rate) -- daily granularity (repeats over
weekends/holidays), rather than FEDFUNDS (monthly), so the site's
allocation donut can use the most current available value.

Outputs:
    data/fed_funds_rate.csv  (date, rate_pct)

Run:
    python erp_valuation/fetch_fed_funds_rate.py
"""
from __future__ import annotations

import csv
import urllib.request
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
CSV_PATH = DATA_DIR / "fed_funds_rate.csv"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF"


def fetch_fed_funds_rate() -> list[tuple[date, float]]:
    # Note: a typical browser User-Agent (e.g. a Mozilla/... string) causes
    # this specific FRED endpoint to hang indefinitely for some clients --
    # observed consistently in local testing, root cause unconfirmed (some
    # WAF/rate-limit behavior keyed on the UA string, not a redirect or TLS
    # issue). A curl-style UA avoids it; keep this if ever touching this URL.
    headers = {"User-Agent": "curl/8.0"}
    req = urllib.request.Request(FRED_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode("utf-8")

    records: list[tuple[date, float]] = []
    lines = text.strip().splitlines()
    for line in lines[1:]:  # skip header
        parts = line.split(",")
        if len(parts) != 2:
            continue
        d_str, v_str = parts
        if v_str in ("", "."):
            continue
        try:
            d = date.fromisoformat(d_str)
            rate = float(v_str)
        except ValueError:
            continue
        records.append((d, rate))
    return records


def write_csv(records: list[tuple[date, float]], path: Path = CSV_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "rate_pct"])
        for d, rate in sorted(records):
            writer.writerow([d.isoformat(), f"{rate:.2f}"])


def main() -> int:
    records = fetch_fed_funds_rate()
    if not records:
        print("Fed Funds Rate: no data returned")
        return 0
    write_csv(records)
    latest_date, latest_rate = max(records)
    print(f"Fed Funds Rate: {len(records)} rows, latest = {latest_date.isoformat()} {latest_rate:.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
