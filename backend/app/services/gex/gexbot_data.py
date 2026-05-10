"""GexBot Classic GEX wrapper.

Reads GexBot's `/{TICKER}/classic/zero` endpoint and reshapes the response into
the same dict shape `gex_analysis.compute_gex()` returns, so downstream code
(S14 detector, chart overlay, backtester) doesn't care which source produced
the levels.

Auth: `x-api-key` header. Key is read from the GEXBOT_API_KEY env var.
Endpoint reference: https://www.gexbot.com/apidocs
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")

GEXBOT_BASE_URL = "https://api.gexbot.com"
DEFAULT_TIMEOUT_SECS = 12.0


class GexBotError(Exception):
    """Raised on any GexBot API problem (network, auth, parse, empty data)."""


def _api_key() -> str:
    key = os.environ.get("GEXBOT_API_KEY", "").strip()
    if not key:
        raise GexBotError("GEXBOT_API_KEY env var is not set")
    return key


def _fetch_classic_zero(ticker: str, timeout_secs: float = DEFAULT_TIMEOUT_SECS) -> list[dict]:
    """Hit /{TICKER}/classic/zero. Returns the raw snapshot array."""
    url = f"{GEXBOT_BASE_URL}/{ticker.upper()}/classic/zero"
    # GexBot uses bearer-token auth (the docs SPA's `x-api-key` reference in
    # its JS bundle is misleading — actual API requires `Authorization: Bearer`).
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
        if e.code == 404:
            raise GexBotError(f"ticker '{ticker}' not found on GexBot (404)") from e
        raise GexBotError(f"unexpected status {e.code}") from e
    except urllib_error.URLError as e:
        raise GexBotError(f"network error: {e.reason}") from e

    try:
        data = json.loads(body)
    except ValueError as e:
        raise GexBotError(f"invalid JSON: {e}") from e

    # Live API returns a single snapshot dict; the example data files in their
    # docs return an array of snapshots. Normalize to a list either way.
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise GexBotError("empty or malformed response")
    return data


def _to_levels_dict(snapshot: dict, ticker: str) -> Dict[str, Any]:
    """Map a single GexBot snapshot to compute_gex()'s dict shape.

    GexBot snapshot fields used:
      - spot:           current underlying price
      - major_pos_oi:   strike with the highest +GEX (Call Wall)
      - major_neg_oi:   strike with the most -GEX (Put Wall)
      - zero_gamma:     gamma flip price (0 means not yet computed by GexBot)
      - timestamp:      unix seconds
      - strikes:        per-strike profile [[strike, gex_vol, gex_oi, ...], ...]
    """
    spot = snapshot.get("spot")
    cw_strike = snapshot.get("major_pos_oi")
    pw_strike = snapshot.get("major_neg_oi")
    flip_strike = snapshot.get("zero_gamma")
    ts = snapshot.get("timestamp")

    # GexBot uses 0 for "no flip computed yet" — treat as missing.
    flip = flip_strike if flip_strike not in (None, 0) else None

    # Derive regime by comparing spot to flip (matches compute_gex's convention).
    if spot is not None and flip is not None:
        regime = "POSITIVE_GAMMA" if spot > flip else "NEGATIVE_GAMMA"
        regime_desc = (
            "Above gamma flip — dealers long gamma — moves dampened"
            if regime == "POSITIVE_GAMMA"
            else "Below gamma flip — dealers short gamma — moves amplified"
        )
    else:
        regime = "POSITIVE_GAMMA" if (snapshot.get("sum_gex_oi") or 0) > 0 else "NEGATIVE_GAMMA"
        regime_desc = "Net positive gamma" if regime == "POSITIVE_GAMMA" else "Net negative gamma"

    # Reshape strikes to a list of dicts so consumers (e.g. the backtester chart)
    # can iterate symbolically. GexBot row layout: [strike, gex_vol, gex_oi, [priors]]
    gex_profile = []
    for row in snapshot.get("strikes", []):
        if not isinstance(row, list) or len(row) < 3:
            continue
        strike, gex_vol, gex_oi = row[0], row[1], row[2]
        gex_profile.append({
            "strike": strike,
            "call_gex": max(0, gex_oi),  # approximation — GexBot returns net only
            "put_gex": min(0, gex_oi),
            "net_gex": gex_oi,
            "call_oi": 0,
            "put_oi": 0,
            "call_vol": gex_vol if gex_vol > 0 else 0,
            "put_vol": -gex_vol if gex_vol < 0 else 0,
        })

    out: Dict[str, Any] = {
        "source": "gexbot_classic",
        "symbol": ticker.upper(),
        "spot": round(spot, 2) if spot is not None else None,
        "timestamp": (
            datetime.fromtimestamp(ts, NY).strftime("%Y-%m-%d %H:%M:%S ET")
            if ts else None
        ),
        "dte_filter": "classic",
        "expirations_used": ["classic-aggregate"],
        "strikes_analyzed": len(gex_profile),
        "gex_profile": gex_profile,
        "call_wall": {
            "strike": cw_strike,
            "gex": 0,
            "distance": round(cw_strike - spot, 2) if (cw_strike and spot) else None,
        } if cw_strike is not None else None,
        "put_wall": {
            "strike": pw_strike,
            "gex": 0,
            "distance": round(pw_strike - spot, 2) if (pw_strike and spot) else None,
        } if pw_strike is not None else None,
        "gamma_flip": {
            "strike": round(flip, 2) if flip else None,
            "distance": round(flip - spot, 2) if (flip and spot) else None,
        },
        "regime": regime,
        "regime_desc": regime_desc,
        "net_gex": snapshot.get("sum_gex_oi", 0),
        "total_positive_gex": 0,  # GexBot doesn't split call/put
        "total_negative_gex": 0,
        # GexBot doesn't expose distinct LGN/SGN node lists; leave empty so the
        # frontend chart can fall back to call_wall / put_wall / gamma_flip only.
        "long_gamma_nodes": [],
        "short_gamma_nodes": [],
    }
    return out


def compute_gex_via_gexbot(symbol: str = "SPX") -> Dict[str, Any]:
    """Fetch Classic GEX from GexBot, reshape to compute_gex() format.

    Always queries SPX on the GexBot side (institutional gamma signal). Caller
    is responsible for any SPX→SPY scaling needed for downstream consumers.

    Args:
        symbol: GexBot ticker. Defaults to "SPX". Pass other tickers (SPY, QQQ,
            IWM, NDX, etc.) to query their respective Classic GEX.

    Returns:
        Dict matching the shape of `gex_analysis.compute_gex()`. On failure
        returns `{"error": "<reason>", "source": "gexbot_classic"}`.
    """
    try:
        snapshots = _fetch_classic_zero(symbol)
    except GexBotError as e:
        logger.warning("GexBot fetch failed for %s: %s", symbol, e)
        return {"error": str(e), "source": "gexbot_classic"}

    # The endpoint returns an array of snapshots — newest last by timestamp.
    latest = max(snapshots, key=lambda s: s.get("timestamp") or 0)
    return _to_levels_dict(latest, symbol)
