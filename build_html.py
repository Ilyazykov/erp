"""
build_html.py — generates index.html with interactive Plotly charts for GitHub Pages.

Usage: python3 build_html.py
Output: index.html (open in browser or publish via GitHub Pages)
"""
import csv, json, math
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DATA_DIR = REPO_ROOT / "data"

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
]

# USD/RUB → CNY weight sigmoid
def w_cny(x, m):
    return 0.20 + 0.60 / (1 + math.exp(15 * (x - m) / m))

usd_rub_rows = read_csv(f"{DATA_DIR}/usd_rub_history.csv")
usd_rub_rates = [val(r['rate']) for r in usd_rub_rows]

with open(f"{DATA_DIR}/usd_rub_stats.json") as f:
    usd_rub_stats = json.load(f)

sigmoid_x = usd_rub_stats['x']
sigmoid_m = usd_rub_stats['m']
sigmoid_w_cny = w_cny(sigmoid_x, sigmoid_m)
sigmoid_m_w_cny = w_cny(sigmoid_m, sigmoid_m)
sigmoid_w_rub = 1 - sigmoid_w_cny
sigmoid_date = usd_rub_stats['date']

AXIS_MIN = min([55] + usd_rub_rates + [sigmoid_x, sigmoid_m])
AXIS_MAX = max([120] + usd_rub_rates + [sigmoid_x, sigmoid_m])
N_POINTS = 300
sigmoid_curve_x = [AXIS_MIN + i * (AXIS_MAX - AXIS_MIN) / (N_POINTS - 1) for i in range(N_POINTS)]
sigmoid_curve_y = [w_cny(px, sigmoid_m) * 100 for px in sigmoid_curve_x]

sigmoid_traces = [
    {
        'x': sigmoid_curve_x, 'y': sigmoid_curve_y, 'name': 'w_CNY(x)',
        'type': 'scatter', 'mode': 'lines',
        'line': {'color': '#4da8c8', 'width': 2.5},
        'hovertemplate': 'USD/RUB: %{x:.2f}<br>w_CNY: <b>%{y:.0f}%</b><extra></extra>',
    },
    {
        'x': [sigmoid_x], 'y': [sigmoid_w_cny * 100], 'name': f'current x = {sigmoid_x:.2f}',
        'type': 'scatter', 'mode': 'markers',
        'marker': {'color': '#e05252', 'size': 11},
        'hovertemplate': f'x = {sigmoid_x:.2f}<br>w_CNY = {sigmoid_w_cny:.0%}<extra></extra>',
    },
]

sigmoid_shapes = [
    # vertical + horizontal at m (blue)
    {'type': 'line', 'x0': sigmoid_m, 'x1': sigmoid_m, 'y0': 0, 'y1': 100,
     'line': {'color': '#4da8c8', 'dash': 'dash', 'width': 1}},
    {'type': 'line', 'xref': 'paper', 'x0': 0, 'x1': 1, 'y0': sigmoid_m_w_cny * 100, 'y1': sigmoid_m_w_cny * 100,
     'line': {'color': '#4da8c8', 'dash': 'dash', 'width': 1}},
    # vertical + horizontal at x (red)
    {'type': 'line', 'x0': sigmoid_x, 'x1': sigmoid_x, 'y0': 0, 'y1': 100,
     'line': {'color': '#e05252', 'dash': 'dash', 'width': 1}},
    {'type': 'line', 'xref': 'paper', 'x0': 0, 'x1': 1, 'y0': sigmoid_w_cny * 100, 'y1': sigmoid_w_cny * 100,
     'line': {'color': '#e05252', 'dash': 'dash', 'width': 1}},
]

sigmoid_annotations = [
    {'x': sigmoid_x, 'y': sigmoid_w_cny * 100, 'text': f'w_CNY = {sigmoid_w_cny:.0%}',
     'showarrow': False, 'xanchor': 'left', 'xshift': 12, 'yshift': 10,
     'font': {'color': '#e05252', 'size': 13}},
    {'x': sigmoid_m, 'y': sigmoid_m_w_cny * 100, 'text': f'm = {sigmoid_m:.2f}',
     'showarrow': False, 'xanchor': 'left', 'xshift': 12, 'yshift': -14,
     'font': {'color': '#4da8c8', 'size': 12}},
]

data_json = json.dumps({
    'layer1': layer1_traces,
    'layer1_individual': layer1_individual_traces,
    'layer2_rebal': layer2_rebal_traces,
    'layer2_alloc': layer2_alloc_traces,
    'sigmoid': sigmoid_traces,
    'sigmoid_shapes': sigmoid_shapes,
    'sigmoid_annotations': sigmoid_annotations,
    'sigmoid_stats': {
        'x': sigmoid_x, 'm': sigmoid_m,
        'w_cny': sigmoid_w_cny, 'w_rub': 1 - sigmoid_w_cny,
        'date': usd_rub_stats['date'],
    },
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
  <div class="tab" onclick="showTab('sigmoid')">USD/RUB → CNY Weight</div>
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

<div id="sigmoid" class="chart-wrap"><div id="plot_sigmoid" style="height:480px"></div>
<p class="note">
  w_CNY(x) = 0.20 + 0.60 / (1 + exp(15·(x−m)/m)), where <b>x</b> is the latest USD/RUB rate and
  <b>m</b> is its 365-day average.<br>
  <b>Blue</b> — sigmoid curve and 365-day average (m = {sigmoid_m:.2f}).
  <b>Red</b> — current rate (x = {sigmoid_x:.2f}) and resulting w_CNY = {sigmoid_w_cny:.0%},
  w_RUB = {sigmoid_w_rub:.0%}.<br>
  Data as of {sigmoid_date}.
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

function sigmoidLayout() {{
  return Object.assign({{}}, LAYOUT_BASE, {{
    xaxis: {{ gridcolor: '#1e2830', linecolor: '#1e2830', title: 'USD/RUB rate' }},
    yaxis: Object.assign({{}}, LAYOUT_BASE.yaxis, {{ title: 'w_CNY(x), %', range: [0, 100], dtick: 10 }}),
    shapes: DATA.sigmoid_shapes,
    annotations: DATA.sigmoid_annotations,
  }});
}}

const CONFIG = {{ responsive: true, displayModeBar: true,
  modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'],
  toImageButtonOptions: {{ format: 'png', scale: 2 }} }};

let rendered = {{}};

function showTab(id) {{
  document.querySelectorAll('.tab').forEach((t,i) => {{
    const ids = ['layer1','layer1i','layer2r','layer2a','sigmoid'];
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
  }} else if (id === 'sigmoid') {{
    Plotly.newPlot('plot_sigmoid', DATA.sigmoid, sigmoidLayout(), CONFIG);
  }}
}}

// Render first tab immediately
renderChart('layer1');
</script>
</body>
</html>"""

out = REPO_ROOT / "index.html"
with open(out, 'w') as f:
    f.write(html)
print(f"Generated: {out}")
