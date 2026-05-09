"""Option chain snapshot storage for contract selection analysis."""
import json
import logging
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
SNAPSHOT_FILE = DATA_DIR / "option_chain_snapshots.jsonl"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SNAPSHOT_FILE.exists():
        SNAPSHOT_FILE.write_text("")


def append_snapshot(snapshot: Dict[str, Any]) -> None:
    """Append one snapshot entry as a JSON line."""
    _ensure_file()
    with open(SNAPSHOT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(snapshot, default=str) + "\n")


def read_snapshots(limit: int = 100) -> List[Dict[str, Any]]:
    """Read the most recent snapshot entries."""
    _ensure_file()
    lines = SNAPSHOT_FILE.read_text(encoding="utf-8").strip().splitlines()
    result = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result
