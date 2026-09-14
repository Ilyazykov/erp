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
SIGMOID_K = 20.0

# Symmetric Stocks/Bonds allocation shift (allocation_split, below): the
# max pp one side can ever gain/lose, approached asymptotically as |Z| -> inf
# (never reached, never exceeded). Calibrated (not derived analytically) to
# match two explicit reference points: RU (base_stocks=18.95%, Z=+1.80)
# should shift by ~+1.35pp -> target ~20.3% stocks, and US
# (base_stocks=84.18%, Z=-2.37) should shift by ~-3.72pp -> target ~80.46%
# stocks -- both hold to within ~0.05pp at k=4.4, max_pp=4.1.
ALLOC_MAX_SHIFT_PP = 4.1
ALLOC_SIGMOID_K = 4.4

# Age-based glide path, applied identically to the RU and US stocks/bonds
# allocation base share (independent of, and blended 50/50 with, the
# rate-based base share -- see calc_target_weights.py / calc_us_allocation.py).
# Rule: bonds% = age - AGE_BONDS_OFFSET (a more aggressive-in-stocks variant
# of the classic "bonds% = age" rule of thumb), clamped to [0, 100].
BIRTH_YEAR = 1991
AGE_BONDS_OFFSET = 5


def stock_share_from_age(age: float) -> float:
    bonds_share = max(0.0, min(100.0, age - AGE_BONDS_OFFSET))
    return 100.0 - bonds_share


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


def _alloc_shift_pp(z_beyond_threshold: float) -> float:
    """pp shift for allocation_split, below: 0 at z_beyond_threshold == 0,
    smoothly and asymptotically approaching ALLOC_MAX_SHIFT_PP as
    z_beyond_threshold -> +inf. Continuous and differentiable at 0 (same
    "bell curve" shape as adjusted_weight's shrink fraction, just measuring
    the RELEASED amount directly in pp instead of a multiplicative fraction
    of base -- this is what makes the shift's own ceiling independent of
    which side is shrinking, unlike a multiplicative fraction)."""
    s = _sigmoid(ALLOC_SIGMOID_K * z_beyond_threshold)
    return ALLOC_MAX_SHIFT_PP * (1.0 - 4.0 * s * (1.0 - s))


def allocation_split(base_stocks: float, z: float | None) -> tuple[float, float]:
    """Returns (adjusted_stocks, adjusted_bonds) for the symmetric
    Stocks/Bonds allocation (calc_target_weights.py / calc_us_allocation.py's
    compute_allocation). One side gains, the other loses, by the SAME pp
    amount (see _alloc_shift_pp) -- so total always stays exactly
    base_stocks + base_bonds, no renormalization needed. The shift itself is
    capped at ALLOC_MAX_SHIFT_PP as an asymptote (never reached), so on its
    own it can't push a side below zero as long as that side's base share is
    at least ALLOC_MAX_SHIFT_PP; if a base share is smaller than that (e.g. a
    near-zero base), the shift is additionally clamped to that side's own
    base share so the result never goes negative in that edge case either.
    Continuous and differentiable at z = +-Z_THRESHOLD, same as
    adjusted_weight."""
    base_bonds = 100.0 - base_stocks
    if z is None or abs(z) <= Z_THRESHOLD:
        return base_stocks, base_bonds

    excess = abs(z) - Z_THRESHOLD
    shift = _alloc_shift_pp(excess)

    if z > Z_THRESHOLD:
        # Stocks cheap vs rates -> buy stocks: Bonds loses, Stocks gains.
        shift = min(shift, base_bonds)
        return base_stocks + shift, base_bonds - shift
    else:
        # Rates rich vs stocks -> buy bonds: Stocks loses, Bonds gains.
        shift = min(shift, base_stocks)
        return base_stocks - shift, base_bonds + shift


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