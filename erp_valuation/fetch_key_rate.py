"""
Fetches the Bank of Russia (CBR) key rate ("ключевая ставка") history via
the DailyInfo SOAP service and keeps data/key_rate.csv up to date.

Unlike the USD/RUB XML_dynamic.asp endpoint, the key rate is only exposed
via a SOAP 1.1 service (DailyInfoWebServ/DailyInfo.asmx, KeyRateXML method).
No auth required. Returns a daily calendar series (rate repeats between
policy decisions), so the CSV only stores the actual change points plus
keeps the latest known rate available.

Outputs:
    data/key_rate.csv  (date, rate_pct) — one row per calendar day fetched

Run:
    python erp_valuation/fetch_key_rate.py
"""
from __future__ import annotations

import csv
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
CSV_PATH = DATA_DIR / "key_rate.csv"

SOAP_URL = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx"
SOAP_ACTION = "http://web.cbr.ru/KeyRateXML"
NS = "http://web.cbr.ru/"

HISTORY_START = date(2013, 9, 13)  # key rate introduced by CBR on this date


def fetch_key_rate(from_date: date, to_date: date) -> list[tuple[date, float]]:
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <KeyRateXML xmlns="{NS}">
      <fromDate>{from_date.isoformat()}</fromDate>
      <ToDate>{to_date.isoformat()}</ToDate>
    </KeyRateXML>
  </soap:Body>
</soap:Envelope>"""

    req = urllib.request.Request(
        SOAP_URL,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": f'"{SOAP_ACTION}"',
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        xml_bytes = resp.read()

    root = ET.fromstring(xml_bytes)
    records: list[tuple[date, float]] = []
    for kr in root.iter("KR"):
        dt_el = kr.find("DT")
        rate_el = kr.find("Rate")
        if dt_el is None or rate_el is None or not dt_el.text or not rate_el.text:
            continue
        d = date.fromisoformat(dt_el.text[:10])
        rate = float(rate_el.text)
        records.append((d, rate))

    records.sort(key=lambda r: r[0])
    return records


def read_existing(path: Path = CSV_PATH) -> dict[date, float]:
    if not path.exists():
        return {}
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return {date.fromisoformat(row["date"]): float(row["rate_pct"]) for row in reader}


def write_csv(records: dict[date, float], path: Path = CSV_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "rate_pct"])
        for d in sorted(records):
            writer.writerow([d.isoformat(), f"{records[d]:.2f}"])


def main() -> int:
    existing = read_existing()
    last_known = max(existing) if existing else HISTORY_START - timedelta(days=1)
    fetch_from = last_known + timedelta(days=1) if existing else HISTORY_START
    today = date.today()

    if fetch_from > today:
        print(f"Key rate: up to date (last = {last_known.isoformat()})")
        return 0

    new_records = fetch_key_rate(fetch_from, today)
    if not new_records:
        print(f"Key rate: no new data returned for {fetch_from}..{today}")
        return 0

    existing.update(dict(new_records))
    write_csv(existing)
    latest_date, latest_rate = max(existing.items())
    print(f"Key rate: +{len(new_records)} rows, latest = {latest_date.isoformat()} {latest_rate:.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
