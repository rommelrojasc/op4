"""Shared progress state for optimizer and backtester."""
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)

optimizer_progress: Dict[str, Any] = {
    "running": False,
    "phase": "",
    "step": "",
    "pct": 0,
    "details": "",
    "log": [],
}


def _progress(phase: str, step: str, pct: int = 0, details: str = ""):
    optimizer_progress["running"] = True
    optimizer_progress["phase"] = phase
    optimizer_progress["step"] = step
    optimizer_progress["pct"] = pct
    optimizer_progress["details"] = details
    line = f"[{phase}] {step}" + (f" — {details}" if details else "")
    optimizer_progress["log"].append(line)
    if len(optimizer_progress["log"]) > 200:
        optimizer_progress["log"] = optimizer_progress["log"][-200:]
    logger.info(f"Optimizer: {line}")
