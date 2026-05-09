"""Strategy performance analysis from archived trade logs."""
import json
import logging
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _bs_delta(S: float, K: float, T: float, r: float, sigma: float, right: str) -> float | None:
    """
    Black-Scholes delta for a European option.

    Args:
        S:     underlying price
        K:     strike price
        T:     time to expiration in years (> 0)
        r:     risk-free rate (e.g. 0.045 for 4.5%)
        sigma: implied volatility (e.g. 0.25 for 25%)
        right: "C" (call) or "P" (put)

    Returns:
        Delta in (0, 1) for calls, (-1, 0) for puts, or None if inputs invalid.
    """
    try:
        if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
            return None
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        if right.upper() == "C":
            return _norm_cdf(d1)
        elif right.upper() == "P":
            return _norm_cdf(d1) - 1.0
        return None
    except Exception:
        return None


def _norm_cdf(x: float) -> float:
    """Standard normal CDF via math.erf."""
    return (1.0 + math.erf(x / math.sqrt(2))) / 2.0

ACTIVITY_ARCHIVE_GLOB = "activity_log_*.jsonl"

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
LOG_FILE = DATA_DIR / "trade_log.jsonl"
ARCHIVE_DIR = DATA_DIR / "archives"

NY_TZ = timezone(timedelta(hours=-5))  # ET standard; close enough for bucketing

STRATEGY_NAMES: dict[str, str] = {
    "ct15": "CT15 — Open Gap Trendline",
    "strategy1": "Strategy 1",
    "strategy2": "Strategy 2 — Midline Bounce",
    "strategy3": "Strategy 3 — Open Gap Fade",
    "strategy4": "Strategy 4 — Magnet Effect Gap",
    "strategy5": "Strategy 5 — Lateral/No Volume",
}

HOUR_LABELS = [
    "09:00-10:00",
    "10:00-11:00",
    "11:00-12:00",
    "12:00-13:00",
    "13:00-14:00",
    "14:00-15:00",
    "15:00-16:00",
]

BUCKETS_30M = [
    "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
    "15:00", "15:30",
]
_BUCKET_30M_SET = set(BUCKETS_30M)


def _to_bucket_30m(ts: int) -> str | None:
    """Return the 30-minute bucket label (HH:MM) for a unix timestamp in ET, or None if outside trading hours."""
    dt = _to_ny_dt(ts)
    m = 0 if dt.minute < 30 else 30
    b = f"{dt.hour:02d}:{m:02d}"
    return b if b in _BUCKET_30M_SET else None


def _normalize_strategy(strategy_id: str | None) -> str:
    if not strategy_id:
        return "unknown"
    sid = strategy_id.lower()
    if sid.startswith("ct15"):
        return "ct15"
    if sid.startswith("ct_"):
        return "ct_open"
    if sid.startswith("strategy11") or sid == "strategy-11":
        return "strategy11"
    if sid.startswith("strategy10") or sid == "strategy-10":
        return "strategy10"
    if sid.startswith("strategy9") or sid == "strategy-9":
        return "strategy9"
    if sid.startswith("strategy8") or sid == "strategy-8":
        return "strategy8"
    if sid.startswith("strategy7") or sid == "strategy-7":
        return "strategy7"
    if sid.startswith("strategy5") or sid == "strategy-5":
        return "strategy5"
    if sid.startswith("strategy4") or sid == "strategy-4":
        return "strategy4"
    if sid.startswith("strategy3") or sid == "strategy-3":
        return "strategy3"
    if sid.startswith("strategy2") or sid == "strategy-2":
        return "strategy2"
    if sid.startswith("strategy1") or sid == "strategy-1":
        return "strategy1"
    return strategy_id


def _to_ny_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=NY_TZ)


def _hour_label(ts: int) -> str | None:
    dt = _to_ny_dt(ts)
    h = dt.hour
    for label in HOUR_LABELS:
        start = int(label[:2])
        if h == start:
            return label
    return None


def _load_all_entries(start_date: str | None, end_date: str | None, mode: str | None = None) -> list[dict]:
    """Load all JSONL entries from archives + live log, optionally filtered by date range and trading mode.

    Entries without a 'mode' field are treated as 'paper' (the historic default).
    Pass mode=None to load all entries regardless of mode.
    """
    entries: list[dict] = []

    # Parse date range bounds (inclusive)
    # For OPEN entries, extend the start date back by 7 days to capture trades that opened
    # before the date range but closed within it
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=NY_TZ) if start_date else None
    start_dt_extended = start_dt - timedelta(days=7) if start_dt else None
    end_dt = (
        datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=NY_TZ) + timedelta(days=1)
        if end_date
        else None
    )

    files: list[Path] = sorted(ARCHIVE_DIR.glob("*.jsonl")) if ARCHIVE_DIR.exists() else []
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > 0:
        files.append(LOG_FILE)

    for path in files:
        try:
            with open(path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = entry.get("timestamp")
                    if ts is None:
                        continue
                    dt = _to_ny_dt(int(ts))
                    entry_type = entry.get("type", "").upper()

                    # Use extended date range for OPEN entries to capture trades that
                    # opened before the date range but closed within it
                    effective_start = start_dt_extended if entry_type == "OPEN" else start_dt

                    if effective_start and dt < effective_start:
                        continue
                    if end_dt and dt >= end_dt:
                        continue
                    if mode is not None:
                        entry_mode = entry.get("mode") or "paper"
                        if entry_mode != mode:
                            continue
                    entries.append(entry)
        except OSError:
            continue

    return entries


def _build_trade_pairs(entries: list[dict]) -> list[dict]:
    """Match OPEN + CLOSE entries by position_id into completed trades."""
    opens: dict[str, dict] = {}
    closes: dict[str, dict] = {}

    for e in entries:
        pid = e.get("position_id") or e.get("signal_id")
        if not pid:
            continue
        t = e.get("type", "").upper()
        if t == "OPEN":
            opens[pid] = e
        elif t == "CLOSE":
            closes[pid] = e

    trades = []
    for pid, open_e in opens.items():
        close_e = closes.get(pid)
        if close_e is None:
            continue
        pnl = close_e.get("pnl")
        pnl_pct = close_e.get("pnl_pct")
        if pnl is None:
            continue
        hold_min = round((close_e["timestamp"] - open_e["timestamp"]) / 60)
        trades.append({
            "symbol": open_e.get("symbol", ""),
            "right": (open_e.get("right") or "").upper() or None,
            "strategy": _normalize_strategy(open_e.get("strategy_id")),
            "strategy_id_raw": open_e.get("strategy_id", ""),
            "position_id": pid,
            "open_ts": open_e["timestamp"],
            "close_ts": close_e["timestamp"],
            "pnl": float(pnl),
            "pnl_pct": float(pnl_pct) if pnl_pct is not None else None,
            "entry_price": open_e.get("entry_price") or open_e.get("price"),
            "quantity": open_e.get("quantity") or 1,
            "close_price": close_e.get("price"),
            "hold_min": max(0, hold_min),
            "hour_label": _hour_label(open_e["timestamp"]),
            "date_key": _to_ny_dt(open_e["timestamp"]).strftime("%Y-%m-%d"),
            "win": float(pnl) > 0,
        })

    return sorted(trades, key=lambda t: t["open_ts"])


def _agg(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0, "pnl": 0.0, "wins": 0, "losses": 0, "win_rate": None,
                "avg_return": None, "avg_hold": None}
    pnl = round(sum(t["pnl"] for t in trades), 2)
    wins = sum(1 for t in trades if t["win"])
    losses = len(trades) - wins
    win_rate = round(wins / len(trades) * 100) if trades else None
    returns = [t["pnl_pct"] for t in trades if t["pnl_pct"] is not None]
    avg_return = round(sum(returns) / len(returns), 1) if returns else None
    avg_hold = round(sum(t["hold_min"] for t in trades) / len(trades)) if trades else None
    return {
        "trades": len(trades),
        "pnl": pnl,
        "wins": wins,
        "losses": losses,
        "win_rate": win_rate,
        "avg_return": avg_return,
        "avg_hold": avg_hold,
    }


def _load_activity_entries(start_date: str | None, end_date: str | None) -> list[dict]:
    """Load activity log entries from archives + current log, filtered by date range."""
    from app.services.auto_trader_log import read_all_activity_entries
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=NY_TZ) if start_date else None
    end_dt = (
        datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=NY_TZ) + timedelta(days=1)
        if end_date else None
    )
    start_ts = int(start_dt.timestamp()) if start_dt else None
    end_ts = int(end_dt.timestamp()) if end_dt else None
    return read_all_activity_entries(start_ts=start_ts, end_ts=end_ts)


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def _compute_signal_stats(
    activity: list[dict],
    trades: list[dict],
    all_strategy_keys: list[str],
) -> dict[str, Any]:
    """Compute signal conversion funnel and skip reason breakdown from activity log."""
    skip_counts: dict[str, dict[str, int]] = {}  # strategy -> {reason_code: count}
    overall_skips: dict[str, int] = {}
    ticker_skips: dict[str, dict[str, int]] = {}  # symbol -> {reason_code: count}
    hour_skips: dict[str, int] = {}               # hour_label -> count
    skip_entries: list[dict[str, Any]] = []        # individual enriched entries

    for entry in activity:
        if entry.get("type") != "signal_skipped":
            continue
        d = entry.get("details") or {}
        reason = d.get("reason_code") or "unknown"
        strategy = _normalize_strategy(d.get("strategy_id"))
        symbol = d.get("symbol") or "unknown"
        ts = entry.get("timestamp")

        overall_skips[reason] = overall_skips.get(reason, 0) + 1

        skip_counts.setdefault(strategy, {})
        skip_counts[strategy][reason] = skip_counts[strategy].get(reason, 0) + 1

        ticker_skips.setdefault(symbol, {})
        ticker_skips[symbol][reason] = ticker_skips[symbol].get(reason, 0) + 1

        if ts:
            hl = _hour_label(int(ts))
            if hl:
                hour_skips[hl] = hour_skips.get(hl, 0) + 1

        # Build enriched entry for the detail table
        row: dict[str, Any] = {
            "timestamp": ts,
            "time_et": _to_ny_dt(int(ts)).strftime("%Y-%m-%d %H:%M") if ts else None,
            "symbol": symbol,
            "direction": d.get("direction") or d.get("right"),
            "strategy": strategy,
            "reason_code": reason,
            "stage": d.get("stage"),
            "latest_price": d.get("latest_price"),
            "nearest_strike": d.get("nearest_strike"),
            "min_premium": d.get("min"),
            "max_premium": d.get("max"),
            "range_reason": d.get("range_reason"),
            "range_diff_pct": d.get("range_diff_pct"),
            "candidate_count": d.get("candidate_count"),
            "quote_count": d.get("quote_count"),
        }
        skip_entries.append(row)

    skip_entries.sort(key=lambda x: x.get("timestamp") or 0, reverse=True)

    # Per-ticker summary
    by_ticker = []
    for sym, reasons in sorted(ticker_skips.items(), key=lambda x: -sum(x[1].values())):
        total = sum(reasons.values())
        by_ticker.append({
            "symbol": sym,
            "total": total,
            "reasons": dict(sorted(reasons.items(), key=lambda x: -x[1])),
            "top_reason": max(reasons, key=reasons.get),
        })

    # Per-hour summary (sorted by hour label)
    by_hour = [{"hour": hl, "skipped": hour_skips[hl]}
               for hl in HOUR_LABELS if hl in hour_skips]

    # Signals detected = skipped + traded (from trade_list)
    by_strategy: dict[str, Any] = {}
    for sk in all_strategy_keys:
        sk_trades = sum(1 for t in trades if t["strategy"] == sk)
        sk_skips = sum(skip_counts.get(sk, {}).values())
        sk_evaluated = sk_trades + sk_skips
        conv = round(sk_trades / sk_evaluated * 100) if sk_evaluated > 0 else None
        by_strategy[sk] = {
            "evaluated": sk_evaluated,
            "acted_on": sk_trades,
            "skipped": sk_skips,
            "conversion_rate": conv,
            "skip_reasons": dict(sorted(skip_counts.get(sk, {}).items(), key=lambda x: -x[1])),
        }

    total_traded = len(trades)
    total_skipped = sum(overall_skips.values())
    total_evaluated = total_traded + total_skipped
    return {
        "total_evaluated": total_evaluated,
        "total_acted_on": total_traded,
        "total_skipped": total_skipped,
        "conversion_rate": round(total_traded / total_evaluated * 100) if total_evaluated > 0 else None,
        "skip_reasons": dict(sorted(overall_skips.items(), key=lambda x: -x[1])),
        "by_strategy": by_strategy,
        "by_ticker": by_ticker,
        "by_hour": by_hour,
        "entries": skip_entries,
    }


def _compute_iv_mfe_mae(trades_pairs: list[dict], open_entries: dict, close_entries: dict) -> dict[str, Any]:
    """Compute IV and MFE/MAE averages per strategy from enriched trade log entries."""
    by_strategy: dict[str, Any] = {}

    strategy_keys = sorted(set(t["strategy"] for t in trades_pairs))
    for sk in strategy_keys:
        sk_pairs = [t for t in trades_pairs if t["strategy"] == sk]
        iv_entries: list[float] = []
        iv_exits: list[float] = []
        iv_crushes: list[float] = []
        mfes: list[float] = []
        maes: list[float] = []

        deltas: list[float] = []
        for pair in sk_pairs:
            pid = pair.get("position_id")
            open_e = open_entries.get(pid)
            close_e = close_entries.get(pid)
            if open_e:
                iv_e = open_e.get("iv_at_entry")
                if iv_e is not None:
                    try:
                        iv_entries.append(float(iv_e))
                    except (TypeError, ValueError):
                        pass
                d = open_e.get("delta_at_entry")
                if d is not None:
                    try:
                        deltas.append(abs(float(d)))  # store absolute value
                    except (TypeError, ValueError):
                        pass
            if close_e:
                iv_x = close_e.get("iv_at_exit")
                if iv_x is not None:
                    try:
                        iv_exits.append(float(iv_x))
                    except (TypeError, ValueError):
                        pass
                mfe = close_e.get("mfe_pct")
                mae = close_e.get("mae_pct")
                if mfe is not None:
                    try:
                        mfes.append(float(mfe))
                    except (TypeError, ValueError):
                        pass
                if mae is not None:
                    try:
                        maes.append(float(mae))
                    except (TypeError, ValueError):
                        pass

        # IV crush = entry IV - exit IV (positive = IV dropped)
        if iv_entries and iv_exits and len(iv_entries) == len(iv_exits):
            iv_crushes = [e - x for e, x in zip(iv_entries, iv_exits)]

        by_strategy[sk] = {
            "avg_delta_entry": _avg(deltas),
            "avg_iv_entry": _avg(iv_entries),
            "avg_iv_exit": _avg(iv_exits),
            "avg_iv_crush": _avg(iv_crushes),
            "avg_mfe_pct": _avg(mfes),
            "avg_mae_pct": _avg(maes),
            "iv_entry_count": len(iv_entries),
            "mfe_count": len(mfes),
            "delta_count": len(deltas),
        }

    return {"by_strategy": by_strategy}


def _compute_tp_analysis(trade_pairs: list[dict], open_entries: dict, close_entries: dict) -> list[dict]:
    """Compute per-ticker EV and breakeven win rate to guide take-profit optimization."""
    by_symbol: dict[str, dict] = {}
    for pair in trade_pairs:
        sym = pair["symbol"]
        pid = pair.get("position_id")
        close_e = close_entries.get(pid)
        open_e  = open_entries.get(pid)
        if not close_e:
            continue
        pnl_pct = close_e.get("pnl_pct")   # decimal (0.11 = 11%)
        if pnl_pct is None:
            continue
        win = (close_e.get("pnl") or 0) > 0
        ep = (open_e or {}).get("entry_price") or close_e.get("entry_price")
        tp = (open_e or {}).get("target_price") or close_e.get("target_price")
        tp_pct = ((tp / ep) - 1) * 100 if ep and tp and ep > 0 else None

        by_symbol.setdefault(sym, {"wins": [], "losses": [], "tp_pcts": []})
        if win:
            by_symbol[sym]["wins"].append(pnl_pct * 100)
            if tp_pct is not None:
                by_symbol[sym]["tp_pcts"].append(tp_pct)
        else:
            by_symbol[sym]["losses"].append(pnl_pct * 100)

    results = []
    for sym, d in sorted(by_symbol.items()):
        wins, losses = d["wins"], d["losses"]
        total = len(wins) + len(losses)
        if total == 0:
            continue
        wr = len(wins) / total * 100
        avg_win  = sum(wins)   / len(wins)   if wins   else None
        avg_loss = sum(losses) / len(losses) if losses else None
        # EV: use 0 for whichever side has no data
        _aw = avg_win  if avg_win  is not None else 0.0
        _al = avg_loss if avg_loss is not None else 0.0
        ev = (wr / 100) * _aw + (1 - wr / 100) * _al
        # Breakeven WR: if no losses recorded, any WR is sufficient (be_wr=0);
        # if no wins recorded, need 100% WR (be_wr=100).
        if avg_win is not None and avg_loss is not None:
            denom = _aw + abs(_al)
            be_wr = abs(_al) / denom * 100 if denom != 0 else None
        elif avg_loss is None:
            be_wr = 0.0   # no losses observed → trivially breakeven at any WR
        else:
            be_wr = 100.0  # no wins observed → must win every trade to break even
        margin = round(wr - be_wr, 1) if be_wr is not None else None
        current_tp = round(sum(d["tp_pcts"]) / len(d["tp_pcts"]), 1) if d["tp_pcts"] else None
        results.append({
            "symbol":           sym,
            "trades":           total,
            "wins":             len(wins),
            "losses":           len(losses),
            "win_rate":         round(wr, 1),
            "avg_win_pct":      round(avg_win,  2) if avg_win  is not None else None,
            "avg_loss_pct":     round(avg_loss, 2) if avg_loss is not None else None,
            "expected_value":   round(ev, 2),
            "breakeven_wr":     round(be_wr, 1) if be_wr is not None else None,
            "margin_of_safety": margin,
            "current_tp_pct":   current_tp,
        })
    return results


async def _compute_post_exit_opportunity(
    trade_pairs: list[dict],
    open_entries: dict,
    close_entries: dict,
) -> dict[str, Any]:
    """
    For each winning (TP-hit) trade, fetch 1-min bars after the exit timestamp
    and compute how much further the underlying moved in the favorable direction
    before reversing or reaching 16:00 ET (market close).

    Returns {"rows": [...per-ticker summaries...], "debug": {...diagnostic counts...}}
    Note: % values are underlying stock moves, not option premium moves.
    """
    import logging as _logging
    _log = _logging.getLogger(__name__)

    debug: dict[str, Any] = {
        "winning_trades": 0,
        "unique_sym_dates": 0,
        "sym_dates_with_bars": 0,
        "trades_with_ref_bar": 0,
        "trades_with_post_bars": 0,
        "trades_with_positive_move": 0,
        "delta_fallback": None,       # filled in after pre-pass
        "delta_real_count": 0,        # how many trades had real delta
        "errors": [],
    }

    try:
        from app.services.ib.market_data import get_intraday_bars_for_date
    except Exception as e:
        debug["errors"].append(f"import failed: {e}")
        return {"rows": [], "debug": debug}

    # ── 1. Collect winning trades grouped by (symbol, close_date) ──────────────
    # Use close_date instead of date_key (open date) to fetch bars for the day the trade closed
    by_sym_date: dict[tuple, list[dict]] = {}
    for pair in trade_pairs:
        if not pair.get("win"):
            continue
        debug["winning_trades"] += 1
        # Use close date instead of open date
        close_date_key = _to_ny_dt(pair["close_ts"]).strftime("%Y-%m-%d")
        key = (pair["symbol"], close_date_key)
        by_sym_date.setdefault(key, []).append(pair)

    debug["unique_sym_dates"] = len(by_sym_date)
    if not by_sym_date:
        return {"rows": [], "debug": debug}

    # ── 2. Fetch 1-min bars per (symbol, close_date) — one IB call each ─────────────
    bars_cache: dict[tuple, list[dict]] = {}
    for (sym, dk) in by_sym_date:
        date_str = dk.replace("-", "")   # "2026-01-15" → "20260115"
        bars = await get_intraday_bars_for_date(sym, date_str)
        bars_cache[(sym, dk)] = bars
        if bars:
            debug["sym_dates_with_bars"] += 1
        else:
            debug["errors"].append(f"no bars: {sym} {dk}")

    # ── 2b. Compute period-average real delta (fallback for missing delta) ──────
    _real_deltas: list[float] = []
    for pair in trade_pairs:
        if not pair.get("win"):
            continue
        pid = pair.get("position_id")
        open_e = open_entries.get(pid) if pid else None
        _d = (open_e or {}).get("delta_at_entry")
        try:
            _dv = abs(float(_d)) if _d is not None else None
        except (TypeError, ValueError):
            _dv = None
        # Try BS reconstruction as a secondary source
        if _dv is None and open_e:
            try:
                _iv = open_e.get("iv_at_entry")
                _K  = open_e.get("strike")
                _ex = open_e.get("expiration")
                _ts = open_e.get("timestamp")
                _r  = (pair.get("right") or "").upper()
                # Need a stock price proxy — use entry_price of the *close* entry
                pid2 = pair.get("position_id")
                close_e = close_entries.get(pid2) if pid2 else None
                # We don't have stock price in pre-pass; skip BS here,
                # it will be computed per-trade in the main loop using ref_price
            except Exception:
                pass
        if _dv is not None:
            _real_deltas.append(_dv)
    _period_avg_delta: float | None = (
        sum(_real_deltas) / len(_real_deltas) if _real_deltas else None
    )
    _delta_fallback: float = round(_period_avg_delta, 3) if _period_avg_delta is not None else 0.35
    debug["delta_fallback"] = _delta_fallback
    debug["delta_real_count"] = len(_real_deltas)
    logger.info(
        f"_compute_post_exit_opportunity: period_avg_delta={_delta_fallback} "
        f"(from {len(_real_deltas)} real values; {'using hardcoded 0.35' if not _real_deltas else 'data-driven'})"
    )

    # ── 3. Compute left-on-table per trade ────────────────────────────────────
    _NY_CUTOFF = 16  # stop collecting at 16:00 ET (market close)

    by_symbol: dict[str, list[dict]] = {}
    for pair in trade_pairs:
        if not pair.get("win"):
            continue
        sym = pair["symbol"]
        close_date_key = _to_ny_dt(pair["close_ts"]).strftime("%Y-%m-%d")
        right = (pair.get("right") or "").upper()   # "C" or "P"
        close_ts = pair["close_ts"]

        bars = bars_cache.get((sym, close_date_key), [])
        if not bars:
            continue

        # Reference bar: the 1-min bar whose window contains close_ts
        ref_bar = None
        for b in bars:
            if b["time"] <= close_ts:
                ref_bar = b
        if ref_bar is None:
            debug["errors"].append(f"no ref_bar: {sym} {close_date_key} close_ts={close_ts} first_bar={bars[0]['time'] if bars else 'n/a'}")
            continue
        debug["trades_with_ref_bar"] += 1
        ref_price = ref_bar["close"]
        if not ref_price or ref_price <= 0:
            continue

        # Post-exit bars up to 14:00 ET
        post_bars = [
            b for b in bars
            if b["time"] > close_ts and _to_ny_dt(b["time"]).hour < _NY_CUTOFF
        ]

        if not post_bars:
            debug["errors"].append(f"no post_bars: {sym} {close_date_key} close_ts={close_ts}")
            continue
        debug["trades_with_post_bars"] += 1

        # Max favorable move after exit
        if right == "C":
            best_price = max(b["high"] for b in post_bars)
            best_bar   = next(b for b in post_bars if b["high"] >= best_price)
            left_pct   = (best_price - ref_price) / ref_price * 100
        elif right == "P":
            best_price = min(b["low"] for b in post_bars)
            best_bar   = next(b for b in post_bars if b["low"] <= best_price)
            left_pct   = (ref_price - best_price) / ref_price * 100
        else:
            continue

        # Only record if the price actually continued in our favour
        if left_pct <= 0:
            continue
        debug["trades_with_positive_move"] += 1

        mins_to_peak    = max(1, round((best_bar["time"] - close_ts) / 60))
        hold_min        = pair.get("hold_min", 0)
        option_entry    = pair.get("entry_price")   # option premium at entry
        pid             = pair.get("position_id")
        open_e          = open_entries.get(pid) if pid else None
        delta_raw       = (open_e or {}).get("delta_at_entry")
        try:
            delta_val = abs(float(delta_raw)) if delta_raw is not None else None
        except (TypeError, ValueError):
            delta_val = None

        # ── Try Black-Scholes reconstruction if IB delta is missing ───────────
        if delta_val is None and open_e:
            iv_raw  = open_e.get("iv_at_entry")
            strike  = open_e.get("strike")
            expiry  = open_e.get("expiration")   # "YYYYMMDD" or "YYYY-MM-DD"
            open_ts = open_e.get("timestamp")
            try:
                iv_float = float(iv_raw) if iv_raw is not None else None
                K = float(strike) if strike is not None else None
                if iv_float and K and expiry and open_ts and ref_price > 0:
                    # Parse expiry — support both YYYYMMDD and YYYY-MM-DD
                    expiry_str = str(expiry).replace("-", "")
                    exp_dt = datetime(int(expiry_str[:4]), int(expiry_str[4:6]), int(expiry_str[6:8]),
                                      16, 0, 0, tzinfo=NY_TZ)
                    entry_dt = datetime.fromtimestamp(int(open_ts), tz=NY_TZ)
                    T = max((exp_dt - entry_dt).total_seconds() / (365.25 * 24 * 3600), 1 / (365.25 * 24))
                    bs = _bs_delta(ref_price, K, T, 0.045, iv_float, right)
                    if bs is not None:
                        delta_val = abs(bs)
            except Exception:
                pass  # fall through to period-average fallback

        # delta_estimated = True only when we fell all the way back to period-avg/0.35
        delta_estimated = delta_val is None
        if delta_val is None:
            delta_val = _delta_fallback
        # TP% recorded on the open entry (target_price / entry_price - 1)
        tp_raw    = (open_e or {}).get("target_price")
        ep_raw    = (open_e or {}).get("entry_price") or option_entry
        tp_pct_trade = ((tp_raw / ep_raw) - 1) * 100 if tp_raw and ep_raw and ep_raw > 0 else None

        by_symbol.setdefault(sym, []).append({
            "left_pct":        round(left_pct, 3),
            "mins_to_peak":    mins_to_peak,
            "hold_min":        hold_min,
            "stock_price":     ref_price,
            "option_entry":    float(option_entry) if option_entry else None,
            "delta":           delta_val,
            "delta_estimated": delta_estimated,
            "tp_pct":          tp_pct_trade,
        })

    # ── 4. Aggregate per ticker ───────────────────────────────────────────────
    def _pct(lst: list[float], p: int) -> float:
        lst = sorted(lst)
        idx = max(0, min(int(len(lst) * p / 100), len(lst) - 1))
        return lst[idx]

    results = []
    for sym, records in sorted(by_symbol.items()):
        if not records:
            continue
        left_pcts    = [r["left_pct"]    for r in records]
        mins_list    = [r["mins_to_peak"] for r in records]
        hold_list    = [r["hold_min"]     for r in records]
        stock_prices = [r["stock_price"]  for r in records if r.get("stock_price")]
        opt_entries  = [r["option_entry"] for r in records if r.get("option_entry")]
        deltas       = [r["delta"]        for r in records if r.get("delta") is not None]
        tp_pcts      = [r["tp_pct"]       for r in records if r.get("tp_pct") is not None]
        all_estimated = all(r.get("delta_estimated", True) for r in records)
        n = len(records)

        avg_stock  = sum(stock_prices) / len(stock_prices) if stock_prices else None
        avg_opt    = sum(opt_entries)  / len(opt_entries)  if opt_entries  else None
        avg_delta  = sum(deltas)       / len(deltas)       if deltas       else None
        avg_cur_tp = sum(tp_pcts)      / len(tp_pcts)      if tp_pcts      else None
        p25        = _pct(left_pcts, 25)

        # Leverage = delta × (stock_price / option_entry_price)
        leverage = round(avg_delta * (avg_stock / avg_opt), 1) \
            if avg_delta and avg_stock and avg_opt and avg_opt > 0 else None

        # Suggested TP = current_tp + P25_underlying × leverage
        suggested_tp = round(avg_cur_tp + p25 * leverage, 1) \
            if leverage is not None and avg_cur_tp is not None else None

        results.append({
            "symbol":            sym,
            "sample":            n,
            "avg_left_pct":      round(sum(left_pcts) / n, 2),
            "p25_left_pct":      round(p25, 2),
            "p50_left_pct":      round(_pct(left_pcts, 50), 2),
            "p75_left_pct":      round(_pct(left_pcts, 75), 2),
            "avg_mins_to_peak":  round(sum(mins_list) / len(mins_list)),
            "avg_hold_min":      round(sum(hold_list) / len(hold_list)) if hold_list else None,
            "avg_stock_price":   round(avg_stock, 2) if avg_stock else None,
            "avg_option_entry":  round(avg_opt, 2)   if avg_opt   else None,
            "avg_delta":         round(avg_delta, 3) if avg_delta else None,
            "delta_estimated":   all_estimated,       # True = using 0.35 fallback for all trades
            "avg_leverage":      leverage,
            "current_tp_pct":    round(avg_cur_tp, 1) if avg_cur_tp is not None else None,
            "suggested_tp_pct":  suggested_tp,
        })
    return {"rows": results, "debug": debug}


def _compute_market_context(activity: list[dict], trades: list[dict]) -> dict[str, Any]:
    """Correlate SPY direction at scan time with trade outcomes on the same day."""
    # Build a map of date_key -> list of spy_direction values from scan_context events
    day_direction: dict[str, list[str]] = {}
    for entry in activity:
        if entry.get("type") != "scan_context":
            continue
        d = entry.get("details") or {}
        direction = d.get("spy_direction")
        if not direction:
            continue
        ts = entry.get("timestamp")
        if ts:
            day_key = _to_ny_dt(int(ts)).strftime("%Y-%m-%d")
            day_direction.setdefault(day_key, []).append(direction)

    # Pick dominant direction per day (most frequent)
    day_dominant: dict[str, str] = {}
    for dk, dirs in day_direction.items():
        from collections import Counter
        most_common = Counter(dirs).most_common(1)
        if most_common:
            day_dominant[dk] = most_common[0][0]

    # Group trades by SPY direction on their day
    by_direction: dict[str, list[dict]] = {}
    for t in trades:
        direction = day_dominant.get(t["date_key"])
        if direction:
            by_direction.setdefault(direction, []).append(t)

    return {
        "by_spy_direction": {
            direction: _agg(day_trades)
            for direction, day_trades in sorted(by_direction.items())
        },
        "days_with_context": len(day_dominant),
    }


async def compute_report(start_date: str | None = None, end_date: str | None = None, mode: str | None = None, include_post_exit: bool = False) -> dict[str, Any]:
    entries = _load_all_entries(start_date, end_date, mode=mode)
    trades = _build_trade_pairs(entries)

    # Build position_id → entry maps for IV/MFE/MAE lookup
    open_entries: dict[str, dict] = {}
    close_entries: dict[str, dict] = {}
    for e in entries:
        pid = e.get("position_id")
        if not pid:
            continue
        t = e.get("type", "").upper()
        if t == "OPEN":
            open_entries[pid] = e
        elif t == "CLOSE":
            close_entries[pid] = e

    # Load activity log for signal stats and market context
    try:
        activity = _load_activity_entries(start_date, end_date)
    except Exception:
        activity = []

    empty_base = {
        "date_range": {"start": start_date, "end": end_date},
        "overview": {"sessions": 0, "completed_trades": 0, "total_pnl": 0.0,
                     "win_rate": None, "winners": 0, "losers": 0,
                     "total_capital_deployed": 0.0, "avg_capital_per_trade": 0.0,
                     "return_on_capital": None, "profit_factor": None,
                     "avg_winner": None, "avg_loser": None, "avg_hold_min": None,
                     "open_trades": 0, "open_capital_deployed": 0.0},
        "open_positions_detail": [],
        "sessions": [],
        "strategies": {},
        "cross_hour": {},
        "cross_hour_opens": {},
        "ticker_summary": [],
        "best_trades": [],
        "worst_trades": [],
        "calls_puts": {},
        "signal_stats": {"total_evaluated": 0, "total_acted_on": 0, "total_skipped": 0,
                         "conversion_rate": None, "skip_reasons": {}, "by_strategy": {},
                         "by_ticker": [], "by_hour": [], "entries": []},
        "iv_mfe_mae": {"by_strategy": {}},
        "market_context": {"by_spy_direction": {}, "days_with_context": 0},
        "ticker_tp_analysis": [],
        "capital_timeline": {"rows": [], "date_keys": []},
        "post_exit_opportunity": [],
        "post_exit_debug": {},
    }

    if not trades:
        # Still compute signal stats even with no completed trades
        if activity:
            empty_base["signal_stats"] = _compute_signal_stats(activity, [], [])
        return empty_base

    # --- Overview ---
    sessions_set = sorted(set(t["date_key"] for t in trades))
    total_pnl = round(sum(t["pnl"] for t in trades), 2)
    winners = sum(1 for t in trades if t["win"])
    losers = len(trades) - winners
    win_rate = round(winners / len(trades) * 100) if trades else None
    # --- Still-open positions in this date range ---
    still_open = [e for pid, e in open_entries.items() if pid not in close_entries]
    open_count = len(still_open)
    open_capital = round(sum((e.get("entry_price") or 0) * (e.get("quantity") or 1) * 100 for e in still_open), 2)

    # Fetch price bars for open positions
    try:
        from app.services.ib.market_data import get_intraday_bars_for_date
    except Exception:
        get_intraday_bars_for_date = None

    async def _get_price_bars_for_position(entry: dict) -> list[dict]:
        """Fetch 1-min bars from position open time to market close (16:00 ET)."""
        if not get_intraday_bars_for_date:
            return []

        symbol = entry.get("symbol")
        open_ts = entry.get("timestamp")
        if not symbol or not open_ts:
            return []

        # Get date in YYYYMMDD format
        dt = _to_ny_dt(int(open_ts))
        date_str = dt.strftime("%Y%m%d")

        try:
            bars = await get_intraday_bars_for_date(symbol, date_str)
            if not bars:
                return []

            # Filter bars from open time to market close (16:00 ET)
            filtered_bars = [
                b for b in bars
                if b["time"] >= open_ts and _to_ny_dt(b["time"]).hour < 16
            ]

            # Return simplified bar data (time and close price)
            return [{"time": b["time"], "price": b["close"]} for b in filtered_bars]
        except Exception:
            return []

    # Build signal_id → activity events index for enrichment
    _sig_events: dict[str, list[dict]] = {}
    for ae in activity:
        sig = (ae.get("details") or {}).get("signal_id")
        if sig:
            _sig_events.setdefault(sig, []).append(ae)

    def _enrich_open(e: dict) -> dict:
        signal_id = e.get("signal_id") or e.get("position_id") or ""
        events = sorted(_sig_events.get(signal_id, []), key=lambda x: x.get("timestamp") or 0)

        checks = [ev for ev in events if ev.get("type") == "position_check"]
        last_check = checks[-1] if checks else None
        lcd = (last_check.get("details") or {}) if last_check else {}

        last_premium = lcd.get("premium")
        last_target  = lcd.get("target_price") or e.get("target_price")
        pct_to_tp    = round(last_premium / last_target * 100, 1) if last_premium and last_target and last_target > 0 else None

        # Calculate max premium reached across all checks
        entry_price = e.get("entry_price") or e.get("price") or 0
        premiums = [
            (ev.get("details") or {}).get("premium")
            for ev in checks
            if (ev.get("details") or {}).get("premium") is not None
        ]
        max_premium = max(premiums) if premiums else None
        max_pct_gain = round((max_premium - entry_price) / entry_price * 100, 1) if max_premium and entry_price > 0 else None
        max_pct_to_tp = round(max_premium / last_target * 100, 1) if max_premium and last_target and last_target > 0 else None

        has_close_timeout = any(ev.get("type") == "close_fill_timeout" for ev in events)
        has_close_retry   = any(ev.get("type") == "close_retry_scheduled" for ev in events)
        has_worker_stop   = any(ev.get("type") == "worker_stop" for ev in events)

        if has_close_timeout:
            status_reason = "close_order_cancelled"
        elif has_close_retry:
            status_reason = "close_retry_pending"
        elif checks and has_worker_stop:
            # worker stopped after last check — monitoring ended
            last_stop_ts = max(
                (ev.get("timestamp") or 0) for ev in events if ev.get("type") == "worker_stop"
            )
            last_check_ts = last_check.get("timestamp") or 0
            status_reason = "worker_stopped" if last_stop_ts > last_check_ts else "tp_not_reached"
        elif not checks:
            status_reason = "worker_stopped" if has_worker_stop else "no_data"
        else:
            status_reason = "tp_not_reached"

        # Key events (skip noisy position_check / signal_stage)
        SKIP_TYPES = {"position_check", "signal_stage"}
        key_events = [
            {
                "type": ev.get("type"),
                "time_et": _to_ny_dt(int(ev["timestamp"])).strftime("%H:%M") if ev.get("timestamp") else None,
                "message": (ev.get("message") or "")[:120],
            }
            for ev in events if ev.get("type") not in SKIP_TYPES
        ]

        return {
            "position_id":  e.get("position_id"),
            "symbol":       e.get("symbol"),
            "right":        e.get("right"),
            "strike":       e.get("strike"),
            "expiration":   e.get("expiration"),
            "price":        e.get("entry_price") or e.get("price"),
            "quantity":     e.get("quantity") or 1,
            "strategy_id":  e.get("strategy_id"),
            "timestamp":    e.get("timestamp"),
            "target_price": e.get("target_price"),
            "mode":         e.get("mode"),
            # activity enrichment
            "signal_id":       signal_id,
            "check_count":     len(checks),
            "last_check_ts":   last_check.get("timestamp") if last_check else None,
            "last_premium":    last_premium,
            "last_target":     last_target,
            "pct_to_tp":       pct_to_tp,
            "max_premium":     max_premium,
            "max_pct_gain":    max_pct_gain,
            "max_pct_to_tp":   max_pct_to_tp,
            "status_reason":   status_reason,
            "close_attempts":  sum(1 for ev in events if ev.get("type") == "close_fill_timeout"),
            "key_events":      key_events,
        }

    # Enrich open positions with price bars
    enriched_positions = []
    # Skip price bar fetching if there are many open positions (too slow with 64+ positions)
    skip_bars = len(still_open) > 20
    for e in still_open:
        enriched = _enrich_open(e)
        # Fetch price bars for this position (skip if too many positions to avoid timeout)
        if not skip_bars:
            price_bars = await _get_price_bars_for_position(e)
        else:
            price_bars = []
        enriched["price_bars"] = price_bars
        enriched_positions.append(enriched)

    open_positions_detail = sorted(
        enriched_positions,
        key=lambda x: x.get("timestamp") or 0,
    )

    # --- TP Analysis for open positions ---
    open_tp_analysis = {}
    if open_positions_detail:
        # Filter positions with valid max_pct_gain data
        positions_with_data = [
            p for p in open_positions_detail
            if p.get("max_pct_gain") is not None and p.get("target_price") is not None and p.get("price") is not None
        ]

        if positions_with_data:
            # Current TP setting (from target_price vs entry_price)
            target_gains = [
                round((p["target_price"] - p["price"]) / p["price"] * 100, 1)
                for p in positions_with_data
                if p["price"] > 0
            ]
            current_tp_pct = round(sum(target_gains) / len(target_gains), 1) if target_gains else 20.0

            # Distribution of max gains reached
            max_gains = [p["max_pct_gain"] for p in positions_with_data]
            avg_max_gain = round(sum(max_gains) / len(max_gains), 1)

            # How many would have closed at different TP thresholds
            tp_thresholds = [5, 7.5, 10, 12.5, 15, 17.5, 20]
            capture_rates = []
            for tp in tp_thresholds:
                captured = sum(1 for g in max_gains if g >= tp)
                rate = round(captured / len(max_gains) * 100, 1)
                capture_rates.append({"tp_pct": tp, "captured": captured, "rate": rate})

            # Recommended TP (threshold that would have captured 70-80% of positions)
            recommended_tp = None
            for item in capture_rates:
                if 70 <= item["rate"] <= 85:
                    recommended_tp = item["tp_pct"]
                    break
            if recommended_tp is None:
                # Fallback: find closest to 75%
                recommended_tp = min(capture_rates, key=lambda x: abs(x["rate"] - 75))["tp_pct"]

            open_tp_analysis = {
                "total_positions": len(positions_with_data),
                "current_tp_pct": current_tp_pct,
                "avg_max_gain": avg_max_gain,
                "capture_rates": capture_rates,
                "recommended_tp": recommended_tp,
                "positions_detail": [
                    {
                        "symbol": p["symbol"],
                        "entry": p["price"],
                        "target": p["target_price"],
                        "max_premium": p["max_premium"],
                        "max_pct_gain": p["max_pct_gain"],
                    }
                    for p in positions_with_data
                ],
            }

    total_capital = round(sum((t.get("entry_price") or 0) * (t.get("quantity") or 1) * 100 for t in trades), 2)
    avg_capital = round(total_capital / len(trades), 2) if trades else 0.0
    return_on_capital = round(total_pnl / total_capital * 100, 2) if total_capital > 0 else None
    winning_pnls = [t["pnl"] for t in trades if t["win"]]
    losing_pnls  = [abs(t["pnl"]) for t in trades if not t["win"]]
    losing_total = sum(losing_pnls)
    profit_factor = round(sum(winning_pnls) / losing_total, 2) if winning_pnls and losing_total > 0 else None
    avg_winner = round(sum(winning_pnls) / len(winning_pnls), 2) if winning_pnls else None
    avg_loser  = round(sum(losing_pnls)  / len(losing_pnls),  2) if losing_pnls  else None
    hold_mins  = [t["hold_min"] for t in trades if t.get("hold_min") is not None]
    avg_hold   = round(sum(hold_mins) / len(hold_mins)) if hold_mins else None

    # --- Sessions ---
    sessions = []
    for dk in sessions_set:
        day_trades = [t for t in trades if t["date_key"] == dk]
        agg = _agg(day_trades)
        dt = datetime.strptime(dk, "%Y-%m-%d")
        day_capital = round(sum(
            (t.get("entry_price") or 0) * (t.get("quantity") or 1) * 100
            for t in day_trades
        ), 2)
        sessions.append({
            "date_key": dk,
            "date_label": dt.strftime("%b %d, %Y"),
            "capital_deployed": day_capital,
            **agg,
        })

    # --- Capital & P&L timeline: 30-min bucketed (opens → capital, closes → P&L) ---
    _cap_by_b: dict[str, float] = {}
    _opens_by_b: dict[str, int] = {}
    _pnl_by_b: dict[str, float] = {}
    _closes_by_b: dict[str, int] = {}
    _date_cap_by_b: dict[str, dict[str, float]] = {}  # date_key -> bucket -> capital

    for t in trades:
        capital = (t.get("entry_price") or 0) * (t.get("quantity") or 1) * 100
        pnl = t.get("pnl") or 0.0
        dk = t.get("date_key")

        ob = _to_bucket_30m(t["open_ts"])
        if ob:
            _cap_by_b[ob] = _cap_by_b.get(ob, 0.0) + capital
            _opens_by_b[ob] = _opens_by_b.get(ob, 0) + 1
            if dk:
                _date_cap_by_b.setdefault(dk, {})
                _date_cap_by_b[dk][ob] = _date_cap_by_b[dk].get(ob, 0.0) + capital

        cb = _to_bucket_30m(t["close_ts"])
        if cb:
            _pnl_by_b[cb] = _pnl_by_b.get(cb, 0.0) + pnl
            _closes_by_b[cb] = _closes_by_b.get(cb, 0) + 1

    _active_buckets = set(_cap_by_b) | set(_pnl_by_b)
    capital_timeline_rows = []
    _cum_pnl = 0.0
    _cum_cap = 0.0
    for b in BUCKETS_30M:
        if b not in _active_buckets:
            continue
        _bucket_pnl = round(_pnl_by_b.get(b, 0.0), 2)
        _bucket_cap = round(_cap_by_b.get(b, 0.0), 2)
        _cum_pnl = round(_cum_pnl + _bucket_pnl, 2)
        _cum_cap = round(_cum_cap + _bucket_cap, 2)
        row: dict[str, Any] = {
            "bucket": b,
            "capital": _bucket_cap,
            "opens": _opens_by_b.get(b, 0),
            "cumulative_capital": _cum_cap,
            "pnl": _bucket_pnl,
            "closes": _closes_by_b.get(b, 0),
            "cumulative_pnl": _cum_pnl,
        }
        for dk in sessions_set:
            if dk in _date_cap_by_b and b in _date_cap_by_b[dk]:
                row[dk] = round(_date_cap_by_b[dk][b], 2)
        capital_timeline_rows.append(row)
    capital_timeline = {"rows": capital_timeline_rows, "date_keys": sessions_set}

    # --- Per-strategy ---
    all_strategy_keys = sorted(set(t["strategy"] for t in trades))
    strategies: dict[str, Any] = {}
    for sk in all_strategy_keys:
        st_trades = [t for t in trades if t["strategy"] == sk]
        agg = _agg(st_trades)

        # by hour
        by_hour = []
        for hl in HOUR_LABELS:
            ht = [t for t in st_trades if t["hour_label"] == hl]
            if not ht:
                continue
            hagg = _agg(ht)
            tickers = sorted(set(t["symbol"] for t in ht))
            by_hour.append({"hour": hl, **hagg, "tickers": tickers})

        # trade list
        trade_list = []
        for t in reversed(st_trades):
            dt_close = _to_ny_dt(t["close_ts"])
            trade_list.append({
                "win": t["win"],
                "symbol": t["symbol"],
                "right": t["right"],
                "close_time": dt_close.strftime("%H:%M ET"),
                "date": datetime.strptime(t["date_key"], "%Y-%m-%d").strftime("%b %d, %Y"),
                "pnl": t["pnl"],
                "pnl_pct": t["pnl_pct"],
                "hold_min": t["hold_min"],
            })

        strategies[sk] = {
            "name": STRATEGY_NAMES.get(sk, sk),
            **agg,
            "by_hour": by_hour,
            "trade_list": trade_list,
        }

    # --- Cross-hour matrix (completed trades) ---
    cross_hour: dict[str, dict[str, Any]] = {}
    for hl in HOUR_LABELS:
        ht = [t for t in trades if t["hour_label"] == hl]
        if not ht:
            continue
        hour_data: dict[str, Any] = {"total": _agg(ht)}
        for sk in all_strategy_keys:
            st = [t for t in ht if t["strategy"] == sk]
            if st:
                hour_data[sk] = _agg(st)
        cross_hour[hl] = hour_data

    # --- Cross-hour opens matrix (all opened positions, including unclosed) ---
    cross_hour_opens: dict[str, dict[str, int]] = {}
    for hl in HOUR_LABELS:
        # Count all OPEN entries in this hour
        hour_opens: dict[str, int] = {"total": 0}
        for pid, entry in open_entries.items():
            hl_entry = _hour_label(entry.get("timestamp"))
            if hl_entry != hl:
                continue
            strategy = _normalize_strategy(entry.get("strategy_id"))
            hour_opens["total"] = hour_opens.get("total", 0) + 1
            hour_opens[strategy] = hour_opens.get(strategy, 0) + 1

        if hour_opens["total"] > 0:
            cross_hour_opens[hl] = hour_opens

    # --- Ticker summary ---
    ticker_map: dict[str, list[dict]] = {}
    for t in trades:
        ticker_map.setdefault(t["symbol"], []).append(t)

    ticker_summary = []
    for sym, tt in sorted(ticker_map.items()):
        agg = _agg(tt)
        calls = [t for t in tt if t["right"] == "C"]
        puts = [t for t in tt if t["right"] == "P"]
        ticker_summary.append({
            "symbol": sym,
            **agg,
            "calls": _agg(calls) if calls else None,
            "puts": _agg(puts) if puts else None,
        })
    ticker_summary.sort(key=lambda x: x["pnl"], reverse=True)

    # --- Best/worst trades ---
    scored = [t for t in trades if t["pnl_pct"] is not None]
    scored_sorted = sorted(scored, key=lambda t: t["pnl_pct"] or 0, reverse=True)

    def _trade_row(t: dict) -> dict:
        dt_close = _to_ny_dt(t["close_ts"])
        return {
            "win": t["win"],
            "symbol": t["symbol"],
            "right": t["right"],
            "date": datetime.strptime(t["date_key"], "%Y-%m-%d").strftime("%b %d, %Y"),
            "pnl": t["pnl"],
            "pnl_pct": t["pnl_pct"],
            "hold_min": t["hold_min"],
            "strategy": STRATEGY_NAMES.get(t["strategy"], t["strategy"]),
            "close_time": dt_close.strftime("%H:%M ET"),
        }

    best_trades = [_trade_row(t) for t in scored_sorted[:5]]
    worst_trades = [_trade_row(t) for t in scored_sorted[-5:][::-1]]

    # --- Calls vs Puts ---
    calls_trades = [t for t in trades if t["right"] == "C"]
    puts_trades = [t for t in trades if t["right"] == "P"]

    cp_by_hour = []
    for hl in HOUR_LABELS:
        c = [t for t in calls_trades if t["hour_label"] == hl]
        p = [t for t in puts_trades if t["hour_label"] == hl]
        if c or p:
            cp_by_hour.append({
                "hour": hl,
                "calls": _agg(c) if c else None,
                "puts": _agg(p) if p else None,
            })

    cp_by_strategy = []
    for sk in all_strategy_keys:
        c = [t for t in calls_trades if t["strategy"] == sk]
        p = [t for t in puts_trades if t["strategy"] == sk]
        if c or p:
            cp_by_strategy.append({
                "strategy": STRATEGY_NAMES.get(sk, sk),
                "calls": _agg(c) if c else None,
                "puts": _agg(p) if p else None,
            })

    cp_by_ticker = []
    all_tickers = sorted(set(t["symbol"] for t in trades))
    for sym in all_tickers:
        c = [t for t in calls_trades if t["symbol"] == sym]
        p = [t for t in puts_trades if t["symbol"] == sym]
        if c or p:
            cp_by_ticker.append({
                "symbol": sym,
                "calls": _agg(c) if c else None,
                "puts": _agg(p) if p else None,
            })

    report = {
        "date_range": {"start": start_date, "end": end_date},
        "overview": {
            "sessions": len(sessions_set),
            "completed_trades": len(trades),
            "total_pnl": total_pnl,
            "win_rate": win_rate,
            "winners": winners,
            "losers": losers,
            "total_capital_deployed": total_capital,
            "avg_capital_per_trade": avg_capital,
            "return_on_capital": return_on_capital,
            "profit_factor": profit_factor,
            "avg_winner": avg_winner,
            "avg_loser": avg_loser,
            "avg_hold_min": avg_hold,
            "open_trades": open_count,
            "open_capital_deployed": open_capital,
        },
        "open_positions_detail": open_positions_detail,
        "open_tp_analysis": open_tp_analysis,
        "sessions": sessions,
        "strategies": strategies,
        "strategy_keys": all_strategy_keys,
        "cross_hour": cross_hour,
        "cross_hour_opens": cross_hour_opens,
        "ticker_summary": ticker_summary,
        "best_trades": best_trades,
        "worst_trades": worst_trades,
        "calls_puts": {
            "calls": _agg(calls_trades),
            "puts": _agg(puts_trades),
            "by_hour": cp_by_hour,
            "by_strategy": cp_by_strategy,
            "by_ticker": cp_by_ticker,
        },
        "signal_stats": _compute_signal_stats(activity, trades, all_strategy_keys),
        "iv_mfe_mae": _compute_iv_mfe_mae(trades, open_entries, close_entries),
        "market_context": _compute_market_context(activity, trades),
        "ticker_tp_analysis": _compute_tp_analysis(trades, open_entries, close_entries),
        "capital_timeline": capital_timeline,
    }

    if include_post_exit:
        _post_exit = await _compute_post_exit_opportunity(trades, open_entries, close_entries)
        report["post_exit_opportunity"] = _post_exit["rows"]
        report["post_exit_debug"] = _post_exit["debug"]
    else:
        report["post_exit_opportunity"] = []
        report["post_exit_debug"] = {}
    return report
