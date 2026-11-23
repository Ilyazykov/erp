"""12-month net income of a Russian stock from its published quarters, without one-off quarters."""
from statistics import median

ONE_OFF_SHARE = 0.75  # this far from the median of the recent quarters (share of it) is unusual
RECENT_QUARTERS = 8


def without_one_offs(values: list[float]) -> list[float]:
    """Quarters, oldest first. An unusual quarter takes the recent median; two unusual ones in a row
    on the same side are kept: that's a real change in earnings, not a one-off."""
    recent = values[-RECENT_QUARTERS:]
    if len(recent) < 4:
        return values
    typical = median(recent)
    if typical <= 0:
        return values
    side = [0 if abs(v - typical) <= ONE_OFF_SHARE * typical else (1 if v > typical else -1) for v in recent]
    cleaned = [
        typical if s and not ((i > 0 and side[i - 1] == s) or (i + 1 < len(side) and side[i + 1] == s)) else v
        for i, (v, s) in enumerate(zip(recent, side))
    ]
    return values[:-len(recent)] + cleaned


def ttm_net_income(values: list[float]) -> float:
    """The last four quarters' sum (at least four expected)."""
    return sum(without_one_offs(values)[-4:])
