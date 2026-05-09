"""GEX level computation for Strategy 12 (Mean Reversion at Gamma Nodes).

Computes Long Gamma nodes (LVN — entry zones), Short Gamma nodes (HVN — TP zones),
Zero Gamma level, and regime from SPX/SPY 0DTE options chain.

Works with both IB Gateway (live) and Polygon (backtesting).
"""
import logging
import math
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


def compute_gex_levels_from_quotes(
    quotes: List[Dict[str, Any]],
    spot: float,
    strike_range: float = 100,
) -> Dict[str, Any]:
    """Compute GEX levels from a list of option quotes.

    This is the core computation used by both live (IB) and backtest (Polygon) paths.

    Args:
        quotes: List of quote dicts with strike, right, gamma, oi, delta, volume
        spot: Current underlying spot price
        strike_range: Dollar range around spot to analyze

    Returns:
        Dict with long_gamma_nodes, short_gamma_nodes, zero_gamma, regime, etc.
    """
    if not quotes or spot <= 0:
        return {"error": "No quotes or invalid spot", "levels": None}

    # Compute GEX per strike
    # Customer view: Long Gamma = customer is long vol at these strikes (LVN)
    # GEX = gamma × OI × 100 × spot² × 0.01
    gex_by_strike = defaultdict(lambda: {
        "call_gex": 0, "put_gex": 0, "net_gex": 0,
        "call_oi": 0, "put_oi": 0, "call_vol": 0, "put_vol": 0,
        "call_delta": 0, "put_delta": 0,
    })

    for q in quotes:
        strike = q.get("strike", 0)
        if abs(strike - spot) > strike_range:
            continue

        gamma = q.get("gamma") or 0
        oi = q.get("oi") or 0
        volume = q.get("volume") or 0
        delta = q.get("delta") or 0
        right = q.get("right", "")

        if gamma <= 0 or oi <= 0:
            continue

        gex = gamma * oi * 100 * spot * spot * 0.01

        entry = gex_by_strike[strike]
        if right == "C":
            entry["call_gex"] += gex
            entry["call_oi"] += oi
            entry["call_vol"] += volume
            entry["call_delta"] = delta
        elif right == "P":
            entry["put_gex"] -= gex  # Puts = negative GEX (customer perspective)
            entry["put_oi"] += oi
            entry["put_vol"] += volume
            entry["put_delta"] = delta

        entry["net_gex"] = entry["call_gex"] + entry["put_gex"]

    if not gex_by_strike:
        return {"error": "No valid GEX data computed", "levels": None}

    # Build sorted profile
    profile = []
    for strike in sorted(gex_by_strike.keys()):
        e = gex_by_strike[strike]
        total_oi = e["call_oi"] + e["put_oi"]
        profile.append({
            "strike": strike,
            "net_gex": round(e["net_gex"]),
            "call_gex": round(e["call_gex"]),
            "put_gex": round(e["put_gex"]),
            "call_oi": e["call_oi"],
            "put_oi": e["put_oi"],
            "total_oi": total_oi,
            "call_vol": e["call_vol"],
            "put_vol": e["put_vol"],
        })

    # ── Find Key Levels ──────────────────────────────────────────────────

    # Call Wall: strike with highest positive (call-side) GEX
    call_wall = max(profile, key=lambda x: x["call_gex"])

    # Put Wall: strike with most negative (put-side) GEX
    put_wall = min(profile, key=lambda x: x["put_gex"])

    # Zero Gamma: where net GEX crosses zero (interpolated)
    zero_gamma = None
    for i in range(1, len(profile)):
        prev = profile[i - 1]
        curr = profile[i]
        if prev["net_gex"] * curr["net_gex"] < 0:
            total = abs(prev["net_gex"]) + abs(curr["net_gex"])
            if total > 0:
                zero_gamma = prev["strike"] + (curr["strike"] - prev["strike"]) * abs(prev["net_gex"]) / total
            break

    # ── Identify Long Gamma Nodes (LVN — Entry Zones) ────────────────
    # These are strikes with high absolute GEX — hard ceilings/floors
    # Price violently rejects and reverts at these levels
    abs_gex_values = [abs(g["net_gex"]) for g in profile if g["net_gex"] != 0]
    avg_abs_gex = sum(abs_gex_values) / len(abs_gex_values) if abs_gex_values else 0
    threshold_long = avg_abs_gex * 1.5  # Significantly above average

    long_gamma_nodes = []
    for g in profile:
        if abs(g["net_gex"]) > threshold_long:
            node_type = "resistance" if g["net_gex"] > 0 else "support"
            # At positive LGN (resistance): buy puts (fade the ceiling)
            # At negative LGN (support): buy calls (fade the floor)
            trade_direction = "PUT" if g["net_gex"] > 0 else "CALL"
            long_gamma_nodes.append({
                "strike": g["strike"],
                "net_gex": g["net_gex"],
                "type": node_type,
                "trade_direction": trade_direction,
                "distance": round(g["strike"] - spot, 2),
            })

    # ── Identify Short Gamma Nodes (HVN — Take Profit Zones) ────────
    # These are strikes with low GEX but high OI — high liquidity areas
    # Price gets stuck in the "muck" — use as TP targets only
    avg_oi = sum(g["total_oi"] for g in profile) / len(profile) if profile else 0
    short_gamma_nodes = []
    for g in profile:
        if abs(g["net_gex"]) < avg_abs_gex * 0.3 and g["total_oi"] > avg_oi * 0.5:
            short_gamma_nodes.append({
                "strike": g["strike"],
                "net_gex": g["net_gex"],
                "total_oi": g["total_oi"],
                "distance": round(g["strike"] - spot, 2),
            })

    # ── Regime ────────────────────────────────────────────────────────
    if zero_gamma is not None:
        if spot > zero_gamma:
            regime = "BULLISH"
            regime_desc = "Spot above Zero Gamma — favor CALLs"
        else:
            regime = "BEARISH"
            regime_desc = "Spot below Zero Gamma — favor PUTs"
    else:
        net_total = sum(g["net_gex"] for g in profile)
        regime = "BULLISH" if net_total > 0 else "BEARISH"
        regime_desc = "Net positive gamma" if net_total > 0 else "Net negative gamma"

    # Total GEX
    total_positive = sum(g["call_gex"] for g in profile)
    total_negative = sum(g["put_gex"] for g in profile)

    return {
        "spot": round(spot, 2),
        "call_wall": {"strike": call_wall["strike"], "gex": call_wall["call_gex"], "distance": round(call_wall["strike"] - spot, 2)},
        "put_wall": {"strike": put_wall["strike"], "gex": put_wall["put_gex"], "distance": round(put_wall["strike"] - spot, 2)},
        "zero_gamma": round(zero_gamma, 2) if zero_gamma else None,
        "regime": regime,
        "regime_desc": regime_desc,
        "long_gamma_nodes": long_gamma_nodes,
        "short_gamma_nodes": short_gamma_nodes,
        "net_gex": round(total_positive + total_negative),
        "profile": profile,
    }


def find_nearest_long_gamma(
    levels: Dict[str, Any],
    spot: float,
    direction: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Find the nearest Long Gamma node to spot price.

    Args:
        levels: Output from compute_gex_levels_from_quotes
        spot: Current spot price
        direction: Optional filter — "CALL" returns only support floors,
                   "PUT" returns only resistance ceilings

    Returns:
        Nearest matching node or None
    """
    nodes = levels.get("long_gamma_nodes", [])
    if not nodes:
        return None

    if direction:
        nodes = [n for n in nodes if n["trade_direction"] == direction]

    if not nodes:
        return None

    return min(nodes, key=lambda n: abs(n["strike"] - spot))


def find_tp_target(
    levels: Dict[str, Any],
    entry_strike: float,
    direction: str,
) -> Optional[float]:
    """Find the nearest Short Gamma node as take-profit target.

    For PUTs: find the nearest short gamma node BELOW entry
    For CALLs: find the nearest short gamma node ABOVE entry

    Args:
        levels: Output from compute_gex_levels_from_quotes
        entry_strike: The Long Gamma node where we entered
        direction: "CALL" or "PUT"

    Returns:
        TP strike price or None
    """
    nodes = levels.get("short_gamma_nodes", [])
    zero_gamma = levels.get("zero_gamma")

    if direction == "PUT":
        # TP below entry — price will drop to short gamma
        candidates = [n for n in nodes if n["strike"] < entry_strike]
        if not candidates and zero_gamma and zero_gamma < entry_strike:
            return zero_gamma
        return max(candidates, key=lambda n: n["strike"])["strike"] if candidates else zero_gamma
    else:
        # TP above entry — price will rise to short gamma
        candidates = [n for n in nodes if n["strike"] > entry_strike]
        if not candidates and zero_gamma and zero_gamma > entry_strike:
            return zero_gamma
        return min(candidates, key=lambda n: n["strike"])["strike"] if candidates else zero_gamma


def is_approaching_node(
    bars_1m: List[Dict],
    node_strike: float,
    node_type: str,
    lookback: int = 5,
    min_velocity: float = 0.3,
) -> bool:
    """Check if price is approaching a Long Gamma node with momentum ("hot tape").

    Args:
        bars_1m: Recent 1-minute bars
        node_strike: The gamma node strike price
        node_type: "resistance" or "support"
        lookback: Number of bars to check momentum
        min_velocity: Minimum $ move in lookback period to qualify as "hot tape"

    Returns:
        True if price is approaching with sufficient momentum
    """
    if len(bars_1m) < lookback + 1:
        return False

    recent = bars_1m[-(lookback + 1):]
    current_price = recent[-1]["close"]
    lookback_price = recent[0]["close"]
    move = current_price - lookback_price

    # Check proximity — within $2 of the node
    distance = abs(current_price - node_strike)
    if distance > 2.0:
        return False

    if node_type == "resistance":
        # Price approaching from below with upward momentum
        return move > min_velocity and current_price < node_strike
    else:
        # Price approaching from above with downward momentum
        return move < -min_velocity and current_price > node_strike


def check_impulse_wick(
    bars_1m: List[Dict],
    node_strike: float,
    node_type: str,
) -> bool:
    """Check if the latest bar shows an impulse wick (liquidity tap) at the node.

    An impulse wick is when price briefly pierces the node level then reverses,
    showing rejection.

    Args:
        bars_1m: Recent 1-minute bars (need at least 2)
        node_strike: The gamma node strike
        node_type: "resistance" or "support"

    Returns:
        True if an impulse wick is detected
    """
    if len(bars_1m) < 2:
        return False

    bar = bars_1m[-1]
    prev = bars_1m[-2]

    if node_type == "resistance":
        # Wick above: high pierces node but close is below
        return bar["high"] >= node_strike and bar["close"] < node_strike and bar["close"] < bar["open"]
    else:
        # Wick below: low pierces node but close is above
        return bar["low"] <= node_strike and bar["close"] > node_strike and bar["close"] > bar["open"]
