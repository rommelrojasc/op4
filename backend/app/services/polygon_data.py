"""Polygon.io integration for historical options data."""
import logging
import os
import time
from datetime import datetime, date
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from polygon import RESTClient

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")

# Rate limiter + retry for Polygon API (starter plan: 5 req/min)
_last_call_ts: float = 0.0
_RATE_LIMIT_SECS = 1.0  # 1 req/sec to stay well within limits
_MAX_RETRIES = 3
_RETRY_BACKOFF = 15  # seconds to wait on 429


def _rate_limit():
    global _last_call_ts
    now = time.time()
    elapsed = now - _last_call_ts
    if elapsed < _RATE_LIMIT_SECS:
        time.sleep(_RATE_LIMIT_SECS - elapsed)
    _last_call_ts = time.time()


def _call_with_retry(fn, *args, **kwargs):
    """Call a Polygon API function with rate limiting and 429 retry."""
    for attempt in range(_MAX_RETRIES):
        _rate_limit()
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            if "429" in str(e) and attempt < _MAX_RETRIES - 1:
                wait = _RETRY_BACKOFF * (attempt + 1)
                logger.warning(f"Polygon 429 rate limit — waiting {wait}s (attempt {attempt + 1}/{_MAX_RETRIES})")
                time.sleep(wait)
            else:
                raise


def _get_client() -> RESTClient:
    key = os.environ.get("POLYGON_API_KEY", "")
    if not key:
        try:
            from app.core.config import settings
            key = settings.POLYGON_API_KEY
        except Exception:
            pass
    if not key:
        raise RuntimeError("POLYGON_API_KEY not set in environment")
    return RESTClient(api_key=key)


def build_option_ticker(symbol: str, expiration: str, right: str, strike: float) -> str:
    """Build a Polygon option ticker string.

    Format: O:SPY260410C00680000
    - O: prefix
    - SPY: underlying
    - 260410: YYMMDD expiration
    - C/P: call or put
    - 00680000: strike * 1000, zero-padded to 8 digits
    """
    exp_date = datetime.strptime(expiration, "%Y-%m-%d")
    exp_str = exp_date.strftime("%y%m%d")
    strike_int = int(strike * 1000)
    return f"O:{symbol}{exp_str}{right[0].upper()}{strike_int:08d}"


def get_option_contracts(
    symbol: str,
    expiration: str,
    strike_min: Optional[float] = None,
    strike_max: Optional[float] = None,
    contract_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """List available option contracts for a symbol and expiration.

    Args:
        symbol: Underlying ticker (e.g., "SPY")
        expiration: Date string "YYYY-MM-DD"
        strike_min: Minimum strike price filter
        strike_max: Maximum strike price filter
        contract_type: "call" or "put" (optional)

    Returns:
        List of contract dicts with ticker, strike, right, expiration, etc.
    """
    client = _get_client()
    params = {
        "underlying_ticker": symbol,
        "expiration_date": expiration,
        "limit": 250,
        "sort": "strike_price",
        "order": "asc",
    }
    if strike_min is not None:
        params["strike_price_gte"] = strike_min
    if strike_max is not None:
        params["strike_price_lte"] = strike_max
    if contract_type:
        params["contract_type"] = contract_type.lower()

    results = []
    for contract in _call_with_retry(lambda: list(client.list_options_contracts(**params))):
        results.append({
            "ticker": contract.ticker,
            "underlying": contract.underlying_ticker,
            "strike": contract.strike_price,
            "right": "C" if contract.contract_type == "call" else "P",
            "expiration": contract.expiration_date,
            "style": getattr(contract, "exercise_style", None),
            "shares_per_contract": getattr(contract, "shares_per_contract", 100),
        })
    return results


def get_option_bars(
    option_ticker: str,
    from_date: str,
    to_date: str,
    interval: str = "1",
    timespan: str = "minute",
) -> List[Dict[str, Any]]:
    """Fetch historical OHLCV bars for a specific option contract.

    Args:
        option_ticker: Polygon option ticker (e.g., "O:SPY260410C00680000")
        from_date: Start date "YYYY-MM-DD"
        to_date: End date "YYYY-MM-DD"
        interval: Multiplier (e.g., "1" for 1-minute, "5" for 5-minute)
        timespan: "minute", "hour", "day"

    Returns:
        List of bar dicts with time, open, high, low, close, volume.
    """
    client = _get_client()
    bars = []
    for agg in _call_with_retry(lambda: list(client.list_aggs(
        ticker=option_ticker,
        multiplier=int(interval),
        timespan=timespan,
        from_=from_date,
        to=to_date,
        limit=50000,
        sort="asc",
    ))):
        # agg.timestamp is ms since epoch
        ts = int(agg.timestamp / 1000)
        bars.append({
            "time": ts,
            "open": agg.open,
            "high": agg.high,
            "low": agg.low,
            "close": agg.close,
            "volume": agg.volume,
            "vwap": getattr(agg, "vwap", None),
            "trades": getattr(agg, "transactions", None),
        })
    return bars


def get_option_chain_snapshot(
    symbol: str,
    expiration: str,
    spot: float,
    window: float = 15.0,
) -> Dict[str, List[Dict[str, Any]]]:
    """Get the option chain for a specific expiration from Polygon reference data.

    This returns the contracts available — for actual prices, use get_option_bars
    for each contract at the desired timestamp.

    Args:
        symbol: Underlying ticker
        expiration: "YYYY-MM-DD"
        spot: Current underlying price (for filtering strikes)
        window: Dollar window around spot for strike selection

    Returns:
        {"calls": [...], "puts": [...]} with contract details.
    """
    calls = get_option_contracts(
        symbol, expiration,
        strike_min=spot - window,
        strike_max=spot + window,
        contract_type="call",
    )
    puts = get_option_contracts(
        symbol, expiration,
        strike_min=spot - window,
        strike_max=spot + window,
        contract_type="put",
    )
    return {"calls": calls, "puts": puts}


def get_stock_bars(
    symbol: str,
    from_date: str,
    to_date: str,
    interval: str = "1",
    timespan: str = "minute",
) -> List[Dict[str, Any]]:
    """Fetch historical OHLCV bars for a stock/ETF from Polygon.

    Args:
        symbol: Ticker (e.g., "SPY")
        from_date: Start date "YYYY-MM-DD"
        to_date: End date "YYYY-MM-DD"
        interval: Multiplier (e.g., "1", "5", "15")
        timespan: "minute", "hour", "day"

    Returns:
        List of bar dicts with time, open, high, low, close, volume.
    """
    client = _get_client()
    bars = []
    for agg in _call_with_retry(lambda: list(client.list_aggs(
        ticker=symbol,
        multiplier=int(interval),
        timespan=timespan,
        from_=from_date,
        to=to_date,
        limit=50000,
        sort="asc",
    ))):
        ts = int(agg.timestamp / 1000)
        bars.append({
            "time": ts,
            "open": agg.open,
            "high": agg.high,
            "low": agg.low,
            "close": agg.close,
            "volume": agg.volume,
        })
    return bars


def get_option_premium_at_time(
    symbol: str,
    expiration: str,
    strike: float,
    right: str,
    target_date: str,
    target_time_et: Optional[str] = None,
    interval: str = "1",
) -> Optional[Dict[str, Any]]:
    """Get the option premium at a specific time on a specific date.

    Args:
        symbol: Underlying (e.g., "SPY")
        expiration: Option expiration "YYYY-MM-DD"
        strike: Strike price
        right: "C" or "P"
        target_date: Date to look up "YYYY-MM-DD"
        target_time_et: Optional ET time "HH:MM" to find nearest bar
        interval: Bar interval in minutes

    Returns:
        The bar dict at or nearest to the target time, or None.
    """
    ticker = build_option_ticker(symbol, expiration, right, strike)
    bars = get_option_bars(ticker, target_date, target_date, interval)
    if not bars:
        return None
    if not target_time_et:
        return bars[-1]

    # Find bar nearest to target time
    target_dt = datetime.strptime(f"{target_date} {target_time_et}", "%Y-%m-%d %H:%M")
    target_dt = target_dt.replace(tzinfo=NY)
    target_ts = int(target_dt.timestamp())

    nearest = min(bars, key=lambda b: abs(b["time"] - target_ts))
    return nearest
