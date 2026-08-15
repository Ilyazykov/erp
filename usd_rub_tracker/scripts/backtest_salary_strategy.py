"""
Backtests a simple monthly savings strategy from 2010 onward:

Each month, an amount equal to the average Russian nominal salary that
month is received and split between a RUB "deposit" and a USD "deposit"
according to the CNY-weight formula's w_CNY(t) (used here as the foreign-
currency share, i.e. the fraction converted to USD at that month's
USD/RUB rate). Past contributions are never rebalanced or sold — each
month's RUB portion keeps compounding at that month's CBR key rate, and
each month's USD portion keeps compounding at that month's Fed funds
rate. A second, comparison strategy contributes with a fixed 50/50 split
instead of the w_CNY(t)-based split.

Total capital (in RUB) at any time t is:
    rub_capital(t) + usd_capital(t) * USD_RUB(t)

Salary, CBR rate, and Fed rate are hand-entered from well-known public
figures (Rosstat, cbr.ru, federalreserve.gov) — see the tables below.
Salary is linearly interpolated between yearly averages; both rates are
step-interpolated (held constant between listed change dates), matching
how each is actually reported/decided.

Outputs:
    usd_rub_tracker/charts/salary_backtest.png

Run:
    python scripts/backtest_salary_strategy.py
"""

from __future__ import annotations

import csv
from datetime import date, datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PROJECT_ROOT = Path(__file__).resolve().parent.parent
HISTORY_5Y_PATH = REPO_ROOT / "data" / "usd_rub_history_5y.csv"
PLOT_PATH = PROJECT_ROOT / "charts" / "salary_backtest.png"

ROLLING_WINDOW_DAYS = 365
BACKTEST_START = date(2010, 1, 1)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def w_cny(x: float, m: float) -> float:
    return 0.20 + 0.60 / (1 + np.exp(15 * (x - m) / m))


# ── Average Russian nominal monthly salary by year (RUB), Rosstat ──────────────
SALARY_BY_YEAR = {
    2010: 20952, 2011: 23369, 2012: 26629, 2013: 29792, 2014: 32495,
    2015: 34030, 2016: 36709, 2017: 39167, 2018: 43724, 2019: 47867,
    2020: 51344, 2021: 57244, 2022: 65338, 2023: 74854, 2024: 87952,
    2025: 99000, 2026: 109000,
}


def salary_at(d: date) -> float:
    """Linearly interpolate the average monthly salary at date d, anchored
    to each year's average value on July 1 of that year."""
    y = d.year
    anchor_this = date(y, 7, 1)
    if d < anchor_this:
        y0, y1 = y - 1, y
    else:
        y0, y1 = y, y + 1
    y0 = max(min(SALARY_BY_YEAR.keys()), y0)
    y1 = min(max(SALARY_BY_YEAR.keys()), y1)
    if y0 == y1:
        return SALARY_BY_YEAR[y0]
    s0, s1 = SALARY_BY_YEAR[y0], SALARY_BY_YEAR[y1]
    t0, t1 = date(y0, 7, 1), date(y1, 7, 1)
    frac = (d - t0).days / (t1 - t0).days
    return s0 + frac * (s1 - s0)


# ── CBR key rate, step function: (effective date, rate %) ─────────────────────
CBR_RATE_CHANGES = [
    (date(2010, 1, 1), 8.75), (date(2010, 2, 24), 8.50), (date(2010, 3, 29), 8.25),
    (date(2010, 6, 1), 7.75), (date(2011, 5, 3), 8.25), (date(2011, 12, 26), 8.00),
    (date(2013, 9, 13), 5.50), (date(2014, 3, 3), 7.00), (date(2014, 4, 28), 7.50),
    (date(2014, 7, 28), 8.00), (date(2014, 11, 5), 9.50), (date(2014, 12, 12), 10.50),
    (date(2014, 12, 16), 17.00), (date(2015, 2, 2), 15.00), (date(2015, 3, 16), 14.00),
    (date(2015, 5, 5), 12.50), (date(2015, 6, 16), 11.50), (date(2015, 8, 3), 11.00),
    (date(2016, 6, 14), 10.50), (date(2016, 9, 19), 10.00), (date(2017, 3, 27), 9.75),
    (date(2017, 5, 2), 9.25), (date(2017, 6, 19), 9.00), (date(2017, 9, 18), 8.50),
    (date(2017, 10, 30), 8.25), (date(2017, 12, 18), 7.75), (date(2018, 2, 12), 7.50),
    (date(2018, 3, 26), 7.25), (date(2018, 9, 17), 7.50), (date(2018, 12, 17), 7.75),
    (date(2019, 6, 17), 7.50), (date(2019, 7, 29), 7.25), (date(2019, 9, 9), 7.00),
    (date(2019, 10, 28), 6.50), (date(2019, 12, 16), 6.25), (date(2020, 2, 10), 6.00),
    (date(2020, 4, 27), 5.50), (date(2020, 6, 22), 4.50), (date(2020, 7, 27), 4.25),
    (date(2021, 3, 22), 4.50), (date(2021, 4, 26), 5.00), (date(2021, 6, 15), 5.50),
    (date(2021, 7, 26), 6.50), (date(2021, 9, 13), 6.75), (date(2021, 10, 25), 7.50),
    (date(2021, 12, 20), 8.50), (date(2022, 2, 14), 9.50), (date(2022, 2, 28), 20.00),
    (date(2022, 4, 11), 17.00), (date(2022, 5, 4), 14.00), (date(2022, 5, 27), 11.00),
    (date(2022, 6, 14), 9.50), (date(2022, 7, 25), 8.00), (date(2022, 9, 19), 7.50),
    (date(2023, 7, 24), 8.50), (date(2023, 8, 15), 12.00), (date(2023, 9, 18), 13.00),
    (date(2023, 10, 30), 15.00), (date(2023, 12, 18), 16.00), (date(2024, 7, 29), 18.00),
    (date(2024, 9, 16), 19.00), (date(2024, 10, 28), 21.00), (date(2025, 6, 9), 20.00),
    (date(2025, 7, 28), 18.00), (date(2025, 9, 15), 17.00), (date(2025, 10, 27), 16.50),
    (date(2025, 12, 19), 16.00), (date(2026, 6, 1), 13.00),
]

# ── Fed funds rate (target upper bound), step function ─────────────────────────
FED_RATE_CHANGES = [
    (date(2010, 1, 1), 0.25), (date(2015, 12, 17), 0.50), (date(2016, 12, 15), 0.75),
    (date(2017, 3, 16), 1.00), (date(2017, 6, 15), 1.25), (date(2017, 12, 14), 1.50),
    (date(2018, 3, 22), 1.75), (date(2018, 6, 14), 2.00), (date(2018, 9, 27), 2.25),
    (date(2018, 12, 20), 2.50), (date(2019, 8, 1), 2.25), (date(2019, 9, 19), 2.00),
    (date(2019, 10, 31), 1.75), (date(2020, 3, 3), 1.25), (date(2020, 3, 16), 0.25),
    (date(2022, 3, 17), 0.50), (date(2022, 5, 5), 1.00), (date(2022, 6, 16), 1.75),
    (date(2022, 7, 28), 2.50), (date(2022, 9, 22), 3.25), (date(2022, 11, 3), 4.00),
    (date(2022, 12, 15), 4.50), (date(2023, 2, 2), 4.75), (date(2023, 3, 23), 5.00),
    (date(2023, 5, 4), 5.25), (date(2023, 7, 27), 5.50), (date(2024, 9, 19), 5.00),
    (date(2024, 11, 8), 4.75), (date(2024, 12, 19), 4.50), (date(2025, 9, 18), 4.25),
    (date(2025, 10, 30), 4.00), (date(2025, 12, 11), 3.75), (date(2026, 6, 1), 3.25),
]


def make_step_lookup(changes: list[tuple[date, float]]):
    sorted_changes = sorted(changes)

    def lookup(d: date) -> float:
        rate = sorted_changes[0][1]
        for change_date, value in sorted_changes:
            if change_date > d:
                break
            rate = value
        return rate

    return lookup


cbr_rate_at = make_step_lookup(CBR_RATE_CHANGES)
fed_rate_at = make_step_lookup(FED_RATE_CHANGES)


def read_usd_rub_history(path: Path) -> dict[date, float]:
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return {date.fromisoformat(row["date"]): float(row["rate"]) for row in reader}


def compute_w_cny_series(rate_by_date: dict[date, float]) -> dict[date, float]:
    """Trailing 365-day average m(t) and w_CNY(x(t), m(t)) for every date
    that has 365 preceding days of history."""
    dates_sorted = sorted(rate_by_date)
    rates = [rate_by_date[d] for d in dates_sorted]
    n = len(rates)
    cumsum = np.cumsum(rates)

    w_cny_by_date: dict[date, float] = {}
    for i in range(ROLLING_WINDOW_DAYS - 1, n):
        window_sum = cumsum[i] - (cumsum[i - ROLLING_WINDOW_DAYS] if i >= ROLLING_WINDOW_DAYS else 0)
        m_t = window_sum / ROLLING_WINDOW_DAYS
        x_t = rates[i]
        w_cny_by_date[dates_sorted[i]] = w_cny(x_t, m_t)
    return w_cny_by_date


def month_range(start: date, end: date) -> list[date]:
    months = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        months.append(date(y, m, 1))
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return months


def nearest_available_date(target: date, available_dates: list[date]) -> date:
    """available_dates must be sorted ascending. Returns the closest date
    <= target, or the first available date if target is before all of them."""
    lo, hi = 0, len(available_dates) - 1
    best = available_dates[0]
    while lo <= hi:
        mid = (lo + hi) // 2
        if available_dates[mid] <= target:
            best = available_dates[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def allocate_contribution(
    rub_capital: float, usd_capital: float, usd_rub_rate: float, target_usd_share: float, salary: float
) -> tuple[float, float]:
    """
    Soft rebalancing: direct the whole salary toward whichever currency is
    currently under its target share of total capital, until the target
    is hit; any leftover salary is split according to target_usd_share.
    Past contributions are never sold — only the new salary moves the mix.
    """
    total = rub_capital + usd_capital * usd_rub_rate
    target_usd_value = total * target_usd_share
    current_usd_value = usd_capital * usd_rub_rate
    usd_gap_rub = target_usd_value - current_usd_value  # >0 => USD underweight

    if usd_gap_rub > 0:
        to_usd_rub = min(salary, usd_gap_rub)
        leftover = salary - to_usd_rub
        rub_add = leftover * (1 - target_usd_share)
        usd_add_rub = to_usd_rub + leftover * target_usd_share
    else:
        to_rub = min(salary, -usd_gap_rub)
        leftover = salary - to_rub
        rub_add = to_rub + leftover * (1 - target_usd_share)
        usd_add_rub = leftover * target_usd_share

    return rub_add, usd_add_rub / usd_rub_rate


def run_backtest(rate_by_date: dict[date, float], w_cny_by_date: dict[date, float]):
    available_dates = sorted(rate_by_date)
    w_cny_dates = sorted(w_cny_by_date)
    end = available_dates[-1]

    months = month_range(BACKTEST_START, end)

    rub_capital_wcny = 0.0
    usd_capital_wcny = 0.0
    rub_capital_5050 = 0.0
    usd_capital_5050 = 0.0
    rub_capital_hard = 0.0
    usd_capital_hard = 0.0
    rub_capital_hybrid = 0.0
    usd_capital_hybrid = 0.0
    rub_capital_all_rub = 0.0
    usd_capital_all_usd = 0.0
    rub_capital_hybrid_5050 = 0.0
    usd_capital_hybrid_5050 = 0.0

    total_wcny_series = []
    total_5050_series = []
    total_hard_series = []
    total_hybrid_series = []
    total_all_rub_series = []
    total_all_usd_series = []
    total_hybrid_5050_series = []
    dates_series = []

    for month_start in months:
        usd_rub_date = nearest_available_date(month_start, available_dates)
        usd_rub_rate = rate_by_date[usd_rub_date]

        w_cny_date = nearest_available_date(month_start, w_cny_dates)
        current_w_cny = w_cny_by_date[w_cny_date]

        cbr_rate = cbr_rate_at(month_start) / 100
        fed_rate = fed_rate_at(month_start) / 100

        # Compound existing capital at this month's rates (monthly rate = annual / 12).
        rub_capital_wcny *= 1 + cbr_rate / 12
        usd_capital_wcny *= 1 + fed_rate / 12
        rub_capital_5050 *= 1 + cbr_rate / 12
        usd_capital_5050 *= 1 + fed_rate / 12
        rub_capital_hard *= 1 + cbr_rate / 12
        usd_capital_hard *= 1 + fed_rate / 12
        rub_capital_hybrid *= 1 + cbr_rate / 12
        usd_capital_hybrid *= 1 + fed_rate / 12
        rub_capital_all_rub *= 1 + cbr_rate / 12
        usd_capital_all_usd *= 1 + fed_rate / 12
        rub_capital_hybrid_5050 *= 1 + cbr_rate / 12
        usd_capital_hybrid_5050 *= 1 + fed_rate / 12

        salary = salary_at(month_start)

        # Strategy 1: soft-rebalance toward w_CNY(t) — only new salary moves the mix.
        rub_add, usd_add = allocate_contribution(
            rub_capital_wcny, usd_capital_wcny, usd_rub_rate, current_w_cny, salary
        )
        rub_capital_wcny += rub_add
        usd_capital_wcny += usd_add

        # Strategy 2: soft-rebalance toward a fixed 50/50 target.
        rub_add, usd_add = allocate_contribution(
            rub_capital_5050, usd_capital_5050, usd_rub_rate, 0.5, salary
        )
        rub_capital_5050 += rub_add
        usd_capital_5050 += usd_add

        # Strategy 3: hard rebalance — add salary, then sell/buy so the whole
        # portfolio exactly matches w_CNY(t) every month (full rebalancing).
        rub_capital_hard += salary * (1 - current_w_cny)
        usd_capital_hard += salary * current_w_cny / usd_rub_rate
        total_hard = rub_capital_hard + usd_capital_hard * usd_rub_rate
        usd_capital_hard = total_hard * current_w_cny / usd_rub_rate
        rub_capital_hard = total_hard * (1 - current_w_cny)

        # Strategy 4: hybrid — soft-rebalance every month like Strategy 1,
        # but once a year (every January) hard-rebalance the whole portfolio
        # to that month's w_CNY(t), same as Strategy 3.
        rub_add, usd_add = allocate_contribution(
            rub_capital_hybrid, usd_capital_hybrid, usd_rub_rate, current_w_cny, salary
        )
        rub_capital_hybrid += rub_add
        usd_capital_hybrid += usd_add
        if month_start.month == 1:
            total_hybrid_rebalance = rub_capital_hybrid + usd_capital_hybrid * usd_rub_rate
            usd_capital_hybrid = total_hybrid_rebalance * current_w_cny / usd_rub_rate
            rub_capital_hybrid = total_hybrid_rebalance * (1 - current_w_cny)

        # Strategy 5: everything in RUB (CBR key rate deposit only).
        rub_capital_all_rub += salary

        # Strategy 6: everything in USD (Fed funds rate deposit only).
        usd_capital_all_usd += salary / usd_rub_rate

        # Strategy 7: hybrid — soft-rebalance every month toward a fixed
        # 50/50 target, plus a hard rebalance to 50/50 every January.
        rub_add, usd_add = allocate_contribution(
            rub_capital_hybrid_5050, usd_capital_hybrid_5050, usd_rub_rate, 0.5, salary
        )
        rub_capital_hybrid_5050 += rub_add
        usd_capital_hybrid_5050 += usd_add
        if month_start.month == 1:
            total_hybrid_5050_rebalance = rub_capital_hybrid_5050 + usd_capital_hybrid_5050 * usd_rub_rate
            usd_capital_hybrid_5050 = total_hybrid_5050_rebalance * 0.5 / usd_rub_rate
            rub_capital_hybrid_5050 = total_hybrid_5050_rebalance * 0.5

        total_wcny = rub_capital_wcny + usd_capital_wcny * usd_rub_rate
        total_5050 = rub_capital_5050 + usd_capital_5050 * usd_rub_rate
        total_hybrid = rub_capital_hybrid + usd_capital_hybrid * usd_rub_rate
        total_all_rub = rub_capital_all_rub
        total_all_usd = usd_capital_all_usd * usd_rub_rate
        total_hybrid_5050 = rub_capital_hybrid_5050 + usd_capital_hybrid_5050 * usd_rub_rate

        dates_series.append(month_start)
        total_wcny_series.append(total_wcny)
        total_5050_series.append(total_5050)
        total_hard_series.append(total_hard)
        total_hybrid_series.append(total_hybrid)
        total_all_rub_series.append(total_all_rub)
        total_all_usd_series.append(total_all_usd)
        total_hybrid_5050_series.append(total_hybrid_5050)

    return (dates_series, total_wcny_series, total_5050_series, total_hard_series,
            total_hybrid_series, total_all_rub_series, total_all_usd_series, total_hybrid_5050_series)


def build_plot(dates_series, total_wcny_series, total_5050_series, total_hard_series,
                total_hybrid_series, total_all_rub_series, total_all_usd_series,
                total_hybrid_5050_series, out_path: Path) -> None:
    fig, ax = plt.subplots(figsize=(12, 6.5))
    ax.plot(dates_series, np.array(total_hard_series) / 1e6, color="#16a34a", linewidth=1.8,
            label="w_CNY(t), hard rebalance (sells old holdings)")
    ax.plot(dates_series, np.array(total_hybrid_series) / 1e6, color="#f59e0b", linewidth=1.8,
            label="w_CNY(t), hybrid (soft monthly + hard rebalance every January)")
    ax.plot(dates_series, np.array(total_hybrid_5050_series) / 1e6, color="#ec4899", linewidth=1.8,
            linestyle="-.", label="Fixed 50/50, hybrid (soft monthly + hard rebalance every January)")
    ax.plot(dates_series, np.array(total_wcny_series) / 1e6, color="#2563eb", linewidth=1.8,
            label="w_CNY(t), soft rebalance (new salary only)")
    ax.plot(dates_series, np.array(total_5050_series) / 1e6, color="#9ca3af", linewidth=1.5,
            linestyle="--", label="Fixed 50/50, soft rebalance")
    ax.plot(dates_series, np.array(total_all_rub_series) / 1e6, color="#dc2626", linewidth=1.3,
            linestyle=":", label="All RUB (CBR key rate only)")
    ax.plot(dates_series, np.array(total_all_usd_series) / 1e6, color="#a855f7", linewidth=1.3,
            linestyle=":", label="All USD (Fed funds rate only)")

    ax.set_xlabel("Date")
    ax.set_ylabel("Total capital, RUB (millions)")
    ax.set_title("Capital from monthly salary contributions since 2010\n"
                 "(RUB @ CBR key rate, USD @ Fed funds rate)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    ax.xaxis.set_major_locator(mdates.YearLocator())
    plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
    ax.grid(True, alpha=0.3)
    ax.legend(loc="upper left")
    fig.text(0.99, 0.01, f"Updated: {utc_timestamp()}", color="#6b7280", fontsize=7,
              ha="right", va="bottom")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def main() -> int:
    rate_by_date = read_usd_rub_history(HISTORY_5Y_PATH)
    w_cny_by_date = compute_w_cny_series(rate_by_date)

    (dates_series, total_wcny_series, total_5050_series, total_hard_series, total_hybrid_series,
     total_all_rub_series, total_all_usd_series, total_hybrid_5050_series) = run_backtest(
        rate_by_date, w_cny_by_date
    )

    build_plot(dates_series, total_wcny_series, total_5050_series, total_hard_series,
               total_hybrid_series, total_all_rub_series, total_all_usd_series,
               total_hybrid_5050_series, PLOT_PATH)

    print(f"Months simulated: {len(dates_series)}")
    print(f"Final capital (w_CNY, soft rebalance): {total_wcny_series[-1]:,.0f} RUB")
    print(f"Final capital (50/50, soft rebalance): {total_5050_series[-1]:,.0f} RUB")
    print(f"Final capital (w_CNY, hard rebalance): {total_hard_series[-1]:,.0f} RUB")
    print(f"Final capital (w_CNY, hybrid rebalance): {total_hybrid_series[-1]:,.0f} RUB")
    print(f"Final capital (50/50, hybrid rebalance): {total_hybrid_5050_series[-1]:,.0f} RUB")
    print(f"Final capital (all RUB): {total_all_rub_series[-1]:,.0f} RUB")
    print(f"Final capital (all USD): {total_all_usd_series[-1]:,.0f} RUB")
    print(f"Saved plot to {PLOT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
