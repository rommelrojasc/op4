"""Favorites storage for auto-trader filtering."""
import json
from pathlib import Path
from typing import List

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
FAVORITES_FILE = DATA_DIR / "favorites.json"


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not FAVORITES_FILE.exists():
        FAVORITES_FILE.write_text("[]")


def get_favorites() -> List[str]:
    _ensure_file()
    try:
        data = json.loads(FAVORITES_FILE.read_text())
        if isinstance(data, list):
            return [str(item).upper() for item in data if str(item).strip()]
    except Exception:
        return []
    return []


def save_favorites(favorites: List[str]) -> List[str]:
    _ensure_file()
    normalized = [str(item).upper() for item in favorites if str(item).strip()]
    FAVORITES_FILE.write_text(json.dumps(sorted(set(normalized)), indent=2))
    return normalized
