"""Strategy 14 — Gamma Zero (SPX 0DTE).

Directional 0DTE based on the Call Wall / Put Wall / Gamma Flip from
gex_analysis.compute_gex(). Implements the 4-position state machine from
the cero_gamma_v4 spec:

    Position 1 — between walls          (regime-biased near-wall entries)
    Position 2 — above Call Wall        (CALL: gamma squeeze)
    Position 3 — below Put Wall         (PUT: free fall)
    Position 4 — reclaiming broken PW   (CALL exception, off by default)

Entry windows: 10:00–11:30 ET and 14:00–15:00 ET (dual).
Skip zone:     ±gammaZeroBufferPct around the gamma flip price.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.services.strategy_analysis import (
    Bar,
    StrategySignal,
    get_ny_parts,
)

logger = logging.getLogger(__name__)

STRATEGY_ID = "strategy14_gamma_zero"


@dataclass
class GammaZeroSignal:
    """Wraps StrategySignal with the GEX context that produced it."""
    signal: StrategySignal
    position: str            # "between_walls" | "above_call_wall" | "below_put_wall" | "reclaim_pw"
    regime: str              # "POSITIVE_GAMMA" | "NEGATIVE_GAMMA"
    call_wall: float
    put_wall: float
    gamma_flip: Optional[float]
    spot: float


def _within_dual_window(current_time: int) -> bool:
    """True when current_time falls in 10:00–11:30 ET or 14:00–15:00 ET."""
    parts = get_ny_parts(current_time)
    mins = parts["hour"] * 60 + parts["minute"]
    return (600 <= mins <= 690) or (840 <= mins <= 900)


def _at_gamma_zero(spot: float, flip: Optional[float], buffer_pct: float) -> bool:
    """Within ±buffer_pct of the gamma flip → no-go zone."""
    if flip is None or spot <= 0:
        return False
    return abs(spot - flip) / spot <= buffer_pct


def _avg_volume(bars: List[Bar], end_idx: int, lookback: int = 5) -> float:
    """Average volume of `lookback` bars ending at end_idx (exclusive)."""
    start = max(0, end_idx - lookback)
    window = bars[start:end_idx]
    if not window:
        return 0.0
    vols = [b.get("volume", 0) or 0 for b in window]
    return sum(vols) / len(vols) if vols else 0.0


def _is_bullish_reversal_5m(bar: Bar) -> bool:
    """Hammer / bullish engulfing approximation on a single 5m bar.

    True when the bar closes above its open AND the lower wick is at least
    as long as the body (rejection of lows).
    """
    o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
    body = abs(c - o)
    if body <= 0:
        return False
    lower_wick = min(o, c) - l
    return c > o and lower_wick >= body


def detect_strategy14_gamma_zero(
    symbol: str,
    bars1m: List[Bar],
    bars5m: List[Bar],
    current_price: float,
    gex_levels: Dict[str, Any],
    settings: Dict[str, Any],
) -> List[GammaZeroSignal]:
    """Generate Gamma Zero signals from the latest bar tick.

    Only emits signals at the most recent 1m bar — this matches how the
    auto-trader polls and avoids backfilled historical signals.

    Args:
        symbol: Underlying ticker (must be in allowedTickers; default ["SPX"])
        bars1m: Recent 1-minute bars (for entry timing + volume)
        bars5m: Recent 5-minute bars (for reversal candle detection)
        current_price: Spot price of the underlying
        gex_levels: Output of compute_gex() — must include call_wall, put_wall,
            gamma_flip, regime, spot
        settings: Strategy settings dict (read settings["strategy14"])

    Returns:
        List of GammaZeroSignal (usually 0 or 1 per call).
    """
    out: List[GammaZeroSignal] = []
    s14 = settings.get("strategy14", {})
    if not s14.get("enabled", False):
        return out

    allowed = [t.upper() for t in s14.get("allowedTickers", ["SPX"])]
    if symbol.upper() not in allowed:
        return out

    if not bars1m or current_price <= 0:
        return out

    # GEX level extraction — gex_analysis.compute_gex returns dicts with .strike
    cw = gex_levels.get("call_wall") or {}
    pw = gex_levels.get("put_wall") or {}
    gf = gex_levels.get("gamma_flip") or {}
    call_wall = cw.get("strike")
    put_wall = pw.get("strike")
    gamma_flip = gf.get("strike")
    regime = gex_levels.get("regime", "")

    if call_wall is None or put_wall is None:
        logger.debug("S14: missing call_wall or put_wall, skipping")
        return out

    # Use the live/current bar price (moves intraday) rather than the GEX
    # snapshot's spot (frozen at refresh/midpoint). Walls and flip from
    # gex_levels are intentionally static for the day.
    spot = current_price if current_price > 0 else gex_levels.get("spot", 0)
    if spot <= 0:
        return out

    # Time-window gate
    last_bar = bars1m[-1]
    current_time = last_bar["time"]
    if not _within_dual_window(current_time):
        return out

    # No-go: at gamma flip
    buffer_pct = float(s14.get("gammaZeroBufferPct", 0.0015))
    if _at_gamma_zero(spot, gamma_flip, buffer_pct):
        logger.debug(f"S14: spot {spot:.2f} within ±{buffer_pct*100:.2f}% of flip {gamma_flip}, skipping")
        return out

    proximity_pct = float(s14.get("wallProximityPct", 0.002))
    near_call_wall = abs(spot - call_wall) / spot <= proximity_pct
    near_put_wall = abs(spot - put_wall) / spot <= proximity_pct

    direction: Optional[str] = None
    position: str = ""

    # ── Position 3: spot below put_wall → free fall, PUT only ──────────
    if spot < put_wall:
        direction = "PUT"
        position = "below_put_wall"

    # ── Position 2: spot above call_wall → gamma squeeze, CALL ─────────
    elif spot > call_wall:
        direction = "CALL"
        position = "above_call_wall"

    # ── Position 1: between walls → regime-biased near-wall entry ──────
    else:
        if regime == "POSITIVE_GAMMA":
            # Sticky table: CALL near put wall (bounce), PUT near call wall (rejection)
            if near_put_wall:
                direction = "CALL"
                position = "between_walls"
            elif near_call_wall:
                direction = "PUT"
                position = "between_walls"
        elif regime == "NEGATIVE_GAMMA":
            # Bearish bias: only PUT near call wall, or CALL only with reclaim
            # conditions (handled via Position 4 below).
            if near_call_wall:
                direction = "PUT"
                position = "between_walls"

    # ── Position 4: reclaim of broken Put Wall (CALL exception) ────────
    # Only considered when spot is below put_wall AND we already chose PUT
    # above; we override to CALL if reclaim conditions are met. Off by default.
    if (
        s14.get("enableReclaimEntries", False)
        and spot < put_wall
        and bars5m
    ):
        last_5m = bars5m[-1]
        # Condition 2: bullish reversal candle on 5m
        bullish_candle = _is_bullish_reversal_5m(last_5m)
        # Condition 3: above-average volume on the bounce candle
        min_ratio = float(s14.get("minBounceVolumeRatio", 1.0))
        avg_vol = _avg_volume(bars5m, len(bars5m) - 1, lookback=5)
        bounce_vol_ok = (
            avg_vol > 0
            and (last_5m.get("volume", 0) or 0) >= avg_vol * min_ratio
        )
        # Condition 4: price pushing back above broken put wall
        reclaiming = last_5m["close"] >= put_wall * 0.999  # within 0.1% of reclaim

        if bullish_candle and bounce_vol_ok and reclaiming:
            direction = "CALL"
            position = "reclaim_pw"

    if direction is None:
        return out

    # Per-signal context for the trade modal / live activity log. Snapshots
    # everything that drove the entry decision at the moment of the signal.
    metadata = {
        "position": position,                    # which of the 4 positions fired
        "regime": regime,                        # POSITIVE_GAMMA / NEGATIVE_GAMMA
        "spot_at_signal": round(float(spot), 2),
        "call_wall": float(call_wall),
        "put_wall": float(put_wall),
        "gamma_flip": float(gamma_flip) if gamma_flip is not None else None,
        "dist_to_call_wall": round(float(spot) - float(call_wall), 2),
        "dist_to_put_wall": round(float(spot) - float(put_wall), 2),
        "dist_to_flip": round(float(spot) - float(gamma_flip), 2) if gamma_flip is not None else None,
        "wall_proximity_pct": float(s14.get("wallProximityPct", 0.0007)),
        "gamma_zero_buffer_pct": float(s14.get("gammaZeroBufferPct", 0.0003)),
    }
    sig = StrategySignal(
        id=f"{STRATEGY_ID}_{symbol}_{direction.lower()}_{current_time}",
        symbol=symbol,
        strategy_id=STRATEGY_ID,
        direction=direction,
        entry_time=current_time,
        anchor_time=current_time,
        metadata=metadata,
    )
    out.append(GammaZeroSignal(
        signal=sig,
        position=position,
        regime=regime,
        call_wall=float(call_wall),
        put_wall=float(put_wall),
        gamma_flip=float(gamma_flip) if gamma_flip is not None else None,
        spot=float(spot),
    ))
    return out


def adapt_backtest_gex_for_s14(backtest_gex: Dict[str, Any]) -> Dict[str, Any]:
    """Reshape compute_gex_for_backtest() output into the live compute_gex() shape.

    The backtest GEX builder (gex_levels.compute_gex_levels_from_quotes) emits:
      - regime: "BULLISH" | "BEARISH"
      - zero_gamma: float (bare)
    This detector (built against the live shape) expects:
      - regime: "POSITIVE_GAMMA" | "NEGATIVE_GAMMA"
      - gamma_flip: {"strike": float, "distance": float}

    call_wall and put_wall already match — pass them through unchanged.
    """
    if not backtest_gex:
        return backtest_gex
    spot = backtest_gex.get("spot")
    zero_gamma = backtest_gex.get("zero_gamma")
    gamma_flip = None
    if zero_gamma is not None:
        gamma_flip = {
            "strike": zero_gamma,
            "distance": round(zero_gamma - spot, 2) if spot is not None else None,
        }
    regime_in = backtest_gex.get("regime")
    regime_out = (
        "POSITIVE_GAMMA" if regime_in == "BULLISH"
        else "NEGATIVE_GAMMA" if regime_in == "BEARISH"
        else regime_in or ""
    )
    return {
        **backtest_gex,
        "gamma_flip": gamma_flip,
        "regime": regime_out,
    }


def scan_day_for_gamma_zero_signals(
    *,
    symbol: str,
    bars_1m: List[Bar],
    bars_5m: List[Bar],
    gex_levels: Dict[str, Any],
    settings: Dict[str, Any],
    scan_interval: int = 5,
) -> List[StrategySignal]:
    """Walk a day's 1m bars and collect Gamma Zero signals.

    Mirrors the pattern in strategy12_gex.scan_day_for_gex_signals — at each
    `scan_interval` step we feed the detector the bars-so-far so that signal
    timing simulates how the live auto-trader would have polled.

    Args:
        symbol: Trading symbol (typically SPY in backtests)
        bars_1m: Full day's 1m bars (must be sorted by time)
        bars_5m: Full day's 5m bars (used by reclaim path)
        gex_levels: GEX levels for the day. If still in backtest shape (regime
            "BULLISH"/"BEARISH"), pass through adapt_backtest_gex_for_s14() first.
        settings: Strategy settings dict (must contain "strategy14")
        scan_interval: Walk every N bars (default 5 minutes)

    Returns:
        Deduplicated list of StrategySignal objects.
    """
    if not bars_1m or not gex_levels or gex_levels.get("error"):
        return []

    cooldown_secs = int(settings.get("strategy14", {}).get("cooldownMinutes", 30)) * 60

    seen_ids: set = set()
    out: List[StrategySignal] = []
    # Per-direction last-fired timestamp so a CALL doesn't reset a PUT cooldown.
    last_signal_ts: Dict[str, int] = {"CALL": 0, "PUT": 0}

    for i in range(scan_interval, len(bars_1m), scan_interval):
        bars_so_far = bars_1m[: i + 1]
        last_t = bars_so_far[-1]["time"]
        # Trim 5m bars to the same point in time
        bars_5m_so_far = [b for b in bars_5m if b["time"] <= last_t]
        current_price = bars_so_far[-1]["close"]

        gz_signals = detect_strategy14_gamma_zero(
            symbol=symbol,
            bars1m=bars_so_far,
            bars5m=bars_5m_so_far,
            current_price=current_price,
            gex_levels=gex_levels,
            settings=settings,
        )
        for gz in gz_signals:
            sig = gz.signal
            # Cooldown: don't emit a same-direction signal within cooldown_secs
            # of the previous one in that direction.
            if cooldown_secs > 0 and sig.entry_time - last_signal_ts.get(sig.direction, 0) < cooldown_secs:
                continue
            if sig.id in seen_ids:
                continue
            seen_ids.add(sig.id)
            last_signal_ts[sig.direction] = sig.entry_time
            out.append(sig)

    return out
