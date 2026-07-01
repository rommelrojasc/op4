"""Default strategy settings and merge helper."""
from __future__ import annotations

from typing import Any, Dict


DEFAULT_STRATEGY_SETTINGS: Dict[str, Any] = {
    "global": {
        "warmup": 100,
        "minBars1h": 400,
        "minBars15m": 800,
        "minBars5m": 600,
        "minBars1d": 200,
        "minBars1m": 2000,
        "successThresholdPct": 0.005,
    },
    "strategy1": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "window15m": 4,
        "cooldownHours": 3,
        "trendLookback": 3,
        "minDTE": 1,
    },
    "strategy2": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "dailyTrendLookback": 3,
        "touchPct": 0.0015,
        "window1h": 2,
        "window15m": 4,
        "cooldownHours": 6,
        "minDTE": 1,
    },
    "strategy3": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "minGapPct": 0.004,
        "tightLookback": 100,
        "tightPercentile": 20,
        "bandOutsideTol": 0,
        "entryWindowMinutes": 5,
        "maxSignalsPerDay": 1,
        "minDTE": 1,
    },
    "strategy4": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "minDistPct": 0.012,
        "firstBarWindow": 2,
        "confirmWindow": 6,
        "cooldownHours": 6,
        "minDTE": 1,
    },
    "strategy5": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "minGapPct": 0.004,
        "tightLookback": 100,
        "tightPercentile": 20,
        "bandOutsideTol": 0.0005,
        "maxSignalsPerDay": 1,
        "flatLookback": 6,
        "flatEpsilon": 0.0005,
        "entryWindowMinutes": 5,
        "minDTE": 1,
    },
    "ct15": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "minGapPct": 0.002,
        "bwSlopeLookback": 3,
        "bwAvgRatio": 1.0,
        "maxSignalsPerDay": 1,
        "strictExposedMode": False,
        "minDTE": 1,
    },
    "ct_open": {
        "enabled": True,
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "requireSqueeze": True,
        "squeezeLookback": 100,
        "squeezePercentile": 15,
        "entryWindowMinutes": 15,
        "minBreakoutBars": 3,
        "minDisplacementPct": 0.10,
        "maxSignalsPerDay": 1,
        "minDTE": 1,
    },
    "strategy7": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": True,
        "allowedTickers": ["SPX", "SPY", "QQQ", "IWM"],
        "targetDTE": 0,
        "entryEndTime": "14:00",
        "timeExitAt": "15:30",
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.10,
        "stopLossPct": 0.50,
        "maxHoldMinutes": 5,
        "cooldownMinutes": 3,
        "useTrailingStop": True,
        "trailingStopPct": 0.05,
        "volumeSpikePct": 1.5,
        "maxSpreadDollar": 0.30,
        "minConsecutiveBars": 2,
    },
    "strategy8": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": True,
        "allowedTickers": ["SPX", "SPY", "QQQ", "IWM"],
        "targetDTE": 0,
        "entryEndTime": "14:00",
        "timeExitAt": "15:30",
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.20,
        "stopLossPct": 0.50,
        "useTrailingStop": True,
        "trailingStopPct": 0.10,
        "trailingActivationPct": 0.15,
        "cooldownMinutes": 10,
        "rsiOverbought": 65,
        "rsiOversold": 35,
        "rsiPeriod": 14,
        "volumeSpikeMult": 2.0,
    },
    "strategy9": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": True,
        "allowedTickers": ["SPX", "SPY", "QQQ", "IWM"],
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.20,
        "stopLossPct": 0.50,
        "entryStartTime": "10:00",
        "entryEndTime": "14:00",
        "timeExitAt": "15:30",
        "cooldownMinutes": 30,
        "minGapPct": 0.005,
    },
    "strategy10": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": True,
        "allowedTickers": ["SPX", "SPY", "QQQ", "IWM"],
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.30,
        "stopLossPct": 0.50,
        "useTrailingStop": True,
        "trailingStopPct": 0.15,
        "trailingActivationPct": 0.20,
        "entryStartTime": "09:45",
        "entryEndTime": "13:00",
        "timeExitAt": "15:30",
        "cooldownMinutes": 60,
        "minTrendBars": 3,
        "rsiTrendCallMin": 50,
        "rsiTrendCallMax": 70,
        "rsiTrendPutMin": 30,
        "rsiTrendPutMax": 50,
        "rsiPeriod": 14,
        "requireSmaBreakout": False,
        "smaFastPeriod": 20,
        "smaSlowPeriod": 200,
        "signalMaxAgeSecs": 180,
        "requireEntryPriceConfirmation": True,
        "requireVwapTrend": True,
        "vwapSlopeLookback": 5,
        "failedBreakoutBlockMinutes": 30,
        "minDelta": 0.35,
    },
    "strategy11": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": True,
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.40,
        "stopLossPct": 0.50,
        "useTrailingStop": True,
        "trailingStopPct": 0.10,
        "trailingActivationPct": 0.15,
        "entryStartTime": "09:30",
        "entryEndTime": "15:45",
        "timeExitAt": "15:30",
        "cooldownMinutes": 30,
        "swingLookback": 3,
        "minDisplacementPct": 0.0005,
        "avgBodyLookback": 20,
        "avgBodyMult": 1.0,
        "minRiskReward": 1.5,
        "sweepWindowBars": 36,
        "mssLookbackBars": 6,
        "useSRFilter": False,
        "srProximityPct": 0.002,
        "allowSREntry": False,
    },
    "strategy12": {
        "operatingStartTime": "09:45",
        "operatingEndTime": "15:00",
        "enabled": False,
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.20,
        "stopLossPct": 0.0,
        "useTrailingStop": True,
        "trailingStopPct": 0.05,
        "trailingActivationPct": 0.15,
        "entryStartTime": "09:45",
        "entryEndTime": "15:00",
        "timeExitAt": "15:00",
        "cooldownMinutes": 5,
        "allowedTickers": ["SPY"],
        # GEX-specific settings
        "gexRefreshMinutes": 5,
        "proximityThreshold": 2.0,  # $ distance to node for entry
        "minVelocity": 0.3,  # Min $ momentum to qualify
        "velocityLookback": 5,  # Bars
        "requireWick": False,  # Require impulse wick
        "stopDistance": 1.5,  # $ behind node for stop
        "lateCutoffTime": "15:00",  # No trades after this (theta crush)
    },
    "strategy13": {
        "operatingStartTime": "09:30",
        "operatingEndTime": "16:00",
        "enabled": False,
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.30,
        "stopLossPct": 0.50,
        "useTrailingStop": True,
        "trailingStopPct": 0.10,
        "trailingActivationPct": 0.30,
        "entryStartTime": "10:00",
        "entryEndTime": "11:30",
        "timeExitAt": "15:30",
        "cooldownMinutes": 60,
        "lateCutoffTime": "11:30",
        "allowedTickers": ["SPY"],
        # S13-specific: Opening Direction Confirmation
        "observationMinutes": 30,       # Minutes from open to watch
        "confirmationBars": 3,          # Consecutive 5m bars confirming direction
        "confirmationTimeframe": "5m",  # Bar size for confirmation
        "minRangeDollars": 1.50,        # Min observation range to qualify
        "maxRangeDollars": 5.00,        # Max range (move already done)
        "enableGapFade": True,          # Block gap-continuation trades
        "requireRetest": False,         # Wait for pullback to range boundary
    },
    "strategy14": {
        # Gamma Zero — SPX 0DTE directional based on Call Wall / Put Wall / Gamma Flip.
        # MVP: single TP at +50%, dual entry windows enforced inside the detector,
        # no VIX-based sizing.
        "operatingStartTime": "10:00",
        "operatingEndTime": "15:00",
        "enabled": False,
        "targetDTE": 0,
        "limitOrderTimeoutSecs": 60,
        "profitTargetPct": 0.50,        # Golden Rule 6: take profit at +50% (T1)
        "stopLossPct": 0.20,            # Golden Rule 7: exit at -20%
        "useTrailingStop": False,
        "trailingStopPct": 0.10,
        "trailingActivationPct": 0.50,
        # Two entry windows are enforced inside detect_strategy14_gamma_zero():
        # 10:00-11:30 and 14:00-15:00. The fields below are the *outer* bounds
        # that the auto-trader uses for its operatingStart/End check — keep them
        # wide enough to cover both windows.
        "entryStartTime": "10:00",
        "entryEndTime": "15:00",
        "timeExitAt": "15:00",          # Golden Rule 5: close before 3pm
        "cooldownMinutes": 30,
        "allowedTickers": ["SPY"],      # Trade SPY (GEX still derived from SPX 0DTE)
        # GEX data source. "gexbot" = Classic view (cumulative across all
        # expirations) per cero_gamma_v4 spec; "ib" = same-day IB option chain
        # via compute_gex(). Dispatcher auto-falls-back if the chosen source errors.
        "gexSource": "gexbot",
        # GEX-specific. NOTE: percent-of-spot thresholds — calibrated for SPY (~$700)
        # where 0DTE walls are typically $1–$3 apart. The cero_gamma_v4 spec uses 0.15%
        # / 0.2% which works on SPX ($7000+, walls $10–$30 apart) but blankets the
        # entire wall range on SPY. If you switch this strategy to SPX, multiply
        # gammaZeroBufferPct and wallProximityPct by 5–10×.
        "gexRefreshMinutes": 10,        # How often to refresh Call/Put Wall + Flip
        "gammaZeroBufferPct": 0.0003,   # ±0.03%: skip entries within ~$0.22 of flip on SPY
        "wallProximityPct": 0.0007,     # 0.07%: ~$0.52 on SPY — “near a wall” for Position 1
        "enableReclaimEntries": False,  # Position 4 (Put Wall reclaim) — off until backtested
        "minBounceVolumeRatio": 1.0,    # Bounce candle volume must beat avg of prior 5
    },
}


def merge_strategy_settings(
    overrides: Dict[str, Any] | None,
    strategy_settings_overrides: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    """Merge strategy settings with overrides from both sources.

    Args:
        overrides: Symbol-specific overrides from strategy_settings.json
        strategy_settings_overrides: Global strategy overrides from auto_trader_settings.json
    """
    if not overrides and not strategy_settings_overrides:
        return DEFAULT_STRATEGY_SETTINGS

    # Helper to merge a single strategy, coercing types to match defaults
    def merge_strat(key: str) -> Dict[str, Any]:
        defaults = DEFAULT_STRATEGY_SETTINGS.get(key, {})
        result = defaults.copy()
        # Apply overrides in order, coercing each value to match the default's type
        for source in (overrides, strategy_settings_overrides):
            if not source:
                continue
            for k, v in source.get(key, {}).items():
                default_val = defaults.get(k)
                if default_val is not None and not isinstance(v, type(default_val)):
                    # Coerce to match default type; fall back to default on failure
                    try:
                        if isinstance(default_val, bool):
                            v = bool(v)
                        elif isinstance(default_val, int):
                            v = int(float(v)) if v != "" else default_val
                        elif isinstance(default_val, float):
                            v = float(v) if v != "" else default_val
                    except (ValueError, TypeError):
                        v = default_val
                elif v == "" and isinstance(default_val, (int, float)):
                    v = default_val
                result[k] = v
        return result

    merged: Dict[str, Any] = {
        "global": merge_strat("global"),
        "strategy1": merge_strat("strategy1"),
        "strategy2": merge_strat("strategy2"),
        "strategy3": merge_strat("strategy3"),
        "strategy4": merge_strat("strategy4"),
        "strategy5": merge_strat("strategy5"),
        "ct15": merge_strat("ct15"),
        "ct_open": merge_strat("ct_open"),
        "strategy7": merge_strat("strategy7"),
        "strategy8": merge_strat("strategy8"),
        "strategy9": merge_strat("strategy9"),
        "strategy10": merge_strat("strategy10"),
        "strategy11": merge_strat("strategy11"),
        "strategy12": merge_strat("strategy12"),
        "strategy13": merge_strat("strategy13"),
        "strategy14": merge_strat("strategy14"),
    }
    return merged
