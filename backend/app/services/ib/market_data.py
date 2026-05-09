"""Market data service for fetching historical and real-time data from IB."""
import asyncio
import json
import logging
from datetime import datetime, date, time, timezone
from typing import List, Dict, Any

import redis
from ib_insync import Stock, Contract, Index, util
from app.core.config import settings
from app.services.ib.gateway import ib_manager
from app.services.ib.metrics import record_start, record_end
from app.utils.timeframe_converter import convert_timeframe

logger = logging.getLogger(__name__)

_redis_client = None
_BARS_CACHE_TTL = 30 * 24 * 60 * 60  # 30 days in seconds


def _get_redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client

INDEX_CONTRACTS: Dict[str, Dict[str, str]] = {
    "SPX": {"exchange": "CBOE", "currency": "USD"},
}


def _build_contract(
    symbol: str,
    con_id: int | None = None,
    sec_type: str | None = None,
    exchange: str | None = None,
    currency: str | None = None,
) -> Contract:
    if con_id:
        return Contract(
            conId=con_id,
            secType=sec_type or "",
            exchange=exchange or "SMART",
            currency=currency or "USD",
        )
    if symbol in INDEX_CONTRACTS:
        meta = INDEX_CONTRACTS[symbol]
        return Index(symbol, meta["exchange"], meta.get("currency", "USD"))
    return Stock(symbol, exchange or "SMART", currency or "USD")


async def get_historical_bars(
    symbol: str,
    interval: str,
    bars_count: int = 500,
    con_id: int | None = None,
    sec_type: str | None = None,
    exchange: str | None = None,
    currency: str | None = None,
    use_rth: bool = True,
    end_date: datetime | None = None,
) -> List[Dict[str, Any]]:
    """
    Fetch historical OHLCV bars from IB Gateway.

    Args:
        symbol: Stock symbol (e.g., "SPY")
        interval: Timeframe interval (e.g., "5m", "1h", "1d")
        bars_count: Number of bars to fetch (default: 500)

    Returns:
        List of bar dictionaries with OHLCV data

    Raises:
        ValueError: If symbol or interval is invalid
        ConnectionError: If IB Gateway connection fails
    """
    # --- Redis cache check ---
    today = date.today()
    is_past = (end_date is not None and isinstance(end_date, datetime)
               and end_date.date() < today)
    end_date_tag = end_date.strftime("%Y%m%d_%H%M") if end_date else "live"
    rth_tag = "rth" if use_rth else "ext"
    cache_key = f"bars:{symbol}:{interval}:{end_date_tag}:{bars_count}:{rth_tag}"

    if is_past:
        try:
            cached_raw = _get_redis().get(cache_key)
            if cached_raw:
                result = json.loads(cached_raw)
                logger.info(f"Redis cache HIT for {cache_key} ({len(result)} bars)")
                return result
        except Exception as exc:
            logger.warning(f"Redis cache read failed for {cache_key}: {exc}")

    # --- IB fetch ---
    try:
        start = record_start("historical_bars", symbol)
        # Get IB connection
        ib = await ib_manager.get_connection()

        # Force live market data — options_data.py may have set type 3 (delayed)
        # on this shared connection. IB Gateway applies +delay to historical
        # requests when the client is in delayed mode.
        ib.reqMarketDataType(1)

        # Create contract
        contract = _build_contract(symbol, con_id, sec_type, exchange, currency)
        await ib.qualifyContractsAsync(contract)

        # Convert timeframe to IB format
        bar_size, duration = convert_timeframe(interval)

        logger.info(
            f"Fetching {bars_count} bars for {symbol} with interval {interval} "
            f"(bar_size={bar_size}, duration={duration})"
        )

        # Request historical data
        # If end_date is provided, format it for IB API (format: "yyyyMMdd HH:mm:ss" or "yyyyMMdd-HH:mm:ss")
        end_datetime_str = ""
        if end_date:
            # IB API accepts format: "20260217 16:00:00" or "20260217-16:00:00"
            end_datetime_str = end_date.strftime("%Y%m%d %H:%M:%S")

        bars = await ib.reqHistoricalDataAsync(
            contract,
            endDateTime=end_datetime_str,  # Empty string = current time, or specific date
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow="TRADES",
            useRTH=use_rth,  # Regular trading hours only when True
            formatDate=1,  # Return as datetime objects
        )

        # Diagnostic: log the latest bar time vs current time
        if bars:
            latest_bar = bars[-1]
            latest_dt = latest_bar.date
            now_utc = datetime.now(timezone.utc)
            if isinstance(latest_dt, datetime):
                if latest_dt.tzinfo is None:
                    # ib_insync returns naive datetimes in UTC for intraday
                    lag = now_utc.replace(tzinfo=None) - latest_dt
                else:
                    lag = now_utc - latest_dt
                lag_min = lag.total_seconds() / 60
                logger.warning(
                    f"CHART DIAG: {symbol} {interval} latest_bar={latest_dt} "
                    f"now_utc={now_utc.strftime('%H:%M:%S')} lag={lag_min:.1f}min "
                    f"bars_returned={len(bars)}"
                )

        # Convert to list of dictionaries (limit to requested count)
        result = []
        for bar in bars[-bars_count:]:
            bar_date = bar.date
            if isinstance(bar_date, date) and not isinstance(bar_date, datetime):
                bar_date = datetime.combine(bar_date, time.min)
            result.append(
                {
                    "time": int(bar_date.timestamp()),  # Unix timestamp
                    "open": float(bar.open),
                    "high": float(bar.high),
                    "low": float(bar.low),
                    "close": float(bar.close),
                    "volume": int(bar.volume),
                }
            )

        logger.info(f"Successfully fetched {len(result)} bars for {symbol}")
        record_end(start, True, response_items=len(result))

        # --- Redis cache store (past dates only) ---
        if is_past and result:
            try:
                _get_redis().setex(cache_key, _BARS_CACHE_TTL, json.dumps(result))
                logger.info(f"Redis cache SET for {cache_key} ({len(result)} bars, TTL=30d)")
            except Exception as exc:
                logger.warning(f"Redis cache write failed for {cache_key}: {exc}")

        # Small delay after actual IB requests to respect rate limits
        await asyncio.sleep(0.2)

        return result

    except Exception as e:
        logger.error(f"Error fetching historical data for {symbol}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        raise


async def get_intraday_bars_for_date(
    symbol: str,
    date_str: str,
) -> List[Dict[str, Any]]:
    """
    Fetch all 1-minute bars for a specific past trading date.

    Args:
        symbol:   Stock symbol, e.g. "AAPL"
        date_str: Date as "YYYYMMDD", e.g. "20260115"

    Returns:
        List of {time, high, low, close} dicts sorted ascending by time.
        Returns [] if IB has no data for that date (too old, holiday, etc.)
    """
    try:
        ib = await ib_manager.get_connection()
        contract = _build_contract(symbol)
        await ib.qualifyContractsAsync(contract)
        # IB endDateTime format: "YYYYMMDD HH:MM:SS" — no timezone suffix,
        # uses the IB Gateway's configured timezone (US/Eastern for US traders).
        end_dt_str = f"{date_str} 16:00:00"
        logger.info(f"get_intraday_bars_for_date: {symbol} {date_str} endDateTime={end_dt_str!r}")
        bars = await ib.reqHistoricalDataAsync(
            contract,
            endDateTime=end_dt_str,
            durationStr="1 D",
            barSizeSetting="1 min",
            whatToShow="TRADES",
            useRTH=True,
            formatDate=1,
        )
        logger.info(f"get_intraday_bars_for_date: {symbol} {date_str} → {len(bars)} bars returned")
        result = []
        for bar in bars:
            bar_date = bar.date
            if isinstance(bar_date, date) and not isinstance(bar_date, datetime):
                bar_date = datetime.combine(bar_date, time.min)
            result.append({
                "time":  int(bar_date.timestamp()),
                "high":  float(bar.high),
                "low":   float(bar.low),
                "close": float(bar.close),
            })
        return result
    except Exception as e:
        logger.warning(f"get_intraday_bars_for_date({symbol}, {date_str}) FAILED: {e}")
        return []


async def validate_symbol(symbol: str) -> bool:
    """
    Validate if a symbol exists and can be traded.

    Args:
        symbol: Stock symbol to validate

    Returns:
        True if valid, False otherwise
    """
    try:
        start = record_start("validate_symbol", symbol)
        ib = await ib_manager.get_connection()
        contract = _build_contract(symbol)
        qualified = await ib.qualifyContractsAsync(contract)
        record_end(start, True, response_items=len(qualified))
        return len(qualified) > 0
    except Exception as e:
        logger.error(f"Error validating symbol {symbol}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        return False


async def search_symbols(query: str, max_results: int = 20) -> List[Dict[str, Any]]:
    """
    Search symbols using IB Gateway matching symbols endpoint.

    Args:
        query: Company name or ticker
        max_results: Maximum results to return

    Returns:
        List of symbol match dictionaries
    """
    try:
        start = record_start("search_symbols", query)
        ib = await ib_manager.get_connection()
        if hasattr(ib, "reqMatchingSymbolsAsync"):
            matches = await ib.reqMatchingSymbolsAsync(query)
        else:
            matches = await ib.reqMatchingSymbols(query)

        results: List[Dict[str, Any]] = []
        for match in matches[:max_results]:
            contract = match.contract
            results.append(
                {
                    "symbol": contract.symbol,
                    "secType": contract.secType,
                    "exchange": contract.exchange,
                    "primaryExchange": contract.primaryExchange,
                    "currency": contract.currency,
                    "conId": contract.conId,
                    "description": getattr(match, "description", None)
                    or getattr(match, "name", None),
                }
            )
        record_end(start, True, response_items=len(results))
        return results
    except Exception as e:
        logger.error(f"Error searching symbols for {query}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        raise
