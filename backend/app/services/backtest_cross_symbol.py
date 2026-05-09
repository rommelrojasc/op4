"""Cross-symbol backtest analysis service.

Runs range analysis across multiple symbols and collects signals_detail
with the symbol field attached for cross-company comparison.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine, Dict, List, Optional

from app.services.backtest_range import run_range_analysis

logger = logging.getLogger(__name__)


async def run_cross_symbol_analysis(
    symbols: List[str],
    start_date: str,
    end_date: str,
    lookback_days: int = 10,
    on_progress: Optional[Callable[[str], Coroutine]] = None,
    enabled_strategies: Optional[set] = None,
) -> Dict[str, Any]:
    """Run range analysis across multiple symbols and collect signal details.

    Args:
        symbols: List of stock symbols to analyze
        start_date: Start date YYYY-MM-DD
        end_date: End date YYYY-MM-DD
        lookback_days: Number of lookback days for indicator warmup
        on_progress: Optional async callback for progress updates

    Returns:
        Dict with symbols, date range, and flat list of all signal details
    """

    async def _progress(msg: str):
        if on_progress:
            await on_progress(msg)

    total = len(symbols)
    all_signals: List[Dict[str, Any]] = []

    for i, symbol in enumerate(symbols):
        await _progress(f"Analyzing {symbol} ({i + 1}/{total})...")
        logger.info(f"Cross-symbol analysis: processing {symbol} ({i + 1}/{total})")

        try:
            result = await run_range_analysis(
                symbol=symbol.upper(),
                start_date=start_date,
                end_date=end_date,
                lookback_days=lookback_days,
                on_progress=None,  # Don't forward per-day progress
                enabled_strategies=enabled_strategies,
            )

            # Extract signals_detail and attach symbol
            for sig in result.get("signals_detail", []):
                sig["symbol"] = symbol.upper()
                all_signals.append(sig)

            sig_count = len(result.get("signals_detail", []))
            logger.info(f"Cross-symbol: {symbol} produced {sig_count} signals")

        except Exception as e:
            logger.error(f"Cross-symbol: error analyzing {symbol}: {e}", exc_info=True)
            await _progress(f"Skipped {symbol} (error: {str(e)[:80]})")

    await _progress("Building cross-symbol report...")

    return {
        "symbols": [s.upper() for s in symbols],
        "start_date": start_date,
        "end_date": end_date,
        "total_signals": len(all_signals),
        "signals_detail": all_signals,
    }
