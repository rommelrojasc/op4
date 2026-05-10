"""Source dispatcher for GEX levels.

Single entry point that hides whether the data came from GexBot Classic or
from the IB-derived `compute_gex()`. Includes automatic fallback so a
transient outage on the primary source doesn't kill S14.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

GexSource = str  # "gexbot" | "ib"
VALID_SOURCES: tuple[str, ...] = ("gexbot", "ib")


async def get_gex_levels(
    symbol: str = "SPX",
    *,
    source: GexSource = "gexbot",
    fallback: bool = True,
    dte_filter: str = "0dte",
    strike_range: float = 100,
) -> Dict[str, Any]:
    """Return Classic-shaped GEX levels from the requested source.

    Args:
        symbol: Underlying ticker. Defaults to SPX (institutional gamma).
        source: "gexbot" (Classic, recommended) or "ib" (live option chain).
        fallback: If True, on primary failure try the other source. Logs the
            fallback so callers know what happened.
        dte_filter: Only used by the IB path. GexBot Classic always aggregates
            across all expirations.
        strike_range: Only used by the IB path. Dollar range around spot.

    Returns:
        Dict with `call_wall`, `put_wall`, `gamma_flip`, `regime`, `spot`,
        `gex_profile`, etc. Always includes a `source` field identifying the
        path that actually produced the data. On total failure (both sources
        errored) returns `{"error": "...", "source": "none"}`.
    """
    if source not in VALID_SOURCES:
        logger.warning("Unknown gex source %r, defaulting to 'gexbot'", source)
        source = "gexbot"

    primary_result = await _fetch(source, symbol, dte_filter=dte_filter, strike_range=strike_range)
    if not primary_result.get("error"):
        return primary_result

    if not fallback:
        return primary_result

    other = "ib" if source == "gexbot" else "gexbot"
    logger.info(
        "GEX source %r failed (%s). Falling back to %r.",
        source, primary_result.get("error"), other,
    )
    fallback_result = await _fetch(other, symbol, dte_filter=dte_filter, strike_range=strike_range)
    if not fallback_result.get("error"):
        # Mark the fallback so callers / UI can surface it.
        fallback_result["source_fallback_from"] = source
        return fallback_result

    # Both failed. Return whichever message is more useful (the primary's, since
    # that's what the caller asked for).
    return {
        "error": f"primary({source})={primary_result.get('error')}; fallback({other})={fallback_result.get('error')}",
        "source": "none",
    }


async def _fetch(
    source: GexSource,
    symbol: str,
    *,
    dte_filter: str,
    strike_range: float,
) -> Dict[str, Any]:
    if source == "gexbot":
        # GexBot client is sync (httpx-based, no async needed); run in executor
        # so we don't block the event loop on slow networks.
        from app.services.gex.gexbot_data import compute_gex_via_gexbot
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, compute_gex_via_gexbot, symbol)

    if source == "ib":
        from app.services.gex_analysis import compute_gex
        return await compute_gex(symbol=symbol, dte_filter=dte_filter, strike_range=strike_range)

    return {"error": f"unsupported source {source!r}", "source": "none"}
