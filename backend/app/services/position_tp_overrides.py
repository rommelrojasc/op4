"""Per-position take-profit override service.

Allows setting custom TP settings for individual positions while keeping
global/symbol settings for new positions.
"""
import json
import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
OVERRIDES_FILE = DATA_DIR / "position_tp_overrides.json"


def _ensure_file_exists():
    """Ensure the overrides file exists."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not OVERRIDES_FILE.exists():
        OVERRIDES_FILE.write_text("{}")


def get_all_overrides() -> Dict[str, dict]:
    """Get all position TP overrides.

    Returns:
        Dict mapping signal_id -> override settings
    """
    _ensure_file_exists()
    try:
        with open(OVERRIDES_FILE, "r") as f:
            return json.load(f)
    except Exception as exc:
        logger.error(f"Failed to read TP overrides: {exc}")
        return {}


def get_override(signal_id: str) -> Optional[dict]:
    """Get TP override for a specific position.

    Args:
        signal_id: The signal ID of the position

    Returns:
        Override settings dict or None if no override exists
    """
    overrides = get_all_overrides()
    return overrides.get(signal_id)


def set_override(signal_id: str, settings: dict) -> dict:
    """Set TP override for a position.

    Args:
        signal_id: The signal ID of the position
        settings: Override settings dict with keys:
            - profitTargetPct: Custom profit target (e.g., 0.08 for 8%)
            - useTrailingStop: Whether to use trailing stop (optional)
            - trailingStopPct: Trailing stop percentage (optional)

    Returns:
        The saved override settings
    """
    _ensure_file_exists()
    try:
        overrides = get_all_overrides()
        overrides[signal_id] = settings

        with open(OVERRIDES_FILE, "w") as f:
            json.dump(overrides, f, indent=2)

        logger.info(f"Set TP override for {signal_id}: {settings}")
        return settings
    except Exception as exc:
        logger.error(f"Failed to set TP override for {signal_id}: {exc}")
        raise


def delete_override(signal_id: str) -> bool:
    """Delete TP override for a position.

    Args:
        signal_id: The signal ID of the position

    Returns:
        True if override was deleted, False if it didn't exist
    """
    _ensure_file_exists()
    try:
        overrides = get_all_overrides()
        if signal_id in overrides:
            del overrides[signal_id]

            with open(OVERRIDES_FILE, "w") as f:
                json.dump(overrides, f, indent=2)

            logger.info(f"Deleted TP override for {signal_id}")
            return True
        return False
    except Exception as exc:
        logger.error(f"Failed to delete TP override for {signal_id}: {exc}")
        raise


def get_effective_settings(signal_id: str, symbol_settings: dict) -> dict:
    """Get effective TP settings for a position, checking override first.

    Args:
        signal_id: The signal ID of the position
        symbol_settings: The symbol/global settings to use as fallback

    Returns:
        Merged settings dict with override taking precedence
    """
    override = get_override(signal_id)
    if override:
        # Merge override with symbol settings (override takes precedence)
        return {**symbol_settings, **override}
    return symbol_settings
