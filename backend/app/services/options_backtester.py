"""Options backtester using real historical option premiums from Polygon.io.

Replays strategy signals against actual 1-minute option bars to simulate
entry, trailing stop, TP, and exit with real market prices.
"""
import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from app.services.polygon_data import (
    build_option_ticker,
    get_option_bars,
    get_option_contracts,
    get_stock_bars,
)
from app.services.strategy_analysis import analyze_with_bars
from app.services.strategy_defaults import DEFAULT_STRATEGY_SETTINGS, merge_strategy_settings
from app.services.strategy_settings import get_settings
from app.services.auto_trader_settings import get_settings as get_auto_trader_settings
from app.services.auto_trader import _compute_adx, _safe_float
from app.services.optimizer_progress import _progress, optimizer_progress

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


def _get_trading_days(start_date: str, end_date: str) -> List[str]:
    """Return list of weekday date strings between start and end (inclusive)."""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    days = []
    current = start
    while current <= end:
        if current.weekday() < 5:  # Mon-Fri
            days.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return days


def _select_strike(
    spot: float,
    direction: str,
    available_strikes: List[float],
    option_bars_cache: Dict[str, List[Dict]],
    expiration: str,
    symbol: str,
    entry_ts: int,
    settings: Dict[str, Any],
    premium_min: float = 0,
    premium_max: float = 0,
) -> Optional[Tuple[float, str, float, List[Dict]]]:
    """Select optimal strike using same logic as auto trader.

    Returns (strike, option_ticker, entry_premium, bars) or None.
    """
    right = "C" if direction == "CALL" else "P"

    # Sort strikes by distance from spot — nearest first
    if direction == "CALL":
        candidates = sorted([s for s in available_strikes if s >= spot - 2], key=lambda s: s)
    else:
        candidates = sorted([s for s in available_strikes if s <= spot + 2], key=lambda s: -s)

    # Try each candidate strike
    for strike in candidates[:10]:  # Check up to 10 strikes
        ticker = build_option_ticker(symbol, expiration, right, strike)

        # Get bars from cache
        bars = option_bars_cache.get(ticker)
        if not bars or len(bars) < 5:
            continue

        # Find the bar at entry time
        entry_bar = min(bars, key=lambda b: abs(b["time"] - entry_ts))
        if abs(entry_bar["time"] - entry_ts) > 120:  # Within 2 minutes
            continue

        premium = entry_bar["close"]
        if premium is None or premium <= 0.01:
            continue

        # Premium range filter
        if premium_min > 0 and premium < premium_min:
            continue
        if premium_max > 0 and premium > premium_max:
            continue

        # Check spread (use bar OHLC as proxy — if high-low is too wide, skip)
        bar_spread_pct = ((entry_bar["high"] - entry_bar["low"]) / premium * 100) if premium > 0 else 999
        if bar_spread_pct > 50:  # Very wide bar = illiquid
            continue

        return strike, ticker, premium, bars

    return None


def _simulate_trade(
    entry_premium: float,
    bars: List[Dict],
    entry_ts: int,
    settings: Dict[str, Any],
    strat_settings: Dict[str, Any],
) -> Dict[str, Any]:
    """Simulate a trade on actual option 1m bars with trailing stop logic.

    Returns trade result dict.
    """
    # Settings
    tp_pct = _safe_float(strat_settings.get("profitTargetPct") or settings.get("profitTargetPct"), 0.25)
    use_trailing = strat_settings.get("useTrailingStop", settings.get("useTrailingStop", True))
    trail_pct = _safe_float(strat_settings.get("trailingStopPct") or settings.get("trailingStopPct"), 0.07)
    trailing_tiers = settings.get("trailingTiers", [])
    stop_loss_pct = _safe_float(strat_settings.get("stopLossPct") or settings.get("stopLossPct"), 0)
    stale_after_mins = _safe_float(settings.get("staleAfterMinutes"), 0)
    stale_min_gain = _safe_float(settings.get("staleMinGainPct"), 0.10)
    time_exit_str = strat_settings.get("timeExitAt", "15:30")
    time_exit_enabled = bool(time_exit_str and time_exit_str.strip())

    target_price = entry_premium * (1 + tp_pct)
    hwm = entry_premium
    trailing_activated = False
    mfe_premium = entry_premium
    mae_premium = entry_premium

    # Filter bars to those after entry
    trade_bars = [b for b in bars if b["time"] >= entry_ts]
    if not trade_bars:
        return {"exit_premium": 0.01, "exit_reason": "no_bars", "exit_ts": entry_ts, "hwm": hwm, "mfe_premium": mfe_premium, "mae_premium": mae_premium, "bars_held": 0}

    # Parse time exit
    h, m = 15, 30
    if time_exit_enabled:
        try:
            h, m = map(int, time_exit_str.split(":"))
        except Exception:
            time_exit_enabled = False

    for bar in trade_bars:
        premium = bar["close"]
        if premium is None or premium <= 0:
            continue

        # Track MFE/MAE on premium
        if premium > mfe_premium:
            mfe_premium = premium
        if premium < mae_premium:
            mae_premium = premium

        # Update HWM
        if premium > hwm:
            hwm = premium

        # Determine trail_pct from tiers
        effective_trail = trail_pct
        if use_trailing and trailing_tiers and isinstance(trailing_tiers, list) and entry_premium > 0:
            current_gain = (hwm - entry_premium) / entry_premium
            for tier in sorted(trailing_tiers, key=lambda t: t.get("above", 0), reverse=True):
                if current_gain >= _safe_float(tier.get("above"), 0):
                    effective_trail = _safe_float(tier.get("trail"), trail_pct)
                    break

        # Trailing stop logic
        trail_stop_price = hwm * (1 - effective_trail) if use_trailing else 0
        if use_trailing and trail_stop_price < entry_premium:
            trail_stop_price = entry_premium  # Breakeven floor

        if not trailing_activated and hwm >= target_price:
            trailing_activated = True

        # Check close conditions
        bar_dt = datetime.fromtimestamp(bar["time"], NY)

        # Time exit
        if time_exit_enabled and (bar_dt.hour > h or (bar_dt.hour == h and bar_dt.minute >= m)):
            return {
                "exit_premium": premium, "exit_reason": f"time_exit_{time_exit_str}",
                "exit_ts": bar["time"], "hwm": hwm, "trail_pct_used": effective_trail,
                "mfe_premium": mfe_premium, "mae_premium": mae_premium,
                "bars_held": len([b for b in trade_bars if b["time"] <= bar["time"]]),
            }

        # Stale position exit
        if stale_after_mins > 0:
            hold_mins = (bar["time"] - entry_ts) / 60
            if hold_mins >= stale_after_mins:
                gain_pct = (premium - entry_premium) / entry_premium if entry_premium > 0 else 0
                if gain_pct < stale_min_gain:
                    return {
                        "exit_premium": premium, "exit_reason": "stale_exit",
                        "exit_ts": bar["time"], "hwm": hwm, "trail_pct_used": effective_trail,
                        "mfe_premium": mfe_premium, "mae_premium": mae_premium,
                        "bars_held": len([b for b in trade_bars if b["time"] <= bar["time"]]),
                    }

        # Stop loss
        if stop_loss_pct > 0:
            sl_price = entry_premium * (1 - stop_loss_pct)
            if premium <= sl_price:
                return {
                    "exit_premium": premium, "exit_reason": "stop_loss",
                    "exit_ts": bar["time"], "hwm": hwm, "trail_pct_used": effective_trail,
                    "mfe_premium": mfe_premium, "mae_premium": mae_premium,
                    "bars_held": len([b for b in trade_bars if b["time"] <= bar["time"]]),
                }

        # Trailing stop
        if trailing_activated and premium <= trail_stop_price:
            return {
                "exit_premium": premium, "exit_reason": "trailing_stop",
                "exit_ts": bar["time"], "hwm": hwm, "trail_pct_used": effective_trail,
                "mfe_premium": mfe_premium, "mae_premium": mae_premium,
                "bars_held": len([b for b in trade_bars if b["time"] <= bar["time"]]),
            }

        # Fixed TP (no trailing)
        if not use_trailing and premium >= target_price:
            return {
                "exit_premium": premium, "exit_reason": "target_hit",
                "exit_ts": bar["time"], "hwm": hwm, "trail_pct_used": 0,
                "mfe_premium": mfe_premium, "mae_premium": mae_premium,
                "bars_held": len([b for b in trade_bars if b["time"] <= bar["time"]]),
            }

    # End of day — force close at last bar
    last = trade_bars[-1]
    return {
        "exit_premium": last["close"] or 0.01, "exit_reason": "eod_close",
        "exit_ts": last["time"], "hwm": hwm, "trail_pct_used": effective_trail if use_trailing else 0,
        "mfe_premium": mfe_premium, "mae_premium": mae_premium,
        "bars_held": len(trade_bars),
    }


def run_backtest(
    symbol: str = "SPY",
    start_date: str = "2026-03-27",
    end_date: str = "2026-04-10",
    lookback_days: int = 10,
    settings_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    symbol = symbol.upper()
    """Run the full options backtest.

    For each trading day:
    1. Fetch underlying bars from IB
    2. Run strategy signal detection
    3. For each signal, fetch real option bars from Polygon
    4. Simulate entry + trailing stop on actual premiums
    5. Compute P&L

    Args:
        symbol: Underlying ticker
        start_date: First date to backtest (YYYY-MM-DD)
        end_date: Last date to backtest (YYYY-MM-DD)
        lookback_days: Days of lookback for indicator warmup
        settings_override: Optional settings to override auto trader defaults

    Returns:
        Dict with trades, summary stats, and per-day breakdown.
    """
    trading_days = _get_trading_days(start_date, end_date)
    if not trading_days:
        return {"error": "No trading days in range", "trades": []}

    # Load settings
    at_settings = get_auto_trader_settings()
    if settings_override:
        at_settings.update(settings_override)
    # Normalize tickerSettings keys to uppercase so case-mismatched callers
    # (e.g. forms that pass the user's literal input as the dict key) don't
    # silently lose their per-ticker overrides when we look up by uppercased
    # symbol below.
    _ts_raw = at_settings.get("tickerSettings", {})
    if _ts_raw:
        at_settings["tickerSettings"] = {str(k).upper(): v for k, v in _ts_raw.items()}
    strategy_overrides = at_settings.get("strategySettings", {})
    # Ensure the backtested symbol is allowed in all strategies
    for _sk, _sv in strategy_overrides.items():
        if isinstance(_sv, dict) and "allowedTickers" in _sv:
            if symbol not in _sv["allowedTickers"]:
                _sv["allowedTickers"] = list(_sv["allowedTickers"]) + [symbol]
    symbol_settings = get_settings(symbol) or {}
    merged_settings = merge_strategy_settings(symbol_settings, strategy_overrides)
    # Also patch the merged settings (from defaults)
    for _sk, _sv in merged_settings.items():
        if isinstance(_sv, dict) and "allowedTickers" in _sv:
            if symbol not in _sv["allowedTickers"]:
                _sv["allowedTickers"] = list(_sv["allowedTickers"]) + [symbol]

    # Chop filter settings
    chop_enabled = at_settings.get("chopFilterEnabled", True)
    chop_adx_threshold = _safe_float(at_settings.get("chopFilterAdxThreshold"), 20)
    chop_di_gap = _safe_float(at_settings.get("chopFilterDiGap"), 10)
    chop_tf = at_settings.get("chopFilterTimeframe", "5m")

    # Enabled strategies filter
    enabled_set = None
    ticker_cfg = at_settings.get("tickerSettings", {}).get(symbol, {})
    enabled_list = ticker_cfg.get("enabledStrategies")
    if enabled_list:
        enabled_set = set(enabled_list)
    logger.info(
        f"Backtest gating for {symbol}: enabled_set={enabled_set} "
        f"saved_strategy12.enabled={strategy_overrides.get('strategy12', {}).get('enabled')} "
        f"saved_strategy13.enabled={strategy_overrides.get('strategy13', {}).get('enabled')} "
        f"saved_strategy14.enabled={strategy_overrides.get('strategy14', {}).get('enabled')}"
    )

    all_trades = []
    day_summaries = []
    polygon_calls = 0
    capital_limit = _safe_float(at_settings.get("capitalLimit"), 0)

    # Pre-fetch ALL underlying bars from Polygon for the full date range (much faster than per-day IB calls)
    lookback_start_str = (datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=lookback_days + 5)).strftime("%Y-%m-%d")
    optimizer_progress["log"] = []
    optimizer_progress["running"] = True
    _progress("Fetch", f"Fetching {symbol} bars from Polygon...", 5)

    try:
        all_bars_1m = get_stock_bars(symbol, lookback_start_str, end_date, "1", "minute")
        all_bars_5m = get_stock_bars(symbol, lookback_start_str, end_date, "5", "minute")
        all_bars_15m = get_stock_bars(symbol, lookback_start_str, end_date, "15", "minute")
        all_bars_1h = get_stock_bars(symbol, lookback_start_str, end_date, "1", "hour")
        all_bars_1d = get_stock_bars(symbol, lookback_start_str, end_date, "1", "day")
        polygon_calls += 5
    except Exception as e:
        logger.error(f"Failed to fetch underlying bars from Polygon: {e}")
        return {"error": str(e), "trades": [], "summary": {}, "day_summaries": []}

    logger.info(f"Fetched bars: 1m={len(all_bars_1m)}, 5m={len(all_bars_5m)}, 15m={len(all_bars_15m)}, 1h={len(all_bars_1h)}, 1d={len(all_bars_1d)}")

    _progress("Fetch", f"Bars ready: 1m={len(all_bars_1m)}, 5m={len(all_bars_5m)}", 15)

    all_gex_levels = {}  # day_str -> gex_levels for chart rendering
    # Track which GEX-using strategies actually fired across the run, so the
    # chart only draws the levels relevant to the active strategy.
    _any_s12_active = False
    _any_s14_active = False

    for day_idx, day_str in enumerate(trading_days):
        day_start = time.time()
        day_pct = 15 + int((day_idx / len(trading_days)) * 80)
        _progress("Backtest", f"Day {day_idx+1}/{len(trading_days)}: {day_str}", day_pct)

        target_date = datetime.strptime(day_str, "%Y-%m-%d")
        target_ny = target_date.replace(tzinfo=NY)
        market_open = target_ny.replace(hour=9, minute=30, second=0)
        market_close = target_ny.replace(hour=16, minute=0, second=0)
        start_unix = int(market_open.timestamp())
        end_unix = int(market_close.timestamp())
        lookback_start = market_open - timedelta(days=lookback_days)
        lookback_unix = int(lookback_start.timestamp())

        # Filter pre-fetched bars to include lookback + current day
        bars_1m = [b for b in all_bars_1m if lookback_unix <= b["time"] <= end_unix]
        bars_5m = [b for b in all_bars_5m if lookback_unix <= b["time"] <= end_unix]
        bars_15m = [b for b in all_bars_15m if lookback_unix <= b["time"] <= end_unix]
        bars_1h = [b for b in all_bars_1h if lookback_unix <= b["time"] <= end_unix]
        bars_1d = [b for b in all_bars_1d if b["time"] <= end_unix]

        if not bars_1m or len(bars_1m) < 30:
            day_summaries.append({"date": day_str, "error": "insufficient_bars", "trades": 0, "pnl": 0})
            continue

        # Check if we have bars for this day
        day_bars = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
        if not day_bars:
            day_summaries.append({"date": day_str, "skipped": "no_bars_for_day", "trades": 0, "pnl": 0})
            continue

        # Run strategy analysis
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
            logger.error(f"Strategy analysis failed for {day_str}: {e}")
            day_summaries.append({"date": day_str, "error": f"analysis_failed: {e}", "trades": 0, "pnl": 0})
            continue

        # Filter signals to this day's market hours and deduplicate
        day_signals = [s for s in signals if start_unix <= s.entry_time <= end_unix]
        seen_ids = set()
        unique_signals = []
        for sig in day_signals:
            if sig.id not in seen_ids:
                seen_ids.add(sig.id)
                unique_signals.append(sig)

        # ── S12 GEX signals (if enabled via strategy dropdown or settings) ──
        # When enabled_set is provided (from the dropdown), treat it as
        # authoritative — otherwise saved live `strategy12.enabled=True` would
        # leak into every backtest regardless of dropdown choice.
        _s12_settings = strategy_overrides.get("strategy12", {})
        if enabled_set is not None:
            _s12_enabled = 12 in enabled_set
        else:
            _s12_enabled = _s12_settings.get("enabled", False)
        if _s12_enabled:
            _any_s12_active = True
            try:
                from app.services.strategy12_gex import scan_day_for_gex_signals, compute_gex_for_backtest
                _spot_for_gex = day_bars[len(day_bars) // 2]["close"] if day_bars else None
                if _spot_for_gex:
                    # Use SPY options directly (Polygon has SPY historical data)
                    _gex_levels = compute_gex_for_backtest(symbol="SPY", day_str=day_str, spot=_spot_for_gex, strike_range=15)
                    if _gex_levels and not _gex_levels.get("error"):
                        all_gex_levels[day_str] = _gex_levels
                        # Merge defaults → saved overrides → form entry times
                        _s12_merged = {**DEFAULT_STRATEGY_SETTINGS.get("strategy12", {}), **_s12_settings, "enabled": True}
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
                        for sig in _gex_sigs:
                            if sig.id not in seen_ids:
                                unique_signals.append(sig)
                                seen_ids.add(sig.id)
                        logger.info(f"  S12: {len(_gex_sigs)} GEX signals, {len(_gex_levels.get('long_gamma_nodes',[]))} LGN nodes")
                    else:
                        logger.info(f"  S12: no GEX levels for {day_str}")
            except Exception as exc:
                logger.warning(f"S12 backtest GEX failed for {day_str}: {exc}", exc_info=True)

        # ── S14 Gamma Zero signals (if enabled via dropdown or settings) ──
        _s14_settings = strategy_overrides.get("strategy14", {})
        if enabled_set is not None:
            _s14_enabled = 14 in enabled_set
        else:
            _s14_enabled = _s14_settings.get("enabled", False)
        if _s14_enabled:
            _any_s14_active = True
            try:
                from app.services.strategy12_gex import compute_gex_for_backtest
                from app.services.strategy14_gamma_zero import (
                    scan_day_for_gamma_zero_signals,
                    adapt_backtest_gex_for_s14,
                )
                _spot_for_s14 = day_bars[len(day_bars) // 2]["close"] if day_bars else None
                if _spot_for_s14:
                    # Reuse cached GEX from S12 if it ran for the same day; otherwise compute now.
                    _gex_raw = all_gex_levels.get(day_str) or compute_gex_for_backtest(
                        symbol="SPY", day_str=day_str, spot=_spot_for_s14, strike_range=15
                    )
                    if _gex_raw and not _gex_raw.get("error"):
                        all_gex_levels.setdefault(day_str, _gex_raw)
                        _gex_s14 = adapt_backtest_gex_for_s14(_gex_raw)
                        # Force allowedTickers to include the backtest symbol so the
                        # detector doesn't reject it (live default is ["SPY"]).
                        _s14_merged = {
                            **DEFAULT_STRATEGY_SETTINGS.get("strategy14", {}),
                            **_s14_settings,
                            "enabled": True,
                            "allowedTickers": [symbol.upper()],
                        }
                        _s14_day_bars_1m = [b for b in bars_1m if start_unix <= b["time"] <= end_unix]
                        _s14_day_bars_5m = [b for b in bars_5m if start_unix <= b["time"] <= end_unix]
                        # Diagnostic: dump GEX levels and a few in-window spot samples
                        _cw = (_gex_s14.get("call_wall") or {}).get("strike")
                        _pw = (_gex_s14.get("put_wall") or {}).get("strike")
                        _gf = (_gex_s14.get("gamma_flip") or {}).get("strike")
                        # Sample spot at 10:00, 11:00, 14:00, 14:30 ET
                        from datetime import datetime as _dt
                        _samples = []
                        for _hh, _mm in ((10, 0), (10, 30), (11, 0), (11, 30), (14, 0), (14, 30), (15, 0)):
                            _t = int(target_ny.replace(hour=_hh, minute=_mm).timestamp())
                            _bar = next((b for b in _s14_day_bars_1m if b["time"] >= _t), None)
                            if _bar:
                                _samples.append(f"{_hh:02d}:{_mm:02d}=${_bar['close']:.2f}")
                        logger.info(
                            f"  S14 diag for {day_str}: CW=${_cw} PW=${_pw} flip=${_gf} "
                            f"regime={_gex_s14.get('regime')} spot_samples=[{', '.join(_samples)}] "
                            f"proximityPct={_s14_merged.get('wallProximityPct')} "
                            f"flipBufferPct={_s14_merged.get('gammaZeroBufferPct')}"
                        )
                        _s14_sigs = scan_day_for_gamma_zero_signals(
                            symbol=symbol,
                            bars_1m=_s14_day_bars_1m,
                            bars_5m=_s14_day_bars_5m,
                            gex_levels=_gex_s14,
                            settings={"strategy14": _s14_merged},
                            scan_interval=5,
                        )
                        for sig in _s14_sigs:
                            if sig.id not in seen_ids:
                                unique_signals.append(sig)
                                seen_ids.add(sig.id)
                        logger.info(f"  S14: {len(_s14_sigs)} Gamma Zero signals (regime={_gex_s14.get('regime')})")
                    else:
                        logger.info(f"  S14: no GEX levels for {day_str}")
            except Exception as exc:
                logger.warning(f"S14 backtest failed for {day_str}: {exc}", exc_info=True)

        # ── S13 Opening Direction signals (if enabled) ──
        _s13_settings = strategy_overrides.get("strategy13", {})
        if enabled_set is not None:
            _s13_enabled = 13 in enabled_set
        else:
            _s13_enabled = _s13_settings.get("enabled", False)
        if _s13_enabled:
            try:
                from app.services.strategy13_opening_direction import scan_day_for_opening_direction_signals
                _prev_day_bars = [b for b in all_bars_1d if b["time"] < start_unix]
                _prev_close_s13 = _prev_day_bars[-1]["close"] if _prev_day_bars else None
                _s13_merged = {**DEFAULT_STRATEGY_SETTINGS.get("strategy13", {}), **_s13_settings, "enabled": True}
                if at_settings.get("entryStartTime"):
                    _s13_merged["entryStartTime"] = at_settings["entryStartTime"]
                if at_settings.get("entryEndTime"):
                    _s13_merged["entryEndTime"] = at_settings["entryEndTime"]
                _s13_day_bars_5m = [b for b in bars_5m if start_unix <= b["time"] <= end_unix]
                _s13_sigs = scan_day_for_opening_direction_signals(
                    symbol=symbol,
                    bars_5m=_s13_day_bars_5m,
                    settings={"strategy13": _s13_merged},
                    prev_close=_prev_close_s13,
                )
                for sig in _s13_sigs:
                    if sig.id not in seen_ids:
                        unique_signals.append(sig)
                        seen_ids.add(sig.id)
                logger.info(f"  S13: {len(_s13_sigs)} Opening Direction signals")
            except Exception as exc:
                logger.warning(f"S13 backtest failed for {day_str}: {exc}", exc_info=True)

        if not unique_signals:
            day_summaries.append({
                "date": day_str, "signals_total": len(day_signals),
                "signals_after_filter": 0, "trades": 0, "pnl": 0,
            })
            continue

        # Get the spot price for strike selection
        spot_at_day = day_bars[0]["close"] if day_bars else None
        if not spot_at_day:
            continue

        # Pre-fetch option bars from Polygon for nearby strikes
        day_high = max(b["high"] for b in day_bars)
        day_low = min(b["low"] for b in day_bars)
        day_mid = (day_high + day_low) / 2
        signal_directions = set(s.direction for s in unique_signals)
        near_strikes = sorted(set(
            [round(day_mid + i) for i in range(-8, 9)]
        ))

        option_bars_cache: Dict[str, List[Dict]] = {}
        rights_to_fetch = []
        if "CALL" in signal_directions:
            rights_to_fetch.append("C")
        if "PUT" in signal_directions:
            rights_to_fetch.append("P")
        if not rights_to_fetch:
            rights_to_fetch = ["C", "P"]

        for strike in near_strikes:
            for right in rights_to_fetch:
                ticker = build_option_ticker(symbol, day_str, right, strike)
                try:
                    opt_bars_fetched = get_option_bars(ticker, day_str, day_str, "1", "minute")
                    if opt_bars_fetched:
                        option_bars_cache[ticker] = opt_bars_fetched
                        polygon_calls += 1
                except Exception as e:
                    logger.debug(f"No Polygon data for {ticker}: {e}")

        # Simulate trades using shared core logic
        from app.services.backtest_core import simulate_day_trades
        day_trades, _, day_skipped = simulate_day_trades(
            symbol=symbol,
            day_str=day_str,
            unique_signals=unique_signals,
            day_bars=day_bars,
            near_strikes=near_strikes,
            option_bars_cache=option_bars_cache,
            at_settings=at_settings,
            strategy_overrides=strategy_overrides,
            chop_enabled=chop_enabled,
            chop_adx_threshold=chop_adx_threshold,
            chop_di_gap=chop_di_gap,
            chop_tf=chop_tf,
            bars_5m=[b for b in all_bars_5m if lookback_unix <= b["time"] <= end_unix],
            bars_15m=[b for b in all_bars_15m if lookback_unix <= b["time"] <= end_unix],
        )
        all_trades.extend(day_trades)
        all_trades.extend(day_skipped)

        day_pnl = sum(t["pnl"] for t in day_trades)
        day_summaries.append({
            "date": day_str,
            "signals_total": len(unique_signals),
            "signals_after_filter": len(day_trades),
            "trades": len(day_trades),
            "pnl": round(day_pnl, 2),
            "wins": sum(1 for t in day_trades if t["pnl"] > 0),
            "losses": sum(1 for t in day_trades if t["pnl"] <= 0),
            "elapsed_secs": round(time.time() - day_start, 1),
        })
        logger.info(f"  {day_str}: {len(day_trades)} trades, P&L ${day_pnl:+.0f} ({time.time() - day_start:.1f}s)")

    # Separate executed vs skipped trades
    executed_trades = [t for t in all_trades if not t.get("skipped")]
    skipped_trades_all = [t for t in all_trades if t.get("skipped")]

    # Compute summary (only executed trades)
    total_pnl = sum(t["pnl"] for t in executed_trades)
    wins = [t for t in executed_trades if t["pnl"] > 0]
    losses = [t for t in executed_trades if t["pnl"] <= 0]

    # Compute drawdown
    equity_curve = []
    cum_pnl = 0
    peak_equity = 0
    max_drawdown = 0
    max_drawdown_pct = 0
    drawdown_series = []
    for t in executed_trades:
        cum_pnl += t["pnl"]
        equity_curve.append(round(cum_pnl, 2))
        if cum_pnl > peak_equity:
            peak_equity = cum_pnl
        dd = cum_pnl - peak_equity
        if dd < max_drawdown:
            max_drawdown = dd
            max_drawdown_pct = round((dd / peak_equity) * 100, 1) if peak_equity > 0 else 0
        drawdown_series.append(round(dd, 2))

    n_exec = len(executed_trades)
    n_skip = len(skipped_trades_all)
    skip_pnl = sum(t["pnl"] for t in skipped_trades_all)

    summary = {
        "symbol": symbol,
        "start_date": start_date,
        "end_date": end_date,
        "trading_days": len(trading_days),
        "days_with_trades": sum(1 for d in day_summaries if d.get("trades", 0) > 0),
        "total_trades": n_exec,
        "skipped_trades": n_skip,
        "skipped_pnl": round(skip_pnl, 2),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / n_exec * 100, 1) if n_exec else 0,
        "total_pnl": round(total_pnl, 2),
        "avg_pnl": round(total_pnl / n_exec, 2) if n_exec else 0,
        "best_trade": round(max((t["pnl"] for t in executed_trades), default=0), 2),
        "worst_trade": round(min((t["pnl"] for t in executed_trades), default=0), 2),
        "max_drawdown": round(max_drawdown, 2),
        "max_drawdown_pct": max_drawdown_pct,
        "avg_mfe": round(sum(t["mfe_pct"] for t in executed_trades) / n_exec, 1) if n_exec else 0,
        "avg_mae": round(sum(t["mae_pct"] for t in executed_trades) / n_exec, 1) if n_exec else 0,
        "avg_hold_minutes": round(sum(t["hold_minutes"] for t in executed_trades) / n_exec) if n_exec else 0,
        "polygon_api_calls": polygon_calls,
        "equity_curve": equity_curve,
        "drawdown_series": drawdown_series,
    }

    _progress("Done", f"Complete: {len(all_trades)} trades, P&L ${total_pnl:+.0f}", 100)
    optimizer_progress["running"] = False

    # Filter bars to just the backtest date range for the chart
    range_start = int(datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=NY, hour=9, minute=30).timestamp())
    range_end = int(datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=NY, hour=16, minute=0).timestamp())
    chart_bars = {
        "1m": [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]} for b in all_bars_1m if range_start <= b["time"] <= range_end],
        "5m": [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]} for b in all_bars_5m if range_start <= b["time"] <= range_end],
        "15m": [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]} for b in all_bars_15m if range_start <= b["time"] <= range_end],
        "1h": [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]} for b in all_bars_1h if range_start <= b["time"] <= range_end],
    }

    # Build GEX zones for the chart. The set of lines drawn depends on which
    # GEX strategy is active so the chart only shows what's actually being
    # used for entry decisions.
    #   - S14 only:  3 lines  → Call Wall, Put Wall, Gamma Flip
    #   - S12 (or S12+S14):   full set → LGN/SGN/Zero (S12 trades AT each LGN node)
    gex_zones = []
    _s14_only = _any_s14_active and not _any_s12_active
    for gex_day, gex_data in all_gex_levels.items():
        if _s14_only:
            cw = gex_data.get("call_wall") or {}
            pw = gex_data.get("put_wall") or {}
            if cw.get("strike") is not None:
                gex_zones.append({
                    "strike": cw["strike"], "type": "CALL_WALL",
                    "net_gex": round(cw.get("gex", 0)), "day": gex_day,
                })
            if pw.get("strike") is not None:
                gex_zones.append({
                    "strike": pw["strike"], "type": "PUT_WALL",
                    "net_gex": round(pw.get("gex", 0)), "day": gex_day,
                })
            zg = gex_data.get("zero_gamma")
            if zg is not None:
                gex_zones.append({
                    "strike": round(zg, 2), "type": "FLIP",
                    "net_gex": 0, "day": gex_day,
                })
        else:
            for node in gex_data.get("long_gamma_nodes", []):
                gex_zones.append({
                    "strike": node["strike"], "type": "LGN", "node_type": node["type"],
                    "net_gex": round(node.get("net_gex", 0)), "day": gex_day,
                })
            for node in gex_data.get("short_gamma_nodes", []):
                gex_zones.append({
                    "strike": node["strike"], "type": "SGN",
                    "net_gex": round(node.get("net_gex", 0)), "day": gex_day,
                })
            if gex_data.get("zero_gamma"):
                gex_zones.append({
                    "strike": round(gex_data["zero_gamma"], 2), "type": "ZERO",
                    "net_gex": 0, "day": gex_day,
                })

    return {
        "summary": summary,
        "trades": all_trades,
        "day_summaries": day_summaries,
        "chart_bars": chart_bars,
        "gex_zones": gex_zones,
        "settings_used": {
            "profitTargetPct": at_settings.get("profitTargetPct"),
            "trailingStopPct": at_settings.get("trailingStopPct"),
            "trailingTiers": at_settings.get("trailingTiers"),
            "stopLossPct": at_settings.get("stopLossPct"),
            "chopFilterEnabled": chop_enabled,
            "chopFilterAdxThreshold": chop_adx_threshold,
            "chopFilterDiGap": chop_di_gap,
            "chopFilterTimeframe": chop_tf,
            "capitalLimit": capital_limit,
        },
    }
