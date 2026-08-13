"""
Daily updater for data/usd_rub_history.csv and data/usd_rub_stats.json.

The Bank of Russia (CBR) publishes the official USD/RUB rate in advance,
for the next business day. That means the CBR feed's most recent record
can be dated "tomorrow" relative to the machine's current date. This
script treats the two consumers of that data differently:

- data/usd_rub_history.csv only ever gets rows for days that have already
  started (date <= today). It is the historical, append-only daily series
  used to compute the 365-day average (m).
- data/usd_rub_stats.json's "x" field is the single most recently
  published CBR rate, even if its date is in the future relative to
  today. This is the "current" rate used for the weight formulas, and it
  is what makes x track real-world quotes (e.g. Google) most closely.

m is always computed strictly from the CSV (i.e. it never includes a
not-yet-started day), while x can pull ahead of the CSV's last row.

Data source: Bank of Russia "Dynamics of a currency rate" XML endpoint.
    https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=DD/MM/YYYY&date_req2=DD/MM/YYYY&VAL_NM_RQ=R01235
VAL_NM_RQ=R01235 is the CBR internal code for USD. No API key required.

Run:
    python scripts/update_usd_rub.py
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
CSV_PATH = REPO_ROOT / "data" / "usd_rub_history.csv"
HISTORY_5Y_PATH = REPO_ROOT / "data" / "usd_rub_history_5y.csv"
STATS_PATH = REPO_ROOT / "data" / "usd_rub_stats.json"

REQUEST_TIMEOUT = 30
HISTORY_DAYS = 365


def fetch_recent_usd_rub_rates() -> list[tuple[str, float]]:
    """
    Fetch recently published USD/RUB rates (roughly the last 10 calendar
    days, which may include a not-yet-started day since the CBR publishes
    a rate in advance for the next business day) from the CBR XML API.

    Returns (date, rate) pairs sorted ascending by date.
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
        raw_date = record.attrib["Date"]  # DD.MM.YYYY
        value_text = record.findtext("Value", default="").replace(",", ".")
        if not value_text:
            continue
        day, month, year = raw_date.split(".")
        iso_date = f"{year}-{month}-{day}"
        records.append((iso_date, float(value_text)))

    records.sort(key=lambda pair: pair[0])
    return records


def read_history(path: Path = CSV_PATH) -> list[tuple[str, float]]:
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [(row["date"], float(row["rate"])) for row in reader]


def write_history(records: list[tuple[str, float]], path: Path = CSV_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "rate"])
        for iso_date, rate in records:
            writer.writerow([iso_date, f"{rate:.4f}"])


def trim_to_last_n_days(
    records: list[tuple[str, float]], days: int = HISTORY_DAYS
) -> list[tuple[str, float]]:
    cutoff = date.today() - timedelta(days=days)
    cutoff_iso = cutoff.isoformat()
    return [r for r in records if r[0] >= cutoff_iso]


def forward_fill_gap(
    existing: list[tuple[str, float]], new_date: str, new_rate: float
) -> list[tuple[str, float]]:
    """
    Append new_date/new_rate to existing history, carrying the last known
    rate forward into any calendar-day gap (weekends/holidays) between the
    last existing date and new_date.
    """
    if not existing:
        return [(new_date, new_rate)]

    last_day = date.fromisoformat(existing[-1][0])
    target_day = date.fromisoformat(new_date)
    last_rate = existing[-1][1]

    filled = list(existing)
    day = last_day + timedelta(days=1)
    while day < target_day:
        filled.append((day.isoformat(), last_rate))
        day += timedelta(days=1)
    filled.append((new_date, new_rate))
    return filled


def write_stats(
    history: list[tuple[str, float]], latest_date: str, latest_rate: float, path: Path = STATS_PATH
) -> None:
    """
    m is the 365-day average computed strictly from history (days that
    have already started). x is the single most recently published CBR
    rate, which may be dated later than history's last row.
    """
    rates = [rate for _, rate in history]
    m = sum(rates) / len(rates)
    stats = {"date": latest_date, "x": latest_rate, "m": m}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    existing = read_history()
    existing_5y = read_history(HISTORY_5Y_PATH)

    recent = fetch_recent_usd_rub_rates()
    if not recent:
        print("No rate returned by CBR API.", file=sys.stderr)
        return 1

    today_iso = date.today().isoformat()
    started_records = [r for r in recent if r[0] <= today_iso]
    latest_started = started_records[-1] if started_records else None
    latest_published = recent[-1]  # may be dated in the future (next business day)

    history_changed = False
    updated = existing

    if latest_started is not None and (not existing or latest_started[0] > existing[-1][0]):
        started_date, started_rate = latest_started
        updated = forward_fill_gap(existing, started_date, started_rate)
        updated = trim_to_last_n_days(updated)
        write_history(updated)
        history_changed = True
        print(f"Appended through {started_date} = {started_rate:.4f}. Total rows: {len(updated)}")

    if latest_started is not None and existing_5y and latest_started[0] > existing_5y[-1][0]:
        started_date, started_rate = latest_started
        updated_5y = forward_fill_gap(existing_5y, started_date, started_rate)
        write_history(updated_5y, HISTORY_5Y_PATH)
        print(f"Appended through {started_date} to 5y history. Total rows: {len(updated_5y)}")

    write_stats(updated, latest_published[0], latest_published[1])
    print(f"Latest published rate: {latest_published[0]} = {latest_published[1]:.4f}")

    if not history_changed:
        print("History unchanged (already up to date).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
