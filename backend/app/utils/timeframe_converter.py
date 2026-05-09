"""Timeframe conversion utilities for IB Gateway."""
from typing import Dict, Tuple


# Mapping of standard timeframe notation to IB Gateway format
TIMEFRAME_MAPPING: Dict[str, Dict[str, str]] = {
    "1m": {"bar_size": "1 min", "duration": "3 D"},
    "5m": {"bar_size": "5 mins", "duration": "2 D"},
    "15m": {"bar_size": "15 mins", "duration": "1 W"},
    "30m": {"bar_size": "30 mins", "duration": "1 M"},
    "1h": {"bar_size": "1 hour", "duration": "1 M"},
    "4h": {"bar_size": "4 hours", "duration": "1 M"},
    "1d": {"bar_size": "1 day", "duration": "1 Y"},
    "1w": {"bar_size": "1 week", "duration": "2 Y"},
}


def convert_timeframe(interval: str) -> Tuple[str, str]:
    """
    Convert standard timeframe notation to IB Gateway format.

    Args:
        interval: Standard timeframe (e.g., "5m", "1h", "1d")

    Returns:
        Tuple of (bar_size, duration) for IB Gateway API

    Raises:
        ValueError: If interval is not supported
    """
    if interval not in TIMEFRAME_MAPPING:
        supported = ", ".join(TIMEFRAME_MAPPING.keys())
        raise ValueError(
            f"Unsupported interval: {interval}. Supported intervals: {supported}"
        )

    mapping = TIMEFRAME_MAPPING[interval]
    return mapping["bar_size"], mapping["duration"]


def get_supported_timeframes() -> list[str]:
    """Get list of supported timeframe intervals."""
    return list(TIMEFRAME_MAPPING.keys())
