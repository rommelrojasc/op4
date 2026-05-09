from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, Dict


@dataclass
class IbMetrics:
    total_requests: int = 0
    total_errors: int = 0
    in_flight: int = 0
    last_kind: str | None = None
    last_symbol: str | None = None
    last_duration_ms: float | None = None
    avg_duration_ms: float | None = None
    last_response_items: int | None = None
    last_error: str | None = None
    last_status: str | None = None
    updated_at: float = field(default_factory=time.time)


_metrics = IbMetrics()
_lock = Lock()


def record_start(kind: str, symbol: str | None) -> float:
    start = time.time()
    with _lock:
        _metrics.total_requests += 1
        _metrics.in_flight += 1
        _metrics.last_kind = kind
        _metrics.last_symbol = symbol
        _metrics.last_status = "in_flight"
        _metrics.updated_at = time.time()
    return start


def record_end(
    start: float,
    success: bool,
    response_items: int | None = None,
    error: str | None = None,
) -> None:
    duration_ms = (time.time() - start) * 1000
    with _lock:
        _metrics.in_flight = max(0, _metrics.in_flight - 1)
        _metrics.last_duration_ms = duration_ms
        prev_avg = _metrics.avg_duration_ms
        if prev_avg is None:
            _metrics.avg_duration_ms = duration_ms
        else:
            _metrics.avg_duration_ms = (prev_avg * 0.9) + (duration_ms * 0.1)
        _metrics.last_response_items = response_items
        _metrics.last_status = "ok" if success else "error"
        _metrics.last_error = None if success else error
        if not success:
            _metrics.total_errors += 1
        _metrics.updated_at = time.time()


def snapshot() -> Dict[str, Any]:
    with _lock:
        return {
            "total_requests": _metrics.total_requests,
            "total_errors": _metrics.total_errors,
            "in_flight": _metrics.in_flight,
            "last_kind": _metrics.last_kind,
            "last_symbol": _metrics.last_symbol,
            "last_duration_ms": _metrics.last_duration_ms,
            "avg_duration_ms": _metrics.avg_duration_ms,
            "last_response_items": _metrics.last_response_items,
            "last_error": _metrics.last_error,
            "last_status": _metrics.last_status,
            "updated_at": _metrics.updated_at,
        }
