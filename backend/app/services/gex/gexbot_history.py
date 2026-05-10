"""GexBot historical GEX wrapper for backtests.

Hits `/v2/hist/{TICKER}/{view}/{aggregation}/{YYYY-MM-DD}` and reshapes the
response into the existing `compute_gex()` dict shape, so the backtester can
swap its current Polygon + Black-Scholes approximation for actual historical
walls + flip without changing downstream logic.

Tier note: this endpoint requires a higher GexBot tier than `/SPX/classic/zero`.
On 403 the wrapper returns a structured error so callers can fall back to the
existing approximation path.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.services.gex.gexbot_data import (
    DEFAULT_TIMEOUT_SECS,
    GEXBOT_BASE_URL,
    GexBotError,
    _api_key,
    _to_levels_dict,
)

logger = logging.getLogger(__name__)


def _fetch_history(
    ticker: str,
    day_str: str,
    *,
    view: str = "classic",       # "classic" or "state"
    aggregation: str = "gex_zero",  # "gex_zero" or "gex_full"
    timeout_secs: float = DEFAULT_TIMEOUT_SECS,
) -> list[dict]:
    """Hit /v2/hist/{TICKER}/{view}/{aggregation}/{YYYY-MM-DD}.

    Returns the snapshot list for the requested day. Raises GexBotError on
    network / auth / tier / parse problems.
    """
    url = f"{GEXBOT_BASE_URL}/v2/hist/{ticker.upper()}/{view}/{aggregation}/{day_str}?noredirect"
    req = urllib_request.Request(url, headers={
        "Authorization": f"Bearer {_api_key()}",
        "accept": "application/json",
        "user-agent": "op3-trading/1.0",
    })
    try:
        with urllib_request.urlopen(req, timeout=timeout_secs) as r:
            body = r.read()
    except urllib_error.HTTPError as e:
        if e.code == 401:
            raise GexBotError("auth failed (401) — check GEXBOT_API_KEY") from e
        if e.code == 403:
            raise GexBotError("403 — historical data requires a higher GexBot tier") from e
        if e.code == 404:
            raise GexBotError(f"no historical data for {ticker} on {day_str}") from e
        raise GexBotError(f"unexpected status {e.code}") from e
    except urllib_error.URLError as e:
        raise GexBotError(f"network error: {e.reason}") from e

    try:
        data = json.loads(body)
    except ValueError as e:
        raise GexBotError(f"invalid JSON: {e}") from e

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise GexBotError("empty or malformed response")
    return data


def fetch_historical_gex_at(
    symbol: str,
    day_str: str,
    *,
    view: str = "classic",
) -> Dict[str, Any]:
    """Return the LAST snapshot of historical GEX for `symbol` on `day_str`.

    Most callers (e.g. the backtester) want the closing-time levels for the
    day so they can use the same walls/flip the live trader would have seen
    for entries on that day.

    Args:
        symbol: GexBot ticker. SPX recommended.
        day_str: ISO date "YYYY-MM-DD".
        view: "classic" (cumulative across expirations — spec default) or
            "state" (0DTE intraday).

    Returns:
        Dict in the `compute_gex()` shape. On failure returns
        `{"error": "...", "source": "gexbot_classic_history"}`.
    """
    try:
        snapshots = _fetch_history(symbol, day_str, view=view, aggregation="gex_zero")
    except GexBotError as e:
        logger.info("GexBot history miss for %s/%s: %s", symbol, day_str, e)
        return {"error": str(e), "source": f"gexbot_{view}_history"}

    # Use the latest snapshot of the day (closest to close).
    latest = max(snapshots, key=lambda s: s.get("timestamp") or 0)
    out = _to_levels_dict(latest, symbol)
    out["source"] = f"gexbot_{view}_history"
    return out
