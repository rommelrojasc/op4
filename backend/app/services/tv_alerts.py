"""Storage for TradingView webhook alerts.

The webhook payload format depends on whatever the user configures in the
TradingView alert dialog (or whatever the indicator's Pine `alert()` call sends).
We therefore store the RAW body of every alert plus a receive timestamp, and
attempt a best-effort parse of common fields (symbol/price/etc.) without
assuming any particular schema.
"""
import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
LOG_FILE = DATA_DIR / "tv_alerts.jsonl"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LOG_FILE.exists():
        LOG_FILE.write_text("")


def _best_effort_parse(raw: str) -> Dict[str, Any]:
    """Try to pull structured fields out of an unknown alert body.

    Returns a dict that always contains `parsed_json` (the JSON object if the
    body was valid JSON, else None) plus any of symbol/price/time/action we
    could recover from either JSON keys or a plain-text message.
    """
    fields: Dict[str, Any] = {"parsed_json": None}

    # 1) Try JSON first.
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            fields["parsed_json"] = obj
            # Common key spellings TradingView users pick.
            for key in ("symbol", "ticker"):
                if obj.get(key):
                    fields["symbol"] = str(obj[key]).upper()
                    break
            for key in ("price", "close", "last"):
                if obj.get(key) is not None:
                    try:
                        fields["price"] = float(obj[key])
                    except (TypeError, ValueError):
                        pass
                    break
            for key in ("time", "timenow", "timestamp"):
                if obj.get(key):
                    fields["time"] = obj[key]
                    break
            for key in ("action", "side", "signal"):
                if obj.get(key):
                    fields["action"] = str(obj[key])
                    break
            return fields
    except (json.JSONDecodeError, ValueError):
        pass

    # 2) Plain text: recover what we can from a free-form message.
    lower = raw.lower()

    # Direction from common keywords.
    if re.search(r"\b(buy|long|bull)\b", lower):
        fields["action"] = "buy"
    elif re.search(r"\b(sell|short|bear|exit)\b", lower):
        fields["action"] = "sell"

    # A ticker-ish token (all-caps 1-6 chars), if the message happens to carry one.
    sym_match = re.search(r"\b([A-Z]{1,6})\b", raw)
    if sym_match:
        fields["symbol"] = sym_match.group(1).upper()

    # A price, if present.
    price_match = re.search(r"(\d+(?:\.\d+)?)", raw)
    if price_match:
        try:
            fields["price"] = float(price_match.group(1))
        except ValueError:
            pass

    # Use the whole message as the human-readable signal label.
    fields["signal"] = raw.strip()
    return fields


def append_alert(
    raw_body: str,
    content_type: Optional[str] = None,
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Store a raw alert body and return the persisted entry.

    `overrides` (e.g. symbol/action from webhook URL query params) take
    precedence over fields parsed from the body.
    """
    _ensure_file()
    entry: Dict[str, Any] = {
        "received_at": int(time.time()),
        "content_type": content_type,
        "raw": raw_body,
        **_best_effort_parse(raw_body),
    }
    if overrides:
        entry.update({k: v for k, v in overrides.items() if v is not None})
    try:
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
    except Exception as exc:
        logger.error(f"Failed to write TradingView alert: {exc}")
    return entry


def read_alerts(limit: int = 200, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return stored alerts, most-recent last. Optionally filter by symbol."""
    _ensure_file()
    try:
        lines = LOG_FILE.read_text().splitlines()
    except Exception as exc:
        logger.error(f"Failed to read TradingView alerts: {exc}")
        return []

    entries: List[Dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            continue

    if symbol:
        target = symbol.upper()
        entries = [e for e in entries if str(e.get("symbol", "")).upper() == target]

    return entries[-limit:]


def clear_alerts() -> None:
    _ensure_file()
    try:
        LOG_FILE.write_text("")
    except Exception as exc:
        logger.error(f"Failed to clear TradingView alerts: {exc}")
