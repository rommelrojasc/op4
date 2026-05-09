"""Earnings calendar service (IB fundamentals)."""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

import redis
from ib_insync import Stock

from app.core.config import settings
from app.services.ib.gateway import ib_manager
from app.services.ib.metrics import record_start, record_end
from app.services.finviz_data import fetch_finviz_earnings_date

logger = logging.getLogger(__name__)

CACHE_TTL = timedelta(days=30)
_redis_client = None


def _get_redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def _parse_earnings_date(payload: str) -> Optional[str]:
    """
    Parse IB fundamental XML for an earnings date.
    Returns YYYY-MM-DD if found.
    """
    if not payload:
        return None
    for marker in ("EarningsDate", "EarningsDate="):
        if marker in payload:
            # Try to split on common XML/CSV-like tokens
            for token in ('<EarningsDate>', 'EarningsDate="'):
                if token in payload:
                    tail = payload.split(token, 1)[1]
                    if token.endswith('>'):
                        value = tail.split('<', 1)[0]
                    else:
                        value = tail.split('"', 1)[0]
                    value = value.strip()
                    if value:
                        return value[:10]
    return None


async def get_earnings_date(symbol: str) -> Optional[str]:
    """
    Fetch earnings date via IB fundamental data (cached).
    """
    cache_key = f"earnings:{symbol}"
    try:
        client = _get_redis()
        cached_raw = client.get(cache_key)
        if cached_raw:
            cached_payload = json.loads(cached_raw)
            return cached_payload.get("earnings_date")
    except Exception as e:
        logger.warning(f"Earnings cache (redis) unavailable: {e}")

    try:
        start = record_start("earnings", symbol)
        ib = await ib_manager.get_connection()
        contract = Stock(symbol, "SMART", "USD")
        await ib.qualifyContractsAsync(contract)

        # CalendarReport provides corporate actions/earnings when available
        payload = await ib.reqFundamentalDataAsync(contract, "CalendarReport")
        earnings_date = _parse_earnings_date(payload or "")
        if not earnings_date:
            finviz = fetch_finviz_earnings_date(symbol)
            earnings_date = finviz.get("earnings_date")

        cached_at = datetime.utcnow().isoformat()
        try:
            client = _get_redis()
            client.setex(
                cache_key,
                int(CACHE_TTL.total_seconds()),
                json.dumps({"earnings_date": earnings_date, "cached_at": cached_at}),
            )
        except Exception as e:
            logger.warning(f"Earnings cache (redis) set failed: {e}")
        record_end(start, True, response_items=1 if earnings_date else 0)
        return earnings_date
    except Exception as e:
        logger.error(f"Error fetching earnings date for {symbol}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        return None
