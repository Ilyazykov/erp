"""
One-off backfill script.

Fetches daily USD/RUB exchange rates from 2009-01-01 onward from the Bank
of Russia (CBR) public XML API and saves them to
data/usd_rub_history_5y.csv. Unlike data/usd_rub_history.csv (a 365-day
rolling window, trimmed daily), this file is append-only and keeps
growing forever — it is the source for the "w_CNY over 5 years" chart.

The chart itself starts around 2010-01 (a full year after 2009-01-01),
since the first 365 days of history are only used to warm up each day's
trailing 365-day average (m) and produce no visible w_CNY(t) point.

Data source: Bank of Russia "Dynamics of a currency rate" XML endpoint.
    https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=DD/MM/YYYY&date_req2=DD/MM/YYYY&VAL_NM_RQ=R01235
VAL_NM_RQ=R01235 is the CBR internal code for USD. No API key required.

Run once:
    python scripts/fetch_5y_history.py
"""

from __future__ import annotations

import csv
import sys
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree

import requests

CBR_DYNAMIC_URL = "https://www.cbr.ru/scripts/XML_dynamic.asp"
USD_CODE = "R01235"

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = REPO_ROOT / "data"
CSV_PATH = DATA_DIR / "usd_rub_history_5y.csv"

REQUEST_TIMEOUT = 60
HISTORY_START = date(2009, 1, 1)


def fetch_usd_rub_history(start: date, end: date) -> list[tuple[str, float]]:
    """
    Fetch daily USD/RUB rates between start and end (inclusive) from the
    Bank of Russia XML API. Returns ascending (date, rate) pairs.
    """
    params = {
        "date_req1": start.strftime("%d/%m/%Y"),
        "date_req2": end.strftime("%d/%m/%Y"),
        "VAL_NM_RQ": USD_CODE,
    }

    response = requests.get(CBR_DYNAMIC_URL, params=params, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    root = ElementTree.fromstring(response.content.decode("windows-1251"))

    records: list[tuple[str, float]] = []
    for record in root.findall("Record"):
        raw_date = record.attrib["Date"]  # DD.MM.YYYY
        value_text = record.findtext("Value", default="").replace(",", ".")
        if not value_text:
            continue
        day, month, year = raw_date.split(".")
        iso_date = f"{year}-{month}-{day}"
        records.append((iso_date, float(value_text)))

    records.sort(key=lambda pair: pair[0])
    return records


def forward_fill_calendar_days(records: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """
    Given ascending (date, rate) pairs that may skip weekends/holidays,
    return one row per calendar day between the first and last date,
    carrying the last known rate forward into any gap.
    """
    if not records:
        return records

    filled: list[tuple[str, float]] = []
    first_day = date.fromisoformat(records[0][0])
    last_day = date.fromisoformat(records[-1][0])
    rate_by_date = {iso_date: rate for iso_date, rate in records}

    current_rate = records[0][1]
    day = first_day
    while day <= last_day:
        iso_day = day.isoformat()
        if iso_day in rate_by_date:
            current_rate = rate_by_date[iso_day]
        filled.append((iso_day, current_rate))
        day += timedelta(days=1)

    return filled


def save_history_csv(records: list[tuple[str, float]], path: Path = CSV_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "rate"])
        for iso_date, rate in records:
            writer.writerow([iso_date, f"{rate:.4f}"])


def main() -> int:
    today = date.today()
    start = HISTORY_START

    raw_records = fetch_usd_rub_history(start, today)
    if not raw_records:
        print("No records fetched from CBR API.", file=sys.stderr)
        return 1

    records = forward_fill_calendar_days(raw_records)
    save_history_csv(records)

    print(f"Saved {len(records)} rows to {CSV_PATH}")
    print(f"Range: {records[0][0]} .. {records[-1][0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
