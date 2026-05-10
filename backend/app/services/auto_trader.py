"""Background auto-trader that scans strategies every minute (RTH only)."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.data.symbols import SYMBOLS
from app.services.ib.earnings_data import get_earnings_date
from app.services.ib.market_data import get_historical_bars
from app.services.ib.options_data import get_option_chain, get_option_quotes, get_batch_option_quotes
from app.services.ib.gateway import ib_manager
from app.services.ib.trading import place_option_order, cancel_order, get_settle_cash, get_available_funds
from app.services.strategy_analysis import StrategySignal, analyze_with_bars, get_ny_day_key
from app.services.strategy_defaults import DEFAULT_STRATEGY_SETTINGS, merge_strategy_settings
from app.services.strategy_settings import get_settings
from app.services.trading_log import append_entry, build_open_positions, read_entries, update_position_field
from app.services.auto_trader_log import append_event, read_events, clear_events, archive_and_clear_events
from app.services.position_tp_overrides import get_effective_settings as get_effective_tp_settings
from app.services.option_chain_snapshot import append_snapshot
from app.services.auto_trader_settings import (
    get_settings as get_auto_trader_settings,
    get_symbol_settings,
)
from app.services.favorites import get_favorites

logger = logging.getLogger(__name__)

NY_TZ = ZoneInfo("America/New_York")

BASE_DIR = Path(__file__).resolve().parents[3]
OPTIMAL_RANGES_FILE = BASE_DIR / "frontend" / "src" / "data" / "optimalRanges.json"

# ── Disk-based bars cache ─────────────────────────────────────────────────────
_BARS_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "bars_cache"

# Seconds per bar for each supported interval — used to compute the delta fetch count.
_INTERVAL_SECONDS: Dict[str, int] = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400,
}


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Convert value to float, returning *default* for None/empty-string/non-numeric."""
    if val is None or val == "":
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _bars_disk_path(symbol: str, interval: str) -> Path:
    _BARS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    return _BARS_DATA_DIR / f"{symbol}_{interval}.json"


def _load_bars_from_disk(symbol: str, interval: str) -> Optional[List[Dict[str, Any]]]:
    """Return cached bars from disk, or None if not found / corrupt."""
    path = _bars_disk_path(symbol, interval)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        bars = data.get("bars")
        if isinstance(bars, list) and bars:
            return bars
    except Exception as exc:
        logger.warning("Failed to load bars from disk for %s/%s: %s", symbol, interval, exc)
    return None


def _save_bars_to_disk(symbol: str, interval: str, bars: List[Dict[str, Any]]) -> None:
    """Persist bars to disk. Silently ignores write errors."""
    try:
        path = _bars_disk_path(symbol, interval)
        path.write_text(json.dumps({"symbol": symbol, "interval": interval, "bars": bars}))
    except Exception as exc:
        logger.warning("Failed to save bars to disk for %s/%s: %s", symbol, interval, exc)


async def _save_bars_to_disk_async(symbol: str, interval: str, bars: List[Dict[str, Any]]) -> None:
    """Non-blocking wrapper — runs disk write in a thread so the event loop stays free."""
    await asyncio.get_event_loop().run_in_executor(None, _save_bars_to_disk, symbol, interval, bars)


def _delta_bar_count(bars: List[Dict[str, Any]], interval: str, min_count: int) -> int:
    """
    Given bars already on disk, return how many bars to fetch from IBKR to
    bring them up to date.  Adds a 5-bar safety buffer to cover the current
    incomplete bar and any that arrived while the server was down.
    """
    if not bars:
        return min_count
    last_ts = bars[-1]["time"]
    secs_per_bar = _INTERVAL_SECONDS.get(interval, 60)
    elapsed_bars = max(0, int((time.time() - last_ts) / secs_per_bar))
    needed = elapsed_bars + 5          # +5 safety buffer
    return min(needed, min_count)      # never fetch more than a full warmup


def load_optimal_ranges() -> tuple[Dict[str, Dict[str, float]], Dict[str, Dict[str, float]]]:
    """Load optimal ranges from tickerSettings in auto_trader_settings.json.

    Returns (regular_ranges, zero_dte_ranges).
    Falls back to static frontend file if tickerSettings is not available.
    """
    try:
        # Try loading from saved settings first (tickerSettings)
        from app.services.auto_trader_settings import get_settings
        settings = get_settings()
        ticker_settings = settings.get("tickerSettings", {})

        ranges: Dict[str, Dict[str, float]] = {}
        ranges_0dte: Dict[str, Dict[str, float]] = {}

        if ticker_settings:
            # Convert tickerSettings format to optimal_ranges format
            # tickerSettings: {symbol: {enabled: bool, optimalMin: num, optimalMax: num, optimalMin0DTE: num, optimalMax0DTE: num}}
            for symbol, cfg in ticker_settings.items():
                if isinstance(cfg, dict):
                    if cfg.get("optimalMin") is not None and cfg.get("optimalMax") is not None:
                        ranges[symbol] = {
                            "min": float(cfg["optimalMin"]),
                            "max": float(cfg["optimalMax"])
                        }
                    if cfg.get("optimalMin0DTE") is not None and cfg.get("optimalMax0DTE") is not None:
                        ranges_0dte[symbol] = {
                            "min": float(cfg["optimalMin0DTE"]),
                            "max": float(cfg["optimalMax0DTE"])
                        }
            if ranges:
                logger.info(f"Loaded {len(ranges)} optimal ranges, {len(ranges_0dte)} 0DTE ranges from tickerSettings")
                return ranges, ranges_0dte

        # Fallback to static frontend file
        if not OPTIMAL_RANGES_FILE.exists():
            return {}, {}
        import json
        data = json.loads(OPTIMAL_RANGES_FILE.read_text())
        result = {k: v for k, v in data.items() if isinstance(v, dict)}
        logger.info(f"Loaded {len(result)} optimal ranges from static file (fallback)")
        return result, {}
    except Exception as exc:
        logger.warning(f"Failed to load optimal ranges: {exc}")
        return {}, {}


def is_rth_now() -> bool:
    now = datetime.now(NY_TZ)
    if now.weekday() >= 5:
        return False
    open_time = datetime(now.year, now.month, now.day, 9, 30, tzinfo=NY_TZ)
    close_time = datetime(now.year, now.month, now.day, 16, 0, tzinfo=NY_TZ)
    return open_time <= now <= close_time


def next_friday_key(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(NY_TZ)
    days_ahead = (4 - now.weekday()) % 7
    if days_ahead == 0:
        close_time = datetime(now.year, now.month, now.day, 16, 0, tzinfo=NY_TZ)
        if now >= close_time:
            days_ahead = 7
    target = now + timedelta(days=days_ahead)
    return target.strftime("%Y-%m-%d")


def _strategy_settings_key(strategy_id: str) -> str:
    """Map a full signal strategy_id to the short key used in strategy_defaults.

    Examples:
        "strategy-1"                                    -> "strategy1"
        "strategy2_midline_bounce_1d_1h_15m"            -> "strategy2"
        "ct15_open_gap_trendline_midline_volatility_15m"-> "ct15"
        "strategy9_0dte_gap_fade"                       -> "strategy9"
        "strategy10_0dte_trend"                         -> "strategy10"
    """
    if strategy_id.startswith("ct_open"):
        return "ct_open"
    if strategy_id.startswith("ct15"):
        return "ct15"
    m = re.match(r"strategy[_-]?(\d+)", strategy_id)
    if m:
        return f"strategy{m.group(1)}"
    return strategy_id  # fallback: use as-is


_BARS_CACHE_MAX = 100  # max symbols to keep in-memory


def merge_bars(existing: List[Dict[str, Any]], new_bars: List[Dict[str, Any]], max_len: int) -> List[Dict[str, Any]]:
    """Merge a small number of new bars into a sorted existing list.

    Existing is assumed already sorted by time (invariant maintained by this
    function on every call).  new_bars is typically 2-5 bars fetched on
    refresh, so the overhead of a full O(n log n) sort is unnecessary.
    """
    if not existing:
        result = sorted(new_bars, key=lambda b: b["time"])
        return result[-max_len:] if len(result) > max_len else result
    if not new_bars:
        return existing[-max_len:] if len(existing) > max_len else existing
    # Build O(k) lookup for the tiny new_bars set
    new_lookup: Dict[int, Dict[str, Any]] = {bar["time"]: bar for bar in new_bars}
    # Update existing bars that share a timestamp (e.g. current incomplete bar)
    updated = [new_lookup.pop(bar["time"], bar) for bar in existing]
    # Any remaining entries in new_lookup are genuinely new; sort the small set
    appended = sorted(new_lookup.values(), key=lambda b: b["time"])
    result = updated + appended
    return result[-max_len:] if len(result) > max_len else result


def _compute_adx(bars: List[Dict[str, Any]], period: int = 14) -> tuple:
    """Compute the ADX (Average Directional Index) from OHLCV bar dicts.
    Returns (adx, plus_di, minus_di) tuple, or (None, None, None) if insufficient data.
    """
    if len(bars) < 2 * period + 1:
        return None, None, None
    # Compute TR, +DM, -DM
    tr_list, plus_dm_list, minus_dm_list = [], [], []
    for i in range(1, len(bars)):
        high = bars[i]["high"]
        low = bars[i]["low"]
        prev_close = bars[i - 1]["close"]
        prev_high = bars[i - 1]["high"]
        prev_low = bars[i - 1]["low"]
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        plus_dm = max(high - prev_high, 0) if (high - prev_high) > (prev_low - low) else 0
        minus_dm = max(prev_low - low, 0) if (prev_low - low) > (high - prev_high) else 0
        tr_list.append(tr)
        plus_dm_list.append(plus_dm)
        minus_dm_list.append(minus_dm)
    # Wilder's smoothing
    atr = sum(tr_list[:period]) / period
    plus_di_smooth = sum(plus_dm_list[:period]) / period
    minus_di_smooth = sum(minus_dm_list[:period]) / period
    dx_list = []
    last_plus_di, last_minus_di = 0.0, 0.0
    for i in range(period, len(tr_list)):
        atr = (atr * (period - 1) + tr_list[i]) / period
        plus_di_smooth = (plus_di_smooth * (period - 1) + plus_dm_list[i]) / period
        minus_di_smooth = (minus_di_smooth * (period - 1) + minus_dm_list[i]) / period
        if atr == 0:
            continue
        last_plus_di = 100 * plus_di_smooth / atr
        last_minus_di = 100 * minus_di_smooth / atr
        di_sum = last_plus_di + last_minus_di
        dx = 100 * abs(last_plus_di - last_minus_di) / di_sum if di_sum > 0 else 0
        dx_list.append(dx)
    if len(dx_list) < period:
        return None, None, None
    adx = sum(dx_list[:period]) / period
    for i in range(period, len(dx_list)):
        adx = (adx * (period - 1) + dx_list[i]) / period
    return adx, last_plus_di, last_minus_di


def best_premium(quote: Dict[str, Any]) -> Optional[float]:
    return quote.get("ask") or quote.get("last") or quote.get("bid")


def exit_premium(quote: Dict[str, Any]) -> Optional[float]:
    return quote.get("bid") or quote.get("last") or quote.get("ask")


def mid_price(quote: Dict[str, Any]) -> Optional[float]:
    """Return (bid + ask) / 2 rounded to 2 decimal places, or None if unavailable."""
    bid = quote.get("bid")
    ask = quote.get("ask")
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return round((bid + ask) / 2, 2)
    return None


def biased_limit_price(quote: Dict[str, Any], bias: float = 0.25) -> Optional[float]:
    """Return mid + bias * spread, biased toward the ask for better fill rates.

    bias=0.0 → pure mid, bias=1.0 → ask price.  Default 0.25 = mid + 25% of spread.
    """
    bid = quote.get("bid")
    ask = quote.get("ask")
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return round(bid + (ask - bid) * (0.5 + bias), 2)
    return None


def _resolve_account(settings_dict: Dict[str, Any]) -> Optional[str]:
    """Return the configured account for the current IB mode (paper/live), or None."""
    mode = ib_manager.active_mode  # "paper" or "live"
    key = "paperAccount" if mode == "paper" else "liveAccount"
    account = settings_dict.get(key) or ""
    return account.strip() or None


async def _place_with_limit_fallback(
    *,
    quote: Optional[Dict[str, Any]],
    use_market_orders: bool,
    timeout_secs: float = 30.0,
    log_event_fn,
    log_kwargs: Dict[str, Any],
    limit_price: Optional[float] = None,
    pre_fallback_check=None,
    **order_kwargs,
) -> dict:
    """
    Place a limit order when use_market_orders is False.
    Waits up to timeout_secs for a fill, then cancels and falls back to a
    market order. Falls through to a market order immediately if no valid
    bid/ask is available.

    If limit_price is provided, it overrides the mid-price calculation
    (used for trailing stop exits at the trail stop price).

    If pre_fallback_check is provided (async callable returning bool),
    it is called before falling back to a market order. If it returns False,
    the order is cancelled and no market order is placed.

    Returns a dict with an extra key ``"fell_back_to_market"`` (bool)
    so the caller knows whether to wait for a market-order fill.
    Returns None if pre_fallback_check vetoed the market fallback.
    """
    limit_px: Optional[float] = None
    if not use_market_orders:
        limit_px = limit_price if limit_price is not None else (mid_price(quote) if quote else None)

    order_info = await place_option_order(**order_kwargs, limit_price=limit_px)
    if limit_px is None:
        if isinstance(order_info, dict):
            order_info["fell_back_to_market"] = False
        return order_info  # market order — caller handles fill wait

    log_event_fn(
        "limit_order_submitted",
        f"Limit order submitted at ${limit_px:.2f}.",
        **log_kwargs,
        limit_price=limit_px,
        order_id=order_info.get("order_id") if isinstance(order_info, dict) else None,
    )

    # ── Wait for fill ─────────────────────────────────────────────────────
    _trade_obj = order_info.get("trade") if isinstance(order_info, dict) else None
    _fill_confirmed = False
    if _trade_obj is not None:
        _deadline = time.time() + timeout_secs
        while time.time() < _deadline:
            _status = getattr(getattr(_trade_obj, "orderStatus", None), "status", "") or ""
            if _status == "Filled":
                _fill_confirmed = True
                break
            await asyncio.sleep(0.5)

    if _fill_confirmed:
        if isinstance(order_info, dict):
            order_info["fell_back_to_market"] = False
        return order_info

    # ── Cancel limit order ────────────────────────────────────────────────
    if _trade_obj is not None:
        await cancel_order(_trade_obj)

    # ── Re-validate before market fallback ────────────────────────────────
    if pre_fallback_check is not None:
        still_valid = await pre_fallback_check()
        if not still_valid:
            log_event_fn(
                "limit_order_fallback_aborted",
                f"Limit order not filled within {int(timeout_secs)}s — signal no longer valid, skipping market fallback.",
                **log_kwargs,
                limit_price=limit_px,
            )
            return None

    log_event_fn(
        "limit_order_timeout",
        f"Limit order not filled within {int(timeout_secs)}s — falling back to market order.",
        **log_kwargs,
        limit_price=limit_px,
    )
    fallback_info = await place_option_order(**order_kwargs, limit_price=None)
    if isinstance(fallback_info, dict):
        fallback_info["fell_back_to_market"] = True
    return fallback_info


@dataclass
class Position:
    symbol: str
    expiration: str
    strike: float
    right: str
    entry_price: float
    target_price: float
    quantity: int
    strategy_id: str
    signal_id: str
    position_id: str
    open_ts: int = 0
    high_water_mark: float = 0.0  # Track peak premium for trailing stop
    mode: str = ""  # "paper" or "live" — set at open time


@dataclass
class AutoTrader:
    interval_seconds: int = 60
    tp_check_interval_seconds: int = 15
    _task: Optional[asyncio.Task] = None
    _tp_task: Optional[asyncio.Task] = None
    _stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    _last_run_at: Optional[int] = None
    _current_symbol: Optional[str] = None
    _current_stage: Optional[str] = None
    _current_strategy: Optional[str] = None
    _current_started_at: Optional[int] = None
    _last_symbol: Optional[str] = None
    _current_index: Optional[int] = None
    _current_total: Optional[int] = None
    _in_flight_symbols: set = field(default_factory=set)
    _events: deque = field(default_factory=lambda: deque(maxlen=2000))
    _bars_cache: OrderedDict = field(default_factory=OrderedDict)
    _last_scan: Dict[str, int] = field(default_factory=dict)
    _seen_signals: set = field(default_factory=set)
    _signal_first_seen: Dict[str, int] = field(default_factory=dict)
    _trades_per_day: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    _open_positions: Dict[str, Position] = field(default_factory=dict)
    _optimal_ranges: Dict[str, Dict[str, float]] = field(default_factory=dict)
    _optimal_ranges_0dte: Dict[str, Dict[str, float]] = field(default_factory=dict)
    _tracked_orders: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    # Tracks cumulative capital deployed today so closed-position gains
    # cannot be recycled to open new positions once the limit is reached.
    _capital_spent_today: Dict[str, Any] = field(default_factory=dict)
    # Per-symbol scan results for the current cycle
    _scan_cycle_results: Dict[str, Dict] = field(default_factory=dict)
    # Pending close orders keyed by signal_id → (Trade object, submit_timestamp)
    _pending_closes: Dict[str, Any] = field(default_factory=dict)
    # Daily realized loss cache: {"day_key": str, "total": float}
    _daily_realized_loss_cache: Dict[str, Any] = field(default_factory=dict)
    # Chop filter block tracking per symbol: {symbol: {"count": int, "first_ts": int}}
    _chop_block_tracker: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # GEX levels cache: {"symbol": {levels_dict}, "ts": timestamp}
    _gex_cache: Dict[str, Any] = field(default_factory=dict)
    _gex_last_refresh: float = 0

    async def start(self) -> None:
        if self._task:
            return
        self._stop_event.clear()
        archive_and_clear_events()
        self._events.clear()
        self._hydrate_from_log()
        self._task = asyncio.create_task(self._run_loop())
        self._tp_task = asyncio.create_task(self._tp_run_loop())
        self._log_event("worker_start", "Auto trader started.")
        logger.info("Auto trader started.")

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        for t in (self._task, self._tp_task):
            if t:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        self._task = None
        self._tp_task = None
        self._scan_cycle_results = {}
        self._in_flight_symbols.clear()
        self._log_event("worker_stop", "Auto trader stopped.")
        logger.info("Auto trader stopped.")

    def status(self) -> Dict[str, Any]:
        settings_data = get_auto_trader_settings()
        running = self._task is not None and not self._task.done()
        next_run_at = None
        if running and self._last_run_at:
            next_run_at = self._last_run_at + self.interval_seconds
        trading_mode = "paper" if settings.IB_PORT in {4002, 7497} else "live"
        return {
            "running": running,
            "interval_seconds": settings_data.get("intervalSeconds", self.interval_seconds),
            "rth_only": settings_data.get("rthOnly", settings.AUTO_TRADE_RTH_ONLY),
            "last_run_at": self._last_run_at,
            "next_run_at": next_run_at,
            "current_symbol": self._current_symbol,
            "in_flight_symbols": sorted(self._in_flight_symbols),
            "current_stage": self._current_stage,
            "current_strategy": self._current_strategy,
            "current_started_at": self._current_started_at,
            "last_symbol": self._last_symbol,
            "current_index": self._current_index,
            "current_total": self._current_total,
            "trading_mode": trading_mode,
            "capital_spent": self._capital_spent_today.get("total", 0.0),
            "daily_realized_loss": self._daily_realized_loss(),
            "scan_results": dict(self._scan_cycle_results),
        }

    # ------------------------------------------------------------------
    # LRU bars cache helpers
    # ------------------------------------------------------------------

    def _cache_get(self, symbol: str) -> Optional[Dict[str, Any]]:
        if symbol in self._bars_cache:
            self._bars_cache.move_to_end(symbol)
            return self._bars_cache[symbol]
        return None

    def _cache_set(self, symbol: str, data: Dict[str, Any]) -> None:
        self._bars_cache[symbol] = data
        self._bars_cache.move_to_end(symbol)
        while len(self._bars_cache) > _BARS_CACHE_MAX:
            self._bars_cache.popitem(last=False)

    def events(self, limit: int = 2000) -> List[Dict[str, Any]]:
        return list(self._events)[-limit:]

    def _log_event(self, event_type: str, message: str, **details: Any) -> None:
        entry = {
            "timestamp": int(time.time()),
            "type": event_type,
            "message": message,
        }
        if details:
            entry["details"] = details
        self._events.append(entry)
        append_event(entry)

    def _log_signal_skip(
        self,
        reason_code: str,
        message: str,
        *,
        signal: StrategySignal,
        symbol: str,
        stage: Optional[str] = None,
        **details: Any,
    ) -> None:
        payload = {
            "reason_code": reason_code,
            "symbol": symbol,
            "signal_id": signal.id,
            "strategy_id": signal.strategy_id,
            "direction": signal.direction,
            "entry_time": signal.entry_time,
            "stage": stage or self._current_stage,
        }
        payload.update(details)
        self._log_event("signal_skipped", message, **payload)

    def _log_signal_stage(
        self,
        stage: str,
        *,
        signals: List[StrategySignal],
        symbol: str,
        **details: Any,
    ) -> None:
        for signal in signals:
            payload = {
                "symbol": symbol,
                "signal_id": signal.id,
                "strategy_id": signal.strategy_id,
                "direction": signal.direction,
                "entry_time": signal.entry_time,
                "stage": stage,
            }
            payload.update(details)
            self._log_event("signal_stage", f"Stage: {stage.replace('_', ' ')}.", **payload)

    def _log_signal_error(
        self,
        error: str,
        *,
        signals: List[StrategySignal],
        symbol: str,
        stage: Optional[str] = None,
        **details: Any,
    ) -> None:
        for signal in signals:
            payload = {
                "symbol": symbol,
                "signal_id": signal.id,
                "strategy_id": signal.strategy_id,
                "direction": signal.direction,
                "entry_time": signal.entry_time,
                "stage": stage or self._current_stage,
                "error": error,
            }
            payload.update(details)
            self._log_event("signal_error", "Signal processing failed.", **payload)

    def _attach_trade_status(self, trade, meta: Dict[str, Any]) -> None:
        try:
            def _on_status(tr: object) -> None:
                try:
                    order_status = getattr(tr, "orderStatus", None)
                    status = getattr(order_status, "status", None)
                    filled = getattr(order_status, "filled", None)
                    remaining = getattr(order_status, "remaining", None)
                    avg_fill_price = getattr(order_status, "avgFillPrice", None)
                    self._log_event(
                        "order_status",
                        "Order status update.",
                        status=status,
                        filled=filled,
                        remaining=remaining,
                        avg_fill_price=avg_fill_price,
                        **meta,
                    )
                except Exception as exc:
                    logger.warning("Order status handler failed: %s", exc)

            trade.orderStatusEvent += _on_status
            self._tracked_orders[trade.order.orderId] = {
                "trade": trade,
                "meta": meta,
                "callback": _on_status,
            }
        except Exception as exc:
            logger.warning("Failed to attach order status listener: %s", exc)

    def flush_position(self, position_id: str, close_price: float | None = None) -> bool:
        """Remove a tracked open position and write a synthetic CLOSE log entry.

        Used when a position was closed outside the auto-trader (e.g. manually
        via the dashboard) so the auto-trader stops trying to manage it.
        If the position is no longer in memory (e.g. after a restart or
        clear_trade_state), falls back to reading the OPEN log entry directly.
        Returns True if flushed successfully, False if position_id not found anywhere.

        When *close_price* is provided the CLOSE entry records the actual sell
        premium and computed P&L instead of zeros.
        """
        position = self._open_positions.pop(position_id, None)
        if position is not None:
            entry_data = {
                "symbol": position.symbol,
                "action": "SELL",
                "right": position.right,
                "expiration": position.expiration,
                "strike": position.strike,
                "quantity": position.quantity,
                "price": position.entry_price,
                "strategy_id": position.strategy_id,
                "signal_id": position.signal_id,
                "entry_price": position.entry_price,
                "target_price": position.target_price,
            }
        else:
            # Not in memory — look for the OPEN log entry as fallback
            entries = read_entries(limit=2000)
            open_entry = next(
                (e for e in entries if e.get("position_id") == position_id and e.get("type") == "OPEN"),
                None,
            )
            if open_entry is None:
                return False
            entry_data = {
                "symbol": open_entry["symbol"],
                "action": "SELL",
                "right": open_entry.get("right"),
                "expiration": open_entry.get("expiration"),
                "strike": open_entry.get("strike"),
                "quantity": open_entry.get("quantity"),
                "price": open_entry.get("entry_price", 0),
                "strategy_id": open_entry.get("strategy_id"),
                "signal_id": open_entry.get("signal_id"),
                "entry_price": open_entry.get("entry_price"),
                "target_price": open_entry.get("target_price"),
            }

        # Compute P&L when close_price is provided (manual sell with known price)
        entry_price = entry_data.get("entry_price") or entry_data.get("price", 0)
        if close_price is not None and entry_price:
            pnl = (close_price - entry_price) * (entry_data.get("quantity", 1)) * 100
            pnl_pct = (close_price - entry_price) / entry_price
            sell_price = close_price
            status = "manually_closed"
        else:
            pnl = 0.0
            pnl_pct = 0.0
            sell_price = entry_price
            status = "manually_flushed"

        close_reason = "Manual close" if close_price is not None else "Manual flush"
        # Use the mode from the position (open time), not current gateway mode
        pos_mode = (position.mode if position else None) or (open_entry.get("mode") if not position and open_entry else None)
        append_entry(
            {
                **entry_data,
                "price": sell_price,
                "timestamp": int(time.time()),
                "status": status,
                "position_id": position_id,
                "type": "CLOSE",
                "mode": pos_mode or ib_manager.active_mode,
                "fill_confirmed": close_price is not None,
                "pnl": round(pnl, 2),
                "pnl_pct": round(pnl_pct, 2),
                "close_reason": close_reason,
            }
        )
        event_label = "position_manually_closed" if close_price is not None else "position_flushed"
        event_msg = (
            f"Position manually closed at {close_price:.2f} (P&L: {pnl:+.2f} / {pnl_pct * 100:+.1f}%)"
            if close_price is not None
            else "Position manually flushed from tracker."
        )
        self._log_event(
            event_label,
            event_msg,
            symbol=entry_data["symbol"],
            position_id=position_id,
        )
        return True

    def clear_trade_state(self) -> None:
        self._open_positions.clear()
        self._seen_signals.clear()
        self._signal_first_seen.clear()
        self._trades_per_day.clear()

    def _hydrate_from_log(self) -> None:
        entries = read_entries(limit=1000)
        current_mode = ib_manager.active_mode  # "paper" or "live"
        for entry in entries:
            signal_id = entry.get("signal_id")
            if signal_id and entry.get("mode", current_mode) == current_mode:
                self._seen_signals.add(signal_id)
        # Only hydrate positions from the current trading mode
        mode_entries = [e for e in entries if e.get("mode", current_mode) == current_mode]
        open_positions_from_log = build_open_positions(mode_entries)
        logger.info(f"Hydrating: found {len(open_positions_from_log)} open positions in trade log")
        for entry in open_positions_from_log:
            try:
                pos = Position(
                    symbol=entry["symbol"],
                    expiration=entry["expiration"],
                    strike=float(entry["strike"]),
                    right=entry["right"],
                    entry_price=float(entry["entry_price"]),
                    target_price=float(entry["target_price"]),
                    quantity=int(entry["quantity"]),
                    strategy_id=entry.get("strategy_id") or "",
                    signal_id=entry.get("signal_id") or "",
                    position_id=entry.get("position_id") or "",
                    high_water_mark=float(entry.get("high_water_mark", 0.0)),
                    mode=entry.get("mode") or current_mode,
                )
                self._open_positions[pos.position_id] = pos
            except Exception as exc:
                logger.error(f"Failed to hydrate position {entry.get('position_id')}: {exc}")
                continue
        logger.info(f"Hydration complete: loaded {len(self._open_positions)} {current_mode} positions into memory")
        # Restore today's cumulative capital spent so the limit is not
        # bypassed after a restart.
        today_key = get_ny_day_key(int(time.time()))
        total_spent = 0.0
        for entry in entries:
            if entry.get("action") == "BUY" and entry.get("type") == "OPEN":
                ts = entry.get("timestamp", 0)
                if ts and get_ny_day_key(ts) == today_key:
                    total_spent += float(entry.get("price", 0) or 0) * 100 * int(entry.get("quantity", 1) or 1)
        self._capital_spent_today = {"day_key": today_key, "total": total_spent}

    def _hydrate_events(self) -> None:
        for entry in read_events(limit=self._events.maxlen):
            self._events.append(entry)

    async def _run_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                start = time.time()
                try:
                    settings_data = get_auto_trader_settings()
                    interval_seconds = int(
                        settings_data.get("intervalSeconds", self.interval_seconds)
                    )
                    rth_only = bool(
                        settings_data.get("rthOnly", settings.AUTO_TRADE_RTH_ONLY)
                    )
                    self._last_run_at = int(start)
                    if rth_only and not is_rth_now():
                        self._log_event(
                            "scan_skipped",
                            "Scan skipped: outside RTH window.",
                            reason="outside_rth",
                            rth_only=rth_only,
                        )
                        await asyncio.wait_for(
                            self._stop_event.wait(), timeout=interval_seconds
                        )
                        continue
                    self._log_event("scan_start", "Scan started.")
                    await self._scan_once()
                    duration_ms = int((time.time() - start) * 1000)
                    self._log_event(
                        "scan_complete",
                        f"Scan completed in {duration_ms / 1000:.1f}s.",
                        duration_ms=duration_ms,
                    )
                except Exception as exc:
                    logger.error(f"Auto trader scan failed: {exc}")
                elapsed = time.time() - start
                sleep_for = max(1, interval_seconds - int(elapsed))
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_for)
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            return

    async def _tp_run_loop(self) -> None:
        """Dedicated loop that checks open positions for take-profit hits."""
        try:
            while not self._stop_event.is_set():
                start = time.time()
                try:
                    settings_data = get_auto_trader_settings()
                    tp_interval = int(
                        settings_data.get("tpCheckIntervalSeconds", self.tp_check_interval_seconds)
                    )
                    rth_only = bool(
                        settings_data.get("rthOnly", settings.AUTO_TRADE_RTH_ONLY)
                    )
                    is_rth = is_rth_now()
                    should_check = not (rth_only and not is_rth)
                    logger.info(f"TP loop: rth_only={rth_only}, is_rth={is_rth}, should_check={should_check}")
                    if should_check:
                        await self._check_open_positions()
                    else:
                        logger.info("TP loop: skipping check - outside RTH")
                except Exception as exc:
                    logger.error(f"TP check loop failed: {exc}")
                elapsed = time.time() - start
                sleep_for = max(1, tp_interval - int(elapsed))
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_for)
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            return

    def reset_capital_spent(self) -> None:
        """Manually reset the cumulative capital-spent counter."""
        self._capital_spent_today = {"day_key": get_ny_day_key(int(time.time())), "total": 0.0}
        self._log_event("capital_reset", "Capital spent counter reset manually.")

    def _daily_realized_loss(self) -> float:
        """Sum of negative P&L from today's CLOSE entries (cached per day key)."""
        today_key = get_ny_day_key(int(time.time()))
        cached = self._daily_realized_loss_cache
        if cached.get("day_key") == today_key:
            return cached.get("total", 0.0)
        entries = read_entries(limit=5000)
        total_loss = 0.0
        for entry in entries:
            if entry.get("type") != "CLOSE":
                continue
            ts = entry.get("timestamp", 0)
            if ts and get_ny_day_key(ts) == today_key:
                pnl = float(entry.get("pnl", 0) or 0)
                if pnl < 0:
                    total_loss += pnl  # negative number
        self._daily_realized_loss_cache = {"day_key": today_key, "total": total_loss}
        return total_loss

    def _invalidate_daily_loss_cache(self) -> None:
        """Clear cache so next call to _daily_realized_loss re-reads the log."""
        self._daily_realized_loss_cache = {}

    async def _scan_once(self) -> None:
        now = int(time.time())
        today_key = get_ny_day_key(now)
        # Reload optimal ranges from settings at start of each scan
        self._optimal_ranges, self._optimal_ranges_0dte = load_optimal_ranges()
        settings_data = get_auto_trader_settings()
        symbols = SYMBOLS
        if settings_data.get("onlyFavorites", False):
            favorites = get_favorites()
            if favorites:
                symbols = favorites
        # Filter out tickers explicitly disabled in tickerSettings
        _ticker_settings = settings_data.get("tickerSettings", {})
        if _ticker_settings:
            symbols = [
                s for s in symbols
                if _ticker_settings.get(s, {}).get("enabled", True) is not False
            ]
        total = len(symbols)
        self._current_total = total
        self._scan_cycle_results = {sym: {"status": "pending"} for sym in symbols}
        concurrency = max(1, int(settings.IB_CLIENT_POOL_SIZE))
        sem = asyncio.Semaphore(concurrency)

        async def run_symbol(symbol: str, idx: int) -> None:
            async with sem:
                # Yield before each symbol so HTTP handlers can be served
                # even when the semaphore bottleneck keeps only one symbol
                # active at a time.
                await asyncio.sleep(0)
                try:
                    self._current_index = idx
                    self._in_flight_symbols.add(symbol)
                    self._scan_cycle_results[symbol] = {"status": "scanning"}
                    await self._process_symbol(symbol, now, today_key)
                    # If still "scanning" after processing, no signal was found
                    if self._scan_cycle_results.get(symbol, {}).get("status") == "scanning":
                        self._scan_cycle_results[symbol] = {"status": "no_signal"}
                except Exception as exc:
                    logger.error(f"Auto trader failed for {symbol}: {exc}")
                    self._scan_cycle_results[symbol] = {"status": "error"}
                    self._log_event(
                        "scan_error",
                        "Auto trader failed for symbol.",
                        symbol=symbol,
                        error=str(exc),
                    )
                finally:
                    self._in_flight_symbols.discard(symbol)

        # Two-phase scan during priority window (09:30-09:47 ET):
        # Phase 1: scan 0DTE-exclusive tickers first (e.g. SPX with enabledStrategies=[7,8,9,10,14])
        # Phase 2: scan everything else
        # Outside this window: single-phase scan (all symbols concurrent).
        _0dte_ids = {7, 8, 9, 10, 14}
        now_ny = datetime.now(NY_TZ)
        _priority_start = now_ny.replace(hour=9, minute=30, second=0, microsecond=0)
        _priority_end = now_ny.replace(hour=9, minute=47, second=0, microsecond=0)
        _in_priority_window = _priority_start <= now_ny <= _priority_end

        priority_symbols = []
        regular_symbols = []
        if _in_priority_window:
            for s in symbols:
                _tcfg = settings_data.get("tickerSettings", {}).get(s, {})
                _es = _tcfg.get("enabledStrategies")
                if _es and set(_es).issubset(_0dte_ids):
                    priority_symbols.append(s)
                else:
                    regular_symbols.append(s)

        if priority_symbols:
            self._log_event(
                "priority_scan_start",
                f"Priority scan: {len(priority_symbols)} 0DTE tickers first.",
                tickers=priority_symbols,
            )
            await asyncio.gather(
                *(run_symbol(s, i + 1) for i, s in enumerate(priority_symbols))
            )
            offset = len(priority_symbols)
            await asyncio.gather(
                *(run_symbol(s, offset + i + 1) for i, s in enumerate(regular_symbols))
            )
        else:
            await asyncio.gather(
                *(run_symbol(symbol, idx + 1) for idx, symbol in enumerate(symbols))
            )
        self._current_symbol = None
        self._current_stage = None
        self._current_strategy = None
        self._current_started_at = None
        self._current_index = None
        self._current_total = None
        self._in_flight_symbols.clear()

        # Take-profit checks run in a separate loop (_tp_run_loop); not called here.

        # Log market context snapshot using SPY bars from cache (if available)
        spy_cache = self._cache_get("SPY")
        spy_price: Optional[float] = None
        spy_direction: Optional[str] = None
        if spy_cache and spy_cache.get("bars1m"):
            bars1m = spy_cache["bars1m"]
            if len(bars1m) >= 2:
                last_close = bars1m[-1]["close"]
                prev_close = bars1m[-2]["close"]
                spy_price = round(last_close, 2)
                diff = last_close - prev_close
                spy_direction = "up" if diff > 0.01 else ("down" if diff < -0.01 else "flat")
            elif len(bars1m) == 1:
                spy_price = round(bars1m[-1]["close"], 2)
        self._log_event(
            "scan_context",
            "Market context snapshot.",
            spy_price=spy_price,
            spy_direction=spy_direction,
            open_positions=len(self._open_positions),
            symbols_scanned=total,
        )

    async def _process_symbol(self, symbol: str, now: int, today_key: str) -> None:
        self._current_symbol = symbol
        self._current_strategy = "all"
        self._current_stage = "loading"
        self._current_started_at = now
        recent_signals: List[StrategySignal] = []
        try:
            settings_data = get_auto_trader_settings()
            effective_settings = get_symbol_settings(symbol)
            trade_state = self._trades_per_day.get(symbol)
            if not trade_state or trade_state.get("day_key") != today_key:
                self._trades_per_day[symbol] = {"day_key": today_key, "count": 0}
            max_trades = int(effective_settings.get("maxTradesPerDay", 2))
            if self._trades_per_day[symbol]["count"] >= max_trades:
                self._log_event(
                    "skip_max_trades",
                    "Skipped: max trades reached for today.",
                    symbol=symbol,
                    max=max_trades,
                    count=self._trades_per_day[symbol]["count"],
                    day_key=today_key,
                )
                self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "max_trades"}
                return

            # One position per symbol guard
            if effective_settings.get("onePositionPerSymbol", False):
                has_open = any(p.symbol == symbol for p in self._open_positions.values())
                if has_open:
                    self._log_event(
                        "skip_one_position_per_symbol",
                        "Skipped: already has an open position for this symbol.",
                        symbol=symbol,
                    )
                    self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "one_position_per_symbol"}
                    return

            # Max daily loss limit guard
            max_daily_loss = float(settings_data.get("maxDailyLossDollar", 0))
            if max_daily_loss > 0:
                daily_loss = self._daily_realized_loss()  # negative number
                if abs(daily_loss) >= max_daily_loss:
                    self._log_event(
                        "skip_daily_loss_limit",
                        f"Skipped: daily realized loss ${abs(daily_loss):.2f} exceeds limit ${max_daily_loss:.2f}.",
                        symbol=symbol,
                        daily_loss=daily_loss,
                        limit=max_daily_loss,
                    )
                    self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "daily_loss_limit"}
                    return

            overrides = get_settings(symbol)
            strategy_overrides = settings_data.get("strategySettings", {})
            settings_override = merge_strategy_settings(overrides or {}, strategy_overrides)
            warmup = settings_override["global"]

            cache = self._cache_get(symbol)
            if not cache:
                # ── Cold start: try disk cache first ─────────────────────────
                _loop = asyncio.get_event_loop()
                disk1m, disk5m, disk15m, disk1h, disk1d = await asyncio.gather(
                    _loop.run_in_executor(None, _load_bars_from_disk, symbol, "1m"),
                    _loop.run_in_executor(None, _load_bars_from_disk, symbol, "5m"),
                    _loop.run_in_executor(None, _load_bars_from_disk, symbol, "15m"),
                    _loop.run_in_executor(None, _load_bars_from_disk, symbol, "1h"),
                    _loop.run_in_executor(None, _load_bars_from_disk, symbol, "1d"),
                )

                if disk1m and disk5m and disk15m and disk1h and disk1d:
                    # Disk hit: fetch only the missing bars since last stored timestamp
                    self._current_stage = "fetching_bars_delta"
                    n1m  = _delta_bar_count(disk1m,  "1m",  warmup["minBars1m"])
                    n5m  = _delta_bar_count(disk5m,  "5m",  warmup.get("minBars5m", 600))
                    n15m = _delta_bar_count(disk15m, "15m", warmup["minBars15m"])
                    n1h  = _delta_bar_count(disk1h,  "1h",  warmup["minBars1h"])
                    n1d  = _delta_bar_count(disk1d,  "1d",  warmup["minBars1d"])
                    logger.info(
                        "Disk cache hit for %s — fetching delta: 1m=%d 5m=%d 15m=%d 1h=%d 1d=%d",
                        symbol, n1m, n5m, n15m, n1h, n1d,
                    )
                    data1m, data5m, data15m, data1h, data1d = await asyncio.gather(
                        get_historical_bars(symbol, "1m",  n1m,  use_rth=True),
                        get_historical_bars(symbol, "5m",  n5m,  use_rth=True),
                        get_historical_bars(symbol, "15m", n15m, use_rth=True),
                        get_historical_bars(symbol, "1h",  n1h,  use_rth=True),
                        get_historical_bars(symbol, "1d",  n1d,  use_rth=True),
                    )
                    merged1m  = merge_bars(disk1m,  data1m,  warmup["minBars1m"])
                    merged5m  = merge_bars(disk5m,  data5m,  warmup.get("minBars5m", 600))
                    merged15m = merge_bars(disk15m, data15m, warmup["minBars15m"])
                    merged1h  = merge_bars(disk1h,  data1h,  warmup["minBars1h"])
                    merged1d  = merge_bars(disk1d,  data1d,  warmup["minBars1d"])
                else:
                    # Full cold fetch (no disk data yet)
                    self._current_stage = "fetching_bars"
                    logger.info("No disk cache for %s — fetching full warmup history.", symbol)
                    data1m, data5m, data15m, data1h, data1d = await asyncio.gather(
                        get_historical_bars(symbol, "1m",  warmup["minBars1m"],  use_rth=True),
                        get_historical_bars(symbol, "5m",  warmup.get("minBars5m", 600), use_rth=True),
                        get_historical_bars(symbol, "15m", warmup["minBars15m"], use_rth=True),
                        get_historical_bars(symbol, "1h",  warmup["minBars1h"],  use_rth=True),
                        get_historical_bars(symbol, "1d",  warmup["minBars1d"],  use_rth=True),
                    )
                    merged1m, merged5m, merged15m, merged1h, merged1d = data1m, data5m, data15m, data1h, data1d

                self._cache_set(symbol, {
                    "bars1m": merged1m, "bars5m": merged5m, "bars15m": merged15m,
                    "bars1h": merged1h, "bars1d": merged1d,
                })
                await asyncio.gather(
                    _save_bars_to_disk_async(symbol, "1m",  merged1m),
                    _save_bars_to_disk_async(symbol, "5m",  merged5m),
                    _save_bars_to_disk_async(symbol, "15m", merged15m),
                    _save_bars_to_disk_async(symbol, "1h",  merged1h),
                    _save_bars_to_disk_async(symbol, "1d",  merged1d),
                )
            else:
                # ── Incremental refresh (in-memory cache hit) ─────────────────
                self._current_stage = "refreshing_bars"
                data1m, data5m, data15m, data1h, data1d = await asyncio.gather(
                    get_historical_bars(symbol, "1m",  5, use_rth=True),
                    get_historical_bars(symbol, "5m",  5, use_rth=True),
                    get_historical_bars(symbol, "15m", 5, use_rth=True),
                    get_historical_bars(symbol, "1h",  3, use_rth=True),
                    get_historical_bars(symbol, "1d",  2, use_rth=True),
                )
                cache["bars1m"]  = merge_bars(cache["bars1m"],  data1m,  warmup["minBars1m"])
                cache["bars5m"]  = merge_bars(cache.get("bars5m", []), data5m, warmup.get("minBars5m", 600))
                cache["bars15m"] = merge_bars(cache["bars15m"], data15m, warmup["minBars15m"])
                cache["bars1h"]  = merge_bars(cache["bars1h"],  data1h,  warmup["minBars1h"])
                cache["bars1d"]  = merge_bars(cache["bars1d"],  data1d,  warmup["minBars1d"])
                self._cache_set(symbol, cache)
                await asyncio.gather(
                    _save_bars_to_disk_async(symbol, "1m",  cache["bars1m"]),
                    _save_bars_to_disk_async(symbol, "5m",  cache["bars5m"]),
                    _save_bars_to_disk_async(symbol, "15m", cache["bars15m"]),
                    _save_bars_to_disk_async(symbol, "1h",  cache["bars1h"]),
                    _save_bars_to_disk_async(symbol, "1d",  cache["bars1d"]),
                )

            cache = self._bars_cache[symbol]
            # Use market open (9:30 AM ET) as start of range so we never miss a
            # signal. The _seen_signals set prevents acting on duplicates.
            _today_ny = datetime.fromtimestamp(now, NY_TZ)
            _market_open = datetime(
                _today_ny.year, _today_ny.month, _today_ny.day,
                9, 30, tzinfo=NY_TZ,
            )
            visible_range = {"from": int(_market_open.timestamp()), "to": now}
            self._current_stage = "analyzing"

            # Keep 1h and 1d bars intact (including the current incomplete bar) because
            # multi-TF strategies use them as anchors/setups. Stripping the current 1h bar
            # makes the auto trader blind to any setup forming in the current hour.
            # Only strip the last bar from lower timeframes (15m, 5m, 1m) used for
            # confirmation — this prevents premature signals on still-forming bars.
            bars1h_closed = cache["bars1h"]
            bars15m_closed = cache["bars15m"][:-1] if len(cache["bars15m"]) > 1 else cache["bars15m"]
            bars5m_closed = cache.get("bars5m", [])[:-1] if len(cache.get("bars5m", [])) > 1 else cache.get("bars5m", [])
            bars1d_closed = cache["bars1d"]
            bars1m_closed = cache["bars1m"][:-1] if len(cache["bars1m"]) > 1 else cache["bars1m"]

            # ── ADX Chop Filter ──────────────────────────────────────
            # S13 (Opening Direction) has its own confirmation logic and bypasses the chop filter
            _chop_exempt_active = (
                settings_override.get("strategy13", {}).get("enabled", False)
                or (settings_data.get("tickerSettings", {}).get(symbol, {}).get("enabledStrategies") and
                    13 in settings_data["tickerSettings"][symbol]["enabledStrategies"])
            )
            _chop_blocked = False
            if effective_settings.get("chopFilterEnabled", True):
                _adx_threshold = float(effective_settings.get("chopFilterAdxThreshold", 20))
                _adx_tf = effective_settings.get("chopFilterTimeframe", "15m")
                _di_gap_threshold = float(effective_settings.get("chopFilterDiGap", 10))
                _adx_bars = {
                    "1m": bars1m_closed, "5m": bars5m_closed, "15m": bars15m_closed,
                    "1h": bars1h_closed, "1d": bars1d_closed,
                }.get(_adx_tf, bars15m_closed)
                _adx_value, _plus_di, _minus_di = _compute_adx(_adx_bars)
                _di_gap = abs(_plus_di - _minus_di) if _plus_di is not None else None
                if _adx_value is not None and _adx_value < _adx_threshold:
                    _chop_msg = f"ADX({_adx_tf})={_adx_value:.1f} < {_adx_threshold} (choppy market)"
                    if _chop_exempt_active:
                        _chop_msg = f"Chop detected for {symbol}: {_chop_msg} — S10/S11 blocked, S13 exempt."
                    else:
                        _chop_msg = f"Skipped {symbol}: {_chop_msg}."
                    self._log_event(
                        "adx_chop_filter",
                        _chop_msg,
                        symbol=symbol,
                        adx_value=round(_adx_value, 2),
                        adx_threshold=_adx_threshold,
                        adx_timeframe=_adx_tf,
                        plus_di=round(_plus_di, 2) if _plus_di is not None else None,
                        minus_di=round(_minus_di, 2) if _minus_di is not None else None,
                        di_gap=round(_di_gap, 2) if _di_gap is not None else None,
                    )
                    self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "adx_chop_filter"}
                    _bt = self._chop_block_tracker.setdefault(symbol, {"count": 0, "first_ts": 0})
                    if _bt["count"] == 0:
                        _bt["first_ts"] = int(time.time())
                    _bt["count"] += 1
                    _chop_blocked = True
                    if not _chop_exempt_active:
                        return
                if _di_gap is not None and _di_gap_threshold > 0 and _di_gap < _di_gap_threshold:
                    _chop_msg2 = f"DI gap={_di_gap:.1f} < {_di_gap_threshold} (+DI={_plus_di:.1f}, -DI={_minus_di:.1f}, ADX={_adx_value:.1f})"
                    if _chop_exempt_active:
                        _chop_msg2 = f"Chop detected for {symbol}: {_chop_msg2} — S10/S11 blocked, S13 exempt."
                    else:
                        _chop_msg2 = f"Skipped {symbol}: {_chop_msg2} — no directional conviction."
                    self._log_event(
                        "di_gap_chop_filter",
                        _chop_msg2,
                        symbol=symbol,
                        adx_value=round(_adx_value, 2),
                        plus_di=round(_plus_di, 2),
                        minus_di=round(_minus_di, 2),
                        di_gap=round(_di_gap, 2),
                        di_gap_threshold=_di_gap_threshold,
                        adx_timeframe=_adx_tf,
                    )
                    self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "di_gap_chop_filter"}
                    _bt = self._chop_block_tracker.setdefault(symbol, {"count": 0, "first_ts": 0})
                    if _bt["count"] == 0:
                        _bt["first_ts"] = int(time.time())
                    _bt["count"] += 1
                    _chop_blocked = True
                    if not _chop_exempt_active:
                        return

            # enabledStrategies filtering: only run specified strategies for this ticker
            _ticker_cfg = settings_data.get("tickerSettings", {}).get(symbol, {})
            _enabled_list = _ticker_cfg.get("enabledStrategies")
            _enabled_set = set(_enabled_list) if _enabled_list else None

            signals = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: analyze_with_bars(
                    symbol,
                    visible_range,
                    bars1h_closed,
                    bars15m_closed,
                    bars1d_closed,
                    bars1m_closed,
                    settings_override,
                    bars5m_closed,
                    bars15m_open=cache["bars15m"],
                    enabled_strategies=_enabled_set,
                ),
            )

            # Hard age filter — reject signals whose entry_time is too old (absolute, not overridable).
            # This prevents stale signals from re-entering after a server restart clears _seen_signals.
            _hard_max_age = int(effective_settings.get("signalMaxAgeSecs", 0))
            _now_ts = int(time.time())
            recent_signals = [
                signal
                for signal in signals
                if signal.entry_time >= visible_range["from"]
                and signal.entry_time <= now
                and signal.id not in self._seen_signals
                and (_hard_max_age <= 0 or (_now_ts - signal.entry_time) <= _hard_max_age * 2)
            ]

            # If chop filter blocked, remove non-exempt signals (S10/S11 from analyze_with_bars)
            if _chop_blocked:
                recent_signals = []

            # ── Strategy 12: GEX Mean Reversion ─────────────────────────
            _s12_enabled = settings_override.get("strategy12", {}).get("enabled", False) or (_enabled_set is not None and 12 in _enabled_set)
            if _s12_enabled:
                try:
                    # Refresh GEX levels every 5 minutes
                    _gex_refresh_interval = float(settings_override.get("strategy12", {}).get("gexRefreshMinutes", 5)) * 60
                    if time.time() - self._gex_last_refresh > _gex_refresh_interval:
                        from app.services.gex_analysis import compute_gex
                        _gex_data = await compute_gex(symbol="SPX", dte_filter="0dte", strike_range=100)
                        if not _gex_data.get("error"):
                            self._gex_cache = _gex_data
                            self._gex_last_refresh = time.time()
                            self._log_event("gex_refresh", f"GEX levels refreshed: zero_gamma={_gex_data.get('zero_gamma')}, regime={_gex_data.get('regime')}, {len(_gex_data.get('long_gamma_nodes',[]))} LGN nodes",
                                            zero_gamma=_gex_data.get("zero_gamma"), regime=_gex_data.get("regime"))

                    if self._gex_cache and not self._gex_cache.get("error"):
                        from app.services.strategy12_gex import detect_gex_signals
                        # Convert GEX levels from SPX to SPY scale
                        _spy_gex = {**self._gex_cache}
                        if _spy_gex.get("spot", 0) > 1000:  # SPX scale → SPY scale
                            _spy_gex["spot"] = _spy_gex["spot"] / 10
                            for n in _spy_gex.get("long_gamma_nodes", []):
                                n["strike"] = n["strike"] / 10
                                n["distance"] = n["distance"] / 10
                            for n in _spy_gex.get("short_gamma_nodes", []):
                                n["strike"] = n["strike"] / 10
                                n["distance"] = n["distance"] / 10
                            if _spy_gex.get("zero_gamma"):
                                _spy_gex["zero_gamma"] = _spy_gex["zero_gamma"] / 10
                            if _spy_gex.get("call_wall"):
                                _spy_gex["call_wall"]["strike"] = _spy_gex["call_wall"]["strike"] / 10
                            if _spy_gex.get("put_wall"):
                                _spy_gex["put_wall"]["strike"] = _spy_gex["put_wall"]["strike"] / 10

                        _gex_signals = detect_gex_signals(
                            symbol=symbol,
                            bars_1m=cache.get("bars1m", []),
                            gex_levels=_spy_gex,
                            settings=settings_override,
                        )
                        for gs in _gex_signals:
                            if gs.signal.id not in self._seen_signals:
                                recent_signals.append(gs.signal)
                                self._log_event("s12_signal", f"GEX signal: {gs.signal.direction} at {gs.node_type} node ${gs.node_strike:.2f}",
                                                symbol=symbol, direction=gs.signal.direction,
                                                node_strike=gs.node_strike, node_type=gs.node_type,
                                                tp_target=gs.tp_target, stop_strike=gs.stop_strike,
                                                regime=gs.regime)
                except Exception as exc:
                    logger.warning(f"S12 GEX signal detection failed: {exc}")

            # ── Strategy 14: Gamma Zero (SPX 0DTE) ──────────────────
            _s14_enabled = settings_override.get("strategy14", {}).get("enabled", False) or (_enabled_set is not None and 14 in _enabled_set)
            if _s14_enabled:
                try:
                    # Refresh per strategy14's own gexRefreshMinutes, sourced
                    # via the dispatcher (default: GexBot Classic, IB fallback).
                    _s14_refresh_interval = float(settings_override.get("strategy14", {}).get("gexRefreshMinutes", 10)) * 60
                    if time.time() - self._gex_last_refresh > _s14_refresh_interval:
                        from app.services.gex import get_gex_levels
                        _gex_source = settings_override.get("strategy14", {}).get("gexSource", "gexbot")
                        _gex_data = await get_gex_levels(symbol="SPX", source=_gex_source, fallback=True)
                        if not _gex_data.get("error"):
                            self._gex_cache = _gex_data
                            self._gex_last_refresh = time.time()
                            _src = _gex_data.get("source", _gex_source)
                            _fallback_from = _gex_data.get("source_fallback_from")
                            _src_label = f"{_src}" + (f" (fell back from {_fallback_from})" if _fallback_from else "")
                            self._log_event(
                                "gex_refresh",
                                f"GEX levels refreshed (S14): source={_src_label}, "
                                f"flip={_gex_data.get('gamma_flip',{}).get('strike')}, "
                                f"CW={_gex_data.get('call_wall',{}).get('strike')}, "
                                f"PW={_gex_data.get('put_wall',{}).get('strike')}, regime={_gex_data.get('regime')}",
                                regime=_gex_data.get("regime"),
                                source=_src,
                            )

                    if self._gex_cache and not self._gex_cache.get("error"):
                        from app.services.strategy14_gamma_zero import detect_strategy14_gamma_zero
                        _current_price = cache.get("bars1m", [{}])[-1].get("close", 0.0) if cache.get("bars1m") else 0.0
                        # GEX is computed against SPX strikes (~7000 scale). When S14
                        # trades SPY (~700 scale, the default), divide all strike-bearing
                        # fields by 10 so the detector can compare them to SPY price.
                        _gex_for_s14 = self._gex_cache
                        if symbol.upper() == "SPY" and self._gex_cache.get("spot", 0) > 1000:
                            _gex_for_s14 = {**self._gex_cache, "spot": self._gex_cache["spot"] / 10}
                            for _wall_key in ("call_wall", "put_wall", "gamma_flip"):
                                _w = self._gex_cache.get(_wall_key)
                                if isinstance(_w, dict) and _w.get("strike") is not None:
                                    _gex_for_s14[_wall_key] = {
                                        **_w,
                                        "strike": _w["strike"] / 10,
                                        "distance": (_w.get("distance") or 0) / 10,
                                    }
                        _s14_signals = detect_strategy14_gamma_zero(
                            symbol=symbol,
                            bars1m=cache.get("bars1m", []),
                            bars5m=cache.get("bars5m", []),
                            current_price=_current_price,
                            gex_levels=_gex_for_s14,
                            settings=settings_override,
                        )
                        for gz in _s14_signals:
                            if gz.signal.id not in self._seen_signals:
                                recent_signals.append(gz.signal)
                                self._log_event(
                                    "s14_signal",
                                    f"Gamma Zero: {gz.signal.direction} ({gz.position}) "
                                    f"spot={gz.spot:.2f} CW={gz.call_wall:.2f} PW={gz.put_wall:.2f} regime={gz.regime}",
                                    symbol=symbol,
                                    direction=gz.signal.direction,
                                    position=gz.position,
                                    regime=gz.regime,
                                    call_wall=gz.call_wall,
                                    put_wall=gz.put_wall,
                                    gamma_flip=gz.gamma_flip,
                                )
                except Exception as exc:
                    logger.warning(f"S14 Gamma Zero signal detection failed: {exc}")

            # ── Strategy 13: Opening Direction Confirmation ─────────
            _s13_enabled = settings_override.get("strategy13", {}).get("enabled", False) or (_enabled_set is not None and 13 in _enabled_set)
            if _s13_enabled:
                try:
                    from app.services.strategy13_opening_direction import detect_opening_direction_signals
                    _prev_close = None
                    _1d_bars = cache.get("bars1d", [])
                    if len(_1d_bars) >= 2:
                        _prev_close = _1d_bars[-2]["close"]
                    _s13_signals = detect_opening_direction_signals(
                        symbol=symbol,
                        bars_5m=cache.get("bars5m", []),
                        settings=settings_override,
                        prev_close=_prev_close,
                    )
                    for s13s in _s13_signals:
                        if s13s.signal.id not in self._seen_signals:
                            recent_signals.append(s13s.signal)
                            self._log_event(
                                "s13_signal",
                                f"Opening Direction signal: {s13s.signal.direction} "
                                f"(range ${s13s.range_low:.2f}-${s13s.range_high:.2f}, "
                                f"confirmed {s13s.confirmation_time})",
                                symbol=symbol, direction=s13s.signal.direction,
                                range_high=s13s.range_high, range_low=s13s.range_low,
                                gap=s13s.gap_dollars,
                            )
                except Exception as exc:
                    logger.warning(f"S13 opening direction signal detection failed: {exc}")

            if not recent_signals:
                return
            # Record wall-clock time when each signal is first detected
            _now_ts = int(time.time())
            for _sig in recent_signals:
                if _sig.id not in self._signal_first_seen:
                    self._signal_first_seen[_sig.id] = _now_ts
            self._log_signal_stage("detected", signals=recent_signals, symbol=symbol)
            self._log_event(
                "signals_detected",
                f"Detected {len(recent_signals)} signal(s).",
                symbol=symbol,
                count=len(recent_signals),
                directions=[signal.direction for signal in recent_signals],
                signal_ids=[signal.id for signal in recent_signals],
                strategy_ids=[signal.strategy_id for signal in recent_signals],
            )

            self._current_stage = "earnings_check"
            self._log_signal_stage("earnings_check", signals=recent_signals, symbol=symbol)
            earnings_date = await get_earnings_date(symbol)
            if effective_settings.get("skipEarningsDay", True) and earnings_date == today_key:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "earnings_day",
                        "Skipped: earnings day.",
                        signal=signal,
                        symbol=symbol,
                        earnings_date=earnings_date,
                        today_key=today_key,
                    )
                self._log_event("skip_earnings", "Skipped due to earnings today.", symbol=symbol)
                self._scan_cycle_results[symbol] = {"status": "skipped", "reason": "earnings"}
                return

            self._current_stage = "selecting_contract"
            self._log_signal_stage("selecting_contract", signals=recent_signals, symbol=symbol)
            latest_price = cache["bars1m"][-1]["close"] if cache["bars1m"] else None
            if not latest_price:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "no_latest_price",
                        "Skipped: no latest price.",
                        signal=signal,
                        symbol=symbol,
                    )
                self._log_event("skip_no_price", "Skipped: no latest price.", symbol=symbol)
                return
            # Check if any signal targets 0DTE (needed for optimal range selection)
            wants_0dte = False
            for sig in recent_signals:
                sk = _strategy_settings_key(sig.strategy_id)
                strat_cfg = settings_override.get(sk, {})
                if strat_cfg.get("targetDTE") == 0:
                    wants_0dte = True
                    break

            use_optimal = bool(effective_settings.get("useOptimalRange", True))
            optimal_range = self._optimal_ranges.get(symbol) if use_optimal else None
            # For 0DTE: use 0DTE-specific range if set, otherwise skip range filter entirely
            if wants_0dte:
                optimal_range = self._optimal_ranges_0dte.get(symbol)  # None = no filter
            if use_optimal and not wants_0dte and not optimal_range:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "no_optimal_range",
                        "Skipped: no optimal range for symbol.",
                        signal=signal,
                        symbol=symbol,
                        use_optimal=use_optimal,
                    )
                self._log_event(
                    "skip_no_optimal_range",
                    "Skipped: no optimal range for symbol.",
                    symbol=symbol,
                )
                return

            self._current_stage = "option_chain"
            self._log_signal_stage("option_chain", signals=recent_signals, symbol=symbol)
            chain = await get_option_chain(symbol)
            if not chain:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "no_option_chain",
                        "Skipped: no option chain returned.",
                        signal=signal,
                        symbol=symbol,
                    )
                self._log_event(
                    "skip_no_chain",
                    "Skipped: no option chain returned.",
                    symbol=symbol,
                )
                return
            # Determine target expiration based on strategy preferences
            today_key = datetime.now(NY_TZ).strftime("%Y-%m-%d")
            if wants_0dte:
                target_expiration = today_key
            else:
                target_expiration = next_friday_key()

            expirations = sorted(item["date"] for item in chain)
            expiration = next((date for date in expirations if date >= target_expiration), expirations[0])
            strikes = next((item["strikes"] for item in chain if item["date"] == expiration), [])
            if not strikes:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "no_strikes",
                        "Skipped: no strikes for expiration.",
                        signal=signal,
                        symbol=symbol,
                        expiration=expiration,
                    )
                self._log_event(
                    "skip_no_strikes",
                    "Skipped: no strikes for expiration.",
                    symbol=symbol,
                    expiration=expiration,
                )
                return
            strikes_sorted = sorted(strikes)
            nearest_strike = min(strikes_sorted, key=lambda s: abs(s - latest_price))
            nearest_index = strikes_sorted.index(nearest_strike)
            window = int(effective_settings.get("strikeWindow", 12))
            strike_slice = strikes_sorted[
                max(0, nearest_index - window) : nearest_index + window
            ]
            if not strike_slice:
                strike_slice = [nearest_strike]
            self._current_stage = "option_quotes"
            self._log_signal_stage(
                "option_quotes",
                signals=recent_signals,
                symbol=symbol,
                expiration=expiration,
            )
            quotes = await get_option_quotes(symbol, expiration, strike_slice, limit=24)
            if not quotes:
                for signal in recent_signals:
                    self._log_signal_skip(
                        "no_option_quotes",
                        "Skipped: no option quotes returned.",
                        signal=signal,
                        symbol=symbol,
                        expiration=expiration,
                    )
                self._log_event(
                    "skip_no_quotes",
                    "Skipped: no option quotes returned.",
                    symbol=symbol,
                    expiration=expiration,
                )
                return

            for signal in recent_signals:
                if self._trades_per_day[symbol]["count"] >= max_trades:
                    self._log_signal_skip(
                        "max_trades",
                        "Skipped: max trades reached for today.",
                        signal=signal,
                        symbol=symbol,
                        max=max_trades,
                        count=self._trades_per_day[symbol]["count"],
                    )
                    break
                if effective_settings.get("onePositionPerSymbol", False):
                    has_open = any(p.symbol == symbol for p in self._open_positions.values())
                    if has_open:
                        self._log_signal_skip(
                            "one_position_per_symbol",
                            "Skipped: already has an open position for this symbol.",
                            signal=signal,
                            symbol=symbol,
                        )
                        break
                if signal.id in self._seen_signals:
                    self._log_signal_skip(
                        "seen_signal",
                        "Skipped: signal already processed.",
                        signal=signal,
                        symbol=symbol,
                    )
                    continue
                # ── Strategy operating hours check ─────────────────────────
                strat_key = _strategy_settings_key(signal.strategy_id)
                strat_settings = settings_override.get(strat_key, {})
                op_start_str = strat_settings.get("operatingStartTime", "09:30")
                op_end_str = strat_settings.get("operatingEndTime", "16:00")
                try:
                    _os_h, _os_m = map(int, op_start_str.split(":"))
                    _oe_h, _oe_m = map(int, op_end_str.split(":"))
                    _now_et = datetime.now(NY_TZ)
                    _op_start = _now_et.replace(hour=_os_h, minute=_os_m, second=0, microsecond=0)
                    _op_end = _now_et.replace(hour=_oe_h, minute=_oe_m, second=0, microsecond=0)
                    if not (_op_start <= _now_et <= _op_end):
                        self._log_signal_skip(
                            "outside_operating_hours",
                            f"Skipped: outside {signal.strategy_id} operating hours ({op_start_str}\u2013{op_end_str}).",
                            signal=signal,
                            symbol=symbol,
                            strategy_id=signal.strategy_id,
                            operating_start=op_start_str,
                            operating_end=op_end_str,
                        )
                        # Past the window — mark as seen so it won't refire every scan
                        if _now_et > _op_end:
                            self._seen_signals.add(signal.id)
                        continue
                except (ValueError, AttributeError):
                    pass  # Malformed time → allow trade (fail-open)
                # ── Entry time window check ─────────────────────────────
                _entry_start_str = strat_settings.get("entryStartTime")
                _entry_end_str = strat_settings.get("entryEndTime")
                if _entry_start_str or _entry_end_str:
                    try:
                        _now_et2 = datetime.now(NY_TZ)
                        if _entry_start_str:
                            _es_h, _es_m = map(int, _entry_start_str.split(":"))
                            _entry_start = _now_et2.replace(hour=_es_h, minute=_es_m, second=0, microsecond=0)
                            if _now_et2 < _entry_start:
                                self._log_signal_skip(
                                    "before_entry_window",
                                    f"Skipped: before entry window start ({_entry_start_str}).",
                                    signal=signal,
                                    symbol=symbol,
                                    strategy_id=signal.strategy_id,
                                    entry_start=_entry_start_str,
                                )
                                continue
                        if _entry_end_str:
                            _ee_h, _ee_m = map(int, _entry_end_str.split(":"))
                            _entry_end = _now_et2.replace(hour=_ee_h, minute=_ee_m, second=0, microsecond=0)
                            if _now_et2 > _entry_end:
                                self._log_signal_skip(
                                    "after_entry_window",
                                    f"Skipped: after entry window end ({_entry_end_str}).",
                                    signal=signal,
                                    symbol=symbol,
                                    strategy_id=signal.strategy_id,
                                    entry_end=_entry_end_str,
                                )
                                self._seen_signals.add(signal.id)
                                continue
                    except (ValueError, AttributeError):
                        pass  # Malformed time → allow trade (fail-open)
                # ── Minimum DTE check ────────────────────────────────────
                _min_dte = int(strat_settings.get("minDTE", 0))
                if _min_dte > 0:
                    try:
                        _exp_date = datetime.strptime(expiration, "%Y-%m-%d").date()
                        _today = datetime.now(NY_TZ).date()
                        _dte = (_exp_date - _today).days
                        if _dte < _min_dte:
                            self._log_signal_skip(
                                "dte_too_low",
                                f"Skipped: expiration {expiration} is {_dte}DTE, strategy requires minDTE={_min_dte}.",
                                signal=signal,
                                symbol=symbol,
                                strategy_id=signal.strategy_id,
                                expiration=expiration,
                                dte=_dte,
                                min_dte=_min_dte,
                            )
                            continue
                    except (ValueError, TypeError):
                        pass  # Malformed date → allow trade (fail-open)
                # Signal freshness check — skip stale signals unless price still confirms direction
                # Use detection time (wall-clock when first seen) instead of bar time,
                # so signals aren't penalised for bar-data lag.
                _signal_max_age = int(effective_settings.get("signalMaxAgeSecs", 0))
                if _signal_max_age > 0:
                    _first_seen = self._signal_first_seen.get(signal.id, signal.entry_time)
                    _signal_age = int(time.time()) - _first_seen
                    if _signal_age > _signal_max_age:
                        # Check if price still moving in signal direction using 5m bars
                        _price_confirms = False
                        _bars_5m = cache.get("bars5m", [])
                        if _bars_5m and len(_bars_5m) >= 2:
                            # Find the bar closest to signal time
                            _signal_bar_close = None
                            for _b in _bars_5m:
                                if _b["time"] <= signal.entry_time:
                                    _signal_bar_close = _b["close"]
                            _latest_close = _bars_5m[-1]["close"]
                            if _signal_bar_close is not None:
                                if signal.direction == "CALL" and _latest_close > _signal_bar_close:
                                    _price_confirms = True
                                elif signal.direction == "PUT" and _latest_close < _signal_bar_close:
                                    _price_confirms = True
                        if _price_confirms:
                            self._log_event(
                                "signal_old_but_confirmed",
                                f"Signal is {_signal_age}s old but price still confirms {signal.direction} direction. Proceeding.",
                                symbol=symbol,
                                strategy_id=signal.strategy_id,
                                signal_id=signal.id,
                                signal_age=_signal_age,
                                max_age=_signal_max_age,
                            )
                        else:
                            self._log_signal_skip(
                                "signal_too_old",
                                f"Skipped: signal is {_signal_age}s old (max {_signal_max_age}s) and price no longer confirms direction.",
                                signal=signal,
                                symbol=symbol,
                                signal_age=_signal_age,
                                max_age=_signal_max_age,
                            )
                            # Mark as seen so it doesn't reappear on every scan
                            self._seen_signals.add(signal.id)
                            continue
                right = "C" if signal.direction == "CALL" else "P"
                if right == "C" and not effective_settings.get("allowCalls", True):
                    self._log_signal_skip(
                        "calls_disabled",
                        "Skipped: CALL positions are disabled.",
                        signal=signal,
                        symbol=symbol,
                    )
                    continue
                if right == "P" and not effective_settings.get("allowPuts", True):
                    self._log_signal_skip(
                        "puts_disabled",
                        "Skipped: PUT positions are disabled.",
                        signal=signal,
                        symbol=symbol,
                    )
                    continue

                # Block counter-trend trades: don't open opposite direction
                # if profitable positions exist in the current direction.
                if effective_settings.get("blockCounterTrend", True):
                    _opposite_right = "P" if right == "C" else "C"
                    _has_profitable_opposite = any(
                        p.symbol == symbol
                        and p.right == _opposite_right
                        and p.high_water_mark > p.entry_price
                        for p in self._open_positions.values()
                    )
                else:
                    _has_profitable_opposite = False
                if _has_profitable_opposite:
                    self._log_signal_skip(
                        "counter_trend_blocked",
                        f"Skipped: profitable {_opposite_right} position(s) open on {symbol}, blocking counter-trend {right} entry.",
                        signal=signal,
                        symbol=symbol,
                    )
                    continue

                if signal.direction == "CALL":
                    candidate_strikes = strikes_sorted[nearest_index : nearest_index + window + 1]
                else:
                    candidate_strikes = list(reversed(strikes_sorted[max(0, nearest_index - window) : nearest_index + 1]))

                selected_quote = None
                selected_strike = None
                premium = None
                contract_premium = None
                range_reason = None
                range_diff_pct = None
                range_bound = None

                # Spread filtering settings
                filter_by_spread = bool(effective_settings.get("filterBySpread", True))
                max_spread_pct = _safe_float(effective_settings.get("maxSpreadPct"), 20.0)
                max_spread_dollar = _safe_float(effective_settings.get("maxSpreadDollar"), 0.30)
                prefer_tight_spreads = bool(effective_settings.get("preferTightSpreads", True))
                min_delta = _safe_float(effective_settings.get("minDelta"), 0.05)

                # Collect all valid strikes (with spread data)
                valid_strikes = []
                candidate_details = []  # Track every candidate with quote + rejection reason
                spread_skip_count = 0
                no_quote_count = 0
                no_conid_count = 0
                no_premium_count = 0
                range_skip_count = 0
                delta_skip_count = 0
                no_bidask_count = 0
                last_range_premium = None

                for strike in candidate_strikes:
                    quote = next(
                        (q for q in quotes if q["right"] == right and q["strike"] == strike),
                        None,
                    )
                    if not quote:
                        no_quote_count += 1
                        candidate_details.append({"strike": strike, "rejection": "no_quote"})
                        continue
                    if not quote.get("con_id"):
                        no_conid_count += 1
                        candidate_details.append({"strike": strike, "rejection": "no_conid",
                            "bid": quote.get("bid"), "ask": quote.get("ask"), "last": quote.get("last"),
                            "iv": quote.get("iv"), "delta": quote.get("delta"), "oi": quote.get("oi")})
                        continue
                    premium_val = best_premium(quote)
                    q_bid = quote.get("bid")
                    q_ask = quote.get("ask")
                    q_spread = round(q_ask - q_bid, 2) if q_bid is not None and q_ask is not None and q_bid > 0 and q_ask > 0 else None
                    q_mid = (q_bid + q_ask) / 2 if q_bid is not None and q_ask is not None and q_bid > 0 and q_ask > 0 else None
                    q_spread_pct = round((q_spread / q_mid) * 100, 1) if q_spread is not None and q_mid and q_mid > 0 else None
                    q_base = {
                        "strike": strike,
                        "bid": q_bid, "ask": q_ask, "last": quote.get("last"),
                        "iv": quote.get("iv"), "delta": quote.get("delta"), "oi": quote.get("oi"),
                        "premium": round(premium_val * 100, 2) if premium_val is not None and math.isfinite(premium_val) else None,
                        "spread": q_spread, "spread_pct": q_spread_pct,
                    }
                    if premium_val is None or not math.isfinite(premium_val):
                        no_premium_count += 1
                        candidate_details.append({**q_base, "rejection": "no_premium"})
                        continue
                    contract_premium_val = premium_val * 100
                    q_base["premium"] = round(contract_premium_val, 2)
                    if optimal_range and (
                        contract_premium_val < optimal_range["min"]
                        or contract_premium_val > optimal_range["max"]
                    ):
                        range_reason = (
                            "below" if contract_premium_val < optimal_range["min"] else "above"
                        )
                        range_bound = (
                            optimal_range["min"]
                            if range_reason == "below"
                            else optimal_range["max"]
                        )
                        range_diff_pct = None
                        if range_bound:
                            range_diff_pct = (contract_premium_val - range_bound) / range_bound
                        range_skip_count += 1
                        last_range_premium = contract_premium_val
                        candidate_details.append({**q_base, "rejection": "out_of_range"})
                        continue

                    # Check minimum delta (reject near-zero delta = far OTM junk)
                    q_delta = quote.get("delta")
                    if min_delta > 0 and q_delta is not None and abs(q_delta) < min_delta:
                        delta_skip_count += 1
                        candidate_details.append({**q_base, "rejection": "low_delta"})
                        continue

                    # Check bid-ask spread
                    bid = quote.get("bid")
                    ask = quote.get("ask")
                    spread_data = None

                    # Reject strikes with no bid/ask data — can't verify spread
                    if filter_by_spread and (bid is None or ask is None or bid <= 0 or ask <= 0):
                        no_bidask_count += 1
                        candidate_details.append({**q_base, "rejection": "no_bidask"})
                        continue

                    if filter_by_spread:
                        spread = ask - bid
                        mid = (bid + ask) / 2
                        spread_pct = (spread / mid) * 100 if mid > 0 else 999.0

                        # Filter by spread percentage
                        if spread_pct > max_spread_pct:
                            spread_skip_count += 1
                            candidate_details.append({**q_base, "rejection": "wide_spread"})
                            continue

                        # Filter by spread dollar amount
                        if spread > max_spread_dollar:
                            spread_skip_count += 1
                            candidate_details.append({**q_base, "rejection": "wide_spread"})
                            continue

                        spread_data = {
                            "spread": spread,
                            "spread_pct": spread_pct,
                            "bid": bid,
                            "ask": ask,
                            "mid": mid,
                        }

                    # Strike passed all filters
                    candidate_details.append({**q_base, "rejection": None})
                    valid_strikes.append({
                        "strike": strike,
                        "quote": quote,
                        "premium": premium_val,
                        "contract_premium": contract_premium_val,
                        "spread_data": spread_data,
                    })

                # Select best strike from valid candidates
                if not valid_strikes:
                    # Build a detailed breakdown of why each candidate was rejected
                    reject_parts = []
                    if no_quote_count:
                        reject_parts.append(f"{no_quote_count} no quote")
                    if no_conid_count:
                        reject_parts.append(f"{no_conid_count} no conId")
                    if no_premium_count:
                        reject_parts.append(f"{no_premium_count} no premium")
                    if range_skip_count:
                        reject_parts.append(f"{range_skip_count} out of range")
                    if delta_skip_count:
                        reject_parts.append(f"{delta_skip_count} low delta")
                    if no_bidask_count:
                        reject_parts.append(f"{no_bidask_count} no bid/ask")
                    if spread_skip_count:
                        reject_parts.append(f"{spread_skip_count} wide spread")
                    reject_summary = ", ".join(reject_parts) if reject_parts else "unknown"

                    skip_reason = "no_strike_match"
                    skip_msg = f"Skipped: {len(candidate_strikes)} candidates checked, none passed ({reject_summary})."
                    skip_details = {
                        "signal": signal,
                        "symbol": symbol,
                        "right": right,
                        "latest_price": latest_price,
                        "nearest_strike": nearest_strike,
                        "expiration": expiration,
                        "strike_window": window,
                        "candidate_count": len(candidate_strikes),
                        "quote_count": len(quotes),
                        "no_quote": no_quote_count,
                        "no_premium": no_premium_count,
                        "range_filtered": range_skip_count,
                        "delta_filtered": delta_skip_count,
                        "no_bidask_filtered": no_bidask_count,
                        "spread_filtered": spread_skip_count,
                        "use_optimal": use_optimal,
                        "min": optimal_range["min"] if optimal_range else None,
                        "max": optimal_range["max"] if optimal_range else None,
                        "range_reason": range_reason,
                        "range_diff_pct": range_diff_pct,
                        "last_range_premium": last_range_premium,
                        "candidate_details": candidate_details,
                    }
                    if spread_skip_count > 0:
                        skip_reason = "spread_too_wide"
                        skip_msg = f"Skipped: {spread_skip_count}/{len(candidate_strikes)} filtered by spread ({reject_summary})."
                        skip_details["max_spread_pct"] = max_spread_pct
                        skip_details["max_spread_dollar"] = max_spread_dollar

                    self._log_signal_skip(skip_reason, skip_msg, **skip_details)
                    # If ALL candidates failed due to range filtering (not spread),
                    # the signal will never match — mark as seen to stop retrying.
                    if range_skip_count > 0 and spread_skip_count == 0:
                        self._seen_signals.add(signal.id)
                    continue

                # Sort by spread quality if preferred
                if prefer_tight_spreads and filter_by_spread:
                    valid_strikes.sort(key=lambda x: x["spread_data"]["spread_pct"] if x["spread_data"] else 999.0)

                # Select the best strike
                best = valid_strikes[0]
                selected_quote = best["quote"]
                selected_strike = best["strike"]
                premium = best["premium"]
                contract_premium = best["contract_premium"]

                # Log spread info if available
                if best["spread_data"]:
                    self._log_event(
                        "strike_selected_with_spread",
                        f"Selected strike ${selected_strike} with {best['spread_data']['spread_pct']:.1f}% spread.",
                        symbol=symbol,
                        strategy_id=signal.strategy_id,
                        signal_id=signal.id,
                        strike=selected_strike,
                        premium=premium,
                        bid=best["spread_data"]["bid"],
                        ask=best["spread_data"]["ask"],
                        spread=best["spread_data"]["spread"],
                        spread_pct=best["spread_data"]["spread_pct"],
                        valid_strikes_count=len(valid_strikes),
                    )

                # contract_premium already set from best strike selection above
                # Apply slippage buffer to account for price movement between check and execution
                slippage_buffer_pct = _safe_float(effective_settings.get("slippageBufferPct"), 0.08)
                required       = contract_premium * (1 + slippage_buffer_pct)
                capital_limit         = float(effective_settings.get("capitalLimit", 0) or 0)
                capital_limit_enabled = bool(effective_settings.get("capitalLimitEnabled", False))
                capital_spent  = self._capital_spent_today.get("total", 0.0)

                # ── 1. IBKR balance checks (GFV + margin safety) ─────────────────
                # Fetch both concurrently and enforce the lower of the two.
                #   SettledCash    → prevents Good Faith Violations (live only)
                #   AvailableFunds → prevents margin calls
                # Paper accounts don't have real settlement — skip GFV check.
                _is_paper = settings.IB_PORT in {4002, 7497}
                import asyncio as _asyncio
                _sc, _af = await _asyncio.gather(
                    get_settle_cash() if not _is_paper else asyncio.sleep(0),
                    get_available_funds(),
                    return_exceptions=True,
                )
                settle_cash:     float | None = _sc if isinstance(_sc, float) else None
                available_funds: float | None = _af if isinstance(_af, float) else None

                # Add commission buffer to prevent IB rejection (IB adds ~$1-2 for fees)
                _commission_buffer = 3.0
                if not _is_paper and settle_cash is not None:
                    settle_available = settle_cash - capital_spent - _commission_buffer
                    if required > settle_available:
                        self._log_signal_skip(
                            "settle_cash",
                            "Skipped: insufficient settled cash (Good Faith Violation prevention).",
                            signal=signal,
                            symbol=symbol,
                            required=required,
                            settle_cash=settle_cash,
                            settle_available=settle_available,
                            capital_spent=capital_spent,
                        )
                        return
                elif not _is_paper:
                    logger.warning(
                        "SettledCash unavailable for %s — skipping GFV check.", symbol
                    )

                if available_funds is not None:
                    af_available = available_funds - capital_spent
                    if required > af_available:
                        self._log_signal_skip(
                            "available_funds",
                            "Skipped: insufficient available funds (margin safety).",
                            signal=signal,
                            symbol=symbol,
                            required=required,
                            available_funds=available_funds,
                            af_available=af_available,
                            capital_spent=capital_spent,
                        )
                        return
                else:
                    logger.warning(
                        "AvailableFunds unavailable for %s — skipping margin check.", symbol
                    )
                if not effective_settings.get("allowOpenPositions", True):
                    self._log_signal_skip(
                        "open_positions_disabled",
                        "Skipped: opening new positions is disabled.",
                        signal=signal,
                        symbol=symbol,
                    )
                    continue

                # Check if current time is past the openPositionsUntil cutoff
                open_until_str = effective_settings.get("openPositionsUntil", "14:30")
                try:
                    now_et = datetime.now(NY_TZ)
                    # Parse HH:MM format
                    cutoff_hour, cutoff_min = map(int, open_until_str.split(":"))
                    cutoff_time = now_et.replace(hour=cutoff_hour, minute=cutoff_min, second=0, microsecond=0)

                    if now_et >= cutoff_time:
                        self._log_signal_skip(
                            "past_open_cutoff",
                            f"Skipped: current time {now_et.strftime('%H:%M')} is past opening cutoff {open_until_str}.",
                            signal=signal,
                            symbol=symbol,
                        )
                        continue
                except Exception as e:
                    logger.warning("Failed to parse openPositionsUntil time: %s", e)

                # ── Calculate position size based on sizing strategy ──────────────
                position_sizing = effective_settings.get("positionSizing", "hybrid")
                risk_per_trade = _safe_float(effective_settings.get("riskPerTrade"), 300.0)
                risk_pct = _safe_float(effective_settings.get("riskPctPerTrade"), 2.0)
                max_contracts = int(effective_settings.get("maxContractsPerTrade", 3))
                min_contracts = int(effective_settings.get("minContractsPerTrade", 1))

                quantity = 1  # Default fallback
                if position_sizing == "fixed":
                    # Fixed dollar risk per trade
                    quantity = max(1, int(risk_per_trade / contract_premium))
                elif position_sizing == "percentage":
                    # Percentage of available capital
                    if available_funds is not None and available_funds > 0:
                        quantity = int((available_funds * risk_pct / 100.0) / contract_premium)
                    else:
                        quantity = 1
                else:  # "hybrid" (default)
                    # Percentage of capital, capped at max contracts
                    if available_funds is not None and available_funds > 0:
                        from_capital = int((available_funds * risk_pct / 100.0) / contract_premium)
                        quantity = min(from_capital, max_contracts)
                    else:
                        quantity = max_contracts

                # Apply min/max bounds
                quantity = max(min_contracts, min(quantity, max_contracts))

                # ── Capital limit cap ───────────────────────────────────
                # Re-read capital_spent right before the check so concurrent
                # coroutines see the most up-to-date value.
                capital_spent = self._capital_spent_today.get("total", 0.0)
                if capital_limit_enabled and contract_premium > 0:
                    limit_remaining = capital_limit - capital_spent
                    max_from_limit = int(limit_remaining / contract_premium)
                    if max_from_limit < min_contracts:
                        self._log_signal_skip(
                            "capital_limit",
                            "Skipped: daily capital limit reached.",
                            signal=signal,
                            symbol=symbol,
                            required=contract_premium * min_contracts,
                            available=limit_remaining,
                            capital_limit=capital_limit,
                            capital_spent=capital_spent,
                        )
                        continue
                    quantity = min(quantity, max_from_limit)

                # Skip if can't afford minimum contracts
                if quantity < min_contracts:
                    self._log_signal_skip(
                        "insufficient_capital_for_min_contracts",
                        f"Skipped: cannot afford minimum {min_contracts} contract(s). Required: ${contract_premium * min_contracts:.2f}, Available: ${available_funds:.2f if available_funds else 0:.2f}",
                        signal=signal,
                        symbol=symbol,
                        min_contracts=min_contracts,
                        contract_premium=contract_premium,
                        available_funds=available_funds,
                    )
                    continue

                # Reserve capital immediately so concurrent coroutines see it
                # before we hit any await points (option chain, order placement).
                _reserved_capital = contract_premium * quantity
                self._capital_spent_today["total"] = (
                    self._capital_spent_today.get("total", 0.0) + _reserved_capital
                )

                self._log_event(
                    "position_size_calculated",
                    f"Position size: {quantity} contract(s) using {position_sizing} strategy.",
                    symbol=symbol,
                    strategy_id=signal.strategy_id,
                    signal_id=signal.id,
                    position_sizing=position_sizing,
                    quantity=quantity,
                    contract_premium=contract_premium,
                    total_cost=contract_premium * quantity,
                    risk_per_trade=risk_per_trade if position_sizing == "fixed" else None,
                    risk_pct=risk_pct if position_sizing in ["percentage", "hybrid"] else None,
                    available_funds=available_funds,
                )

                position_id = f"{symbol}-{signal.id}"
                target_price = premium * (1 + _safe_float(effective_settings.get("profitTargetPct"), 0.35))
                order_payload = {
                    "symbol": symbol,
                    "expiration": expiration,
                    "strike": selected_strike,
                    "right": right,
                    "action": "BUY",
                    "quantity": quantity,
                    "exchange": "SMART",
                    "currency": "USD",
                    "con_id": selected_quote.get("con_id") if selected_quote else None,
                    "trading_class": selected_quote.get("trading_class") if selected_quote else None,
                    "local_symbol": selected_quote.get("local_symbol") if selected_quote else None,
                    "multiplier": selected_quote.get("multiplier") if selected_quote else None,
                }
                self._log_event(
                    "order_request",
                    "Submitting order to IBKR.",
                    strategy_id=signal.strategy_id,
                    signal_id=signal.id,
                    **order_payload,
                )
                use_market_orders = bool(effective_settings.get("useMarketOrders", True))
                # Override: use limit orders biased toward ask for entry when enabled
                _entry_limit_price: Optional[float] = None
                if not use_market_orders or bool(effective_settings.get("useLimitOrdersForEntry", False)):
                    use_market_orders = False
                    _limit_bias = _safe_float(effective_settings.get("limitOrderBias"), 0.25)
                    _biased = biased_limit_price(selected_quote, bias=_limit_bias) if selected_quote else None
                    if _biased is not None:
                        _entry_limit_price = _biased
                _open_account = _resolve_account(effective_settings)
                try:
                    self._current_stage = "placing_order"
                    self._log_signal_stage(
                        "placing_order",
                        signals=[signal],
                        symbol=symbol,
                        expiration=expiration,
                        right=right,
                        strike=selected_strike,
                    )
                    _limit_timeout = float(
                        strat_settings.get("limitOrderTimeoutSecs")
                        or effective_settings.get("limitOrderTimeoutSecs", 30)
                    )
                    # Re-validate signal before market fallback
                    async def _recheck_signal() -> bool:
                        """Re-fetch quote and check the signal is still worth entering."""
                        try:
                            fresh_quotes = await get_option_quotes(
                                symbol, expiration, [selected_strike], right,
                            )
                            fresh_q = fresh_quotes[0] if fresh_quotes else None
                            if not fresh_q:
                                self._log_event(
                                    "fallback_recheck",
                                    f"Re-check failed: no fresh quote for {symbol} {right}{selected_strike}.",
                                    symbol=symbol, strategy_id=signal.strategy_id, signal_id=signal.id,
                                )
                                return False
                            fresh_premium = best_premium(fresh_q)
                            if fresh_premium is None:
                                return False
                            # Reject if premium moved more than 50% above our original entry price
                            _recheck_threshold = _safe_float(effective_settings.get("recheckThresholdPct"), 0.50)
                            max_acceptable = premium * (1 + _recheck_threshold)
                            if fresh_premium > max_acceptable:
                                self._log_event(
                                    "fallback_recheck",
                                    f"Re-check failed: premium moved from ${premium:.2f} to ${fresh_premium:.2f} (+{((fresh_premium/premium)-1)*100:.0f}%), exceeds {_recheck_threshold*100:.0f}% threshold.",
                                    symbol=symbol, strategy_id=signal.strategy_id, signal_id=signal.id,
                                    original_premium=premium, fresh_premium=fresh_premium,
                                )
                                return False
                            self._log_event(
                                "fallback_recheck",
                                f"Re-check passed: premium ${fresh_premium:.2f} (was ${premium:.2f}).",
                                symbol=symbol, strategy_id=signal.strategy_id, signal_id=signal.id,
                                original_premium=premium, fresh_premium=fresh_premium,
                            )
                            return True
                        except Exception as exc:
                            logger.warning("Fallback re-check failed for %s: %s", symbol, exc)
                            return False

                    order_info = await _place_with_limit_fallback(
                        quote=selected_quote,
                        use_market_orders=use_market_orders,
                        timeout_secs=_limit_timeout,
                        log_event_fn=self._log_event,
                        log_kwargs={
                            "symbol": symbol,
                            "strategy_id": signal.strategy_id,
                            "signal_id": signal.id,
                        },
                        limit_price=_entry_limit_price,
                        pre_fallback_check=_recheck_signal if _entry_limit_price is not None else None,
                        symbol=symbol,
                        expiration=expiration,
                        strike=selected_strike,
                        right=right,
                        action="BUY",
                        quantity=quantity,
                        con_id=order_payload.get("con_id"),
                        trading_class=order_payload.get("trading_class"),
                        local_symbol=order_payload.get("local_symbol"),
                        multiplier=order_payload.get("multiplier"),
                        account=_open_account,
                    )
                    if order_info is None:
                        # Pre-fallback check vetoed the market order — release capital
                        self._capital_spent_today["total"] = max(
                            0.0, self._capital_spent_today.get("total", 0.0) - _reserved_capital
                        )
                        # Mark signal as seen so it doesn't retry every scan cycle
                        self._seen_signals.add(signal.id)
                        continue
                except Exception as exc:
                    # Release reserved capital on order failure
                    self._capital_spent_today["total"] = max(
                        0.0, self._capital_spent_today.get("total", 0.0) - _reserved_capital
                    )
                    logger.error(f"Failed to place order for {symbol}: {exc}")
                    self._log_event(
                        "order_failed",
                        "Order placement failed.",
                        strategy_id=signal.strategy_id,
                        signal_id=signal.id,
                        right=right,
                        strike=selected_strike,
                        expiration=expiration,
                        premium=premium,
                        **order_payload,
                        error=str(exc),
                    )
                    continue
                self._log_event(
                    "order_submitted",
                    "Order submitted to IBKR.",
                    strategy_id=signal.strategy_id,
                    signal_id=signal.id,
                    **order_payload,
                    order_id=order_info.get("order_id") if isinstance(order_info, dict) else None,
                    status=order_info.get("status") if isinstance(order_info, dict) else None,
                    premium=premium,
                    capital_required=premium * 100 * quantity,
                    capital_spent_today=self._capital_spent_today.get("total", 0.0),
                )
                self._scan_cycle_results[symbol] = {
                    "status": "signal",
                    "right": right,
                    "strike": selected_strike,
                }
                if isinstance(order_info, dict) and order_info.get("trade") is not None:
                    self._attach_trade_status(order_info["trade"], order_payload)

                # ── Wait for fill confirmation (all order types) ──
                _trade_obj = order_info.get("trade") if isinstance(order_info, dict) else None
                _fill_confirmed = False
                _order_cancelled = False
                if _trade_obj is not None:
                    # Check if already filled (e.g. limit order filled inside _place_with_limit_fallback)
                    _immediate_status = (
                        getattr(getattr(_trade_obj, "orderStatus", None), "status", "") or ""
                    )
                    if _immediate_status == "Filled":
                        _fill_confirmed = True
                    elif _immediate_status == "Cancelled":
                        _order_cancelled = True
                    else:
                        # Wait up to 60s for fill
                        _fill_deadline = time.time() + 60.0
                        while time.time() < _fill_deadline:
                            _fill_status = (
                                getattr(getattr(_trade_obj, "orderStatus", None), "status", "") or ""
                            )
                            if _fill_status == "Filled":
                                _fill_confirmed = True
                                break
                            if _fill_status == "Cancelled":
                                _order_cancelled = True
                                break
                            await asyncio.sleep(0.4)
                        if not _fill_confirmed and not _order_cancelled:
                            _fill_status = (
                                getattr(getattr(_trade_obj, "orderStatus", None), "status", "") or "unknown"
                            )
                            # Capture IB warning/rejection details
                            _warning_text = getattr(getattr(_trade_obj, "orderStatus", None), "warningText", "") or ""
                            _why_held = getattr(getattr(_trade_obj, "orderStatus", None), "whyHeld", "") or ""
                            _log_entries = [str(le) for le in getattr(_trade_obj, "log", [])][-5:]
                            logger.warning(
                                "Order for %s not confirmed as Filled within 60s (status=%s, warning=%s, whyHeld=%s). Cancelling.",
                                symbol, _fill_status, _warning_text, _why_held,
                            )
                            # Cancel unfilled order so it doesn't linger on IBKR
                            await cancel_order(_trade_obj)
                            _order_cancelled = True
                            self._log_event(
                                "order_fill_timeout",
                                f"Order not filled within 60s (status={_fill_status}). Cancelled — position NOT recorded."
                                f"{f' Warning: {_warning_text}' if _warning_text else ''}"
                                f"{f' WhyHeld: {_why_held}' if _why_held else ''}",
                                symbol=symbol,
                                strategy_id=signal.strategy_id,
                                signal_id=signal.id,
                                order_id=order_info.get("order_id") if isinstance(order_info, dict) else None,
                                fill_status=_fill_status,
                                warning_text=_warning_text,
                                why_held=_why_held,
                                trade_log=_log_entries,
                                premium=premium,
                                quantity=quantity,
                                capital_required=premium * 100 * quantity,
                            )
                if _order_cancelled:
                    # Release reserved capital since order was not filled
                    self._capital_spent_today["total"] = max(
                        0.0, self._capital_spent_today.get("total", 0.0) - _reserved_capital
                    )
                    logger.info("Released reserved capital $%.2f after cancelled order for %s", _reserved_capital, symbol)
                    # Capture IB rejection details
                    _warning_text = ""
                    _why_held = ""
                    _log_entries = []
                    if _trade_obj is not None:
                        _warning_text = getattr(getattr(_trade_obj, "orderStatus", None), "warningText", "") or ""
                        _why_held = getattr(getattr(_trade_obj, "orderStatus", None), "whyHeld", "") or ""
                        _log_entries = [str(le) for le in getattr(_trade_obj, "log", [])][-5:]
                    logger.warning(
                        "Open order for %s was Cancelled by IB (warning=%s, whyHeld=%s, log=%s).",
                        symbol, _warning_text, _why_held, _log_entries,
                    )
                    self._log_event(
                        "order_cancelled",
                        f"Open order cancelled by IB — position NOT recorded."
                        f"{f' Warning: {_warning_text}' if _warning_text else ''}"
                        f"{f' WhyHeld: {_why_held}' if _why_held else ''}",
                        symbol=symbol,
                        strategy_id=signal.strategy_id,
                        signal_id=signal.id,
                        warning_text=_warning_text,
                        why_held=_why_held,
                        trade_log=_log_entries,
                        premium=premium,
                        quantity=quantity,
                        capital_required=premium * 100 * quantity,
                    )
                    continue
                open_ts = int(time.time())
                # Use actual fill price from IB when available
                if _fill_confirmed and _trade_obj is not None:
                    _avg_fill = getattr(getattr(_trade_obj, "orderStatus", None), "avgFillPrice", None)
                    if _avg_fill and float(_avg_fill) > 0:
                        premium = float(_avg_fill)
                        target_price = premium * (1 + _safe_float(effective_settings.get("profitTargetPct"), 0.35))
                iv_at_entry = selected_quote.get("iv") if selected_quote else None
                delta_at_entry = selected_quote.get("delta") if selected_quote else None
                append_entry(
                    {
                        "timestamp": open_ts,
                        "symbol": symbol,
                        "action": "BUY",
                        "right": right,
                        "expiration": expiration,
                        "strike": selected_strike,
                        "quantity": quantity,
                        "price": premium,
                        "status": "Filled" if _fill_confirmed else (order_info.get("status") if isinstance(order_info, dict) else None),
                        "strategy_id": signal.strategy_id,
                        "signal_id": signal.id,
                        "position_id": position_id,
                        "type": "OPEN",
                        "mode": ib_manager.active_mode,
                        "entry_price": premium,
                        "target_price": target_price,
                        "high_water_mark": 0.0,
                        "iv_at_entry": iv_at_entry,
                        "delta_at_entry": delta_at_entry,
                    }
                )
                # Capture option chain snapshot for future contract selection analysis
                try:
                    # Compute market context from bars in scope
                    _bars1m = cache.get("bars1m", [])
                    _minutes_to_close = 0
                    if _bars1m:
                        _now_ts = _bars1m[-1]["time"]
                        _ny_now = datetime.fromtimestamp(_now_ts, ZoneInfo("America/New_York"))
                        _close_ts = _ny_now.replace(hour=16, minute=0, second=0).timestamp()
                        _minutes_to_close = max(0, int((_close_ts - _now_ts) / 60))
                    _price_5m_ago = _bars1m[-6]["close"] if len(_bars1m) >= 6 else None
                    _price_15m_ago = _bars1m[-16]["close"] if len(_bars1m) >= 16 else None
                    _selected_bid = selected_quote.get("bid") if selected_quote else None
                    _selected_ask = selected_quote.get("ask") if selected_quote else None
                    _selected_mid = round((_selected_bid + _selected_ask) / 2, 2) if _selected_bid and _selected_ask else None

                    # Chop filter block history for this symbol
                    _chop_ctx = self._chop_block_tracker.get(symbol, {"count": 0, "first_ts": 0})
                    _chop_blocked_secs = (open_ts - _chop_ctx["first_ts"]) if _chop_ctx["count"] > 0 else 0

                    # Market regime from 1m bars
                    _day_start_ts = int(datetime.fromtimestamp(open_ts, ZoneInfo("America/New_York")).replace(
                        hour=9, minute=30, second=0, microsecond=0).timestamp())
                    _bars_today = [b for b in _bars1m if b["time"] >= _day_start_ts]
                    _day_high = max((b["high"] for b in _bars_today), default=None) if _bars_today else None
                    _day_low = min((b["low"] for b in _bars_today), default=None) if _bars_today else None
                    _day_open = _bars_today[0]["open"] if _bars_today else None
                    _day_volume = sum(b.get("volume", 0) for b in _bars_today) if _bars_today else None
                    _vwap = None
                    if _bars_today:
                        _vwap_num = sum(b["close"] * b.get("volume", 0) for b in _bars_today)
                        _vwap_den = sum(b.get("volume", 0) for b in _bars_today)
                        if _vwap_den > 0:
                            _vwap = round(_vwap_num / _vwap_den, 2)
                    _gap_pct = round((_day_open - _bars1m[0]["open"]) / _bars1m[0]["open"] * 100, 2) if _day_open and len(_bars1m) > len(_bars_today) else None

                    append_snapshot({
                        "type": "entry",
                        "timestamp": open_ts,
                        "symbol": symbol,
                        "expiration": expiration,
                        "right": right,
                        "underlying_price": latest_price,
                        "signal_id": signal.id,
                        "strategy_id": signal.strategy_id,
                        "position_id": position_id,
                        "signal_direction": signal.direction,
                        "signal_entry_time": signal.entry_time,
                        "signal_age_secs": open_ts - signal.entry_time,
                        "minutes_to_close": _minutes_to_close,
                        "selected_strike": selected_strike,
                        "selected_premium": premium,
                        "selected_delta": delta_at_entry,
                        "selected_iv": iv_at_entry,
                        "selected_bid": _selected_bid,
                        "selected_ask": _selected_ask,
                        "selected_mid": _selected_mid,
                        "distance_from_underlying": round(selected_strike - latest_price, 2) if latest_price else None,
                        "adx": round(_adx_value, 2) if _adx_value is not None else None,
                        "plus_di": round(_plus_di, 2) if _plus_di is not None else None,
                        "minus_di": round(_minus_di, 2) if _minus_di is not None else None,
                        "di_gap": round(_di_gap, 2) if _di_gap is not None else None,
                        "price_5m_ago": _price_5m_ago,
                        "price_15m_ago": _price_15m_ago,
                        "momentum_5m": round(latest_price - _price_5m_ago, 2) if latest_price and _price_5m_ago else None,
                        "momentum_15m": round(latest_price - _price_15m_ago, 2) if latest_price and _price_15m_ago else None,
                        "chop_filter": {
                            "consecutive_blocks": _chop_ctx["count"],
                            "blocked_since_ts": _chop_ctx["first_ts"] if _chop_ctx["count"] > 0 else None,
                            "blocked_duration_secs": _chop_blocked_secs,
                        },
                        "market_regime": {
                            "day_open": _day_open,
                            "day_high": _day_high,
                            "day_low": _day_low,
                            "day_range": round(_day_high - _day_low, 2) if _day_high and _day_low else None,
                            "day_volume": _day_volume,
                            "vwap": _vwap,
                            "price_vs_vwap": round(latest_price - _vwap, 2) if latest_price and _vwap else None,
                            "gap_pct": _gap_pct,
                        },
                        "quantity": quantity,
                        "optimal_range": optimal_range,
                        "filter_settings": {
                            "filter_by_spread": filter_by_spread,
                            "max_spread_pct": max_spread_pct,
                            "max_spread_dollar": max_spread_dollar,
                            "prefer_tight_spreads": prefer_tight_spreads,
                            "min_delta": min_delta,
                            "strike_window": window,
                        },
                        "all_chain_strikes": strikes_sorted,
                        "quotes": quotes,
                        "candidate_details": candidate_details,
                    })
                    # Reset chop block tracker after successful entry
                    self._chop_block_tracker.pop(symbol, None)
                except Exception:
                    logger.warning("Failed to write option chain snapshot for %s", symbol, exc_info=True)

                self._seen_signals.add(signal.id)
                self._trades_per_day[symbol]["count"] += 1
                # Capital was already reserved before the order was placed
                # (see _reserved_capital above). No additional update needed.
                self._log_event(
                    "trade_open",
                    "Opened position.",
                    symbol=symbol,
                    strategy_id=signal.strategy_id,
                    signal_id=signal.id,
                    right=right,
                    strike=selected_strike,
                    expiration=expiration,
                    premium=premium,
                    contract_premium=contract_premium,
                    min=optimal_range["min"] if optimal_range else None,
                    max=optimal_range["max"] if optimal_range else None,
                    target_price=target_price,
                    iv_at_entry=iv_at_entry,
                    delta_at_entry=delta_at_entry,
                    order_id=order_info.get("order_id") if isinstance(order_info, dict) else None,
                    status=order_info.get("status") if isinstance(order_info, dict) else None,
                )
                self._open_positions[position_id] = Position(
                    symbol=symbol,
                    expiration=expiration,
                    strike=selected_strike,
                    right=right,
                    entry_price=premium,
                    target_price=target_price,
                    quantity=quantity,
                    strategy_id=signal.strategy_id,
                    signal_id=signal.id,
                    position_id=position_id,
                    open_ts=open_ts,
                    mode=ib_manager.active_mode,
                )
        except Exception as exc:
            if recent_signals:
                self._log_signal_error(
                    str(exc),
                    signals=recent_signals,
                    symbol=symbol,
                    stage=self._current_stage,
                )
            raise
        finally:
            self._last_symbol = symbol

    async def _check_open_positions(self) -> None:
        logger.info(f"TP check: checking {len(self._open_positions)} positions in memory")
        if not self._open_positions:
            logger.warning("TP check: skipping - no positions in memory")
            return
        settings_data = get_auto_trader_settings()
        max_positions = int(settings_data.get("maxConcurrentPositions", 20))
        if len(self._open_positions) > max_positions:
            self._log_event(
                "max_positions_warning",
                "Open positions exceed maxConcurrentPositions.",
                count=len(self._open_positions),
                max=max_positions,
            )
        ny_tz = ZoneInfo("America/New_York")
        # Force-close any expiring positions at the configured time (ET) on expiration day.
        expiry_time_str = settings_data.get("expiryCloseTime", "15:45")
        try:
            expiry_hour, expiry_minute = [int(p) for p in expiry_time_str.split(":")]
        except Exception:
            expiry_hour, expiry_minute = 15, 45

        positions = list(self._open_positions.values())

        # ── Phase 1: Batch-fetch all position quotes in a single IBKR call ──
        batch_quotes: Dict[str, Dict] = {}
        try:
            pos_requests = [
                {
                    "symbol": p.symbol,
                    "expiration": p.expiration,
                    "strike": p.strike,
                    "right": p.right,
                }
                for p in positions
            ]
            logger.info("TP check: batch-fetching quotes for %d positions...", len(pos_requests))
            batch_start = time.time()
            batch_quotes = await get_batch_option_quotes(pos_requests)
            batch_elapsed = time.time() - batch_start
            logger.info(
                "TP check: batch fetch complete — %d/%d quotes in %.1fs",
                len(batch_quotes), len(pos_requests), batch_elapsed,
            )
            self._log_event(
                "tp_batch_fetch",
                f"Batch fetch: {len(batch_quotes)}/{len(pos_requests)} quotes in {batch_elapsed:.1f}s",
                quotes_fetched=len(batch_quotes),
                quotes_requested=len(pos_requests),
                elapsed_secs=round(batch_elapsed, 2),
            )
        except Exception as batch_exc:
            logger.warning(
                "TP check: batch fetch failed (%s), falling back to sequential.",
                batch_exc,
            )
            # Fallback: fetch one-by-one so nothing breaks
            for p in positions:
                try:
                    quotes = await get_option_quotes(p.symbol, p.expiration, [p.strike], limit=2)
                    q = next(
                        (q for q in quotes if q["right"] == p.right and q["strike"] == p.strike),
                        None,
                    )
                    if q:
                        key = f"{p.symbol}-{p.expiration}-{p.strike}-{p.right}"
                        batch_quotes[key] = q
                except Exception as seq_exc:
                    logger.error("TP check: sequential fallback failed for %s: %s", p.symbol, seq_exc)

        # ── Phase 2: Evaluate each position with its pre-fetched quote ──
        expiry_closed: list[str] = []
        expiry_failed: list[str] = []
        for idx, position in enumerate(positions):
            # Yield to the event loop between every position check so that
            # HTTP request handlers are not starved when many positions are open.
            await asyncio.sleep(0)
            try:
                logger.info(f"TP check [{idx+1}/{len(positions)}]: checking {position.symbol} {position.right} {position.strike}")
                symbol_settings = get_symbol_settings(position.symbol)
                # Layer strategy-specific TP settings on top of symbol settings.
                # Merge order: global/symbol → user strategy overrides → per-position
                # Note: hardcoded strategy defaults are NOT applied here — they should
                # not override the user's explicit global/symbol settings (e.g. if
                # user sets global stopLossPct=0, a strategy default of 0.50 should
                # not silently re-enable it).  Only explicit user overrides from the
                # strategy settings UI panel take effect.
                _tp_keys = ("profitTargetPct", "stopLossPct", "useTrailingStop", "trailingStopPct", "trailingActivationPct")
                if position.strategy_id:
                    _strat_key = _strategy_settings_key(position.strategy_id)
                    # User overrides from the UI (strategySettings in auto_trader_settings.json)
                    _user_strat_overrides = settings_data.get("strategySettings", {}).get(_strat_key, {})
                    _user_strat_tp = {k: v for k, v in _user_strat_overrides.items() if k in _tp_keys}
                    if _user_strat_tp:
                        symbol_settings = {**symbol_settings, **_user_strat_tp}
                # Check for per-position TP override (takes precedence over symbol/global/strategy settings)
                effective_settings = get_effective_tp_settings(position.signal_id, symbol_settings)
                profit_target_pct = _safe_float(effective_settings.get("profitTargetPct"), 0.35)
                dynamic_target = position.entry_price * (1 + profit_target_pct)

                # Check current time for each position (not scan start time)
                now_ny = datetime.now(ny_tz)
                today_str = now_ny.strftime("%Y-%m-%d")
                expiry_cutoff = now_ny.replace(hour=expiry_hour, minute=expiry_minute, second=0, microsecond=0)

                # Force-close if this option expires today and it's past the configured time (e.g., 2:00 PM ET)
                expiring_today = position.expiration == today_str and now_ny >= expiry_cutoff

                # Strategy-level timeExitAt: force-close at a specific time (e.g., 15:30 for 0DTE)
                _time_exit_forced = False
                _max_hold_exceeded = False
                _max_hold_minutes = 0
                if position.strategy_id:
                    _te_strat_key = _strategy_settings_key(position.strategy_id)
                    _te_defaults = DEFAULT_STRATEGY_SETTINGS.get(_te_strat_key, {})
                    _te_user = settings_data.get("strategySettings", {}).get(_te_strat_key, {})
                    _time_exit_str = _te_user.get("timeExitAt") or _te_defaults.get("timeExitAt")
                    if _time_exit_str:
                        try:
                            _te_h, _te_m = map(int, _time_exit_str.split(":"))
                            _time_exit_at = now_ny.replace(hour=_te_h, minute=_te_m, second=0, microsecond=0)
                            if now_ny >= _time_exit_at:
                                _time_exit_forced = True
                                expiring_today = True  # Treat as forced close
                        except (ValueError, AttributeError):
                            pass
                    # maxHoldMinutes: force-close if position has been open too long
                    _max_hold_minutes = int(_safe_float(
                        _te_user.get("maxHoldMinutes") or _te_defaults.get("maxHoldMinutes"), 0
                    ))
                    if _max_hold_minutes > 0 and position.open_ts > 0:
                        _hold_secs = int(time.time()) - position.open_ts
                        if _hold_secs >= _max_hold_minutes * 60:
                            _max_hold_exceeded = True
                            expiring_today = True  # Treat as forced close

                key = f"{position.symbol}-{position.expiration}-{position.strike}-{position.right}"
                quote = batch_quotes.get(key)
                if not quote:
                    if expiring_today:
                        self._log_event(
                            "expiry_close_skipped",
                            "Expiry close: no quote available, position may expire.",
                            symbol=position.symbol,
                            expiration=position.expiration,
                            strike=position.strike,
                            right=position.right,
                        )
                    continue
                premium = exit_premium(quote)
                if premium is None or not math.isfinite(premium):
                    if expiring_today:
                        self._log_event(
                            "expiry_close_skipped",
                            "Expiry close: invalid premium, position may expire.",
                            symbol=position.symbol,
                            expiration=position.expiration,
                            strike=position.strike,
                            right=position.right,
                        )
                    continue
                delta_pct = (premium - position.entry_price) / position.entry_price
                target_delta_pct = (dynamic_target - position.entry_price) / position.entry_price
                # Trailing stop logic (use effective_settings which includes per-position overrides)
                use_trailing = effective_settings.get("useTrailingStop", False)
                trail_pct = _safe_float(effective_settings.get("trailingStopPct"), 0.1)

                # Tiered trailing: tighten trail as gain increases
                _trailing_tiers = effective_settings.get("trailingTiers")
                if use_trailing and _trailing_tiers and isinstance(_trailing_tiers, list) and position.entry_price > 0:
                    _current_gain_pct = (position.high_water_mark - position.entry_price) / position.entry_price
                    # Tiers sorted descending by "above" — first match wins
                    for _tier in sorted(_trailing_tiers, key=lambda t: t.get("above", 0), reverse=True):
                        if _current_gain_pct >= _safe_float(_tier.get("above"), 0):
                            trail_pct = _safe_float(_tier.get("trail"), trail_pct)
                            break

                # Track if trailing was already activated before this check
                was_trailing_active = use_trailing and position.high_water_mark >= dynamic_target

                # Update high water mark for trailing stop
                if premium > position.high_water_mark:
                    old_hwm = position.high_water_mark
                    position.high_water_mark = premium

                    # Persist high_water_mark to trade log
                    update_position_field(position.position_id, "high_water_mark", premium)

                    # Only log if trailing will be activated (position has crossed TP threshold)
                    will_be_trailing_active = use_trailing and premium >= dynamic_target
                    if will_be_trailing_active:
                        self._log_event(
                            "trailing_hwm_update",
                            f"New peak: ${old_hwm:.2f} → ${premium:.2f} (entry: ${position.entry_price:.2f}, +{(premium - position.entry_price) / position.entry_price * 100:.1f}%)",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            old_hwm=old_hwm,
                            new_hwm=premium,
                            entry_price=position.entry_price,
                            gain_pct=round((premium - position.entry_price) / position.entry_price * 100, 1),
                        )

                # Calculate trail stop price from high water mark
                trail_stop_price = position.high_water_mark * (1 - trail_pct) if use_trailing else 0
                # Enforce breakeven floor: trail stop can never close below entry price
                if use_trailing and trail_stop_price < position.entry_price:
                    trail_stop_price = position.entry_price
                trailing_activated = use_trailing and position.high_water_mark >= dynamic_target
                # Close when trailing is activated and premium breaches trail stop.
                # No breakeven guard — if price gaps through trail stop AND entry
                # in one check interval, close immediately to limit damage.
                should_close_trail = trailing_activated and premium <= trail_stop_price

                # Log when trailing first activates
                if use_trailing and trailing_activated and not was_trailing_active:
                    self._log_event(
                        "trailing_activated",
                        f"Trailing stop activated at ${position.high_water_mark:.2f} (TP: ${dynamic_target:.2f}). Trail will trigger at ${trail_stop_price:.2f} ({trail_pct * 100:.0f}% below peak).",
                        symbol=position.symbol,
                        strategy_id=position.strategy_id,
                        signal_id=position.signal_id,
                        activation_premium=position.high_water_mark,
                        target_price=dynamic_target,
                        trail_stop_price=trail_stop_price,
                        trail_pct=trail_pct * 100,
                    )

                self._log_event(
                    "position_check",
                    "Position checked.",
                    symbol=position.symbol,
                    strategy_id=position.strategy_id,
                    signal_id=position.signal_id,
                    right=position.right,
                    strike=position.strike,
                    expiration=position.expiration,
                    premium=premium,
                    entry_price=position.entry_price,
                    target_price=dynamic_target,
                    delta_pct=delta_pct,
                    target_delta_pct=target_delta_pct,
                    expiring_today=expiring_today,
                    high_water_mark=position.high_water_mark if use_trailing else None,
                    trail_stop_price=trail_stop_price if use_trailing else None,
                    trailing_activated=trailing_activated if use_trailing else None,
                )


                # Hard stop loss check
                _stop_loss_pct = _safe_float(effective_settings.get("stopLossPct"), 0)
                _stop_loss_triggered = False
                if _stop_loss_pct > 0:
                    _stop_loss_price = position.entry_price * (1 - _stop_loss_pct)
                    if premium <= _stop_loss_price:
                        _stop_loss_triggered = True
                        self._log_event(
                            "stop_loss_triggered",
                            f"Stop loss hit: premium ${premium:.2f} <= ${_stop_loss_price:.2f} ({_stop_loss_pct*100:.0f}% below entry ${position.entry_price:.2f}).",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            premium=premium,
                            entry_price=position.entry_price,
                            stop_loss_price=round(_stop_loss_price, 4),
                            stop_loss_pct=_stop_loss_pct,
                            loss_pct=round(delta_pct * 100, 1),
                        )

                # Stale position check: close if not profitable after N minutes
                _stale_after_mins = _safe_float(effective_settings.get("staleAfterMinutes"), 0)
                _stale_min_gain_pct = _safe_float(effective_settings.get("staleMinGainPct"), 0.10)
                _stale_triggered = False
                if _stale_after_mins > 0 and position.open_ts > 0:
                    _hold_mins = (int(time.time()) - position.open_ts) / 60
                    _gain_pct = (premium - position.entry_price) / position.entry_price if position.entry_price > 0 else 0
                    if _hold_mins >= _stale_after_mins and _gain_pct < _stale_min_gain_pct:
                        _stale_triggered = True
                        self._log_event(
                            "stale_position_exit",
                            f"Closing stale position: held {_hold_mins:.0f}m with {_gain_pct*100:+.1f}% gain (min required: {_stale_min_gain_pct*100:.0f}% after {_stale_after_mins:.0f}m).",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            premium=premium,
                            entry_price=position.entry_price,
                            hold_minutes=round(_hold_mins, 1),
                            gain_pct=round(_gain_pct * 100, 1),
                            stale_after_minutes=_stale_after_mins,
                            stale_min_gain_pct=_stale_min_gain_pct,
                        )

                # Close conditions
                if not expiring_today:
                    if _stop_loss_triggered:
                        pass  # Proceed to close — stop loss overrides everything
                    elif _stale_triggered:
                        pass  # Proceed to close — stale position exit
                    elif use_trailing:
                        # With trailing stop: close if trail triggered OR fixed TP reached (if not activated yet)
                        if should_close_trail:
                            pass  # Proceed to close
                        elif not trailing_activated and premium < dynamic_target:
                            continue  # Wait for initial TP activation
                        elif trailing_activated and premium > trail_stop_price:
                            continue  # Trail not hit yet, keep monitoring
                        elif breakeven_blocked:
                            continue  # Breakeven floor — hold until premium >= entry
                    else:
                        # Without trailing stop: use fixed TP
                        if premium < dynamic_target:
                            continue
                if _max_hold_exceeded:
                    _hold_min = (int(time.time()) - position.open_ts) / 60
                    self._log_event(
                        "max_hold_exceeded",
                        f"Closing position: held {_hold_min:.0f}m, max is {_max_hold_minutes}m.",
                        symbol=position.symbol,
                        strategy_id=position.strategy_id,
                        signal_id=position.signal_id,
                        expiration=position.expiration,
                        strike=position.strike,
                        right=position.right,
                        premium=premium,
                        entry_price=position.entry_price,
                        pnl=(premium - position.entry_price) * 100 * position.quantity,
                    )
                elif _time_exit_forced:
                    self._log_event(
                        "time_exit_forced",
                        f"Closing position: timeExitAt {_time_exit_str} ET reached.",
                        symbol=position.symbol,
                        strategy_id=position.strategy_id,
                        signal_id=position.signal_id,
                        expiration=position.expiration,
                        strike=position.strike,
                        right=position.right,
                        premium=premium,
                        entry_price=position.entry_price,
                        pnl=(premium - position.entry_price) * 100 * position.quantity,
                    )
                elif expiring_today and premium < dynamic_target:
                    self._log_event(
                        "expiry_close_forced",
                        "Closing position before expiration to avoid auto-exercise.",
                        symbol=position.symbol,
                        expiration=position.expiration,
                        strike=position.strike,
                        right=position.right,
                        premium=premium,
                        entry_price=position.entry_price,
                        pnl=(premium - position.entry_price) * 100 * position.quantity,
                    )
                # allowClosePositions is bypassed on expiration day — exercise must be avoided.
                if not expiring_today and not symbol_settings.get("allowClosePositions", True):
                    self._log_event(
                        "close_positions_disabled",
                        "Skipped close: closing positions is disabled.",
                        symbol=position.symbol,
                        strategy_id=position.strategy_id,
                        signal_id=position.signal_id,
                        premium=premium,
                        target_price=dynamic_target,
                    )
                    continue
                # ── Check for pending close order from a previous cycle ──
                _close_fill_confirmed = False
                _close_trade = None
                _force_market_replace = False
                _pending_entry = self._pending_closes.get(position.signal_id)
                if _pending_entry is not None:
                    _prev_trade, _submit_ts = _pending_entry
                    _prev_status = getattr(getattr(_prev_trade, "orderStatus", None), "status", "") or ""
                    if _prev_status == "Filled":
                        _avg_fill = getattr(getattr(_prev_trade, "orderStatus", None), "avgFillPrice", None)
                        if _avg_fill:
                            premium = float(_avg_fill)
                        _close_fill_confirmed = True
                        _close_trade = _prev_trade
                        self._pending_closes.pop(position.signal_id, None)
                        self._log_event(
                            "close_fill_confirmed_late",
                            f"Previous close order filled (${premium:.2f}) between cycles.",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            fill_price=premium,
                        )
                    elif _prev_status in ("Submitted", "PreSubmitted"):
                        _stale_timeout = float(symbol_settings.get("closePendingTimeoutSecs", 120))
                        _elapsed = time.time() - _submit_ts
                        if _elapsed < _stale_timeout:
                            # Actively working — don't place a duplicate, keep waiting
                            self._log_event(
                                "close_order_pending",
                                f"Previous close order still {_prev_status} — waiting for fill ({_elapsed:.0f}s/{_stale_timeout:.0f}s).",
                                symbol=position.symbol,
                                strategy_id=position.strategy_id,
                                signal_id=position.signal_id,
                                order_status=_prev_status,
                            )
                            continue
                        else:
                            # Stale limit order — cancel and re-place as market
                            await cancel_order(_prev_trade)
                            self._pending_closes.pop(position.signal_id, None)
                            _force_market_replace = True
                            self._log_event(
                                "close_order_stale_cancelled",
                                f"Close limit order stuck {_prev_status} for {_elapsed:.0f}s — cancelling to re-place as market.",
                                symbol=position.symbol,
                                strategy_id=position.strategy_id,
                                signal_id=position.signal_id,
                                elapsed_secs=_elapsed,
                                timeout_secs=_stale_timeout,
                            )
                    elif _prev_status == "Inactive":
                        # IB won't execute this order (illiquid/no buyers).
                        # Cancel it and force-close at last known premium.
                        await cancel_order(_prev_trade)
                        self._pending_closes.pop(position.signal_id, None)
                        self._log_event(
                            "close_force_inactive",
                            f"Close order stuck Inactive — force-closing at last premium ${premium:.2f}.",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            premium=premium,
                        )
                        _close_fill_confirmed = True
                        _close_trade = _prev_trade
                    else:
                        # Cancelled/Error — clean up and re-place
                        self._pending_closes.pop(position.signal_id, None)

                # ── Place new close order if no confirmed fill yet ──
                if not _close_fill_confirmed:
                    try:
                        close_payload = {
                            "symbol": position.symbol,
                            "expiration": position.expiration,
                            "strike": position.strike,
                            "right": position.right,
                            "action": "SELL",
                            "quantity": position.quantity,
                            "exchange": "SMART",
                            "currency": "USD",
                        }
                        self._log_event(
                            "order_request",
                            "Submitting order to IBKR.",
                            **close_payload,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                        )
                        _use_mkt = bool(symbol_settings.get("useMarketOrders", True))
                        # On expiration-day forced closes always use market to guarantee fill.
                        if expiring_today:
                            _use_mkt = True
                        # Stop loss closes always use market for fast execution.
                        if _stop_loss_triggered:
                            _use_mkt = True
                        # Trailing stop exits: use limit order at trail stop price when enabled.
                        _trail_limit_price: Optional[float] = None
                        if should_close_trail and not expiring_today:
                            _use_limit_trail = bool(symbol_settings.get("useLimitOrdersForTrailExit", True))
                            if _use_limit_trail:
                                _use_mkt = False
                                _trail_limit_price = trail_stop_price
                        # Stale close order re-place: override to market to guarantee fill.
                        if _force_market_replace:
                            _use_mkt = True
                            _trail_limit_price = None
                        _close_account = _resolve_account(symbol_settings)
                        _limit_timeout_close = float(symbol_settings.get("closeLimitTimeoutSecs", 5))
                        order_info = await _place_with_limit_fallback(
                            quote=quote,
                            use_market_orders=_use_mkt,
                            timeout_secs=_limit_timeout_close,
                            log_event_fn=self._log_event,
                            log_kwargs={
                                "symbol": position.symbol,
                                "strategy_id": position.strategy_id,
                                "signal_id": position.signal_id,
                            },
                            limit_price=_trail_limit_price,
                            symbol=position.symbol,
                            expiration=position.expiration,
                            strike=position.strike,
                            right=position.right,
                            action="SELL",
                            quantity=position.quantity,
                            account=_close_account,
                        )
                    except Exception as exc:
                        logger.error(f"Failed to close order for {position.symbol}: {exc}")
                        if expiring_today:
                            expiry_failed.append(position.symbol)
                        self._log_event(
                            "order_failed",
                            "Order placement failed.",
                            symbol=position.symbol,
                            expiration=position.expiration,
                            strike=position.strike,
                            right=position.right,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                            error=str(exc),
                        )
                        continue
                    self._log_event(
                        "order_submitted",
                        "Order submitted to IBKR.",
                        symbol=position.symbol,
                        expiration=position.expiration,
                        strike=position.strike,
                        right=position.right,
                        strategy_id=position.strategy_id,
                        signal_id=position.signal_id,
                        order_id=order_info.get("order_id") if isinstance(order_info, dict) else None,
                        status=order_info.get("status") if isinstance(order_info, dict) else None,
                    )
                    if isinstance(order_info, dict) and order_info.get("trade") is not None:
                        self._attach_trade_status(order_info["trade"], close_payload)

                    # ── Wait briefly for fill confirmation ──
                    # Keep this short (5s) so one slow fill doesn't block
                    # all other position closes. If unconfirmed, the position
                    # stays open and will be retried on the next TP cycle.
                    _close_fill_wait = float(symbol_settings.get("closeFillWaitSecs", 15))
                    _close_trade = order_info.get("trade") if isinstance(order_info, dict) else None
                    if _close_trade is not None:
                        _close_deadline = time.time() + _close_fill_wait
                        while time.time() < _close_deadline:
                            _close_fill_status = (
                                getattr(getattr(_close_trade, "orderStatus", None), "status", "") or ""
                            )
                            if _close_fill_status == "Filled":
                                _close_fill_confirmed = True
                                break
                            if _close_fill_status == "Inactive":
                                # IB won't execute — stop waiting immediately
                                break
                            await asyncio.sleep(0.5)
                        if not _close_fill_confirmed:
                            _close_fill_status = (
                                getattr(getattr(_close_trade, "orderStatus", None), "status", "") or "unknown"
                            )
                            if _close_fill_status == "Inactive":
                                # IB won't fill this order (illiquid/no buyers).
                                # Cancel it and force-close at last known premium.
                                await cancel_order(_close_trade)
                                _close_fill_confirmed = True
                                self._log_event(
                                    "close_force_inactive",
                                    f"Close order Inactive — force-closing at last premium ${premium:.2f}.",
                                    symbol=position.symbol,
                                    strategy_id=position.strategy_id,
                                    signal_id=position.signal_id,
                                    premium=premium,
                                )
                            else:
                                logger.warning(
                                    "Close order for %s not confirmed as Filled within %.0fs (status=%s).",
                                    position.symbol, _close_fill_wait, _close_fill_status,
                                )
                                self._log_event(
                                    "close_fill_timeout",
                                    f"Close order not filled within {_close_fill_wait:.0f}s (status={_close_fill_status}). Will retry next cycle.",
                                    symbol=position.symbol,
                                    strategy_id=position.strategy_id,
                                    signal_id=position.signal_id,
                                )
                    # Use actual fill price if confirmed
                    if _close_fill_confirmed and _close_trade is not None:
                        _avg_fill = getattr(getattr(_close_trade, "orderStatus", None), "avgFillPrice", None)
                        if _avg_fill:
                            premium = float(_avg_fill)

                    if not _close_fill_confirmed:
                        # Track the Trade object so next cycle checks its status
                        # instead of placing a duplicate order.
                        if _close_trade is not None:
                            self._pending_closes[position.signal_id] = (_close_trade, time.time())
                        self._log_event(
                            "close_retry_scheduled",
                            "Close order unconfirmed — position kept open for retry on next cycle.",
                            symbol=position.symbol,
                            strategy_id=position.strategy_id,
                            signal_id=position.signal_id,
                        )
                        continue

                # Fill confirmed — compute P&L, write CLOSE entry, remove position.
                pnl = (premium - position.entry_price) * 100 * position.quantity
                pnl_pct = (premium - position.entry_price) / position.entry_price
                iv_at_exit = quote.get("iv") if quote else None

                # MFE/MAE from underlying 1m bars between open and now
                mfe_pct: Optional[float] = None
                mae_pct: Optional[float] = None
                close_ts = int(time.time())
                bars_cache = self._cache_get(position.symbol)
                if bars_cache and position.open_ts > 0:
                    hold_bars = [b for b in bars_cache.get("bars1m", []) if b["time"] >= position.open_ts]
                    if len(hold_bars) >= 1:
                        entry_close = hold_bars[0]["close"]
                        if entry_close:
                            highs = [b["high"] for b in hold_bars]
                            lows = [b["low"] for b in hold_bars]
                            if position.right == "C":
                                mfe_pct = round((max(highs) - entry_close) / entry_close * 100, 3)
                                mae_pct = round((min(lows) - entry_close) / entry_close * 100, 3)
                            else:
                                mfe_pct = round((entry_close - min(lows)) / entry_close * 100, 3)
                                mae_pct = round((entry_close - max(highs)) / entry_close * 100, 3)

                # Determine close reason before logging
                if _max_hold_exceeded:
                    _hold_min = (int(time.time()) - position.open_ts) / 60
                    close_reason = f"Max hold time exceeded ({_hold_min:.0f}m / {_max_hold_minutes}m limit)."
                elif _time_exit_forced:
                    close_reason = f"Time exit forced at {_time_exit_str} ET."
                elif expiring_today and pnl < 0:
                    close_reason = "Closed before expiration (forced)."
                elif _stop_loss_triggered:
                    close_reason = f"Stop loss triggered at ${premium:.2f} ({_stop_loss_pct*100:.0f}% below entry ${position.entry_price:.2f})."
                elif _stale_triggered:
                    _hold_min = (int(time.time()) - position.open_ts) / 60
                    _gain_pct = (premium - position.entry_price) / position.entry_price * 100 if position.entry_price > 0 else 0
                    close_reason = f"Stale position closed: {_hold_min:.0f}m held, {_gain_pct:+.1f}% gain (min {_stale_min_gain_pct*100:.0f}% required after {_stale_after_mins:.0f}m)."
                elif should_close_trail:
                    close_reason = f"Trailing stop triggered (peak: ${position.high_water_mark:.2f}, trail: ${trail_stop_price:.2f})."
                else:
                    close_reason = "Closed position at target."

                append_entry(
                    {
                        "timestamp": close_ts,
                        "symbol": position.symbol,
                        "action": "SELL",
                        "right": position.right,
                        "expiration": position.expiration,
                        "strike": position.strike,
                        "quantity": position.quantity,
                        "price": premium,
                        "status": order_info.get("status") if isinstance(order_info, dict) else None,
                        "strategy_id": position.strategy_id,
                        "signal_id": position.signal_id,
                        "position_id": position.position_id,
                        "type": "CLOSE",
                        "mode": position.mode or ib_manager.active_mode,
                        "fill_confirmed": True,
                        "pnl": pnl,
                        "pnl_pct": pnl_pct,
                        "entry_price": position.entry_price,
                        "target_price": position.target_price,
                        "iv_at_exit": iv_at_exit,
                        "mfe_pct": mfe_pct,
                        "mae_pct": mae_pct,
                        "close_reason": close_reason,
                    }
                )
                # Capture exit snapshot for analysis
                try:
                    _exit_bars1m = bars_cache.get("bars1m", []) if bars_cache else []
                    _exit_price_5m_ago = _exit_bars1m[-6]["close"] if len(_exit_bars1m) >= 6 else None
                    _exit_underlying = _exit_bars1m[-1]["close"] if _exit_bars1m else None
                    _exit_minutes_to_close = 0
                    if _exit_bars1m:
                        _exit_now_ts = _exit_bars1m[-1]["time"]
                        _exit_ny = datetime.fromtimestamp(_exit_now_ts, ZoneInfo("America/New_York"))
                        _exit_close_ts = _exit_ny.replace(hour=16, minute=0, second=0).timestamp()
                        _exit_minutes_to_close = max(0, int((_exit_close_ts - _exit_now_ts) / 60))
                    # Compute ADX/DI at exit using same bars as entry
                    _exit_adx, _exit_pdi, _exit_mdi = None, None, None
                    _exit_di_gap = None
                    _exit_adx_tf = effective_settings.get("chopFilterTimeframe", "5m")
                    _exit_adx_bars = {
                        "1m": _exit_bars1m,
                        "5m": bars_cache.get("bars5m", []) if bars_cache else [],
                        "15m": bars_cache.get("bars15m", []) if bars_cache else [],
                    }.get(_exit_adx_tf, [])
                    if _exit_adx_bars:
                        _exit_adx, _exit_pdi, _exit_mdi = _compute_adx(_exit_adx_bars[:-1] if len(_exit_adx_bars) > 1 else _exit_adx_bars)
                        _exit_di_gap = abs(_exit_pdi - _exit_mdi) if _exit_pdi is not None else None
                    _exit_bid = quote.get("bid") if quote else None
                    _exit_ask = quote.get("ask") if quote else None
                    _exit_mid = round((_exit_bid + _exit_ask) / 2, 2) if _exit_bid and _exit_ask else None
                    _hold_secs = close_ts - position.open_ts if position.open_ts > 0 else None
                    append_snapshot({
                        "type": "exit",
                        "timestamp": close_ts,
                        "symbol": position.symbol,
                        "expiration": position.expiration,
                        "right": position.right,
                        "underlying_price": _exit_underlying,
                        "signal_id": position.signal_id,
                        "strategy_id": position.strategy_id,
                        "position_id": position.position_id,
                        "minutes_to_close": _exit_minutes_to_close,
                        "hold_time_secs": _hold_secs,
                        "entry_price": position.entry_price,
                        "exit_premium": premium,
                        "exit_bid": _exit_bid,
                        "exit_ask": _exit_ask,
                        "exit_mid": _exit_mid,
                        "exit_slippage": round(premium - _exit_mid, 2) if _exit_mid else None,
                        "exit_delta": quote.get("delta") if quote else None,
                        "exit_gamma": quote.get("gamma") if quote else None,
                        "exit_theta": quote.get("theta") if quote else None,
                        "exit_vega": quote.get("vega") if quote else None,
                        "exit_iv": iv_at_exit,
                        "exit_volume": quote.get("volume") if quote else None,
                        "high_water_mark": position.high_water_mark,
                        "trail_stop_price": trail_stop_price if use_trailing else None,
                        "pnl": pnl,
                        "pnl_pct": pnl_pct,
                        "mfe_pct": mfe_pct,
                        "mae_pct": mae_pct,
                        "close_reason": close_reason,
                        "adx": round(_exit_adx, 2) if _exit_adx is not None else None,
                        "plus_di": round(_exit_pdi, 2) if _exit_pdi is not None else None,
                        "minus_di": round(_exit_mdi, 2) if _exit_mdi is not None else None,
                        "di_gap": round(_exit_di_gap, 2) if _exit_di_gap is not None else None,
                        "momentum_5m": round(_exit_underlying - _exit_price_5m_ago, 2) if _exit_underlying and _exit_price_5m_ago else None,
                    })
                except Exception:
                    logger.warning("Failed to write exit snapshot for %s", position.symbol, exc_info=True)

                self._open_positions.pop(position.position_id, None)
                self._pending_closes.pop(position.signal_id, None)
                self._invalidate_daily_loss_cache()
                if expiring_today:
                    expiry_closed.append(position.symbol)

                self._log_event(
                    "trade_close",
                    close_reason,
                    symbol=position.symbol,
                    strategy_id=position.strategy_id,
                    signal_id=position.signal_id,
                    right=position.right,
                    strike=position.strike,
                    expiration=position.expiration,
                    premium=premium,
                    expiry_forced=expiring_today,
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                )
            except Exception as exc:
                logger.error(f"Failed to check open position {position.symbol}: {exc}")

        # After processing all positions, emit a summary if any expiry closes were attempted.
        if expiry_closed or expiry_failed:
            all_ok = len(expiry_failed) == 0
            msg = (
                f"Expiry close complete: {len(expiry_closed)} closed"
                + (f", {len(expiry_failed)} failed: {', '.join(expiry_failed)}" if expiry_failed else "")
                + "."
            )
            self._log_event(
                "expiry_close_summary",
                msg,
                closed=expiry_closed,
                failed=expiry_failed,
                all_ok=all_ok,
            )


auto_trader = AutoTrader(interval_seconds=settings.AUTO_TRADE_INTERVAL_SECONDS)
