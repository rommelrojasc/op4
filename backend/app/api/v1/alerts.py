"""TradingView alert webhook endpoints.

`POST /alerts/webhook` accepts ANY body (JSON or plain text) so we can capture
whatever a given indicator / alert message actually sends. `GET /alerts` serves
stored alerts to the frontend, optionally filtered by symbol.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Request, Query
from app.services.tv_alerts import append_alert, read_alerts, clear_alerts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.post("/webhook")
async def tradingview_webhook(
    request: Request,
    symbol: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
):
    """Receive a TradingView alert. Body may be JSON or plain text.

    `symbol`/`action` query params (encoded in the webhook URL) override or fill
    in what we parse from the body — useful when the indicator's message is a
    fixed plain-text string that carries no symbol.
    """
    raw = (await request.body()).decode("utf-8", errors="replace")
    content_type = request.headers.get("content-type")
    overrides = {}
    if symbol:
        overrides["symbol"] = symbol.upper()
    if action:
        overrides["action"] = action
    entry = append_alert(raw, content_type=content_type, overrides=overrides)
    logger.info(f"TradingView alert received: {raw[:200]}")
    return {"status": "ok", "stored": entry}


@router.get("")
async def list_alerts(
    limit: int = Query(200, ge=1, le=1000),
    symbol: Optional[str] = Query(None),
):
    """Return stored alerts, most-recent last. Filter by symbol if provided."""
    return {"alerts": read_alerts(limit=limit, symbol=symbol)}


@router.delete("")
async def delete_alerts():
    """Clear all stored alerts."""
    clear_alerts()
    return {"status": "ok"}
