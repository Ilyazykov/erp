"""
Computes daily target portfolio weights by applying a Z-score-driven
correction on top of the base (strategic) weights, then renormalizing
across all positions to sum to 100%.

Formula (per ticker with a Z-score, gated by the same +-1.5 threshold
used elsewhere on the site to mean "buy"/"trim"):

    excess = |Z| - 1.5
    adjusted = base + (exp(excess) - 1) * sign(Z)      if |Z| > 1.5
    adjusted = base                                     otherwise

Tickers without a Z-score (funds: TRND, AKME, AKFN; and DOMRF when its
history is too short) are held at their base weight in this step, but
are included in the final renormalization across all 10 positions, so
they still shift slightly to accommodate corrections elsewhere.

    final = adjusted / sum(adjusted) * 100

Base weights come from data/target_weights_base.json. Z-scores come
from the last row of data/composite_valuation.csv (produced by
composite_valuation.py).

Outputs:
    data/target_weights.json  (for the site's donut chart)
    data/target_weights.csv   (daily history, appended)

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
OUT_JSON_PATH = DATA_DIR / "target_weights.json"
OUT_CSV_PATH = DATA_DIR / "target_weights.csv"

Z_THRESHOLD = 1.5
Z_COLUMN_SUFFIX = "_z"


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


def signal(z: float | None) -> str:
    if z is None:
        return "n/a"
    if z > Z_THRESHOLD:
        return "buy"
    if z < -Z_THRESHOLD:
        return "trim"
    return "neutral"


def adjusted_weight(base: float, z: float | None) -> float:
    if z is None or abs(z) <= Z_THRESHOLD:
        return base
    excess = abs(z) - Z_THRESHOLD
    delta = (math.exp(excess) - 1) * (1 if z > 0 else -1)
    return base + delta


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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
