"""Render options backtest results as a self-contained HTML report."""
import json
from typing import Any, Dict


def render_report(data: Dict[str, Any]) -> str:
    summary = data["summary"]
    trades = data["trades"]
    day_summaries = data["day_summaries"]
    settings = data.get("settings_used", {})
    chart_bars = data.get("chart_bars", {})

    # Serialize bar data for each timeframe
    chart_bars_json = {}
    for tf in ["1m", "5m", "15m", "1h"]:
        bars = chart_bars.get(tf, [])
        chart_bars_json[tf] = json.dumps(bars)

    # GEX zones for the chart (LGN/SGN/ZERO lines)
    gex_zones = data.get("gex_zones", [])
    gex_zones_json = json.dumps(gex_zones)

    # Trade markers for the price chart. Carries enough data for the click-to-open
    # modal to render without an extra round-trip.
    trade_markers = json.dumps([
        {
            "date": t.get("date"),
            "strategy_id": t.get("strategy_id"),
            "signal_id": t.get("signal_id"),
            "direction": t["direction"],
            "right": t["right"],
            "strike": t["strike"],
            "quantity": t.get("quantity", 1),
            "capital_used": t.get("capital_used", 0),
            "entry_ts": t["entry_ts"],
            "exit_ts": t["exit_ts"],
            "entry_time": t.get("entry_time"),
            "exit_time": t.get("exit_time"),
            "entry_premium": t["entry_premium"],
            "exit_premium": t["exit_premium"],
            "pnl": t["pnl"],
            "pnl_pct": t.get("pnl_pct", 0),
            "mfe_pct": t.get("mfe_pct", 0),
            "mae_pct": t.get("mae_pct", 0),
            "hwm": t.get("hwm", 0),
            "hold_minutes": t.get("hold_minutes", 0),
            "exit_reason": t.get("exit_reason"),
            "skipped": t.get("skipped", False),
            "skip_reason": t.get("skip_reason"),
            "spot_at_entry": t.get("spot_at_entry"),
            "signal_metadata": t.get("signal_metadata"),
        }
        for t in trades
    ])

    # Build trade rows
    trade_rows = ""
    for t in trades:
        is_skipped = t.get("skipped", False)
        pnl_color = "#555" if is_skipped else ("#39d98a" if t["pnl"] > 0 else "#ff6b6b")
        dir_icon = "&#9650;" if t["direction"] == "CALL" else "&#9660;"
        dir_color = "#555" if is_skipped else ("#39d98a" if t["direction"] == "CALL" else "#ff6b6b")
        row_style = "opacity:0.5;font-style:italic;display:none" if is_skipped else ""
        row_class = "skipped-row" if is_skipped else ""
        skip_tag = '<span style="color:#f5a623;font-size:10px"> [SKIPPED]</span>' if is_skipped else ""
        trade_rows += f"""<tr style="{row_style}" class="{row_class}">
            <td>{t['date']}</td>
            <td style="color:{dir_color}">{dir_icon} {t['right']}{t['strike']:.0f}{skip_tag}</td>
            <td>{t.get('quantity', 1)}</td>
            <td>${t.get('capital_used', 0):.0f}</td>
            <td>{t['strategy_id'].replace('strategy','s').replace('_0dte_trend','').replace('_ict_price_action','')}</td>
            <td>{t['entry_time']}</td>
            <td>${t['entry_premium']:.2f}</td>
            <td>{t['exit_time']}</td>
            <td>${t['exit_premium']:.2f}</td>
            <td style="color:{pnl_color};font-weight:600">${t['pnl']:+.0f}</td>
            <td style="color:{pnl_color}">{t['pnl_pct']:+.1f}%</td>
            <td>+{t['mfe_pct']:.1f}%</td>
            <td>{t['mae_pct']:.1f}%</td>
            <td>${t['hwm']:.2f}</td>
            <td>{t['hold_minutes']}m</td>
            <td class="muted">{t['exit_reason'].replace('_', ' ')}</td>
        </tr>"""

    # Day summary rows
    day_rows = ""
    cumulative = 0
    day_pnls = []
    for d in day_summaries:
        pnl = d.get("pnl", 0)
        cumulative += pnl
        day_pnls.append(pnl)
        trades_count = d.get("trades", 0)
        pnl_color = "#39d98a" if pnl > 0 else "#ff6b6b" if pnl < 0 else "#7c8190"
        day_rows += f"""<tr>
            <td>{d['date']}</td>
            <td>{d.get('signals_total', '-')}</td>
            <td>{d.get('signals_after_filter', '-')}</td>
            <td>{trades_count}</td>
            <td style="color:{pnl_color};font-weight:600">${pnl:+.0f}</td>
            <td>${cumulative:+.0f}</td>
            <td>{d.get('wins', '-')}</td>
            <td>{d.get('losses', '-')}</td>
            <td class="muted">{d.get('error', d.get('skipped', ''))}</td>
        </tr>"""

    # Equity curve data
    eq_labels = json.dumps([d["date"] for d in day_summaries])
    eq_data = []
    cum = 0
    for d in day_summaries:
        cum += d.get("pnl", 0)
        eq_data.append(round(cum, 2))
    eq_data_json = json.dumps(eq_data)

    # Drawdown per day
    dd_data = []
    dd_peak = 0
    dd_cum = 0
    for d in day_summaries:
        dd_cum += d.get("pnl", 0)
        if dd_cum > dd_peak:
            dd_peak = dd_cum
        dd_data.append(round(dd_cum - dd_peak, 2))
    dd_data_json = json.dumps(dd_data)

    # P&L distribution
    pnl_values = [t["pnl"] for t in trades]
    pnl_hist_labels = []
    pnl_hist_data = []
    pnl_hist_colors = []
    if pnl_values:
        min_pnl = min(pnl_values)
        max_pnl = max(pnl_values)
        bucket_size = max(25, int((max_pnl - min_pnl) / 10))
        start = int(min_pnl // bucket_size) * bucket_size
        end = int(max_pnl // bucket_size + 1) * bucket_size
        for b in range(start, end + bucket_size, bucket_size):
            count = sum(1 for p in pnl_values if b <= p < b + bucket_size)
            pnl_hist_labels.append(f"${b}")
            pnl_hist_data.append(count)
            pnl_hist_colors.append("rgba(57,217,138,0.6)" if b >= 0 else "rgba(255,107,107,0.6)")

    pnl_hist_labels_json = json.dumps(pnl_hist_labels)
    pnl_hist_data_json = json.dumps(pnl_hist_data)
    pnl_hist_colors_json = json.dumps(pnl_hist_colors)

    # MFE vs P&L scatter
    mfe_scatter = json.dumps([{"x": t["mfe_pct"], "y": t["pnl_pct"]} for t in trades])

    # Win/loss by exit reason
    reason_stats = {}
    for t in trades:
        r = t["exit_reason"].replace("_", " ")
        if r not in reason_stats:
            reason_stats[r] = {"count": 0, "pnl": 0, "wins": 0}
        reason_stats[r]["count"] += 1
        reason_stats[r]["pnl"] += t["pnl"]
        if t["pnl"] > 0:
            reason_stats[r]["wins"] += 1

    reason_rows = ""
    for r, s in sorted(reason_stats.items(), key=lambda x: -x[1]["count"]):
        wr = round(s["wins"] / s["count"] * 100) if s["count"] else 0
        pnl_color = "#39d98a" if s["pnl"] > 0 else "#ff6b6b"
        reason_rows += f"""<tr>
            <td>{r}</td><td>{s['count']}</td><td>{wr}%</td>
            <td style="color:{pnl_color}">${s['pnl']:+.0f}</td>
        </tr>"""

    # Settings display
    settings_rows = ""
    for k, v in settings.items():
        if isinstance(v, list):
            v = json.dumps(v)
        settings_rows += f"<tr><td class='muted'>{k}</td><td>{v}</td></tr>"

    # Win stats
    win_trades = [t for t in trades if t["pnl"] > 0]
    loss_trades = [t for t in trades if t["pnl"] <= 0]
    avg_win = sum(t["pnl"] for t in win_trades) / len(win_trades) if win_trades else 0
    avg_loss = sum(t["pnl"] for t in loss_trades) / len(loss_trades) if loss_trades else 0
    profit_factor = abs(sum(t["pnl"] for t in win_trades) / sum(t["pnl"] for t in loss_trades)) if loss_trades and sum(t["pnl"] for t in loss_trades) != 0 else 0

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Options Backtest — {summary['symbol']} {summary['start_date']} to {summary['end_date']}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #0f0f1a; color: #d1d4dc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }}
  h1 {{ color: #fff; font-size: 22px; margin-bottom: 4px; }}
  h2 {{ color: #ffd54f; font-size: 15px; margin: 24px 0 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px; }}
  .subtitle {{ color: #7c8190; font-size: 13px; margin-bottom: 16px; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }}
  .card {{ background: #1a1f2e; border: 1px solid #2b2b43; border-radius: 8px; padding: 14px; }}
  .card-full {{ grid-column: 1 / -1; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 11px; }}
  th {{ text-align: left; color: #7c8190; font-weight: 600; padding: 5px 6px; border-bottom: 1px solid #2b2b43; white-space: nowrap; }}
  td {{ padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); white-space: nowrap; }}
  .muted {{ color: #7c8190; }}
  .stat {{ text-align: center; }}
  .stat-value {{ font-size: 22px; font-weight: 700; color: #fff; }}
  .stat-label {{ font-size: 10px; color: #7c8190; margin-top: 2px; }}
  canvas {{ max-height: 250px; }}
  /* Don't cap the lightweight-charts canvases — they need to fill the resizable
     #priceChart container. The global cap above is for the Chart.js histograms. */
  #priceChart canvas {{ max-height: none !important; }}
  .insight {{ background: rgba(255,213,79,0.06); border-left: 3px solid #ffd54f; padding: 8px 12px; margin: 8px 0; font-size: 11px; border-radius: 0 6px 6px 0; }}
  .tf-btn {{ padding: 3px 10px; font-size: 11px; background: transparent; color: #7c8190; border: 1px solid #2b2b43; border-radius: 4px; cursor: pointer; }}
  .tf-btn.active {{ background: rgba(255,255,255,0.1); color: #fff; }}
  /* Trade detail modal */
  .modal-backdrop {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 9000; align-items: center; justify-content: center; }}
  .modal-backdrop.show {{ display: flex; }}
  .modal-card {{ background: #1a1d2b; border: 1px solid #2b2b43; border-radius: 8px; padding: 18px 20px; width: min(560px, 92vw); max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }}
  .modal-card h3 {{ margin: 0 0 6px; font-size: 16px; color: #fff; display: flex; align-items: center; gap: 10px; }}
  .modal-card h4 {{ margin: 14px 0 6px; font-size: 11px; color: #7c8190; text-transform: uppercase; letter-spacing: 0.06em; }}
  .modal-side-badge {{ font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 700; letter-spacing: 0.04em; }}
  .modal-side-entry {{ background: rgba(255,213,79,0.18); color: #ffd54f; }}
  .modal-side-exit  {{ background: rgba(124,77,255,0.18); color: #b39dff; }}
  .modal-close {{ float: right; background: transparent; border: none; color: #7c8190; font-size: 18px; cursor: pointer; padding: 0 4px; }}
  .modal-close:hover {{ color: #fff; }}
  .modal-grid {{ display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 12px; }}
  .modal-grid .lbl {{ color: #7c8190; }}
  .modal-grid .val {{ color: #fff; font-variant-numeric: tabular-nums; }}
  .modal-rationale {{ background: rgba(255,255,255,0.03); border-left: 3px solid #7c4dff; padding: 8px 12px; font-size: 12px; color: #cfd2dc; line-height: 1.5; border-radius: 0 4px 4px 0; }}
</style>
</head>
<body>
<h1>Options Backtest Report</h1>
<p class="subtitle">{summary['symbol']} &mdash; {summary['start_date']} to {summary['end_date']} &mdash; Real option premiums via Polygon.io</p>

<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value" style="color:{'#39d98a' if summary['total_pnl'] >= 0 else '#ff6b6b'}">${summary['total_pnl']:+.0f}</div>
    <div class="stat-label">Total P&L</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">{summary['total_trades']}</div>
    <div class="stat-label">Trades</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">{summary['win_rate']}%</div>
    <div class="stat-label">Win Rate</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">{"&infin;" if profit_factor == 0 and win_trades else f"{profit_factor:.1f}x"}</div>
    <div class="stat-label">Profit Factor</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">${avg_win:+.0f}</div>
    <div class="stat-label">Avg Win</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">${avg_loss:+.0f}</div>
    <div class="stat-label">Avg Loss</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">{summary['avg_hold_minutes']}m</div>
    <div class="stat-label">Avg Hold</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value">${sum(t.get('capital_used', 0) for t in trades if not t.get('skipped')):,.0f}</div>
    <div class="stat-label">Capital Deployed</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value" style="color:#ff6b6b">${summary.get('max_drawdown',0):+.0f}</div>
    <div class="stat-label">Max Drawdown</div>
  </div>
  <div class="card stat" style="flex:1;min-width:100px">
    <div class="stat-value" style="color:#f5a623">{summary.get('skipped_trades',0)}</div>
    <div class="stat-label">Skipped (${summary.get('skipped_pnl',0):+.0f})</div>
  </div>
</div>

<div class="grid">

<!-- Price Chart with Trade Markers -->
<div class="card card-full">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
    <h2 style="margin:0;border:none;padding:0">{summary['symbol']} Price Chart</h2>
    {"<label style=" + '"font-size:11px;color:#7c8190;display:flex;align-items:center;gap:4px;cursor:pointer"' + "><input type=" + '"checkbox"' + " id=" + '"showGex"' + " onchange=" + '"renderPriceChart()"' + " checked> GEX Zones</label>" if gex_zones else ""}
    <div style="display:flex;gap:4px;margin-left:auto">
      <button class="tf-btn" onclick="setTF('1m')">1m</button>
      <button class="tf-btn active" onclick="setTF('5m')">5m</button>
      <button class="tf-btn" onclick="setTF('15m')">15m</button>
      <button class="tf-btn" onclick="setTF('1h')">1h</button>
    </div>
  </div>
  <div id="priceChart" style="height:350px;min-height:200px;resize:vertical;overflow:hidden;border:1px solid #1f2333;border-radius:4px" title="Drag the bottom-right corner to resize"></div>
  {"<div style=" + '"font-size:10px;color:#7c8190;margin-top:6px;display:flex;gap:14px;flex-wrap:wrap"' + ">" +
   "<span><span style=" + '"color:#39d98a"' + ">&#9644;</span> LGN Support (buy calls)</span>" +
   "<span><span style=" + '"color:#ff6b6b"' + ">&#9644;</span> LGN Resistance (buy puts)</span>" +
   "<span><span style=" + '"color:#f5a623"' + ">- - -</span> SGN Take-Profit</span>" +
   "<span><span style=" + '"color:#7c4dff"' + ">- - -</span> Zero Gamma</span>" +
   "</div>" if gex_zones else ""}
</div>

<!-- Equity Curve + Drawdown -->
<div class="card card-full">
  <h2>Equity Curve &amp; Drawdown</h2>
  <canvas id="equityChart" height="80"></canvas>
</div>

<!-- P&L Distribution -->
<div class="card">
  <h2>P&L Distribution</h2>
  <canvas id="pnlHistChart"></canvas>
</div>

<!-- MFE vs P&L -->
<div class="card">
  <h2>MFE vs Realized P&L</h2>
  <canvas id="mfeChart"></canvas>
</div>

<!-- Exit Reason Breakdown -->
<div class="card">
  <h2>Exit Reason Performance</h2>
  <table>
    <tr><th>Reason</th><th>Count</th><th>Win %</th><th>P&L</th></tr>
    {reason_rows}
  </table>
</div>

<!-- Settings Used -->
<div class="card">
  <h2>Settings Used</h2>
  <table>
    {settings_rows}
  </table>
</div>

<!-- Day-by-Day -->
<div class="card card-full">
  <h2>Day-by-Day Summary</h2>
  <div class="insight">Signals = raw strategy detections. After Filter = passed chop filter. If many signals are filtered, try lowering DI gap or disabling the chop filter (Polygon data differs from IB).</div>
  <table>
    <tr><th>Date</th><th>Signals</th><th>After Filter</th><th>Trades</th><th>P&L</th><th>Cumulative</th><th>W</th><th>L</th><th>Notes</th></tr>
    {day_rows}
  </table>
</div>

<!-- All Trades -->
<div class="card card-full">
  <div style="display:flex;align-items:center;justify-content:space-between">
    <h2 style="margin:0">All Trades</h2>
    <label style="font-size:11px;color:#7c8190;display:flex;align-items:center;gap:4px;cursor:pointer">
      <input type="checkbox" id="hideSkipped" onchange="toggleSkipped()" checked> Hide skipped trades
    </label>
  </div>
  <table>
    <tr><th>Date</th><th>Contract</th><th>Qty</th><th>Capital</th><th>Strategy</th><th>Entry</th><th>Premium</th><th>Exit</th><th>Premium</th><th>P&L</th><th>P&L %</th><th>MFE</th><th>MAE</th><th>HWM</th><th>Hold</th><th>Exit Reason</th></tr>
    {trade_rows}
    <tr style="border-top:2px solid #ffd54f;font-weight:700;color:#fff">
      <td>TOTAL</td>
      <td>{len(trades)} trades</td>
      <td>{sum(t.get('quantity',1) for t in trades)}</td>
      <td>${sum(t.get('capital_used',0) for t in trades):.0f}</td>
      <td></td><td></td><td></td><td></td><td></td>
      <td style="color:{'#39d98a' if summary['total_pnl'] >= 0 else '#ff6b6b'}">${summary['total_pnl']:+.0f}</td>
      <td style="color:{'#39d98a' if summary['total_pnl'] >= 0 else '#ff6b6b'}">{summary['avg_pnl']:+.0f} avg</td>
      <td>+{summary['avg_mfe']:.1f}%</td>
      <td>{summary['avg_mae']:.1f}%</td>
      <td></td>
      <td>{summary['avg_hold_minutes']}m avg</td>
      <td>{len([t for t in trades if t['pnl']>0])}W / {len([t for t in trades if t['pnl']<=0])}L</td>
    </tr>
  </table>
</div>

</div>

<script>
Chart.defaults.color = '#7c8190';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

new Chart(document.getElementById('equityChart'), {{
  type: 'line',
  data: {{
    labels: {eq_labels},
    datasets: [{{
      label: 'Cumulative P&L ($)',
      data: {eq_data_json},
      borderColor: '#ffd54f',
      borderWidth: 2,
      fill: true,
      backgroundColor: 'rgba(255,213,79,0.08)',
      tension: 0.3,
      pointRadius: 3,
      yAxisID: 'y',
    }}, {{
      label: 'Drawdown ($)',
      data: {dd_data_json},
      borderColor: '#ff6b6b',
      borderWidth: 1.5,
      fill: true,
      backgroundColor: 'rgba(255,107,107,0.1)',
      tension: 0.3,
      pointRadius: 0,
      yAxisID: 'y2',
    }}]
  }},
  options: {{
    plugins: {{ legend: {{ labels: {{ font: {{ size: 10 }} }} }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }} }} }},
      y: {{ position: 'left', grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ callback: v => '$'+v }} }},
      y2: {{ position: 'right', grid: {{ display: false }}, ticks: {{ callback: v => '$'+v, color: '#ff6b6b', font: {{ size: 9 }} }} }}
    }}
  }}
}});

new Chart(document.getElementById('pnlHistChart'), {{
  type: 'bar',
  data: {{
    labels: {pnl_hist_labels_json},
    datasets: [{{ data: {pnl_hist_data_json}, backgroundColor: {pnl_hist_colors_json} }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }} }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ stepSize: 1 }} }}
    }}
  }}
}});

new Chart(document.getElementById('mfeChart'), {{
  type: 'scatter',
  data: {{
    datasets: [{{
      label: 'Trades',
      data: {mfe_scatter},
      backgroundColor: (ctx) => ctx.raw.y >= 0 ? '#39d98a' : '#ff6b6b',
      pointRadius: 5,
    }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ title: {{ display: true, text: 'MFE (%)' }}, grid: {{ color: 'rgba(255,255,255,0.04)' }} }},
      y: {{ title: {{ display: true, text: 'Realized P&L (%)' }}, grid: {{ color: 'rgba(255,255,255,0.04)' }} }}
    }}
  }}
}});

// ── Price Chart with Lightweight Charts ──
var _nyDateFmt = new Intl.DateTimeFormat('en-US', {{ timeZone: 'America/New_York', month: 'short', day: 'numeric' }});
var _nyTimeFmt = new Intl.DateTimeFormat('en-US', {{ timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }});
function fmtNyDate(t) {{ return _nyDateFmt.format(new Date(t * 1000)); }}
function fmtNyTime(t) {{ return _nyTimeFmt.format(new Date(t * 1000)); }}

var allBars = {{
  '1m': {chart_bars_json.get('1m', '[]')},
  '5m': {chart_bars_json.get('5m', '[]')},
  '15m': {chart_bars_json.get('15m', '[]')},
  '1h': {chart_bars_json.get('1h', '[]')},
}};
var tradeMarkers = {trade_markers};
var gexZones = {gex_zones_json};
var currentTF = '5m';

var priceContainer = document.getElementById('priceChart');
var priceChart = LightweightCharts.createChart(priceContainer, {{
  width: priceContainer.clientWidth,
  height: 350,
  layout: {{ background: {{ color: '#1a1f2e' }}, textColor: '#7c8190', fontSize: 10 }},
  grid: {{ vertLines: {{ color: 'rgba(255,255,255,0.04)' }}, horzLines: {{ color: 'rgba(255,255,255,0.04)' }} }},
  crosshair: {{ vertLine: {{ color: 'rgba(255,255,255,0.15)' }}, horzLine: {{ color: 'rgba(255,255,255,0.15)' }} }},
  rightPriceScale: {{ borderColor: '#2b2b43' }},
  timeScale: {{
    borderColor: '#2b2b43', timeVisible: true, secondsVisible: false,
    tickMarkFormatter: function(t, tickType) {{
      var ts = typeof t === 'number' ? t : Number(t);
      if (tickType === 0 || tickType === 1 || tickType === 2) return fmtNyDate(ts);
      return fmtNyTime(ts);
    }},
  }},
  localization: {{
    timeFormatter: function(t) {{
      var ts = typeof t === 'number' ? t : Number(t);
      return fmtNyDate(ts) + ', ' + fmtNyTime(ts);
    }},
  }},
}});

var candleSeries = priceChart.addCandlestickSeries({{
  upColor: '#39d98a', downColor: '#ff6b6b',
  borderUpColor: '#39d98a', borderDownColor: '#ff6b6b',
  wickUpColor: '#39d98a', wickDownColor: '#ff6b6b',
}});

function setTF(tf) {{
  currentTF = tf;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderPriceChart();
}}

function toggleSkipped() {{
  var hide = document.getElementById('hideSkipped').checked;
  document.querySelectorAll('.skipped-row').forEach(function(r) {{
    r.style.display = hide ? 'none' : '';
  }});
  renderPriceChart();
}}

function renderPriceChart() {{
  var bars = allBars[currentTF] || [];
  if (!bars.length) return;

  var hideSkipped = document.getElementById('hideSkipped') && document.getElementById('hideSkipped').checked;

  var candles = bars.map(b => ({{ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }}));
  candleSeries.setData(candles);

  // Remove old GEX price lines
  (window._gexLines || []).forEach(function(ln) {{ candleSeries.removePriceLine(ln); }});
  window._gexLines = [];

  // Draw GEX zones as horizontal price lines
  var showGex = document.getElementById('showGex') && document.getElementById('showGex').checked;
  if (showGex && gexZones.length > 0) {{
    var drawnStrikes = {{}};
    gexZones.forEach(function(z) {{
      var key = z.type + '_' + z.strike;
      if (drawnStrikes[key]) return;
      drawnStrikes[key] = true;

      var color, title, lineStyle, lineWidth;
      if (z.type === 'CALL_WALL') {{
        color = '#ff6b6b';
        title = 'Call Wall $' + z.strike;
        lineStyle = 0; // Solid
        lineWidth = 3;
      }} else if (z.type === 'PUT_WALL') {{
        color = '#39d98a';
        title = 'Put Wall $' + z.strike;
        lineStyle = 0; // Solid
        lineWidth = 3;
      }} else if (z.type === 'FLIP') {{
        color = '#7c4dff';
        title = 'Gamma Flip $' + z.strike;
        lineStyle = 2; // Dashed
        lineWidth = 2;
      }} else if (z.type === 'LGN') {{
        color = z.node_type === 'resistance' ? '#ff6b6b' : '#39d98a';
        title = (z.node_type === 'resistance' ? 'LGN Resist' : 'LGN Support') + ' $' + z.strike;
        lineStyle = 0; // Solid
        lineWidth = 2;
      }} else if (z.type === 'SGN') {{
        color = '#f5a623';
        title = 'SGN TP $' + z.strike;
        lineStyle = 2; // Dashed
        lineWidth = 1;
      }} else {{
        color = '#7c4dff';
        title = 'Zero Gamma $' + z.strike;
        lineStyle = 2;
        lineWidth = 2;
      }}
      var ln = candleSeries.createPriceLine({{
        price: z.strike,
        color: color,
        lineWidth: lineWidth,
        lineStyle: lineStyle,
        axisLabelVisible: true,
        title: title,
      }});
      window._gexLines.push(ln);
    }});
  }}

  // Build markers from trades
  var markers = [];
  tradeMarkers.forEach(function(t) {{
    var isSkipped = t.skipped || false;
    if (isSkipped && hideSkipped) return;

    var entryBar = bars.reduce((best, b) => Math.abs(b.t - t.entry_ts) < Math.abs(best.t - t.entry_ts) ? b : best, bars[0]);
    var isCall = t.direction === 'CALL';
    // Entry marker
    markers.push({{
      time: entryBar.t,
      position: isCall ? 'belowBar' : 'aboveBar',
      color: isSkipped ? '#f5a623' : '#ffd54f',
      shape: isCall ? 'arrowUp' : 'arrowDown',
      size: isSkipped ? 1 : 2,
      text: (isSkipped ? 'SKIP ' : 'BUY ') + t.right + t.strike + ' $' + t.entry_premium.toFixed(2),
    }});
    // Exit marker
    var exitBar = bars.reduce((best, b) => Math.abs(b.t - t.exit_ts) < Math.abs(best.t - t.exit_ts) ? b : best, bars[0]);
    var exitColor = isSkipped ? '#f5a623' : (t.pnl >= 0 ? '#39d98a' : '#ff6b6b');
    markers.push({{
      time: exitBar.t,
      position: isCall ? 'aboveBar' : 'belowBar',
      color: exitColor,
      shape: isSkipped ? 'square' : 'circle',
      size: isSkipped ? 1 : 2,
      text: 'EXIT $' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(0),
    }});
  }});
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
  priceChart.timeScale().fitContent();

  // Build a flat lookup of clickable marker timestamps → trade + side, so the
  // chart click handler can map a click time back to the originating trade.
  window._clickableMarkers = [];
  tradeMarkers.forEach(function(t) {{
    if (t.skipped && hideSkipped) return;
    window._clickableMarkers.push({{ time: t.entry_ts, side: 'entry', trade: t }});
    window._clickableMarkers.push({{ time: t.exit_ts,  side: 'exit',  trade: t }});
  }});
}}

renderPriceChart();
// Track both width and height so the user can stretch the chart vertically
// via the CSS resize handle in the bottom-right corner.
new ResizeObserver(entries => {{
  var rect = entries[0].contentRect;
  priceChart.applyOptions({{ width: rect.width, height: rect.height }});
}}).observe(priceContainer);

// ── Click-to-open trade modal ─────────────────────────────────────
// Per-strategy: friendly name + a function that builds rationale text from
// the actual signal metadata captured at detection time. Falls back to a
// generic description when metadata is absent (older trades).
function _money(x) {{ return (x == null || isNaN(x)) ? '—' : '$' + Number(x).toFixed(2); }}
function _delta(x) {{ if (x == null || isNaN(x)) return '—'; return (x >= 0 ? '+' : '') + '$' + Number(x).toFixed(2); }}

var S14_POSITION_LABEL = {{
  'above_call_wall': 'Position 2 — spot above Call Wall (gamma squeeze)',
  'below_put_wall':  'Position 3 — spot below Put Wall (free fall)',
  'between_walls':   'Position 1 — between walls, near a wall in this regime',
  'reclaim_pw':      'Position 4 — reclaiming the broken Put Wall',
}};

var STRATEGY_INFO = {{
  'strategy14_gamma_zero': {{
    name: 'S14 — Gamma Zero',
    generic: 'SPY 0DTE entry from price position vs Call Wall, Put Wall, and Gamma Flip.',
    build: function(t) {{
      var m = t.signal_metadata; if (!m) return this.generic;
      var posLabel = S14_POSITION_LABEL[m.position] || m.position || '—';
      var lines = [];
      lines.push('<b>' + posLabel + '</b> &middot; regime <b>' + (m.regime || '—') + '</b>');
      lines.push('<b>Direction:</b> ' + t.direction + ' &middot; <b>spot at signal:</b> ' + _money(m.spot_at_signal));
      lines.push(
        '<b>Walls:</b> CW ' + _money(m.call_wall) + ' (Δ ' + _delta(m.dist_to_call_wall) + ')' +
        ' &middot; PW ' + _money(m.put_wall) + ' (Δ ' + _delta(m.dist_to_put_wall) + ')' +
        ' &middot; Flip ' + _money(m.gamma_flip) + ' (Δ ' + _delta(m.dist_to_flip) + ')'
      );
      // Specific reasoning per position
      var why;
      if (m.position === 'above_call_wall') {{
        why = 'Spot broke above the Call Wall — dealers must buy to re-hedge, accelerating the move up. CALL bias.';
      }} else if (m.position === 'below_put_wall') {{
        why = 'Spot broke below the Put Wall — no mechanical floor remains; downside likely amplified. PUT bias.';
      }} else if (m.position === 'between_walls' && m.regime === 'POSITIVE_GAMMA') {{
        why = (t.direction === 'CALL')
          ? 'Sticky positive-gamma regime; spot bounced from near the Put Wall — dealers buy dips here.'
          : 'Sticky positive-gamma regime; spot rejected near the Call Wall — dealers sell rallies here.';
      }} else if (m.position === 'between_walls' && m.regime === 'NEGATIVE_GAMMA') {{
        why = 'Negative-gamma between walls — bearish bias; entered PUT on rejection near Call Wall.';
      }} else if (m.position === 'reclaim_pw') {{
        why = 'Broken Put Wall reclaimed with a confirmed 5m bullish reversal candle and above-average volume.';
      }} else {{
        why = this.generic;
      }}
      lines.push('<b>Why:</b> ' + why);
      lines.push('<span style="color:#7c8190;font-size:11px">Thresholds in effect: wallProximity ' + ((m.wall_proximity_pct||0)*100).toFixed(3) + '% &middot; gammaZeroBuffer ±' + ((m.gamma_zero_buffer_pct||0)*100).toFixed(3) + '%</span>');
      return lines.join('<br>');
    }}
  }},
  'strategy12_gex_mean_reversion': {{
    name: 'S12 — GEX Mean Reversion',
    generic: 'Mean reversion at long-gamma nodes. PUT at +GEX node (resistance), CALL at −GEX node (support). TP at the nearest short-gamma node.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy13_opening_direction': {{
    name: 'S13 — Opening Direction Confirmation',
    generic: 'Watches the 9:30–10:00 range, then confirms a directional break with N consecutive 5m bars closing outside the range.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy7_0dte_scalper': {{
    name: 'S7 — 0DTE Scalper',
    generic: 'Short-hold momentum scalp on 1m bars during 9:30–14:00. Requires consecutive directional bars + volume spike.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy8_0dte_momentum': {{
    name: 'S8 — 0DTE Momentum Rider',
    generic: 'RSI-confirmed momentum continuation on 5m bars; trails behind a high-water mark.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy9_0dte_gap_fade': {{
    name: 'S9 — 0DTE Gap Fade',
    generic: 'Fades the opening gap once the 1m price moves toward gap fill and the 15m bar shows reversal. Entry window 10:00–14:00.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy10_0dte_trend': {{
    name: 'S10 — 0DTE Trend Following',
    generic: 'Trades with a confirmed multi-bar trend in the 9:45–13:00 window. Uses RSI bands to qualify continuation setups.',
    build: function(t) {{ return this.generic; }}
  }},
  'strategy11_0dte_ict': {{
    name: 'S11 — 0DTE ICT Price Action',
    generic: 'ICT-style entry: liquidity sweep + market structure shift + (optional) FVG. Risk-reward filtered.',
    build: function(t) {{ return this.generic; }}
  }}
}};

function strategyInfo(strategyId) {{
  var fallback = {{ name: strategyId || '—', generic: 'No description available.', build: function(t){{ return this.generic; }} }};
  if (!strategyId) return fallback;
  if (STRATEGY_INFO[strategyId]) return STRATEGY_INFO[strategyId];
  var m = strategyId.match(/^(strategy[_-]?\d+)/);
  if (m) {{
    for (var k in STRATEGY_INFO) {{ if (k.indexOf(m[1]) === 0) return STRATEGY_INFO[k]; }}
  }}
  return fallback;
}}

function tsToET(ts) {{
  if (!ts) return '—';
  var d = new Date(ts * 1000);
  return d.toLocaleString('en-US', {{ timeZone: 'America/New_York', hour12: false }});
}}

function showTradeModal(trade, side) {{
  var info = strategyInfo(trade.strategy_id);
  var pnlColor = trade.pnl >= 0 ? '#39d98a' : '#ff6b6b';
  var dirColor = trade.direction === 'CALL' ? '#39d98a' : '#ff6b6b';
  var sideLabel = side === 'entry' ? 'ENTRY' : 'EXIT';
  var sideClass = side === 'entry' ? 'modal-side-entry' : 'modal-side-exit';
  var contractStr = (trade.right || '') + (trade.strike != null ? Math.round(trade.strike) : '');

  var html =
    '<button class="modal-close" onclick="closeTradeModal()" aria-label="Close">&times;</button>' +
    '<h3>' +
      '<span style="color:' + dirColor + '">' + (trade.direction === 'CALL' ? '&#9650;' : '&#9660;') + ' ' + contractStr + '</span>' +
      '<span class="modal-side-badge ' + sideClass + '">' + sideLabel + '</span>' +
      '<span style="margin-left:auto;color:' + pnlColor + ';font-weight:700">' +
        (trade.pnl >= 0 ? '+' : '') + '$' + trade.pnl.toFixed(0) +
        ' (' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct.toFixed(1) + '%)' +
      '</span>' +
    '</h3>' +
    '<div style="font-size:11px;color:#7c8190;margin-bottom:10px">' + info.name + ' &middot; ' + (trade.date || '—') + (trade.skipped ? ' &middot; <span style="color:#f5a623">SKIPPED</span>' : '') + '</div>' +

    '<h4>Why this trade</h4>' +
    '<div class="modal-rationale">' + info.build(trade) + '</div>' +

    '<h4>Trade</h4>' +
    '<div class="modal-grid">' +
      '<span class="lbl">Direction</span><span class="val" style="color:' + dirColor + '">' + trade.direction + ' (' + trade.right + ')</span>' +
      '<span class="lbl">Strike</span><span class="val">$' + (trade.strike != null ? trade.strike.toFixed(0) : '—') + '</span>' +
      '<span class="lbl">Quantity</span><span class="val">' + (trade.quantity || 1) + '</span>' +
      '<span class="lbl">Capital used</span><span class="val">$' + (trade.capital_used || 0).toFixed(0) + '</span>' +
      '<span class="lbl">Strategy ID</span><span class="val" style="font-family:monospace;font-size:11px">' + (trade.strategy_id || '—') + '</span>' +
      (trade.signal_id ? '<span class="lbl">Signal ID</span><span class="val" style="font-family:monospace;font-size:11px">' + trade.signal_id + '</span>' : '') +
    '</div>' +

    '<h4>Entry</h4>' +
    '<div class="modal-grid">' +
      '<span class="lbl">Time (ET)</span><span class="val">' + (trade.entry_time || tsToET(trade.entry_ts)) + '</span>' +
      '<span class="lbl">Premium</span><span class="val">$' + trade.entry_premium.toFixed(2) + '</span>' +
    '</div>' +

    '<h4>Exit</h4>' +
    '<div class="modal-grid">' +
      '<span class="lbl">Time (ET)</span><span class="val">' + (trade.exit_time || tsToET(trade.exit_ts)) + '</span>' +
      '<span class="lbl">Premium</span><span class="val">$' + trade.exit_premium.toFixed(2) + '</span>' +
      '<span class="lbl">Reason</span><span class="val">' + (trade.exit_reason || '—') + '</span>' +
      '<span class="lbl">Hold time</span><span class="val">' + (trade.hold_minutes || 0) + ' min</span>' +
    '</div>' +

    '<h4>P&amp;L Path</h4>' +
    '<div class="modal-grid">' +
      '<span class="lbl">Realized</span><span class="val" style="color:' + pnlColor + ';font-weight:600">' + (trade.pnl >= 0 ? '+' : '') + '$' + trade.pnl.toFixed(0) + ' (' + (trade.pnl_pct >= 0 ? '+' : '') + trade.pnl_pct.toFixed(1) + '%)</span>' +
      '<span class="lbl">Max favorable (MFE)</span><span class="val" style="color:#39d98a">+' + trade.mfe_pct.toFixed(1) + '%</span>' +
      '<span class="lbl">Max adverse (MAE)</span><span class="val" style="color:#ff6b6b">' + trade.mae_pct.toFixed(1) + '%</span>' +
      '<span class="lbl">High-water mark</span><span class="val">$' + (trade.hwm || 0).toFixed(2) + '</span>' +
    '</div>' +

    (trade.skipped && trade.skip_reason ? '<h4>Skip reason</h4><div class="modal-rationale" style="border-left-color:#f5a623">' + trade.skip_reason + '</div>' : '');

  document.getElementById('modalCard').innerHTML = html;
  document.getElementById('tradeModal').classList.add('show');
}}

function closeTradeModal() {{
  document.getElementById('tradeModal').classList.remove('show');
}}

// Click handler — find the marker (entry or exit) closest in time to the click,
// disambiguate using vertical position (above/below bar), and open the modal.
priceChart.subscribeClick(function(param) {{
  if (!param.time || !window._clickableMarkers || window._clickableMarkers.length === 0) return;
  var clickTime = param.time;
  // Find any markers within 4 minutes of the click
  var candidates = window._clickableMarkers.filter(function(m) {{
    return Math.abs(m.time - clickTime) <= 240;
  }});
  if (candidates.length === 0) return;
  // Pick the closest in time
  candidates.sort(function(a, b) {{ return Math.abs(a.time - clickTime) - Math.abs(b.time - clickTime); }});
  showTradeModal(candidates[0].trade, candidates[0].side);
}});

// Esc to close, click backdrop to close
document.addEventListener('keydown', function(e) {{ if (e.key === 'Escape') closeTradeModal(); }});
document.getElementById('tradeModal').addEventListener('click', function(e) {{
  if (e.target.id === 'tradeModal') closeTradeModal();
}});
</script>

<!-- Trade detail modal (populated by showTradeModal) -->
<div id="tradeModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalCard">
  <div id="modalCard" class="modal-card"></div>
</div>
</body>
</html>"""
