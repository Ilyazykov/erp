"""
Shared Z-score-driven weight correction logic, used identically by both the
real Russian portfolio's target weights (calc_target_weights.py) and the
purely-illustrative US-stocks basket (calc_us_target_weights.py).

Formula (per ticker with a Z-score, gated by the +-1.5 threshold used
elsewhere on the site to mean "buy"/"trim"):

    excess = |Z| - 1.5
    adjusted = base + Z_CORRECTION_K * sqrt(excess) * sign(Z)   if |Z| > 1.5
    adjusted = base                                              otherwise

sqrt (not exp) is used deliberately: it grows without any upper bound (no
plateau/cap), but far more slowly than an exponential, so an unusually
extreme Z-score (e.g. |Z| > 5) still produces a proportionate, sane
correction instead of the exponential blowing up.

With a small base weight and a strongly negative Z, `adjusted` can go
negative -- impossible for a donut sector's angle/radius (or for a
percentage weight at all). Rather than clip only the offending ticker to 0
(which would distort just that one position's relative standing), every
adjusted value is shifted by the same amount -- the magnitude of the
most-negative one -- so the minimum lands exactly at 0 and every other
position's relative spacing is preserved unchanged. This is a no-op
whenever nothing actually goes negative.

    final = adjusted / sum(adjusted) * 100
"""
from __future__ import annotations

import math

Z_THRESHOLD = 1.5
Z_CORRECTION_K = 3.0  # scales sqrt(excess) -> pp correction; see module docstring


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
    """Returns a list of {ticker, base, z, signal, adjusted, target} dicts.

    `target` values are guaranteed non-negative and sum to 100 (assuming at
    least one `adjusted` value is positive, which always holds unless every
    single base weight is 0).
    """
    rows = []
    for ticker, base in base_weights.items():
        z = zscores.get(ticker)
        adj = adjusted_weight(base, z)
        rows.append({"ticker": ticker, "base": base, "z": z, "signal": signal(z), "adjusted": adj})

    min_adjusted = min(r["adjusted"] for r in rows)
    if min_adjusted < 0:
        shift = -min_adjusted
        for r in rows:
            r["adjusted"] += shift

    total_adjusted = sum(r["adjusted"] for r in rows)
    for r in rows:
        r["target"] = r["adjusted"] / total_adjusted * 100

    return rows
