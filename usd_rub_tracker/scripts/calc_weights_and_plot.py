"""
Computes CNY/RUB portfolio weights from USD/RUB history and renders a
sigmoid weight-curve plot plus a Markdown report.

m (365-day average) and x (latest rate) are precomputed by
scripts/update_usd_rub.py (or scripts/fetch_initial_history.py on first
run) and stored in data/usd_rub_stats.json, so they are read here rather
than recomputed from the full CSV. The CSV is still read for the plot's
min/max rate range.

Formulas:
    w_CNY(x) = 0.20 + 0.60 / (1 + exp(15 * (x - m) / m))
    w_RUB(x) = 1 - w_CNY(x)

Also renders a second chart, w_CNY(t) over the trailing ~5 years, from
data/usd_rub_history_5y.csv (an append-only, ever-growing series — see
scripts/fetch_5y_history.py and scripts/update_usd_rub.py). For each day
t, m(t) is the trailing 365-day average rate as of t, so the first ~365
days of that file have no defined point.

Outputs:
    usd_rub_tracker/charts/sigmoid.png
    usd_rub_tracker/charts/wcny_5y.png
    usd_rub_tracker/REPORT.md

Run:
    python scripts/calc_weights_and_plot.py
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "data" / "usd_rub_history.csv"
HISTORY_5Y_PATH = REPO_ROOT / "data" / "usd_rub_history_5y.csv"
STATS_PATH = REPO_ROOT / "data" / "usd_rub_stats.json"
PLOT_PATH = PROJECT_ROOT / "charts" / "sigmoid.png"
WCNY_5Y_PLOT_PATH = PROJECT_ROOT / "charts" / "wcny_5y.png"
REPORT_PATH = PROJECT_ROOT / "REPORT.md"

ROLLING_WINDOW_DAYS = 365


def read_rates(path: Path = CSV_PATH) -> list[float]:
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [float(row["rate"]) for row in reader]


def read_history(path: Path) -> list[tuple[str, float]]:
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [(row["date"], float(row["rate"])) for row in reader]


def read_stats(path: Path = STATS_PATH) -> tuple[float, float]:
    stats = json.loads(path.read_text(encoding="utf-8"))
    return float(stats["x"]), float(stats["m"])


def w_cny(x: float, m: float) -> float:
    return 0.20 + 0.60 / (1 + np.exp(15 * (x - m) / m))


def w_rub(x: float, m: float) -> float:
    return 1 - w_cny(x, m)


X_AXIS_MIN = 55
X_AXIS_MAX = 120


def build_plot(rates: list[float], x: float, m: float, current_w_cny: float, out_path: Path) -> None:
    axis_min = min(X_AXIS_MIN, min(rates), x, m)
    axis_max = max(X_AXIS_MAX, max(rates), x, m)
    x_range = np.linspace(axis_min, axis_max, 500)
    y_range = w_cny(x_range, m) * 100

    m_w_cny = float(w_cny(m, m)) * 100

    fig, ax = plt.subplots(figsize=(9, 6))
    ax.plot(x_range, y_range, color="#2563eb", linewidth=2, label="w_CNY(x)")
    ax.axvline(m, color="#2563eb", linestyle="--", linewidth=0.8, label=f"m (365-day avg) = {m:.2f}")
    ax.hlines(m_w_cny, x_range[0], x_range[-1], color="#2563eb", linestyle="--", linewidth=0.8)
    ax.axvline(x, color="#dc2626", linestyle="--", linewidth=0.8, label=f"current x = {x:.2f}")
    ax.hlines(current_w_cny * 100, x_range[0], x_range[-1], color="#dc2626", linestyle="--", linewidth=0.8)
    ax.plot([x], [current_w_cny * 100], marker="o", markersize=9, color="#dc2626", zorder=5)
    ax.annotate(
        f"w_CNY = {current_w_cny:.0%}",
        xy=(x, current_w_cny * 100),
        xytext=(10, 12),
        textcoords="offset points",
        fontsize=11,
        fontweight="bold",
        color="#dc2626",
    )

    ax.set_xlabel("USD/RUB rate")
    ax.set_ylabel("w_CNY(x), %")
    ax.set_title("CNY weight as a function of USD/RUB rate")
    ax.set_ylim(0, 100)
    ax.yaxis.set_major_locator(plt.MultipleLocator(10))
    ax.yaxis.set_major_formatter(lambda v, _pos: f"{v:.0f}%")
    ax.grid(True, alpha=0.3)
    ax.legend(loc="best")
    fig.text(0.99, 0.01, f"Updated: {utc_timestamp()}", color="#6b7280", fontsize=7,
              ha="right", va="bottom")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def build_wcny_5y_plot(history_5y: list[tuple[str, float]], out_path: Path) -> None:
    dates = [date.fromisoformat(d) for d, _ in history_5y]
    rates = np.array([r for _, r in history_5y])

    cumsum = np.cumsum(rates)
    n = len(rates)
    if n < ROLLING_WINDOW_DAYS:
        print(f"Not enough history for a {ROLLING_WINDOW_DAYS}-day rolling average; skipping wcny_5y plot.")
        return

    rolling_m = np.empty(n)
    rolling_m[:] = np.nan
    rolling_m[ROLLING_WINDOW_DAYS - 1] = cumsum[ROLLING_WINDOW_DAYS - 1] / ROLLING_WINDOW_DAYS
    for i in range(ROLLING_WINDOW_DAYS, n):
        window_sum = cumsum[i] - cumsum[i - ROLLING_WINDOW_DAYS]
        rolling_m[i] = window_sum / ROLLING_WINDOW_DAYS

    valid = ~np.isnan(rolling_m)
    plot_dates = [d for d, v in zip(dates, valid) if v]
    plot_x = rates[valid]
    plot_m = rolling_m[valid]
    plot_w_cny = w_cny(plot_x, plot_m) * 100

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(plot_dates, plot_w_cny, color="#2563eb", linewidth=1.5, label="w_CNY(t)")
    for level in (20, 50, 80):
        ax.axhline(level, color="#6b7280", linestyle="--", linewidth=0.6)

    ax.set_xlabel("Date")
    ax.set_ylabel("w_CNY(t), %")
    ax.set_title("CNY weight over time (trailing 365-day average)")
    ax.set_ylim(0, 100)
    ax.yaxis.set_major_locator(plt.MultipleLocator(10))
    ax.yaxis.set_major_formatter(lambda v, _pos: f"{v:.0f}%")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
    ax.grid(True, alpha=0.3)
    ax.legend(loc="best")
    fig.text(0.99, 0.01, f"Updated: {utc_timestamp()}", color="#6b7280", fontsize=7,
              ha="right", va="bottom")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def build_report(today: date, x: float, m: float, cny: float, rub: float, report_path: Path) -> None:
    plot_rel_path = "charts/sigmoid.png"
    wcny_5y_rel_path = "charts/wcny_5y.png"
    content = f"""# USD/RUB Weight Report

**Date:** {today.isoformat()}
**Updated:** {utc_timestamp()}

- Current USD/RUB rate (x): **{x:.4f}**
- 365-day average USD/RUB rate (m): **{m:.4f}**
- w_CNY(x): **{cny:.0%}**
- w_RUB(x): **{rub:.0%}**

![Sigmoid weight curve]({plot_rel_path})

![CNY weight over 5 years]({wcny_5y_rel_path})
"""
    report_path.write_text(content, encoding="utf-8")


def main() -> int:
    if not CSV_PATH.exists():
        print(f"History file not found: {CSV_PATH}", file=sys.stderr)
        return 1
    if not STATS_PATH.exists():
        print(f"Stats file not found: {STATS_PATH}", file=sys.stderr)
        return 1

    rates = read_rates()
    if not rates:
        print("History file is empty.", file=sys.stderr)
        return 1

    x, m = read_stats()

    cny = float(w_cny(x, m))
    rub = float(w_rub(x, m))

    build_plot(rates, x, m, cny, PLOT_PATH)

    if HISTORY_5Y_PATH.exists():
        history_5y = read_history(HISTORY_5Y_PATH)
        build_wcny_5y_plot(history_5y, WCNY_5Y_PLOT_PATH)
        print(f"Saved 5-year plot to {WCNY_5Y_PLOT_PATH}")
    else:
        print(f"5-year history not found ({HISTORY_5Y_PATH}); skipping wcny_5y plot.", file=sys.stderr)

    build_report(date.today(), x, m, cny, rub, REPORT_PATH)

    print(f"x={x:.4f} m={m:.4f} w_CNY={cny:.4f} w_RUB={rub:.4f}")
    print(f"Saved plot to {PLOT_PATH}")
    print(f"Saved report to {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
