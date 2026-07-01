"""Historical GEX for the 0DTE tool — delegates to the proven backtester path."""
import logging
from datetime import datetime
from typing import Any, Dict
from zoneinfo import ZoneInfo

from app.services.polygon_data import get_stock_bars
from app.services.strategy12_gex import compute_gex_for_backtest

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")


def compute_historical_gex_spy(
    date: str,
    time_et: str,
    strike_range: int = 25,
) -> Dict[str, Any]:
    """Return historical GEX levels for SPY at a specific date and time.

    Uses the same Polygon-bars + Black-Scholes path as the existing backtester
    (strategy12_gex.compute_gex_for_backtest). Polygon retains OHLCV bars for
    expired option contracts, so this works for past 0DTE dates.

    Args:
        date: Trading date "YYYY-MM-DD"
        time_et: Eastern time "HH:MM" (used to resolve the spot price)
        strike_range: Dollar range ± from spot (default 15 keeps API calls ~60)

    Returns:
        Dict matching the live /gex-analysis response shape.
        Expect ~30–90 s response time due to per-strike Polygon API calls.
    """
    # Step 1: SPY spot at target time from 1-min bars
    bars = get_stock_bars(symbol="SPY", from_date=date, to_date=date,
                          interval="1", timespan="minute")
    if not bars:
        raise ValueError(f"No SPY bars found for {date}")

    target_dt = datetime.strptime(f"{date} {time_et}", "%Y-%m-%d %H:%M").replace(tzinfo=NY)
    target_ts = int(target_dt.timestamp())
    nearest_bar = min(bars, key=lambda b: abs(b["time"] - target_ts))
    spot = nearest_bar["close"]
    logger.info("Historical GEX: SPY spot=%.2f at %s %s", spot, date, time_et)

    # Step 2: compute GEX via the backtester path (Polygon bars + BS gamma)
    levels = compute_gex_for_backtest(
        symbol="SPY",
        day_str=date,
        spot=spot,
        strike_range=float(strike_range),
    )

    if not levels:
        return {
            "spot": spot,
            "call_wall": None,
            "put_wall": None,
            "gamma_flip": None,
            "regime": None,
            "long_gamma_nodes": [],
            "short_gamma_nodes": [],
            "profile": [],
            "as_of": f"{date} {time_et} ET",
            "source": "polygon_bars_bs",
            "symbol": "SPY",
            "quote_count": 0,
            "error": "No option bar data returned from Polygon for this date",
        }

    return {
        "spot": spot,
        "call_wall": levels.get("call_wall"),
        "put_wall": levels.get("put_wall"),
        "gamma_flip": levels.get("zero_gamma"),
        "regime": levels.get("regime"),
        "long_gamma_nodes": levels.get("long_gamma_nodes", []),
        "short_gamma_nodes": levels.get("short_gamma_nodes", []),
        "profile": levels.get("profile", []),
        "as_of": f"{date} {time_et} ET",
        "source": "polygon_bars_bs",
        "symbol": "SPY",
        "quote_count": levels.get("quote_count"),
        "note": "GEX computed from Polygon option bars + Black-Scholes gamma (volume = OI proxy)",
    }


def get_spy_intraday_bars(date: str) -> list:
    """Return 1-min OHLCV bars for SPY on the given date (full session)."""
    return get_stock_bars(symbol="SPY", from_date=date, to_date=date,
                          interval="1", timespan="minute")
