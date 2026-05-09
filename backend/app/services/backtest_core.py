"""Shared trade simulation logic used by both backtester and optimizer.

This ensures identical results regardless of which entry point is used.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from app.services.auto_trader import _compute_adx, _safe_float, _strategy_settings_key
from app.services.options_backtester import _select_strike, _simulate_trade
from app.services.strategy_defaults import DEFAULT_STRATEGY_SETTINGS

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


def simulate_day_trades(
    *,
    symbol: str,
    day_str: str,
    unique_signals: list,
    day_bars: List[Dict],
    near_strikes: List[float],
    option_bars_cache: Dict[str, List[Dict]],
    at_settings: Dict[str, Any],
    strategy_overrides: Dict[str, Any],
    chop_enabled: bool = True,
    chop_adx_threshold: float = 20,
    chop_di_gap: float = 10,
    chop_tf: str = "5m",
    bars_5m: Optional[List[Dict]] = None,
    bars_15m: Optional[List[Dict]] = None,
) -> Tuple[List[Dict], int]:
    """Simulate all trades for a single day using backtester logic.

    This is the single source of truth for trade simulation — both
    the backtester and optimizer call this function.

    Returns (day_trades, used_capital).
    """
    capital_limit = _safe_float(at_settings.get("capitalLimit"), 0)
    premium_min = _safe_float(at_settings.get("premiumMin"), 0)
    premium_max = _safe_float(at_settings.get("premiumMax"), 0)

    day_trades = []
    skipped_trades = []  # Trades that would have happened without capital limits
    used_capital = 0
    traded_signal_ids = set()

    logger.info(f"simulate_day_trades: {day_str} | {len(unique_signals)} signals | chop={chop_enabled} adx_t={chop_adx_threshold} di_t={chop_di_gap} tf={chop_tf} | bars_5m={len(bars_5m or [])} | capital={capital_limit} | premium={premium_min}-{premium_max}")

    # Apply chop filter to signals
    # S13 (Opening Direction) bypasses chop — it has its own confirmation logic
    CHOP_EXEMPT_STRATEGIES = {"strategy13_opening_direction"}
    filtered_signals = []
    for sig in unique_signals:
        if chop_enabled and sig.strategy_id not in CHOP_EXEMPT_STRATEGIES:
            chop_bars = {
                "1m": day_bars,
                "5m": bars_5m or [],
                "15m": bars_15m or [],
            }.get(chop_tf, bars_5m or [])
            closed = [b for b in chop_bars if b["time"] < sig.entry_time]
            adx, plus_di, minus_di = _compute_adx(closed)
            if adx is not None:
                if chop_adx_threshold > 0 and adx < chop_adx_threshold:
                    continue
                di_gap = abs(plus_di - minus_di)
                if chop_di_gap > 0 and di_gap < chop_di_gap:
                    continue
        filtered_signals.append(sig)

    logger.info(f"  chop filter: {len(unique_signals)} -> {len(filtered_signals)} signals")

    for sig in filtered_signals:
        if sig.id in traded_signal_ids:
            continue

        # Track if this trade is capital-blocked
        _capital_blocked = capital_limit > 0 and used_capital >= capital_limit

        # Find spot at signal time
        spot_bar = min(day_bars, key=lambda b: abs(b["time"] - sig.entry_time))
        spot_at_signal = spot_bar["close"]

        # Select strike
        result = _select_strike(
            spot=spot_at_signal,
            direction=sig.direction,
            available_strikes=near_strikes,
            option_bars_cache=option_bars_cache,
            expiration=day_str,
            symbol=symbol,
            entry_ts=sig.entry_time,
            settings=at_settings,
            premium_min=premium_min,
            premium_max=premium_max,
        )

        if not result:
            continue

        strike, opt_ticker, entry_premium, opt_bars = result

        # Position sizing
        contract_premium = entry_premium * 100
        position_sizing = at_settings.get("positionSizing", "fixed")
        risk_per_trade = _safe_float(at_settings.get("riskPerTrade"), 200)
        risk_pct = _safe_float(at_settings.get("riskPctPerTrade"), 2.0)
        max_contracts = int(at_settings.get("maxContractsPerTrade", 3))
        min_contracts = int(at_settings.get("minContractsPerTrade", 1))

        if position_sizing == "fixed":
            quantity = max(1, int(risk_per_trade / contract_premium)) if contract_premium > 0 else 1
        elif position_sizing == "percentage":
            remaining = (capital_limit - used_capital) if capital_limit > 0 else risk_per_trade
            quantity = int((remaining * risk_pct / 100.0) / contract_premium) if contract_premium > 0 else 1
        else:  # hybrid
            remaining = (capital_limit - used_capital) if capital_limit > 0 else risk_per_trade
            from_capital = int((remaining * risk_pct / 100.0) / contract_premium) if contract_premium > 0 else 1
            quantity = min(from_capital, max_contracts)

        quantity = max(min_contracts, min(quantity, max_contracts))

        # Capital limit cap
        if not _capital_blocked and capital_limit > 0 and contract_premium > 0:
            limit_remaining = capital_limit - used_capital
            max_from_limit = int(limit_remaining / contract_premium)
            if max_from_limit < min_contracts:
                _capital_blocked = True
            else:
                quantity = min(quantity, max_from_limit)

        contract_cost = contract_premium * quantity

        # Build strategy settings — global overrides strategy defaults
        strat_key = _strategy_settings_key(sig.strategy_id)
        strat_settings = {**DEFAULT_STRATEGY_SETTINGS.get(strat_key, {}), **strategy_overrides.get(strat_key, {})}
        strat_settings["profitTargetPct"] = _safe_float(at_settings.get("profitTargetPct"), strat_settings.get("profitTargetPct", 0.25))
        strat_settings["trailingStopPct"] = _safe_float(at_settings.get("trailingStopPct"), strat_settings.get("trailingStopPct", 0.07))
        strat_settings["useTrailingStop"] = at_settings.get("useTrailingStop", strat_settings.get("useTrailingStop", True))
        if at_settings.get("stopLossPct") is not None:
            strat_settings["stopLossPct"] = at_settings.get("stopLossPct")
        if strategy_overrides.get(strat_key, {}).get("timeExitAt") is not None:
            strat_settings["timeExitAt"] = strategy_overrides[strat_key]["timeExitAt"]

        # Simulate
        trade_result = _simulate_trade(
            entry_premium=entry_premium,
            bars=opt_bars,
            entry_ts=sig.entry_time,
            settings=at_settings,
            strat_settings=strat_settings,
        )

        pnl = (trade_result["exit_premium"] - entry_premium) * 100 * quantity
        pnl_pct = (trade_result["exit_premium"] - entry_premium) / entry_premium if entry_premium > 0 else 0
        mfe_pct = (trade_result["mfe_premium"] - entry_premium) / entry_premium if entry_premium > 0 else 0
        mae_pct = (trade_result["mae_premium"] - entry_premium) / entry_premium if entry_premium > 0 else 0

        entry_dt = datetime.fromtimestamp(sig.entry_time, NY)
        exit_dt = datetime.fromtimestamp(trade_result["exit_ts"], NY)

        trade = {
            "date": day_str,
            "symbol": symbol,
            "strategy_id": sig.strategy_id,
            "signal_id": sig.id,
            "direction": sig.direction,
            "right": "C" if sig.direction == "CALL" else "P",
            "strike": strike,
            "expiration": day_str,
            "entry_time": entry_dt.strftime("%H:%M"),
            "entry_ts": sig.entry_time,
            "entry_premium": round(entry_premium, 2),
            "exit_time": exit_dt.strftime("%H:%M"),
            "exit_ts": trade_result["exit_ts"],
            "exit_premium": round(trade_result["exit_premium"], 2),
            "exit_reason": trade_result["exit_reason"],
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct * 100, 1),
            "mfe_pct": round(mfe_pct * 100, 1),
            "mae_pct": round(mae_pct * 100, 1),
            "hwm": round(trade_result["hwm"], 2),
            "trail_pct_used": round(trade_result.get("trail_pct_used", 0) * 100, 1),
            "bars_held": trade_result["bars_held"],
            "hold_minutes": trade_result["bars_held"],
            "quantity": quantity,
            "capital_used": round(contract_cost, 2),
            "spot_at_entry": round(spot_at_signal, 2),
            "option_ticker": opt_ticker,
            "skipped": _capital_blocked,
            # Carry the per-signal context (e.g. S14's position/walls/regime) so
            # downstream renderers can show the actual reasoning behind this trade.
            "signal_metadata": getattr(sig, "metadata", None),
        }

        if _capital_blocked:
            skipped_trades.append(trade)
        else:
            day_trades.append(trade)
            used_capital += contract_cost
        traded_signal_ids.add(sig.id)

    return day_trades, used_capital, skipped_trades
