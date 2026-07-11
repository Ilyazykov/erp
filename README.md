# ERP Portfolio Valuation Indicator

Historical valuation indicator for a Russian stock portfolio — ERP proxy and per-stock z-score.

**[Interactive charts →](https://ilyazykov.github.io/erp_portfolio)**

## Usage

```bash
# Update data (downloads only missing entries)
python3 update_data.py

# Recalculate and save charts / CSV
python3 composite_valuation.py

# Rebuild interactive HTML
python3 build_html.py
```

## Requirements

```
matplotlib
openpyxl   # optional, for Excel export
plotly     # for interactive HTML
```
