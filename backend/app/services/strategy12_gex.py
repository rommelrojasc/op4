"""Strategy 12: GEX Mean Reversion at Gamma Nodes.

Generates signals when SPY price approaches Long Gamma nodes (LVN) with
momentum. Entries are mean-reversion: buy puts at positive gamma ceilings,
buy calls at negative gamma floors.

This strategy operates independently from analyze_with_bars because it
requires GEX levels computed from the option chain (not just bar data).
"""
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.gex_levels import (
    compute_gex_levels_from_quotes,
    find_nearest_long_gamma,
    find_tp_target,
    is_approaching_node,
    check_impulse_wick,
)
from app.services.strategy_analysis import StrategySignal

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")

STRATEGY_ID = "strategy12_gex_mean_reversion"


@dataclass
class GexSignal:
    """Extended signal with GEX-specific data."""
    signal: StrategySignal
    node_strike: float
    node_type: str  # "resistance" or "support"
    tp_target: Optional[float]  # Short gamma node for TP
    stop_strike: Optional[float]  # Behind the LGN for stop
    zero_gamma: Optional[float]
    regime: str


def detect_gex_signals(
    *,
    symbol: str,
    bars_1m: List[Dict],
    gex_levels: Dict[str, Any],
    settings: Dict[str, Any],
    at_timestamp: Optional[int] = None,
) -> List[GexSignal]:
    """Detect mean-reversion signals at Long Gamma nodes.

    Args:
        symbol: Trading symbol (SPY)
        bars_1m: Recent 1-minute bars for the symbol
        gex_levels: Output from compute_gex_levels_from_quotes
        settings: Strategy settings
        at_timestamp: Optional timestamp for backtesting (uses bar time instead of now)

    Returns:
        List of GexSignal objects
    """
    if not bars_1m or not gex_levels or gex_levels.get("error"):
        return []

    strat_settings = settings.get("strategy12", {})

    # Use bar timestamp for backtesting, current time for live
    if at_timestamp:
        now = datetime.fromtimestamp(at_timestamp, NY)
    else:
        now = datetime.now(NY)

    # Check time window — prefer entryStartTime/entryEndTime from form, fall back to operating times
    start_time = strat_settings.get("entryStartTime") or strat_settings.get("operatingStartTime", "09:45")
    end_time = strat_settings.get("entryEndTime") or strat_settings.get("operatingEndTime", "15:00")
    try:
        sh, sm = map(int, start_time.split(":"))
        eh, em = map(int, end_time.split(":"))
        current_mins = now.hour * 60 + now.minute
        if not (sh * 60 + sm <= current_mins <= eh * 60 + em):
            return []
    except (ValueError, AttributeError):
        pass

    # Don't trade after the late-day theta crush cutoff
    late_cutoff = strat_settings.get("lateCutoffTime", "15:00")
    try:
        lh, lm = map(int, late_cutoff.split(":"))
        if now.hour * 60 + now.minute > lh * 60 + lm:
            return []
    except (ValueError, AttributeError):
        pass

    spot = bars_1m[-1]["close"] if bars_1m else None
    if not spot:
        return []

    regime = gex_levels.get("regime", "")
    zero_gamma = gex_levels.get("zero_gamma")
    long_nodes = gex_levels.get("long_gamma_nodes", [])

    # Tuning parameters
    proximity_threshold = float(strat_settings.get("proximityThreshold", 2.0))  # $ distance to node
    min_velocity = float(strat_settings.get("minVelocity", 0.3))  # Min $ move in lookback
    velocity_lookback = int(strat_settings.get("velocityLookback", 5))  # Bars
    require_wick = strat_settings.get("requireWick", False)
    stop_distance = float(strat_settings.get("stopDistance", 1.5))  # $ behind node

    signals = []

    for node in long_nodes:
        node_strike = node["strike"]
        node_type = node["type"]
        trade_direction = node["trade_direction"]
        distance = abs(spot - node_strike)

        # Check proximity
        if distance > proximity_threshold:
            continue

        # Regime filter: only trade in the direction the regime supports
        if regime == "BULLISH" and trade_direction == "CALL":
            # Bullish regime + support floor → CALL ✓ (fade dip in bull market)
            pass
        elif regime == "BEARISH" and trade_direction == "PUT":
            # Bearish regime + resistance ceiling → PUT ✓ (fade rally in bear market)
            pass
        elif regime == "BULLISH" and trade_direction == "PUT":
            # Bullish regime but hitting ceiling → only trade if very strong node
            if abs(node.get("net_gex", 0)) < gex_levels.get("net_gex", 0) * 0.5:
                continue  # Node not strong enough to override regime
        elif regime == "BEARISH" and trade_direction == "CALL":
            if abs(node.get("net_gex", 0)) < abs(gex_levels.get("net_gex", 0)) * 0.5:
                continue

        # Check momentum ("hot tape")
        if not is_approaching_node(bars_1m, node_strike, node_type, velocity_lookback, min_velocity):
            continue

        # Optional: check for impulse wick
        if require_wick and not check_impulse_wick(bars_1m, node_strike, node_type):
            continue

        # Find TP target at nearest Short Gamma node
        tp = find_tp_target(gex_levels, node_strike, trade_direction)

        # Stop loss: tightly behind the Long Gamma node
        if node_type == "resistance":
            stop = node_strike + stop_distance
        else:
            stop = node_strike - stop_distance

        # Generate signal
        entry_time = bars_1m[-1]["time"]
        signal_id = f"{STRATEGY_ID}_{symbol}_{trade_direction.lower()}_{entry_time}"

        signal = StrategySignal(
            id=signal_id,
            symbol=symbol,
            strategy_id=STRATEGY_ID,
            direction=trade_direction,
            entry_time=entry_time,
            anchor_time=entry_time,
        )

        gex_signal = GexSignal(
            signal=signal,
            node_strike=node_strike,
            node_type=node_type,
            tp_target=tp,
            stop_strike=stop,
            zero_gamma=zero_gamma,
            regime=regime,
        )

        signals.append(gex_signal)
        _tp_str = f"${tp:.0f}" if tp else "n/a"
        logger.info(
            f"S12 signal: {trade_direction} at {node_type} node ${node_strike:.0f} "
            f"(spot ${spot:.2f}, dist ${distance:.2f}, regime {regime}, "
            f"TP {_tp_str}, stop ${stop:.1f})"
        )

    return signals


def compute_gex_for_backtest(
    *,
    symbol: str = "SPY",
    day_str: str,
    spot: float,
    strike_range: float = 15,
) -> Optional[Dict[str, Any]]:
    """Compute GEX levels for backtesting using Polygon SPY option bars.

    Uses SPY options (not SPX) because Polygon doesn't retain expired
    SPX contracts. Fetches 1m bars for each strike to estimate OI from
    volume, and approximates gamma from a Black-Scholes model.

    Args:
        symbol: "SPY" (uses SPY options for backtest GEX)
        day_str: Date string "YYYY-MM-DD"
        spot: SPY spot price
        strike_range: Dollar range around spot to scan

    Returns:
        GEX levels dict or None
    """
    try:
        import math
        from app.services.polygon_data import build_option_ticker, get_option_bars

        near_strikes = sorted(set([round(spot + i) for i in range(-int(strike_range), int(strike_range) + 1)]))

        quotes = []
        for strike in near_strikes:
            for right in ["C", "P"]:
                ticker = build_option_ticker(symbol, day_str, right, strike)
                try:
                    bars = get_option_bars(ticker, day_str, day_str, "1", "minute")
                except Exception:
                    bars = []

                if not bars:
                    continue

                # Use total volume as proxy for OI (actual OI not available from Polygon bars)
                total_vol = sum(b.get("volume", 0) for b in bars)
                if total_vol <= 0:
                    total_vol = 100  # Minimum

                # Approximate gamma using Black-Scholes normal distribution
                distance = abs(strike - spot)
                vol = 0.20  # Assume 20% annualized vol
                t = 1 / 252  # 0DTE
                sigma = spot * vol * math.sqrt(t)
                if sigma > 0:
                    gamma = math.exp(-0.5 * (distance / sigma) ** 2) / (sigma * math.sqrt(2 * math.pi))
                else:
                    gamma = 0

                quotes.append({
                    "strike": strike,
                    "right": right,
                    "gamma": gamma,
                    "oi": total_vol,  # Use volume as OI proxy
                    "delta": None,
                    "volume": total_vol,
                })

        if not quotes:
            logger.warning(f"No SPY option data from Polygon for {day_str}")
            return None

        logger.info(f"S12 backtest GEX: {len(quotes)} quotes for {len(near_strikes)} strikes on {day_str}")
        result = compute_gex_levels_from_quotes(quotes, spot, strike_range)
        if result is not None:
            result["quote_count"] = len(quotes)
        return result

    except Exception as e:
        logger.warning(f"Failed to compute backtest GEX: {e}")
        return None


def scan_day_for_gex_signals(
    *,
    symbol: str,
    bars_1m: List[Dict],
    gex_levels: Dict[str, Any],
    settings: Dict[str, Any],
    scan_interval: int = 30,
) -> List[StrategySignal]:
    """Scan an entire day's 1m bars for GEX signals (for backtesting).

    Instead of checking once at "now", this walks through the day's bars
    and checks for signals at regular intervals.

    Args:
        symbol: Trading symbol
        bars_1m: Full day's 1-minute bars
        gex_levels: GEX levels for the day
        settings: Strategy settings
        scan_interval: Check every N bars (default 30 = every 30 minutes)

    Returns:
        List of StrategySignal objects (deduplicated)
    """
    if not bars_1m or not gex_levels or gex_levels.get("error"):
        return []

    seen_ids = set()
    all_signals = []

    # Walk through the day checking for signals at intervals
    for i in range(scan_interval, len(bars_1m), scan_interval):
        # Use bars up to this point (simulates live scanning)
        bars_so_far = bars_1m[:i + 1]
        bar_ts = bars_so_far[-1]["time"]

        gex_sigs = detect_gex_signals(
            symbol=symbol,
            bars_1m=bars_so_far,
            gex_levels=gex_levels,
            settings=settings,
            at_timestamp=bar_ts,
        )

        for gs in gex_sigs:
            if gs.signal.id not in seen_ids:
                all_signals.append(gs.signal)
                seen_ids.add(gs.signal.id)

    return all_signals
