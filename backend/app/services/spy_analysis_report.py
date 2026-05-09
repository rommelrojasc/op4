"""Generate a comprehensive SPY options analysis HTML report using live IB data."""
import asyncio
import json
import logging
import math
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.ib.market_data import get_historical_bars
from app.services.ib.options_data import get_option_chain, get_option_quotes

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


async def _fetch_data() -> Dict[str, Any]:
    """Fetch all data needed for the report from IB."""
    symbol = "SPY"

    bars_1m, bars_5m, bars_15m, bars_1d = await asyncio.gather(
        get_historical_bars(symbol, "1m", 2000, use_rth=True),
        get_historical_bars(symbol, "5m", 600, use_rth=True),
        get_historical_bars(symbol, "15m", 500, use_rth=True),
        get_historical_bars(symbol, "1d", 60, use_rth=True),
    )

    # Current price
    spot = bars_1m[-1]["close"] if bars_1m else 0

    # Option chain for 0DTE (today) and next expiry
    chain_list = await get_option_chain(symbol)
    today_str = datetime.now(NY).strftime("%Y-%m-%d")

    # Find 0DTE or nearest expiration
    target_exp = None
    target_strikes = []
    for entry in chain_list:
        if entry["date"] >= today_str:
            target_exp = entry["date"]
            target_strikes = entry["strikes"]
            break
    if not target_exp and chain_list:
        target_exp = chain_list[-1]["date"]
        target_strikes = chain_list[-1]["strikes"]

    # Get strikes within $15 of spot
    near_strikes = sorted([s for s in target_strikes if abs(s - spot) <= 15])

    # Fetch quotes for all near-money strikes (returns both calls and puts)
    call_quotes, put_quotes = [], []
    if target_exp and near_strikes:
        all_quotes = await get_option_quotes(symbol, target_exp, near_strikes)
        call_quotes = [q for q in all_quotes if q.get("right") == "C"]
        put_quotes = [q for q in all_quotes if q.get("right") == "P"]

    return {
        "symbol": symbol,
        "spot": spot,
        "bars_1m": bars_1m,
        "bars_5m": bars_5m,
        "bars_15m": bars_15m,
        "bars_1d": bars_1d,
        "expiration": target_exp,
        "call_quotes": call_quotes,
        "put_quotes": put_quotes,
        "near_strikes": near_strikes,
        "generated_at": datetime.now(NY).strftime("%Y-%m-%d %H:%M:%S ET"),
    }


def _group_bars_by_day(bars: list) -> Dict[str, list]:
    days = {}
    for b in bars:
        day = datetime.fromtimestamp(b["time"], NY).strftime("%Y-%m-%d")
        days.setdefault(day, []).append(b)
    return days


def _analysis_entry_timing(bars_1m: list) -> Dict[str, Any]:
    """Analyze which 30-min window produces the strongest directional moves."""
    days = _group_bars_by_day(bars_1m)
    # For each 30-min window, compute avg absolute move
    window_moves = defaultdict(list)
    for day, dbars in days.items():
        if len(dbars) < 30:
            continue
        for i in range(0, len(dbars) - 5, 5):  # 5-min steps
            dt = datetime.fromtimestamp(dbars[i]["time"], NY)
            window_key = f"{dt.hour:02d}:{(dt.minute // 30) * 30:02d}"
            window_bars = dbars[i:i + 30]  # next 30 bars (30 min)
            if len(window_bars) < 10:
                continue
            move = abs(window_bars[-1]["close"] - window_bars[0]["open"])
            direction = window_bars[-1]["close"] - window_bars[0]["open"]
            window_moves[window_key].append({"move": move, "direction": direction})

    results = []
    for window, moves in sorted(window_moves.items()):
        avg_move = sum(m["move"] for m in moves) / len(moves)
        bullish = sum(1 for m in moves if m["direction"] > 0)
        bearish = len(moves) - bullish
        avg_dir = sum(m["direction"] for m in moves) / len(moves)
        results.append({
            "window": window,
            "avg_move": round(avg_move, 3),
            "avg_direction": round(avg_dir, 3),
            "bullish_pct": round(bullish / len(moves) * 100),
            "samples": len(moves),
        })
    return {"windows": results}


def _analysis_iv_skew(call_quotes: list, put_quotes: list, spot: float) -> Dict[str, Any]:
    """Map IV across strikes for the current expiration."""
    calls = []
    for q in sorted(call_quotes, key=lambda x: x["strike"]):
        if q.get("iv") and q["iv"] > 0:
            calls.append({
                "strike": q["strike"],
                "iv": round(q["iv"] * 100, 1),
                "delta": round(q["delta"], 3) if q.get("delta") else None,
                "distance": round(q["strike"] - spot, 1),
            })
    puts = []
    for q in sorted(put_quotes, key=lambda x: x["strike"]):
        if q.get("iv") and q["iv"] > 0:
            puts.append({
                "strike": q["strike"],
                "iv": round(q["iv"] * 100, 1),
                "delta": round(q["delta"], 3) if q.get("delta") else None,
                "distance": round(q["strike"] - spot, 1),
            })
    return {"calls": calls, "puts": puts, "spot": spot}


def _analysis_volume_oi(call_quotes: list, put_quotes: list) -> Dict[str, Any]:
    """Volume and OI heat map across strikes."""
    data = []
    for q in sorted(call_quotes + put_quotes, key=lambda x: (x["strike"], x["right"])):
        data.append({
            "strike": q["strike"],
            "right": q["right"],
            "oi": q.get("oi") or 0,
            "volume": q.get("volume") or 0,
            "bid": q.get("bid"),
            "ask": q.get("ask"),
        })
    # Aggregate by strike
    by_strike = defaultdict(lambda: {"call_oi": 0, "put_oi": 0, "call_vol": 0, "put_vol": 0, "total_oi": 0})
    for d in data:
        s = by_strike[d["strike"]]
        if d["right"] == "C":
            s["call_oi"] = d["oi"]
            s["call_vol"] = d["volume"]
        else:
            s["put_oi"] = d["oi"]
            s["put_vol"] = d["volume"]
        s["total_oi"] = s["call_oi"] + s["put_oi"]

    results = []
    for strike in sorted(by_strike.keys()):
        s = by_strike[strike]
        results.append({"strike": strike, **s})
    return {"strikes": results}


def _analysis_hv_vs_iv(bars_1d: list, call_quotes: list, put_quotes: list, spot: float) -> Dict[str, Any]:
    """Compare historical volatility to implied volatility."""
    # Compute realized volatility from daily bars
    if len(bars_1d) < 10:
        return {"error": "insufficient daily bars"}

    log_returns = []
    for i in range(1, len(bars_1d)):
        if bars_1d[i - 1]["close"] > 0:
            lr = math.log(bars_1d[i]["close"] / bars_1d[i - 1]["close"])
            log_returns.append(lr)

    hv_windows = {}
    for window in [5, 10, 20, 30]:
        if len(log_returns) >= window:
            recent = log_returns[-window:]
            mean = sum(recent) / len(recent)
            variance = sum((r - mean) ** 2 for r in recent) / (len(recent) - 1)
            hv = math.sqrt(variance) * math.sqrt(252) * 100
            hv_windows[f"hv_{window}d"] = round(hv, 1)

    # ATM IV from option chain
    atm_call_iv = None
    atm_put_iv = None
    for q in call_quotes:
        if abs(q["strike"] - spot) <= 1 and q.get("iv"):
            atm_call_iv = round(q["iv"] * 100, 1)
            break
    for q in put_quotes:
        if abs(q["strike"] - spot) <= 1 and q.get("iv"):
            atm_put_iv = round(q["iv"] * 100, 1)
            break

    atm_iv = atm_call_iv or atm_put_iv
    iv_vs_hv = {}
    if atm_iv:
        for k, hv in hv_windows.items():
            iv_vs_hv[k] = {"hv": hv, "iv": atm_iv, "premium": round(atm_iv - hv, 1)}

    return {"hv": hv_windows, "atm_iv": atm_iv, "comparison": iv_vs_hv}


def _analysis_intraday_pattern(bars_1m: list) -> Dict[str, Any]:
    """Average intraday pattern across multiple days."""
    days = _group_bars_by_day(bars_1m)
    # Normalize each day: express price as % change from open
    time_buckets = defaultdict(list)
    for day, dbars in sorted(days.items()):
        if len(dbars) < 100:
            continue
        day_open = dbars[0]["open"]
        if day_open == 0:
            continue
        for b in dbars:
            dt = datetime.fromtimestamp(b["time"], NY)
            minutes = dt.hour * 60 + dt.minute
            bucket = (minutes // 15) * 15  # 15-min buckets
            pct = ((b["close"] - day_open) / day_open) * 100
            time_buckets[bucket].append(pct)

    results = []
    for bucket in sorted(time_buckets.keys()):
        vals = time_buckets[bucket]
        h = bucket // 60
        m = bucket % 60
        results.append({
            "time": f"{h:02d}:{m:02d}",
            "avg_pct": round(sum(vals) / len(vals), 3),
            "min_pct": round(min(vals), 3),
            "max_pct": round(max(vals), 3),
            "std": round((sum((v - sum(vals) / len(vals)) ** 2 for v in vals) / len(vals)) ** 0.5, 3) if len(vals) > 1 else 0,
            "samples": len(vals),
        })
    return {"pattern": results, "days_analyzed": len(days)}


def _analysis_gamma_exposure(call_quotes: list, put_quotes: list, spot: float) -> Dict[str, Any]:
    """Gamma exposure by strike: gamma * OI * 100 * spot."""
    results = []
    for q in call_quotes:
        gamma = q.get("gamma") or 0
        oi = q.get("oi") or 0
        if gamma > 0 and oi > 0:
            gex = gamma * oi * 100 * spot
            results.append({
                "strike": q["strike"],
                "right": "C",
                "gamma": round(gamma, 5),
                "oi": oi,
                "gex": round(gex),
            })
    for q in put_quotes:
        gamma = q.get("gamma") or 0
        oi = q.get("oi") or 0
        if gamma > 0 and oi > 0:
            # Put gamma exposure is negative (dealers short puts → short gamma)
            gex = -gamma * oi * 100 * spot
            results.append({
                "strike": q["strike"],
                "right": "P",
                "gamma": round(gamma, 5),
                "oi": oi,
                "gex": round(gex),
            })

    # Net GEX by strike
    net_by_strike = defaultdict(float)
    for r in results:
        net_by_strike[r["strike"]] += r["gex"]

    net_gex = [{"strike": s, "net_gex": round(v)} for s, v in sorted(net_by_strike.items())]
    return {"details": results, "net_gex": net_gex}


def _render_html(data: Dict[str, Any], analyses: Dict[str, Any]) -> str:
    """Render the full HTML report."""
    spot = data["spot"]
    gen = data["generated_at"]
    exp = data["expiration"]

    # --- Entry Timing ---
    timing = analyses["entry_timing"]
    timing_rows = ""
    max_move = max((w["avg_move"] for w in timing["windows"]), default=1)
    for w in timing["windows"]:
        bar_width = int(w["avg_move"] / max_move * 200) if max_move else 0
        color = "#39d98a" if w["avg_direction"] > 0 else "#ff6b6b"
        timing_rows += f"""<tr>
            <td>{w['window']}</td>
            <td>{w['avg_move']:.2f}</td>
            <td style="color:{color}">{w['avg_direction']:+.2f}</td>
            <td>{w['bullish_pct']}%</td>
            <td><div style="background:{color};width:{bar_width}px;height:16px;border-radius:3px;opacity:0.7"></div></td>
            <td class="muted">{w['samples']}</td>
        </tr>"""

    # --- IV Skew ---
    iv_skew = analyses["iv_skew"]
    iv_call_points = json.dumps([{"x": c["distance"], "y": c["iv"]} for c in iv_skew["calls"] if c["iv"]])
    iv_put_points = json.dumps([{"x": p["distance"], "y": p["iv"]} for p in iv_skew["puts"] if p["iv"]])

    # --- Volume/OI ---
    vol_oi = analyses["volume_oi"]
    oi_labels = json.dumps([s["strike"] for s in vol_oi["strikes"]])
    oi_call_data = json.dumps([s["call_oi"] for s in vol_oi["strikes"]])
    oi_put_data = json.dumps([s["put_oi"] for s in vol_oi["strikes"]])
    vol_call_data = json.dumps([s["call_vol"] for s in vol_oi["strikes"]])
    vol_put_data = json.dumps([s["put_vol"] for s in vol_oi["strikes"]])

    # --- HV vs IV ---
    hv_iv = analyses["hv_vs_iv"]
    hv_rows = ""
    for k, v in hv_iv.get("comparison", {}).items():
        label = k.replace("hv_", "").replace("d", "-day HV")
        premium_color = "#ff6b6b" if v["premium"] > 5 else "#39d98a" if v["premium"] < -5 else "#d1d4dc"
        hv_rows += f"""<tr>
            <td>{label}</td>
            <td>{v['hv']:.1f}%</td>
            <td>{v['iv']:.1f}%</td>
            <td style="color:{premium_color};font-weight:600">{v['premium']:+.1f}%</td>
            <td class="muted">{'Expensive' if v['premium'] > 5 else 'Cheap' if v['premium'] < -5 else 'Fair'}</td>
        </tr>"""

    # --- Intraday Pattern ---
    pattern = analyses["intraday_pattern"]
    pattern_labels = json.dumps([p["time"] for p in pattern["pattern"]])
    pattern_avg = json.dumps([p["avg_pct"] for p in pattern["pattern"]])
    pattern_min = json.dumps([p["min_pct"] for p in pattern["pattern"]])
    pattern_max = json.dumps([p["max_pct"] for p in pattern["pattern"]])

    # --- Gamma Exposure ---
    gex = analyses["gamma_exposure"]
    gex_labels = json.dumps([g["strike"] for g in gex["net_gex"]])
    gex_data = json.dumps([g["net_gex"] for g in gex["net_gex"]])
    gex_colors = json.dumps(["#39d98a" if g["net_gex"] > 0 else "#ff6b6b" for g in gex["net_gex"]])

    # Top OI strikes
    top_oi = sorted(vol_oi["strikes"], key=lambda x: x["total_oi"], reverse=True)[:5]
    top_oi_text = ", ".join(f"${s['strike']:.0f} ({s['total_oi']:,.0f})" for s in top_oi)

    # Net GEX flip point
    flip_strike = None
    for i, g in enumerate(gex["net_gex"]):
        if i > 0 and gex["net_gex"][i - 1]["net_gex"] * g["net_gex"] < 0:
            flip_strike = g["strike"]

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SPY Options Analysis — {gen}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #0f0f1a; color: #d1d4dc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }}
  h1 {{ color: #fff; font-size: 22px; margin-bottom: 4px; }}
  h2 {{ color: #ffd54f; font-size: 16px; margin: 30px 0 12px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; }}
  h3 {{ color: #9ca3af; font-size: 13px; margin: 16px 0 8px; }}
  .subtitle {{ color: #7c8190; font-size: 13px; margin-bottom: 20px; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }}
  .card {{ background: #1a1f2e; border: 1px solid #2b2b43; border-radius: 8px; padding: 16px; }}
  .card-full {{ grid-column: 1 / -1; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  th {{ text-align: left; color: #7c8190; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid #2b2b43; }}
  td {{ padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); }}
  .muted {{ color: #7c8190; }}
  .highlight {{ background: rgba(255,213,79,0.08); }}
  .tag {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }}
  .tag-green {{ background: rgba(57,217,138,0.15); color: #39d98a; }}
  .tag-red {{ background: rgba(255,107,107,0.15); color: #ff6b6b; }}
  .tag-yellow {{ background: rgba(255,213,79,0.15); color: #ffd54f; }}
  .stat {{ text-align: center; }}
  .stat-value {{ font-size: 24px; font-weight: 700; color: #fff; }}
  .stat-label {{ font-size: 11px; color: #7c8190; margin-top: 2px; }}
  canvas {{ max-height: 300px; }}
  .insight {{ background: rgba(255,213,79,0.06); border-left: 3px solid #ffd54f; padding: 10px 14px; margin: 10px 0; font-size: 12px; border-radius: 0 6px 6px 0; }}
</style>
</head>
<body>
<h1>SPY Options Analysis Report</h1>
<p class="subtitle">Generated {gen} &mdash; SPY ${spot:.2f} &mdash; Exp: {exp}</p>

<div style="display:flex;gap:16px;margin-bottom:20px">
  <div class="card stat" style="flex:1">
    <div class="stat-value">${spot:.2f}</div>
    <div class="stat-label">SPY Spot</div>
  </div>
  <div class="card stat" style="flex:1">
    <div class="stat-value">{hv_iv.get('atm_iv', 'n/a')}{'%' if hv_iv.get('atm_iv') else ''}</div>
    <div class="stat-label">ATM IV</div>
  </div>
  <div class="card stat" style="flex:1">
    <div class="stat-value">{hv_iv.get('hv', {}).get('hv_20d', 'n/a')}{'%' if hv_iv.get('hv', {}).get('hv_20d') else ''}</div>
    <div class="stat-label">20d HV</div>
  </div>
  <div class="card stat" style="flex:1">
    <div class="stat-value">{'$' + str(flip_strike) if flip_strike else 'n/a'}</div>
    <div class="stat-label">GEX Flip Strike</div>
  </div>
</div>

<div class="grid">

<!-- 1. Entry Timing -->
<div class="card card-full">
  <h2>1. Optimal Entry Timing</h2>
  <p class="muted" style="font-size:12px;margin-bottom:10px">Average absolute SPY move per 30-min window (using {len(_group_bars_by_day(data['bars_1m']))} days of 1m data)</p>
  <table>
    <tr><th>Window</th><th>Avg Move ($)</th><th>Avg Direction</th><th>Bullish %</th><th>Strength</th><th>Samples</th></tr>
    {timing_rows}
  </table>
  <div class="insight">Best windows for directional entries have the highest avg move with a clear bullish/bearish bias (&gt;60% or &lt;40%).</div>
</div>

<!-- 2. IV Skew -->
<div class="card">
  <h2>2. IV Skew</h2>
  <canvas id="ivSkewChart"></canvas>
  <div class="insight">Look for strikes where IV is relatively low (cheap) compared to ATM. OTM puts typically have higher IV (skew).</div>
</div>

<!-- 3. HV vs IV -->
<div class="card">
  <h2>3. Historical Vol vs Implied Vol</h2>
  <table>
    <tr><th>Period</th><th>Realized HV</th><th>ATM IV</th><th>IV Premium</th><th>Verdict</th></tr>
    {hv_rows}
  </table>
  <div class="insight">Positive premium = IV &gt; HV = options are expensive (bad for buying). Negative = cheap (good for buying).</div>
</div>

<!-- 4. Volume/OI Heat Map -->
<div class="card card-full">
  <h2>4. Volume &amp; Open Interest</h2>
  <p class="muted" style="font-size:12px;margin-bottom:8px">Top OI strikes: {top_oi_text}</p>
  <canvas id="oiChart" height="120"></canvas>
  <div class="insight">High OI strikes act as magnets — market makers hedge around them. Price tends to gravitate toward max OI.</div>
</div>

<!-- 5. Intraday Pattern -->
<div class="card card-full">
  <h2>5. Average Intraday Pattern ({pattern['days_analyzed']} days)</h2>
  <canvas id="patternChart" height="100"></canvas>
  <div class="insight">Shows the typical SPY intraday trajectory. Band shows min/max range. Steeper slopes = stronger trend windows.</div>
</div>

<!-- 6. Gamma Exposure -->
<div class="card card-full">
  <h2>6. Net Gamma Exposure (GEX) by Strike</h2>
  <canvas id="gexChart" height="120"></canvas>
  <div class="insight">
    Positive GEX = dealers are long gamma (dampens moves). Negative GEX = dealers short gamma (amplifies moves).
    {f'GEX flips at ${flip_strike} — above this strike, moves are dampened; below, they accelerate.' if flip_strike else ''}
  </div>
</div>

</div><!-- grid -->

<script>
Chart.defaults.color = '#7c8190';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

// IV Skew Chart
new Chart(document.getElementById('ivSkewChart'), {{
  type: 'scatter',
  data: {{
    datasets: [
      {{ label: 'Call IV', data: {iv_call_points}, backgroundColor: '#39d98a', pointRadius: 4 }},
      {{ label: 'Put IV', data: {iv_put_points}, backgroundColor: '#ff6b6b', pointRadius: 4 }},
    ]
  }},
  options: {{
    plugins: {{ legend: {{ labels: {{ font: {{ size: 11 }} }} }} }},
    scales: {{
      x: {{ title: {{ display: true, text: 'Distance from Spot ($)' }}, grid: {{ color: 'rgba(255,255,255,0.04)' }} }},
      y: {{ title: {{ display: true, text: 'IV (%)' }}, grid: {{ color: 'rgba(255,255,255,0.04)' }} }}
    }}
  }}
}});

// OI Chart
new Chart(document.getElementById('oiChart'), {{
  type: 'bar',
  data: {{
    labels: {oi_labels},
    datasets: [
      {{ label: 'Call OI', data: {oi_call_data}, backgroundColor: 'rgba(57,217,138,0.5)', stack: 'oi' }},
      {{ label: 'Put OI', data: {oi_put_data}, backgroundColor: 'rgba(255,107,107,0.5)', stack: 'oi' }},
    ]
  }},
  options: {{
    plugins: {{ legend: {{ labels: {{ font: {{ size: 11 }} }} }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }}, maxRotation: 90 }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ callback: v => (v/1000).toFixed(0)+'K' }} }}
    }}
  }}
}});

// Intraday Pattern Chart
new Chart(document.getElementById('patternChart'), {{
  type: 'line',
  data: {{
    labels: {pattern_labels},
    datasets: [
      {{ label: 'Avg %', data: {pattern_avg}, borderColor: '#ffd54f', borderWidth: 2, fill: false, tension: 0.3, pointRadius: 0 }},
      {{ label: 'Max', data: {pattern_max}, borderColor: 'rgba(57,217,138,0.3)', borderWidth: 1, fill: false, pointRadius: 0 }},
      {{ label: 'Min', data: {pattern_min}, borderColor: 'rgba(255,107,107,0.3)', borderWidth: 1, fill: '-1', backgroundColor: 'rgba(255,255,255,0.03)', pointRadius: 0 }},
    ]
  }},
  options: {{
    plugins: {{ legend: {{ labels: {{ font: {{ size: 11 }} }} }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }} }} }},
      y: {{ title: {{ display: true, text: '% from Open' }}, grid: {{ color: 'rgba(255,255,255,0.04)' }} }}
    }}
  }}
}});

// GEX Chart
new Chart(document.getElementById('gexChart'), {{
  type: 'bar',
  data: {{
    labels: {gex_labels},
    datasets: [{{ label: 'Net GEX ($)', data: {gex_data}, backgroundColor: {gex_colors} }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ grid: {{ display: false }}, ticks: {{ font: {{ size: 10 }}, maxRotation: 90 }} }},
      y: {{ grid: {{ color: 'rgba(255,255,255,0.04)' }}, ticks: {{ callback: v => (v/1e6).toFixed(1)+'M' }} }}
    }}
  }}
}});
</script>
</body>
</html>"""


async def generate_report() -> str:
    """Generate the full HTML report. Returns HTML string."""
    data = await _fetch_data()
    analyses = {
        "entry_timing": _analysis_entry_timing(data["bars_1m"]),
        "iv_skew": _analysis_iv_skew(data["call_quotes"], data["put_quotes"], data["spot"]),
        "volume_oi": _analysis_volume_oi(data["call_quotes"], data["put_quotes"]),
        "hv_vs_iv": _analysis_hv_vs_iv(data["bars_1d"], data["call_quotes"], data["put_quotes"], data["spot"]),
        "intraday_pattern": _analysis_intraday_pattern(data["bars_1m"]),
        "gamma_exposure": _analysis_gamma_exposure(data["call_quotes"], data["put_quotes"], data["spot"]),
    }
    return _render_html(data, analyses)
