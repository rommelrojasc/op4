"""Multi-day backtest range analysis service."""
from __future__ import annotations

import asyncio
import logging
import math
import statistics
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.ib.market_data import get_historical_bars
from app.services.strategy_analysis import (
    analyze_with_bars,
    calculate_choppiness_index,
)
from app.services.strategy_defaults import merge_strategy_settings
from app.services.strategy_settings import get_settings
from app.services.auto_trader_settings import get_settings as get_auto_trader_settings

logger = logging.getLogger(__name__)

NY_TZ = ZoneInfo("America/New_York")


def _trading_days(start: date, end: date) -> List[date]:
    """Generate trading days (skip weekends) between start and end inclusive."""
    days = []
    current = start
    while current <= end:
        if current.weekday() < 5:  # Mon-Fri
            days.append(current)
        current += timedelta(days=1)
    return days


def _classify_session(entry_time: int) -> str:
    """Map signal time to its hour bucket (ET). Returns hour as string, e.g. '9', '10', ..., '15'."""
    dt = datetime.fromtimestamp(entry_time, NY_TZ)
    return str(dt.hour)


def _classify_choppiness(ci_value: float) -> str:
    """Classify choppiness index value into regime."""
    if ci_value < 38.2:
        return "trending"
    elif ci_value > 61.8:
        return "choppy"
    return "mixed"


def _compute_mfe_mae(
    signal: Any,
    bars1m: List[Dict[str, Any]],
    market_close_unix: int,
) -> Dict[str, Optional[float]]:
    """Compute Max Favorable Excursion and Max Adverse Excursion for a signal.

    Uses 1m bars after signal entry_time until market close.
    Handles CALL (bullish) vs PUT (bearish) directions.
    """
    entry_time = signal.entry_time
    direction = signal.direction  # "CALL" or "PUT"

    # Find 1m bars after entry
    post_bars = [b for b in bars1m if b["time"] > entry_time and b["time"] <= market_close_unix]
    if not post_bars:
        return {"mfe_pct": None, "mae_pct": None}

    # Use the bar closest to entry as reference price
    entry_bar = None
    for b in bars1m:
        if b["time"] <= entry_time:
            entry_bar = b
        else:
            break
    if entry_bar is None and bars1m:
        entry_bar = bars1m[0]
    if entry_bar is None:
        return {"mfe_pct": None, "mae_pct": None}

    entry_price = entry_bar["close"]
    if entry_price <= 0:
        return {"mfe_pct": None, "mae_pct": None}

    max_favorable = 0.0
    max_adverse = 0.0

    for bar in post_bars:
        if direction == "CALL":
            # Bullish: favorable = price going up
            favorable = (bar["high"] - entry_price) / entry_price * 100
            adverse = (entry_price - bar["low"]) / entry_price * 100
        else:
            # Bearish: favorable = price going down
            favorable = (entry_price - bar["low"]) / entry_price * 100
            adverse = (bar["high"] - entry_price) / entry_price * 100

        max_favorable = max(max_favorable, favorable)
        max_adverse = max(max_adverse, adverse)

    return {"mfe_pct": round(max_favorable, 4), "mae_pct": round(max_adverse, 4)}


def _percentile(data: List[float], p: float) -> float:
    """Compute percentile of a sorted list."""
    if not data:
        return 0.0
    sorted_data = sorted(data)
    k = (len(sorted_data) - 1) * p / 100.0
    f = int(k)
    c = f + 1
    if c >= len(sorted_data):
        return sorted_data[-1]
    return sorted_data[f] + (k - f) * (sorted_data[c] - sorted_data[f])


def _build_distribution(values: List[float], buckets: List[tuple]) -> List[Dict[str, Any]]:
    """Build histogram distribution from values into labeled buckets.

    buckets: list of (label, min_val, max_val) tuples.
    """
    result = []
    for label, lo, hi in buckets:
        count = sum(1 for v in values if lo <= v < hi)
        result.append({"label": label, "count": count})
    return result


MFE_BUCKETS = [
    ("0-0.25%", 0, 0.25),
    ("0.25-0.5%", 0.25, 0.5),
    ("0.5-1%", 0.5, 1.0),
    ("1-2%", 1.0, 2.0),
    ("2-5%", 2.0, 5.0),
    ("5%+", 5.0, 1000.0),
]

MAE_BUCKETS = [
    ("0-0.25%", 0, 0.25),
    ("0.25-0.5%", 0.25, 0.5),
    ("0.5-1%", 0.5, 1.0),
    ("1-2%", 1.0, 2.0),
    ("2-5%", 2.0, 5.0),
    ("5%+", 5.0, 1000.0),
]


async def _fetch_day_data(
    symbol: str,
    day: date,
    lookback_days: int,
    enabled_strategies: Optional[set] = None,
) -> Dict[str, Any]:
    """Fetch bars and run analysis for a single day."""
    ny_tz = NY_TZ
    market_open = datetime(day.year, day.month, day.day, 9, 30, tzinfo=ny_tz)
    market_close = datetime(day.year, day.month, day.day, 16, 0, tzinfo=ny_tz)
    analysis_end = datetime(day.year, day.month, day.day, 15, 45, tzinfo=ny_tz)

    start_unix = int(market_open.timestamp())
    end_unix = int(market_close.timestamp())

    now = datetime.now(ny_tz)
    days_ago = (now - datetime(day.year, day.month, day.day, tzinfo=ny_tz)).days

    lookback_start = market_open - timedelta(days=lookback_days)
    lookback_start_unix = int(lookback_start.timestamp())

    def bars_needed(interval: str) -> int:
        if interval == "1d":
            return max(200, days_ago + lookback_days + 50)
        elif interval == "1h":
            return max(100, (days_ago + lookback_days) * 7 + 50)
        elif interval == "15m":
            return max(500, (days_ago + lookback_days) * 26 + 50)
        elif interval == "5m":
            return max(500, (days_ago + lookback_days) * 78 + 50)
        elif interval == "1m":
            return max(500, (days_ago + lookback_days) * 390 + 50)
        return 500

    async def fetch_bars(interval: str):
        try:
            return await get_historical_bars(
                symbol=symbol.upper(),
                interval=interval,
                bars_count=bars_needed(interval),
                use_rth=True,
                end_date=market_close,
            )
        except Exception as e:
            logger.error(f"Error fetching {interval} bars for {symbol} on {day}: {e}")
            return []

    # Fetch sequentially to avoid overwhelming IB Gateway
    bars_1d = await fetch_bars("1d")
    bars_1h = await fetch_bars("1h")
    bars_15m = await fetch_bars("15m")
    bars_5m = await fetch_bars("5m")
    bars_1m = await fetch_bars("1m")

    def to_dict(bars):
        if not bars:
            return []
        if isinstance(bars[0], dict):
            return [{"time": b["time"], "open": b["open"], "high": b["high"],
                      "low": b["low"], "close": b["close"], "volume": b["volume"]} for b in bars]
        return [{"time": b.time, "open": b.open, "high": b.high,
                  "low": b.low, "close": b.close, "volume": b.volume} for b in bars]

    bars1d = to_dict(bars_1d)
    bars1h = to_dict(bars_1h)
    bars15m = to_dict(bars_15m)
    bars5m = to_dict(bars_5m)
    bars1m = to_dict(bars_1m)

    # Filter 15m bars to market hours for the chart
    day_15m_bars_rth = [b for b in bars15m if start_unix <= b["time"] <= end_unix]

    # Check if bars exist for this day
    bars_in_range = [b for b in bars1m if start_unix <= b["time"] <= end_unix]
    if not bars_in_range:
        return {"date": day.isoformat(), "has_data": False, "signals": [],
                "choppiness_avg": None, "regime": None, "bars_15m": []}

    # Load settings (per-symbol + auto-trader strategy overrides)
    settings_dict = get_settings(symbol.upper()) or {}
    at_settings = get_auto_trader_settings()
    strategy_overrides = at_settings.get("strategySettings", {})
    merged_settings = merge_strategy_settings(settings_dict, strategy_overrides)

    visible_range = {"from": lookback_start_unix, "to": int(analysis_end.timestamp())}

    signals = analyze_with_bars(
        symbol=symbol.upper(),
        visible_range=visible_range,
        bars1h=bars1h,
        bars15m=bars15m,
        bars1d=bars1d,
        bars1m=bars1m,
        settings=merged_settings,
        bars5m=bars5m,
        bars15m_open=bars15m,
        enabled_strategies=enabled_strategies,
    )

    # Filter to only today's signals
    day_signals = [s for s in signals if start_unix <= s.entry_time <= end_unix]

    # Compute choppiness index on 15m bars for the day
    day_15m_bars = [b for b in bars15m if start_unix <= b["time"] <= end_unix]
    ci_values = calculate_choppiness_index(day_15m_bars, period=14)
    valid_ci = [v for v in ci_values if v is not None]
    choppiness_avg = round(statistics.mean(valid_ci), 2) if valid_ci else None
    regime = _classify_choppiness(choppiness_avg) if choppiness_avg is not None else None

    # Compute MFE/MAE for each signal
    signal_details = []
    for sig in day_signals:
        mfe_mae = _compute_mfe_mae(sig, bars1m, end_unix)
        signal_details.append({
            "date": day.isoformat(),
            "strategy_id": sig.strategy_id,
            "direction": sig.direction,
            "entry_time": sig.entry_time,
            "session": _classify_session(sig.entry_time),
            "mfe_pct": mfe_mae["mfe_pct"],
            "mae_pct": mfe_mae["mae_pct"],
        })

    return {
        "date": day.isoformat(),
        "has_data": True,
        "signal_count": len(day_signals),
        "signals": signal_details,
        "choppiness_avg": choppiness_avg,
        "regime": regime,
        "bars_15m": day_15m_bars_rth,
    }


async def run_range_analysis(
    symbol: str,
    start_date: str,
    end_date: str,
    lookback_days: int = 10,
    on_progress: Optional[Any] = None,
    enabled_strategies: Optional[set] = None,
) -> Dict[str, Any]:
    """Run multi-day backtest range analysis.

    Args:
        symbol: Stock symbol
        start_date: Start date YYYY-MM-DD
        end_date: End date YYYY-MM-DD
        lookback_days: Number of lookback days for indicator warmup
        on_progress: Optional async callback(message: str) for progress updates

    Returns:
        Complete range analysis summary dict
    """
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)

    trading_days = _trading_days(start, end)
    total = len(trading_days)
    logger.info(f"Range analysis for {symbol}: {total} trading days from {start_date} to {end_date}")

    async def _progress(msg: str):
        if on_progress:
            await on_progress(msg)

    # Check IB connection before starting
    from app.services.ib.gateway import ib_manager
    if not ib_manager.is_connected():
        await _progress("Reconnecting to IB Gateway...")
        logger.warning("IB Gateway not connected, attempting reconnect before range analysis")
        try:
            await ib_manager.connect()
        except Exception:
            pass

    # Process days sequentially to respect IB rate limits
    all_day_results = []
    consecutive_failures = 0
    for i, day in enumerate(trading_days):
        await _progress(f"Fetching data for {day.strftime('%b %d')} ({i+1}/{total})...")
        logger.info(f"Processing day {i+1}/{total}: {day.isoformat()}")
        try:
            result = await _fetch_day_data(symbol, day, lookback_days, enabled_strategies)
            all_day_results.append(result)
            if result.get("has_data"):
                consecutive_failures = 0
            else:
                consecutive_failures += 1
        except Exception as e:
            logger.error(f"Error processing {day}: {e}", exc_info=True)
            all_day_results.append({
                "date": day.isoformat(), "has_data": False,
                "signals": [], "choppiness_avg": None, "regime": None,
                "bars_15m": [],
            })
            consecutive_failures += 1

        # Abort early if IB appears to have disconnected (3+ consecutive failures)
        if consecutive_failures >= 3 and i < len(trading_days) - 1:
            logger.warning(f"Aborting range analysis after {consecutive_failures} consecutive failures (IB may be disconnected)")
            await _progress("IB Gateway connection lost — skipping remaining days")
            for remaining_day in trading_days[i + 1:]:
                all_day_results.append({
                    "date": remaining_day.isoformat(), "has_data": False,
                    "signals": [], "choppiness_avg": None, "regime": None,
                    "bars_15m": [],
                })
            break

        # Note: IB rate limit delays are handled inside get_historical_bars
        # (0.2s after each actual IB fetch, skipped on cache hits)

    # Aggregate results
    await _progress("Building report...")
    return _build_range_summary(symbol, start_date, end_date, trading_days, all_day_results)


def _build_range_summary(
    symbol: str,
    start_date: str,
    end_date: str,
    trading_days: List[date],
    day_results: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Aggregate day-level results into the range summary response."""
    days_with_data = [d for d in day_results if d.get("has_data")]
    all_signals = []
    all_bars_15m = []
    for d in day_results:
        all_signals.extend(d.get("signals", []))
        all_bars_15m.extend(d.get("bars_15m", []))

    total_signals = len(all_signals)

    # Trading hours (ET): 9:30-16:00 → hour buckets 9..15
    _TRADING_HOURS = [str(h) for h in range(9, 16)]

    # Strategy breakdown
    strategies: Dict[str, Dict[str, Any]] = {}
    for sig in all_signals:
        sid = sig["strategy_id"]
        if sid not in strategies:
            strategies[sid] = {
                "name": sid,
                "total": 0, "calls": 0, "puts": 0,
                "by_hour": {h: 0 for h in _TRADING_HOURS},
                "mfe_values": [], "mae_values": [],
            }
        s = strategies[sid]
        s["total"] += 1
        if sig["direction"] == "CALL":
            s["calls"] += 1
        else:
            s["puts"] += 1
        hour_key = sig["session"]  # now "9", "10", ..., "15"
        if hour_key in s["by_hour"]:
            s["by_hour"][hour_key] += 1
        if sig["mfe_pct"] is not None:
            s["mfe_values"].append(sig["mfe_pct"])
        if sig["mae_pct"] is not None:
            s["mae_values"].append(sig["mae_pct"])

    # Finalize strategy stats
    strategies_out = {}
    for sid, s in strategies.items():
        mfe_vals = s["mfe_values"]
        mae_vals = s["mae_values"]
        strategies_out[sid] = {
            "name": s["name"],
            "total": s["total"],
            "calls": s["calls"],
            "puts": s["puts"],
            "avg_mfe_pct": round(statistics.mean(mfe_vals), 4) if mfe_vals else None,
            "avg_mae_pct": round(statistics.mean(mae_vals), 4) if mae_vals else None,
            "median_mfe_pct": round(statistics.median(mfe_vals), 4) if mfe_vals else None,
            "median_mae_pct": round(statistics.median(mae_vals), 4) if mae_vals else None,
        }

    # Session matrix (hourly breakdown)
    session_matrix = []
    for sid, s in strategies_out.items():
        session_matrix.append({
            "strategy_id": sid,
            "name": s["name"],
            "hours": strategies[sid]["by_hour"],
            "total": s["total"],
        })

    # Days summary
    days_summary = []
    for d in day_results:
        days_summary.append({
            "date": d["date"],
            "signal_count": d.get("signal_count", 0),
            "choppiness_avg": d.get("choppiness_avg"),
            "regime": d.get("regime"),
            "has_data": d.get("has_data", False),
        })

    # Choppiness summary
    ci_values = [d["choppiness_avg"] for d in days_with_data if d.get("choppiness_avg") is not None]
    choppiness = {
        "avg_ci": round(statistics.mean(ci_values), 2) if ci_values else None,
        "trending_days": sum(1 for v in ci_values if v < 38.2),
        "choppy_days": sum(1 for v in ci_values if v > 61.8),
        "mixed_days": sum(1 for v in ci_values if 38.2 <= v <= 61.8),
        "total_days": len(ci_values),
    }

    # Trailing stop / MFE/MAE analysis
    all_mfe = [s["mfe_pct"] for s in all_signals if s["mfe_pct"] is not None]
    all_mae = [s["mae_pct"] for s in all_signals if s["mae_pct"] is not None]

    trailing_stop_analysis = {
        "total_signals_with_data": len(all_mfe),
        "avg_mfe_pct": round(statistics.mean(all_mfe), 4) if all_mfe else None,
        "median_mfe_pct": round(statistics.median(all_mfe), 4) if all_mfe else None,
        "p25_mfe_pct": round(_percentile(all_mfe, 25), 4) if all_mfe else None,
        "p75_mfe_pct": round(_percentile(all_mfe, 75), 4) if all_mfe else None,
        "avg_mae_pct": round(statistics.mean(all_mae), 4) if all_mae else None,
        "median_mae_pct": round(statistics.median(all_mae), 4) if all_mae else None,
        "p25_mae_pct": round(_percentile(all_mae, 25), 4) if all_mae else None,
        "p75_mae_pct": round(_percentile(all_mae, 75), 4) if all_mae else None,
        "mfe_distribution": _build_distribution(all_mfe, MFE_BUCKETS),
        "mae_distribution": _build_distribution(all_mae, MAE_BUCKETS),
    }

    return {
        "symbol": symbol.upper(),
        "start_date": start_date,
        "end_date": end_date,
        "trading_days_requested": len(trading_days),
        "trading_days_with_data": len(days_with_data),
        "total_signals": total_signals,
        "strategies": strategies_out,
        "session_matrix": session_matrix,
        "days": days_summary,
        "choppiness": choppiness,
        "trailing_stop_analysis": trailing_stop_analysis,
        "signals_detail": all_signals,
        "bars_15m": all_bars_15m,
    }
