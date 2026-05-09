"""Trading service for placing paper option orders."""
import logging
import time
import asyncio
from datetime import datetime, timezone
from typing import Optional
from ib_insync import Option, Stock, Contract, MarketOrder, LimitOrder, Trade
from app.core.config import settings
from app.services.ib.gateway import ib_manager
from app.services.ib.metrics import record_start, record_end

logger = logging.getLogger(__name__)

_account_summary_lock = asyncio.Lock()
_last_account_summary: dict | None = None
_last_account_summary_at: float = 0.0
_ACCOUNT_SUMMARY_TTL_SEC = 30.0
_account_summary_items: dict[tuple, dict] = {}
_account_summary_started = False


def _on_account_summary(item):
    key = (getattr(item, "account", None), getattr(item, "tag", None), getattr(item, "currency", None))
    _account_summary_items[key] = {
        "account": getattr(item, "account", None),
        "tag": getattr(item, "tag", None),
        "value": getattr(item, "value", None),
        "currency": getattr(item, "currency", None),
    }


def _start_account_summary_sync(ib) -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    ib.reqAccountSummary()


def _stop_account_summary_sync(ib) -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    try:
        ib.cancelAccountSummary()
    except Exception:
        pass


async def start_account_summary_listener() -> None:
    global _account_summary_started
    if _account_summary_started:
        return
    ib = await ib_manager.get_primary_connection()
    try:
        ib.accountSummaryEvent += _on_account_summary
        _account_summary_started = True
        initial = await asyncio.wait_for(ib.reqAccountSummaryAsync(), timeout=10.0)
        if initial:
            for item in initial:
                _on_account_summary(item)
        logger.info("IB account summary listener started.")
    except asyncio.TimeoutError:
        logger.warning("IB account summary request timed out after 10s.")
    except Exception as exc:
        _account_summary_started = False
        logger.error("Failed to start account summary listener: %s", exc)


async def stop_account_summary_listener() -> None:
    global _account_summary_started
    if not _account_summary_started:
        return
    try:
        ib = await ib_manager.get_primary_connection()
        ib.accountSummaryEvent -= _on_account_summary
        ib.cancelAccountSummary()
    except Exception:
        pass
    _account_summary_started = False


def _fetch_account_summary_sync(ib, timeout: float = 2.0) -> list:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    ib.reqAccountSummary()
    summary: list = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        summary = list(ib.accountSummary())
        if summary:
            break
        ib.waitOnUpdate(timeout=0.2)
    ib.cancelAccountSummary()
    return summary


async def cancel_order(trade_obj: Trade) -> None:
    """Cancel an open order by its Trade object."""
    try:
        ib = await ib_manager.get_connection()
        ib.cancelOrder(trade_obj.order)
        await asyncio.sleep(0.5)
    except Exception as exc:
        logger.warning("cancel_order failed: %s", exc)


async def place_option_order(
    symbol: str,
    expiration: str,
    strike: float,
    right: str,
    action: str,
    quantity: int,
    exchange: str = "SMART",
    currency: str = "USD",
    con_id: Optional[int] = None,
    trading_class: Optional[str] = None,
    local_symbol: Optional[str] = None,
    multiplier: Optional[str] = None,
    limit_price: Optional[float] = None,
    account: Optional[str] = None,
) -> dict:
    if settings.IB_READONLY:
        raise RuntimeError("IB trading is disabled (IB_READONLY=True).")

    start = record_start("place_order", symbol)
    ib = await ib_manager.get_connection()
    if con_id:
        contract = Contract(
            conId=int(con_id),
            secType="OPT",
            symbol=symbol,
            lastTradeDateOrContractMonth=expiration.replace("-", ""),
            strike=float(strike),
            right=right,
            exchange=exchange,
            currency=currency,
            tradingClass=trading_class,
            localSymbol=local_symbol,
            multiplier=multiplier,
        )
    else:
        contract = Option(symbol, expiration.replace("-", ""), float(strike), right, exchange, currency=currency)
    await ib.qualifyContractsAsync(contract)

    order = LimitOrder(action, quantity, limit_price) if limit_price is not None else MarketOrder(action, quantity)
    # Account priority: explicit param > IB_ACCOUNT env > first managed account
    selected_account = account or settings.IB_ACCOUNT or None
    if not selected_account:
        managed = ib.managedAccounts()
        if managed:
            selected_account = managed[0]
    if selected_account:
        order.account = selected_account
    try:
        trade = ib.placeOrder(contract, order)
        # Yield to the event loop so ib-insync can flush the order to the socket.
        # Without this, placeOrder() queues the request internally but never
        # transmits it to IB Gateway before the function returns.
        await asyncio.sleep(0)
        status = getattr(trade.orderStatus, "status", "") or "Submitted"
        record_end(start, True, response_items=1)
        return {
            "order_id": trade.order.orderId,
            "status": status,
            "con_id": contract.conId,
            "trade": trade,
            "order_type": "LMT" if limit_price is not None else "MKT",
        }
    except Exception as exc:
        record_end(start, False, error=str(exc))
        raise


async def place_stock_order(
    symbol: str,
    action: str,
    quantity: int,
    exchange: str = "SMART",
    currency: str = "USD",
    account: Optional[str] = None,
) -> dict:
    if settings.IB_READONLY:
        raise RuntimeError("IB trading is disabled (IB_READONLY=True).")
    start = record_start("place_order", symbol)
    ib = await ib_manager.get_connection()
    contract = Stock(symbol, exchange, currency)
    await ib.qualifyContractsAsync(contract)
    order = MarketOrder(action, quantity)
    selected_account = account or settings.IB_ACCOUNT or None
    if not selected_account:
        managed = ib.managedAccounts()
        if managed:
            selected_account = managed[0]
    if selected_account:
        order.account = selected_account
    try:
        trade = ib.placeOrder(contract, order)
        await asyncio.sleep(0)
        status = getattr(trade.orderStatus, "status", "") or "Submitted"
        record_end(start, True, response_items=1)
        return {
            "order_id": trade.order.orderId,
            "status": status,
            "con_id": contract.conId,
            "trade": trade,
        }
    except Exception as exc:
        record_end(start, False, error=str(exc))
        raise


async def close_position(
    symbol: str,
    sec_type: str,
    quantity: float,
    exchange: str = "SMART",
    currency: str = "USD",
    expiration: Optional[str] = None,
    strike: Optional[float] = None,
    right: Optional[str] = None,
    account: Optional[str] = None,
) -> dict:
    """Close any position (stock or option) by placing a market order in the opposite direction."""
    action = "SELL" if quantity > 0 else "BUY"
    abs_qty = int(abs(quantity))
    if sec_type == "OPT":
        if not expiration or strike is None or not right:
            raise ValueError("expiration, strike, and right are required to close an option position.")
        return await place_option_order(
            symbol=symbol,
            expiration=expiration,
            strike=strike,
            right=right,
            action=action,
            quantity=abs_qty,
            exchange=exchange,
            currency=currency,
            account=account,
        )
    else:
        return await place_stock_order(
            symbol=symbol,
            action=action,
            quantity=abs_qty,
            exchange=exchange,
            currency=currency,
            account=account,
        )


async def get_open_positions(force: bool = False) -> list[dict]:
    start = record_start("positions", None)
    # Always use the primary client for portfolio reads — IB pushes
    # portfolio updates only to the client that placed the order or
    # subscribed to account updates, not to all pooled clients.
    ib = await ib_manager.get_primary_connection()
    if force:
        # Ask IB Gateway to push a fresh portfolio snapshot before we read it.
        acct = ""
        managed = ib.managedAccounts()
        if managed:
            acct = managed[0]
        try:
            await asyncio.wait_for(ib.reqAccountUpdatesAsync(True), timeout=4.0)
        except asyncio.TimeoutError:
            pass  # Fall through to whatever is cached
    portfolio_items = ib.portfolio()
    result = []
    today = datetime.now(timezone.utc).date()
    for item in portfolio_items:
        contract = item.contract
        quantity = float(item.position)
        avg_cost = float(item.averageCost)
        market_price = float(item.marketPrice) if item.marketPrice is not None else None
        market_value = float(item.marketValue) if item.marketValue is not None else None
        unrealized_pnl = float(item.unrealizedPNL) if item.unrealizedPNL is not None else None
        realized_pnl = float(item.realizedPNL) if item.realizedPNL is not None else None

        expiration_raw = getattr(contract, "lastTradeDateOrContractMonth", None) or None
        right = getattr(contract, "right", None) or None
        strike = getattr(contract, "strike", None) or None
        multiplier_raw = getattr(contract, "multiplier", None) or None
        multiplier = float(multiplier_raw) if multiplier_raw else None

        # Days to expiry (options only)
        days_to_expiry = None
        if expiration_raw:
            try:
                exp_date = datetime.strptime(expiration_raw[:8], "%Y%m%d").date()
                days_to_expiry = (exp_date - today).days
            except ValueError:
                pass

        # Cost basis and P&L %
        cost_basis = abs(quantity) * avg_cost if avg_cost else None
        pnl_pct = (unrealized_pnl / cost_basis * 100) if (cost_basis and unrealized_pnl is not None) else None

        result.append(
            {
                "symbol": contract.symbol,
                "sec_type": contract.secType,
                "local_symbol": getattr(contract, "localSymbol", None) or None,
                "exchange": getattr(contract, "exchange", None) or None,
                "currency": getattr(contract, "currency", None) or None,
                "con_id": getattr(contract, "conId", None) or None,
                "multiplier": multiplier,
                "quantity": quantity,
                "avg_cost": avg_cost,
                "market_price": market_price,
                "market_value": market_value,
                "unrealized_pnl": unrealized_pnl,
                "realized_pnl": realized_pnl,
                "cost_basis": cost_basis,
                "pnl_pct": pnl_pct,
                "right": right,
                "strike": strike,
                "expiration": expiration_raw,
                "days_to_expiry": days_to_expiry,
            }
        )
    record_end(start, True, response_items=len(result))
    return result


async def close_all_positions(account: Optional[str] = None) -> list[dict]:
    """Close all open IBKR positions at market price."""
    positions = await get_open_positions()
    results = []
    for pos in positions:
        if pos["quantity"] == 0:
            continue
        try:
            await close_position(
                symbol=pos["symbol"],
                sec_type=pos["sec_type"],
                quantity=pos["quantity"],
                exchange=pos.get("exchange") or "SMART",
                currency=pos.get("currency") or "USD",
                expiration=pos.get("expiration"),
                strike=pos.get("strike"),
                right=pos.get("right"),
                account=account,
            )
            results.append({"symbol": pos["symbol"], "sec_type": pos["sec_type"], "status": "submitted"})
        except Exception as exc:
            results.append({"symbol": pos["symbol"], "sec_type": pos["sec_type"], "status": "error", "error": str(exc)})
    return results


async def get_account_summary(account: Optional[str] = None) -> dict:
    global _last_account_summary, _last_account_summary_at
    # Resolve the target account: explicit param wins, then env setting
    target_account = (account or "").strip() or (settings.IB_ACCOUNT or "").strip() or None
    async with _account_summary_lock:
        now = time.time()
        # Invalidate cache if the requested account differs from the last cached one
        cached_account = (_last_account_summary or {}).get("account")
        cache_valid = (
            _last_account_summary
            and (now - _last_account_summary_at) < _ACCOUNT_SUMMARY_TTL_SEC
            and cached_account == target_account
        )
        if cache_valid:
            return _last_account_summary
        start = record_start("account_summary", None)
        ib = await ib_manager.get_primary_connection()
        try:
            if not _account_summary_started:
                await start_account_summary_listener()
            summary = list(_account_summary_items.values())
        except Exception as exc:
            record_end(start, False, error=str(exc))
            if _last_account_summary:
                return _last_account_summary
            raise
        finally:
            try:
                ib.cancelAccountSummary()
            except Exception:
                pass
    available = None
    total_cash = None
    net_liq = None
    currency = None
    if not summary:
        logger.warning("IB account summary returned no items.")
    else:
        def _tag(item):
            if isinstance(item, dict):
                return item.get("tag")
            return getattr(item, "tag", None)
        tags_seen = {_tag(item) for item in summary}
        logger.info("IB account summary items=%s tags=%s target_account=%s", len(summary), sorted(tags_seen), target_account)

    def pick_best(tag_name: str) -> tuple[Optional[float], Optional[str]]:
        best_score = -1
        best_value = None
        best_currency = None
        for item in summary:
            if isinstance(item, dict):
                item_tag = item.get("tag")
                item_account = item.get("account")
                item_currency = item.get("currency")
                item_value = item.get("value")
            else:
                item_tag = getattr(item, "tag", None)
                item_account = getattr(item, "account", None)
                item_currency = getattr(item, "currency", None)
                item_value = getattr(item, "value", None)
            if item_tag != tag_name:
                continue
            if item_value in (None, ""):
                continue
            # When a specific account is requested, skip all other per-account rows.
            # Only allow "All" / aggregate rows if no specific account is set.
            if target_account:
                if item_account not in (target_account, None, "", "All"):
                    continue
                score = 0
                if item_account == target_account:
                    score += 4  # prefer exact match over aggregate "All" rows
                if item_currency == "USD":
                    score += 2
                elif item_currency == "BASE":
                    score += 1
            else:
                score = 0
                if item_account in (None, "", "All"):
                    score += 2
                if item_currency == "USD":
                    score += 2
                elif item_currency == "BASE":
                    score += 1
            if score > best_score:
                best_score = score
                best_value = float(item_value)
                best_currency = item_currency
        return best_value, best_currency

    available, currency = pick_best("AvailableFunds")
    total_cash, cash_currency = pick_best("TotalCashValue")
    if total_cash is not None:
        currency = cash_currency or currency
    net_liq, net_currency = pick_best("NetLiquidation")
    if net_liq is not None:
        currency = net_currency or currency
    settle_cash, _ = pick_best("SettledCash")  # live accounts only; null on paper
    result = {
        "account": target_account,
        "available_funds": available,
        "total_cash_value": total_cash,
        "net_liquidation": net_liq,
        "settle_cash": settle_cash,
        "currency": currency,
    }
    _last_account_summary = result
    _last_account_summary_at = time.time()
    record_end(start, True, response_items=1)
    return result


async def _get_live_account_tag(tags: list[str]) -> Optional[float]:
    """
    Read a live account summary tag from the streaming _account_summary_items dict.

    `tags` is an ordered preference list — earlier entries score higher.
    Starts the listener if not already running. No TTL cache.
    """
    if not _account_summary_started:
        try:
            await start_account_summary_listener()
            await asyncio.sleep(1.5)
        except Exception as exc:
            logger.warning("_get_live_account_tag: could not start listener: %s", exc)
            return None

    account = settings.IB_ACCOUNT
    best_score = -1
    best_value: Optional[float] = None
    for item in list(_account_summary_items.values()):
        tag  = item.get("tag")     if isinstance(item, dict) else getattr(item, "tag", None)
        val  = item.get("value")   if isinstance(item, dict) else getattr(item, "value", None)
        acct = item.get("account") if isinstance(item, dict) else getattr(item, "account", None)
        curr = item.get("currency") if isinstance(item, dict) else getattr(item, "currency", None)
        if tag not in tags or val in (None, ""):
            continue
        score = (len(tags) - tags.index(tag)) * 10  # earlier in list = higher base score
        if account and acct == account:
            score += 4
        elif acct in (None, "", "All"):
            score += 2
        if curr == "USD":
            score += 2
        elif curr == "BASE":
            score += 1
        if score > best_score:
            best_score = score
            try:
                best_value = float(val)
            except (ValueError, TypeError):
                pass
    return best_value


async def get_settle_cash() -> Optional[float]:
    """
    Settled cash available for trading without GFV risk.
    Live accounts: SettledCash tag.
    Paper accounts: falls back to TotalCashValue (no settlement tracking).
    """
    return await _get_live_account_tag(["SettledCash", "TotalCashValue"])


async def get_available_funds() -> Optional[float]:
    """
    Available funds after margin requirements (AvailableFunds tag).
    Spending more than this risks a margin call.
    """
    return await _get_live_account_tag(["AvailableFunds"])


_EPOCH_TS = 0  # sentinel for "no real time"


def _extract_trade_timestamp(trade: Trade) -> Optional[int]:
    # 1. Use the most recent fill time (most accurate for completed orders)
    fills = getattr(trade, "fills", None)
    if fills:
        try:
            ts = int(fills[-1].time.timestamp())
            if ts > 86400:  # guard against epoch default (1970-01-01)
                return ts
        except Exception:
            pass
    # 2. Fall back to last log entry time
    log = getattr(trade, "log", None)
    if log:
        try:
            ts = int(log[-1].time.timestamp())
            if ts > 86400:
                return ts
        except Exception:
            pass
    # 3. Fall back to order.time
    order = getattr(trade, "order", None)
    order_time = getattr(order, "time", None)
    if order_time:
        try:
            ts = int(order_time.timestamp())
            if ts > 86400:
                return ts
        except Exception:
            pass
    return None


def _extract_order_snapshot(trade: Trade) -> dict:
    contract = getattr(trade, "contract", None)
    order = getattr(trade, "order", None)
    status = getattr(trade, "orderStatus", None)
    return {
        "timestamp": _extract_trade_timestamp(trade),
        "symbol": getattr(contract, "symbol", None),
        "sec_type": getattr(contract, "secType", None),
        "exchange": getattr(contract, "exchange", None),
        "currency": getattr(contract, "currency", None),
        "action": getattr(order, "action", None),
        "right": getattr(contract, "right", None),
        "strike": getattr(contract, "strike", None),
        "expiration": getattr(contract, "lastTradeDateOrContractMonth", None),
        "quantity": getattr(order, "totalQuantity", None),
        "filled": getattr(status, "filled", None),
        "avg_fill_price": getattr(status, "avgFillPrice", None),
        "last_fill_price": getattr(status, "lastFillPrice", None),
        "status": getattr(status, "status", None),
        "order_type": getattr(order, "orderType", None),
        "limit_price": getattr(order, "lmtPrice", None),
        "aux_price": getattr(order, "auxPrice", None),
        "order_id": getattr(order, "orderId", None),
        "perm_id": getattr(order, "permId", None),
        "client_id": getattr(order, "clientId", None),
    }


async def get_ib_orders_history(limit: int = 200) -> list[dict]:
    start = record_start("ib_orders", None)
    ib = await ib_manager.get_primary_connection()
    trades: list[Trade] = []
    try:
        try:
            completed = await asyncio.wait_for(
                ib.reqCompletedOrdersAsync(apiOnly=False), timeout=10.0
            )
            if completed:
                trades.extend(completed)
        except asyncio.TimeoutError:
            logger.warning("reqCompletedOrdersAsync timed out after 10s, using open trades only.")
        except Exception:
            completed = ib.reqCompletedOrders() if hasattr(ib, "reqCompletedOrders") else []
            if completed:
                trades.extend(completed)
    except Exception as exc:
        record_end(start, False, error=str(exc))
        raise

    try:
        trades.extend(ib.openTrades())
    except Exception:
        pass

    snapshots = [_extract_order_snapshot(trade) for trade in trades]

    # Enrich timestamps using execution records (reqExecutions provides fill time per permId)
    try:
        fills = await asyncio.wait_for(ib.reqExecutionsAsync(), timeout=8.0)
        # Build permId → latest fill timestamp map
        perm_to_ts: dict[int, int] = {}
        for fill in fills:
            ex = getattr(fill, "execution", None)
            perm_id = getattr(ex, "permId", None) if ex else None
            fill_time = getattr(fill, "time", None) or (getattr(ex, "time", None) if ex else None)
            if perm_id and fill_time:
                try:
                    ts = int(fill_time.timestamp())
                    if ts > 86400:
                        existing = perm_to_ts.get(perm_id, 0)
                        if ts > existing:
                            perm_to_ts[perm_id] = ts
                except Exception:
                    pass
        # Apply to snapshots that still have no timestamp
        for snap in snapshots:
            if snap.get("timestamp") is None:
                perm_id = snap.get("perm_id")
                if perm_id and perm_id in perm_to_ts:
                    snap["timestamp"] = perm_to_ts[perm_id]
    except Exception as exc:
        logger.debug(f"reqExecutions for timestamp enrichment failed: {exc}")

    snapshots.sort(key=lambda item: item.get("timestamp") or 0, reverse=True)
    if limit:
        snapshots = snapshots[:limit]
    record_end(start, True, response_items=len(snapshots))
    return snapshots
