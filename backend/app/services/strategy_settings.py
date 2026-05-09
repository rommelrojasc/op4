"""Strategy settings storage (per symbol)."""
import json
from pathlib import Path
from typing import Any, Dict, Optional

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "strategy_settings.json"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(json.dumps({"symbols": {}}, indent=2))


def _load() -> Dict[str, Any]:
    _ensure_file()
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except Exception:
        return {"symbols": {}}


def get_settings(symbol: str) -> Optional[Dict[str, Any]]:
    data = _load()
    return data.get("symbols", {}).get(symbol)


def set_settings(symbol: str, settings: Dict[str, Any]) -> None:
    data = _load()
    symbols = data.setdefault("symbols", {})
    symbols[symbol] = settings
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))
