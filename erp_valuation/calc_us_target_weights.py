"""
Computes an informational "target weights" donut for the 37-ticker US
stocks basket (data/us_zscore.csv), using the exact same Z-score-driven
correction formula as the real Russian-portfolio target weights
(calc_target_weights.py) -- see zscore_weights.py for the shared formula
and the negative-weight safeguard both scripts rely on.

This basket is NOT part of the actual portfolio and no real rebalancing
happens from this -- it's purely an illustrative "what would the correction
look like" chart, same spirit as the rest of the US-stocks tab.

Base weights are hardcoded below (from the user-provided basket weights).
Z-scores come from the last row (per ticker) of data/us_zscore.csv.

Outputs:
    data/us_target_weights.json

Run:
    python erp_valuation/calc_us_target_weights.py
"""

from __future__ import annotations

import csv
import json
from datetime import date, datetime, timezone
from pathlib import Path

import zscore_weights
from zscore_weights import Z_THRESHOLD, compute_target_weights


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
ZSCORE_CSV_PATH = DATA_DIR / "us_zscore.csv"
OUT_JSON_PATH = DATA_DIR / "us_target_weights.json"


BASE_WEIGHTS: dict[str, float] = {
    "GOOGL": 6,
    "NVDA": 5,
    "LLY": 5,
    "CAT": 5,
    "LIN": 5,
    "GE": 4,
    "AMZN": 4,
    "WMT": 4,
    "XOM": 4,
    "NEE": 4,
    "PLD": 4,
    "JPM": 3,
    "BRK-B": 3,
    "JNJ": 3,
    "META": 3,
    "V": 2,
    "MA": 2,
    "HOOD": 2,
    "MSFT": 2,
    "AAPL": 2,
    "ABBV": 2,
    "TSLA": 2,
    "HD": 2,
    "PG": 2,
    "KO": 2,
    "SHEL": 2,
    "CVX": 2,
    "SHW": 2,
    "DUK": 2,
    "AMT": 2,
    "SOFI": 1.5,
    "XYZ": 1.5,
    "INTC": 1,
    "SPCX": 1,
    "FCX": 1,
    "SO": 1,
    "EQIX": 1,
}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def read_latest_zscores(
    path: Path = ZSCORE_CSV_PATH,
) -> tuple[str | None, dict[str, float]]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    if not rows:
        raise ValueError(f"{path} is empty")

    by_ticker: dict[str, list[dict[str, str]]] = {}

    for row in rows:
        ticker = row["ticker"]
        by_ticker.setdefault(ticker, []).append(row)

    zscores: dict[str, float] = {}
    latest_date: str | None = None

    for ticker, ticker_rows in by_ticker.items():
        rows_with_z = [
            row
            for row in ticker_rows
            if row["z_score"] not in (None, "")
        ]

        if not rows_with_z:
            continue

        rows_with_z.sort(key=lambda row: row["date"])
        last = rows_with_z[-1]

        zscores[ticker] = float(last["z_score"])

        if latest_date is None or last["date"] > latest_date:
            latest_date = last["date"]

    if latest_date is None:
        raise ValueError(f"No Z-scores found in {path}")

    return latest_date, zscores


def write_json(
    rows: list[dict],
    as_of: str,
    out_path: Path = OUT_JSON_PATH,
) -> None:
    payload = {
        "date": as_of,
        "updated": utc_timestamp(),
        "z_threshold": Z_THRESHOLD,
        "weights": [
            {
                "ticker": row["ticker"],
                "base": round(row["base"], 4),
                "z": round(row["z"], 4)
                if row["z"] is not None
                else None,
                "signal": row["signal"],
                "adjustment": (
                    round(row["adjusted"] - row["base"], 4)
                    if row["z"] is not None
                    else None
                ),
                "target": round(row["target"], 4),
            }
            for row in rows
        ],
    }

    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    # Important diagnostic: show exactly which zscore_weights.py
    # Python imported.
    print(f"Using zscore_weights.py: {zscore_weights.__file__}")

    latest_date, zscores = read_latest_zscores()

    rows = compute_target_weights(
        BASE_WEIGHTS,
        zscores,
    )

    as_of = date.today().isoformat()

    write_json(
        rows,
        as_of,
    )

    print()
    print(
        f"{'Ticker':<8}"
        f"{'Base%':>8}"
        f"{'Z':>8}"
        f"{'Signal':>9}"
        f"{'Adjustment':>14}"
        f"{'Target%':>10}"
    )

    for row in rows:
        z_str = (
            f"{row['z']:.2f}"
            if row["z"] is not None
            else "-"
        )

        adjustment = (
            row["adjusted"] - row["base"]
            if row["z"] is not None
            else 0.0
        )

        print(
            f"{row['ticker']:<8}"
            f"{row['base']:>8.2f}"
            f"{z_str:>8}"
            f"{row['signal']:>9}"
            f"{adjustment:>14.2f}"
            f"{row['target']:>10.2f}"
        )

    print()
    print(
        f"Total: {sum(row['target'] for row in rows):.2f}%"
    )
    print(
        f"Latest Z-score date used: {latest_date}"
    )
    print(
        f"Saved {OUT_JSON_PATH}"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())