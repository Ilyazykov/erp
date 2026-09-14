"""
Computes an informational "Stocks vs Bonds" allocation donut for the US
market, mirroring calc_target_weights.py's compute_allocation() for the
Russian portfolio EXACTLY (same formula, same constants) -- purely
illustrative, no real allocation happens from this.

  1. Base stock share is a 50/50 blend of two independent inputs, same as
     the Russian portfolio's calc_target_weights.py:

       a. Rate-based share, from the US Federal Funds Rate r (the direct
          analog of the CBR key rate used on the Russian side) via the SAME
          inverse-logistic formula and the SAME constants as the Russian
          portfolio (KEY_RATE_MIDPOINT=10.322, KEY_RATE_SLOPE=2.531 -- these
          were calibrated for the CBR's 5-21% range, not the Fed's ~0-5.5%
          range, so the resulting rate-based share sits close to 100%
          almost always; this is intentional, per explicit instruction,
          not a bug):

              w(r) = 100 / (1 + exp((r - 10.322) / 2.531))

       b. Age-based share, from the same glide-path rule of thumb used on
          the Russian side (bonds% = age - 10, clamped to [0, 100]; see
          zscore_weights.stock_share_from_age), using BIRTH_YEAR from
          zscore_weights.py.

     base_stocks = (w(r) + stock_share_from_age(age)) / 2

  2. The same Z-gated sqrt correction used everywhere else on the site is
     applied here too, driven by the US ERP Z-score (Shiller's Excess CAPE
     Yield Z-score, from data/us_erp.csv) instead of composite_erp_z:

         excess = |Z| - 1.5
         adjusted = w(r) + Z_CORRECTION_K * sqrt(excess) * sign(Z)   if |Z| > 1.5
         adjusted = w(r)                                              otherwise

     then renormalized so Stocks + Bonds sum to 100 (same pattern as
     zscore_weights.compute_target_weights, not clipped to [0, 100]).

Fed Funds Rate comes from the latest row of data/fed_funds_rate.csv
(produced by fetch_fed_funds_rate.py). US ERP Z-score comes from the
latest row of data/us_erp.csv (produced by us_erp.py).

Outputs:
    data/us_target_allocation.json

Run:
    python erp_valuation/calc_us_allocation.py
"""
from __future__ import annotations

import csv
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

from zscore_weights import (
    BIRTH_YEAR,
    Z_THRESHOLD,
    signal,
    stock_share_from_age,
    z_correction,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
FED_RATE_CSV_PATH = DATA_DIR / "fed_funds_rate.csv"
US_ERP_CSV_PATH = DATA_DIR / "us_erp.csv"
OUT_JSON_PATH = DATA_DIR / "us_target_allocation.json"

# Same constants as calc_target_weights.py -- see module docstring for why
# they are NOT recalibrated for the Fed's rate range.
KEY_RATE_MIDPOINT = 10.322
KEY_RATE_SLOPE = 2.531


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def read_latest_fed_rate(path: Path = FED_RATE_CSV_PATH) -> tuple[str, float]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path} is empty")
    last = rows[-1]
    return last["date"], float(last["rate_pct"])


def read_latest_us_erp_z(path: Path = US_ERP_CSV_PATH) -> tuple[str, float | None]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path} is empty")
    for row in reversed(rows):
        if row["z_score"] not in (None, ""):
            return row["date"], float(row["z_score"])
    return rows[-1]["date"], None


def stock_share_from_rate(r: float) -> float:
    return 100 / (1 + math.exp((r - KEY_RATE_MIDPOINT) / KEY_RATE_SLOPE))


def current_age(as_of: date) -> int:
    return as_of.year - BIRTH_YEAR


def compute_allocation(fed_rate: float, erp_z: float | None, age: float) -> dict:
    rate_stocks = stock_share_from_rate(fed_rate)
    age_stocks = stock_share_from_age(age)
    base_stocks = (rate_stocks + age_stocks) / 2
    base_bonds = 100 - base_stocks

    correction = z_correction(erp_z)
    if correction > 0:
        stocks_adjustment, bonds_adjustment = correction, 0.0
    elif correction < 0:
        stocks_adjustment, bonds_adjustment = 0.0, -correction
    else:
        stocks_adjustment, bonds_adjustment = 0.0, 0.0

    adjusted_stocks = base_stocks + stocks_adjustment
    adjusted_bonds = base_bonds + bonds_adjustment

    total_adjusted = adjusted_stocks + adjusted_bonds
    target_stocks = adjusted_stocks / total_adjusted * 100
    target_bonds = adjusted_bonds / total_adjusted * 100

    return {
        "fed_rate": fed_rate,
        "age": age,
        "rate_stocks": rate_stocks,
        "age_stocks": age_stocks,
        "base_stocks": base_stocks,
        "base_bonds": base_bonds,
        "z": erp_z,
        "signal": signal(erp_z),
        "stocks_adjustment": stocks_adjustment if erp_z is not None else None,
        "bonds_adjustment": bonds_adjustment if erp_z is not None else None,
        "target_stocks": target_stocks,
        "target_bonds": target_bonds,
    }


def write_json(alloc: dict, as_of: str, fed_rate_date: str, erp_z_date: str,
                out_path: Path = OUT_JSON_PATH) -> None:
    payload = {
        "date": as_of,
        "updated": utc_timestamp(),
        "z_threshold": Z_THRESHOLD,
        "key_rate_midpoint": KEY_RATE_MIDPOINT,
        "key_rate_slope": KEY_RATE_SLOPE,
        "fed_rate": alloc["fed_rate"],
        "fed_rate_date": fed_rate_date,
        "erp_z_date": erp_z_date,
        "birth_year": BIRTH_YEAR,
        "age": alloc["age"],
        "rate_stocks": round(alloc["rate_stocks"], 4),
        "age_stocks": round(alloc["age_stocks"], 4),
        "base_stocks": round(alloc["base_stocks"], 4),
        "base_bonds": round(alloc["base_bonds"], 4),
        "z": round(alloc["z"], 4) if alloc["z"] is not None else None,
        "signal": alloc["signal"],
        "stocks_adjustment": round(alloc["stocks_adjustment"], 4) if alloc["stocks_adjustment"] is not None else None,
        "bonds_adjustment": alloc["bonds_adjustment"],
        "target_stocks": round(alloc["target_stocks"], 4),
        "target_bonds": round(alloc["target_bonds"], 4),
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    fed_rate_date, fed_rate = read_latest_fed_rate()
    erp_z_date, erp_z = read_latest_us_erp_z()
    age = current_age(date.today())
    alloc = compute_allocation(fed_rate, erp_z, age)

    as_of = date.today().isoformat()
    write_json(alloc, as_of, fed_rate_date, erp_z_date)

    z_str = f"{erp_z:.2f}" if erp_z is not None else "-"
    print(f"Fed Funds Rate ({fed_rate_date}): {fed_rate:.2f}%  US ERP Z ({erp_z_date}): {z_str}  Age: {age}")
    print(f"Rate-based stocks: {alloc['rate_stocks']:.2f}%  Age-based stocks: {alloc['age_stocks']:.2f}%  "
          f"Base stocks: {alloc['base_stocks']:.2f}%")
    print(f"Target stocks: {alloc['target_stocks']:.2f}%  "
          f"Target bonds: {alloc['target_bonds']:.2f}%  Signal: {alloc['signal']}")
    print(f"Saved {OUT_JSON_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
