"""Strategy analysis used by the backend auto-trader."""
from __future__ import annotations

import bisect
import math
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

Bar = Dict[str, Any]


@dataclass
class StrategySignal:
    id: str
    symbol: str
    strategy_id: str
    direction: str
    entry_time: int
    anchor_time: Optional[int] = None
    # Optional per-signal context the detector may attach to explain WHY this
    # signal fired. Carried through the simulator into the trade record so
    # downstream UIs (e.g. the backtest report modal) can render specifics
    # like "Position 2 — above call wall, spot $738.20 vs CW $738".
    metadata: Optional[Dict[str, Any]] = None


NY_TZ = ZoneInfo("America/New_York")


def calculate_ma(bars: List[Bar], period: int) -> List[Optional[float]]:
    values: List[Optional[float]] = [None] * len(bars)
    total = 0.0
    for i, bar in enumerate(bars):
        total += bar["close"]
        if i >= period:
            total -= bars[i - period]["close"]
        if i >= period - 1:
            values[i] = total / period
    return values


def aggregate_intraday_bars(bars: List[Bar], minutes: int) -> List[Bar]:
    """Aggregate sorted intraday bars into fixed-minute NY-time buckets."""
    if minutes <= 1:
        return list(bars)

    aggregated: List[Bar] = []
    current_bucket: Optional[int] = None
    current_bar: Optional[Bar] = None

    for bar in bars:
        dt = datetime.fromtimestamp(bar["time"], NY_TZ)
        bucket_minute = (dt.minute // minutes) * minutes
        bucket_dt = dt.replace(minute=bucket_minute, second=0, microsecond=0)
        bucket_ts = int(bucket_dt.timestamp())

        if current_bucket != bucket_ts:
            if current_bar is not None:
                aggregated.append(current_bar)
            current_bucket = bucket_ts
            current_bar = {
                **bar,
                "time": bucket_ts,
                "open": bar["open"],
                "high": bar["high"],
                "low": bar["low"],
                "close": bar["close"],
                "volume": bar.get("volume", 0),
            }
            continue

        if current_bar is None:
            continue
        current_bar["high"] = max(current_bar["high"], bar["high"])
        current_bar["low"] = min(current_bar["low"], bar["low"])
        current_bar["close"] = bar["close"]
        current_bar["volume"] = current_bar.get("volume", 0) + bar.get("volume", 0)

    if current_bar is not None:
        aggregated.append(current_bar)

    return aggregated


def calculate_session_vwap(bars: List[Bar]) -> List[Optional[float]]:
    values: List[Optional[float]] = [None] * len(bars)
    current_day = None
    pv_total = 0.0
    volume_total = 0.0

    for i, bar in enumerate(bars):
        day_key = get_ny_day_key(bar["time"])
        if day_key != current_day:
            current_day = day_key
            pv_total = 0.0
            volume_total = 0.0

        volume = float(bar.get("volume", 0) or 0)
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3
        pv_total += typical * volume
        volume_total += volume
        if volume_total > 0:
            values[i] = pv_total / volume_total

    return values


def calculate_bollinger(
    bars: List[Bar], period: int = 20, mult: float = 2.0
) -> Dict[str, List[Optional[float]]]:
    mid = calculate_ma(bars, period)
    upper: List[Optional[float]] = [None] * len(bars)
    lower: List[Optional[float]] = [None] * len(bars)
    # O(n) incremental variance: maintain running sum and sum-of-squares
    sum_x = 0.0
    sum_x2 = 0.0
    for i in range(len(bars)):
        close = bars[i]["close"]
        sum_x += close
        sum_x2 += close * close
        if i >= period:
            old = bars[i - period]["close"]
            sum_x -= old
            sum_x2 -= old * old
        if i < period - 1 or mid[i] is None:
            continue
        mean = sum_x / period
        # Var(X) = E[X²] - E[X]²; clamp to zero to absorb floating-point drift
        var = max(0.0, sum_x2 / period - mean * mean)
        std = var ** 0.5
        upper[i] = mean + mult * std
        lower[i] = mean - mult * std
    return {"upper": upper, "lower": lower, "mid": mid}


def calculate_ema(values: List[float], length: int) -> List[float]:
    if not values:
        return []
    alpha = 2 / (length + 1)
    result = [values[0]]
    for value in values[1:]:
        result.append(alpha * value + (1 - alpha) * result[-1])
    return result


def calculate_worden_stoch(
    bars: List[Bar], period: int = 14, k_smooth: int = 3, d_smooth: int = 3
) -> Dict[str, List[Optional[float]]]:
    raw_k: List[Optional[float]] = [None] * len(bars)
    # O(n) sliding-window max/min using monotonic deques
    max_dq: deque = deque()  # indices; front holds index of current window max
    min_dq: deque = deque()  # indices; front holds index of current window min
    for i in range(len(bars)):
        high_i = bars[i]["high"]
        low_i = bars[i]["low"]
        # Keep max_dq decreasing by high value
        while max_dq and bars[max_dq[-1]]["high"] <= high_i:
            max_dq.pop()
        max_dq.append(i)
        # Keep min_dq increasing by low value
        while min_dq and bars[min_dq[-1]]["low"] >= low_i:
            min_dq.pop()
        min_dq.append(i)
        # Evict indices that have left the window
        if max_dq[0] < i - period + 1:
            max_dq.popleft()
        if min_dq[0] < i - period + 1:
            min_dq.popleft()
        if i < period - 1:
            continue
        window_high = bars[max_dq[0]]["high"]
        window_low = bars[min_dq[0]]["low"]
        rng = window_high - window_low
        raw_k[i] = 0.0 if rng == 0 else ((bars[i]["close"] - window_low) / rng) * 100
    raw_compact = [v for v in raw_k if v is not None]
    k_smoothed = calculate_ema(raw_compact, k_smooth) if k_smooth > 1 else raw_compact
    d_smoothed = calculate_ema(k_smoothed, d_smooth) if d_smooth > 1 else k_smoothed
    k_values: List[Optional[float]] = [None] * len(bars)
    d_values: List[Optional[float]] = [None] * len(bars)
    start_idx = next((i for i, v in enumerate(raw_k) if v is not None), len(bars))
    for i, val in enumerate(k_smoothed):
        if start_idx + i < len(k_values):
            k_values[start_idx + i] = val
    for i, val in enumerate(d_smoothed):
        if start_idx + i < len(d_values):
            d_values[start_idx + i] = val
    return {"k": k_values, "d": d_values}


def get_ny_parts(unix_seconds: int) -> Dict[str, int]:
    dt = datetime.fromtimestamp(unix_seconds, NY_TZ)
    return {
        "year": dt.year,
        "month": dt.month,
        "day": dt.day,
        "hour": dt.hour,
        "minute": dt.minute,
    }


def get_ny_day_key(unix_seconds: int) -> str:
    parts = get_ny_parts(unix_seconds)
    return f"{parts['year']:04d}-{parts['month']:02d}-{parts['day']:02d}"


def within_visible_range(time: int, visible_range: Dict[str, int]) -> bool:
    return visible_range["from"] <= time <= visible_range["to"]


def nearest_index(bars: List[Bar], t: int) -> int:
    # O(log n) binary search; bars must be sorted by time ascending
    if not bars:
        return -1
    times = [bar["time"] for bar in bars]
    pos = bisect.bisect_right(times, t) - 1
    return pos


def linear_regression(values: List[float]) -> Dict[str, float]:
    n = len(values)
    if n == 0:
        return {"slope": 0.0, "intercept": 0.0}
    sum_x = n * (n - 1) / 2
    sum_x2 = (n - 1) * n * (2 * n - 1) / 6
    sum_y = sum(values)
    sum_xy = sum(i * v for i, v in enumerate(values))
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return {"slope": 0.0, "intercept": values[-1]}
    slope = (n * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y - slope * sum_x) / n
    return {"slope": slope, "intercept": intercept}


def calculate_rsi(prices: List[float], period: int = 14) -> List[Optional[float]]:
    """Calculate RSI (Relative Strength Index) using Wilder's smoothing.

    Args:
        prices: List of closing prices
        period: RSI period (default 14)

    Returns:
        List of RSI values (0-100), with None for initial period bars
    """
    if len(prices) < period + 1:
        return [None] * len(prices)

    rsi_values: List[Optional[float]] = [None] * len(prices)
    gains = []
    losses = []

    # Calculate initial gains and losses
    for i in range(1, len(prices)):
        change = prices[i] - prices[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))

    # Calculate initial average gain and loss (SMA for first period)
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    # First RSI value
    if avg_loss == 0:
        rsi_values[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        rsi_values[period] = 100 - (100 / (1 + rs))

    # Calculate subsequent RSI values using Wilder's smoothing
    for i in range(period + 1, len(prices)):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period

        if avg_loss == 0:
            rsi_values[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi_values[i] = 100 - (100 / (1 + rs))

    return rsi_values


def calculate_atr(bars: List[Bar], period: int = 14) -> List[Optional[float]]:
    """Calculate Average True Range using Wilder's smoothing.

    Returns List[Optional[float]] matching bar count, with None for initial bars.
    """
    if len(bars) < 2:
        return [None] * len(bars)

    atr_values: List[Optional[float]] = [None] * len(bars)

    # True Range for each bar (starting from index 1)
    tr_list: List[float] = []
    for i in range(1, len(bars)):
        high = bars[i]["high"]
        low = bars[i]["low"]
        prev_close = bars[i - 1]["close"]
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        tr_list.append(tr)

    if len(tr_list) < period:
        return atr_values

    # Initial ATR = SMA of first `period` true ranges
    atr = sum(tr_list[:period]) / period
    atr_values[period] = atr  # index `period` because tr_list starts at bar 1

    # Wilder's smoothing for subsequent values
    for i in range(period, len(tr_list)):
        atr = (atr * (period - 1) + tr_list[i]) / period
        atr_values[i + 1] = atr  # offset +1 because tr_list is 0-based from bar 1

    return atr_values


def calculate_choppiness_index(bars: List[Bar], period: int = 14) -> List[Optional[float]]:
    """Calculate Choppiness Index.

    CI = 100 * log10(SUM(ATR_1) over period / (HH - LL)) / log10(period)
    Scale 0-100: >61.8 = choppy, <38.2 = trending.
    Uses O(n) sliding window for HH/LL (monotonic deques).
    """
    if len(bars) < period + 1:
        return [None] * len(bars)

    ci_values: List[Optional[float]] = [None] * len(bars)

    # Pre-compute single-bar true ranges (from index 1)
    tr_list: List[float] = [0.0]  # placeholder for index 0
    for i in range(1, len(bars)):
        high = bars[i]["high"]
        low = bars[i]["low"]
        prev_close = bars[i - 1]["close"]
        tr_list.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))

    # O(n) sliding window max-high / min-low
    max_dq: deque = deque()
    min_dq: deque = deque()

    # Running sum of TR over `period` bars
    tr_window_sum = 0.0
    log_period = math.log10(period)

    for i in range(len(bars)):
        h = bars[i]["high"]
        l = bars[i]["low"]

        while max_dq and bars[max_dq[-1]]["high"] <= h:
            max_dq.pop()
        max_dq.append(i)

        while min_dq and bars[min_dq[-1]]["low"] >= l:
            min_dq.pop()
        min_dq.append(i)

        if max_dq[0] < i - period + 1:
            max_dq.popleft()
        if min_dq[0] < i - period + 1:
            min_dq.popleft()

        # Maintain rolling TR sum
        tr_window_sum += tr_list[i]
        if i >= period:
            tr_window_sum -= tr_list[i - period]

        if i < period:
            continue

        hh = bars[max_dq[0]]["high"]
        ll = bars[min_dq[0]]["low"]
        rng = hh - ll

        if rng <= 0 or log_period == 0:
            ci_values[i] = 100.0
        else:
            ci_values[i] = 100.0 * math.log10(tr_window_sum / rng) / log_period

    return ci_values


def within_0dte_window(
    current_time: int,
    entry_start: Optional[str] = None,
    entry_end: Optional[str] = None
) -> bool:
    """Check if current time is within the allowed 0DTE entry window.

    Args:
        current_time: Unix timestamp in seconds
        entry_start: Start time in HH:MM format (e.g., "09:45"), None = 9:30 AM ET
        entry_end: End time in HH:MM format (e.g., "13:00"), None = 3:45 PM ET

    Returns:
        True if within window, False otherwise
    """
    parts = get_ny_parts(current_time)
    current_hour = parts["hour"]
    current_minute = parts["minute"]
    current_mins = current_hour * 60 + current_minute

    # Default window: 9:30 AM (570 mins) to 3:45 PM (945 mins) ET
    start_mins = 570
    end_mins = 945

    if entry_start:
        try:
            start_h, start_m = map(int, entry_start.split(":"))
            start_mins = start_h * 60 + start_m
        except (ValueError, AttributeError):
            pass

    if entry_end:
        try:
            end_h, end_m = map(int, entry_end.split(":"))
            end_mins = end_h * 60 + end_m
        except (ValueError, AttributeError):
            pass

    return start_mins <= current_mins <= end_mins


def is_spx_only(symbol: str) -> bool:
    """Check if symbol is SPX (for 0DTE strategies filter).

    Args:
        symbol: Ticker symbol

    Returns:
        True if symbol is SPX, False otherwise
    """
    return symbol.upper() == "SPX"


def analyze_with_bars(
    symbol: str,
    visible_range: Dict[str, int],
    bars1h: List[Bar],
    bars15m: List[Bar],
    bars1d: List[Bar],
    bars1m: List[Bar],
    settings: Dict[str, Any],
    bars5m: Optional[List[Bar]] = None,
    bars15m_open: Optional[List[Bar]] = None,
    enabled_strategies: Optional[set] = None,
) -> List[StrategySignal]:
    """Run strategy detection on bar data.

    Args:
        enabled_strategies: If provided, only run these strategy numbers.
            Mapping: 1-5=strategy1-5, 6=ct15, 60=ct_open, 7-11=strategy7-11.
            When None (default), run all strategies.
    """
    signals: List[StrategySignal] = []
    # Normalize enabled_strategies to a set of ints (settings JSON may store strings)
    if enabled_strategies is not None:
        enabled_strategies = {int(s) for s in enabled_strategies}
    run_all = enabled_strategies is None

    # Pre-compute shared indicators only when needed
    need_swing = run_all or bool(enabled_strategies & {1, 2, 3, 4, 5, 6, 60})
    if need_swing:
        ma20_1h = calculate_ma(bars1h, 20)
        ma40_1h = calculate_ma(bars1h, 40)
        ma20_15m = calculate_ma(bars15m, 20)
        stoch15m = calculate_worden_stoch(bars15m, 14, 3, 3)
        ma20_1d = calculate_ma(bars1d, 20)
        ma40_1d = calculate_ma(bars1d, 40)

    if run_all or 1 in enabled_strategies:
        signals.extend(
            detect_strategy1(
                symbol, visible_range, bars1h, bars15m, ma20_1h, ma40_1h, ma20_15m, stoch15m, settings
            )
        )
    if run_all or 2 in enabled_strategies:
        signals.extend(
            detect_strategy2(
                symbol, visible_range, bars1d, bars1h, bars15m, ma20_1d, ma40_1d, ma20_15m, stoch15m, settings
            )
        )
    if run_all or 3 in enabled_strategies:
        signals.extend(
            detect_strategy3(
                symbol, visible_range, bars1d, bars15m, bars1m, settings
            )
        )
    if run_all or 4 in enabled_strategies:
        signals.extend(
            detect_strategy4(
                symbol, visible_range, bars1h, bars15m, ma20_1h, ma40_1h, ma20_15m, stoch15m, settings
            )
        )
    if run_all or 5 in enabled_strategies:
        signals.extend(
            detect_strategy5(
                symbol, visible_range, bars1d, bars15m, bars1m, settings
            )
        )
    if run_all or 6 in enabled_strategies:
        signals.extend(
            detect_ct15(
                symbol, visible_range, bars1d, bars15m, settings
            )
        )

    if bars15m_open and (run_all or 60 in enabled_strategies):
        signals.extend(
            detect_ct_open(
                symbol, visible_range, bars15m_open, bars1m, settings
            )
        )

    # 0DTE strategies (ticker filtering handled inside each strategy)
    current_price = bars1m[-1]["close"] if bars1m else 0.0

    # Strategy 10 uses 1m bars and derives 2m alignment internally.
    if bars1m and (run_all or 10 in enabled_strategies):
        signals.extend(
            detect_strategy10(
                symbol, visible_range, bars1m, current_price, settings
            )
        )

    # Other 0DTE strategies still require 5m bars.
    if bars5m:
        if run_all or 7 in enabled_strategies:
            signals.extend(
                detect_strategy7(
                    symbol, visible_range, bars1m, current_price, settings
                )
            )
        if run_all or 8 in enabled_strategies:
            signals.extend(
                detect_strategy8(
                    symbol, visible_range, bars1m, bars5m, current_price, settings
                )
            )
        if run_all or 9 in enabled_strategies:
            signals.extend(
                detect_strategy9(
                    symbol, visible_range, bars1m, bars15m, bars1d, current_price, settings
                )
            )
        if run_all or 11 in enabled_strategies:
            signals.extend(
                detect_strategy11(
                    symbol, visible_range, bars5m, bars1d, current_price, settings
                )
            )

    return signals


def detect_strategy1(
    symbol: str,
    visible_range: Dict[str, int],
    bars1h: List[Bar],
    bars15m: List[Bar],
    ma20_1h: List[Optional[float]],
    ma40_1h: List[Optional[float]],
    ma20_15m: List[Optional[float]],
    stoch15m: Dict[str, List[Optional[float]]],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    if not settings.get("strategy1", {}).get("enabled", True):
        return signals
    cooldown = settings["strategy1"]["cooldownHours"] * 3600
    window15m = settings["strategy1"]["window15m"]
    trend_lookback = settings["strategy1"]["trendLookback"]
    last_signal = {"CALL": 0, "PUT": 0}

    def try_confirm(start_idx: int, direction: str) -> Optional[int]:
        for i in range(start_idx, min(len(bars15m), start_idx + window15m)):
            ma20 = ma20_15m[i]
            bar = bars15m[i]
            if ma20 is not None:
                if direction == "CALL" and bar["close"] > ma20:
                    return i
                if direction == "PUT" and bar["close"] < ma20:
                    return i
            k_prev = stoch15m["k"][i - 1] if i - 1 >= 0 else None
            k_val = stoch15m["k"][i]
            d_prev = stoch15m["d"][i - 1] if i - 1 >= 0 else None
            d_val = stoch15m["d"][i]
            if k_prev is None or k_val is None:
                continue
            if direction == "CALL":
                if k_prev <= 20 and k_val > 20:
                    return i
                if d_prev is not None and d_val is not None and k_prev <= d_prev and k_val > d_val:
                    return i
            else:
                if k_prev >= 80 and k_val < 80:
                    return i
                if d_prev is not None and d_val is not None and k_prev >= d_prev and k_val < d_val:
                    return i
        return None

    for t in range(trend_lookback, len(bars1h)):
        ma20 = ma20_1h[t]
        ma40 = ma40_1h[t]
        ma20_prev = ma20_1h[t - 1] if t - 1 >= 0 else None
        if ma20 is None or ma40 is None or ma20_prev is None:
            continue
        if ma20_1h[t - trend_lookback] is None:
            continue
        slope = (ma20 - ma20_1h[t - trend_lookback]) / trend_lookback

        prev_down = (
            bars1h[t - 1]["close"] < (ma40_1h[t - 1] or float("inf"))
            and bars1h[t - 2]["close"] < (ma40_1h[t - 2] or float("inf"))
            and bars1h[t - 3]["close"] < (ma40_1h[t - 3] or float("inf"))
            and slope <= 0
        )
        prev_up = (
            bars1h[t - 1]["close"] > (ma40_1h[t - 1] or float("-inf"))
            and bars1h[t - 2]["close"] > (ma40_1h[t - 2] or float("-inf"))
            and bars1h[t - 3]["close"] > (ma40_1h[t - 3] or float("-inf"))
            and slope >= 0
        )
        cross_up = bars1h[t - 1]["close"] <= (ma20_1h[t - 1] or float("inf")) and bars1h[t]["close"] > ma20
        cross_down = bars1h[t - 1]["close"] >= (ma20_1h[t - 1] or float("-inf")) and bars1h[t]["close"] < ma20

        anchor_time = bars1h[t]["time"]
        confirm_start = next((i for i, b in enumerate(bars15m) if b["time"] > anchor_time), -1)
        if confirm_start < 0:
            continue

        if prev_down and cross_up:
            confirm_idx = try_confirm(confirm_start, "CALL")
            if confirm_idx is None:
                continue
            entry_time = bars15m[confirm_idx]["time"]
            if not within_visible_range(entry_time, visible_range):
                continue
            if entry_time - last_signal["CALL"] < cooldown:
                continue
            last_signal["CALL"] = entry_time
            signals.append(
                StrategySignal(
                    id=f"{symbol}-call-{entry_time}",
                    symbol=symbol,
                    strategy_id="strategy-1",
                    direction="CALL",
                    entry_time=entry_time,
                    anchor_time=anchor_time,
                )
            )

        if prev_up and cross_down:
            confirm_idx = try_confirm(confirm_start, "PUT")
            if confirm_idx is None:
                continue
            entry_time = bars15m[confirm_idx]["time"]
            if not within_visible_range(entry_time, visible_range):
                continue
            if entry_time - last_signal["PUT"] < cooldown:
                continue
            last_signal["PUT"] = entry_time
            signals.append(
                StrategySignal(
                    id=f"{symbol}-put-{entry_time}",
                    symbol=symbol,
                    strategy_id="strategy-1",
                    direction="PUT",
                    entry_time=entry_time,
                    anchor_time=anchor_time,
                )
            )

    return signals


def detect_strategy2(
    symbol: str,
    visible_range: Dict[str, int],
    bars1d: List[Bar],
    bars1h: List[Bar],
    bars15m: List[Bar],
    ma20_1d: List[Optional[float]],
    ma40_1d: List[Optional[float]],
    ma20_15m: List[Optional[float]],
    stoch15m: Dict[str, List[Optional[float]]],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    if not settings.get("strategy2", {}).get("enabled", True):
        return signals
    cooldown = settings["strategy2"]["cooldownHours"] * 3600
    window15m = settings["strategy2"]["window15m"]
    window1h = settings["strategy2"]["window1h"]
    touch_pct = settings["strategy2"]["touchPct"]
    daily_lookback = settings["strategy2"]["dailyTrendLookback"]
    last_signal = {"CALL": 0, "PUT": 0}

    _bars1d_times = [bar["time"] for bar in bars1d]

    def daily_index(time: int) -> int:
        return bisect.bisect_right(_bars1d_times, time) - 1

    def try_confirm15m(start_idx: int, direction: str) -> Optional[int]:
        for i in range(start_idx, min(len(bars15m), start_idx + window15m)):
            ma20 = ma20_15m[i]
            bar = bars15m[i]
            if ma20 is not None:
                if direction == "CALL" and bar["close"] > ma20:
                    return i
                if direction == "PUT" and bar["close"] < ma20:
                    return i
            k_prev = stoch15m["k"][i - 1] if i - 1 >= 0 else None
            k_val = stoch15m["k"][i]
            d_prev = stoch15m["d"][i - 1] if i - 1 >= 0 else None
            d_val = stoch15m["d"][i]
            if k_prev is None or k_val is None:
                continue
            if direction == "CALL":
                if k_prev <= 20 and k_val > 20:
                    return i
                if d_prev is not None and d_val is not None and k_prev <= d_prev and k_val > d_val:
                    return i
            else:
                if k_prev >= 80 and k_val < 80:
                    return i
                if d_prev is not None and d_val is not None and k_prev >= d_prev and k_val < d_val:
                    return i
        return None

    for i, bar in enumerate(bars1h):
        d_idx = daily_index(bar["time"])
        if d_idx < daily_lookback:
            continue
        ma20 = ma20_1d[d_idx]
        ma40 = ma40_1d[d_idx]
        if ma20 is None or ma40 is None or ma20_1d[d_idx - daily_lookback] is None:
            continue
        slope = (ma20 - ma20_1d[d_idx - daily_lookback]) / daily_lookback

        daily_down = slope <= 0 and all(
            bars1d[d_idx - j]["close"] < (ma40_1d[d_idx - j] or float("inf"))
            for j in range(1, daily_lookback + 1)
        )
        daily_up = slope >= 0 and all(
            bars1d[d_idx - j]["close"] > (ma40_1d[d_idx - j] or float("-inf"))
            for j in range(1, daily_lookback + 1)
        )

        distance_pct = abs(bar["close"] - ma20) / ma20
        high_distance = abs(bar["high"] - ma20) / ma20
        low_distance = abs(bar["low"] - ma20) / ma20
        touch = (
            (bar["low"] <= ma20 <= bar["high"])
            or distance_pct <= touch_pct
            or high_distance <= touch_pct
            or low_distance <= touch_pct
        )
        if not touch:
            continue

        if daily_down:
            confirm_idx = None
            for j in range(i + 1, min(len(bars1h), i + 1 + window1h)):
                if bars1h[j]["close"] < ma20 and bars1h[j]["close"] < bar["low"]:
                    confirm_idx = j
                    break
            if confirm_idx is not None:
                confirm_time = bars1h[confirm_idx]["time"]
                confirm_start = next((k for k, b in enumerate(bars15m) if b["time"] > confirm_time), -1)
                if confirm_start < 0:
                    continue
                confirm15m = try_confirm15m(confirm_start, "PUT")
                if confirm15m is None:
                    continue
                entry_time = bars15m[confirm15m]["time"]
                if not within_visible_range(entry_time, visible_range):
                    continue
                if entry_time - last_signal["PUT"] < cooldown:
                    continue
                last_signal["PUT"] = entry_time
                signals.append(
                    StrategySignal(
                        id=f"{symbol}-s2-put-{entry_time}",
                        symbol=symbol,
                        strategy_id="strategy2_midline_bounce_1d_1h_15m",
                        direction="PUT",
                        entry_time=entry_time,
                        anchor_time=confirm_time,
                    )
                )

        if daily_up:
            confirm_idx = None
            for j in range(i + 1, min(len(bars1h), i + 1 + window1h)):
                if bars1h[j]["close"] > ma20 and bars1h[j]["close"] > bar["high"]:
                    confirm_idx = j
                    break
            if confirm_idx is not None:
                confirm_time = bars1h[confirm_idx]["time"]
                confirm_start = next((k for k, b in enumerate(bars15m) if b["time"] > confirm_time), -1)
                if confirm_start < 0:
                    continue
                confirm15m = try_confirm15m(confirm_start, "CALL")
                if confirm15m is None:
                    continue
                entry_time = bars15m[confirm15m]["time"]
                if not within_visible_range(entry_time, visible_range):
                    continue
                if entry_time - last_signal["CALL"] < cooldown:
                    continue
                last_signal["CALL"] = entry_time
                signals.append(
                    StrategySignal(
                        id=f"{symbol}-s2-call-{entry_time}",
                        symbol=symbol,
                        strategy_id="strategy2_midline_bounce_1d_1h_15m",
                        direction="CALL",
                        entry_time=entry_time,
                        anchor_time=confirm_time,
                    )
                )

    return signals


def detect_strategy3(
    symbol: str,
    visible_range: Dict[str, int],
    bars1d: List[Bar],
    bars15m: List[Bar],
    bars1m: List[Bar],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    s3 = settings["strategy3"]
    if not s3.get("enabled", True):
        return signals
    entry_window_end = 30 + s3["entryWindowMinutes"]
    if not bars1m or not bars15m:
        return signals

    bands15m = calculate_bollinger(bars15m, 20, 2)
    bandwidth15m: List[Optional[float]] = []
    for idx, mid in enumerate(bands15m["mid"]):
        if mid is None or bands15m["upper"][idx] is None or bands15m["lower"][idx] is None:
            bandwidth15m.append(None)
        else:
            bandwidth15m.append((bands15m["upper"][idx] - bands15m["lower"][idx]) / mid)

    bars1m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars1m:
        bars1m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars1m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars15m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars15m:
        bars15m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars15m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars1d_by_day = {get_ny_day_key(bar["time"]): bar for bar in bars1d}

    for day_key, day_bars_1m in bars1m_by_day.items():
        open_bar = next(
            (bar for bar in day_bars_1m if get_ny_parts(bar["time"])["hour"] == 9 and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open_bar:
            continue
        if not within_visible_range(open_bar["time"], visible_range):
            continue
        prior_day_key = get_ny_day_key(open_bar["time"] - 86400)
        prior_bars = bars1m_by_day.get(prior_day_key, [])
        prior_close_bar = next(
            (bar for bar in reversed(prior_bars) if get_ny_parts(bar["time"])["hour"] == 16 and get_ny_parts(bar["time"])["minute"] == 0),
            None,
        )
        prior_close = prior_close_bar["close"] if prior_close_bar else (bars1d_by_day.get(prior_day_key) or {}).get("close")
        if not prior_close:
            continue

        gap_pct = (open_bar["open"] - prior_close) / prior_close
        gap_up = gap_pct >= s3["minGapPct"]
        gap_down = gap_pct <= -s3["minGapPct"]
        if not gap_up and not gap_down:
            continue

        day_bars_15m = bars15m_by_day.get(day_key, [])
        open15m = next(
            (bar for bar in day_bars_15m if get_ny_parts(bar["time"])["hour"] == 9 and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open15m:
            continue
        open15m_idx = next((i for i, bar in enumerate(bars15m) if bar["time"] == open15m["time"]), -1)
        if open15m_idx < 0:
            continue
        bb_upper = bands15m["upper"][open15m_idx]
        bb_lower = bands15m["lower"][open15m_idx]
        bb_bw = bandwidth15m[open15m_idx]
        if bb_upper is None or bb_lower is None or bb_bw is None:
            continue

        window_start = max(0, open15m_idx - s3["tightLookback"] + 1)
        window = [v for v in bandwidth15m[window_start : open15m_idx + 1] if v is not None]
        if len(window) < min(20, s3["tightLookback"]):
            continue
        sorted_vals = sorted(window)
        rank = next((i for i, v in enumerate(sorted_vals) if v >= bb_bw), len(sorted_vals) - 1)
        percentile = (rank + 1) / len(sorted_vals) * 100
        if percentile > s3["tightPercentile"]:
            continue

        open_outside_upper = open_bar["open"] > bb_upper * (1 + s3["bandOutsideTol"])
        open_outside_lower = open_bar["open"] < bb_lower * (1 - s3["bandOutsideTol"])
        if gap_up and not open_outside_upper:
            continue
        if gap_down and not open_outside_lower:
            continue

        entry_window = [
            bar
            for bar in day_bars_1m
            if (p := get_ny_parts(bar["time"])) and p["hour"] == 9 and 30 <= p["minute"] < entry_window_end
        ]
        entry_bar: Optional[Bar] = None
        for i in range(1, len(entry_window)):
            prev = entry_window[i - 1]
            curr = entry_window[i]
            if gap_up and curr["close"] < curr["open"] and curr["close"] < prev["low"]:
                entry_bar = curr
                break
            if gap_down and curr["close"] > curr["open"] and curr["close"] > prev["high"]:
                entry_bar = curr
                break
        if not entry_bar:
            continue
        if not within_visible_range(entry_bar["time"], visible_range):
            continue
        direction = "PUT" if gap_up else "CALL"
        signals.append(
            StrategySignal(
                id=f"{symbol}-s3-{day_key}-{entry_bar['time']}",
                symbol=symbol,
                strategy_id="strategy3_open_gap_fade_lowvol_15m_1m",
                direction=direction,
                entry_time=entry_bar["time"],
                anchor_time=open15m["time"],
            )
        )

    return signals


def detect_strategy4(
    symbol: str,
    visible_range: Dict[str, int],
    bars1h: List[Bar],
    bars15m: List[Bar],
    ma20_1h: List[Optional[float]],
    ma40_1h: List[Optional[float]],
    ma20_15m: List[Optional[float]],
    stoch15m: Dict[str, List[Optional[float]]],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    s4 = settings["strategy4"]
    if not s4.get("enabled", True):
        return signals
    cooldown = s4["cooldownHours"] * 3600
    last_signal = {"CALL": 0, "PUT": 0}
    bands15m = calculate_bollinger(bars15m, 20, 2)

    day_groups: Dict[str, List[int]] = {}
    for idx, bar in enumerate(bars15m):
        day_groups.setdefault(get_ny_day_key(bar["time"]), []).append(idx)

    for indices in day_groups.values():
        indices.sort()
        open_idx = next(
            (idx for idx in indices if (p := get_ny_parts(bars15m[idx]["time"])) and p["hour"] == 9 and p["minute"] == 30),
            None,
        )
        if open_idx is None:
            continue
        start = indices.index(open_idx)
        window_indices = indices[start : start + s4["firstBarWindow"]]
        first_outside_idx = None
        outside_dir = None
        for idx in window_indices:
            upper = bands15m["upper"][idx]
            lower = bands15m["lower"][idx]
            if upper is not None and bars15m[idx]["close"] > upper:
                first_outside_idx = idx
                outside_dir = "upper"
                break
            if lower is not None and bars15m[idx]["close"] < lower:
                first_outside_idx = idx
                outside_dir = "lower"
                break
        if first_outside_idx is None:
            continue

        k = first_outside_idx
        ma20 = ma20_15m[k]
        if ma20 is None:
            continue
        dist_pct = abs(bars15m[k]["close"] - ma20) / ma20
        if dist_pct < s4["minDistPct"]:
            continue

        idx1h = nearest_index(bars1h, bars15m[k]["time"])
        if idx1h < 3:
            continue
        slope = (
            (ma20_1h[idx1h] - ma20_1h[idx1h - 3]) / 3
            if ma20_1h[idx1h] is not None and ma20_1h[idx1h - 3] is not None
            else 0.0
        )
        closes_below = [
            bars1h[idx1h - 1]["close"] < (ma40_1h[idx1h - 1] or float("inf")),
            bars1h[idx1h - 2]["close"] < (ma40_1h[idx1h - 2] or float("inf")),
            bars1h[idx1h - 3]["close"] < (ma40_1h[idx1h - 3] or float("inf")),
        ]
        closes_above = [
            bars1h[idx1h - 1]["close"] > (ma40_1h[idx1h - 1] or float("-inf")),
            bars1h[idx1h - 2]["close"] > (ma40_1h[idx1h - 2] or float("-inf")),
            bars1h[idx1h - 3]["close"] > (ma40_1h[idx1h - 3] or float("-inf")),
        ]
        intraday_down = all(closes_below) and slope <= 0
        intraday_up = all(closes_above) and slope >= 0
        slope_weak = abs(slope) <= 0.01

        is_call = bars15m[k]["close"] < ma20 and outside_dir == "lower"
        is_put = bars15m[k]["close"] > ma20 and outside_dir == "upper"
        if not is_call and not is_put:
            continue

        confirm_idx = None
        for i in range(k + 1, min(len(bars15m), k + s4["confirmWindow"] + 1)):
            k_prev = stoch15m["k"][i - 1]
            k_val = stoch15m["k"][i]
            d_prev = stoch15m["d"][i - 1]
            d_val = stoch15m["d"][i]
            if k_prev is None or k_val is None:
                continue
            bullish = (k_prev <= 20 and k_val > 20) or (
                d_prev is not None and d_val is not None and k_prev <= d_prev and k_val > d_val
            )
            bearish = (k_prev >= 80 and k_val < 80) or (
                d_prev is not None and d_val is not None and k_prev >= d_prev and k_val < d_val
            )
            if is_call and bullish:
                confirm_idx = i
                break
            if is_put and bearish:
                confirm_idx = i
                break
        if confirm_idx is None:
            continue
        entry_time = bars15m[confirm_idx]["time"]
        if not within_visible_range(entry_time, visible_range):
            continue
        direction = "CALL" if is_call else "PUT"
        if entry_time - last_signal[direction] < cooldown:
            continue
        last_signal[direction] = entry_time
        trend_gate = (intraday_down or slope_weak) if direction == "CALL" else (intraday_up or slope_weak)
        if not trend_gate:
            continue
        signals.append(
            StrategySignal(
                id=f"{symbol}-s4-{entry_time}",
                symbol=symbol,
                strategy_id="strategy4_magnet_effect_gap_far_from_ma20_15m",
                direction=direction,
                entry_time=entry_time,
                anchor_time=bars15m[k]["time"],
            )
        )

    return signals


def detect_strategy5(
    symbol: str,
    visible_range: Dict[str, int],
    bars1d: List[Bar],
    bars15m: List[Bar],
    bars1m: List[Bar],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    s5 = settings["strategy5"]
    if not s5.get("enabled", True):
        return signals
    entry_window_end = 30 + s5["entryWindowMinutes"]
    if not bars1m or not bars15m:
        return signals

    bands15m = calculate_bollinger(bars15m, 20, 2)
    bandwidth15m: List[Optional[float]] = []
    for idx, mid in enumerate(bands15m["mid"]):
        if mid is None or bands15m["upper"][idx] is None or bands15m["lower"][idx] is None:
            bandwidth15m.append(None)
        else:
            bandwidth15m.append((bands15m["upper"][idx] - bands15m["lower"][idx]) / mid)

    bars1m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars1m:
        bars1m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars1m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars15m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars15m:
        bars15m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars15m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars1d_by_day = {get_ny_day_key(bar["time"]): bar for bar in bars1d}

    for day_key, day_bars_1m in bars1m_by_day.items():
        open_bar = next(
            (bar for bar in day_bars_1m if get_ny_parts(bar["time"])["hour"] == 9 and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open_bar:
            continue
        if not within_visible_range(open_bar["time"], visible_range):
            continue
        prior_day_key = get_ny_day_key(open_bar["time"] - 86400)
        prior_bars = bars1m_by_day.get(prior_day_key, [])
        prior_close_bar = next(
            (bar for bar in reversed(prior_bars) if get_ny_parts(bar["time"])["hour"] == 16 and get_ny_parts(bar["time"])["minute"] == 0),
            None,
        )
        prior_close = prior_close_bar["close"] if prior_close_bar else (bars1d_by_day.get(prior_day_key) or {}).get("close")
        if not prior_close:
            continue

        gap_pct = (open_bar["open"] - prior_close) / prior_close
        gap_up = gap_pct >= s5["minGapPct"]
        gap_down = gap_pct <= -s5["minGapPct"]
        if not gap_up and not gap_down:
            continue

        day_bars_15m = bars15m_by_day.get(day_key, [])
        open15m = next(
            (bar for bar in day_bars_15m if get_ny_parts(bar["time"])["hour"] == 9 and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open15m:
            continue
        open15m_idx = next((i for i, bar in enumerate(bars15m) if bar["time"] == open15m["time"]), -1)
        if open15m_idx < 0:
            continue
        bb_upper = bands15m["upper"][open15m_idx]
        bb_lower = bands15m["lower"][open15m_idx]
        bb_mid = bands15m["mid"][open15m_idx]
        bb_bw = bandwidth15m[open15m_idx]
        if bb_upper is None or bb_lower is None or bb_mid is None or bb_bw is None:
            continue

        window_start = max(0, open15m_idx - s5["tightLookback"] + 1)
        window = [v for v in bandwidth15m[window_start : open15m_idx + 1] if v is not None]
        if len(window) < min(20, s5["tightLookback"]):
            continue
        sorted_vals = sorted(window)
        rank = next((i for i, v in enumerate(sorted_vals) if v >= bb_bw), len(sorted_vals) - 1)
        percentile = (rank + 1) / len(sorted_vals) * 100
        if percentile > s5["tightPercentile"]:
            continue

        slope_mid = 0.0
        if open15m_idx - s5["flatLookback"] >= 0:
            prev_mid = bands15m["mid"][open15m_idx - s5["flatLookback"]]
            if prev_mid is not None:
                slope_mid = (bb_mid - prev_mid) / s5["flatLookback"]
        if abs(slope_mid) > s5["flatEpsilon"]:
            continue

        open_outside_upper = open_bar["open"] > bb_upper * (1 + s5["bandOutsideTol"])
        open_outside_lower = open_bar["open"] < bb_lower * (1 - s5["bandOutsideTol"])
        if gap_up and not open_outside_upper:
            continue
        if gap_down and not open_outside_lower:
            continue

        entry_window = [
            bar
            for bar in day_bars_1m
            if (p := get_ny_parts(bar["time"])) and p["hour"] == 9 and 30 <= p["minute"] < entry_window_end
        ]
        entry_bar: Optional[Bar] = None
        for i in range(1, len(entry_window)):
            prev = entry_window[i - 1]
            curr = entry_window[i]
            if gap_up and curr["close"] < curr["open"] and curr["close"] < prev["low"]:
                entry_bar = curr
                break
            if gap_down and curr["close"] > curr["open"] and curr["close"] > prev["high"]:
                entry_bar = curr
                break
        if not entry_bar:
            continue
        if not within_visible_range(entry_bar["time"], visible_range):
            continue
        direction = "PUT" if gap_up else "CALL"
        signals.append(
            StrategySignal(
                id=f"{symbol}-s5-{day_key}-{entry_bar['time']}",
                symbol=symbol,
                strategy_id="strategy5_lateral_open_outside_bollinger_no_vol",
                direction=direction,
                entry_time=entry_bar["time"],
                anchor_time=open15m["time"],
            )
        )

    return signals


def detect_strategy7(
    symbol: str,
    visible_range: Dict[str, int],
    bars1m: List[Bar],
    current_price: float,
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """Strategy 7: 0DTE Scalper

    - Timeframe: 1-minute bars
    - Target gain: 5-20% (default 10%)
    - Hold duration: 1-5 minutes
    - Expected frequency: 10-20 trades/day
    - Signal criteria:
      - Strong directional momentum (2+ consecutive 1m bars in same direction)
      - Volume spike (>150% of 5-bar average)
      - Tight bid-ask spread (<$0.30)
    """
    signals: List[StrategySignal] = []

    s7 = settings.get("strategy7", {})
    if not s7.get("enabled", True):
        return signals

    # Check if symbol is in allowed tickers list
    allowed_tickers = s7.get("allowedTickers", ["SPX"])
    if symbol.upper() not in [t.upper() for t in allowed_tickers]:
        return signals

    if not bars1m or len(bars1m) < 10:
        return signals

    # Parameters
    min_consecutive = s7.get("minConsecutiveBars", 2)
    volume_spike_pct = s7.get("volumeSpikePct", 1.5)

    # Need at least bars for volume calculation + consecutive bars
    required_bars = 7  # 5 for volume avg + 2 for momentum check
    if len(bars1m) < required_bars:
        return signals

    # Iterate through all bars to find signals throughout the day
    cooldown_minutes = s7.get("cooldownMinutes", 3)
    last_signal_time = 0

    for i in range(required_bars, len(bars1m)):
        current_bar = bars1m[i]
        current_time = current_bar["time"]

        # Check if within trading window (9:30 AM - 3:45 PM ET by default)
        if not within_0dte_window(current_time):
            continue

        # Check if within visible range
        if not within_visible_range(current_time, visible_range):
            continue

        # Cooldown check
        if last_signal_time and (current_time - last_signal_time) < (cooldown_minutes * 60):
            continue

        # Get recent bars for analysis
        recent_bars = bars1m[i - required_bars:i]

        # Calculate 5-bar average volume
        volume_window = recent_bars[:5]
        avg_volume = sum(b["volume"] for b in volume_window) / len(volume_window)

        # Check last bars for consecutive momentum
        last_bars = recent_bars[-min_consecutive:]

        # Check for bullish momentum (calls)
        bullish = all(b["close"] > b["open"] for b in last_bars)
        if bullish:
            # Volume spike on most recent bar
            last_volume = last_bars[-1]["volume"]
            if last_volume > avg_volume * volume_spike_pct:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy7_0dte_scalper_{symbol}_call_{current_time}",
                        strategy_id="strategy7_0dte_scalper",
                        direction="CALL",
                        entry_time=current_time,
                    )
                )
                last_signal_time = current_time
                continue

        # Check for bearish momentum (puts)
        bearish = all(b["close"] < b["open"] for b in last_bars)
        if bearish:
            last_volume = last_bars[-1]["volume"]
            if last_volume > avg_volume * volume_spike_pct:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy7_0dte_scalper_{symbol}_put_{current_time}",
                        strategy_id="strategy7_0dte_scalper",
                        direction="PUT",
                        entry_time=current_time,
                    )
                )
                last_signal_time = current_time

    return signals


def detect_strategy8(
    symbol: str,
    visible_range: Dict[str, int],
    bars1m: List[Bar],
    bars5m: List[Bar],
    current_price: float,
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """Strategy 8: 0DTE Momentum Rider

    - Timeframe: 1-minute and 5-minute bars
    - Target gain: 30-100% (default 50%)
    - Hold duration: 10-60 minutes
    - Expected frequency: 5-10 trades/day
    - Signal criteria:
      - 1m trend confirmed by 5m bar alignment
      - RSI(14) entering overbought (>65) or oversold (<35) zone
      - Strong volume (1m volume > 2x recent 1m average)
    """
    signals: List[StrategySignal] = []

    s8 = settings.get("strategy8", {})
    if not s8.get("enabled", True):
        return signals

    # Check if symbol is in allowed tickers list
    allowed_tickers = s8.get("allowedTickers", ["SPX"])
    if symbol.upper() not in [t.upper() for t in allowed_tickers]:
        return signals

    if not bars1m or not bars5m or len(bars1m) < 20 or len(bars5m) < 5:
        return signals

    # Parameters
    rsi_period = s8.get("rsiPeriod", 14)
    rsi_overbought = s8.get("rsiOverbought", 65)
    rsi_oversold = s8.get("rsiOversold", 35)

    # Calculate RSI on 1m bars
    prices_1m = [b["close"] for b in bars1m]
    rsi_values = calculate_rsi(prices_1m, rsi_period)

    if not rsi_values or len(rsi_values) < 2:
        return signals

    # Build a time->5m bar lookup for alignment checks
    bars5m_by_time = {}
    for b5 in bars5m:
        bars5m_by_time[b5["time"]] = b5

    # We need to align RSI indices with bars1m indices
    # rsi_values has (len(bars1m) - rsi_period) entries, starting from index rsi_period
    rsi_offset = len(bars1m) - len(rsi_values)

    cooldown_minutes = s8.get("cooldownMinutes", 10)
    last_signal_time = 0

    for i in range(max(rsi_offset, 5), len(bars1m)):
        bar_1m = bars1m[i]
        current_time = bar_1m["time"]

        if not within_0dte_window(current_time):
            continue

        if not within_visible_range(current_time, visible_range):
            continue

        if last_signal_time and (current_time - last_signal_time) < (cooldown_minutes * 60):
            continue

        rsi_idx = i - rsi_offset
        if rsi_idx < 0 or rsi_idx >= len(rsi_values):
            continue
        current_rsi = rsi_values[rsi_idx]
        if current_rsi is None:
            continue

        # Find the most recent 5m bar at or before this time
        nearest_5m = None
        for b5 in bars5m:
            if b5["time"] <= current_time:
                nearest_5m = b5
            else:
                break

        if not nearest_5m:
            continue

        # Calculate recent 1m average volume (compare apples to apples)
        volume_spike_mult = s8.get("volumeSpikeMult", 2.0)
        vol_1m_start = max(0, i - 5)
        avg_volume_1m = sum(b["volume"] for b in bars1m[vol_1m_start:i]) / max(1, i - vol_1m_start)

        # Bullish signal: RSI > overbought + 5m and 1m both bullish + high volume
        if current_rsi > rsi_overbought:
            five_m_bullish = nearest_5m["close"] > nearest_5m["open"]
            one_m_bullish = bar_1m["close"] > bar_1m["open"]
            high_volume = bar_1m["volume"] > avg_volume_1m * volume_spike_mult

            if five_m_bullish and one_m_bullish and high_volume:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy8_0dte_momentum_{symbol}_call_{current_time}",
                        strategy_id="strategy8_0dte_momentum",
                        direction="CALL",
                        entry_time=current_time,
                    )
                )
                last_signal_time = current_time
                continue

        # Bearish signal: RSI < oversold + 5m and 1m both bearish + high volume
        if current_rsi < rsi_oversold:
            five_m_bearish = nearest_5m["close"] < nearest_5m["open"]
            one_m_bearish = bar_1m["close"] < bar_1m["open"]
            high_volume = bar_1m["volume"] > avg_volume_1m * volume_spike_mult

            if five_m_bearish and one_m_bearish and high_volume:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy8_0dte_momentum_{symbol}_put_{current_time}",
                        strategy_id="strategy8_0dte_momentum",
                        direction="PUT",
                        entry_time=current_time,
                    )
                )
                last_signal_time = current_time

    return signals


def detect_strategy9(
    symbol: str,
    visible_range: Dict[str, int],
    bars1m: List[Bar],
    bars15m: List[Bar],
    bars1d: List[Bar],
    current_price: float,
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """Strategy 9: 0DTE Gap Fade Enhanced

    - Timeframe: 1-minute and 15-minute bars
    - Target gain: 15-30% (default 20%)
    - Hold duration: All-day (reversal trading)
    - Expected frequency: 3-8 trades/day
    - Signal criteria:
      - Opening gap >0.5% from previous close
      - Price moves toward gap fill on 1m bars
      - 15m bar shows reversal confirmation
      - Entry only 10:00-14:00 ET
    """
    signals: List[StrategySignal] = []

    s9 = settings.get("strategy9", {})
    if not s9.get("enabled", True):
        return signals

    # Check if symbol is in allowed tickers list
    allowed_tickers = s9.get("allowedTickers", ["SPX"])
    if symbol.upper() not in [t.upper() for t in allowed_tickers]:
        return signals

    if not bars1m or not bars15m or not bars1d:
        return signals

    if len(bars1d) < 2 or len(bars15m) < 2 or len(bars1m) < 5:
        return signals

    # Parameters
    min_gap_pct = s9.get("minGapPct", 0.005)
    entry_start = s9.get("entryStartTime", "10:00")
    entry_end = s9.get("entryEndTime", "14:00")
    cooldown_minutes = s9.get("cooldownMinutes", 30)

    # Get previous day's close
    prev_close = bars1d[-2]["close"]
    today_open = bars1d[-1]["open"]

    # Calculate gap
    gap_pct = (today_open - prev_close) / prev_close

    # Need a meaningful gap
    if abs(gap_pct) < min_gap_pct:
        return signals

    # Build a time->15m bar lookup
    last_signal_time = 0

    for i in range(1, len(bars1m)):
        bar_1m = bars1m[i]
        current_time = bar_1m["time"]

        if not within_0dte_window(current_time, entry_start, entry_end):
            continue

        if not within_visible_range(current_time, visible_range):
            continue

        if last_signal_time and (current_time - last_signal_time) < (cooldown_minutes * 60):
            continue

        # Find the most recent 15m bar at or before this time
        nearest_15m = None
        for b15 in bars15m:
            if b15["time"] <= current_time:
                nearest_15m = b15
            else:
                break

        if not nearest_15m:
            continue

        # Gap up scenario: look for fade (puts)
        if gap_pct > min_gap_pct:
            moving_toward_fill = bar_1m["close"] < today_open
            reversal_15m = nearest_15m["close"] < nearest_15m["open"]

            if moving_toward_fill and reversal_15m:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy9_0dte_gap_fade_{symbol}_put_{current_time}",
                        strategy_id="strategy9_0dte_gap_fade",
                        direction="PUT",
                        entry_time=current_time,
                        anchor_time=bars1d[-1]["time"],
                    )
                )
                last_signal_time = current_time

        # Gap down scenario: look for fade (calls)
        elif gap_pct < -min_gap_pct:
            moving_toward_fill = bar_1m["close"] > today_open
            reversal_15m = nearest_15m["close"] > nearest_15m["open"]

            if moving_toward_fill and reversal_15m:
                signals.append(
                    StrategySignal(
                        symbol=symbol,
                        id=f"strategy9_0dte_gap_fade_{symbol}_call_{current_time}",
                        strategy_id="strategy9_0dte_gap_fade",
                        direction="CALL",
                        entry_time=current_time,
                        anchor_time=bars1d[-1]["time"],
                    )
                )
                last_signal_time = current_time

    return signals


def detect_strategy10(
    symbol: str,
    visible_range: Dict[str, int],
    bars1m: List[Bar],
    current_price: float,
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """Strategy 10: 0DTE Trend Following

    - Timeframe: 1-minute and 2-minute bars
    - Target gain: 50-150% (default 75%)
    - Hold duration: 1-3 hours
    - Expected frequency: 1-5 trades/day
    - Signal criteria:
      - Strong 1m trend (3+ bars same direction)
      - 1m candles breaking out from SMA20 and SMA200
      - 2m trend alignment
      - RSI(14) in trend zone (calls: 50-70, puts: 30-50)
      - Entry only 9:45-13:00 ET
    """
    signals: List[StrategySignal] = []

    s10 = settings.get("strategy10", {})
    if not s10.get("enabled", True):
        return signals

    # Check if symbol is in allowed tickers list
    allowed_tickers = s10.get("allowedTickers", ["SPX"])
    if symbol.upper() not in [t.upper() for t in allowed_tickers]:
        return signals

    if not bars1m:
        return signals

    # Parameters
    min_trend_bars = s10.get("minTrendBars", 3)
    rsi_period = s10.get("rsiPeriod", 14)
    rsi_call_min = s10.get("rsiTrendCallMin", 50)
    rsi_call_max = s10.get("rsiTrendCallMax", 70)
    rsi_put_min = s10.get("rsiTrendPutMin", 30)
    rsi_put_max = s10.get("rsiTrendPutMax", 50)
    require_sma_breakout = s10.get("requireSmaBreakout", True)
    sma_fast_period = max(2, int(s10.get("smaFastPeriod", 20)))
    sma_slow_period = max(sma_fast_period + 1, int(s10.get("smaSlowPeriod", 200)))
    require_vwap_trend = s10.get("requireVwapTrend", True)
    vwap_slope_lookback = max(1, int(s10.get("vwapSlopeLookback", 5)))
    failed_breakout_block_minutes = max(0, int(s10.get("failedBreakoutBlockMinutes", 30)))
    entry_start = s10.get("entryStartTime", "09:45")
    entry_end = s10.get("entryEndTime", "13:00")

    bars2m = aggregate_intraday_bars(bars1m, 2)

    # Need enough bars for trend detection
    min_required_1m = min_trend_bars + rsi_period
    if len(bars1m) < min_required_1m or len(bars2m) < 2:
        return signals
    if require_sma_breakout and len(bars1m) < max(sma_fast_period, sma_slow_period):
        return signals

    # Calculate RSI on 1m bars
    prices_1m = [b["close"] for b in bars1m]
    rsi_values = calculate_rsi(prices_1m, rsi_period)
    sma_fast = calculate_ma(bars1m, sma_fast_period) if require_sma_breakout else []
    sma_slow = calculate_ma(bars1m, sma_slow_period) if require_sma_breakout else []
    vwap_values = calculate_session_vwap(bars1m) if require_vwap_trend else []

    if not rsi_values or len(rsi_values) < 2:
        return signals

    rsi_offset = len(bars1m) - len(rsi_values)
    cooldown_minutes = s10.get("cooldownMinutes", 60)
    last_signal_time = 0
    bars1m_times = [bar["time"] for bar in bars1m] if require_sma_breakout else []

    for i in range(max(rsi_offset + 1, min_trend_bars), len(bars1m)):
        bar_1m = bars1m[i]
        current_time = bar_1m["time"]

        if not within_0dte_window(current_time, entry_start, entry_end):
            continue

        if not within_visible_range(current_time, visible_range):
            continue

        if last_signal_time and (current_time - last_signal_time) < (cooldown_minutes * 60):
            continue

        rsi_idx = i - rsi_offset
        if rsi_idx < 0 or rsi_idx >= len(rsi_values):
            continue
        current_rsi = rsi_values[rsi_idx]
        if current_rsi is None:
            continue

        # Get recent 1m bars for trend detection
        recent_1m = bars1m[i - min_trend_bars + 1:i + 1]

        sma_breakout_call = True
        sma_breakout_put = True
        vwap_trend_call = True
        vwap_trend_put = True
        failed_breakout_call = False
        failed_breakout_put = False
        sma_idx = -1
        if require_sma_breakout:
            sma_idx = bisect.bisect_right(bars1m_times, current_time) - 1
            first_sma_idx = sma_idx - min_trend_bars + 1
            if sma_idx < 0 or first_sma_idx < 0:
                continue

            fast_now = sma_fast[sma_idx]
            slow_now = sma_slow[sma_idx]
            fast_start = sma_fast[first_sma_idx]
            slow_start = sma_slow[first_sma_idx]
            if fast_now is None or slow_now is None or fast_start is None or slow_start is None:
                continue

            first_close = bars1m[first_sma_idx]["close"]
            last_close = bars1m[sma_idx]["close"]
            highest_sma_now = max(fast_now, slow_now)
            lowest_sma_now = min(fast_now, slow_now)
            highest_sma_start = max(fast_start, slow_start)
            lowest_sma_start = min(fast_start, slow_start)

            # "Coming out of" the moving averages: price starts inside/below
            # the SMA zone and closes above both for calls, or starts inside/above
            # the SMA zone and closes below both for puts.
            sma_breakout_call = first_close <= highest_sma_start and last_close > highest_sma_now
            sma_breakout_put = first_close >= lowest_sma_start and last_close < lowest_sma_now

            if failed_breakout_block_minutes > 0:
                block_start_time = current_time - failed_breakout_block_minutes * 60
                block_start_idx = bisect.bisect_left(bars1m_times, block_start_time)
                call_broke = False
                put_broke = False
                for j in range(max(block_start_idx, sma_slow_period - 1), sma_idx):
                    if sma_fast[j] is None or sma_slow[j] is None:
                        continue
                    upper_sma = max(sma_fast[j], sma_slow[j])
                    lower_sma = min(sma_fast[j], sma_slow[j])
                    close_j = bars1m[j]["close"]
                    if close_j > upper_sma:
                        call_broke = True
                    elif call_broke and close_j <= upper_sma:
                        failed_breakout_call = True
                    if close_j < lower_sma:
                        put_broke = True
                    elif put_broke and close_j >= lower_sma:
                        failed_breakout_put = True

        if require_vwap_trend:
            vwap_idx = i
            vwap_start_idx = vwap_idx - vwap_slope_lookback
            if vwap_start_idx < 0 or vwap_values[vwap_idx] is None or vwap_values[vwap_start_idx] is None:
                continue
            vwap_now = vwap_values[vwap_idx]
            vwap_start = vwap_values[vwap_start_idx]
            close_now = bar_1m["close"]
            vwap_trend_call = close_now > vwap_now and vwap_now > vwap_start
            vwap_trend_put = close_now < vwap_now and vwap_now < vwap_start

        # Find the most recent 2m bar at or before this time
        nearest_2m = None
        for b2 in bars2m:
            if b2["time"] <= current_time:
                nearest_2m = b2
            else:
                break

        if not nearest_2m:
            continue

        # Bullish trend detection
        bullish_1m_trend = all(b["close"] > b["open"] for b in recent_1m)
        bullish_2m = nearest_2m["close"] > nearest_2m["open"]
        rsi_in_call_zone = rsi_call_min <= current_rsi <= rsi_call_max

        if (
            bullish_1m_trend
            and bullish_2m
            and rsi_in_call_zone
            and sma_breakout_call
            and vwap_trend_call
            and not failed_breakout_call
        ):
            signals.append(
                StrategySignal(
                    symbol=symbol,
                    id=f"strategy10_0dte_trend_{symbol}_call_{current_time}",
                    strategy_id="strategy10_0dte_trend",
                    direction="CALL",
                    entry_time=current_time,
                    anchor_time=nearest_2m["time"],
                    metadata={
                        "smaFastPeriod": sma_fast_period,
                        "smaSlowPeriod": sma_slow_period,
                        "smaTimeframe": "1m",
                        "trendTimeframe": "1m",
                        "alignmentTimeframe": "2m",
                        "signalHigh": bar_1m["high"],
                        "signalLow": bar_1m["low"],
                        "signalClose": bar_1m["close"],
                        "vwap": round(vwap_values[i], 4) if require_vwap_trend and vwap_values[i] is not None else None,
                        "smaFast": round(sma_fast[sma_idx], 4) if require_sma_breakout and sma_idx >= 0 and sma_fast[sma_idx] is not None else None,
                        "smaSlow": round(sma_slow[sma_idx], 4) if require_sma_breakout and sma_idx >= 0 and sma_slow[sma_idx] is not None else None,
                    },
                )
            )
            last_signal_time = current_time
            continue

        # Bearish trend detection
        bearish_1m_trend = all(b["close"] < b["open"] for b in recent_1m)
        bearish_2m = nearest_2m["close"] < nearest_2m["open"]
        rsi_in_put_zone = rsi_put_min <= current_rsi <= rsi_put_max

        if (
            bearish_1m_trend
            and bearish_2m
            and rsi_in_put_zone
            and sma_breakout_put
            and vwap_trend_put
            and not failed_breakout_put
        ):
            signals.append(
                StrategySignal(
                    symbol=symbol,
                    id=f"strategy10_0dte_trend_{symbol}_put_{current_time}",
                    strategy_id="strategy10_0dte_trend",
                    direction="PUT",
                    entry_time=current_time,
                    anchor_time=nearest_2m["time"],
                    metadata={
                        "smaFastPeriod": sma_fast_period,
                        "smaSlowPeriod": sma_slow_period,
                        "smaTimeframe": "1m",
                        "trendTimeframe": "1m",
                        "alignmentTimeframe": "2m",
                        "signalHigh": bar_1m["high"],
                        "signalLow": bar_1m["low"],
                        "signalClose": bar_1m["close"],
                        "vwap": round(vwap_values[i], 4) if require_vwap_trend and vwap_values[i] is not None else None,
                        "smaFast": round(sma_fast[sma_idx], 4) if require_sma_breakout and sma_idx >= 0 and sma_fast[sma_idx] is not None else None,
                        "smaSlow": round(sma_slow[sma_idx], 4) if require_sma_breakout and sma_idx >= 0 and sma_slow[sma_idx] is not None else None,
                    },
                )
            )
            last_signal_time = current_time

    return signals


def detect_ct15(
    symbol: str,
    visible_range: Dict[str, int],
    bars1d: List[Bar],
    bars15m: List[Bar],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    signals: List[StrategySignal] = []
    ct15 = settings["ct15"]
    if not ct15.get("enabled", True):
        return signals
    if not bars15m:
        return signals
    bands15m = calculate_bollinger(bars15m, 20, 2)
    bandwidth15m: List[Optional[float]] = []
    for idx, mid in enumerate(bands15m["mid"]):
        if mid is None or bands15m["upper"][idx] is None or bands15m["lower"][idx] is None:
            bandwidth15m.append(None)
        else:
            bandwidth15m.append((bands15m["upper"][idx] - bands15m["lower"][idx]) / mid)

    bars15m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars15m:
        bars15m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars15m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars1d_by_day = {get_ny_day_key(bar["time"]): bar for bar in bars1d}

    for day_key, day_bars in bars15m_by_day.items():
        open_bar = next(
            (bar for bar in day_bars if get_ny_parts(bar["time"])["hour"] == 9 and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open_bar:
            continue
        if not within_visible_range(open_bar["time"], visible_range):
            continue

        # CT15 requires the 9:30 bar to be closed (next bar must exist)
        next_bar = next((bar for bar in day_bars if bar["time"] > open_bar["time"]), None)
        if not next_bar:
            continue

        prior_day_key = get_ny_day_key(open_bar["time"] - 86400)
        prior_bars = bars15m_by_day.get(prior_day_key, [])
        if not prior_bars:
            continue
        prior_close = prior_bars[-1]["close"]
        gap_pct = (open_bar["open"] - prior_close) / prior_close
        if abs(gap_pct) < ct15["minGapPct"]:
            continue

        open_idx = next((i for i, bar in enumerate(bars15m) if bar["time"] == open_bar["time"]), -1)
        if open_idx < 0:
            continue
        bb_mid_open = bands15m["mid"][open_idx]
        bb_upper_open = bands15m["upper"][open_idx]
        bb_lower_open = bands15m["lower"][open_idx]
        if bb_mid_open is None:
            continue

        bw = bandwidth15m[open_idx]
        if bw is None:
            continue
        lookback = ct15["bwSlopeLookback"]
        prev_idx = open_idx - lookback
        if prev_idx < 0 or bandwidth15m[prev_idx] is None:
            continue
        bw_slope = (bw - bandwidth15m[prev_idx]) / lookback
        window_start = max(0, open_idx - 20 + 1)
        bw_window = [v for v in bandwidth15m[window_start : open_idx + 1] if v is not None]
        if not bw_window:
            continue
        bw_avg = sum(bw_window) / len(bw_window)
        bw_avg_ratio = ct15.get("bwAvgRatio", 1.0)
        vol_open = bw > bw_avg * bw_avg_ratio and bw_slope > 0
        if not vol_open:
            continue

        prior_regression = linear_regression([bar["close"] for bar in prior_bars])
        trendline_level = prior_regression["intercept"] + prior_regression["slope"] * len(prior_bars)
        slope = prior_regression["slope"]

        last_prior = prior_bars[-1]
        last_mid_idx = next((i for i, bar in enumerate(bars15m) if bar["time"] == last_prior["time"]), -1)
        if last_mid_idx < 0:
            continue
        last_mid = bands15m["mid"][last_mid_idx]
        if last_mid is None:
            continue

        exposed = False
        if bb_upper_open is not None and open_bar["open"] > bb_upper_open:
            exposed = True
        if bb_lower_open is not None and open_bar["open"] < bb_lower_open:
            exposed = True
        if exposed and ct15["strictExposedMode"]:
            continue

        # Bullish (CALL)
        if slope <= 0 and last_prior["close"] < last_mid:
            if open_bar["open"] > prior_close and open_bar["open"] > bb_mid_open and open_bar["open"] > trendline_level:
                signals.append(
                    StrategySignal(
                        id=f"{symbol}-ct15-call-{next_bar['time']}",
                        symbol=symbol,
                        strategy_id="ct15_open_gap_trendline_midline_volatility_15m",
                        direction="CALL",
                        entry_time=next_bar["time"],
                        anchor_time=open_bar["time"],
                    )
                )

        # Bearish (PUT)
        if slope >= 0 and last_prior["close"] > last_mid:
            if open_bar["open"] < prior_close and open_bar["open"] < bb_mid_open and open_bar["open"] < trendline_level:
                signals.append(
                    StrategySignal(
                        id=f"{symbol}-ct15-put-{next_bar['time']}",
                        symbol=symbol,
                        strategy_id="ct15_open_gap_trendline_midline_volatility_15m",
                        direction="PUT",
                        entry_time=next_bar["time"],
                        anchor_time=open_bar["time"],
                    )
                )

    return signals


def detect_ct_open(
    symbol: str,
    visible_range: Dict[str, int],
    bars15m: List[Bar],
    bars1m: List[Bar],
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """CT-Open: Bollinger Squeeze Breakout at market open.

    Phase 1 — Squeeze detection (at 9:30, using 15m bars):
      - Bandwidth at the 9:30 bar is below squeezePercentile of the last
        squeezeLookback bars (tight bands = compressed volatility).
      - Price opens INSIDE the Bollinger bands (between lower and upper).

    Phase 2 — Breakout confirmation (using 1m bars, 9:30–9:30+entryWindowMinutes):
      - 1m Bollinger bandwidth must be expanding (current 1m BW > 1m BW at 9:30).
      - Price closes above opening price for minBreakoutBars consecutive bars → CALL.
      - Price closes below opening price for minBreakoutBars consecutive bars → PUT.
      - First confirmed directional run with expanding BW wins.
    """
    signals: List[StrategySignal] = []
    ct = settings["ct_open"]
    if not ct.get("enabled", True):
        return signals
    if not bars15m or not bars1m:
        return signals

    require_squeeze = ct.get("requireSqueeze", True)
    squeeze_lookback = ct.get("squeezeLookback", 100)
    squeeze_percentile = ct.get("squeezePercentile", 30)
    entry_window_minutes = ct.get("entryWindowMinutes", 15)
    min_breakout_bars = ct.get("minBreakoutBars", 3)
    min_displacement_pct = ct.get("minDisplacementPct", 0.10)
    max_signals = ct.get("maxSignalsPerDay", 1)

    # 15m Bollinger for squeeze detection
    bands15m = calculate_bollinger(bars15m, 20, 2)
    bandwidth15m: List[Optional[float]] = []
    for idx, mid in enumerate(bands15m["mid"]):
        if mid is None or bands15m["upper"][idx] is None or bands15m["lower"][idx] is None:
            bandwidth15m.append(None)
        else:
            bandwidth15m.append((bands15m["upper"][idx] - bands15m["lower"][idx]) / mid)

    # 1m Bollinger for expansion confirmation
    bands1m = calculate_bollinger(bars1m, 20, 2)
    bandwidth1m: List[Optional[float]] = []
    for idx, mid in enumerate(bands1m["mid"]):
        if mid is None or bands1m["upper"][idx] is None or bands1m["lower"][idx] is None:
            bandwidth1m.append(None)
        else:
            bandwidth1m.append((bands1m["upper"][idx] - bands1m["lower"][idx]) / mid)

    # Build time -> index map for fast 1m bar lookup
    bars1m_time_to_idx = {bar["time"]: i for i, bar in enumerate(bars1m)}

    # Group bars by day
    bars15m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars15m:
        bars15m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars15m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    bars1m_by_day: Dict[str, List[Bar]] = {}
    for bar in bars1m:
        bars1m_by_day.setdefault(get_ny_day_key(bar["time"]), []).append(bar)
    for lst in bars1m_by_day.values():
        lst.sort(key=lambda b: b["time"])

    for day_key, day_bars_15m in bars15m_by_day.items():
        if len([s for s in signals if get_ny_day_key(s.entry_time) == day_key]) >= max_signals:
            continue

        # Find the 9:30 opening 15m bar
        open_bar = next(
            (bar for bar in day_bars_15m
             if get_ny_parts(bar["time"])["hour"] == 9
             and get_ny_parts(bar["time"])["minute"] == 30),
            None,
        )
        if not open_bar:
            continue
        if not within_visible_range(open_bar["time"], visible_range):
            continue

        open_idx = next((i for i, bar in enumerate(bars15m) if bar["time"] == open_bar["time"]), -1)
        if open_idx < 0:
            continue

        bb_upper = bands15m["upper"][open_idx]
        bb_lower = bands15m["lower"][open_idx]
        bb_mid = bands15m["mid"][open_idx]
        bw = bandwidth15m[open_idx]
        if bb_upper is None or bb_lower is None or bb_mid is None or bw is None:
            continue

        if require_squeeze:
            # Phase 1a: Squeeze check — BW must be below squeezePercentile
            window_start = max(0, open_idx - squeeze_lookback + 1)
            bw_history = [v for v in bandwidth15m[window_start:open_idx + 1] if v is not None]
            if len(bw_history) < min(20, squeeze_lookback):
                continue
            sorted_bw = sorted(bw_history)
            rank = next((i for i, v in enumerate(sorted_bw) if v >= bw), len(sorted_bw) - 1)
            percentile = (rank + 1) / len(sorted_bw) * 100
            if percentile > squeeze_percentile:
                continue

            # Phase 1b: Price must open INSIDE the bands
            if open_bar["open"] > bb_upper or open_bar["open"] < bb_lower:
                continue

        # Phase 2: Scan 1m bars for breakout with BW expansion
        day_bars_1m = bars1m_by_day.get(day_key, [])
        if not day_bars_1m:
            continue

        entry_window_end_minute = 30 + entry_window_minutes
        entry_window = [
            bar for bar in day_bars_1m
            if (p := get_ny_parts(bar["time"]))
            and p["hour"] * 60 + p["minute"] >= 9 * 60 + 30
            and p["hour"] * 60 + p["minute"] < 9 * 60 + entry_window_end_minute
        ]
        if not entry_window:
            continue

        # Get 1m BW at 9:30 as the baseline for expansion comparison
        bw_1m_baseline: Optional[float] = None
        if require_squeeze:
            open_1m_idx = bars1m_time_to_idx.get(entry_window[0]["time"])
            if open_1m_idx is None:
                continue
            bw_1m_baseline = bandwidth1m[open_1m_idx]
            if bw_1m_baseline is None:
                continue

        # Use the opening price as the reference for direction — avoids
        # stale MA20 values from the prior session contaminating the signal.
        open_price = open_bar["open"]

        entry_bar: Optional[Bar] = None
        direction: Optional[str] = None
        consec_above = 0
        consec_below = 0
        for bar_1m in entry_window:
            idx_1m = bars1m_time_to_idx.get(bar_1m["time"])
            if idx_1m is None:
                continue
            bw_1m_current = bandwidth1m[idx_1m]
            # Require 1m BW expansion: current > baseline at 9:30
            if require_squeeze and bw_1m_current is not None and bw_1m_baseline is not None:
                if bw_1m_current <= bw_1m_baseline:
                    consec_above = 0
                    consec_below = 0
                    continue
            # Track consecutive closes above/below the opening price
            if bar_1m["close"] > open_price:
                consec_above += 1
                consec_below = 0
            elif bar_1m["close"] < open_price:
                consec_below += 1
                consec_above = 0
            else:
                consec_above = 0
                consec_below = 0
            # Check displacement gate: price must have moved enough from open
            displacement_pct = abs(bar_1m["close"] - open_price) / open_price * 100
            if consec_above >= min_breakout_bars and displacement_pct >= min_displacement_pct:
                entry_bar = bar_1m
                direction = "CALL"
                break
            if consec_below >= min_breakout_bars and displacement_pct >= min_displacement_pct:
                entry_bar = bar_1m
                direction = "PUT"
                break

        if not entry_bar or not direction:
            continue
        if not within_visible_range(entry_bar["time"], visible_range):
            continue

        signals.append(
            StrategySignal(
                id=f"{symbol}-ct-open-{direction.lower()}-{entry_bar['time']}",
                symbol=symbol,
                strategy_id="ct_open_squeeze_breakout_15m_1m",
                direction=direction,
                entry_time=entry_bar["time"],
                anchor_time=open_bar["time"],
            )
        )

    return signals


# ---------------------------------------------------------------------------
# Strategy 11 — ICT Price Action: Liquidity Sweep + MSS + FVG
# ---------------------------------------------------------------------------


def _find_swing_points(
    bars: List[Bar], lookback: int = 5
) -> Dict[str, List[Dict[str, Any]]]:
    """Identify swing highs and swing lows from a bar series.

    A swing high is a bar whose high is greater than the highs of the
    ``lookback`` bars on either side.  Swing lows are the mirror image.
    """
    highs: List[Dict[str, Any]] = []
    lows: List[Dict[str, Any]] = []
    for i in range(lookback, len(bars) - lookback):
        bar = bars[i]
        is_high = all(bar["high"] >= bars[i + d]["high"] for d in range(-lookback, lookback + 1) if d != 0)
        is_low = all(bar["low"] <= bars[i + d]["low"] for d in range(-lookback, lookback + 1) if d != 0)
        if is_high:
            highs.append({"index": i, "price": bar["high"], "time": bar["time"]})
        if is_low:
            lows.append({"index": i, "price": bar["low"], "time": bar["time"]})
    return {"highs": highs, "lows": lows}


def _find_fvg(bars: List[Bar], start_idx: int, direction: str) -> Optional[Dict[str, Any]]:
    """Find the first Fair Value Gap after *start_idx* in the given direction.

    Uses candle bodies (open/close) rather than wicks (high/low) to detect
    the gap — this is more practical on lower timeframes (5m) where true
    wick gaps are extremely rare due to market liquidity.

    An FVG is a three-candle pattern where candle-1's body top and candle-3's
    body bottom do not overlap, creating a gap (inefficiency).

    Returns dict with ``top``, ``bottom``, ``mid``, ``bar_index``, ``time``
    or ``None`` if none found.
    """
    for i in range(max(0, start_idx), len(bars) - 2):
        c1 = bars[i]
        c2 = bars[i + 1]
        c3 = bars[i + 2]
        c1_body_top = max(c1["open"], c1["close"])
        c1_body_bot = min(c1["open"], c1["close"])
        c3_body_top = max(c3["open"], c3["close"])
        c3_body_bot = min(c3["open"], c3["close"])
        if direction == "CALL":
            # Bullish FVG: candle-3 body bottom above candle-1 body top
            # Also accept if candle-2 is strongly bullish and creates a gap
            # between c1 high and c3 low (wick-based, classic definition)
            gap_body = c3_body_bot - c1_body_top
            gap_wick = c3["low"] - c1["high"]
            if gap_body > 0 or gap_wick > 0:
                # Use the tighter (body) gap if available, else wick gap
                if gap_body > 0:
                    top = c3_body_bot
                    bottom = c1_body_top
                else:
                    top = c3["low"]
                    bottom = c1["high"]
                return {
                    "top": top,
                    "bottom": bottom,
                    "mid": (top + bottom) / 2,
                    "bar_index": i + 1,
                    "time": c2["time"],
                }
        else:
            # Bearish FVG: candle-1 body bottom above candle-3 body top
            gap_body = c1_body_bot - c3_body_top
            gap_wick = c1["low"] - c3["high"]
            if gap_body > 0 or gap_wick > 0:
                if gap_body > 0:
                    top = c1_body_bot
                    bottom = c3_body_top
                else:
                    top = c1["low"]
                    bottom = c3["high"]
                return {
                    "top": top,
                    "bottom": bottom,
                    "mid": (top + bottom) / 2,
                    "bar_index": i + 1,
                    "time": c2["time"],
                }
    return None


def _cluster_levels(prices: List[float], cluster_pct: float = 0.0015) -> List[float]:
    """Merge nearby price levels into clusters, keeping the average of each group.

    Two levels within cluster_pct of each other are merged.  Returns a
    de-duplicated, much shorter list.
    """
    if not prices:
        return []
    sorted_prices = sorted(prices)
    clusters: List[List[float]] = [[sorted_prices[0]]]
    for p in sorted_prices[1:]:
        # Compare to the cluster's first member (representative)
        if abs(p - clusters[-1][0]) / clusters[-1][0] <= cluster_pct:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    # Return average of each cluster, rounded to 2 decimals
    return [round(sum(c) / len(c), 2) for c in clusters]


def compute_sr_levels(
    bars5m: List[Bar],
    bars1d: List[Bar],
    swing_lookback: int = 3,
    max_levels: int = 8,
) -> Dict[str, List[float]]:
    """Compute key support and resistance levels from daily bars and 5m swings.

    Clusters nearby levels, scores by significance (daily > weekly > intraday),
    and returns at most *max_levels* per side.
    """
    if not bars1d or len(bars1d) < 2:
        return {"support": [], "resistance": []}

    # Collect candidate levels with a weight (higher = more significant)
    # (price, weight)
    high_candidates: List[tuple] = []
    low_candidates: List[tuple] = []

    # Previous day H/L — strongest
    prev_day_high = bars1d[-2]["high"]
    prev_day_low = bars1d[-2]["low"]
    high_candidates.append((prev_day_high, 3))
    low_candidates.append((prev_day_low, 3))

    # Previous 2-day H/L
    if len(bars1d) >= 3:
        high_candidates.append((bars1d[-3]["high"], 2))
        low_candidates.append((bars1d[-3]["low"], 2))

    # Previous week H/L
    if len(bars1d) >= 6:
        week_high = max(b["high"] for b in bars1d[-6:-1])
        week_low = min(b["low"] for b in bars1d[-6:-1])
        high_candidates.append((week_high, 2))
        low_candidates.append((week_low, 2))

    # Intraday swing points — lower weight
    if bars5m and len(bars5m) >= 10:
        swings = _find_swing_points(bars5m, swing_lookback)
        for sh in swings["highs"]:
            high_candidates.append((sh["price"], 1))
        for sl in swings["lows"]:
            low_candidates.append((sl["price"], 1))

    def _pick_top(candidates: List[tuple], descending: bool) -> List[float]:
        """Cluster, score, and return top levels."""
        if not candidates:
            return []
        # Group into clusters
        prices = sorted(set(p for p, _ in candidates))
        clustered = _cluster_levels(prices, cluster_pct=0.0015)
        # Score each cluster: sum weights of all candidates that fall into it
        scored: List[tuple] = []
        for cp in clustered:
            score = sum(w for p, w in candidates
                        if abs(p - cp) / cp <= 0.0015)
            scored.append((cp, score))
        # Sort by score descending, then take top N
        scored.sort(key=lambda x: x[1], reverse=True)
        result = [p for p, _ in scored[:max_levels]]
        result.sort(reverse=descending)
        return result

    return {
        "support": _pick_top(low_candidates, descending=False),
        "resistance": _pick_top(high_candidates, descending=True),
    }


def detect_strategy11(
    symbol: str,
    visible_range: Dict[str, int],
    bars5m: List[Bar],
    bars1d: List[Bar],
    current_price: float,
    settings: Dict[str, Any],
) -> List[StrategySignal]:
    """Strategy 11 — ICT Price Action: Liquidity Sweep -> MSS -> FVG Entry

    Three-step algorithm based on Smart Money Concepts:

    Step A — Liquidity Sweep: Price wicks above a previous swing high / daily
    high (bearish setup) or below a previous swing low / daily low (bullish
    setup), sweeping retail stop-losses.  Uses both daily levels and
    intraday 5m swing points as liquidity pools.

    Step B — Market Structure Shift (MSS): After the sweep, price breaks
    the most recent opposing swing level with a displacement candle whose
    body exceeds the rolling average.

    Step C — Fair Value Gap (FVG) Entry: A body-based FVG (gap between
    candle-1 body top and candle-3 body bottom, or vice-versa) created in
    the sweep→MSS range provides the entry zone.

    Timeframe alignment:
    - Liquidity levels: 1D bars (previous 2 days H/L) + 5M swing points
    - MSS + FVG detection: 5M bars

    Kill-zone: NY Open (8:00-11:00 AM ET) by default.
    """
    signals: List[StrategySignal] = []

    s11 = settings.get("strategy11", {})
    if not s11.get("enabled", True):
        return signals

    allowed_tickers = s11.get("allowedTickers")
    if allowed_tickers and symbol.upper() not in [t.upper() for t in allowed_tickers]:
        return signals

    if not bars5m or len(bars5m) < 30 or not bars1d or len(bars1d) < 3:
        return signals

    # ── Parameters ──────────────────────────────────────────────────────
    # Cast to numeric — settings saved from the UI may arrive as strings.
    swing_lookback = int(s11.get("swingLookback", 3))
    min_displacement_pct = float(s11.get("minDisplacementPct", 0.0005))
    avg_body_lookback = int(s11.get("avgBodyLookback", 20))
    avg_body_mult = float(s11.get("avgBodyMult", 1.0))
    cooldown_minutes = float(s11.get("cooldownMinutes", 30))
    entry_start = s11.get("entryStartTime", "09:30")
    entry_end = s11.get("entryEndTime", "15:45")
    min_rr = float(s11.get("minRiskReward", 1.5))
    sweep_window = int(s11.get("sweepWindowBars", 36))
    use_sr_filter = s11.get("useSRFilter", False)
    sr_proximity_pct = float(s11.get("srProximityPct", 0.002))
    allow_sr_entry = s11.get("allowSREntry", False)
    mss_lookback = int(s11.get("mssLookbackBars", 6))

    # ── Step A: Identify liquidity levels ───────────────────────────────
    # Daily levels
    prev_day_high = bars1d[-2]["high"] if len(bars1d) >= 2 else bars1d[-1]["high"]
    prev_day_low = bars1d[-2]["low"] if len(bars1d) >= 2 else bars1d[-1]["low"]
    prev2_day_high = bars1d[-3]["high"] if len(bars1d) >= 3 else prev_day_high
    prev2_day_low = bars1d[-3]["low"] if len(bars1d) >= 3 else prev_day_low

    # ── Detect swings on 5m bars ────────────────────────────────────────
    swings = _find_swing_points(bars5m, swing_lookback)
    swing_highs = swings["highs"]
    swing_lows = swings["lows"]

    # Build liquidity pools: daily levels + significant intraday swing points
    liquidity_highs_set: set = {prev_day_high, prev2_day_high}
    liquidity_lows_set: set = {prev_day_low, prev2_day_low}
    for sh in swing_highs:
        liquidity_highs_set.add(sh["price"])
    for sl in swing_lows:
        liquidity_lows_set.add(sl["price"])
    liquidity_highs = sorted(liquidity_highs_set, reverse=True)
    liquidity_lows = sorted(liquidity_lows_set)

    # ── S/R levels for optional proximity filter ─────────────────────
    # Support = swing lows + daily lows; Resistance = swing highs + daily highs
    # Also add previous week high/low if we have enough daily bars
    sr_support_levels = sorted(liquidity_lows_set)
    sr_resistance_levels = sorted(liquidity_highs_set, reverse=True)
    if len(bars1d) >= 6:
        week_high = max(b["high"] for b in bars1d[-6:-1])
        week_low = min(b["low"] for b in bars1d[-6:-1])
        sr_resistance_levels.append(week_high)
        sr_support_levels.append(week_low)
        sr_resistance_levels = sorted(set(sr_resistance_levels), reverse=True)
        sr_support_levels = sorted(set(sr_support_levels))

    def _near_sr_level(price: float, direction: str) -> bool:
        """Check if price is near an S/R level appropriate for the direction.
        CALL entries should be near support; PUT entries near resistance."""
        if not use_sr_filter:
            return True  # filter disabled, always pass
        levels = sr_support_levels if direction == "CALL" else sr_resistance_levels
        for level in levels:
            if abs(price - level) / price <= sr_proximity_pct:
                return True
        return False

    # ── Pre-compute average candle body on 5m for displacement check ────
    bodies_5m = [abs(b["close"] - b["open"]) for b in bars5m]
    n_body = min(avg_body_lookback, len(bodies_5m))
    avg_body = sum(bodies_5m[-n_body:]) / n_body if n_body else 0.001

    last_signal_time = 0

    # ── Pre-compute day boundaries so sweeps don't cross sessions ───────
    # Build a map: bar index → date string, so we can find the first bar
    # of each trading day.
    def _bar_date(b: Bar) -> str:
        return datetime.fromtimestamp(b["time"], NY_TZ).strftime("%Y-%m-%d")

    day_start_idx: Dict[str, int] = {}
    for idx, b in enumerate(bars5m):
        d = _bar_date(b)
        if d not in day_start_idx:
            day_start_idx[d] = idx

    # ── Scan 5m bars for the 3-step pattern ─────────────────────────────
    for i in range(swing_lookback + 1, len(bars5m)):
        bar = bars5m[i]
        current_time = bar["time"]

        if not within_0dte_window(current_time, entry_start, entry_end):
            continue
        if not within_visible_range(current_time, visible_range):
            continue
        if last_signal_time and (current_time - last_signal_time) < cooldown_minutes * 60:
            continue

        # Don't look for sweeps before the current session started
        current_day = _bar_date(bar)
        session_start_idx = day_start_idx.get(current_day, 0)
        sweep_earliest = max(session_start_idx, i - sweep_window)

        # ── BEARISH SETUP: sweep above a liquidity high → break swing low
        # Find the most recent sweep in the lookback window (same day only)
        best_sweep_idx = -1
        for j in range(i - 1, sweep_earliest - 1, -1):
            bar_j = bars5m[j]
            for liq_high in liquidity_highs:
                if bar_j["high"] > liq_high:
                    best_sweep_idx = j
                    break
            if best_sweep_idx >= 0:
                break

        if best_sweep_idx >= 0:
            # MSS: any bar from sweep to current closes below a swing low
            # with cumulative bearish movement (displacement) meeting threshold
            candidate_lows = [s for s in swing_lows if s["index"] < i]
            if candidate_lows:
                nearest_swing_low = candidate_lows[-1]
                # Check current bar or recent bars for MSS
                mss_bar_idx = -1
                for mi in range(i, max(i - mss_lookback, best_sweep_idx - 1), -1):
                    mb = bars5m[mi]
                    if mb["close"] < nearest_swing_low["price"]:
                        mb_body = abs(mb["close"] - mb["open"])
                        if mb_body > avg_body * avg_body_mult:
                            mss_bar_idx = mi
                            break
                        # Also accept if the close is well below the swing
                        # even without a single energetic bar (accumulated move)
                        disp = (nearest_swing_low["price"] - mb["close"]) / nearest_swing_low["price"]
                        if disp >= min_displacement_pct * 2:
                            mss_bar_idx = mi
                            break

                if mss_bar_idx >= 0:
                    mss_bar = bars5m[mss_bar_idx]
                    displacement = (nearest_swing_low["price"] - mss_bar["close"]) / nearest_swing_low["price"]
                    if displacement >= min_displacement_pct:
                        fvg_search_start = max(0, best_sweep_idx - 2)
                        fvg = _find_fvg(bars5m, fvg_search_start, "PUT")
                        # Use FVG mid as entry, or current bar close if allowSREntry and near resistance
                        entry_price = None
                        if fvg and fvg["bar_index"] <= i:
                            entry_price = fvg["mid"]
                        elif allow_sr_entry and _near_sr_level(bar["close"], "PUT"):
                            entry_price = bar["close"]

                        if entry_price is not None:
                            sl_price = max(
                                bars5m[k]["high"]
                                for k in range(best_sweep_idx, min(best_sweep_idx + 3, len(bars5m)))
                            )
                            tp_price = min(liquidity_lows) if liquidity_lows else nearest_swing_low["price"] * 0.99
                            risk = abs(sl_price - entry_price) if sl_price != entry_price else 0.001
                            reward = abs(entry_price - tp_price)
                            if risk > 0 and reward / risk >= min_rr and _near_sr_level(entry_price, "PUT"):
                                signals.append(
                                    StrategySignal(
                                        id=f"s11_ict_{symbol}_put_{current_time}",
                                        symbol=symbol,
                                        strategy_id="strategy11_ict_price_action",
                                        direction="PUT",
                                        entry_time=current_time,
                                        anchor_time=bars5m[best_sweep_idx]["time"],
                                    )
                                )
                                last_signal_time = current_time
                                continue

        # ── BULLISH SETUP: sweep below a liquidity low → break swing high
        best_sweep_idx = -1
        for j in range(i - 1, sweep_earliest - 1, -1):
            bar_j = bars5m[j]
            for liq_low in liquidity_lows:
                if bar_j["low"] < liq_low:
                    best_sweep_idx = j
                    break
            if best_sweep_idx >= 0:
                break

        if best_sweep_idx >= 0:
            candidate_highs = [s for s in swing_highs if s["index"] < i]
            if candidate_highs:
                nearest_swing_high = candidate_highs[-1]
                mss_bar_idx = -1
                for mi in range(i, max(i - mss_lookback, best_sweep_idx - 1), -1):
                    mb = bars5m[mi]
                    if mb["close"] > nearest_swing_high["price"]:
                        mb_body = abs(mb["close"] - mb["open"])
                        if mb_body > avg_body * avg_body_mult:
                            mss_bar_idx = mi
                            break
                        disp = (mb["close"] - nearest_swing_high["price"]) / nearest_swing_high["price"]
                        if disp >= min_displacement_pct * 2:
                            mss_bar_idx = mi
                            break

                if mss_bar_idx >= 0:
                    mss_bar = bars5m[mss_bar_idx]
                    displacement = (mss_bar["close"] - nearest_swing_high["price"]) / nearest_swing_high["price"]
                    if displacement >= min_displacement_pct:
                        fvg_search_start = max(0, best_sweep_idx - 2)
                        fvg = _find_fvg(bars5m, fvg_search_start, "CALL")
                        # Use FVG mid as entry, or current bar close if allowSREntry and near support
                        entry_price = None
                        if fvg and fvg["bar_index"] <= i:
                            entry_price = fvg["mid"]
                        elif allow_sr_entry and _near_sr_level(bar["close"], "CALL"):
                            entry_price = bar["close"]

                        if entry_price is not None:
                            sl_price = min(
                                bars5m[k]["low"]
                                for k in range(best_sweep_idx, min(best_sweep_idx + 3, len(bars5m)))
                            )
                            tp_price = max(liquidity_highs) if liquidity_highs else nearest_swing_high["price"] * 1.01
                            risk = abs(entry_price - sl_price) if entry_price != sl_price else 0.001
                            reward = abs(tp_price - entry_price)
                            if risk > 0 and reward / risk >= min_rr and _near_sr_level(entry_price, "CALL"):
                                signals.append(
                                    StrategySignal(
                                        id=f"s11_ict_{symbol}_call_{current_time}",
                                        symbol=symbol,
                                        strategy_id="strategy11_ict_price_action",
                                        direction="CALL",
                                        entry_time=current_time,
                                        anchor_time=bars5m[best_sweep_idx]["time"],
                                    )
                                )
                                last_signal_time = current_time

    return signals
