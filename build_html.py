"""
build_html.py — generates index.html with interactive Plotly charts for GitHub Pages.

Usage: python3 build_html.py
Output: index.html (open in browser or publish via GitHub Pages)
"""
import csv, json
from datetime import datetime

DATA_DIR = "./data"

def read_csv(path):
    with open(path) as f:
        return list(csv.DictReader(f))

def val(s):
    try:
        return float(s) if s else None
    except ValueError:
        return None

# ── Load data ─────────────────────────────────────────────────────────────────

rows = read_csv(f"{DATA_DIR}/composite_valuation.csv")
dates = [r['date'] + '-01' for r in rows]  # YYYY-MM-DD for plotly

def series(key):
    return [val(r.get(key, '')) for r in rows]

# Layer 1
port_yield  = series('portfolio_yield')
ofz10y      = series('ofz10y')
erp         = series('erp')

# Layer 1 — individual EY (from erp_portfolio.csv which has per-ticker EY)
ey_rows = read_csv(f"{DATA_DIR}/erp_portfolio.csv")
ey_dates = [r['date'] + '-01' for r in ey_rows]
def ey_series(key):
    return [val(r.get(key, '')) for r in ey_rows]

sber_ey = ey_series('SBER_ey')
ydex_ey = ey_series('YDEX_ey')
t_ey    = ey_series('T_ey')
ozon_ey = ey_series('OZON_ey')
rosn_ey = ey_series('ROSN_ey')
vtbr_ey = ey_series('VTBR_ey')

# Layer 2
sber_z  = series('SBER_z')
ydex_z  = series('YDEX_z')
t_z     = series('T_z')
ozon_z  = series('OZON_z')
rosn_z  = series('ROSN_z')
vtbr_z  = series('VTBR_z')
port_z  = series('portfolio_z')
ofz_z   = series('ofz_z')
comp_z  = series('composite_erp_z')

# ── Build chart data for JS ───────────────────────────────────────────────────

def js_series(dates, values, name, color, dash='solid', width=2, visible=True):
    clean_x = []
    clean_y = []
    for d, v in zip(dates, values):
        clean_x.append(d)
        clean_y.append(v)  # None becomes null in JSON which plotly handles
    return {
        'x': clean_x, 'y': clean_y, 'name': name,
        'type': 'scatter', 'mode': 'lines',
        'line': {'color': color, 'dash': dash, 'width': width},
        'visible': True if visible else 'legendonly',
        'hovertemplate': '%{x|%Y-%m}<br>' + name + ': <b>%{y:.2f}</b><extra></extra>',
    }

# ERP fill areas
def erp_fill(dates, values, above):
    y_fill = [v if v is not None and ((above and v >= 0) or (not above and v < 0)) else None
              for v in values]
    return {
        'x': dates, 'y': y_fill,
        'fill': 'tozeroy',
        'fillcolor': 'rgba(61,214,140,0.12)' if above else 'rgba(224,82,82,0.12)',
        'line': {'width': 0},
        'mode': 'lines',
        'showlegend': False,
        'hoverinfo': 'skip',
        'type': 'scatter',
        'connectgaps': False,
    }

layer1_traces = [
    js_series(dates, port_yield, 'Portfolio EY (all tickers)', '#4da8c8', width=2),
    js_series(dates, ofz10y,     'OFZ 10Y',                  '#f0b429', width=2),
    js_series(dates, erp,        'ERP (EY − OFZ)',            '#3dd68c', width=2.5),
    erp_fill(dates, erp, above=True),
    erp_fill(dates, erp, above=False),
]

layer1_individual_traces = [
    js_series(ey_dates, sber_ey, 'SBER EY%', '#4da8c8', visible=True),
    js_series(ey_dates, ydex_ey, 'YDEX EY%', '#f0b429', visible=True),
    js_series(ey_dates, t_ey,    'T EY%',    '#3dd68c', visible=True),
    js_series(ey_dates, ozon_ey, 'OZON EY%', '#e05252', visible=True),
    js_series(ey_dates, rosn_ey, 'ROSN EY%', '#a78bfa', visible='legendonly'),
    js_series(ey_dates, vtbr_ey, 'VTBR EY%', '#fb923c', visible='legendonly'),
    js_series(ey_dates, [val(r['ofz10y']) for r in ey_rows],
              'OFZ 10Y', '#f0b429', dash='dash', width=1.5),
]

layer2_rebal_traces = [
    js_series(dates, sber_z, 'SBER (EY)',       '#4da8c8'),
    js_series(dates, ydex_z, 'YDEX (Rev Yield)','#f0b429'),
    js_series(dates, t_z,    'T (EY)',           '#3dd68c'),
    js_series(dates, ozon_z, 'OZON (Rev Yield)', '#e05252'),
    js_series(dates, rosn_z, 'ROSN (FCF Yield)', '#a78bfa', visible='legendonly'),
    js_series(dates, vtbr_z, 'VTBR (EY)',        '#fb923c', visible='legendonly'),
]

layer2_alloc_traces = [
    js_series(dates, port_z, 'Portfolio Z', '#4da8c8'),
    js_series(dates, ofz_z,  'OFZ Z',       '#f0b429'),
    js_series(dates, comp_z, 'Composite ERP Z (Port − OFZ)', '#3dd68c', width=2.5),
    erp_fill(dates, comp_z, above=True),
    erp_fill(dates, comp_z, above=False),
]

data_json = json.dumps({
    'layer1': layer1_traces,
    'layer1_individual': layer1_individual_traces,
    'layer2_rebal': layer2_rebal_traces,
    'layer2_alloc': layer2_alloc_traces,
}, default=lambda x: None)

# ── HTML ──────────────────────────────────────────────────────────────────────

html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ERP Portfolio Valuation</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }}
  h1 {{ font-size: 1.3rem; font-weight: 600; color: #e6edf3; margin-bottom: 4px; }}
  .subtitle {{ font-size: 0.85rem; color: #6a7381; margin-bottom: 24px; }}
  .tabs {{ display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }}
  .tab {{ padding: 6px 16px; border-radius: 6px; border: 1px solid #1e2830; background: #13191f;
          color: #8b949e; cursor: pointer; font-size: 0.85rem; transition: all 0.15s; }}
  .tab:hover {{ border-color: #4da8c8; color: #c9d1d9; }}
  .tab.active {{ background: #1a2a3a; border-color: #4da8c8; color: #4da8c8; }}
  .chart-wrap {{ background: #0d1117; border: 1px solid #1e2830; border-radius: 8px;
                 padding: 8px; margin-bottom: 16px; display: none; }}
  .chart-wrap.active {{ display: block; }}
  .note {{ font-size: 0.78rem; color: #6a7381; margin-top: 8px; line-height: 1.5; }}
  .note b {{ color: #8b949e; }}
</style>
</head>
<body>
<h1>ERP Portfolio Valuation</h1>
<p class="subtitle">SBER · YDEX · T · OZON · ROSN · VTBR &nbsp;|&nbsp; Jan 2019 — present</p>

<div class="tabs">
  <div class="tab active" onclick="showTab('layer1')">Layer 1: ERP</div>
  <div class="tab" onclick="showTab('layer1i')">Yield per stock</div>
  <div class="tab" onclick="showTab('layer2r')">Layer 2: Rebalancing</div>
  <div class="tab" onclick="showTab('layer2a')">Layer 2: Allocation</div>
</div>

<div id="layer1" class="chart-wrap active"><div id="plot_layer1" style="height:480px"></div>
<p class="note">
  <b>Blue</b> — Portfolio Earnings Yield (TTM Net Income / Market Cap for all 6 stocks, portfolio-weighted).<br>
  <b>Orange</b> — OFZ 10Y (risk-free rate).<br>
  <b>Green</b> — ERP = EY − OFZ. Green zone: stocks yield more than bonds. Red zone: bonds yield more.
</p></div>

<div id="layer1i" class="chart-wrap"><div id="plot_layer1i" style="height:480px"></div>
<p class="note">
  Earnings Yield per stock. YDEX and OZON have low EY due to high market cap (growth premium).<br>
  OZON until 2025 — negative EY (loss-making).
</p></div>

<div id="layer2r" class="chart-wrap"><div id="plot_layer2r" style="height:480px"></div>
<p class="note">
  Z-score of each stock vs its own 3-year history (36-month rolling window).<br>
  Metrics: SBER/T/VTBR — Earnings Yield; ROSN — FCF Yield; YDEX/OZON — Revenue Yield.<br>
  <b>Above +1.5</b> → stock cheaper than its norm → buy. <b>Below −1.5</b> → more expensive → trim.
</p></div>

<div id="layer2a" class="chart-wrap"><div id="plot_layer2a" style="height:480px"></div>
<p class="note">
  <b>Green (Composite ERP Z)</b> = Portfolio Z − OFZ Z.<br>
  Above +1.5 → stocks cheap vs rates → increase equity allocation.<br>
  Below −1.5 → rates high vs stocks → increase bond allocation.
</p></div>

<script>
const DATA = {data_json};

const LAYOUT_BASE = {{
  paper_bgcolor: '#0d1117',
  plot_bgcolor:  '#0d1117',
  font:  {{ color: '#c9d1d9', size: 11 }},
  xaxis: {{ gridcolor: '#1e2830', linecolor: '#1e2830', tickformat: '%Y-%m',
            tickangle: -45, dtick: 'M3' }},
  yaxis: {{ gridcolor: '#1e2830', linecolor: '#1e2830' }},
  legend: {{ bgcolor: '#13191f', bordercolor: '#1e2830', borderwidth: 1 }},
  hovermode: 'x unified',
  hoverlabel: {{ bgcolor: '#13191f', bordercolor: '#1e2830', font: {{ color: '#c9d1d9' }} }},
  margin: {{ t: 20, r: 20, b: 60, l: 50 }},
  shapes: [],
}};

function layoutWith(yaxis_title, shapes) {{
  return Object.assign({{}}, LAYOUT_BASE, {{
    yaxis: Object.assign({{}}, LAYOUT_BASE.yaxis, {{ title: yaxis_title }}),
    shapes: shapes || [],
  }});
}}

const HLINE = (y, color, dash) => ({{
  type: 'line', xref: 'paper', x0: 0, x1: 1,
  y0: y, y1: y, line: {{ color, dash: dash||'dash', width: 1 }},
}});

const CONFIG = {{ responsive: true, displayModeBar: true,
  modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'],
  toImageButtonOptions: {{ format: 'png', scale: 2 }} }};

let rendered = {{}};

function showTab(id) {{
  document.querySelectorAll('.tab').forEach((t,i) => {{
    const ids = ['layer1','layer1i','layer2r','layer2a'];
    t.classList.toggle('active', ids[i] === id);
  }});
  document.querySelectorAll('.chart-wrap').forEach(el => {{
    el.classList.toggle('active', el.id === id);
  }});
  if (!rendered[id]) {{
    rendered[id] = true;
    renderChart(id);
  }}
}}

function renderChart(id) {{
  if (id === 'layer1') {{
    Plotly.newPlot('plot_layer1', DATA.layer1,
      layoutWith('%, annualised', [HLINE(0,'#6a7381','dot')]), CONFIG);
  }} else if (id === 'layer1i') {{
    Plotly.newPlot('plot_layer1i', DATA.layer1_individual,
      layoutWith('%, annualised', [HLINE(0,'#6a7381','dot')]), CONFIG);
  }} else if (id === 'layer2r') {{
    Plotly.newPlot('plot_layer2r', DATA.layer2_rebal,
      layoutWith('Z-score', [
        HLINE(0,  '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5,'#e05252', 'dot'),
      ]), CONFIG);
  }} else if (id === 'layer2a') {{
    Plotly.newPlot('plot_layer2a', DATA.layer2_alloc,
      layoutWith('Z-score', [
        HLINE(0,  '#6a7381', 'dot'),
        HLINE(1.5, '#3dd68c', 'dot'),
        HLINE(-1.5,'#e05252', 'dot'),
      ]), CONFIG);
  }}
}}

// Render first tab immediately
renderChart('layer1');
</script>
</body>
</html>"""

out = "./index.html"
with open(out, 'w') as f:
    f.write(html)
print(f"Generated: {out}")
