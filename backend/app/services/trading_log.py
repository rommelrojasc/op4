"""Local trade log storage for paper trading."""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
LOG_FILE = DATA_DIR / "trade_log.jsonl"
ARCHIVE_DIR = DATA_DIR / "archives"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LOG_FILE.exists():
        LOG_FILE.write_text("")


def append_entry(entry: Dict[str, Any]) -> None:
    _ensure_file()
    try:
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
    except Exception as exc:
        logger.error(f"Failed to write trade log: {exc}")


def read_entries(limit: int = 200) -> List[Dict[str, Any]]:
    _ensure_file()
    try:
        lines = LOG_FILE.read_text().splitlines()
    except Exception as exc:
        logger.error(f"Failed to read trade log: {exc}")
        return []
    entries: List[Dict[str, Any]] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            continue
    return entries


def clear_entries() -> None:
    _ensure_file()
    try:
        LOG_FILE.write_text("")
    except Exception as exc:
        logger.error(f"Failed to clear trade log: {exc}")


def archive_entries() -> str:
    _ensure_file()
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    archive_path = ARCHIVE_DIR / f"trade_log_{timestamp}.jsonl"
    try:
        archive_path.write_text(LOG_FILE.read_text())
    except Exception as exc:
        logger.error(f"Failed to archive trade log: {exc}")
        raise
    return str(archive_path)


def update_position_field(position_id: str, field: str, value: Any) -> bool:
    """Update a specific field in an open position entry."""
    _ensure_file()
    try:
        # Read all entries
        lines = LOG_FILE.read_text().splitlines()
        updated = False
        new_lines = []

        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                # Update the matching OPEN entry
                if (entry.get("position_id") == position_id and
                    entry.get("type") == "OPEN"):
                    entry[field] = value
                    updated = True
                new_lines.append(json.dumps(entry))
            except Exception:
                new_lines.append(line)

        # Write back to file
        if updated:
            LOG_FILE.write_text("\n".join(new_lines) + "\n")

        return updated
    except Exception as exc:
        logger.error(f"Failed to update position field: {exc}")
        return False


def build_open_positions(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    positions: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        position_id = entry.get("position_id")
        if not position_id:
            continue
        entry_type = entry.get("type")
        if entry_type == "OPEN":
            positions[position_id] = entry
        elif entry_type == "CLOSE":
            positions.pop(position_id, None)
    return list(positions.values())


def summarize(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    daily: Dict[str, float] = {}
    total = 0.0
    for entry in entries:
        pnl = entry.get("pnl")
        if pnl is None:
            continue
        try:
            pnl_value = float(pnl)
        except (TypeError, ValueError):
            continue
        timestamp = entry.get("timestamp")
        if timestamp:
            day_key = datetime.utcfromtimestamp(int(timestamp)).strftime("%Y-%m-%d")
        else:
            day_key = "unknown"
        daily[day_key] = daily.get(day_key, 0.0) + pnl_value
        total += pnl_value
    return {"total_pnl": total, "daily_pnl": daily}
