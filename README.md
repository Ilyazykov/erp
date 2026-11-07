# ERP Portfolio Valuation Indicator

Personal portfolio tool: historical valuation indicator (ERP proxy and per-stock z-score),
a Supabase-backed dashboard, and a set of importers for bank and broker statements.

**[Interactive charts →](https://ilyazykov.github.io/erp)**

## Layout

- `index.html` — the whole front end: a single static page with Plotly charts and the
  Supabase client. It reads `data/*.csv` and `data/usd_rub_stats.json` via `fetch()`,
  so no build step is needed after the data changes.
- `erp_valuation/` — Python: market data updates, ERP / z-score / target weight calculations.
- `usd_rub_tracker/` — Python: USD/RUB history and CNY/RUB weight calculations.
- `supabase/migrations/` — SQL migrations, applied to the database by the deploy workflow.
- `supabase/functions/` — Edge Functions (Deno/TypeScript): statement importers
  (`import-*`), broker and exchange syncs (`sync-*`), and scheduled updates (`update-*`).
  Shared code lives in `supabase/functions/_shared/`.
- `data/` — tracked CSV/JSON that the page and the charts read.
- `statements/` — raw bank and broker files. Not in git (see `.gitignore`).
- `tests/charts.test.mjs` — checks the Charts tab's target calculations on a synthetic portfolio.
- `tmp_charts/` — local chart exports. Not in git.

## Usage

```bash
# Update data (downloads only missing entries)
python3 erp_valuation/update_data.py

# Recalculate and save charts / CSV
python3 erp_valuation/composite_valuation.py

# Update USD/RUB history and recalc CNY/RUB weights
python3 usd_rub_tracker/scripts/update_usd_rub.py
python3 usd_rub_tracker/scripts/calc_weights_and_plot.py

# Test the Charts tab logic
node tests/charts.test.mjs
```

The scheduled jobs in `.github/workflows/` run the Python scripts daily and commit the
results back to the repository. `supabase_deploy.yml` pushes migrations and deploys Edge
Functions on every push to `main` that touches `supabase/`.

## Secrets

Nothing secret is committed. Broker and exchange API keys and tokens are entered on the
page and stored in Supabase Vault; the page reads back only whether a value is set.
Edge Functions get them through the service role. The Supabase deploy workflow uses the
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD` repository secrets.

## Requirements

```bash
pip install -r erp_valuation/requirements.txt
pip install -r usd_rub_tracker/requirements.txt
```

Node.js 20+ for the test.
