"""Finviz scraping utilities (Recom + Target Price, Earnings)."""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
import redis
from app.core.config import settings

logger = logging.getLogger(__name__)

CACHE_TTL = timedelta(days=30)
_cache: Dict[str, Tuple[datetime, Dict[str, Optional[str]]]] = {}
_redis_client = None


def _get_redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def fetch_finviz_recom_target(symbol: str) -> Dict[str, Optional[str]]:
    """
    Scrape Finviz for analyst recommendation and target price.
    """
    cache_key = f"finviz:{symbol}"
    try:
        client = _get_redis()
        cached_raw = client.get(cache_key)
        if cached_raw:
            cached_payload = json.loads(cached_raw)
            return cached_payload
    except Exception as e:
        logger.warning(f"Finviz cache (redis) unavailable: {e}")

    cached = _cache.get(symbol)
    if cached:
        cached_at, payload = cached
        if datetime.utcnow() - cached_at < CACHE_TTL:
            return {**payload, "cached_at": cached_at.isoformat()}
    url = f"https://finviz.com/quote.ashx?t={symbol}&p=d"
    try:
        req = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/121.0.0.0 Safari/537.36"
            },
        )
        with urlopen(req, timeout=15) as response:
            html = response.read()
        soup = BeautifulSoup(html, "html.parser")
        table = soup.find("table", {"class": "snapshot-table2"})
        if not table:
            return {"recom": None, "target_price": None}

        cells = [cell.get_text(strip=True) for cell in table.find_all("td")]
        data = {}
        for i in range(0, len(cells) - 1, 2):
            label = cells[i]
            value = cells[i + 1]
            data[label] = value

        result = {
            "recom": data.get("Recom"),
            "target_price": data.get("Target Price"),
            "cached_at": datetime.utcnow().isoformat(),
        }
        _cache[symbol] = (datetime.utcnow(), result)
        try:
            client = _get_redis()
            client.setex(cache_key, int(CACHE_TTL.total_seconds()), json.dumps(result))
        except Exception as e:
            logger.warning(f"Finviz cache (redis) set failed: {e}")
        return result
    except Exception as e:
        logger.error(f"Error scraping Finviz for {symbol}: {e}")
        return {"recom": None, "target_price": None, "cached_at": None}


def _parse_finviz_earnings_date(raw_value: Optional[str]) -> Optional[str]:
    if not raw_value:
        return None
    value = raw_value.strip()
    if value.upper() in {"N/A", "NA", "-"}:
        return None
    # Examples: "Feb 06 AMC", "Feb 6 BMO"
    parts = value.split()
    if len(parts) < 2:
        return None
    month = parts[0]
    day = parts[1]
    try:
        day_int = int(day)
    except ValueError:
        return None
    now = datetime.utcnow()
    try:
        parsed = datetime.strptime(f"{month} {day_int} {now.year}", "%b %d %Y")
    except ValueError:
        return None
    # If date looks far in the past, assume next year
    if (now - parsed).days > 180:
        parsed = parsed.replace(year=now.year + 1)
    return parsed.strftime("%Y-%m-%d")


def fetch_finviz_earnings_date(symbol: str) -> Dict[str, Optional[str]]:
    """
    Scrape Finviz for earnings date.
    """
    cache_key = f"finviz:earnings:{symbol}"
    try:
        client = _get_redis()
        cached_raw = client.get(cache_key)
        if cached_raw:
            cached_payload = json.loads(cached_raw)
            return cached_payload
    except Exception as e:
        logger.warning(f"Finviz earnings cache (redis) unavailable: {e}")

    url = f"https://finviz.com/quote.ashx?t={symbol}&p=d"
    try:
        req = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/121.0.0.0 Safari/537.36"
            },
        )
        with urlopen(req, timeout=15) as response:
            html = response.read()
        soup = BeautifulSoup(html, "html.parser")
        table = soup.find("table", {"class": "snapshot-table2"})
        if not table:
            return {"earnings_date": None, "cached_at": None}

        cells = [cell.get_text(strip=True) for cell in table.find_all("td")]
        data: Dict[str, str] = {}
        for i in range(0, len(cells) - 1, 2):
            data[cells[i]] = cells[i + 1]

        earnings_raw = data.get("Earnings")
        earnings_date = _parse_finviz_earnings_date(earnings_raw)
        result = {
            "earnings_date": earnings_date,
            "cached_at": datetime.utcnow().isoformat(),
        }
        try:
            client = _get_redis()
            client.setex(cache_key, int(CACHE_TTL.total_seconds()), json.dumps(result))
        except Exception as e:
            logger.warning(f"Finviz earnings cache (redis) set failed: {e}")
        return result
    except Exception as e:
        logger.error(f"Error scraping Finviz earnings for {symbol}: {e}")
        return {"earnings_date": None, "cached_at": None}
