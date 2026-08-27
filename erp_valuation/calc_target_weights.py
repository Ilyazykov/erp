"""
Computes daily target portfolio weights by applying a Z-score-driven
correction on top of the base (strategic) weights, then renormalizing
across all positions to sum to 100%.

Formula (per ticker with a Z-score, gated by the same +-1.5 threshold
used elsewhere on the site to mean "buy"/"trim"):

    excess = |Z| - 1.5
    adjusted = base + Z_CORRECTION_K * sqrt(excess) * sign(Z)   if |Z| > 1.5
    adjusted = base                                              otherwise

sqrt (not exp) is used deliberately: it grows without any upper bound (no
plateau/cap), but far more slowly than an exponential, so an unusually
extreme Z-score (e.g. |Z| > 5) still produces a proportionate, sane
correction instead of the exponential blowing up (exp(3.7) - 1 = ~39pp on
a 2%-base ticker, dwarfing every other position).

Tickers without a Z-score (funds: TRND, AKME, AKFN; and DOMRF when its
history is too short) are held at their base weight in this step, but
are included in the final renormalization across all 10 positions, so
they still shift slightly to accommodate corrections elsewhere.

    final = adjusted / sum(adjusted) * 100

Base weights come from data/target_weights_base.json. Z-scores come
from the last row of data/composite_valuation.csv (produced by
composite_valuation.py).

Also computes the Layer 2: Allocation split (stocks vs bonds), which is
independent of the per-ticker weights above:

  1. Base stock share from the CBR key rate r (inverse logistic —
     low rate -> high stock share, high rate -> low stock share):

         w(r) = 100 / (1 + exp((r - 10.322) / 2.531))

  2. The same Z-gated sqrt correction applied to tickers is applied here
     too, driven by composite_erp_z (Portfolio Z - OFZ Z):

         excess = |Z| - 1.5
         adjusted = w(r) + Z_CORRECTION_K * sqrt(excess) * sign(Z)   if |Z| > 1.5
         adjusted = w(r)                                              otherwise

     then clipped to [0, 100]. Bonds share = 100 - stocks share.

Key rate comes from the latest row of data/key_rate.csv (produced by
fetch_key_rate.py).

Outputs:
    data/target_weights.json   (per-ticker, for the site's donut chart)
    data/target_weights.csv    (per-ticker daily history, appended)
    data/target_allocation.json (stocks/bonds split, for the site)
    data/target_allocation.csv  (stocks/bonds daily history, appended)

Run:
    python erp_valuation/calc_target_weights.py
"""
from __future__ import annotations

import csv
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
BASE_WEIGHTS_PATH = DATA_DIR / "target_weights_base.json"
COMPOSITE_CSV_PATH = DATA_DIR / "composite_valuation.csv"
KEY_RATE_CSV_PATH = DATA_DIR / "key_rate.csv"
OUT_JSON_PATH = DATA_DIR / "target_weights.json"
OUT_CSV_PATH = DATA_DIR / "target_weights.csv"
ALLOC_OUT_JSON_PATH = DATA_DIR / "target_allocation.json"
ALLOC_OUT_CSV_PATH = DATA_DIR / "target_allocation.csv"

Z_THRESHOLD = 1.5
Z_CORRECTION_K = 3.0  # scales sqrt(excess) -> pp correction; see module docstring
Z_COLUMN_SUFFIX = "_z"
COMPOSITE_Z_COLUMN = "composite_erp_z"

# Inverse-logistic base stock share as a function of the CBR key rate (%).
KEY_RATE_MIDPOINT = 10.322
KEY_RATE_SLOPE = 2.531


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def read_base_weights(path: Path = BASE_WEIGHTS_PATH) -> dict[str, float]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_latest_zscores(path: Path = COMPOSITE_CSV_PATH) -> dict[str, float]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path} is empty")
    last = rows[-1]
    zscores: dict[str, float] = {}
    for key, value in last.items():
        if key.endswith(Z_COLUMN_SUFFIX) and value not in (None, ""):
            ticker = key[: -len(Z_COLUMN_SUFFIX)]
            zscores[ticker] = float(value)
    return zscores


def read_latest_composite_z(path: Path = COMPOSITE_CSV_PATH) -> tuple[str, float | None]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path} is empty")
    last = rows[-1]
    value = last.get(COMPOSITE_Z_COLUMN)
    return last["date"], (float(value) if value not in (None, "") else None)


def read_latest_key_rate(path: Path = KEY_RATE_CSV_PATH) -> tuple[str, float]:
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path} is empty")
    last = rows[-1]
    return last["date"], float(last["rate_pct"])


def stock_share_from_rate(r: float) -> float:
    return 100 / (1 + math.exp((r - KEY_RATE_MIDPOINT) / KEY_RATE_SLOPE))


def signal(z: float | None) -> str:
    if z is None:
        return "n/a"
    if z > Z_THRESHOLD:
        return "buy"
    if z < -Z_THRESHOLD:
        return "trim"
    return "neutral"


def z_correction(z: float | None) -> float:
    if z is None or abs(z) <= Z_THRESHOLD:
        return 0.0
    excess = abs(z) - Z_THRESHOLD
    return Z_CORRECTION_K * math.sqrt(excess) * (1 if z > 0 else -1)


def adjusted_weight(base: float, z: float | None) -> float:
    return base + z_correction(z)


def compute_target_weights(base_weights: dict[str, float], zscores: dict[str, float]) -> list[dict]:
    rows = []
    for ticker, base in base_weights.items():
        z = zscores.get(ticker)
        adj = adjusted_weight(base, z)
        rows.append({"ticker": ticker, "base": base, "z": z, "signal": signal(z), "adjusted": adj})

    total_adjusted = sum(r["adjusted"] for r in rows)
    for r in rows:
        r["target"] = r["adjusted"] / total_adjusted * 100

    return rows


def compute_allocation(key_rate: float, composite_z: float | None) -> dict:
    base_stocks = stock_share_from_rate(key_rate)
    base_bonds = 100 - base_stocks

    # Composite ERP Z > +1.5 -> stocks cheap vs rates -> buy stocks: the
    # correction goes to Stocks, Bonds gets 0. Z < -1.5 -> rates rich vs
    # stocks -> buy bonds: the correction goes to Bonds instead, Stocks gets
    # 0. Neither side ever receives the other's mirrored/negated value -- at
    # any moment only ONE side actually has an active signal, exactly like a
    # ticker with no Z-score sitting at 0. Both legs are then renormalized to
    # sum to 100%, same as the per-ticker target weights.
    correction = z_correction(composite_z)
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
        "key_rate": key_rate,
        "base_stocks": base_stocks,
        "base_bonds": base_bonds,
        "z": composite_z,
        "signal": signal(composite_z),
        "stocks_adjustment": stocks_adjustment if composite_z is not None else None,
        "bonds_adjustment": bonds_adjustment if composite_z is not None else None,
        "target_stocks": target_stocks,
        "target_bonds": target_bonds,
    }


def write_json(rows: list[dict], as_of: str, out_path: Path = OUT_JSON_PATH) -> None:
    payload = {
        "date": as_of,
        "updated": utc_timestamp(),
        "z_threshold": Z_THRESHOLD,
        "weights": [
            {
                "ticker": r["ticker"],
                "base": round(r["base"], 4),
                "z": round(r["z"], 4) if r["z"] is not None else None,
                "signal": r["signal"],
                "adjustment": round(r["adjusted"] - r["base"], 4) if r["z"] is not None else None,
                "target": round(r["target"], 4),
            }
            for r in rows
        ],
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_csv(rows: list[dict], as_of: str, out_path: Path = OUT_CSV_PATH) -> None:
    tickers = [r["ticker"] for r in rows]
    header = ["date"] + [f"{t}_target" for t in tickers]

    file_exists = out_path.exists()
    existing_rows = []
    if file_exists:
        with out_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            existing_header = next(reader, None)
            existing_rows = list(reader)
        if existing_header != header:
            file_exists = False
            existing_rows = []

    new_row = [as_of] + [f"{r['target']:.4f}" for r in rows]

    if existing_rows and existing_rows[-1][0] == as_of:
        existing_rows[-1] = new_row
    else:
        existing_rows.append(new_row)

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(existing_rows)


def write_allocation_json(alloc: dict, as_of: str, key_rate_date: str,
                           composite_z_date: str, out_path: Path = ALLOC_OUT_JSON_PATH) -> None:
    payload = {
        "date": as_of,
        "updated": utc_timestamp(),
        "z_threshold": Z_THRESHOLD,
        "key_rate_midpoint": KEY_RATE_MIDPOINT,
        "key_rate_slope": KEY_RATE_SLOPE,
        "key_rate": alloc["key_rate"],
        "key_rate_date": key_rate_date,
        "composite_z_date": composite_z_date,
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


def append_allocation_csv(alloc: dict, as_of: str, out_path: Path = ALLOC_OUT_CSV_PATH) -> None:
    header = ["date", "key_rate", "base_stocks", "z", "target_stocks", "target_bonds"]
    new_row = [
        as_of,
        f"{alloc['key_rate']:.2f}",
        f"{alloc['base_stocks']:.4f}",
        f"{alloc['z']:.4f}" if alloc["z"] is not None else "",
        f"{alloc['target_stocks']:.4f}",
        f"{alloc['target_bonds']:.4f}",
    ]

    existing_rows = []
    if out_path.exists():
        with out_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            existing_header = next(reader, None)
            existing_rows = list(reader)
        if existing_header != header:
            existing_rows = []

    if existing_rows and existing_rows[-1][0] == as_of:
        existing_rows[-1] = new_row
    else:
        existing_rows.append(new_row)

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(existing_rows)


def main() -> int:
    base_weights = read_base_weights()
    zscores = read_latest_zscores()
    rows = compute_target_weights(base_weights, zscores)

    as_of = date.today().isoformat()
    write_json(rows, as_of)
    append_csv(rows, as_of)

    print(f"{'Ticker':<8}{'Base%':>8}{'Z':>8}{'Signal':>9}{'Target%':>10}")
    for r in rows:
        z_str = f"{r['z']:.2f}" if r["z"] is not None else "-"
        print(f"{r['ticker']:<8}{r['base']:>8.2f}{z_str:>8}{r['signal']:>9}{r['target']:>10.2f}")
    print(f"Total: {sum(r['target'] for r in rows):.2f}%")
    print(f"Saved {OUT_JSON_PATH}")
    print(f"Saved {OUT_CSV_PATH}")

    key_rate_date, key_rate = read_latest_key_rate()
    composite_z_date, composite_z = read_latest_composite_z()
    alloc = compute_allocation(key_rate, composite_z)
    write_allocation_json(alloc, as_of, key_rate_date, composite_z_date)
    append_allocation_csv(alloc, as_of)

    z_str = f"{composite_z:.2f}" if composite_z is not None else "-"
    print()
    print(f"Key rate ({key_rate_date}): {key_rate:.2f}%  Composite Z ({composite_z_date}): {z_str}")
    print(f"Base stocks: {alloc['base_stocks']:.2f}%  Target stocks: {alloc['target_stocks']:.2f}%  "
          f"Target bonds: {alloc['target_bonds']:.2f}%  Signal: {alloc['signal']}")
    print(f"Saved {ALLOC_OUT_JSON_PATH}")
    print(f"Saved {ALLOC_OUT_CSV_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
