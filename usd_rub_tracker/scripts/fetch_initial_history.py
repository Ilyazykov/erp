"""
One-off backfill script.

Fetches historical daily USD/RUB exchange rates for the last 365 calendar
days from the Bank of Russia (CBR) public XML API and saves them to
data/usd_rub_history.csv.

Data source: Bank of Russia "Dynamics of a currency rate" XML endpoint.
    https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=DD/MM/YYYY&date_req2=DD/MM/YYYY&VAL_NM_RQ=R01235
VAL_NM_RQ=R01235 is the CBR internal code for USD. No API key required.

Run once:
    python scripts/fetch_initial_history.py
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree

import requests

CBR_DYNAMIC_URL = "https://www.cbr.ru/scripts/XML_dynamic.asp"
USD_CODE = "R01235"

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = REPO_ROOT / "data"
CSV_PATH = DATA_DIR / "usd_rub_history.csv"
STATS_PATH = DATA_DIR / "usd_rub_stats.json"

REQUEST_TIMEOUT = 30


def fetch_usd_rub_history_last_365_days() -> list[tuple[str, float]]:
    """
    Fetch daily USD/RUB rates for the last 365 calendar days (inclusive of
    today) from the Bank of Russia XML API.

    Returns a list of (date, rate) pairs sorted ascending by date, where
    date is an ISO 'YYYY-MM-DD' string and rate is a float.
    """
    today = date.today()
    start = today - timedelta(days=365)

    params = {
        "date_req1": start.strftime("%d/%m/%Y"),
        "date_req2": today.strftime("%d/%m/%Y"),
        "VAL_NM_RQ": USD_CODE,
    }

    response = requests.get(CBR_DYNAMIC_URL, params=params, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    # CBR serves the XML as windows-1251.
    root = ElementTree.fromstring(response.content.decode("windows-1251"))

    records: list[tuple[str, float]] = []
    for record in root.findall("Record"):
        raw_date = record.attrib["Date"]  # DD.MM.YYYY
        value_text = record.findtext("Value", default="").replace(",", ".")
        if not value_text:
            continue
        day, month, year = raw_date.split(".")
        iso_date = f"{year}-{month}-{day}"
        rate = float(value_text)
        records.append((iso_date, rate))

    records.sort(key=lambda pair: pair[0])
    return forward_fill_calendar_days(records)


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


def fetch_latest_published_rate(fallback: tuple[str, float]) -> tuple[str, float]:
    """
    Fetch the single most recently published USD/RUB rate from the CBR
    XML API. The CBR publishes a rate in advance for the next business
    day, so this can return a date later than today. Falls back to the
    given (date, rate) pair if the request returns nothing.
    """
    today = date.today()
    start = today - timedelta(days=10)
    end = today + timedelta(days=1)

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
        raw_date = record.attrib["Date"]
        value_text = record.findtext("Value", default="").replace(",", ".")
        if not value_text:
            continue
        day, month, year = raw_date.split(".")
        records.append((f"{year}-{month}-{day}", float(value_text)))

    if not records:
        return fallback

    records.sort(key=lambda pair: pair[0])
    return records[-1]


def save_stats_json(
    history: list[tuple[str, float]], latest_date: str, latest_rate: float, path: Path = STATS_PATH
) -> None:
    rates = [rate for _, rate in history]
    m = sum(rates) / len(rates)
    stats = {"date": latest_date, "x": latest_rate, "m": m}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    records = fetch_usd_rub_history_last_365_days()
    if not records:
        print("No records fetched from CBR API.", file=sys.stderr)
        return 1

    save_history_csv(records)

    latest_date, latest_rate = fetch_latest_published_rate(fallback=records[-1])
    save_stats_json(records, latest_date, latest_rate)

    print(f"Saved {len(records)} rows to {CSV_PATH}")
    print(f"Range: {records[0][0]} .. {records[-1][0]}")
    print(f"Latest published rate: {latest_date} = {latest_rate:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
