"""Market data API endpoints."""
import asyncio
import json
import logging
import time
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Body
from fastapi.responses import StreamingResponse
from app.models.schemas import (
    HistoricalDataResponse,
    Bar,
    ErrorResponse,
    OptionChainResponse,
    OptionChainExpiration,
    OptionQuotesResponse,
    OptionQuote,
    FinvizRecomTargetResponse,
    EarningsResponse,
    StrategySettingsResponse,
    OrdersResponse,
    OrdersSummaryResponse,
    IbPositionsResponse,
    IbOrdersResponse,
    IbAccountSummaryResponse,
    AutoTraderStatusResponse,
    AutoTraderEventsResponse,
    AutoTraderSettingsResponse,
    AutoTraderSettings,
    FavoritesPayload,
    FavoritesResponse,
    SwitchModeRequest,
    SwitchModeResponse,
    TradingAccountsResponse,
    IbAccountInfo,
    TradeOrderRequest,
    OrderLogEntry,
    ClosePositionRequest,
    ClosePositionResponse,
    CloseAllPositionsResponse,
    CloseAllPositionsResult,
)
from app.services.ib.market_data import get_historical_bars, validate_symbol, search_symbols
from app.services.ib.metrics import snapshot as ib_metrics_snapshot
from app.services.ib.options_data import get_option_chain, get_option_quotes
from app.services.ib.earnings_data import get_earnings_date
from app.services.finviz_data import fetch_finviz_recom_target
from app.services.strategy_settings import get_settings, set_settings
from app.services.trading_log import (
    read_entries,
    build_open_positions,
    summarize,
    clear_entries,
    archive_entries,
)
from app.services.ib.trading import (
    place_option_order,
    close_position,
    close_all_positions,
    get_open_positions,
    get_account_summary,
    get_ib_orders_history,
    _account_summary_items,
    stop_account_summary_listener,
    start_account_summary_listener,
)
from app.services.auto_trader import auto_trader
from app.services.ib.gateway import ib_manager, PAPER_PORT, LIVE_PORT
from app.services.auto_trader_settings import get_settings as get_auto_trader_settings
from app.services.auto_trader_settings import save_settings as save_auto_trader_settings


def _active_ib_account() -> Optional[str]:
    """Return the configured IB account for the current trading mode, or None."""
    at_settings = get_auto_trader_settings()
    mode = ib_manager.active_mode  # "paper" or "live"
    account = (at_settings.get("liveAccount" if mode == "live" else "paperAccount") or "").strip()
    return account or None
from app.services.favorites import get_favorites, save_favorites
from app.services.strategy_report import compute_report
from app.utils.timeframe_converter import get_supported_timeframes
from app.services import position_tp_overrides
from app.services.strategy_analysis import analyze_with_bars
from app.services.strategy_defaults import DEFAULT_STRATEGY_SETTINGS, merge_strategy_settings
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/market-data", tags=["market-data"])


@router.get("/options-backtest-ui")
async def options_backtest_ui():
    """Dashboard UI for the options backtester with full settings control."""
    from fastapi.responses import HTMLResponse
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    ny = ZoneInfo("America/New_York")
    today = datetime.now(ny).strftime("%Y-%m-%d")
    two_weeks_ago = (datetime.now(ny) - timedelta(days=14)).strftime("%Y-%m-%d")
    html = f"""<!DOCTYPE html>
<html><head><title>Options Backtester</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  .flatpickr-calendar {{ background:#1a1f2e !important; border-color:#2b2b43 !important; }}
  .flatpickr-day {{ color:#d1d4dc !important; }}
  .flatpickr-day.selected {{ background:#ffd54f !important; color:#0f0f1a !important; }}
  body {{ background:#0f0f1a; color:#d1d4dc; font-family:-apple-system,sans-serif; padding:20px; }}
  h1 {{ color:#fff; font-size:20px; }}
  .sub {{ color:#7c8190; font-size:12px; margin-bottom:16px; }}
  .layout {{ display:flex; gap:16px; align-items:flex-start; }}
  .panel {{ background:#1a1f2e; border:1px solid #2b2b43; border-radius:10px; padding:16px; }}
  .settings {{ width:360px; flex-shrink:0; }}
  .results {{ flex:1; min-width:0; }}
  h2 {{ color:#ffd54f; font-size:13px; margin:14px 0 8px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:4px; }}
  h2:first-child {{ margin-top:0; }}
  label {{ display:block; font-size:11px; color:#9ca3af; margin:8px 0 3px; }}
  input,select {{ width:100%; padding:6px 10px; background:#0f0f1a; border:1px solid #2b2b43; border-radius:5px; color:#d1d4dc; font-size:13px; }}
  input[type=number] {{ width:100%; }}
  .row {{ display:flex; gap:8px; }}
  .row > div {{ flex:1; }}
  .row3 {{ display:flex; gap:8px; }}
  .row3 > div {{ flex:1; }}
  button {{ width:100%; margin-top:14px; padding:9px; background:#ffd54f; color:#0f0f1a; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; }}
  button:hover {{ background:#ffca28; }}
  button:disabled {{ background:#444; color:#888; cursor:wait; }}
  .note {{ font-size:10px; color:#555; margin-top:8px; }}
  iframe {{ width:100%; height:calc(100vh - 60px); border:none; border-radius:8px; background:#0f0f1a; }}
  .empty {{ display:flex; align-items:center; justify-content:center; height:400px; color:#555; font-size:14px; }}
  .check {{ display:flex; align-items:center; gap:6px; margin:4px 0; }}
  .check input {{ width:auto; }}
  .check label {{ margin:0; font-size:12px; }}
  .tier {{ display:flex; gap:6px; align-items:center; margin:3px 0; font-size:11px; }}
  .tier input {{ width:65px; font-size:11px; padding:4px 6px; }}
  .tier span {{ color:#7c8190; white-space:nowrap; }}
  .tier button {{ width:auto; margin:0; padding:2px 8px; font-size:10px; background:transparent; color:#ff6b6b; border:1px solid #ff6b6b33; }}
  .add-btn {{ width:auto; margin:4px 0; padding:3px 10px; font-size:11px; background:transparent; color:#ffd54f; border:1px solid #ffd54f33; }}
</style></head><body>
<h1>Options Backtester</h1>
<p class="sub">Backtest strategies using real Polygon.io option premiums. Settings below are independent of your live auto trader.</p>
<div class="layout">
<div class="panel settings">
  <form id="f">
    <h2>General</h2>
    <div class="row">
      <div><label>Symbol</label><input name="symbol" value="SPY" /></div>
      <div><label>Strategy</label><select name="strategy">
        <option value="10" selected>S10 — 0DTE Trend</option>
        <option value="11">S11 — ICT Price Action</option>
        <option value="12">S12 — GEX Mean Reversion</option>
        <option value="13">S13 — Opening Direction</option>
        <option value="14">S14 — Gamma Zero (SPY)</option>
        <option value="10,11">S10 + S11</option>
        <option value="10,13">S10 + S13</option>
        <option value="10,11,12,13,14">All (S10–S14)</option>
      </select></div>
    </div>
    <div class="row">
      <div><label>Start Date</label><input type="text" name="start_date" id="start_date" value="{two_weeks_ago}" /></div>
      <div><label>End Date</label><input type="text" name="end_date" id="end_date" value="{today}" /></div>
    </div>

    <h2>Premium Range</h2>
    <div class="row">
      <div><label>Min Premium ($)</label><input type="number" name="premiumMin" value="0" min="0" step="0.25" /></div>
      <div><label>Max Premium ($)</label><input type="number" name="premiumMax" value="0" min="0" step="0.25" /></div>
    </div>
    <p class="note" style="margin-top:4px">Per-share price (e.g. 0.50 = $50/contract). 0 = no filter.</p>

    <h2>Capital &amp; Sizing</h2>
    <div class="row">
      <div><label>Capital Limit ($)</label><input type="number" name="capitalLimit" value="200" step="50" /></div>
      <div><label>Position Sizing</label><select name="positionSizing">
        <option value="fixed" selected>Fixed ($ per trade)</option>
        <option value="percentage">% of Capital</option>
        <option value="hybrid">Hybrid (% capped)</option>
      </select></div>
    </div>
    <div class="row">
      <div><label>Risk per Trade ($)</label><input type="number" name="riskPerTrade" value="200" step="25" /></div>
      <div><label>Max Contracts</label><input type="number" name="maxContractsPerTrade" value="3" min="1" max="20" /></div>
    </div>
    <div class="row">
      <div><label>Min Contracts</label><input type="number" name="minContractsPerTrade" value="1" min="1" max="10" /></div>
      <div><label>Risk % of Capital</label><input type="number" name="riskPctPerTrade" value="2" step="0.5" min="0.5" max="20" /></div>
    </div>

    <h2>Entry</h2>
    <div class="row">
      <div><label>Entry Start (ET)</label><input name="entryStartTime" value="10:30" /></div>
      <div><label>Entry End (ET)</label><input name="entryEndTime" value="15:30" /></div>
    </div>

    <h2>Chop Filter</h2>
    <div class="check"><input type="checkbox" name="chopFilterEnabled" checked /><label>Enable chop filter</label></div>
    <div class="row3">
      <div><label>ADX threshold</label><input type="number" name="chopFilterAdxThreshold" value="20" min="5" max="50" /></div>
      <div><label>DI gap</label><input type="number" name="chopFilterDiGap" value="10" min="0" max="30" /></div>
      <div><label>Timeframe</label><select name="chopFilterTimeframe"><option value="5m" selected>5m</option><option value="15m">15m</option></select></div>
    </div>

    <h2>Take Profit</h2>
    <div class="row">
      <div><label>Profit Target (%)</label><input type="number" name="profitTargetPct" value="25" step="5" /></div>
      <div>
        <label>Time Exit (ET)</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input name="timeExitAt" value="15:30" id="timeExitAt" style="flex:1" />
          <div class="check" style="margin:0"><input type="checkbox" name="timeExitEnabled" id="timeExitEnabled" checked onchange="document.getElementById('timeExitAt').disabled=!this.checked" /><label style="font-size:11px">On</label></div>
        </div>
      </div>
    </div>

    <h2>Trailing Stop</h2>
    <div class="check"><input type="checkbox" name="useTrailingStop" checked /><label>Enable trailing stop</label></div>
    <div class="row">
      <div><label>Default Trail (%)</label><input type="number" name="trailingStopPct" value="7" step="1" /></div>
      <div><label>Stop Loss (%)</label><input type="number" name="stopLossPct" value="0" step="5" /></div>
    </div>
    <label>Trailing Tiers <button type="button" class="add-btn" onclick="addTier()">+ Add</button></label>
    <div id="tiers">
      <div class="tier"><span>&ge;</span><input type="number" value="0" data-field="above" step="5"/>%<span>trail</span><input type="number" value="7" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove()">&times;</button></div>
      <div class="tier"><span>&ge;</span><input type="number" value="25" data-field="above" step="5"/>%<span>trail</span><input type="number" value="5" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove()">&times;</button></div>
      <div class="tier"><span>&ge;</span><input type="number" value="50" data-field="above" step="5"/>%<span>trail</span><input type="number" value="4" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove()">&times;</button></div>
      <div class="tier"><span>&ge;</span><input type="number" value="100" data-field="above" step="5"/>%<span>trail</span><input type="number" value="3" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove()">&times;</button></div>
    </div>

    <h2>Stale Position Exit</h2>
    <div class="row">
      <div><label>Close after (min)</label><input type="number" name="staleAfterMinutes" value="0" min="0" step="5" /></div>
      <div><label>Min gain required (%)</label><input type="number" name="staleMinGainPct" value="10" min="0" step="5" /></div>
    </div>

    <button type="submit" id="btn">Run Backtest</button>
    <button type="button" id="opt-btn" onclick="runOptimize()" style="margin-top:6px;background:#7c4dff">Find Best Settings</button>
    <button type="button" id="trail-btn" onclick="runTrailingOptimize()" style="margin-top:6px;background:#00897b">Optimize Trailing</button>
    <p class="note">Backtest: ~3-5 sec/day. Optimize: ~30-60 sec. Trailing: uses best Phase 1 settings.</p>
  </form>
</div>
<div class="panel results" id="results-panel">
  <div class="empty">Configure settings and click Run Backtest</div>
</div>
<div class="panel" id="progress-panel" style="display:none;position:fixed;bottom:16px;right:16px;width:420px;max-height:300px;overflow-y:auto;font-size:11px;z-index:100;opacity:0.95">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <b id="prog-phase" style="color:#ffd54f;font-size:12px"></b>
    <span id="prog-pct" style="color:#7c8190"></span>
  </div>
  <div style="background:#0f0f1a;border-radius:4px;height:6px;margin-bottom:8px"><div id="prog-bar" style="height:100%;background:#ffd54f;border-radius:4px;width:0%;transition:width 0.3s"></div></div>
  <div id="prog-log" style="font-family:monospace;font-size:10px;color:#9ca3af;max-height:200px;overflow-y:auto"></div>
</div>
</div>
<script>
function addTier() {{
  var d = document.createElement('div'); d.className='tier';
  d.innerHTML='<span>&ge;</span><input type="number" value="0" data-field="above" step="5"/>%<span>trail</span><input type="number" value="7" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove()">&times;</button>';
  document.getElementById('tiers').appendChild(d);
}}

function getTiers() {{
  var tiers = [];
  document.querySelectorAll('#tiers .tier').forEach(function(row) {{
    var above = parseFloat(row.querySelector('[data-field=above]').value) / 100;
    var trail = parseFloat(row.querySelector('[data-field=trail]').value) / 100;
    tiers.push({{above: above, trail: trail}});
  }});
  return tiers;
}}

document.getElementById('f').onsubmit = function(e) {{
  e.preventDefault();
  var btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Running...';
  var fd = new FormData(this);

  // Build settings override from form
  var strategies = fd.get('strategy').split(',').map(Number);
  var settings = {{
    premiumMin: parseFloat(fd.get('premiumMin')) || 0,
    premiumMax: parseFloat(fd.get('premiumMax')) || 0,
    capitalLimit: parseFloat(fd.get('capitalLimit')) || 0,
    positionSizing: fd.get('positionSizing') || 'fixed',
    riskPerTrade: parseFloat(fd.get('riskPerTrade')) || 200,
    riskPctPerTrade: parseFloat(fd.get('riskPctPerTrade')) || 2,
    maxContractsPerTrade: parseInt(fd.get('maxContractsPerTrade')) || 3,
    minContractsPerTrade: parseInt(fd.get('minContractsPerTrade')) || 1,
    profitTargetPct: parseFloat(fd.get('profitTargetPct')) / 100,
    useTrailingStop: fd.get('useTrailingStop') === 'on',
    trailingStopPct: parseFloat(fd.get('trailingStopPct')) / 100,
    staleAfterMinutes: parseFloat(fd.get('staleAfterMinutes')) || 0,
    staleMinGainPct: parseFloat(fd.get('staleMinGainPct')) / 100,
    stopLossPct: parseFloat(fd.get('stopLossPct')) / 100,
    trailingTiers: getTiers(),
    chopFilterEnabled: fd.get('chopFilterEnabled') === 'on',
    chopFilterAdxThreshold: parseFloat(fd.get('chopFilterAdxThreshold')),
    chopFilterDiGap: parseFloat(fd.get('chopFilterDiGap')),
    chopFilterTimeframe: fd.get('chopFilterTimeframe'),
    entryStartTime: fd.get('entryStartTime') || '10:30',
    entryEndTime: fd.get('entryEndTime') || '15:30',
    tickerSettings: {{
      [fd.get('symbol').toUpperCase()]: {{
        enabled: true,
        enabledStrategies: strategies
      }}
    }},
  }};

  var url = '/api/v1/market-data/options-backtest?symbol=' + fd.get('symbol').toUpperCase()
    + '&start_date=' + fd.get('start_date')
    + '&end_date=' + fd.get('end_date')
    + '&output=html';

  startProgressPoll();
  fetch(url, {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify(settings)
  }})
  .then(r => {{
    if (!r.ok) return r.text().then(txt => {{ try {{ var j = JSON.parse(txt); throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)); }} catch(e) {{ if (e instanceof SyntaxError) throw new Error(txt); throw e; }} }});
    return r.text();
  }})
  .then(html => {{
    var panel = document.getElementById('results-panel');
    var iframe = document.createElement('iframe');
    panel.innerHTML = '';
    panel.appendChild(iframe);
    iframe.srcdoc = html;
    btn.disabled = false; btn.textContent = 'Run Backtest';
  }})
  .catch(err => {{
    var panel = document.getElementById('results-panel');
    var msg = String(err.message || err);
    if (msg.includes('429')) msg = 'Polygon API rate limit reached. Please wait 1-2 minutes and try again.';
    panel.innerHTML = '<div class="empty" style="color:#ff6b6b;padding:20px;text-align:center;font-size:13px">' + msg + '</div>';
    btn.disabled = false; btn.textContent = 'Run Backtest';
  }});
}};

var _progressInterval = null;
function startProgressPoll() {{
  var panel = document.getElementById('progress-panel');
  panel.style.display = 'block';
  if (_progressInterval) clearInterval(_progressInterval);
  _progressInterval = setInterval(function() {{
    fetch('/api/v1/market-data/options-optimize-progress')
      .then(r => r.json())
      .then(d => {{
        document.getElementById('prog-phase').textContent = d.phase + ': ' + d.step;
        document.getElementById('prog-pct').textContent = d.pct + '%';
        document.getElementById('prog-bar').style.width = d.pct + '%';
        var logDiv = document.getElementById('prog-log');
        logDiv.innerHTML = (d.log || []).map(l => '<div>' + l + '</div>').join('');
        logDiv.scrollTop = logDiv.scrollHeight;
        if (!d.running && d.pct >= 100) {{
          clearInterval(_progressInterval);
          _progressInterval = null;
          setTimeout(() => {{ panel.style.display = 'none'; }}, 5000);
        }}
      }}).catch(() => {{}});
  }}, 1000);
}}

function runTrailingOptimize() {{
  var btn = document.getElementById('trail-btn');
  btn.disabled = true; btn.textContent = 'Optimizing trailing...';
  startProgressPoll();
  var fd = new FormData(document.getElementById('f'));
  var url = '/api/v1/market-data/options-optimize-trailing?symbol=' + fd.get('symbol').toUpperCase()
    + '&start_date=' + fd.get('start_date')
    + '&end_date=' + fd.get('end_date')
    + '&profitTargetPct=' + (parseFloat(fd.get('profitTargetPct')) / 100)
    + '&chopFilterDiGap=' + (fd.get('chopFilterEnabled') === 'on' ? fd.get('chopFilterDiGap') : '0')
    + '&chopFilterAdxThreshold=' + (fd.get('chopFilterEnabled') === 'on' ? fd.get('chopFilterAdxThreshold') : '0')
    + '&stopLossPct=' + (parseFloat(fd.get('stopLossPct')) / 100)
    + '&capitalLimit=' + fd.get('capitalLimit')
    + '&positionSizing=' + (fd.get('positionSizing') || 'fixed')
    + '&riskPerTrade=' + (fd.get('riskPerTrade') || '200')
    + '&maxContractsPerTrade=' + (fd.get('maxContractsPerTrade') || '3')
    + '&minContractsPerTrade=' + (fd.get('minContractsPerTrade') || '1')
    + '&riskPctPerTrade=' + (fd.get('riskPctPerTrade') || '2')
    + '&staleAfterMinutes=' + (fd.get('staleAfterMinutes') || '0')
    + '&staleMinGainPct=' + ((parseFloat(fd.get('staleMinGainPct')) || 0) / 100)
    + '&premiumMin=' + (fd.get('premiumMin') || '0')
    + '&premiumMax=' + (fd.get('premiumMax') || '0');
  fetch(url)
    .then(r => {{
      if (!r.ok) return r.text().then(txt => {{ try {{ var j = JSON.parse(txt); throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)); }} catch(e) {{ if (e instanceof SyntaxError) throw new Error(txt); throw e; }} }});
      return r.text();
    }})
    .then(html => {{
      var panel = document.getElementById('results-panel');
      var iframe = document.createElement('iframe');
      panel.innerHTML = '';
      panel.appendChild(iframe);
      iframe.srcdoc = html;
      btn.disabled = false; btn.textContent = 'Optimize Trailing';
    }})
    .catch(err => {{
      var panel = document.getElementById('results-panel');
      var msg = String(err.message || err);
      if (msg.includes('429')) msg = 'Polygon API rate limit. Wait 1-2 min and try again.';
      panel.innerHTML = '<div class="empty" style="color:#ff6b6b;padding:20px;text-align:center;font-size:13px">' + msg + '</div>';
      btn.disabled = false; btn.textContent = 'Optimize Trailing';
    }});
}}

function runOptimize() {{
  var btn = document.getElementById('opt-btn');
  btn.disabled = true; btn.textContent = 'Optimizing...';
  startProgressPoll();
  var fd = new FormData(document.getElementById('f'));
  var url = '/api/v1/market-data/options-optimize?symbol=' + fd.get('symbol').toUpperCase()
    + '&start_date=' + fd.get('start_date')
    + '&end_date=' + fd.get('end_date')
    + '&capitalLimit=' + fd.get('capitalLimit')
    + '&positionSizing=' + (fd.get('positionSizing') || 'fixed')
    + '&riskPerTrade=' + (fd.get('riskPerTrade') || '200')
    + '&maxContractsPerTrade=' + (fd.get('maxContractsPerTrade') || '3')
    + '&minContractsPerTrade=' + (fd.get('minContractsPerTrade') || '1')
    + '&riskPctPerTrade=' + (fd.get('riskPctPerTrade') || '2')
    + '&staleAfterMinutes=' + (fd.get('staleAfterMinutes') || '0')
    + '&staleMinGainPct=' + ((parseFloat(fd.get('staleMinGainPct')) || 0) / 100)
    + '&premiumMin=' + (fd.get('premiumMin') || '0')
    + '&premiumMax=' + (fd.get('premiumMax') || '0');
  fetch(url)
    .then(r => {{
      if (!r.ok) return r.text().then(txt => {{ try {{ var j = JSON.parse(txt); throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)); }} catch(e) {{ if (e instanceof SyntaxError) throw new Error(txt); throw e; }} }});
      return r.text();
    }})
    .then(html => {{
      var panel = document.getElementById('results-panel');
      var iframe = document.createElement('iframe');
      panel.innerHTML = '';
      panel.appendChild(iframe);
      iframe.srcdoc = html;
      btn.disabled = false; btn.textContent = 'Find Best Settings';
    }})
    .catch(err => {{
      var panel = document.getElementById('results-panel');
      var msg = String(err.message || err);
      if (msg.includes('429')) msg = 'Polygon API rate limit reached. Please wait 1-2 minutes and try again.';
      panel.innerHTML = '<div class="empty" style="color:#ff6b6b;padding:20px;text-align:center;font-size:13px">' + msg + '</div>';
      btn.disabled = false; btn.textContent = 'Find Best Settings';
    }});
}}
</script>
<script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
<script>
flatpickr('#start_date', {{ dateFormat: 'Y-m-d', theme: 'dark', onChange: function() {{ saveSettings(); }} }});
flatpickr('#end_date', {{ dateFormat: 'Y-m-d', theme: 'dark', onChange: function() {{ saveSettings(); }} }});

// Listen for "Apply to Dashboard" from optimizer iframe
window.addEventListener('message', function(e) {{
  if (e.data && e.data.type === 'apply-optimizer-settings') {{
    var d = e.data;
    var f = document.getElementById('f');
    var set = function(name, val) {{
      var el = f.querySelector('[name="' + name + '"]');
      if (el) {{ el.value = val; el.dispatchEvent(new Event('input', {{bubbles:true}})); }}
    }};
    var setCheck = function(name, val) {{
      var el = f.querySelector('[name="' + name + '"]');
      if (el && el.type === 'checkbox') {{ el.checked = val; el.dispatchEvent(new Event('change', {{bubbles:true}})); }}
    }};
    if (d.profitTargetPct !== undefined) set('profitTargetPct', d.profitTargetPct);
    if (d.trailingStopPct !== undefined) set('trailingStopPct', d.trailingStopPct);
    if (d.stopLossPct !== undefined) set('stopLossPct', d.stopLossPct);
    if (d.chopFilterDiGap !== undefined) set('chopFilterDiGap', d.chopFilterDiGap);
    if (d.chopFilterAdxThreshold !== undefined) set('chopFilterAdxThreshold', d.chopFilterAdxThreshold);
    if (d.staleAfterMinutes !== undefined) set('staleAfterMinutes', d.staleAfterMinutes);
    if (d.staleMinGainPct !== undefined) set('staleMinGainPct', d.staleMinGainPct);
    if (d.chopFilterDiGap > 0 || d.chopFilterAdxThreshold > 0) setCheck('chopFilterEnabled', true);
    else setCheck('chopFilterEnabled', false);
    // Clear trailing tiers so backtest uses flat trail (matching optimizer)
    if (d.clearTiers) {{
      document.getElementById('tiers').innerHTML = '';
    }}
    saveSettings();
  }}
}});

// ── Auto-save/restore settings via localStorage ──
var STORAGE_KEY = 'backtester_settings';
var form = document.getElementById('f');

function saveSettings() {{
  var data = {{}};
  form.querySelectorAll('input, select').forEach(function(el) {{
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else data[el.name] = el.value;
  }});
  // Save tiers
  data._tiers = [];
  document.querySelectorAll('#tiers .tier').forEach(function(row) {{
    data._tiers.push({{
      above: row.querySelector('[data-field=above]').value,
      trail: row.querySelector('[data-field=trail]').value,
    }});
  }});
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}}

function restoreSettings() {{
  var raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {{
    var data = JSON.parse(raw);
    form.querySelectorAll('input, select').forEach(function(el) {{
      if (el.name in data) {{
        if (el.type === 'checkbox') el.checked = data[el.name];
        else el.value = data[el.name];
      }}
    }});
    // Restore tiers
    if (data._tiers && data._tiers.length) {{
      var container = document.getElementById('tiers');
      container.innerHTML = '';
      data._tiers.forEach(function(t) {{
        var d = document.createElement('div'); d.className='tier';
        d.innerHTML='<span>&ge;</span><input type="number" value="'+t.above+'" data-field="above" step="5"/>%<span>trail</span><input type="number" value="'+t.trail+'" data-field="trail" step="1"/>%<button type="button" onclick="this.parentElement.remove();saveSettings()">&times;</button>';
        container.appendChild(d);
      }});
    }}
    // Sync disabled state
    var teCheck = document.getElementById('timeExitEnabled');
    if (teCheck) document.getElementById('timeExitAt').disabled = !teCheck.checked;
  }} catch(e) {{}}
}}

restoreSettings();
// Re-sync flatpickr with restored values (flatpickr reads from the input element)
document.querySelectorAll('#start_date, #end_date').forEach(function(el) {{
  if (el._flatpickr) el._flatpickr.setDate(el.value, false);
}});
// Auto-save on any field change so localStorage always reflects current form state
form.addEventListener('input', saveSettings);
form.addEventListener('change', saveSettings);

// Save on any input change
form.addEventListener('input', saveSettings);
form.addEventListener('change', saveSettings);
// Also save when tiers are added/removed
new MutationObserver(saveSettings).observe(document.getElementById('tiers'), {{ childList: true, subtree: true }});
</script>
</body></html>"""
    return HTMLResponse(content=html)


@router.get("/daily-report")
async def daily_report(date: str = Query(default="", description="Date YYYY-MM-DD (empty = today)")):
    """Generate comprehensive daily auto trader HTML report."""
    from fastapi.responses import HTMLResponse
    from app.services.daily_report import generate_daily_report
    try:
        html = generate_daily_report(date_str=date if date else None)
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Daily report error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/gex-analysis")
async def gex_analysis(
    symbol: str = Query(default="SPX"),
    dte_filter: str = Query(default="0dte", description="0dte, weekly, or all (IB only)"),
    strike_range: float = Query(default=100, description="Dollar range around spot (IB only)"),
    source: str = Query(default="gexbot", description="GEX data source: 'gexbot' (Classic) or 'ib'"),
    fallback: bool = Query(default=True, description="Auto-fall-back to the other source on error"),
):
    """Return GEX levels (Call Wall / Put Wall / Gamma Flip + profile).

    By default uses GexBot's Classic view (cumulative across all expirations,
    matching the cero_gamma_v4 spec). Pass `?source=ib` to use the IB-derived
    same-day option chain instead.
    """
    from app.services.gex import get_gex_levels
    try:
        return await get_gex_levels(
            symbol=symbol, source=source, fallback=fallback,
            dte_filter=dte_filter, strike_range=strike_range,
        )
    except Exception as e:
        logger.error(f"GEX analysis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/gex-dashboard")
async def gex_dashboard():
    """GEX Dashboard UI."""
    from fastapi.responses import HTMLResponse
    html = """<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GEX Dashboard — Gamma Exposure</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f0f1a; color:#d1d4dc; font-family:-apple-system,sans-serif; padding:20px; }
  h1 { color:#fff; font-size:22px; margin-bottom:4px; }
  .sub { color:#7c8190; font-size:12px; margin-bottom:16px; }
  .controls { display:flex; gap:8px; margin-bottom:16px; align-items:center; }
  .controls select, .controls input { padding:6px 10px; background:#1a1f2e; border:1px solid #2b2b43; border-radius:5px; color:#d1d4dc; font-size:13px; }
  .controls button { padding:6px 14px; background:#ffd54f; color:#0f0f1a; border:none; border-radius:5px; font-size:13px; font-weight:600; cursor:pointer; }
  .controls button:hover { background:#ffca28; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .card { background:#1a1f2e; border:1px solid #2b2b43; border-radius:8px; padding:14px; }
  .card-full { grid-column:1/-1; }
  .stat { text-align:center; }
  .stat-value { font-size:22px; font-weight:700; color:#fff; }
  .stat-label { font-size:10px; color:#7c8190; margin-top:2px; }
  h2 { color:#ffd54f; font-size:14px; margin:0 0 10px; }
  canvas { max-height:350px; }
  .level { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12px; }
  .level-label { color:#7c8190; }
  .level-value { font-weight:600; }
  .regime-pos { color:#39d98a; }
  .regime-neg { color:#ff6b6b; }
  .error { color:#ff6b6b; text-align:center; padding:40px; font-size:14px; }
  .loading { color:#7c8190; text-align:center; padding:40px; }
  #status { font-size:11px; color:#7c8190; }
</style></head><body>

<h1>GEX Dashboard</h1>
<p class="sub">Gamma Exposure Analysis — SPX Options for SPY Trading</p>

<div class="controls">
  <select id="symbol"><option value="SPX" selected>SPX (Institutional)</option><option value="SPY">SPY</option></select>
  <select id="dte"><option value="0dte" selected>0DTE</option><option value="weekly">Weekly (≤7d)</option><option value="all">All Expirations</option></select>
  <label style="font-size:12px;color:#7c8190">Range: $</label>
  <input type="number" id="range" value="100" min="20" max="500" step="10" style="width:70px">
  <button onclick="loadGEX()">Refresh</button>
  <label style="font-size:12px;color:#7c8190"><input type="checkbox" id="autoRefresh" checked> Auto (60s)</label>
  <span id="status"></span>
</div>

<div id="content"><div class="loading">Loading GEX data...</div></div>

<script>
Chart.defaults.color = '#7c8190';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.animation = false;

var gexChart = null;
var oiChart = null;
var priceChart = null;
var priceSeries = null;
var refreshTimer = null;

function loadGEX() {
  var sym = document.getElementById('symbol').value;
  var dte = document.getElementById('dte').value;
  var range = document.getElementById('range').value;
  document.getElementById('status').textContent = 'Loading...';

  fetch('/api/v1/market-data/gex-analysis?symbol=' + sym + '&dte_filter=' + dte + '&strike_range=' + range)
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        document.getElementById('content').innerHTML = '<div class="error">' + data.error + (data.spot ? '<br>Spot: $' + data.spot : '') + '</div>';
        document.getElementById('status').textContent = 'Error';
        return;
      }
      renderDashboard(data);
      document.getElementById('status').textContent = 'Updated ' + data.timestamp;
    })
    .catch(err => {
      document.getElementById('content').innerHTML = '<div class="error">' + err.message + '</div>';
      document.getElementById('status').textContent = 'Error';
    });
}

function renderDashboard(d) {
  var cw = d.call_wall || {};
  var pw = d.put_wall || {};
  var gf = d.gamma_flip || {};
  var isPos = d.regime === 'POSITIVE_GAMMA';
  var regimeColor = isPos ? '#39d98a' : '#ff6b6b';
  var regimeText = isPos ? 'LONG GAMMA (Dampened)' : 'SHORT GAMMA (Amplified)';
  var spyLabel = d.spy_price ? ' (SPY $' + d.spy_price + ')' : '';

  var html = '<div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">';
  html += '<div class="card stat" style="flex:1;min-width:90px"><div class="stat-value">$' + d.spot + '</div><div class="stat-label">' + d.symbol + ' Spot' + spyLabel + '</div></div>';
  html += '<div class="card stat" style="flex:1;min-width:90px"><div class="stat-value" style="color:#39d98a">$' + cw.strike + '</div><div class="stat-label">Call Wall (' + (cw.distance > 0 ? '+' : '') + cw.distance + ')</div></div>';
  html += '<div class="card stat" style="flex:1;min-width:90px"><div class="stat-value" style="color:#ff6b6b">$' + pw.strike + '</div><div class="stat-label">Put Wall (' + pw.distance + ')</div></div>';
  html += '<div class="card stat" style="flex:1;min-width:90px"><div class="stat-value" style="color:#ffd54f">$' + (gf.strike || 'n/a') + '</div><div class="stat-label">Gamma Flip (' + (gf.distance != null ? (gf.distance > 0 ? '+' : '') + gf.distance : 'n/a') + ')</div></div>';
  html += '<div class="card stat" style="flex:1;min-width:90px"><div class="stat-value" style="color:' + regimeColor + '">' + regimeText + '</div><div class="stat-label">Regime</div></div>';
  html += '</div>';

  html += '<div class="grid">';

  // Price chart with GEX levels overlay
  html += '<div class="card card-full"><h2>SPY Price Action + GEX Levels</h2><div id="priceChart" style="height:300px"></div>';
  html += '<div style="font-size:10px;color:#7c8190;margin-top:6px;display:flex;gap:14px;flex-wrap:wrap">';
  html += '<span><span style="color:#39d98a">&#9644;</span> Call Wall</span>';
  html += '<span><span style="color:#ff6b6b">&#9644;</span> Put Wall</span>';
  html += '<span><span style="color:#ffd54f">- - -</span> Gamma Flip</span>';
  html += '<span><span style="color:#7c4dff">&#9644;</span> Long Gamma Nodes</span>';
  html += '<span><span style="color:#f5a623">- - -</span> Short Gamma Nodes</span>';
  html += '</div></div>';

  // GEX Profile chart
  html += '<div class="card card-full"><h2>GEX Profile by Strike</h2><canvas id="gexChart" height="140"></canvas></div>';

  // OI chart
  html += '<div class="card"><h2>Open Interest by Strike</h2><canvas id="oiChart"></canvas></div>';

  // Key levels
  html += '<div class="card"><h2>Key Levels</h2>';
  html += '<div class="level"><span class="level-label">Call Wall</span><span class="level-value" style="color:#39d98a">$' + cw.strike + ' (GEX: ' + formatGEX(cw.gex) + ')</span></div>';
  html += '<div class="level"><span class="level-label">Put Wall</span><span class="level-value" style="color:#ff6b6b">$' + pw.strike + ' (GEX: ' + formatGEX(pw.gex) + ')</span></div>';
  html += '<div class="level"><span class="level-label">Gamma Flip</span><span class="level-value" style="color:#ffd54f">$' + (gf.strike || 'n/a') + '</span></div>';
  html += '<div class="level"><span class="level-label">Net GEX</span><span class="level-value">' + formatGEX(d.net_gex) + '</span></div>';
  html += '<div class="level"><span class="level-label">Total + GEX</span><span class="level-value" style="color:#39d98a">' + formatGEX(d.total_positive_gex) + '</span></div>';
  html += '<div class="level"><span class="level-label">Total − GEX</span><span class="level-value" style="color:#ff6b6b">' + formatGEX(d.total_negative_gex) + '</span></div>';
  html += '<div class="level"><span class="level-label">Expirations</span><span class="level-value">' + (d.expirations_used || []).join(', ') + '</span></div>';
  html += '<div class="level"><span class="level-label">Strikes Analyzed</span><span class="level-value">' + d.strikes_analyzed + '</span></div>';

  // Long/Short gamma nodes
  if (d.long_gamma_nodes && d.long_gamma_nodes.length) {
    html += '<div style="margin-top:8px;font-size:11px;color:#ffd54f;font-weight:600">Long Gamma Nodes (S/R Pivots)</div>';
    d.long_gamma_nodes.forEach(function(n) {
      html += '<div class="level"><span>$' + n.strike + '</span><span>' + formatGEX(n.net_gex) + '</span></div>';
    });
  }
  html += '</div>';

  html += '</div>'; // grid

  // Destroy Lightweight Charts before replacing DOM (innerHTML wipes the container)
  if (priceChart) { priceChart.remove(); priceChart = null; priceSeries = null; window._gexPriceLines = []; }
  document.getElementById('content').innerHTML = html;

  // Render GEX chart
  var profile = d.gex_profile || [];
  var labels = profile.map(g => '$' + g.strike);
  var netData = profile.map(g => g.net_gex);
  var colors = profile.map(g => g.net_gex >= 0 ? 'rgba(57,217,138,0.7)' : 'rgba(255,107,107,0.7)');

  // Find spot position in the strike labels for the price line
  var spotPrice = d.spot || 0;
  var spotIdx = -1;
  var strikes = profile.map(g => g.strike);
  for (var i = 0; i < strikes.length; i++) {
    if (strikes[i] >= spotPrice) { spotIdx = i; break; }
  }
  // Interpolate between two strikes for precise placement
  var spotFrac = spotIdx;
  if (spotIdx > 0 && spotIdx < strikes.length) {
    var lo = strikes[spotIdx - 1], hi = strikes[spotIdx];
    if (hi !== lo) spotFrac = (spotIdx - 1) + (spotPrice - lo) / (hi - lo);
  }

  // Custom plugin to draw spot price line on the horizontal bar chart
  var spotLinePlugin = {
    id: 'spotLine',
    afterDraw: function(chart) {
      if (spotIdx < 0) return;
      var yScale = chart.scales.y;
      var ctx = chart.ctx;
      var yPos = yScale.getPixelForValue(spotFrac);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([6, 3]);
      ctx.moveTo(chart.chartArea.left, yPos);
      ctx.lineTo(chart.chartArea.right, yPos);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffd54f';
      ctx.stroke();
      // Label
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('Spot $' + spotPrice.toFixed(2), chart.chartArea.right - 4, yPos - 5);
      ctx.restore();
    }
  };

  if (gexChart) gexChart.destroy();
  gexChart = new Chart(document.getElementById('gexChart'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Net GEX',
        data: netData,
        backgroundColor: colors,
      }]
    },
    plugins: [spotLinePlugin],
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => formatGEX(v) } },
        y: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 30 } }
      }
    }
  });

  // Render OI chart
  var callOI = profile.map(g => g.call_oi);
  var putOI = profile.map(g => g.put_oi);

  if (oiChart) oiChart.destroy();
  oiChart = new Chart(document.getElementById('oiChart'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Call OI', data: callOI, backgroundColor: 'rgba(57,217,138,0.5)' },
        { label: 'Put OI', data: putOI, backgroundColor: 'rgba(255,107,107,0.5)' },
      ]
    },
    options: {
      plugins: { legend: { labels: { font: { size: 10 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, maxTicksLimit: 20, maxRotation: 90 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => (v/1000).toFixed(0) + 'K' } }
      }
    }
  });

  // ── Price Chart with GEX Levels ──
  var spyBars = d.spy_bars_5m || [];
  var priceContainer = document.getElementById('priceChart');
  if (priceContainer && spyBars.length > 0) {
    var nyTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
    var nyDateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

    // Create chart once, reuse on refresh
    if (!priceChart) {
      priceChart = LightweightCharts.createChart(priceContainer, {
        width: priceContainer.clientWidth,
        height: 300,
        layout: { background: { color: '#1a1f2e' }, textColor: '#7c8190', fontSize: 10 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
        crosshair: { vertLine: { color: 'rgba(255,255,255,0.15)' }, horzLine: { color: 'rgba(255,255,255,0.15)' } },
        rightPriceScale: { borderColor: '#2b2b43' },
        timeScale: {
          borderColor: '#2b2b43', timeVisible: true, secondsVisible: false,
          tickMarkFormatter: function(t, tickType) {
            if (tickType <= 2) return nyDateFmt.format(new Date(t * 1000));
            return nyTimeFmt.format(new Date(t * 1000));
          },
        },
        localization: {
          timeFormatter: function(t) { return nyDateFmt.format(new Date(t * 1000)) + ' ' + nyTimeFmt.format(new Date(t * 1000)); },
        },
      });
      priceSeries = priceChart.addCandlestickSeries({
        upColor: '#39d98a', downColor: '#ff6b6b',
        borderUpColor: '#39d98a', borderDownColor: '#ff6b6b',
        wickUpColor: '#39d98a', wickDownColor: '#ff6b6b',
      });
      new ResizeObserver(entries => {
        if (priceChart) priceChart.applyOptions({ width: entries[0].contentRect.width });
      }).observe(priceContainer);
    }

    // Update candle data
    priceSeries.setData(spyBars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));

    // Clear old price lines and redraw
    (window._gexPriceLines || []).forEach(function(ln) { priceSeries.removePriceLine(ln); });
    window._gexPriceLines = [];

    var isSPX = d.symbol === 'SPX';
    var cwStrike = isSPX ? cw.strike / 10 : cw.strike;
    var pwStrike = isSPX ? pw.strike / 10 : pw.strike;
    var gfStrike = gf.strike ? (isSPX ? gf.strike / 10 : gf.strike) : null;

    function addGexLine(price, color, width, style, title) {
      var ln = priceSeries.createPriceLine({ price: price, color: color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title: title });
      window._gexPriceLines.push(ln);
    }
    if (cwStrike) addGexLine(cwStrike, '#39d98a', 2, 0, 'Call Wall $' + cwStrike.toFixed(0));
    if (pwStrike) addGexLine(pwStrike, '#ff6b6b', 2, 0, 'Put Wall $' + pwStrike.toFixed(0));
    if (gfStrike) addGexLine(gfStrike, '#ffd54f', 2, 2, 'Gamma Flip $' + gfStrike.toFixed(0));

    (d.long_gamma_nodes || []).forEach(function(n) {
      var strike = isSPX ? n.strike / 10 : n.strike;
      addGexLine(strike, '#7c4dff', 1, 0, 'LGN $' + strike.toFixed(0));
    });
    (d.short_gamma_nodes || []).forEach(function(n) {
      var strike = isSPX ? n.strike / 10 : n.strike;
      addGexLine(strike, '#f5a623', 1, 2, 'SGN $' + strike.toFixed(0));
    });

    priceChart.timeScale().fitContent();
  }
}

function formatGEX(v) {
  if (v == null) return 'n/a';
  if (Math.abs(v) >= 1e9) return (v/1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

// Initial load
loadGEX();

// Auto-refresh
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(function() {
    if (document.getElementById('autoRefresh').checked) loadGEX();
  }, 60000);
}
startAutoRefresh();
</script>
</body></html>"""
    return HTMLResponse(content=html)


@router.get("/options-optimize-progress")
async def options_optimize_progress():
    """Poll optimizer progress."""
    from app.services.optimizer_progress import optimizer_progress
    return optimizer_progress


@router.get("/options-optimize")
async def options_optimize(
    symbol: str = Query(default="SPY"),
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    capitalLimit: float = Query(default=0),
    positionSizing: str = Query(default="fixed"),
    riskPerTrade: float = Query(default=200),
    maxContractsPerTrade: int = Query(default=3),
    minContractsPerTrade: int = Query(default=1),
    riskPctPerTrade: float = Query(default=2),
    staleAfterMinutes: float = Query(default=0),
    staleMinGainPct: float = Query(default=0.10),
    premiumMin: float = Query(default=0),
    premiumMax: float = Query(default=0),
):
    """Run parameter optimization sweep across all setting combinations."""
    from app.services.options_optimizer import run_optimization
    from fastapi.responses import HTMLResponse
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: run_optimization(symbol=symbol, start_date=start_date, end_date=end_date,
                                           settings_override={
                                               "capitalLimit": capitalLimit, "positionSizing": positionSizing,
                                               "riskPerTrade": riskPerTrade, "maxContractsPerTrade": maxContractsPerTrade,
                                               "minContractsPerTrade": minContractsPerTrade, "riskPctPerTrade": riskPctPerTrade,
                                               "staleAfterMinutes": staleAfterMinutes, "staleMinGainPct": staleMinGainPct,
                                               "premiumMin": premiumMin, "premiumMax": premiumMax,
                                           })
        )
        if result.get("error"):
            raise HTTPException(status_code=500, detail=result["error"])

        # Render HTML report
        top = result["top_results"]
        worst = result["worst_results"]

        # Detect if S12 params are in results
        _has_s12 = any("proximityThreshold" in r.get("params", {}) for r in top)
        _s12_hdr = "<th>Prox$</th><th>Vel$</th><th>Stop$</th>" if _has_s12 else ""

        rows = ""
        for i, r in enumerate(top):
            p = r["params"]
            pnl_color = "#39d98a" if r["total_pnl"] > 0 else "#ff6b6b"
            medal = ["&#129351;", "&#129352;", "&#129353;"][i] if i < 3 else f"#{i+1}"
            _s12_cols = f"<td>{p.get('proximityThreshold','')}</td><td>{p.get('minVelocity','')}</td><td>{p.get('stopDistance','')}</td>" if _has_s12 else ""
            rows += f"""<tr>
                <td>{medal}</td>
                <td style="color:{pnl_color};font-weight:700">${r['total_pnl']:+.0f}</td>
                <td style="color:#ff6b6b">${r.get('max_drawdown',0):.0f}</td>
                <td>{r['trades']}</td>
                <td>{r['win_rate']}%</td>
                <td>{r['profit_factor']}x</td>
                <td>${r['avg_pnl']:+.0f}</td>
                <td>{p.get('profitTargetPct',0)*100:.0f}%</td>
                <td>{p.get('trailingStopPct',0)*100:.0f}%</td>
                <td>{p.get('chopFilterDiGap',0)}</td>
                <td>{p.get('chopFilterAdxThreshold',0)}</td>
                <td>{p.get('stopLossPct',0)*100:.0f}%</td>
                <td>{p.get('staleAfterMinutes',0):.0f}m</td>
                <td>{p.get('staleMinGainPct',0)*100:.0f}%</td>
                {_s12_cols}
            </tr>"""

        worst_rows = ""
        for r in worst:
            p = r["params"]
            _s12_cols = f"<td>{p.get('proximityThreshold','')}</td><td>{p.get('minVelocity','')}</td><td>{p.get('stopDistance','')}</td>" if _has_s12 else ""
            worst_rows += f"""<tr class="muted">
                <td></td>
                <td style="color:#ff6b6b">${r['total_pnl']:+.0f}</td>
                <td style="color:#ff6b6b">${r.get('max_drawdown',0):.0f}</td>
                <td>{r['trades']}</td><td>{r['win_rate']}%</td><td>{r['profit_factor']}x</td><td>${r['avg_pnl']:+.0f}</td>
                <td>{p.get('profitTargetPct',0)*100:.0f}%</td><td>{p.get('trailingStopPct',0)*100:.0f}%</td>
                <td>{p.get('chopFilterDiGap',0)}</td><td>{p.get('chopFilterAdxThreshold',0)}</td><td>{p.get('stopLossPct',0)*100:.0f}%</td>
                <td>{p.get('staleAfterMinutes',0):.0f}m</td><td>{p.get('staleMinGainPct',0)*100:.0f}%</td>
                {_s12_cols}
            </tr>"""

        best = top[0] if top else {}
        bp = best.get("params", {})

        html = f"""<!DOCTYPE html>
<html><head><title>Optimizer — {symbol} {start_date} to {end_date}</title>
<style>
  body {{ background:#0f0f1a; color:#d1d4dc; font-family:-apple-system,sans-serif; padding:20px; }}
  h1 {{ color:#fff; font-size:20px; margin-bottom:4px; }}
  .sub {{ color:#7c8190; font-size:12px; margin-bottom:16px; }}
  .stats {{ display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; }}
  .stat {{ background:#1a1f2e; border:1px solid #2b2b43; border-radius:8px; padding:12px 16px; text-align:center; flex:1; min-width:100px; }}
  .stat-value {{ font-size:20px; font-weight:700; color:#fff; }}
  .stat-label {{ font-size:10px; color:#7c8190; }}
  table {{ width:100%; border-collapse:collapse; font-size:12px; background:#1a1f2e; border-radius:8px; overflow:hidden; }}
  th {{ text-align:left; color:#7c8190; font-weight:600; padding:8px 10px; border-bottom:1px solid #2b2b43; background:#161b28; }}
  td {{ padding:6px 10px; border-bottom:1px solid rgba(255,255,255,0.04); }}
  tr:hover {{ background:rgba(255,255,255,0.03); }}
  .muted {{ color:#555; }}
  h2 {{ color:#ffd54f; font-size:14px; margin:20px 0 8px; }}
  .best {{ background:rgba(255,213,79,0.06); border:1px solid #ffd54f33; border-radius:8px; padding:14px; margin-bottom:16px; }}
  .best-title {{ color:#ffd54f; font-size:13px; font-weight:600; margin-bottom:8px; }}
  .best-params {{ font-size:12px; display:flex; gap:16px; flex-wrap:wrap; }}
  .best-params span {{ color:#7c8190; }}
</style></head><body>
<h1>Parameter Optimization Results</h1>
<p class="sub">{symbol} &mdash; {start_date} to {end_date} &mdash; {result['total_combos']:,} combinations tested in {result['total_time_secs']:.1f}s</p>

<div class="stats">
  <div class="stat"><div class="stat-value">{result['total_combos']:,}</div><div class="stat-label">Combinations</div></div>
  <div class="stat"><div class="stat-value">{result['fetch_time_secs']:.0f}s</div><div class="stat-label">Data Fetch</div></div>
  <div class="stat"><div class="stat-value">{result['sweep_time_secs']:.1f}s</div><div class="stat-label">Sweep Time</div></div>
  <div class="stat"><div class="stat-value">{result['polygon_calls']}</div><div class="stat-label">API Calls</div></div>
</div>

<div class="best">
  <div class="best-title">Best Configuration</div>
  <div class="best-params">
    <div><span>TP:</span> {bp.get('profitTargetPct',0)*100:.0f}%</div>
    <div><span>Trail:</span> {bp.get('trailingStopPct',0)*100:.0f}%</div>
    <div><span>DI Gap:</span> {bp.get('chopFilterDiGap',0)}</div>
    <div><span>ADX:</span> {bp.get('chopFilterAdxThreshold',0)}</div>
    <div><span>Stop Loss:</span> {bp.get('stopLossPct',0)*100:.0f}%</div>
    <div><span>Stale Exit:</span> {bp.get('staleAfterMinutes',0):.0f}m / {bp.get('staleMinGainPct',0)*100:.0f}%</div>
    {"<div><span>Proximity:</span> $" + f"{bp.get('proximityThreshold',2.0)}" + "</div>" +
     "<div><span>Velocity:</span> $" + f"{bp.get('minVelocity',0.3)}" + "</div>" +
     "<div><span>Stop Dist:</span> $" + f"{bp.get('stopDistance',1.5)}" + "</div>" if _has_s12 else ""}
    <div><span>P&L:</span> <b style="color:#39d98a">${best.get('total_pnl',0):+.0f}</b></div>
    <div><span>Max DD:</span> <span style="color:#ff6b6b">${best.get('max_drawdown',0):.0f}</span></div>
    <div><span>Win Rate:</span> {best.get('win_rate',0)}%</div>
    <div><span>Profit Factor:</span> {best.get('profit_factor',0)}x</div>
  </div>
  <button onclick="applyBest()" style="margin-top:10px;padding:6px 16px;background:#ffd54f;color:#0f0f1a;border:none;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer">Apply to Dashboard</button>
</div>
<script>
function applyBest() {{
  window.parent.postMessage({{
    type: 'apply-optimizer-settings',
    profitTargetPct: {bp.get('profitTargetPct',0)*100},
    trailingStopPct: {bp.get('trailingStopPct',0)*100},
    chopFilterDiGap: {bp.get('chopFilterDiGap',0)},
    chopFilterAdxThreshold: {bp.get('chopFilterAdxThreshold',0)},
    stopLossPct: {bp.get('stopLossPct',0)*100},
    staleAfterMinutes: {bp.get('staleAfterMinutes',0)},
    staleMinGainPct: {bp.get('staleMinGainPct',0)*100},
    clearTiers: true,
  }}, '*');
}}
</script>

<h2>Top {len(top)} Configurations</h2>
<table>
  <tr><th>#</th><th>P&L</th><th>DD</th><th>Trades</th><th>Win%</th><th>PF</th><th>Avg</th><th>TP%</th><th>Trail%</th><th>DI Gap</th><th>ADX</th><th>SL%</th><th>Stale</th><th>Min%</th>{_s12_hdr}</tr>
  {rows}
</table>

<h2>Worst 5 Configurations</h2>
<table>
  <tr><th>#</th><th>P&L</th><th>DD</th><th>Trades</th><th>Win%</th><th>PF</th><th>Avg</th><th>TP%</th><th>Trail%</th><th>DI Gap</th><th>ADX</th><th>SL%</th><th>Stale</th><th>Min%</th>{_s12_hdr}</tr>
  {worst_rows}
</table>
</body></html>"""
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Optimizer error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/options-optimize-trailing")
async def options_optimize_trailing(
    symbol: str = Query(default="SPY"),
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    profitTargetPct: float = Query(default=0.30),
    chopFilterDiGap: float = Query(default=0),
    chopFilterAdxThreshold: float = Query(default=15),
    stopLossPct: float = Query(default=0),
    capitalLimit: float = Query(default=0),
    positionSizing: str = Query(default="fixed"),
    riskPerTrade: float = Query(default=200),
    maxContractsPerTrade: int = Query(default=3),
    minContractsPerTrade: int = Query(default=1),
    riskPctPerTrade: float = Query(default=2),
    staleAfterMinutes: float = Query(default=0),
    staleMinGainPct: float = Query(default=0.10),
    premiumMin: float = Query(default=0),
    premiumMax: float = Query(default=0),
):
    """Run trailing tier optimization with locked base settings."""
    from app.services.options_optimizer import run_trailing_optimization
    from fastapi.responses import HTMLResponse
    try:
        base = {
            "profitTargetPct": profitTargetPct,
            "chopFilterDiGap": chopFilterDiGap,
            "chopFilterAdxThreshold": chopFilterAdxThreshold,
            "stopLossPct": stopLossPct,
            "capitalLimit": capitalLimit,
            "positionSizing": positionSizing,
            "riskPerTrade": riskPerTrade,
            "maxContractsPerTrade": maxContractsPerTrade,
            "minContractsPerTrade": minContractsPerTrade,
            "riskPctPerTrade": riskPctPerTrade,
            "staleAfterMinutes": staleAfterMinutes,
            "staleMinGainPct": staleMinGainPct,
            "premiumMin": premiumMin,
            "premiumMax": premiumMax,
        }
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: run_trailing_optimization(
                symbol=symbol, start_date=start_date, end_date=end_date,
                base_settings=base,
            )
        )
        if result.get("error"):
            raise HTTPException(status_code=500, detail=result["error"])

        presets = result["results"]
        bp = result.get("base_settings", {})

        rows = ""
        for i, r in enumerate(presets):
            pnl_color = "#39d98a" if r["total_pnl"] > 0 else "#ff6b6b"
            medal = ["&#129351;", "&#129352;", "&#129353;"][i] if i < 3 else f"#{i+1}"
            tiers_str = " → ".join(f'{t["above"]*100:.0f}%:{t["trail"]*100:.0f}%' for t in r["tiers"]) if r["tiers"] else "flat"
            exit_summary = ", ".join(f'{k}: {v}' for k, v in sorted(r.get("exit_reasons", {}).items(), key=lambda x: -x[1]))
            rows += f"""<tr>
                <td>{medal}</td>
                <td style="font-weight:600">{r['name']}</td>
                <td style="color:{pnl_color};font-weight:700">${r['total_pnl']:+.0f}</td>
                <td>{r['trades']}</td>
                <td>{r['win_rate']}%</td>
                <td>{r['profit_factor']}x</td>
                <td>${r['avg_pnl']:+.0f}</td>
                <td>{r['avg_capture_pct']}%</td>
                <td class="muted" style="font-size:10px">{tiers_str}</td>
                <td class="muted" style="font-size:10px">{exit_summary}</td>
            </tr>"""

        best = presets[0] if presets else {}
        best_tiers_str = " → ".join(f'≥{t["above"]*100:.0f}%: trail {t["trail"]*100:.0f}%' for t in best.get("tiers", [])) or "flat"

        html = f"""<!DOCTYPE html>
<html><head><title>Trailing Optimizer — {symbol}</title>
<style>
  body {{ background:#0f0f1a; color:#d1d4dc; font-family:-apple-system,sans-serif; padding:20px; }}
  h1 {{ color:#fff; font-size:20px; margin-bottom:4px; }}
  .sub {{ color:#7c8190; font-size:12px; margin-bottom:16px; }}
  table {{ width:100%; border-collapse:collapse; font-size:12px; background:#1a1f2e; border-radius:8px; overflow:hidden; }}
  th {{ text-align:left; color:#7c8190; font-weight:600; padding:8px 10px; border-bottom:1px solid #2b2b43; background:#161b28; }}
  td {{ padding:6px 10px; border-bottom:1px solid rgba(255,255,255,0.04); }}
  tr:hover {{ background:rgba(255,255,255,0.03); }}
  .muted {{ color:#555; }}
  h2 {{ color:#ffd54f; font-size:14px; margin:20px 0 8px; }}
  .best {{ background:rgba(255,213,79,0.06); border:1px solid #ffd54f33; border-radius:8px; padding:14px; margin-bottom:16px; }}
  .best-title {{ color:#ffd54f; font-size:13px; font-weight:600; margin-bottom:6px; }}
  .best-detail {{ font-size:12px; margin:3px 0; }}
  .best-detail span {{ color:#7c8190; }}
  .base {{ background:#1a1f2e; border:1px solid #2b2b43; border-radius:8px; padding:10px 14px; margin-bottom:12px; font-size:12px; display:flex; gap:16px; flex-wrap:wrap; }}
  .base span {{ color:#7c8190; }}
</style></head><body>
<h1>Trailing Tier Optimization</h1>
<p class="sub">{symbol} — {start_date} to {end_date} — {result['presets_tested']} presets × {result['total_trades_per_preset']} trades — sweep: {result['sweep_time_secs']*1000:.0f}ms</p>

<div class="base">
  <div><span>Base settings (locked):</span></div>
  <div><span>TP:</span> {bp.get('profitTargetPct',0)*100:.0f}%</div>
  <div><span>DI Gap:</span> {bp.get('chopFilterDiGap',0)}</div>
  <div><span>ADX:</span> {bp.get('chopFilterAdxThreshold',0)}</div>
  <div><span>Stop Loss:</span> {bp.get('stopLossPct',0)*100:.0f}%</div>
</div>

<div class="best">
  <div class="best-title">Best Trailing Configuration: {best.get('name','')}</div>
  <div class="best-detail"><span>Tiers:</span> {best_tiers_str}</div>
  <div class="best-detail"><span>P&L:</span> <b style="color:#39d98a">${best.get('total_pnl',0):+.0f}</b> | <span>Win Rate:</span> {best.get('win_rate',0)}% | <span>Avg Capture:</span> {best.get('avg_capture_pct',0)}% of peak</div>
</div>

<h2>All Presets Ranked</h2>
<table>
  <tr><th>#</th><th>Preset</th><th>P&L</th><th>Trades</th><th>Win%</th><th>PF</th><th>Avg P&L</th><th>Capture</th><th>Tiers</th><th>Exit Reasons</th></tr>
  {rows}
</table>
</body></html>"""
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Trailing optimizer error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/options-backtest")
async def options_backtest_get(
    symbol: str = Query(default="SPY"),
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    output: str = Query(default="html", description="Response format: html or json"),
):
    """Run options backtest using real Polygon option premiums (GET — uses live settings)."""
    import traceback
    from app.services.options_backtester import run_backtest
    try:
        result = run_backtest(symbol=symbol, start_date=start_date, end_date=end_date)
        if result.get("error"):
            raise HTTPException(status_code=500, detail=result["error"])
        if output == "json":
            return result
        from app.services.options_backtest_report import render_report
        from fastapi.responses import HTMLResponse
        html = render_report(result)
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Options backtest error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-500:]}")


@router.post("/options-backtest")
async def options_backtest_post(
    symbol: str = Query(default="SPY"),
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    output: str = Query(default="html", description="Response format: html or json"),
    settings_override: dict = Body(default={}),
):
    """Run options backtest with custom settings (POST — independent of live settings)."""
    import traceback
    from app.services.options_backtester import run_backtest
    try:
        logger.info(f"Backtest POST: symbol={symbol} start={start_date} end={end_date} override_keys={list(settings_override.keys()) if settings_override else 'None'}")
        logger.info(f"Backtest POST: settings_override={json.dumps(settings_override, default=str)[:500]}")
        _s = settings_override if settings_override else None
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: run_backtest(symbol=symbol, start_date=start_date, end_date=end_date, settings_override=_s)
        )
        if result.get("error"):
            raise HTTPException(status_code=500, detail=result["error"])
        if output == "json":
            return result
        from app.services.options_backtest_report import render_report
        from fastapi.responses import HTMLResponse
        html = render_report(result)
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Options backtest error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-500:]}")


@router.get("/spy-analysis-report")
async def spy_analysis_report():
    """Generate a comprehensive SPY options analysis HTML report."""
    from fastapi.responses import HTMLResponse
    from app.services.spy_analysis_report import generate_report
    try:
        html = await generate_report()
        return HTMLResponse(content=html)
    except Exception as e:
        logger.error(f"Error generating SPY analysis report: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/chart-diag")
async def chart_diagnostic(symbol: str = "SPY"):
    """Quick diagnostic: fetch bars and report lag."""
    from datetime import datetime, timezone
    from app.services.ib.gateway import ib_manager

    try:
        port = ib_manager.active_port
        mode = ib_manager.active_mode
        connected = ib_manager.is_connected()

        if not connected:
            return {"error": "IB not connected", "mode": mode, "port": port}

        now_utc = datetime.now(timezone.utc)
        result = {"symbol": symbol, "mode": mode, "port": port, "connected": connected,
                  "now_utc": now_utc.isoformat()}

        # --- Equity bars check ---
        bars = await get_historical_bars(symbol, "1m", bars_count=5, use_rth=False)
        if bars:
            latest_ts = bars[-1]["time"]
            latest_dt = datetime.fromtimestamp(latest_ts, tz=timezone.utc)
            lag_sec = (now_utc - latest_dt).total_seconds()
            result["bars"] = {
                "latest_bar_utc": latest_dt.isoformat(),
                "lag_minutes": round(lag_sec / 60, 1),
                "status": "DELAYED" if lag_sec > 120 else "REALTIME",
            }

        # --- Option quote check ---
        try:
            from ib_insync import Stock, Option
            ib = await ib_manager.get_connection()
            ib.reqMarketDataType(1)
            stock = Stock(symbol, "SMART", "USD")
            await ib.qualifyContractsAsync(stock)
            chains = await ib.reqSecDefOptParamsAsync(stock.symbol, "", stock.secType, stock.conId)
            if chains:
                chain = next((c for c in chains if c.exchange == "SMART"), chains[0])
                exp = sorted(chain.expirations)[0]
                # Find ATM strike
                stock_ticker = await asyncio.wait_for(
                    asyncio.ensure_future(ib.reqTickersAsync(stock)), timeout=5
                )
                spot = stock_ticker[0].marketPrice() if stock_ticker else 654
                strike = min(chain.strikes, key=lambda s: abs(s - spot))
                opt = Option(symbol, exp, strike, "C", "SMART")
                await ib.qualifyContractsAsync(opt)
                [opt_ticker] = await ib.reqTickersAsync(opt)
                bid = opt_ticker.bid if opt_ticker.bid and opt_ticker.bid > 0 else None
                ask = opt_ticker.ask if opt_ticker.ask and opt_ticker.ask > 0 else None
                last = opt_ticker.last if opt_ticker.last and opt_ticker.last > 0 else None
                result["option_quote"] = {
                    "contract": f"{symbol} {exp} {strike}C",
                    "bid": bid, "ask": ask, "last": last,
                    "has_data": bid is not None or ask is not None or last is not None,
                    "ticker_time": str(opt_ticker.time) if hasattr(opt_ticker, 'time') and opt_ticker.time else None,
                }
        except Exception as e:
            result["option_quote"] = {"error": str(e)}

        return result
    except Exception as e:
        return {"error": str(e), "mode": getattr(ib_manager, 'active_mode', 'unknown'),
                "port": getattr(ib_manager, 'active_port', 'unknown')}


@router.get(
    "/historical",
    response_model=HistoricalDataResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_historical_data(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
    interval: str = Query(
        default="5m", description="Timeframe interval (e.g., 1m, 5m, 1h, 1d)"
    ),
    bars_count: int = Query(
        default=500, description="Number of bars to fetch", ge=1, le=2000
    ),
    con_id: int | None = Query(default=None, description="Optional IB contract ID"),
    sec_type: str | None = Query(default=None, description="Optional IB security type"),
    exchange: str | None = Query(default=None, description="Optional IB exchange"),
    currency: str | None = Query(default=None, description="Optional IB currency"),
    use_rth: bool = Query(default=True, description="Use regular trading hours only"),
):
    """
    Fetch historical OHLCV bars for a symbol.

    Args:
        symbol: Stock symbol
        interval: Timeframe interval
        bars_count: Number of bars to return

    Returns:
        Historical bars data
    """
    try:
        # Validate symbol (skip when conId provided)
        symbol = symbol.upper()
        if con_id is None:
            is_valid = await validate_symbol(symbol)
            if not is_valid:
                raise HTTPException(status_code=400, detail=f"Invalid symbol: {symbol}")

        # Validate interval
        supported_intervals = get_supported_timeframes()
        if interval not in supported_intervals:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid interval: {interval}. Supported: {', '.join(supported_intervals)}",
            )

        # Fetch data
        bars_data = await get_historical_bars(
            symbol,
            interval,
            bars_count,
            con_id=con_id,
            sec_type=sec_type,
            exchange=exchange,
            currency=currency,
            use_rth=use_rth,
        )

        return HistoricalDataResponse(
            symbol=symbol,
            interval=interval,
            bars=[Bar(**bar) for bar in bars_data],
            count=len(bars_data),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching historical data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/timeframes", response_model=list[str])
async def get_timeframes():
    """Get list of supported timeframe intervals."""
    return get_supported_timeframes()


@router.get("/validate-symbol")
async def check_symbol(symbol: str = Query(..., description="Symbol to validate")):
    """
    Validate if a symbol exists and can be traded.

    Args:
        symbol: Stock symbol to validate

    Returns:
        Validation result
    """
    try:
        symbol = symbol.upper()
        is_valid = await validate_symbol(symbol)
        return {"symbol": symbol, "valid": is_valid}
    except Exception as e:
        logger.error(f"Error validating symbol: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-symbols")
async def search_symbols_endpoint(
    query: str = Query(..., description="Symbol or company name to search"),
    max_results: int = Query(default=20, ge=1, le=50),
):
    """
    Search symbols using IB Gateway.
    """
    try:
        results = await search_symbols(query, max_results)
        return {"query": query, "results": results}
    except Exception as e:
        logger.error(f"Error searching symbols: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ib-metrics")
async def get_ib_metrics():
    """Return IB Gateway request/response metrics."""
    return ib_metrics_snapshot()


@router.get(
    "/options-chain",
    response_model=OptionChainResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_options_chain(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
):
    """
    Fetch option expirations and strikes for a symbol.
    """
    try:
        symbol = symbol.upper()
        is_valid = await validate_symbol(symbol)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid symbol: {symbol}")

        expirations = await get_option_chain(symbol)
        return OptionChainResponse(
            symbol=symbol,
            expirations=[OptionChainExpiration(**exp) for exp in expirations],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching option chain: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/options-quotes",
    response_model=OptionQuotesResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_options_quotes(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
    expiration: str = Query(..., description="Expiration date YYYY-MM-DD"),
    strikes: str = Query(..., description="Comma-separated strikes"),
    limit: int = Query(default=40, ge=1, le=200, description="Max strikes to fetch"),
):
    """
    Fetch option quotes (last/bid/ask/oi/iv) for calls and puts at given strikes.
    """
    try:
        symbol = symbol.upper()
        is_valid = await validate_symbol(symbol)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid symbol: {symbol}")

        strike_list = [float(s) for s in strikes.split(",") if s.strip()]
        if not strike_list:
            raise HTTPException(status_code=400, detail="Strikes list is empty")

        quotes = await get_option_quotes(symbol, expiration, strike_list, limit=limit)
        return OptionQuotesResponse(
            symbol=symbol,
            expiration=expiration,
            quotes=[OptionQuote(**quote) for quote in quotes],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching option quotes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/finviz-recom-target",
    response_model=FinvizRecomTargetResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_finviz_recom_target(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
):
    """
    Scrape Finviz for analyst recommendation and target price.
    """
    try:
        symbol = symbol.upper()
        data = fetch_finviz_recom_target(symbol)
        return FinvizRecomTargetResponse(
            symbol=symbol,
            recom=data.get("recom"),
            target_price=data.get("target_price"),
            cached_at=data.get("cached_at"),
        )
    except Exception as e:
        logger.error(f"Error fetching Finviz data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/earnings",
    response_model=EarningsResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_earnings(symbol: str = Query(..., description="Stock symbol (e.g., SPY)")):
    """
    Fetch earnings date from IB fundamentals (CalendarReport).
    """
    try:
        symbol = symbol.upper()
        is_valid = await validate_symbol(symbol)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid symbol: {symbol}")
        earnings_date = await get_earnings_date(symbol)
        return EarningsResponse(symbol=symbol, earnings_date=earnings_date, cached_at=None)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching earnings date: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/strategy-settings",
    response_model=StrategySettingsResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def get_strategy_settings(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
):
    try:
        symbol = symbol.upper()
        data = get_settings(symbol)
        return StrategySettingsResponse(symbol=symbol, settings=data)
    except Exception as e:
        logger.error(f"Error fetching strategy settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put(
    "/strategy-settings",
    response_model=StrategySettingsResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def save_strategy_settings(
    symbol: str = Query(..., description="Stock symbol (e.g., SPY)"),
    settings: dict = Body(...),
):
    try:
        symbol = symbol.upper()
        if settings is None:
            raise HTTPException(status_code=400, detail="settings payload required")
        set_settings(symbol, settings)
        return StrategySettingsResponse(symbol=symbol, settings=settings)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving strategy settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/trading/orders",
    response_model=OrdersResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_orders(limit: int = Query(default=200, ge=1, le=2000)):
    import asyncio
    from fastapi.responses import JSONResponse
    try:
        loop = asyncio.get_event_loop()
        entries = await loop.run_in_executor(None, read_entries, limit)
        open_positions = await loop.run_in_executor(None, build_open_positions, entries)
        return JSONResponse({
            "orders": entries,
            "open_positions": open_positions,
            "count": len(entries),
        })
    except Exception as e:
        logger.error(f"Error reading orders log: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/trading/orders/summary",
    response_model=OrdersSummaryResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_orders_summary(limit: int = Query(default=2000, ge=1, le=5000)):
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        entries = await loop.run_in_executor(None, read_entries, limit)
        summary = await loop.run_in_executor(None, summarize, entries)
        return OrdersSummaryResponse(**summary)
    except Exception as e:
        logger.error(f"Error summarizing orders log: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/trading/ib-orders",
    response_model=IbOrdersResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_ib_orders(limit: int = Query(default=200, ge=1, le=2000)):
    try:
        orders = await get_ib_orders_history(limit=limit)
        return IbOrdersResponse(orders=orders)
    except Exception as e:
        logger.error(f"Error fetching IB orders: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/trading/orders/clear",
    responses={500: {"model": ErrorResponse}},
)
async def clear_orders():
    """Clear local orders log and derived P&L."""
    try:
        archive_path = archive_entries()
        clear_entries()
        auto_trader.clear_trade_state()
        return {"ok": True, "archive_path": archive_path}
    except Exception as e:
        logger.error(f"Error clearing orders log: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/trading/order",
    response_model=OrderLogEntry,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def submit_trade_order(payload: TradeOrderRequest):
    try:
        symbol = payload.symbol.upper()
        if payload.quantity <= 0:
            raise HTTPException(status_code=400, detail="quantity must be > 0")
        result = await place_option_order(
            symbol=symbol,
            expiration=payload.expiration,
            strike=payload.strike,
            right=payload.right,
            action=payload.action,
            quantity=payload.quantity,
        )
        if isinstance(result, dict) and "trade" in result:
            result = {k: v for k, v in result.items() if k != "trade"}
        entry = {
            "timestamp": int(time.time()),
            "symbol": symbol,
            "action": payload.action,
            "right": payload.right,
            "expiration": payload.expiration,
            "strike": payload.strike,
            "quantity": payload.quantity,
            "price": payload.price,
            "status": payload.status or result.get("status"),
            "strategy_id": payload.strategy_id,
            "signal_id": payload.signal_id,
            "position_id": payload.position_id,
            "pnl": payload.pnl,
            "pnl_pct": payload.pnl_pct,
            "type": payload.type,
            "entry_price": payload.entry_price,
            "target_price": payload.target_price,
        }
        from app.services.trading_log import append_entry

        append_entry(entry)
        return OrderLogEntry(**entry)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error submitting trade order: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/trading/positions",
    response_model=IbPositionsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_trading_positions(force: bool = Query(False, description="Force a fresh snapshot from IB Gateway")):
    """Get current IBKR positions."""
    try:
        positions = await get_open_positions(force=force)
        return IbPositionsResponse(positions=positions)
    except Exception as e:
        logger.error(f"Error fetching IB positions: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/trading/account-summary",
    response_model=IbAccountSummaryResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_account_summary_endpoint():
    """Get IBKR account summary for the currently selected account."""
    try:
        summary = await get_account_summary(account=_active_ib_account())
        return IbAccountSummaryResponse(**summary)
    except Exception as e:
        logger.error(f"Error fetching account summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/trading/account-summary/raw")
async def get_account_summary_raw():
    """Debug: return all raw account summary items from IBKR."""
    from app.services.ib.trading import start_account_summary_listener, _account_summary_started
    if not _account_summary_started:
        await start_account_summary_listener()
        import asyncio
        await asyncio.sleep(2.0)
    return {"items": list(_account_summary_items.values())}


@router.get(
    "/trading/worker/status",
    response_model=AutoTraderStatusResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_worker_status():
    """Get auto-trader worker status."""
    return AutoTraderStatusResponse(**auto_trader.status())


@router.get(
    "/trading/worker/events",
    response_model=AutoTraderEventsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_worker_events(limit: int = Query(default=2000, ge=1, le=5000)):
    """Get recent auto-trader activity events.

    Returns a raw JSONResponse to avoid Pydantic validation overhead on
    up to 2000 events every 5 seconds.

    Supplements ring buffer with signal_skipped events from the file log
    since high-frequency scan events can evict them from the buffer.
    """
    from fastapi.responses import JSONResponse
    from app.services.auto_trader_log import read_events as read_file_events

    events = auto_trader.events(limit)

    # Supplement ring buffer with signal_skipped events from the file log.
    # High-frequency scan events (3 per 30s cycle) evict signal_skipped from
    # the 2000-entry ring buffer within ~3 hours.
    ring_skip_ids = {
        (e.get("timestamp"), e.get("details", {}).get("signal_id"))
        for e in events if e.get("type") == "signal_skipped"
    }
    file_events = read_file_events(limit=2000)
    for skip in file_events:
        if skip.get("type") != "signal_skipped":
            continue
        key = (skip.get("timestamp"), skip.get("details", {}).get("signal_id"))
        if key not in ring_skip_ids:
            events.append(skip)
            ring_skip_ids.add(key)
    events.sort(key=lambda e: e.get("timestamp", 0))
    events = events[-limit:]

    return JSONResponse({"events": events})


@router.get(
    "/trading/worker/settings",
    response_model=AutoTraderSettingsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_worker_settings():
    """Get auto-trader settings."""
    settings = get_auto_trader_settings()
    return AutoTraderSettingsResponse(settings=AutoTraderSettings(**settings))


@router.post(
    "/trading/worker/settings",
    response_model=AutoTraderSettingsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def update_worker_settings(payload: AutoTraderSettings):
    """Update auto-trader settings, switching trading mode if it changed."""
    new_mode = payload.tradingMode or "paper"
    if new_mode != ib_manager.active_mode:
        if auto_trader._task is not None and not auto_trader._task.done():
            raise HTTPException(status_code=400, detail="Stop the auto-trader before switching trading mode.")
        new_port = PAPER_PORT if new_mode == "paper" else LIVE_PORT
        try:
            await stop_account_summary_listener()
            _account_summary_items.clear()
            await ib_manager.switch_port(new_port)
            auto_trader.clear_trade_state()
            auto_trader.reset_capital_spent()
            auto_trader._bars_cache.clear()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to switch to {new_mode} mode: {exc}")
    settings = save_auto_trader_settings(payload.model_dump())
    return AutoTraderSettingsResponse(settings=AutoTraderSettings(**settings))


@router.post(
    "/trading/worker/start",
    response_model=AutoTraderStatusResponse,
    responses={500: {"model": ErrorResponse}},
)
async def start_worker():
    """Start auto-trader worker."""
    await auto_trader.start()
    return AutoTraderStatusResponse(**auto_trader.status())


@router.post(
    "/trading/worker/stop",
    response_model=AutoTraderStatusResponse,
    responses={500: {"model": ErrorResponse}},
)
async def stop_worker():
    """Stop auto-trader worker."""
    await auto_trader.stop()
    return AutoTraderStatusResponse(**auto_trader.status())


@router.post(
    "/trading/worker/reset-capital",
    response_model=AutoTraderStatusResponse,
    responses={500: {"model": ErrorResponse}},
)
async def reset_capital():
    """Reset the cumulative capital-spent counter."""
    auto_trader.reset_capital_spent()
    return AutoTraderStatusResponse(**auto_trader.status())


@router.post(
    "/trading/worker/flush-position/{position_id}",
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def flush_position(position_id: str, close_price: float | None = None):
    """Remove a tracked open position and write a synthetic CLOSE log entry.
    Use when a position was closed outside the auto-trader (e.g. manually)
    so the auto-trader stops trying to manage it.
    Pass close_price to record actual sell price and compute P&L.
    """
    found = auto_trader.flush_position(position_id, close_price=close_price)
    if not found:
        raise HTTPException(status_code=404, detail=f"Position '{position_id}' not found in auto-trader tracking.")
    return {"ok": True, "position_id": position_id}


@router.post(
    "/trading/switch-mode",
    response_model=SwitchModeResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def switch_trading_mode(payload: SwitchModeRequest):
    """Switch between paper (port 4002) and live (port 4001) IB Gateway."""
    if payload.mode not in ("paper", "live"):
        raise HTTPException(status_code=400, detail="mode must be 'paper' or 'live'")
    if auto_trader._task is not None and not auto_trader._task.done():
        raise HTTPException(
            status_code=400,
            detail="Stop the auto-trader before switching trading mode.",
        )
    new_port = PAPER_PORT if payload.mode == "paper" else LIVE_PORT
    try:
        await stop_account_summary_listener()
        _account_summary_items.clear()
        await ib_manager.switch_port(new_port)
        # Clear auto-trader state — positions belong to the previous account
        auto_trader.clear_trade_state()
        auto_trader.reset_capital_spent()
        auto_trader._bars_cache.clear()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to connect to IB Gateway on port {new_port}: {exc}")
    return SwitchModeResponse(
        mode=ib_manager.active_mode,
        port=ib_manager.active_port,
        connected=ib_manager.is_connected(),
    )


@router.get(
    "/trading/mode",
    response_model=SwitchModeResponse,
)
async def get_trading_mode():
    """Return the current trading mode (paper or live)."""
    return SwitchModeResponse(
        mode=ib_manager.active_mode,
        port=ib_manager.active_port,
        connected=ib_manager.is_connected(),
    )


@router.get(
    "/trading/accounts",
    response_model=TradingAccountsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_trading_accounts():
    """Return managed accounts with their types for the current IB connection."""
    try:
        ib = await ib_manager.get_connection()
        account_ids = ib.managedAccounts()
        # Build a map of account -> AccountType from account values
        type_map: dict[str, str] = {}
        try:
            values = ib.accountValues()
            for v in values:
                if getattr(v, "tag", None) == "AccountType" and getattr(v, "account", None):
                    type_map[v.account] = v.value
        except Exception:
            pass
        accounts = [
            IbAccountInfo(account=acct, account_type=type_map.get(acct))
            for acct in account_ids
        ]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch accounts: {exc}")
    return TradingAccountsResponse(
        accounts=accounts,
        current_mode=ib_manager.active_mode,
    )


@router.post(
    "/trading/close-position",
    response_model=ClosePositionResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def close_position_endpoint(payload: ClosePositionRequest):
    """Close a single IBKR position (stock or option) at market."""
    try:
        action = "SELL" if payload.quantity > 0 else "BUY"
        result = await close_position(
            symbol=payload.symbol,
            sec_type=payload.sec_type,
            quantity=payload.quantity,
            exchange=payload.exchange or "SMART",
            currency=payload.currency or "USD",
            expiration=payload.expiration,
            strike=payload.strike,
            right=payload.right,
            account=_active_ib_account(),
        )
        return ClosePositionResponse(
            symbol=payload.symbol,
            sec_type=payload.sec_type,
            action=action,
            quantity=int(abs(payload.quantity)),
            order_id=result.get("order_id"),
            status=result.get("status"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post(
    "/trading/close-all-positions",
    response_model=CloseAllPositionsResponse,
    responses={500: {"model": ErrorResponse}},
)
async def close_all_positions_endpoint():
    """Close all open IBKR positions at market price."""
    try:
        results = await close_all_positions(account=_active_ib_account())
        return CloseAllPositionsResponse(
            results=[CloseAllPositionsResult(**r) for r in results]
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get(
    "/trading/favorites",
    response_model=FavoritesResponse,
    responses={500: {"model": ErrorResponse}},
)
async def get_trading_favorites():
    """Get favorites for auto-trader filtering."""
    return FavoritesResponse(favorites=get_favorites())


@router.post(
    "/trading/favorites",
    response_model=FavoritesResponse,
    responses={500: {"model": ErrorResponse}},
)
async def update_trading_favorites(payload: FavoritesPayload):
    """Update favorites for auto-trader filtering."""
    favorites = save_favorites(payload.favorites)
    return FavoritesResponse(favorites=favorites)


@router.get(
    "/strategy-report",
    responses={500: {"model": ErrorResponse}},
)
async def get_strategy_report(
    start_date: str | None = None,
    end_date: str | None = None,
    mode: str | None = Query(default=None, description="Filter by trading mode: 'paper' or 'live'. Omit for all."),
    include_post_exit: bool = Query(default=False, description="Include post-exit opportunity analysis (requires many IB calls, slow)."),
):
    """Compute strategy performance analysis from archived trade logs."""
    if mode is not None and mode not in ("paper", "live"):
        raise HTTPException(status_code=400, detail="mode must be 'paper' or 'live'")
    try:
        return await compute_report(start_date=start_date, end_date=end_date, mode=mode, include_post_exit=include_post_exit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/trading/position-tp-overrides")
async def get_position_tp_overrides():
    """Get all per-position TP overrides."""
    return {"overrides": position_tp_overrides.get_all_overrides()}


@router.get("/trading/position-tp-override/{signal_id}")
async def get_position_tp_override(signal_id: str):
    """Get TP override for a specific position."""
    override = position_tp_overrides.get_override(signal_id)
    return {"signal_id": signal_id, "override": override}


@router.post("/trading/position-tp-override/{signal_id}")
async def set_position_tp_override(
    signal_id: str,
    profitTargetPct: float = Body(..., description="Custom profit target (e.g., 0.08 for 8%)"),
    useTrailingStop: Optional[bool] = Body(None, description="Whether to use trailing stop"),
    trailingStopPct: Optional[float] = Body(None, description="Trailing stop percentage (e.g., 0.03 for 3%)"),
):
    """Set custom TP settings for a specific position.
    
    Example:
        {"profitTargetPct": 0.08, "useTrailingStop": false}
        Sets position to 8% fixed TP without trailing stop
    """
    settings = {"profitTargetPct": profitTargetPct}
    
    if useTrailingStop is not None:
        settings["useTrailingStop"] = useTrailingStop
        
    if trailingStopPct is not None:
        settings["trailingStopPct"] = trailingStopPct
    
    saved = position_tp_overrides.set_override(signal_id, settings)
    return {"signal_id": signal_id, "override": saved}


@router.delete("/trading/position-tp-override/{signal_id}")
async def delete_position_tp_override(signal_id: str):
    """Delete TP override for a position (reverts to global/symbol settings)."""
    deleted = position_tp_overrides.delete_override(signal_id)
    return {"signal_id": signal_id, "deleted": deleted}


@router.get("/backtest")
async def backtest(
    symbol: str = Query(..., description="Ticker to analyze"),
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    lookback_days: int = Query(default=10, description="Days before date for indicator warmup", ge=1, le=30),
    enabled_strategies: str = Query(default="", description="Comma-separated strategy numbers to run (empty = all)"),
):
    """Run backtest analysis for a specific symbol and date.

    Fetches historical bars for all intervals, runs strategy analysis,
    and returns bars + signals for the selected date.

    Args:
        symbol: Ticker symbol (e.g., "SPY")
        date: Date to backtest in YYYY-MM-DD format
        lookback_days: Number of days before date to fetch for indicator warmup

    Returns:
        - bars: Dict of bars for each interval (1d, 1h, 15m, 5m, 1m)
        - signals: List of detected signals within the selected date
        - date_range: Start/end timestamps for the selected date (9:30 AM - 4:00 PM ET)
    """
    try:
        # Parse date string to get Unix timestamp range for selected day
        ny_tz = ZoneInfo("America/New_York")
        target_date = datetime.strptime(date, "%Y-%m-%d")
        target_date_ny = target_date.replace(tzinfo=ny_tz)

        # Market hours: 9:30 AM - 4:00 PM ET
        market_open = target_date_ny.replace(hour=9, minute=30, second=0, microsecond=0)
        market_close = target_date_ny.replace(hour=16, minute=0, second=0, microsecond=0)

        start_unix = int(market_open.timestamp())
        end_unix = int(market_close.timestamp())

        # Fetch historical bars for all intervals with lookback
        # Use parallel fetching for performance
        import asyncio

        # Calculate lookback start time (lookback_days before market open)
        lookback_start = market_open - timedelta(days=lookback_days)
        lookback_start_unix = int(lookback_start.timestamp())

        # Calculate how many days back from today to the selected date
        now = datetime.now(ny_tz)
        days_ago = (now - target_date_ny).days

        # Calculate bars needed to cover from selected date to now + lookback
        # Add extra bars to ensure we have enough data
        def calculate_bars_needed(interval: str, days_back: int) -> int:
            """Calculate how many bars needed to cover the date range."""
            # Base bars needed for the date range
            if interval == "1d":
                return max(200, days_back + lookback_days + 50)  # Need 200 for MA200
            elif interval == "1h":
                return max(100, (days_back + lookback_days) * 7 + 50)  # ~7 hours/day
            elif interval == "15m":
                return max(500, (days_back + lookback_days) * 26 + 50)  # ~26 bars/day
            elif interval == "5m":
                return max(500, (days_back + lookback_days) * 78 + 50)  # ~78 bars/day
            elif interval == "1m":
                return max(500, (days_back + lookback_days) * 390 + 50)  # ~390 bars/day
            return 500

        async def fetch_interval_bars(interval_name: str):
            """Fetch bars for a specific interval."""
            try:
                bars_count = calculate_bars_needed(interval_name, days_ago)
                logger.info(f"Fetching {bars_count} {interval_name} bars for {symbol} ending at {market_close.strftime('%Y-%m-%d %H:%M:%S ET')}")
                return await get_historical_bars(
                    symbol=symbol.upper(),
                    interval=interval_name,  # Fixed: was 'timeframe'
                    bars_count=bars_count,
                    use_rth=True,
                    end_date=market_close,  # Fetch bars ending at market close of selected date
                )
            except Exception as e:
                logger.error(f"Error fetching {interval_name} bars for {symbol}: {e}", exc_info=True)
                return []

        # Fetch all intervals in parallel
        bars_1d, bars_1h, bars_15m, bars_5m, bars_1m = await asyncio.gather(
            fetch_interval_bars("1d"),
            fetch_interval_bars("1h"),
            fetch_interval_bars("15m"),
            fetch_interval_bars("5m"),
            fetch_interval_bars("1m"),
        )

        # Convert to strategy analysis format
        def to_strategy_bars(bars):
            # get_historical_bars returns dicts, not objects
            if not bars:
                return []
            # Check if bars are already dicts or objects
            if isinstance(bars[0], dict):
                return [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars]
            else:
                return [{"time": b.time, "open": b.open, "high": b.high, "low": b.low, "close": b.close, "volume": b.volume} for b in bars]

        bars1d_dict = to_strategy_bars(bars_1d)
        bars1h_dict = to_strategy_bars(bars_1h)
        bars15m_dict = to_strategy_bars(bars_15m)
        bars5m_dict = to_strategy_bars(bars_5m)
        bars1m_dict = to_strategy_bars(bars_1m)

        logger.info(f"Backtest for {symbol} on {date}: fetched bars - 1d:{len(bars1d_dict)}, 1h:{len(bars1h_dict)}, 15m:{len(bars15m_dict)}, 5m:{len(bars5m_dict)}, 1m:{len(bars1m_dict)}")

        # Check if any 1m bars actually fall within the selected date range
        # If not (holiday/weekend), find the actual last trading day in the data
        bars_in_range = [b for b in bars1m_dict if start_unix <= b["time"] <= end_unix]
        if not bars_in_range and bars1m_dict:
            # Find the last bar's date and use that as the actual trading day
            last_bar_time = bars1m_dict[-1]["time"]
            last_bar_dt = datetime.fromtimestamp(last_bar_time, ny_tz)
            actual_date = last_bar_dt.date()

            actual_open = datetime(actual_date.year, actual_date.month, actual_date.day, 9, 30, tzinfo=ny_tz)
            actual_close = datetime(actual_date.year, actual_date.month, actual_date.day, 16, 0, tzinfo=ny_tz)

            start_unix = int(actual_open.timestamp())
            end_unix = int(actual_close.timestamp())

            logger.info(f"No bars found for {date}, adjusted to last trading day: {actual_date.strftime('%Y-%m-%d')} ({actual_open.strftime('%H:%M')}-{actual_close.strftime('%H:%M')} ET)")

        # Load strategy settings for this symbol + auto-trader strategy overrides
        settings_dict = get_settings(symbol.upper()) or {}
        at_settings = get_auto_trader_settings()
        strategy_overrides = at_settings.get("strategySettings", {})

        # Merge with defaults (same merge order as auto-trader)
        merged_settings = merge_strategy_settings(settings_dict, strategy_overrides)

        # Run strategy analysis on all bars
        # For 0DTE strategies, use 3:45 PM as the cutoff (they don't trade after that)
        # Use the adjusted end_unix date (may differ from original if holiday/weekend)
        analysis_end_dt = datetime.fromtimestamp(end_unix, ny_tz).replace(hour=15, minute=45, second=0, microsecond=0)
        analysis_end_unix = int(analysis_end_dt.timestamp())

        visible_range = {
            "from": lookback_start_unix,
            "to": analysis_end_unix,  # 3:45 PM for strategy analysis
        }

        # Parse enabled_strategies filter
        enabled_set = None
        if enabled_strategies:
            try:
                enabled_set = {int(s.strip()) for s in enabled_strategies.split(",") if s.strip()}
            except ValueError:
                pass

        signals = analyze_with_bars(
            symbol=symbol.upper(),
            visible_range=visible_range,
            bars1h=bars1h_dict,
            bars15m=bars15m_dict,
            bars1d=bars1d_dict,
            bars1m=bars1m_dict,
            settings=merged_settings,
            bars5m=bars5m_dict,
            bars15m_open=bars15m_dict,
            enabled_strategies=enabled_set,
        )

        # Log all signals before filtering
        logger.info(f"Backtest for {symbol} on {date}: found {len(signals)} total signals (visible_range from={lookback_start_unix} to={analysis_end_unix})")

        # Log signal breakdown by strategy
        from collections import Counter
        strategy_counts = Counter(sig.strategy_id for sig in signals)
        if strategy_counts:
            logger.info(f"Signal breakdown: {dict(strategy_counts)}")
        logger.info(f"Bars passed to analysis: 1m={len(bars1m_dict)}, 5m={len(bars5m_dict)}, 15m={len(bars15m_dict)}, 1h={len(bars1h_dict)}, 1d={len(bars1d_dict)}")
        if signals:
            logger.info(f"Signal times: {[(sig.strategy_id, datetime.fromtimestamp(sig.entry_time, ny_tz).strftime('%Y-%m-%d %H:%M:%S ET')) for sig in signals[:5]]}")

        # ── ADX / DI gap chop filter for backtest signals ──
        from app.services.auto_trader import _compute_adx
        _chop_enabled = at_settings.get("chopFilterEnabled", True)
        _chop_adx_threshold = float(at_settings.get("chopFilterAdxThreshold", 20))
        _chop_di_gap = float(at_settings.get("chopFilterDiGap", 10))
        _chop_tf = at_settings.get("chopFilterTimeframe", "5m")
        _chop_bars_source = {
            "1m": bars1m_dict, "5m": bars5m_dict, "15m": bars15m_dict,
            "1h": bars1h_dict, "1d": bars1d_dict,
        }.get(_chop_tf, bars5m_dict)

        def _chop_check_at(entry_time: int):
            """Return (filtered: bool, reason: str|None, adx, plus_di, minus_di, di_gap)."""
            if not _chop_enabled:
                return False, None, None, None, None, None
            closed = [b for b in _chop_bars_source if b["time"] < entry_time]
            adx, plus_di, minus_di = _compute_adx(closed)
            if adx is None:
                return False, None, None, None, None, None
            di_gap = abs(plus_di - minus_di)
            if adx < _chop_adx_threshold:
                return True, "adx", adx, plus_di, minus_di, di_gap
            if _chop_di_gap > 0 and di_gap < _chop_di_gap:
                return True, "di_gap", adx, plus_di, minus_di, di_gap
            return False, None, adx, plus_di, minus_di, di_gap

        # Filter signals to only include those within the selected day (9:30 AM - 4:00 PM ET)
        filtered_signals = []
        for sig in signals:
            if start_unix <= sig.entry_time <= end_unix:
                chop_filtered, chop_reason, adx_val, pdi, mdi, di_gap = _chop_check_at(sig.entry_time)
                entry = {
                    "id": sig.id,
                    "symbol": sig.symbol,
                    "strategy_id": sig.strategy_id,
                    "direction": sig.direction,
                    "entry_time": sig.entry_time,
                    "anchor_time": sig.anchor_time,
                    "chop_filtered": chop_filtered,
                    "chop_reason": chop_reason,
                    "adx": round(adx_val, 1) if adx_val is not None else None,
                    "di_gap": round(di_gap, 1) if di_gap is not None else None,
                }
                filtered_signals.append(entry)

        logger.info(f"Filtered to {len(filtered_signals)} signals within market hours ({datetime.fromtimestamp(start_unix, ny_tz).strftime('%H:%M')} - {datetime.fromtimestamp(end_unix, ny_tz).strftime('%H:%M')} ET)")

        # Compute actual_date string for frontend display
        actual_date_str = datetime.fromtimestamp(start_unix, ny_tz).strftime("%Y-%m-%d")

        # Compute S/R levels if strategy11 useSRFilter is on
        sr_levels = None
        s11_settings = merged_settings.get("strategy11", {})
        if s11_settings.get("useSRFilter", False):
            from app.services.strategy_analysis import compute_sr_levels
            sr_levels = compute_sr_levels(
                bars5m=bars5m_dict,
                bars1d=bars1d_dict,
                swing_lookback=s11_settings.get("swingLookback", 3),
            )

        # Return all bars (including lookback) + filtered signals
        result = {
            "symbol": symbol.upper(),
            "date": date,
            "actual_date": actual_date_str,
            "bars": {
                "1d": [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars1d_dict],
                "1h": [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars1h_dict],
                "15m": [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars15m_dict],
                "5m": [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars5m_dict],
                "1m": [{"time": b["time"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars1m_dict],
            },
            "signals": filtered_signals,
            "date_range": {
                "start": start_unix,
                "end": end_unix,
            },
        }
        if sr_levels:
            result["sr_levels"] = sr_levels
        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {str(e)}")
    except Exception as e:
        logger.error(f"Error in backtest endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/backtest-range")
async def backtest_range(
    symbol: str = Query(..., description="Stock symbol"),
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    lookback_days: int = Query(10, description="Lookback days for indicator warmup"),
):
    """Run multi-day backtest range analysis with strategy breakdowns and MFE/MAE."""
    from app.services.backtest_range import run_range_analysis

    try:
        from datetime import date as date_type

        start = date_type.fromisoformat(start_date)
        end = date_type.fromisoformat(end_date)

        if end < start:
            raise HTTPException(status_code=400, detail="end_date must be >= start_date")
        if (end - start).days > 60:
            raise HTTPException(status_code=400, detail="Maximum range is 60 calendar days")

        result = await run_range_analysis(symbol, start_date, end_date, lookback_days)
        return result

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {str(e)}")
    except Exception as e:
        logger.error(f"Error in backtest-range endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/backtest-range-stream")
async def backtest_range_stream(
    symbol: str = Query(..., description="Stock symbol"),
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    lookback_days: int = Query(10, description="Lookback days for indicator warmup"),
    enabled_strategies: str = Query(default="", description="Comma-separated strategy numbers to run (empty = all)"),
):
    """SSE stream for range analysis with progress updates."""
    from app.services.backtest_range import run_range_analysis
    from datetime import date as date_type

    start = date_type.fromisoformat(start_date)
    end = date_type.fromisoformat(end_date)
    if end < start:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")
    if (end - start).days > 60:
        raise HTTPException(status_code=400, detail="Maximum range is 60 calendar days")

    queue: asyncio.Queue = asyncio.Queue()

    async def on_progress(message: str):
        await queue.put({"type": "progress", "message": message})

    enabled_set = None
    if enabled_strategies:
        try:
            enabled_set = {int(s.strip()) for s in enabled_strategies.split(",") if s.strip()}
        except ValueError:
            pass

    async def run_analysis():
        try:
            result = await run_range_analysis(
                symbol, start_date, end_date, lookback_days,
                on_progress=on_progress, enabled_strategies=enabled_set,
            )
            await queue.put({"type": "result", "data": result})
        except Exception as exc:
            logger.error(f"Error in backtest-range-stream: {exc}", exc_info=True)
            await queue.put({"type": "error", "message": str(exc)})

    async def event_generator():
        task = asyncio.create_task(run_analysis())
        try:
            while True:
                item = await queue.get()
                yield f"data: {json.dumps(item)}\n\n"
                if item["type"] in ("result", "error"):
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/backtest-cross-symbol-stream")
async def backtest_cross_symbol_stream(
    symbols: str = Query(..., description="Comma-separated stock symbols"),
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    lookback_days: int = Query(10, description="Lookback days for indicator warmup"),
    enabled_strategies: str = Query(default="", description="Comma-separated strategy numbers to run (empty = all)"),
):
    """SSE stream for cross-symbol analysis with progress updates."""
    from app.services.backtest_cross_symbol import run_cross_symbol_analysis
    from datetime import date as date_type

    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="At least one symbol is required")

    start = date_type.fromisoformat(start_date)
    end = date_type.fromisoformat(end_date)
    if end < start:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")
    if (end - start).days > 60:
        raise HTTPException(status_code=400, detail="Maximum range is 60 calendar days")

    queue: asyncio.Queue = asyncio.Queue()

    async def on_progress(message: str):
        await queue.put({"type": "progress", "message": message})

    enabled_set_cs = None
    if enabled_strategies:
        try:
            enabled_set_cs = {int(s.strip()) for s in enabled_strategies.split(",") if s.strip()}
        except ValueError:
            pass

    async def run_analysis():
        try:
            result = await run_cross_symbol_analysis(
                symbol_list, start_date, end_date, lookback_days,
                on_progress=on_progress, enabled_strategies=enabled_set_cs,
            )
            await queue.put({"type": "result", "data": result})
        except Exception as exc:
            logger.error(f"Error in backtest-cross-symbol-stream: {exc}", exc_info=True)
            await queue.put({"type": "error", "message": str(exc)})

    async def event_generator():
        task = asyncio.create_task(run_analysis())
        try:
            while True:
                item = await queue.get()
                yield f"data: {json.dumps(item)}\n\n"
                if item["type"] in ("result", "error"):
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
