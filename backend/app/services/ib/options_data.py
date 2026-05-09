"""Options data service for fetching option chains from IB."""
import asyncio
import logging
import math
from datetime import datetime, time as dt_time
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo
from ib_insync import Stock, Index, Option
from app.services.ib.gateway import ib_manager
from app.services.ib.metrics import record_start, record_end

logger = logging.getLogger(__name__)

# Symbols that are indices (not stocks/ETFs) and need Index contract + CBOE exchange
INDEX_SYMBOLS = {"SPX", "VIX", "NDX", "RUT"}


async def get_option_chain(symbol: str) -> List[Dict[str, List[float]]]:
    """
    Fetch option chain expirations and strikes for a symbol.

    Returns:
        List of {date, strikes} dictionaries.
    """
    try:
        start = record_start("option_chain", symbol)
        ib = await ib_manager.get_connection()
        if symbol.upper() in INDEX_SYMBOLS:
            contract = Index(symbol, "CBOE", "USD")
            sec_type = "IND"
        else:
            contract = Stock(symbol, "SMART", "USD")
            sec_type = "STK"
        logger.info("Options: requesting chain for %s (secType=%s).", symbol, sec_type)
        await ib.qualifyContractsAsync(contract)

        chains = await ib.reqSecDefOptParamsAsync(symbol, "", sec_type, contract.conId)
        if not chains:
            logger.info("Options: no chain returned for %s.", symbol)
            return []

        expirations: Dict[str, set] = {}
        for chain in chains:
            for exp in chain.expirations:
                # IB returns YYYYMMDD; format to YYYY-MM-DD
                if len(exp) == 8:
                    date = f"{exp[0:4]}-{exp[4:6]}-{exp[6:8]}"
                else:
                    date = exp
                if date not in expirations:
                    expirations[date] = set()
                expirations[date].update(chain.strikes)

        result = []
        for date in sorted(expirations.keys()):
            strikes = sorted([float(s) for s in expirations[date]])
            result.append({"date": date, "strikes": strikes})

        logger.info(
            "Options: chain for %s with %s expiration(s).",
            symbol,
            len(result),
        )
        record_end(start, True, response_items=len(result))
        return result
    except Exception as e:
        logger.error(f"Error fetching option chain for {symbol}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        raise


async def get_batch_option_quotes(
    positions: List[Dict[str, str]],
) -> Dict[str, Dict[str, Optional[float]]]:
    """Fetch quotes for multiple positions in a single IBKR round-trip.

    Args:
        positions: list of dicts with keys: symbol, expiration, strike, right

    Returns:
        Dict keyed by 'symbol-expiration-strike-right' → quote dict with
        last, bid, ask, iv, delta, etc.
    """
    if not positions:
        return {}

    try:
        start = record_start("batch_option_quotes", f"{len(positions)} positions")
        ib = await ib_manager.get_connection()

        def is_market_open_ny() -> bool:
            now = datetime.now(ZoneInfo("America/New_York"))
            if now.weekday() >= 5:
                return False
            open_time = dt_time(9, 30)
            close_time = dt_time(16, 0)
            return open_time <= now.time() <= close_time

        # Set market data type once for the batch
        ib.reqMarketDataType(1 if is_market_open_ny() else 3)

        # Build one Option contract per position
        contracts = []
        key_map: Dict[int, str] = {}  # index → lookup key
        for i, pos in enumerate(positions):
            sym = pos["symbol"]
            exp = pos["expiration"].replace("-", "")
            strike = float(pos["strike"])
            right = pos["right"]
            exchange = "CBOE" if sym.upper() in INDEX_SYMBOLS else "SMART"
            contracts.append(Option(sym, exp, strike, right, exchange))
            key_map[i] = f"{sym}-{pos['expiration']}-{pos['strike']}-{right}"

        logger.info("Batch quotes: qualifying %d contracts...", len(contracts))
        qualified = await ib.qualifyContractsAsync(*contracts)

        # Map qualified contracts back to their keys
        qualified_with_keys: List[tuple] = []
        for i, con in enumerate(qualified):
            if getattr(con, "conId", 0):
                qualified_with_keys.append((key_map[i], con))

        if not qualified_with_keys:
            logger.warning("Batch quotes: no contracts qualified.")
            record_end(start, True, response_items=0)
            return {}

        qualified_contracts = [c for _, c in qualified_with_keys]
        logger.info("Batch quotes: fetching tickers for %d qualified contracts...", len(qualified_contracts))
        tickers = await ib.reqTickersAsync(*qualified_contracts)

        # If market is open but no prices, retry with delayed data
        if is_market_open_ny():
            has_prices = any(
                (t.last and t.last > 0)
                or (t.bid and t.bid > 0)
                or (t.ask and t.ask > 0)
                for t in tickers
            )
            if not has_prices:
                ib.reqMarketDataType(3)
                tickers = await ib.reqTickersAsync(*qualified_contracts)

        results: Dict[str, Dict[str, Optional[float]]] = {}
        for (key, _con), ticker in zip(qualified_with_keys, tickers):
            con = ticker.contract
            oi = (
                getattr(ticker, "openInterest", None)
                or getattr(ticker, "callOpenInterest", None)
                or getattr(ticker, "putOpenInterest", None)
            )
            iv = getattr(ticker, "impliedVolatility", None)
            delta = None
            gamma = None
            theta = None
            vega = None
            if ticker.modelGreeks is not None:
                if iv is None:
                    iv = ticker.modelGreeks.impliedVol
                raw_delta = ticker.modelGreeks.delta
                if raw_delta is not None and isinstance(raw_delta, float) and math.isfinite(raw_delta):
                    delta = raw_delta
                raw_gamma = ticker.modelGreeks.gamma
                if raw_gamma is not None and isinstance(raw_gamma, float) and math.isfinite(raw_gamma):
                    gamma = raw_gamma
                raw_theta = ticker.modelGreeks.theta
                if raw_theta is not None and isinstance(raw_theta, float) and math.isfinite(raw_theta):
                    theta = raw_theta
                raw_vega = ticker.modelGreeks.vega
                if raw_vega is not None and isinstance(raw_vega, float) and math.isfinite(raw_vega):
                    vega = raw_vega
            if oi is not None and isinstance(oi, float) and not math.isfinite(oi):
                oi = None
            if iv is not None and isinstance(iv, float) and not math.isfinite(iv):
                iv = None
            last = ticker.last
            bid = ticker.bid
            ask = ticker.ask
            volume = getattr(ticker, "volume", None)
            if last is not None and isinstance(last, float) and not math.isfinite(last):
                last = None
            if bid is not None and isinstance(bid, float) and not math.isfinite(bid):
                bid = None
            if ask is not None and isinstance(ask, float) and not math.isfinite(ask):
                ask = None
            if volume is not None and isinstance(volume, float) and not math.isfinite(volume):
                volume = None
            if isinstance(last, (int, float)) and last <= 0:
                last = None
            if isinstance(bid, (int, float)) and bid <= 0:
                bid = None
            if isinstance(ask, (int, float)) and ask <= 0:
                ask = None
            if isinstance(volume, (int, float)) and volume <= 0:
                volume = None
            results[key] = {
                "con_id": getattr(con, "conId", None),
                "strike": float(con.strike),
                "right": con.right,
                "exchange": getattr(con, "exchange", None),
                "trading_class": getattr(con, "tradingClass", None),
                "multiplier": getattr(con, "multiplier", None),
                "local_symbol": getattr(con, "localSymbol", None),
                "last": last,
                "bid": bid,
                "ask": ask,
                "oi": oi,
                "iv": iv,
                "delta": delta,
                "gamma": gamma,
                "theta": theta,
                "vega": vega,
                "volume": volume,
            }

        logger.info("Batch quotes: returned %d/%d quotes.", len(results), len(positions))
        record_end(start, True, response_items=len(results))
        return results
    except Exception as e:
        logger.error("Error in batch option quotes: %s", e)
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        raise


async def get_option_quotes(
    symbol: str, expiration: str, strikes: List[float], limit: int = 40
) -> List[Dict[str, Optional[float]]]:
    """
    Fetch option quotes (last/bid/ask/oi/iv) for calls and puts at given strikes.
    """
    try:
        start = record_start("option_quotes", symbol)
        ib = await ib_manager.get_connection()
        is_index = symbol.upper() in INDEX_SYMBOLS
        if is_index:
            contract = Index(symbol, "CBOE", "USD")
        else:
            contract = Stock(symbol, "SMART", "USD")
        logger.info(
            "Options: requesting quotes for %s exp %s (strikes=%s, limit=%s).",
            symbol,
            expiration,
            len(strikes),
            limit,
        )
        await ib.qualifyContractsAsync(contract)

        exp = expiration.replace("-", "")
        def is_market_open_ny() -> bool:
            now = datetime.now(ZoneInfo("America/New_York"))
            if now.weekday() >= 5:
                return False
            open_time = dt_time(9, 30)
            close_time = dt_time(16, 0)
            return open_time <= now.time() <= close_time

        def set_market_data_type(live: bool) -> None:
            # 1 = live, 3 = delayed
            ib.reqMarketDataType(1 if live else 3)

        set_market_data_type(is_market_open_ny())

        underlying_price: Optional[float] = None
        try:
            underlying_ticker = (await ib.reqTickersAsync(contract))[0]
            if underlying_ticker is not None:
                if hasattr(underlying_ticker, "marketPrice"):
                    underlying_price = underlying_ticker.marketPrice()
                if not underlying_price or not math.isfinite(underlying_price):
                    underlying_price = underlying_ticker.last or underlying_ticker.close
        except Exception:
            underlying_price = None

        if underlying_price and math.isfinite(underlying_price):
            strikes = sorted(strikes, key=lambda s: abs(s - underlying_price))[:limit]
        else:
            strikes = sorted(strikes)
            if len(strikes) > limit:
                mid = len(strikes) // 2
                half = limit // 2
                strikes = strikes[max(0, mid - half) : max(0, mid - half) + limit]

        contracts = []
        exchange = "CBOE" if symbol.upper() in INDEX_SYMBOLS else "SMART"
        for strike in strikes:
            contracts.append(Option(symbol, exp, float(strike), "C", exchange))
            contracts.append(Option(symbol, exp, float(strike), "P", exchange))

        qualified = await ib.qualifyContractsAsync(*contracts)
        qualified = [con for con in qualified if getattr(con, "conId", 0)]
        if not qualified:
            logger.info("Options: no qualified contracts for %s exp %s.", symbol, expiration)
            return []
        logger.info(
            "Options: qualified %s/%s contracts for %s exp %s.",
            len(qualified),
            len(contracts),
            symbol,
            expiration,
        )

        tickers = await ib.reqTickersAsync(*qualified)
        if is_market_open_ny():
            has_prices = any(
                (t.last and t.last > 0)
                or (t.bid and t.bid > 0)
                or (t.ask and t.ask > 0)
                for t in tickers
            )
            if not has_prices:
                # Fallback to delayed data if live isn't entitled
                set_market_data_type(False)
                tickers = await ib.reqTickersAsync(*qualified)

            # If we have prices but no greeks, subscribe briefly to get modelGreeks
            has_greeks = any(t.modelGreeks is not None for t in tickers)
            if not has_greeks:
                logger.info("Options: no greeks from snapshot, subscribing for streaming data...")
                for con in qualified:
                    ib.reqMktData(con, genericTickList="", snapshot=False, regulatorySnapshot=False)
                # Wait for greeks to populate (IB needs ~2-3s to compute model greeks)
                for _ in range(8):
                    await asyncio.sleep(0.5)
                    tickers = [ib.ticker(con) for con in qualified]
                    if any(t.modelGreeks is not None for t in tickers):
                        break
                logger.info("Options: greeks available for %d/%d contracts after streaming",
                            sum(1 for t in tickers if t.modelGreeks is not None), len(tickers))
                # Cancel streaming subscriptions
                for con in qualified:
                    ib.cancelMktData(con)

        results: List[Dict[str, Optional[float]]] = []
        for ticker in tickers:
            con = ticker.contract
            oi = (
                getattr(ticker, "openInterest", None)
                or getattr(ticker, "callOpenInterest", None)
                or getattr(ticker, "putOpenInterest", None)
            )
            iv = getattr(ticker, "impliedVolatility", None)
            delta = None
            gamma = None
            theta = None
            vega = None
            if ticker.modelGreeks is not None:
                if iv is None:
                    iv = ticker.modelGreeks.impliedVol
                raw_delta = ticker.modelGreeks.delta
                if raw_delta is not None and isinstance(raw_delta, float) and math.isfinite(raw_delta):
                    delta = raw_delta
                raw_gamma = ticker.modelGreeks.gamma
                if raw_gamma is not None and isinstance(raw_gamma, float) and math.isfinite(raw_gamma):
                    gamma = raw_gamma
                raw_theta = ticker.modelGreeks.theta
                if raw_theta is not None and isinstance(raw_theta, float) and math.isfinite(raw_theta):
                    theta = raw_theta
                raw_vega = ticker.modelGreeks.vega
                if raw_vega is not None and isinstance(raw_vega, float) and math.isfinite(raw_vega):
                    vega = raw_vega
            if oi is not None and isinstance(oi, float) and not math.isfinite(oi):
                oi = None
            if iv is not None and isinstance(iv, float) and not math.isfinite(iv):
                iv = None
            last = ticker.last
            bid = ticker.bid
            ask = ticker.ask
            volume = getattr(ticker, "volume", None)
            if last is not None and isinstance(last, float) and not math.isfinite(last):
                last = None
            if bid is not None and isinstance(bid, float) and not math.isfinite(bid):
                bid = None
            if ask is not None and isinstance(ask, float) and not math.isfinite(ask):
                ask = None
            if volume is not None and isinstance(volume, float) and not math.isfinite(volume):
                volume = None
            if isinstance(last, (int, float)) and last <= 0:
                last = None
            if isinstance(bid, (int, float)) and bid <= 0:
                bid = None
            if isinstance(ask, (int, float)) and ask <= 0:
                ask = None
            if isinstance(volume, (int, float)) and volume <= 0:
                volume = None
            results.append(
                {
                    "con_id": getattr(con, "conId", None),
                    "strike": float(con.strike),
                    "right": con.right,
                    "exchange": getattr(con, "exchange", None),
                    "trading_class": getattr(con, "tradingClass", None),
                    "multiplier": getattr(con, "multiplier", None),
                    "local_symbol": getattr(con, "localSymbol", None),
                    "last": last,
                    "bid": bid,
                    "ask": ask,
                    "oi": oi,
                    "iv": iv,
                    "delta": delta,
                    "gamma": gamma,
                    "theta": theta,
                    "vega": vega,
                    "volume": volume,
                }
            )
        logger.info(
            "Options: quotes for %s exp %s returned %s contract(s).",
            symbol,
            expiration,
            len(results),
        )
        record_end(start, True, response_items=len(results))
        return results
    except Exception as e:
        logger.error(f"Error fetching option quotes for {symbol}: {e}")
        try:
            record_end(start, False, error=str(e))
        except Exception:
            pass
        raise
