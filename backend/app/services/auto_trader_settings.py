"""Auto-trader settings storage."""
import json
from pathlib import Path
from typing import Any, Dict

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "auto_trader_settings.json"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "enabled": False,
    "intervalSeconds": 60,
    "tpCheckIntervalSeconds": 15,
    "rthOnly": True,
    "profitTargetPct": 0.35,
    "useTrailingStop": False,
    "trailingStopPct": 0.1,
    "maxTradesPerDay": 2,
    "useOptimalRange": True,
    "skipEarningsDay": True,
    "useMarketOrders": True,
    "useLimitOrdersForTrailExit": True,
    "useLimitOrdersForEntry": False,
    "limitOrderTimeoutSecs": 30,
    "stopLossPct": 0.0,
    "signalMaxAgeSecs": 0,
    "onePositionPerSymbol": False,
    "blockCounterTrend": True,
    "maxConcurrentPositions": 20,
    "onlyFavorites": False,
    "capitalLimit": 0.0,
    "maxDailyLossDollar": 0,
    "allowOpenPositions": True,
    "openPositionsUntil": "14:30",
    "allowClosePositions": True,
    "expiryCloseTime": "14:00",
    "overrides": {},
    "tickerSettings": {},
    "allowCalls": True,
    "allowPuts": True,
    "paperAccount": "",
    "liveAccount": "",
    "tradingMode": "paper",
    "positionSizing": "hybrid",
    "riskPerTrade": 300.0,
    "riskPctPerTrade": 2.0,
    "maxContractsPerTrade": 3,
    "minContractsPerTrade": 1,
    "strikeWindow": 12,
    "filterBySpread": True,
    "maxSpreadPct": 20.0,
    "maxSpreadDollar": 0.30,
    "preferTightSpreads": True,
    "staleAfterMinutes": 0,
    "staleMinGainPct": 0.10,
    "trailingTiers": [],
    "slippageBufferPct": 0.08,
    "limitOrderBias": 0.25,
    "chopFilterEnabled": True,
    "chopFilterAdxThreshold": 20,
    "chopFilterTimeframe": "5m",
    "chopFilterDiGap": 10,
    "strategySettings": {},
}


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(json.dumps(DEFAULT_SETTINGS, indent=2))
        return
    # Backfill any keys added to DEFAULT_SETTINGS since the file was last saved.
    try:
        data = json.loads(SETTINGS_FILE.read_text()) or {}
        missing = {k: v for k, v in DEFAULT_SETTINGS.items() if k not in data}
        if missing:
            data.update(missing)
            SETTINGS_FILE.write_text(json.dumps(data, indent=2))
    except Exception:
        pass


def get_settings() -> Dict[str, Any]:
    _ensure_file()
    try:
        data = json.loads(SETTINGS_FILE.read_text())
        return {**DEFAULT_SETTINGS, **(data or {})}
    except Exception:
        return DEFAULT_SETTINGS.copy()


def save_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_file()
    overrides = (settings or {}).get("overrides") or {}
    strategy_settings = (settings or {}).get("strategySettings") or {}
    merged = {**DEFAULT_SETTINGS, **(settings or {})}
    merged["overrides"] = overrides
    merged["strategySettings"] = strategy_settings
    SETTINGS_FILE.write_text(json.dumps(merged, indent=2))
    return merged


def get_symbol_settings(symbol: str) -> Dict[str, Any]:
    settings = get_settings()
    overrides = settings.get("overrides") or {}
    override = overrides.get(symbol, {}) or {}
    effective = {**settings, **override}
    effective.pop("overrides", None)
    return effective
