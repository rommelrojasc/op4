"""Generate a comprehensive daily HTML report for the auto trader."""
import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")
DATA_DIR = Path(__file__).resolve().parents[2] / "data"


def _load_today_data(date_str: Optional[str] = None) -> Dict[str, Any]:
    """Load all data for a specific day."""
    if date_str:
        target = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=NY)
    else:
        target = datetime.now(NY)

    day_start = int(target.replace(hour=0, minute=0, second=0).timestamp())
    day_end = int((target + timedelta(days=1)).replace(hour=0, minute=0, second=0).timestamp())

    # Trade log
    trades = []
    trade_log = DATA_DIR / "trade_log.jsonl"
    if trade_log.exists():
        for line in trade_log.read_text().strip().splitlines():
            if not line.strip():
                continue
            e = json.loads(line)
            if day_start <= e.get("timestamp", 0) <= day_end and e.get("symbol") == "SPY":
                trades.append(e)

    # Activity log
    di_blocks = 0
    adx_blocks = 0
    spy_prices = []
    key_events = []
    activity_log = DATA_DIR / "auto_trader_activity.jsonl"
    if activity_log.exists():
        for line in activity_log.read_text().strip().splitlines():
            if not line.strip():
                continue
            e = json.loads(line)
            if day_start <= e.get("timestamp", 0) <= day_end:
                t = e["type"]
                d = e.get("details", {})
                if t == "scan_context" and "spy_price" in d:
                    spy_prices.append({"ts": e["timestamp"], "price": d["spy_price"], "dir": d.get("spy_direction", "")})
                if t == "di_gap_chop_filter":
                    di_blocks += 1
                if t == "adx_chop_filter":
                    adx_blocks += 1

    # Snapshots
    snapshots = []
    snap_file = DATA_DIR / "option_chain_snapshots.jsonl"
    if snap_file.exists():
        for line in snap_file.read_text().strip().splitlines():
            if not line.strip():
                continue
            s = json.loads(line)
            if day_start <= s.get("timestamp", 0) <= day_end:
                snapshots.append(s)

    # Pair opens and closes
    opens = {t["signal_id"]: t for t in trades if t.get("type") == "OPEN"}
    closes = [t for t in trades if t.get("type") == "CLOSE"]

    # Match snapshots to trades
    entry_snaps = {s["signal_id"]: s for s in snapshots if s.get("type") == "entry"}
    exit_snaps = {s["signal_id"]: s for s in snapshots if s.get("type") == "exit"}

    return {
        "date": target.strftime("%Y-%m-%d"),
        "trades": trades,
        "opens": opens,
        "closes": closes,
        "entry_snaps": entry_snaps,
        "exit_snaps": exit_snaps,
        "spy_prices": spy_prices,
        "di_blocks": di_blocks,
        "adx_blocks": adx_blocks,
    }


def generate_daily_report(date_str: Optional[str] = None) -> str:
    """Generate HTML daily report."""
    data = _load_today_data(date_str)
    date_display = data["date"]
    opens = data["opens"]
    closes = data["closes"]
    entry_snaps = data["entry_snaps"]
    exit_snaps = data["exit_snaps"]
    spy_prices = data["spy_prices"]
    di_blocks = data["di_blocks"]
    adx_blocks = data["adx_blocks"]

    # Trade summary
    total_pnl = sum((c.get("pnl") or 0) for c in closes)
    wins = [c for c in closes if (c.get("pnl") or 0) > 0]
    losses = [c for c in closes if (c.get("pnl") or 0) <= 0]

    # Trade rows
    trade_rows = ""
    for c in closes:
        o = opens.get(c.get("signal_id"), {})
        entry_ts = datetime.fromtimestamp(o.get("timestamp", 0), NY).strftime("%H:%M") if o else "?"
        exit_ts = datetime.fromtimestamp(c.get("timestamp", 0), NY).strftime("%H:%M")
        pnl = c.get("pnl", 0) or 0
        pnl_pct = (c.get("pnl_pct", 0) or 0) * 100
        mfe = (c.get("mfe_pct") or 0) * 100
        mae = (c.get("mae_pct") or 0) * 100
        hold = (c["timestamp"] - o.get("timestamp", c["timestamp"])) // 60
        pnl_color = "#39d98a" if pnl > 0 else "#ff6b6b"
        right = o.get("right", "?")
        strike = o.get("strike", "?")
        contract = f"{right}{strike}"
        direction = "&#9650;" if right == "C" else "&#9660;"
        dir_color = "#39d98a" if right == "C" else "#ff6b6b"
        reason = (c.get("close_reason") or "?")[:50]

        trade_rows += f"""<tr>
            <td style="color:{dir_color}">{direction} {contract}</td>
            <td>{entry_ts}</td><td>${o.get('price',0):.2f}</td>
            <td>{exit_ts}</td><td>${c.get('price',0):.2f}</td>
            <td style="color:{pnl_color};font-weight:700">${pnl:+.0f}</td>
            <td style="color:{pnl_color}">{pnl_pct:+.1f}%</td>
            <td>+{mfe:.1f}%</td><td>{mae:.1f}%</td>
            <td>{hold}m</td><td class="muted">{reason}</td>
        </tr>"""

    # Snapshot analysis rows
    snap_html = ""
    for c in closes:
        sig_id = c.get("signal_id", "")
        o = opens.get(sig_id, {})
        es = entry_snaps.get(sig_id, {})
        xs = exit_snaps.get(sig_id, {})
        if not es:
            continue
        right = o.get("right", "?")
        strike = o.get("strike", "?")
        pnl = c.get("pnl", 0) or 0
        pnl_color = "#39d98a" if pnl > 0 else "#ff6b6b"

        # Entry details
        regime = es.get("market_regime", {})
        chop = es.get("chop_filter", {})

        snap_html += f"""
        <div style="background:#161b28;border:1px solid #2b2b43;border-radius:8px;padding:14px;margin:10px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-weight:700;color:#fff">{right}{strike}</span>
            <span style="color:{pnl_color};font-weight:700;font-size:16px">${pnl:+.0f}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <div style="font-size:11px;color:#ffd54f;font-weight:600;margin-bottom:6px">Entry Context</div>
              <table class="snap-tbl">
                <tr><td>Underlying</td><td>${es.get('underlying_price','?')}</td></tr>
                <tr><td>Delta</td><td>{es.get('selected_delta',0):.3f}</td></tr>
                <tr><td>Bid/Ask</td><td>${es.get('selected_bid','?')} / ${es.get('selected_ask','?')}</td></tr>
                <tr><td>Fill vs Mid</td><td>${(es.get('selected_premium',0) - (es.get('selected_mid') or es.get('selected_premium',0))):.2f}</td></tr>
                <tr><td>Distance OTM</td><td>${es.get('distance_from_underlying',0):.2f}</td></tr>
                <tr><td>Signal Age</td><td>{es.get('signal_age_secs',0)//60}m {es.get('signal_age_secs',0)%60}s</td></tr>
                <tr><td>Min to Close</td><td>{es.get('minutes_to_close','?')}</td></tr>
                <tr><td>ADX / DI gap</td><td>{es.get('adx','?')} / {es.get('di_gap','?')}</td></tr>
                <tr><td>Momentum 5m</td><td>${es.get('momentum_5m','?')}</td></tr>
                <tr><td>Momentum 15m</td><td>${es.get('momentum_15m','?')}</td></tr>
              </table>
            </div>
            <div>
              <div style="font-size:11px;color:#ffd54f;font-weight:600;margin-bottom:6px">Exit Context</div>
              <table class="snap-tbl">
                <tr><td>Underlying</td><td>${xs.get('underlying_price','?')}</td></tr>
                <tr><td>Delta</td><td>{f"{xs['exit_delta']:.3f}" if xs.get('exit_delta') else '?'}</td></tr>
                <tr><td>Gamma</td><td>{f"{xs['exit_gamma']:.4f}" if xs.get('exit_gamma') else '?'}</td></tr>
                <tr><td>Theta</td><td>{f"{xs['exit_theta']:.4f}" if xs.get('exit_theta') else '?'}</td></tr>
                <tr><td>Exit Bid/Ask</td><td>${xs.get('exit_bid','?')} / ${xs.get('exit_ask','?')}</td></tr>
                <tr><td>Exit Slippage</td><td>${xs.get('exit_slippage','?')}</td></tr>
                <tr><td>HWM</td><td>${xs.get('high_water_mark','?')}</td></tr>
                <tr><td>ADX / DI gap</td><td>{xs.get('adx','?')} / {xs.get('di_gap','?')}</td></tr>
                <tr><td>Hold Time</td><td>{(xs.get('hold_time_secs',0) or 0)//60}m</td></tr>
                <tr><td>Momentum 5m</td><td>${xs.get('momentum_5m','?')}</td></tr>
              </table>
            </div>
          </div>
          <div style="margin-top:8px">
            <div style="font-size:11px;color:#ffd54f;font-weight:600;margin-bottom:4px">Market Regime at Entry</div>
            <div style="font-size:11px;display:flex;gap:12px;flex-wrap:wrap;color:#9ca3af">
              <span>Range: ${regime.get('day_range','?')}</span>
              <span>VWAP: ${regime.get('vwap','?')}</span>
              <span>vs VWAP: ${regime.get('price_vs_vwap','?')}</span>
              <span>Gap: {regime.get('gap_pct','?')}%</span>
              <span>Volume: {(regime.get('day_volume') or 0)/1e6:.1f}M</span>
            </div>
          </div>
          <div style="margin-top:6px">
            <div style="font-size:11px;color:#ffd54f;font-weight:600;margin-bottom:4px">Chop Filter</div>
            <div style="font-size:11px;color:#9ca3af">
              Consecutive blocks: {chop.get('consecutive_blocks',0)} | Blocked duration: {chop.get('blocked_duration_secs',0)}s
            </div>
          </div>
        </div>"""

    # SPY price chart data
    price_labels = json.dumps([datetime.fromtimestamp(p["ts"], NY).strftime("%H:%M") for p in spy_prices[::30]])
    price_data = json.dumps([p["price"] for p in spy_prices[::30]])

    # Trade markers for price chart
    trade_markers_data = []
    for c in closes:
        o = opens.get(c.get("signal_id"), {})
        if o:
            trade_markers_data.append({
                "entry_ts": o["timestamp"],
                "exit_ts": c["timestamp"],
                "right": o.get("right", "?"),
                "strike": o.get("strike", 0),
                "entry_price": o.get("price", 0),
                "pnl": c.get("pnl", 0) or 0,
            })

    # P&L waterfall data
    pnl_labels = []
    pnl_values = []
    pnl_colors = []
    cum = 0
    for c in closes:
        o = opens.get(c.get("signal_id"), {})
        right = o.get("right", "?")
        strike = o.get("strike", "?")
        pnl = c.get("pnl", 0) or 0
        cum += pnl
        pnl_labels.append(f"{right}{strike}")
        pnl_values.append(pnl)
        pnl_colors.append("rgba(57,217,138,0.7)" if pnl > 0 else "rgba(255,107,107,0.7)")
    pnl_labels.append("NET")
    pnl_values.append(total_pnl)
    pnl_colors.append("#ffd54f" if total_pnl > 0 else "#ff6b6b")

    # Running tally - load recent trades
    tally_rows = ""
    recent_days = defaultdict(float)
    if (DATA_DIR / "trade_log.jsonl").exists():
        cutoff = int((datetime.now(NY) - timedelta(days=30)).timestamp())
        for line in (DATA_DIR / "trade_log.jsonl").read_text().strip().splitlines():
            if not line.strip():
                continue
            e = json.loads(line)
            if e.get("timestamp", 0) >= cutoff and e.get("type") == "CLOSE" and e.get("symbol") == "SPY":
                day = datetime.fromtimestamp(e["timestamp"], NY).strftime("%Y-%m-%d")
                recent_days[day] += (e.get("pnl") or 0)

    cum_pnl = 0
    tally_labels = []
    tally_data = []
    for day in sorted(recent_days.keys())[-15:]:
        pnl = recent_days[day]
        cum_pnl += pnl
        pnl_color = "#39d98a" if pnl > 0 else "#ff6b6b" if pnl < 0 else "#7c8190"
        tally_rows += f'<tr><td>{day}</td><td style="color:{pnl_color}">${pnl:+.0f}</td><td>${cum_pnl:+.0f}</td></tr>'
        tally_labels.append(day[-5:])
        tally_data.append(round(cum_pnl, 2))

    tally_labels_json = json.dumps(tally_labels)
    tally_data_json = json.dumps(tally_data)

    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily Report — {date_display}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ background:#0f0f1a; color:#d1d4dc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:20px; max-width:1100px; margin:0 auto; }}
  h1 {{ color:#fff; font-size:22px; margin-bottom:4px; }}
  h2 {{ color:#ffd54f; font-size:15px; margin:28px 0 10px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:5px; }}
  .sub {{ color:#7c8190; font-size:12px; margin-bottom:16px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }}
  .card {{ background:#1a1f2e; border:1px solid #2b2b43; border-radius:8px; padding:14px; }}
  .card-full {{ grid-column:1/-1; }}
  table {{ width:100%; border-collapse:collapse; font-size:11px; }}
  th {{ text-align:left; color:#7c8190; font-weight:600; padding:5px 6px; border-bottom:1px solid #2b2b43; }}
  td {{ padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.04); }}
  .muted {{ color:#7c8190; }}
  .stat {{ text-align:center; }}
  .stat-value {{ font-size:22px; font-weight:700; color:#fff; }}
  .stat-label {{ font-size:10px; color:#7c8190; margin-top:2px; }}
  canvas {{ max-height:250px; }}
  .snap-tbl {{ font-size:11px; }}
  .snap-tbl td {{ padding:2px 6px; border:none; }}
  .snap-tbl td:first-child {{ color:#7c8190; }}
  .insight {{ background:rgba(255,213,79,0.06); border-left:3px solid #ffd54f; padding:8px 12px; margin:8px 0; font-size:11px; border-radius:0 6px 6px 0; }}
  .tag {{ display:inline-block; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600; margin:0 2px; }}
  .tag-green {{ background:rgba(57,217,138,0.15); color:#39d98a; }}
  .tag-red {{ background:rgba(255,107,107,0.15); color:#ff6b6b; }}
</style></head><body>

<h1>Daily Auto Trader Report</h1>
<p class="sub">SPY &mdash; {date_display} &mdash; {len(closes)} trades &mdash; Net P&L: <span style="color:{'#39d98a' if total_pnl >= 0 else '#ff6b6b'};font-weight:700">${total_pnl:+.0f}</span></p>

<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value" style="color:{'#39d98a' if total_pnl >= 0 else '#ff6b6b'}">${total_pnl:+.0f}</div>
    <div class="stat-label">Net P&L</div>
  </div>
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value">{len(closes)}</div>
    <div class="stat-label">Trades</div>
  </div>
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value">{len(wins)}W / {len(losses)}L</div>
    <div class="stat-label">Win/Loss</div>
  </div>
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value">{di_blocks}</div>
    <div class="stat-label">DI Blocks</div>
  </div>
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value">{adx_blocks}</div>
    <div class="stat-label">ADX Blocks</div>
  </div>
  <div class="card stat" style="flex:1;min-width:90px">
    <div class="stat-value">${spy_prices[0]['price']:.0f}-{spy_prices[-1]['price']:.0f}</div>
    <div class="stat-label">SPY Range</div>
  </div>
</div>

<div class="grid">

<!-- Trade Summary -->
<div class="card card-full">
  <h2 style="margin-top:0">1. Trade Summary</h2>
  <table>
    <tr><th>Contract</th><th>Entry</th><th>Premium</th><th>Exit</th><th>Premium</th><th>P&L</th><th>P&L%</th><th>MFE</th><th>MAE</th><th>Hold</th><th>Reason</th></tr>
    {trade_rows}
  </table>
</div>

<!-- P&L Waterfall -->
<div class="card">
  <h2 style="margin-top:0">P&L Breakdown</h2>
  <canvas id="pnlChart"></canvas>
</div>

<!-- SPY Price -->
<div class="card">
  <h2 style="margin-top:0">SPY Price Action</h2>
  <canvas id="priceChart"></canvas>
</div>

<!-- Snapshot Analysis -->
<div class="card card-full">
  <h2 style="margin-top:0">2. Snapshot Analysis</h2>
  {snap_html if snap_html else '<p class="muted">No snapshots recorded today.</p>'}
</div>

<!-- Filter Performance -->
<div class="card">
  <h2 style="margin-top:0">3. Filter Performance</h2>
  <table>
    <tr><td>DI Gap blocks</td><td><b>{di_blocks}</b></td></tr>
    <tr><td>ADX blocks</td><td><b>{adx_blocks}</b></td></tr>
    <tr><td>Total blocks</td><td><b>{di_blocks + adx_blocks}</b></td></tr>
  </table>
  {'<div class="insight">DI gap filter is disabled (threshold=0). Re-enable with threshold 8-10 for better loss avoidance.</div>' if di_blocks == 0 and adx_blocks == 0 else ''}
</div>

<!-- Running Tally -->
<div class="card">
  <h2 style="margin-top:0">7. Cumulative P&L</h2>
  <canvas id="tallyChart"></canvas>
</div>

<!-- Tally Table -->
<div class="card card-full">
  <h2 style="margin-top:0">Running Tally (Last 15 Days)</h2>
  <table>
    <tr><th>Date</th><th>P&L</th><th>Cumulative</th></tr>
    {tally_rows}
  </table>
</div>

</div><!-- grid -->

<script>
Chart.defaults.color = '#7c8190';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

// P&L Waterfall
new Chart(document.getElementById('pnlChart'), {{
  type: 'bar',
  data: {{
    labels: {json.dumps(pnl_labels)},
    datasets: [{{ data: {json.dumps(pnl_values)}, backgroundColor: {json.dumps(pnl_colors)} }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ grid: {{ display: false }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ callback: v => '$'+v }} }}
    }}
  }}
}});

// SPY Price
new Chart(document.getElementById('priceChart'), {{
  type: 'line',
  data: {{
    labels: {price_labels},
    datasets: [{{
      label: 'SPY',
      data: {price_data},
      borderColor: '#ffd54f', borderWidth: 1.5, fill: false, tension: 0.3, pointRadius: 0,
    }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 9 }}, maxTicksLimit: 12 }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }} }}
    }}
  }}
}});

// Cumulative Tally
new Chart(document.getElementById('tallyChart'), {{
  type: 'line',
  data: {{
    labels: {tally_labels_json},
    datasets: [{{
      label: 'Cumulative P&L',
      data: {tally_data_json},
      borderColor: '#ffd54f', borderWidth: 2, fill: true,
      backgroundColor: 'rgba(255,213,79,0.08)', tension: 0.3, pointRadius: 3,
    }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 9 }} }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ callback: v => '$'+v }} }}
    }}
  }}
}});
</script>
</body></html>"""
