"""Gamma Exposure (GEX) analysis for SPX/SPY options.

Computes GEX per strike, call/put walls, gamma flip point, and regime.
Uses SPX 0DTE options for signal generation (institutional gamma) with
SPY as the execution vehicle.
"""
import asyncio
import logging
import math
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.ib.options_data import get_option_chain, get_option_quotes
from app.services.ib.market_data import get_historical_bars

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


async def compute_gex(
    symbol: str = "SPX",
    dte_filter: str = "0dte",
    strike_range: float = 100,
) -> Dict[str, Any]:
    """Compute full GEX analysis.

    Args:
        symbol: Underlying for option chain (SPX for institutional gamma)
        dte_filter: "0dte", "weekly", or "all"
        strike_range: Dollar range around spot to analyze

    Returns:
        Dict with gex_profile, call_wall, put_wall, gamma_flip, regime, etc.
    """
    now = datetime.now(NY)
    today_str = now.strftime("%Y-%m-%d")

    # Get spot price (use SPY bars as proxy for SPX if needed)
    try:
        spy_bars = await get_historical_bars("SPY", "1m", 5, use_rth=True)
        spy_price = spy_bars[-1]["close"] if spy_bars else None
    except Exception:
        spy_price = None

    if symbol == "SPX":
        spot = spy_price * 10 if spy_price else None  # SPX ≈ SPY × 10
    else:
        spot = spy_price

    if not spot:
        return {"error": "Could not determine spot price"}

    # Get option chain
    try:
        chain = await get_option_chain(symbol)
    except Exception as e:
        return {"error": f"Failed to fetch option chain: {e}"}

    if not chain:
        return {"error": "No option chain returned"}

    # Select expirations based on DTE filter
    target_expirations = []
    for entry in chain:
        exp_date = entry["date"]
        try:
            exp_dt = datetime.strptime(exp_date, "%Y-%m-%d")
            dte = (exp_dt.date() - now.date()).days
        except ValueError:
            continue

        if dte_filter == "0dte" and dte == 0:
            target_expirations.append(entry)
        elif dte_filter == "weekly" and dte <= 7:
            target_expirations.append(entry)
        elif dte_filter == "all":
            target_expirations.append(entry)

    # If no 0DTE found, try next trading day
    if not target_expirations and dte_filter == "0dte":
        for entry in chain:
            try:
                exp_dt = datetime.strptime(entry["date"], "%Y-%m-%d")
                dte = (exp_dt.date() - now.date()).days
                if dte >= 0:
                    target_expirations.append(entry)
                    break
            except ValueError:
                continue

    if not target_expirations:
        return {"error": f"No expirations found for filter '{dte_filter}'"}

    # Collect strikes near the money
    all_quotes = []
    for exp_entry in target_expirations:
        exp_date = exp_entry["date"]
        near_strikes = [s for s in exp_entry["strikes"] if abs(s - spot) <= strike_range]

        if not near_strikes:
            continue

        try:
            quotes = await get_option_quotes(symbol, exp_date, near_strikes)
            for q in quotes:
                q["expiration"] = exp_date
            all_quotes.extend(quotes)
        except Exception as e:
            logger.warning(f"Failed to fetch quotes for {exp_date}: {e}")
            continue

    if not all_quotes:
        return {
            "error": "No option quotes available (market may be closed)",
            "spot": round(spot, 2),
            "spy_price": round(spy_price, 2) if spy_price else None,
        }

    # Diagnostic: count what data we have
    _has_gamma = sum(1 for q in all_quotes if q.get("gamma") and q["gamma"] > 0)
    _has_oi = sum(1 for q in all_quotes if q.get("oi") and q["oi"] > 0)
    _has_vol = sum(1 for q in all_quotes if q.get("volume") and q["volume"] > 0)
    logger.info(f"GEX quotes: {len(all_quotes)} total, {_has_gamma} with gamma, {_has_oi} with OI, {_has_vol} with volume")

    # Compute GEX per strike
    # GEX = gamma × OI × 100 × spot²
    # Calls: positive contribution (dealers long calls = long gamma)
    # Puts: negative contribution (dealers short puts = short gamma)
    gex_by_strike = defaultdict(lambda: {"call_gex": 0, "put_gex": 0, "net_gex": 0,
                                          "call_oi": 0, "put_oi": 0, "call_vol": 0, "put_vol": 0,
                                          "call_gamma": 0, "put_gamma": 0})

    for q in all_quotes:
        strike = q["strike"]
        gamma = q.get("gamma") or 0
        oi = q.get("oi") or 0
        volume = q.get("volume") or 0
        right = q.get("right", "")

        if gamma <= 0:
            continue
        # Use OI if available, otherwise fall back to volume (common for 0DTE)
        position_size = oi if oi > 0 else volume
        if position_size <= 0:
            continue

        gex = gamma * position_size * 100 * spot * spot * 0.01  # Per 1% move

        entry = gex_by_strike[strike]
        if right == "C":
            entry["call_gex"] += gex
            entry["call_oi"] += oi if oi > 0 else volume
            entry["call_vol"] += volume
            entry["call_gamma"] += gamma * position_size
        elif right == "P":
            entry["put_gex"] -= gex  # Puts contribute negative GEX
            entry["put_oi"] += oi if oi > 0 else volume
            entry["put_vol"] += volume
            entry["put_gamma"] += gamma * position_size

        entry["net_gex"] = entry["call_gex"] + entry["put_gex"]

    if not gex_by_strike:
        return {
            "error": f"No GEX data — {len(all_quotes)} quotes but {_has_gamma} have gamma, {_has_oi} have OI, {_has_vol} have volume. Greeks may need streaming subscription.",
            "spot": round(spot, 2),
        }

    # Build sorted GEX profile
    gex_profile = []
    for strike in sorted(gex_by_strike.keys()):
        entry = gex_by_strike[strike]
        gex_profile.append({
            "strike": strike,
            "call_gex": round(entry["call_gex"]),
            "put_gex": round(entry["put_gex"]),
            "net_gex": round(entry["net_gex"]),
            "call_oi": entry["call_oi"],
            "put_oi": entry["put_oi"],
            "call_vol": entry["call_vol"],
            "put_vol": entry["put_vol"],
        })

    # Find Call Wall (strike with highest positive call GEX)
    call_wall = max(gex_profile, key=lambda x: x["call_gex"])
    call_wall_strike = call_wall["strike"]

    # Find Put Wall (strike with most negative put GEX)
    put_wall = min(gex_profile, key=lambda x: x["put_gex"])
    put_wall_strike = put_wall["strike"]

    # Find Gamma Flip (where net GEX crosses zero)
    gamma_flip = None
    for i in range(1, len(gex_profile)):
        prev = gex_profile[i - 1]
        curr = gex_profile[i]
        if prev["net_gex"] * curr["net_gex"] < 0:
            # Linear interpolation
            total = abs(prev["net_gex"]) + abs(curr["net_gex"])
            if total > 0:
                gamma_flip = prev["strike"] + (curr["strike"] - prev["strike"]) * abs(prev["net_gex"]) / total
            break

    # Determine regime
    if gamma_flip is not None:
        if spot > gamma_flip:
            regime = "POSITIVE_GAMMA"
            regime_desc = "Above gamma flip — dealers long gamma — moves dampened"
        else:
            regime = "NEGATIVE_GAMMA"
            regime_desc = "Below gamma flip — dealers short gamma — moves amplified"
    else:
        total_net = sum(g["net_gex"] for g in gex_profile)
        regime = "POSITIVE_GAMMA" if total_net > 0 else "NEGATIVE_GAMMA"
        regime_desc = "Net positive gamma" if total_net > 0 else "Net negative gamma"

    # Long gamma nodes (major support/resistance pivots)
    # These are strikes with unusually high absolute GEX
    avg_abs_gex = sum(abs(g["net_gex"]) for g in gex_profile) / len(gex_profile) if gex_profile else 0
    long_gamma_nodes = [g for g in gex_profile if abs(g["net_gex"]) > avg_abs_gex * 2]

    # Short gamma nodes (high volume/liquidity areas where price gets stuck)
    short_gamma_nodes = [g for g in gex_profile if abs(g["net_gex"]) < avg_abs_gex * 0.3 and (g["call_oi"] + g["put_oi"]) > 0]

    # Total GEX
    total_positive = sum(g["call_gex"] for g in gex_profile)
    total_negative = sum(g["put_gex"] for g in gex_profile)
    net_gex = total_positive + total_negative

    return {
        "symbol": symbol,
        "spot": round(spot, 2),
        "spy_price": round(spy_price, 2) if spy_price else None,
        "timestamp": now.strftime("%Y-%m-%d %H:%M:%S ET"),
        "dte_filter": dte_filter,
        "expirations_used": [e["date"] for e in target_expirations],
        "strikes_analyzed": len(gex_profile),
        "gex_profile": gex_profile,
        "call_wall": {
            "strike": call_wall_strike,
            "gex": round(call_wall["call_gex"]),
            "distance": round(call_wall_strike - spot, 2),
        },
        "put_wall": {
            "strike": put_wall_strike,
            "gex": round(put_wall["put_gex"]),
            "distance": round(put_wall_strike - spot, 2),
        },
        "gamma_flip": {
            "strike": round(gamma_flip, 2) if gamma_flip else None,
            "distance": round(gamma_flip - spot, 2) if gamma_flip else None,
        },
        "regime": regime,
        "regime_desc": regime_desc,
        "net_gex": round(net_gex),
        "total_positive_gex": round(total_positive),
        "total_negative_gex": round(total_negative),
        "long_gamma_nodes": [{"strike": g["strike"], "net_gex": g["net_gex"]} for g in long_gamma_nodes],
        "short_gamma_nodes": [{"strike": g["strike"], "net_gex": g["net_gex"]} for g in short_gamma_nodes],
        "spy_bars_5m": await _get_spy_bars(),
    }


async def _get_spy_bars():
    """Fetch today's SPY 5m bars for the price overlay chart."""
    try:
        bars = await get_historical_bars("SPY", "5m", 80, use_rth=True)
        return [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]} for b in bars] if bars else []
    except Exception:
        return []
