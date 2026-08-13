# ERP Portfolio Valuation Indicator

Historical valuation indicator for a Russian stock portfolio — ERP proxy and per-stock z-score.

**[Interactive charts →](https://ilyazykov.github.io/erp)**

## Usage

```bash
# Update data (downloads only missing entries)
python3 erp_valuation/update_data.py

# Recalculate and save charts / CSV
python3 erp_valuation/composite_valuation.py

# Update USD/RUB history and recalc CNY/RUB weights
python3 usd_rub_tracker/scripts/update_usd_rub.py
python3 usd_rub_tracker/scripts/calc_weights_and_plot.py
```

`index.html` is static and loads `data/*.csv` / `data/usd_rub_stats.json` directly in the
browser via `fetch()` — no rebuild step needed after updating data.

## Requirements

```
matplotlib
openpyxl   # optional, for Excel export
requests
numpy
```
