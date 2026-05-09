"""Local auto-trader activity log storage."""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
LOG_FILE = DATA_DIR / "auto_trader_activity.jsonl"
ARCHIVE_DIR = DATA_DIR / "archives"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LOG_FILE.exists():
        LOG_FILE.write_text("")


def archive_and_clear_events() -> None:
    """Archive previous-day events and clear them, keeping today's events.

    On same-day restarts the log is left intact so all intraday events
    are preserved in a single file.  Only events from earlier days are
    moved to the archives folder.
    """
    _ensure_file()
    try:
        content = LOG_FILE.read_text(encoding="utf-8").strip()
        if not content:
            return
        today_str = datetime.utcnow().strftime("%Y-%m-%d")
        old_lines: list[str] = []
        today_lines: list[str] = []
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                ts = entry.get("timestamp")
                if ts is not None:
                    entry_day = datetime.utcfromtimestamp(int(ts)).strftime("%Y-%m-%d")
                    if entry_day < today_str:
                        old_lines.append(line)
                        continue
            except (json.JSONDecodeError, ValueError, TypeError, OSError):
                pass
            today_lines.append(line)
        if old_lines:
            ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
            ts_label = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            dest = ARCHIVE_DIR / f"activity_log_{ts_label}.jsonl"
            dest.write_text("\n".join(old_lines) + "\n", encoding="utf-8")
            logger.info(f"Archived {len(old_lines)} old events to {dest.name}")
        # Rewrite the log with only today's events
        LOG_FILE.write_text(
            ("\n".join(today_lines) + "\n") if today_lines else "",
            encoding="utf-8",
        )
        if old_lines:
            logger.info(f"Kept {len(today_lines)} today events in activity log")
    except Exception as exc:
        logger.error(f"Failed to archive activity log: {exc}")


def append_event(event: Dict[str, Any]) -> None:
    _ensure_file()
    try:
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")
    except Exception as exc:
        logger.error(f"Failed to write auto-trader log: {exc}")


def read_events(limit: int = 200) -> List[Dict[str, Any]]:
    _ensure_file()
    try:
        lines = LOG_FILE.read_text().splitlines()
    except Exception as exc:
        logger.error(f"Failed to read auto-trader log: {exc}")
        return []
    events: List[Dict[str, Any]] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def clear_events() -> None:
    _ensure_file()
    try:
        LOG_FILE.write_text("")
    except Exception as exc:
        logger.error(f"Failed to clear auto-trader log: {exc}")


def read_all_activity_entries(start_ts: int | None = None, end_ts: int | None = None) -> List[Dict[str, Any]]:
    """Read all activity entries from archives + current log, optionally filtered by timestamp."""
    entries: List[Dict[str, Any]] = []
    files: list[Path] = sorted(ARCHIVE_DIR.glob("activity_log_*.jsonl")) if ARCHIVE_DIR.exists() else []
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > 0:
        files.append(LOG_FILE)
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = entry.get("timestamp")
                    if ts is None:
                        continue
                    if start_ts and int(ts) < start_ts:
                        continue
                    if end_ts and int(ts) > end_ts:
                        continue
                    entries.append(entry)
        except OSError:
            continue
    return entries
