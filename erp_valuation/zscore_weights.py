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

With a small base weight and a strongly negative Z, base + correction can go
negative -- impossible for a donut sector's angle/radius (or for a
percentage weight at all). Rather than clip (max(0, x): a hard corner, not
differentiable, and any redistribution scheme to compensate the clipped
amount either distorts just the one clipped ticker or has to pick an
arbitrary redistribution rule) or apply one global shift to every ticker
(shifting the minimum up to exactly 0 preserves relative spacing but still
has that same sharp corner at the exact moment a ticker crosses zero;
shifting it up to the ticker's own base instead avoids the corner but
visibly dilutes every OTHER ticker's correction towards its base, including
tickers whose Z-score needed no correction at all -- both were tried and
rejected), `adjusted` is passed through softplus:

    adjusted = softplus(base + correction) = ln(1 + e^(base + correction))

softplus is smooth everywhere (no corner, unlike max(0, x)) and satisfies
softplus(x) -> x as x -> +inf, softplus(x) -> 0+ as x -> -inf, so it
behaves like the identity function far from zero and only bends the curve
in the region where base + correction is small or negative -- exactly the
region where the raw formula was already numerically fragile. Every
ticker's own value moves smoothly with only its own correction (no cross-
ticker shift, so tickers with no correction stay close to their own base,
unlike the shift-based approaches above); the price for that is that
softplus(x) != x even for x > 0 (e.g. softplus(1) ~ 1.31), so already-small
base weights are inflated slightly even when their Z-score needed no
correction. This was judged an acceptable, purely cosmetic tradeoff since
every value is renormalized to sum to 100 anyway.

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


def _softplus(x: float) -> float:
    if x > 30:  # e^x would overflow; softplus(x) ~ x to way beyond float precision here
        return x
    return math.log(1 + math.exp(x))


def adjusted_weight(base: float, z: float | None) -> float:
    return _softplus(base + z_correction(z))


def compute_target_weights(base_weights: dict[str, float], zscores: dict[str, float]) -> list[dict]:
    """Returns a list of {ticker, base, z, signal, adjusted, target} dicts.

    `target` values are guaranteed non-negative (in fact strictly positive,
    via softplus -- see module docstring) and sum to 100.
    """
    rows = []
    for ticker, base in base_weights.items():
        z = zscores.get(ticker)
        adj = adjusted_weight(base, z)
        rows.append({"ticker": ticker, "base": base, "z": z, "signal": signal(z), "adjusted": adj})

    total_adjusted = sum(r["adjusted"] for r in rows)
    for r in rows:
        r["target"] = r["adjusted"] / total_adjusted * 100

    return rows
