"""Parameter optimizer for the options backtester.

Pre-fetches all data once, then sweeps parameter combinations
by replaying the trade simulation with different settings.
"""
import itertools
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.polygon_data import build_option_ticker, get_option_bars, get_stock_bars
from app.services.strategy_analysis import analyze_with_bars
from app.services.strategy_defaults import DEFAULT_STRATEGY_SETTINGS, merge_strategy_settings
from app.services.strategy_settings import get_settings
from app.services.auto_trader_settings import get_settings as get_auto_trader_settings
from app.services.auto_trader import _compute_adx, _safe_float, _strategy_settings_key
from app.services.options_backtester import _simulate_trade, _select_strike, _get_trading_days
from app.services.strategy12_gex import scan_day_for_gex_signals, compute_gex_for_backtest

from app.services.optimizer_progress import _progress, optimizer_progress

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


def _fetch_s12_signals(symbol, day_str, day_bars, bars_1m, start_unix, end_unix, strategy_overrides, enabled_set, s12_settings_override=None, at_settings=None):
    """Fetch S12 GEX signals for a single day (shared by both optimizers)."""
    _s12_settings = strategy_overrides.get("strategy12", {})
    if s12_settings_override:
        _s12_settings = {**_s12_settings, **s12_settings_override}
    # Authoritative: dropdown's enabled_set wins over saved per-strategy enabled flag.
    if enabled_set is not None:
        _s12_enabled = 12 in enabled_set
    else:
        _s12_enabled = _s12_settings.get("enabled", False)
    if not _s12_enabled:
        return [], 0

    signals = []
    polygon_calls = 0
    try:
        _spot_for_gex = day_bars[len(day_bars) // 2]["close"] if day_bars else None
        if _spot_for_gex:
            _gex_levels = compute_gex_for_backtest(symbol="SPY", day_str=day_str, spot=_spot_for_gex, strike_range=15)
            polygon_calls += 30  # approximate API calls for GEX computation
            if _gex_levels and not _gex_levels.get("error"):
                _s12_merged = {**DEFAULT_STRATEGY_SETTINGS.get("strategy12", {}), **_s12_settings, "enabled": True}
                # Apply form entry times
                if at_settings:
                    if at_settings.get("entryStartTime"):
                        _s12_merged["entryStartTime"] = at_settings["entryStartTime"]
                    if at_settings.get("entryEndTime"):
                        _s12_merged["entryEndTime"] = at_settings["entryEndTime"]
                _gex_day_bars = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
                _gex_sigs = scan_day_for_gex_signals(
                    symbol=symbol,
                    bars_1m=_gex_day_bars,
                    gex_levels=_gex_levels,
                    settings={"strategy12": _s12_merged},
                    scan_interval=5,
                )
                signals = _gex_sigs
                logger.info(f"  S12 optimizer: {len(_gex_sigs)} GEX signals for {day_str}")
    except Exception as exc:
        logger.warning(f"S12 optimizer GEX failed for {day_str}: {exc}", exc_info=True)

    return signals, polygon_calls


# Default parameter grid
DEFAULT_PARAM_GRID = {
    "profitTargetPct": [0.20, 0.30, 0.50],
    "trailingStopPct": [0.03, 0.07, 0.12],
    "chopFilterDiGap": [0, 5, 10],
    "chopFilterAdxThreshold": [15, 20],
    "stopLossPct": [0, 0.30],
    "staleAfterMinutes": [0, 30],
    "staleMinGainPct": [0, 0.10],
}


def run_optimization(
    symbol: str = "SPY",
    start_date: str = "2026-04-06",
    end_date: str = "2026-04-10",
    param_grid: Optional[Dict[str, List]] = None,
    lookback_days: int = 10,
    top_n: int = 20,
    settings_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run parameter sweep optimization.

    1. Fetch all data once (Polygon bars + signal detection + option bars)
    2. For each parameter combo, replay trade simulation
    3. Return ranked results

    Args:
        symbol: Underlying ticker
        start_date: Start date YYYY-MM-DD
        end_date: End date YYYY-MM-DD
        param_grid: Dict of param_name -> list of values to sweep
        lookback_days: Indicator warmup days
        top_n: Number of top results to return

    Returns:
        Dict with ranked results, total combos tested, and timing.
    """
    grid = param_grid or DEFAULT_PARAM_GRID
    t_start = time.time()
    optimizer_progress["log"] = []
    optimizer_progress["running"] = True

    # ── Phase 1: Fetch all data (once) ──────────────────────────────────
    _progress("Fetch", "Starting data fetch from Polygon...")
    trading_days = _get_trading_days(start_date, end_date)
    if not trading_days:
        return {"error": "No trading days in range"}

    at_settings = get_auto_trader_settings()
    if settings_override:
        at_settings.update(settings_override)
    strategy_overrides = at_settings.get("strategySettings", {})
    # Ensure the backtested symbol is allowed in all strategies
    for _sk, _sv in strategy_overrides.items():
        if isinstance(_sv, dict) and "allowedTickers" in _sv:
            if symbol not in _sv["allowedTickers"]:
                _sv["allowedTickers"] = list(_sv["allowedTickers"]) + [symbol]
    symbol_settings = get_settings(symbol) or {}
    merged_settings = merge_strategy_settings(symbol_settings, strategy_overrides)
    for _sk, _sv in merged_settings.items():
        if isinstance(_sv, dict) and "allowedTickers" in _sv:
            if symbol not in _sv["allowedTickers"]:
                _sv["allowedTickers"] = list(_sv["allowedTickers"]) + [symbol]

    enabled_set = None
    ticker_cfg = at_settings.get("tickerSettings", {}).get(symbol, {})
    enabled_list = ticker_cfg.get("enabledStrategies")
    if enabled_list:
        enabled_set = set(enabled_list)

    lookback_start_str = (datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=lookback_days + 5)).strftime("%Y-%m-%d")
    _progress("Fetch", "Fetching underlying bars (1m, 5m, 15m, 1h, 1d)...", 5)

    try:
        all_bars_1m = get_stock_bars(symbol, lookback_start_str, end_date, "1", "minute")
        all_bars_5m = get_stock_bars(symbol, lookback_start_str, end_date, "5", "minute")
        all_bars_15m = get_stock_bars(symbol, lookback_start_str, end_date, "15", "minute")
        all_bars_1h = get_stock_bars(symbol, lookback_start_str, end_date, "1", "hour")
        all_bars_1d = get_stock_bars(symbol, lookback_start_str, end_date, "1", "day")
    except Exception as e:
        return {"error": f"Failed to fetch bars: {e}"}

    _progress("Fetch", f"Bars fetched: 1m={len(all_bars_1m)}, 5m={len(all_bars_5m)}, 15m={len(all_bars_15m)}", 15)

    # ── Phase 2: Pre-compute signals + option bars per day ──────────────
    _progress("Signals", f"Processing {len(trading_days)} trading days...", 20)
    day_data = {}
    polygon_calls = 5  # underlying bar fetches

    for day_idx, day_str in enumerate(trading_days):
        day_pct = 20 + int((day_idx / len(trading_days)) * 40)  # 20-60%
        _progress("Signals", f"Day {day_idx+1}/{len(trading_days)}: {day_str}", day_pct, "Running strategy analysis...")

        target_date = datetime.strptime(day_str, "%Y-%m-%d")
        target_ny = target_date.replace(tzinfo=NY)
        market_open = target_ny.replace(hour=9, minute=30, second=0)
        market_close = target_ny.replace(hour=16, minute=0, second=0)
        start_unix = int(market_open.timestamp())
        end_unix = int(market_close.timestamp())
        lookback_start = market_open - timedelta(days=lookback_days)
        lookback_unix = int(lookback_start.timestamp())

        bars_1m = [b for b in all_bars_1m if lookback_unix <= b["time"] <= end_unix]
        bars_5m = [b for b in all_bars_5m if lookback_unix <= b["time"] <= end_unix]
        bars_15m = [b for b in all_bars_15m if lookback_unix <= b["time"] <= end_unix]
        bars_1h = [b for b in all_bars_1h if lookback_unix <= b["time"] <= end_unix]
        bars_1d = [b for b in all_bars_1d if b["time"] <= end_unix]

        if not bars_1m or len(bars_1m) < 30:
            _progress("Signals", f"Day {day_idx+1}/{len(trading_days)}: {day_str}", day_pct, "Skipped — insufficient bars")
            continue

        day_bars = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
        if not day_bars:
            continue

        # Run signal detection (once per day)
        visible_range = {
            "from": int(lookback_start.timestamp()),
            "to": int(target_ny.replace(hour=15, minute=45).timestamp()),
        }

        try:
            signals = analyze_with_bars(
                symbol=symbol,
                visible_range=visible_range,
                bars1h=bars_1h,
                bars15m=bars_15m,
                bars1d=bars_1d,
                bars1m=bars_1m,
                settings=merged_settings,
                bars5m=bars_5m,
                bars15m_open=bars_15m,
                enabled_strategies=enabled_set,
            )
        except Exception as e:
            _progress("Signals", f"Day {day_str}: analysis failed", day_pct, str(e))
            continue

        day_signals = [s for s in signals if start_unix <= s.entry_time <= end_unix]

        # Deduplicate
        seen = set()
        unique_signals = []
        for sig in day_signals:
            if sig.id not in seen:
                seen.add(sig.id)
                unique_signals.append(sig)

        # ── S12 GEX signals ──
        _s12_settings = strategy_overrides.get("strategy12", {})
        if enabled_set is not None:
            _s12_enabled = 12 in enabled_set
        else:
            _s12_enabled = _s12_settings.get("enabled", False)
        _gex_levels_cached = None
        _gex_day_bars = None
        if _s12_enabled:
            _spot_for_gex = day_bars[len(day_bars) // 2]["close"] if day_bars else None
            if _spot_for_gex:
                try:
                    _gex_levels_cached = compute_gex_for_backtest(symbol="SPY", day_str=day_str, spot=_spot_for_gex, strike_range=15)
                    polygon_calls += 30
                    _gex_day_bars = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
                    if _gex_levels_cached and not _gex_levels_cached.get("error"):
                        _s12_merged = {**DEFAULT_STRATEGY_SETTINGS.get("strategy12", {}), **_s12_settings, "enabled": True}
                        if at_settings.get("entryStartTime"):
                            _s12_merged["entryStartTime"] = at_settings["entryStartTime"]
                        if at_settings.get("entryEndTime"):
                            _s12_merged["entryEndTime"] = at_settings["entryEndTime"]
                        _gex_sigs = scan_day_for_gex_signals(
                            symbol=symbol, bars_1m=_gex_day_bars,
                            gex_levels=_gex_levels_cached,
                            settings={"strategy12": _s12_merged}, scan_interval=5,
                        )
                        for sig in _gex_sigs:
                            if sig.id not in seen:
                                unique_signals.append(sig)
                                seen.add(sig.id)
                        _progress("Signals", f"Day {day_idx+1}/{len(trading_days)}: {day_str}", day_pct,
                                  f"S12: {len(_gex_sigs)} GEX signals")
                except Exception as exc:
                    logger.warning(f"S12 optimizer GEX failed for {day_str}: {exc}", exc_info=True)

        # ── S13 Opening Direction signals ──
        _s13_settings = strategy_overrides.get("strategy13", {})
        if enabled_set is not None:
            _s13_enabled_opt = 13 in enabled_set
        else:
            _s13_enabled_opt = _s13_settings.get("enabled", False)
        if _s13_enabled_opt:
            try:
                from app.services.strategy13_opening_direction import scan_day_for_opening_direction_signals
                _prev_day_bars_1d = [b for b in all_bars_1d if b["time"] < start_unix]
                _prev_close_s13 = _prev_day_bars_1d[-1]["close"] if _prev_day_bars_1d else None
                _s13_merged = {**DEFAULT_STRATEGY_SETTINGS.get("strategy13", {}), **_s13_settings, "enabled": True}
                if at_settings.get("entryStartTime"):
                    _s13_merged["entryStartTime"] = at_settings["entryStartTime"]
                if at_settings.get("entryEndTime"):
                    _s13_merged["entryEndTime"] = at_settings["entryEndTime"]
                _s13_day_5m = [b for b in bars_5m if start_unix <= b["time"] <= end_unix]
                _s13_sigs = scan_day_for_opening_direction_signals(
                    symbol=symbol, bars_5m=_s13_day_5m,
                    settings={"strategy13": _s13_merged}, prev_close=_prev_close_s13,
                )
                for sig in _s13_sigs:
                    if sig.id not in seen:
                        unique_signals.append(sig)
                        seen.add(sig.id)
            except Exception as exc:
                logger.warning(f"S13 optimizer failed for {day_str}: {exc}", exc_info=True)

        if not unique_signals:
            continue

        # Pre-fetch option bars for nearby strikes
        day_high = max(b["high"] for b in day_bars)
        day_low = min(b["low"] for b in day_bars)
        day_mid = (day_high + day_low) / 2
        near_strikes = sorted(set([round(day_mid + i) for i in range(-8, 9)]))

        signal_directions = set(s.direction for s in unique_signals)
        rights = []
        if "CALL" in signal_directions:
            rights.append("C")
        if "PUT" in signal_directions:
            rights.append("P")
        if not rights:
            rights = ["C", "P"]

        _progress("Signals", f"Day {day_idx+1}/{len(trading_days)}: {day_str}", day_pct,
                  f"{len(day_signals)} signals found, fetching {len(near_strikes)}×{len(rights)} option bars...")
        option_bars_cache = {}
        for strike in near_strikes:
            for right in rights:
                ticker = build_option_ticker(symbol, day_str, right, strike)
                try:
                    opt_bars = get_option_bars(ticker, day_str, day_str, "1", "minute")
                    if opt_bars:
                        option_bars_cache[ticker] = opt_bars
                        polygon_calls += 1
                except Exception:
                    pass

        # Pre-compute ADX/DI at each signal time (for chop filter sweep)
        signal_adx_data = []
        for sig in unique_signals:
            chop_bars_5m = [b for b in bars_5m if b["time"] < sig.entry_time]
            chop_bars_15m = [b for b in bars_15m if b["time"] < sig.entry_time]
            adx_5m, pdi_5m, mdi_5m = _compute_adx(chop_bars_5m)
            adx_15m, pdi_15m, mdi_15m = _compute_adx(chop_bars_15m)
            di_gap_5m = abs(pdi_5m - mdi_5m) if pdi_5m is not None else None
            di_gap_15m = abs(pdi_15m - mdi_15m) if pdi_15m is not None else None
            signal_adx_data.append({
                "signal": sig,
                "adx_5m": adx_5m, "di_gap_5m": di_gap_5m,
                "adx_15m": adx_15m, "di_gap_15m": di_gap_15m,
            })

        day_data[day_str] = {
            "signals": unique_signals,
            "signal_adx": signal_adx_data,
            "day_bars": day_bars,
            "option_bars_cache": option_bars_cache,
            "near_strikes": near_strikes,
            "bars_5m": bars_5m,
            "bars_15m": bars_15m,
            "gex_levels": _gex_levels_cached,
            "gex_day_bars": _gex_day_bars,
            "s12_enabled": _s12_enabled,
        }

    t_fetch = time.time() - t_start
    _progress("Fetch", f"Data ready: {len(day_data)} days with signals, {polygon_calls} API calls in {t_fetch:.1f}s", 60)

    if not day_data:
        optimizer_progress["running"] = False
        return {"error": "No days with signals found", "fetch_time": t_fetch}

    # ── Phase 3: Parameter sweep ────────────────────────────────────────
    # Detect if any S12-specific params are in the grid
    S12_SIGNAL_PARAMS = {"proximityThreshold", "minVelocity", "velocityLookback", "stopDistance"}
    has_s12_sweep = bool(S12_SIGNAL_PARAMS & set(grid.keys()))

    param_names = sorted(grid.keys())
    param_values = [grid[k] for k in param_names]
    combos = list(itertools.product(*param_values))
    total_combos = len(combos)
    _progress("Sweep", f"Sweeping {total_combos:,} parameter combinations...", 65)

    results = []
    t_sweep_start = time.time()

    from app.services.backtest_core import simulate_day_trades

    # Cache re-scanned S12 signals per param tuple to avoid redundant scans
    _s12_signal_cache = {}

    for combo_idx, combo in enumerate(combos):
        if combo_idx % 100 == 0:
            sweep_pct = 65 + int((combo_idx / total_combos) * 30)  # 65-95%
            _progress("Sweep", f"Combo {combo_idx+1:,}/{total_combos:,}", sweep_pct,
                      f"Best so far: ${max((r['total_pnl'] for r in results), default=0):+.0f}" if results else "")
        params = dict(zip(param_names, combo))

        tp_pct = params.get("profitTargetPct", 0.25)
        trail_pct = params.get("trailingStopPct", 0.07)
        di_gap_threshold = params.get("chopFilterDiGap", 10)
        adx_threshold = params.get("chopFilterAdxThreshold", 20)
        stop_loss = params.get("stopLossPct", 0)
        stale_mins = params.get("staleAfterMinutes", 0)
        stale_gain = params.get("staleMinGainPct", 0.10)
        chop_enabled = di_gap_threshold > 0 or adx_threshold > 0

        # S12-specific params for signal re-generation
        s12_proximity = params.get("proximityThreshold")
        s12_velocity = params.get("minVelocity")
        s12_vel_lookback = params.get("velocityLookback")
        s12_stop_dist = params.get("stopDistance")

        # Skip redundant combos
        if stale_mins == 0 and stale_gain != (grid.get("staleMinGainPct", [0.10]) or [0.10])[0]:
            continue

        # Build combo-specific settings overlay
        combo_settings = {**at_settings,
            "profitTargetPct": tp_pct, "trailingStopPct": trail_pct,
            "stopLossPct": stop_loss, "useTrailingStop": True, "trailingTiers": [],
            "staleAfterMinutes": stale_mins, "staleMinGainPct": stale_gain,
        }

        # Build S12 param key for caching re-scanned signals
        s12_param_key = (s12_proximity, s12_velocity, s12_vel_lookback, s12_stop_dist) if has_s12_sweep else None

        combo_trades = []
        for day_str, dd in day_data.items():
            # If S12 params are being swept, re-scan signals with new params
            signals_for_day = dd["signals"]
            if has_s12_sweep and dd.get("s12_enabled") and dd.get("gex_levels"):
                cache_key = (day_str, s12_param_key)
                if cache_key not in _s12_signal_cache:
                    # Re-scan with this combo's S12 settings
                    _s12_override = {}
                    if s12_proximity is not None:
                        _s12_override["proximityThreshold"] = s12_proximity
                    if s12_velocity is not None:
                        _s12_override["minVelocity"] = s12_velocity
                    if s12_vel_lookback is not None:
                        _s12_override["velocityLookback"] = s12_vel_lookback
                    if s12_stop_dist is not None:
                        _s12_override["stopDistance"] = s12_stop_dist
                    _s12_merged = {
                        **DEFAULT_STRATEGY_SETTINGS.get("strategy12", {}),
                        **strategy_overrides.get("strategy12", {}),
                        **_s12_override,
                        "enabled": True,
                    }
                    _rescan_sigs = scan_day_for_gex_signals(
                        symbol=symbol, bars_1m=dd["gex_day_bars"],
                        gex_levels=dd["gex_levels"],
                        settings={"strategy12": _s12_merged}, scan_interval=5,
                    )
                    _s12_signal_cache[cache_key] = _rescan_sigs

                # Replace S12 signals in the day's signal list
                non_s12 = [s for s in dd["signals"] if not s.strategy_id.startswith("strategy12")]
                rescanned = _s12_signal_cache[cache_key]
                seen_ids = set(s.id for s in non_s12)
                signals_for_day = list(non_s12)
                for sig in rescanned:
                    if sig.id not in seen_ids:
                        signals_for_day.append(sig)
                        seen_ids.add(sig.id)

            day_trades, _, _ = simulate_day_trades(
                symbol=symbol,
                day_str=day_str,
                unique_signals=signals_for_day,
                day_bars=dd["day_bars"],
                near_strikes=dd["near_strikes"],
                option_bars_cache=dd["option_bars_cache"],
                at_settings=combo_settings,
                strategy_overrides=strategy_overrides,
                chop_enabled=chop_enabled,
                chop_adx_threshold=adx_threshold,
                chop_di_gap=di_gap_threshold,
                chop_tf="5m",
                bars_5m=dd.get("bars_5m"),
                bars_15m=dd.get("bars_15m"),
            )
            combo_trades.extend(t["pnl"] for t in day_trades)

        # Compute combo stats
        total_pnl = sum(combo_trades)
        wins = sum(1 for p in combo_trades if p > 0)
        losses = sum(1 for p in combo_trades if p <= 0)
        n = len(combo_trades)

        # Compute max drawdown for this combo
        _dd_peak = 0; _dd_cum = 0; _dd_max = 0
        for _p in combo_trades:
            _dd_cum += _p
            if _dd_cum > _dd_peak: _dd_peak = _dd_cum
            _dd = _dd_cum - _dd_peak
            if _dd < _dd_max: _dd_max = _dd

        results.append({
            "params": params,
            "total_pnl": round(total_pnl, 2),
            "trades": n,
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / n * 100, 1) if n > 0 else 0,
            "avg_pnl": round(total_pnl / n, 2) if n > 0 else 0,
            "max_drawdown": round(_dd_max, 2),
            "profit_factor": round(
                abs(sum(p for p in combo_trades if p > 0) /
                    sum(p for p in combo_trades if p < 0))
                if any(p < 0 for p in combo_trades) else 0, 2
            ) if combo_trades else 0,
        })

    t_sweep = time.time() - t_sweep_start
    t_total = time.time() - t_start

    # Sort by total P&L descending
    results.sort(key=lambda r: r["total_pnl"], reverse=True)

    best = results[0] if results else {}
    _progress("Done", f"Complete! Best: ${best.get('total_pnl', 0):+.0f} ({best.get('win_rate', 0)}% WR)", 100,
              f"{total_combos:,} combos in {t_sweep:.1f}s")
    optimizer_progress["running"] = False

    return {
        "symbol": symbol,
        "start_date": start_date,
        "end_date": end_date,
        "total_combos": total_combos,
        "fetch_time_secs": round(t_fetch, 1),
        "sweep_time_secs": round(t_sweep, 1),
        "total_time_secs": round(t_total, 1),
        "polygon_calls": polygon_calls,
        "top_results": results[:top_n],
        "worst_results": results[-5:],
        "all_results_count": len(results),
    }


# ── Trailing Tier Presets ────────────────────────────────────────────────────

TRAILING_PRESETS = {
    "Flat 3%": [],  # uses trailingStopPct=0.03
    "Flat 5%": [],
    "Flat 7%": [],
    "Flat 10%": [],
    "Flat 15%": [],
    "Aggressive (7→5→3→2)": [
        {"above": 0, "trail": 0.07}, {"above": 0.25, "trail": 0.05},
        {"above": 0.50, "trail": 0.03}, {"above": 1.0, "trail": 0.02},
    ],
    "Moderate (7→5→4→3)": [
        {"above": 0, "trail": 0.07}, {"above": 0.25, "trail": 0.05},
        {"above": 0.50, "trail": 0.04}, {"above": 1.0, "trail": 0.03},
    ],
    "Conservative (10→7→5→3)": [
        {"above": 0, "trail": 0.10}, {"above": 0.25, "trail": 0.07},
        {"above": 0.50, "trail": 0.05}, {"above": 1.0, "trail": 0.03},
    ],
    "Wide-to-tight (12→8→5→3)": [
        {"above": 0, "trail": 0.12}, {"above": 0.25, "trail": 0.08},
        {"above": 0.50, "trail": 0.05}, {"above": 1.0, "trail": 0.03},
    ],
    "Two-step (7→4)": [
        {"above": 0, "trail": 0.07}, {"above": 0.50, "trail": 0.04},
    ],
    "Late lock (10→10→5→3)": [
        {"above": 0, "trail": 0.10}, {"above": 0.25, "trail": 0.10},
        {"above": 0.50, "trail": 0.05}, {"above": 1.0, "trail": 0.03},
    ],
    "Ultra-tight (5→3→2→1)": [
        {"above": 0, "trail": 0.05}, {"above": 0.25, "trail": 0.03},
        {"above": 0.50, "trail": 0.02}, {"above": 1.0, "trail": 0.01},
    ],
    "Relaxed (15→10→7→5)": [
        {"above": 0, "trail": 0.15}, {"above": 0.25, "trail": 0.10},
        {"above": 0.50, "trail": 0.07}, {"above": 1.0, "trail": 0.05},
    ],
    "Three-step (10→5→3)": [
        {"above": 0, "trail": 0.10}, {"above": 0.30, "trail": 0.05},
        {"above": 0.75, "trail": 0.03},
    ],
}


def run_trailing_optimization(
    symbol: str = "SPY",
    start_date: str = "2026-04-06",
    end_date: str = "2026-04-10",
    base_settings: Optional[Dict[str, Any]] = None,
    lookback_days: int = 10,
) -> Dict[str, Any]:
    """Run trailing tier optimization using locked base settings.

    Uses the same data pre-fetch as run_optimization, then sweeps
    trailing tier presets with base settings locked.

    Args:
        symbol: Underlying ticker
        start_date, end_date: Date range
        base_settings: Locked settings from Phase 1 (TP%, ADX, DI gap, SL%)
        lookback_days: Indicator warmup

    Returns:
        Dict with ranked trailing presets.
    """
    t_start = time.time()
    optimizer_progress["log"] = []
    optimizer_progress["running"] = True
    _progress("Fetch", "Starting trailing tier optimization...")
    base = base_settings or {}

    tp_pct = base.get("profitTargetPct", 0.25)
    di_gap_threshold = base.get("chopFilterDiGap", 0)
    adx_threshold = base.get("chopFilterAdxThreshold", 15)
    stop_loss = base.get("stopLossPct", 0)
    chop_enabled = di_gap_threshold > 0 or adx_threshold > 0

    # ── Fetch data (same as Phase 1) ────────────────────────────────────
    trading_days = _get_trading_days(start_date, end_date)
    if not trading_days:
        return {"error": "No trading days in range"}

    at_settings = get_auto_trader_settings()
    strategy_overrides = at_settings.get("strategySettings", {})
    symbol_settings = get_settings(symbol) or {}
    merged_settings = merge_strategy_settings(symbol_settings, strategy_overrides)

    enabled_set = None
    ticker_cfg = at_settings.get("tickerSettings", {}).get(symbol, {})
    enabled_list = ticker_cfg.get("enabledStrategies")
    if enabled_list:
        enabled_set = set(enabled_list)

    lookback_start_str = (datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=lookback_days + 5)).strftime("%Y-%m-%d")

    try:
        all_bars_1m = get_stock_bars(symbol, lookback_start_str, end_date, "1", "minute")
        all_bars_5m = get_stock_bars(symbol, lookback_start_str, end_date, "5", "minute")
        all_bars_15m = get_stock_bars(symbol, lookback_start_str, end_date, "15", "minute")
        all_bars_1h = get_stock_bars(symbol, lookback_start_str, end_date, "1", "hour")
        all_bars_1d = get_stock_bars(symbol, lookback_start_str, end_date, "1", "day")
    except Exception as e:
        return {"error": f"Failed to fetch bars: {e}"}

    polygon_calls = 5

    # ── Pre-compute signals + option bars ────────────────────────────────
    _capital_limit = _safe_float(base.get("capitalLimit"), 0)
    valid_trades = []  # list of (signal, entry_premium, opt_bars, strat_cfg)

    for day_str in trading_days:
        target_date = datetime.strptime(day_str, "%Y-%m-%d")
        target_ny = target_date.replace(tzinfo=NY)
        market_open = target_ny.replace(hour=9, minute=30, second=0)
        market_close = target_ny.replace(hour=16, minute=0, second=0)
        start_unix = int(market_open.timestamp())
        end_unix = int(market_close.timestamp())
        lookback_start = market_open - timedelta(days=lookback_days)
        lookback_unix = int(lookback_start.timestamp())

        bars_1m = [b for b in all_bars_1m if lookback_unix <= b["time"] <= end_unix]
        bars_5m = [b for b in all_bars_5m if lookback_unix <= b["time"] <= end_unix]
        bars_15m = [b for b in all_bars_15m if lookback_unix <= b["time"] <= end_unix]
        bars_1h = [b for b in all_bars_1h if lookback_unix <= b["time"] <= end_unix]
        bars_1d = [b for b in all_bars_1d if b["time"] <= end_unix]

        if not bars_1m or len(bars_1m) < 30:
            continue
        day_bars = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
        if not day_bars:
            continue

        visible_range = {
            "from": int(lookback_start.timestamp()),
            "to": int(target_ny.replace(hour=15, minute=45).timestamp()),
        }

        try:
            signals = analyze_with_bars(
                symbol=symbol, visible_range=visible_range,
                bars1h=bars_1h, bars15m=bars_15m, bars1d=bars_1d,
                bars1m=bars_1m, settings=merged_settings,
                bars5m=bars_5m, bars15m_open=bars_15m,
                enabled_strategies=enabled_set,
            )
        except Exception:
            continue

        day_signals = [s for s in signals if start_unix <= s.entry_time <= end_unix]
        seen = set()
        unique = [s for s in day_signals if s.id not in seen and not seen.add(s.id)]

        # ── S12 GEX signals ──
        s12_sigs, s12_calls = _fetch_s12_signals(
            symbol, day_str, day_bars, bars_1m, start_unix, end_unix,
            strategy_overrides, enabled_set, at_settings=at_settings,
        )
        for sig in s12_sigs:
            if sig.id not in seen:
                unique.append(sig)
                seen.add(sig.id)
        polygon_calls += s12_calls

        # ── S13 Opening Direction signals ──
        _s13_settings_t = strategy_overrides.get("strategy13", {})
        if enabled_set is not None:
            _s13_en_t = 13 in enabled_set
        else:
            _s13_en_t = _s13_settings_t.get("enabled", False)
        if _s13_en_t:
            try:
                from app.services.strategy13_opening_direction import scan_day_for_opening_direction_signals
                _prev_1d_t = [b for b in all_bars_1d if b["time"] < start_unix]
                _pc_t = _prev_1d_t[-1]["close"] if _prev_1d_t else None
                _s13m = {**DEFAULT_STRATEGY_SETTINGS.get("strategy13", {}), **_s13_settings_t, "enabled": True}
                _s13_5m_t = [b for b in bars_5m if start_unix <= b["time"] <= end_unix]
                _s13s_t = scan_day_for_opening_direction_signals(
                    symbol=symbol, bars_5m=_s13_5m_t,
                    settings={"strategy13": _s13m}, prev_close=_pc_t,
                )
                for sig in _s13s_t:
                    if sig.id not in seen:
                        unique.append(sig)
                        seen.add(sig.id)
            except Exception:
                pass

        # Chop filter
        filtered = []
        for sig in unique:
            if chop_enabled:
                chop_bars = [b for b in bars_5m if b["time"] < sig.entry_time]
                adx, pdi, mdi = _compute_adx(chop_bars)
                if adx is not None:
                    if adx_threshold > 0 and adx < adx_threshold:
                        continue
                    di_gap = abs(pdi - mdi)
                    if di_gap_threshold > 0 and di_gap < di_gap_threshold:
                        continue
            filtered.append(sig)

        if not filtered:
            continue

        # Fetch option bars
        day_high = max(b["high"] for b in day_bars)
        day_low = min(b["low"] for b in day_bars)
        day_mid = (day_high + day_low) / 2
        near_strikes = sorted(set([round(day_mid + i) for i in range(-8, 9)]))
        signal_dirs = set(s.direction for s in filtered)
        rights = (["C"] if "CALL" in signal_dirs else []) + (["P"] if "PUT" in signal_dirs else []) or ["C", "P"]

        obc = {}
        for strike in near_strikes:
            for right in rights:
                ticker = build_option_ticker(symbol, day_str, right, strike)
                try:
                    ob = get_option_bars(ticker, day_str, day_str, "1", "minute")
                    if ob:
                        obc[ticker] = ob
                        polygon_calls += 1
                except Exception:
                    pass

        traded_ids = set()
        day_capital_used = 0
        for sig in filtered:
            if sig.id in traded_ids:
                continue
            spot_bar = min(day_bars, key=lambda b: abs(b["time"] - sig.entry_time))
            result = _select_strike(
                spot=spot_bar["close"], direction=sig.direction,
                available_strikes=near_strikes, option_bars_cache=obc,
                expiration=day_str, symbol=symbol, entry_ts=sig.entry_time,
                settings=at_settings,
                premium_min=_safe_float(at_settings.get("premiumMin"), 0),
                premium_max=_safe_float(at_settings.get("premiumMax"), 0),
            )
            if not result:
                continue
            strike, ticker, entry_premium, opt_bars = result
            _contract_premium = entry_premium * 100
            _sizing = base.get("positionSizing", "fixed")
            _risk = _safe_float(base.get("riskPerTrade"), 200)
            _max_c = int(base.get("maxContractsPerTrade", 3))
            _min_c = int(base.get("minContractsPerTrade", 1))
            if _sizing == "fixed":
                _contracts = max(1, int(_risk / _contract_premium)) if _contract_premium > 0 else 1
            else:
                _contracts = _max_c
            _contracts = max(_min_c, min(_contracts, _max_c))
            contract_cost = _contract_premium * _contracts
            if _capital_limit > 0 and day_capital_used + contract_cost > _capital_limit:
                _lim_rem = _capital_limit - day_capital_used
                _max_from_lim = int(_lim_rem / _contract_premium) if _contract_premium > 0 else 0
                if _max_from_lim < _min_c:
                    continue
                _contracts = min(_contracts, _max_from_lim)
                contract_cost = _contract_premium * _contracts
            strat_key = _strategy_settings_key(sig.strategy_id)
            strat_cfg = {**DEFAULT_STRATEGY_SETTINGS.get(strat_key, {}), **strategy_overrides.get(strat_key, {})}
            valid_trades.append((sig, entry_premium, opt_bars, strat_cfg, _contracts))
            traded_ids.add(sig.id)
            day_capital_used += contract_cost

    t_fetch = time.time() - t_start

    if not valid_trades:
        optimizer_progress["running"] = False
        return {"error": "No valid trades found with the base settings", "fetch_time": t_fetch}

    _progress("Sweep", f"Sweeping {len(TRAILING_PRESETS)} presets on {len(valid_trades)} trades...", 70)

    # ── Sweep trailing presets ──────────────────────────────────────────
    t_sweep = time.time()
    results = []

    flat_pcts = {"Flat 3%": 0.03, "Flat 5%": 0.05, "Flat 7%": 0.07, "Flat 10%": 0.10, "Flat 15%": 0.15}

    for preset_idx, (name, tiers) in enumerate(TRAILING_PRESETS.items()):
        _progress("Sweep", f"Preset {preset_idx+1}/{len(TRAILING_PRESETS)}: {name}", 70 + int((preset_idx / len(TRAILING_PRESETS)) * 25))
        trail_default = flat_pcts.get(name, 0.07)
        trade_pnls = []
        trade_details = []

        for sig, entry_premium, opt_bars, strat_cfg, _contracts in valid_trades:
            sc = {**strat_cfg}
            sc["profitTargetPct"] = tp_pct
            sc["useTrailingStop"] = True
            sc["trailingStopPct"] = trail_default
            sc["stopLossPct"] = stop_loss

            sim_settings = {
                **at_settings,
                "profitTargetPct": tp_pct,
                "trailingStopPct": trail_default,
                "trailingTiers": tiers,
                "stopLossPct": stop_loss,
            }

            tr = _simulate_trade(
                entry_premium=entry_premium, bars=opt_bars,
                entry_ts=sig.entry_time, settings=sim_settings,
                strat_settings=sc,
            )

            pnl = (tr["exit_premium"] - entry_premium) * 100 * _contracts
            capture = ((tr["exit_premium"] - entry_premium) / (tr["hwm"] - entry_premium) * 100) if tr["hwm"] > entry_premium else 0
            trade_pnls.append(pnl)
            trade_details.append({
                "pnl": round(pnl, 2),
                "capture_pct": round(capture, 1),
                "exit_reason": tr["exit_reason"],
                "trail_used": round(tr.get("trail_pct_used", 0) * 100, 1),
            })

        total_pnl = sum(trade_pnls)
        wins = sum(1 for p in trade_pnls if p > 0)
        n = len(trade_pnls)
        avg_capture = sum(d["capture_pct"] for d in trade_details) / n if n else 0
        exit_reasons = {}
        for d in trade_details:
            r = d["exit_reason"]
            exit_reasons[r] = exit_reasons.get(r, 0) + 1

        results.append({
            "name": name,
            "tiers": tiers,
            "total_pnl": round(total_pnl, 2),
            "trades": n,
            "wins": wins,
            "losses": n - wins,
            "win_rate": round(wins / n * 100, 1) if n else 0,
            "avg_pnl": round(total_pnl / n, 2) if n else 0,
            "avg_capture_pct": round(avg_capture, 1),
            "profit_factor": round(
                abs(sum(p for p in trade_pnls if p > 0) / sum(p for p in trade_pnls if p < 0))
                if any(p < 0 for p in trade_pnls) else 0, 2
            ) if trade_pnls else 0,
            "exit_reasons": exit_reasons,
        })

    results.sort(key=lambda r: r["total_pnl"], reverse=True)
    t_sweep_elapsed = time.time() - t_sweep

    best = results[0] if results else {}
    _progress("Done", f"Best trailing: {best.get('name','')} ${best.get('total_pnl',0):+.0f}", 100)
    optimizer_progress["running"] = False

    return {
        "symbol": symbol,
        "start_date": start_date,
        "end_date": end_date,
        "base_settings": base,
        "total_trades_per_preset": len(valid_trades),
        "presets_tested": len(TRAILING_PRESETS),
        "fetch_time_secs": round(t_fetch, 1),
        "sweep_time_secs": round(t_sweep_elapsed, 3),
        "total_time_secs": round(time.time() - t_start, 1),
        "polygon_calls": polygon_calls,
        "results": results,
    }
