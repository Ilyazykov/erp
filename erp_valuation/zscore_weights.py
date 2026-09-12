"""
Shared Z-score-driven weight correction logic, used identically by both the
real Russian portfolio's target weights (calc_target_weights.py) and the
purely-illustrative US-stocks basket (calc_us_target_weights.py).

For |Z| <= 1.5:
    adjusted = base

For positive Z > 1.5:
    adjusted = base + Z_CORRECTION_K * sqrt(Z - Z_THRESHOLD)

For negative Z < -1.5:
    adjusted smoothly decreases from base towards 20% of base using a sigmoid.

The negative-side correction is relative to base, so the same Z-score produces
the same percentage reduction for every ticker, regardless of its base weight.

The function is continuous and differentiable at z = -1.5.

After adjustment, all weights are normalized to sum to 100.
"""

from __future__ import annotations

import math

Z_THRESHOLD = 1.5
Z_CORRECTION_K = 3.0  # scales sqrt(excess) -> pp correction
MIN_BASE_FRACTION = 0.20
SIGMOID_K = 8.0


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


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def adjusted_weight(base: float, z: float | None) -> float:
    if z is None:
        return base

    if z < -Z_THRESHOLD:
        s = _sigmoid(SIGMOID_K * (z + Z_THRESHOLD))
        fraction = (
            MIN_BASE_FRACTION
            + (1.0 - MIN_BASE_FRACTION) * 4.0 * s * (1.0 - s)
        )
        return base * fraction

    if z <= Z_THRESHOLD:
        return base

    return base + z_correction(z)


def compute_target_weights(
    base_weights: dict[str, float],
    zscores: dict[str, float],
) -> list[dict]:
    """Returns a list of {ticker, base, z, signal, adjusted, target} dicts.

    `target` values are non-negative and sum to 100.
    """
    rows = []

    for ticker, base in base_weights.items():
        z = zscores.get(ticker)
        adj = adjusted_weight(base, z)

        rows.append({
            "ticker": ticker,
            "base": base,
            "z": z,
            "signal": signal(z),
            "adjusted": adj,
        })

    total_adjusted = sum(r["adjusted"] for r in rows)

    for r in rows:
        r["target"] = r["adjusted"] / total_adjusted * 100

    return rows