"""Strategy 13: Opening Direction Confirmation (ODC).

Waits for the first N minutes (observation window) to establish direction,
then confirms with consecutive bars closing in the same direction outside
the opening range. Avoids the noisy first 5 minutes and the 47% false
breakout rate of immediate ORB strategies.

Key finding: the 30-min direction predicts the full-day direction 70% of the time.
"""
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.services.strategy_analysis import StrategySignal

logger = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")

STRATEGY_ID = "strategy13_opening_direction"


@dataclass
class OpeningDirectionSignal:
    """Extended signal with opening direction metadata."""
    signal: StrategySignal
    direction: str  # "UP" or "DOWN"
    range_high: float
    range_low: float
    range_dollars: float
    open_price: float
    obs_close: float
    gap_dollars: float  # gap from previous close
    confirmation_time: str  # HH:MM when confirmed
    confirmation_bars_used: int


def detect_opening_direction_signals(
    *,
    symbol: str,
    bars_5m: List[Dict],
    settings: Dict[str, Any],
    prev_close: Optional[float] = None,
    at_timestamp: Optional[int] = None,
) -> List[OpeningDirectionSignal]:
    """Detect opening direction confirmation signals.

    Args:
        symbol: Trading symbol (SPY)
        bars_5m: 5-minute bars (should include today's bars)
        settings: Strategy settings dict (expects settings["strategy13"])
        prev_close: Previous day's closing price (for gap detection)
        at_timestamp: Optional timestamp for backtesting

    Returns:
        List of OpeningDirectionSignal objects (at most 1 per day)
    """
    if not bars_5m:
        return []

    strat = settings.get("strategy13", {})

    # Time window check
    if at_timestamp:
        now = datetime.fromtimestamp(at_timestamp, NY)
    else:
        now = datetime.now(NY)

    entry_start = strat.get("entryStartTime", "10:00")
    entry_end = strat.get("entryEndTime", "11:30")
    try:
        es_h, es_m = map(int, entry_start.split(":"))
        ee_h, ee_m = map(int, entry_end.split(":"))
        current_mins = now.hour * 60 + now.minute
        # Too early — observation not done yet
        if current_mins < es_h * 60 + es_m:
            return []
        # Too late — entry window closed
        if current_mins > ee_h * 60 + ee_m:
            return []
    except (ValueError, AttributeError):
        pass

    # Parameters
    obs_minutes = int(strat.get("observationMinutes", 30))
    confirm_bars_needed = int(strat.get("confirmationBars", 3))
    min_range = float(strat.get("minRangeDollars", 1.50))
    max_range = float(strat.get("maxRangeDollars", 5.00))
    enable_gap_fade = strat.get("enableGapFade", True)
    require_retest = strat.get("requireRetest", False)

    # Determine today's date from bars
    today_str = now.strftime("%Y-%m-%d")
    today_date = now.date()

    # Filter to today's bars only
    today_bars = []
    for b in bars_5m:
        bar_dt = datetime.fromtimestamp(b["time"], NY)
        if bar_dt.date() == today_date:
            today_bars.append(b)

    if not today_bars:
        return []

    # Market open time
    market_open = datetime(now.year, now.month, now.day, 9, 30, tzinfo=NY)
    market_open_ts = int(market_open.timestamp())
    obs_end_ts = market_open_ts + obs_minutes * 60

    # Phase 1: Observation window bars (09:30 → 09:30 + obs_minutes)
    obs_bars = [b for b in today_bars if market_open_ts <= b["time"] < obs_end_ts]
    if len(obs_bars) < 2:
        return []

    open_price = obs_bars[0]["open"]
    obs_close = obs_bars[-1]["close"]
    range_high = max(b["high"] for b in obs_bars)
    range_low = min(b["low"] for b in obs_bars)
    range_dollars = range_high - range_low

    # Range filter
    if range_dollars < min_range:
        logger.debug(f"S13 {symbol}: range ${range_dollars:.2f} < min ${min_range:.2f}, skipping")
        return []
    if range_dollars > max_range:
        logger.debug(f"S13 {symbol}: range ${range_dollars:.2f} > max ${max_range:.2f}, skipping")
        return []

    # Direction
    if obs_close > open_price:
        direction = "UP"
        trade_direction = "CALL"
    else:
        direction = "DOWN"
        trade_direction = "PUT"

    # Gap fade filter
    gap_dollars = (open_price - prev_close) if prev_close else 0
    if enable_gap_fade and prev_close:
        is_gap_up = gap_dollars > 0.5  # meaningful gap threshold
        is_gap_down = gap_dollars < -0.5
        if is_gap_up and direction == "UP":
            # Gap-up continuation — data shows 53% reverse by EOD, skip
            logger.info(f"S13 {symbol}: gap-up + UP direction = continuation, blocked by gap fade filter")
            return []
        if is_gap_down and direction == "DOWN":
            # Gap-down continuation — 50/50 odds, skip
            logger.info(f"S13 {symbol}: gap-down + DOWN direction = continuation, blocked by gap fade filter")
            return []

    # Phase 2: Confirmation bars (after observation window)
    post_obs_bars = [b for b in today_bars if b["time"] >= obs_end_ts]
    if not post_obs_bars:
        return []

    # Parse entry end time for cutoff
    try:
        ee_dt = datetime(now.year, now.month, now.day, ee_h, ee_m, tzinfo=NY)
        entry_end_ts = int(ee_dt.timestamp())
    except Exception:
        entry_end_ts = obs_end_ts + 5400  # fallback: 1.5h after obs

    # Optional retest: price must touch back to range boundary before confirming
    retest_seen = not require_retest  # if not required, treat as already seen
    if require_retest:
        for b in post_obs_bars:
            if b["time"] > entry_end_ts:
                break
            if direction == "UP" and b["low"] <= range_high:
                retest_seen = True
                break
            if direction == "DOWN" and b["high"] >= range_low:
                retest_seen = True
                break

    if not retest_seen:
        logger.debug(f"S13 {symbol}: retest required but not seen, skipping")
        return []

    # Count consecutive confirmation bars
    consecutive = 0
    confirm_bar = None
    for b in post_obs_bars:
        if b["time"] > entry_end_ts:
            break  # past entry window

        if direction == "UP":
            # Bar must close above the observation range high
            if b["close"] > range_high and b["close"] > b["open"]:
                consecutive += 1
            else:
                consecutive = 0
        else:  # DOWN
            # Bar must close below the observation range low
            if b["close"] < range_low and b["close"] < b["open"]:
                consecutive += 1
            else:
                consecutive = 0

        if consecutive >= confirm_bars_needed:
            confirm_bar = b
            break

    if not confirm_bar:
        return []

    # Generate signal
    confirm_dt = datetime.fromtimestamp(confirm_bar["time"], NY)
    confirm_time = confirm_dt.strftime("%H:%M")
    entry_ts = confirm_bar["time"]
    signal_id = f"{STRATEGY_ID}_{symbol}_{trade_direction.lower()}_{entry_ts}"

    signal = StrategySignal(
        id=signal_id,
        symbol=symbol,
        strategy_id=STRATEGY_ID,
        direction=trade_direction,
        entry_time=entry_ts,
        anchor_time=entry_ts,
    )

    odc_signal = OpeningDirectionSignal(
        signal=signal,
        direction=direction,
        range_high=range_high,
        range_low=range_low,
        range_dollars=range_dollars,
        open_price=open_price,
        obs_close=obs_close,
        gap_dollars=gap_dollars,
        confirmation_time=confirm_time,
        confirmation_bars_used=consecutive,
    )

    logger.info(
        f"S13 signal: {trade_direction} confirmed at {confirm_time} "
        f"(dir={direction}, range ${range_low:.2f}-${range_high:.2f} = ${range_dollars:.2f}, "
        f"gap ${gap_dollars:+.2f}, {consecutive} confirm bars)"
    )

    return [odc_signal]


def scan_day_for_opening_direction_signals(
    *,
    symbol: str,
    bars_5m: List[Dict],
    settings: Dict[str, Any],
    prev_close: Optional[float] = None,
) -> List[StrategySignal]:
    """Scan a day's 5m bars for opening direction signals (for backtesting).

    Walks through the day simulating time progression, checking for
    confirmation at each 5m bar after the observation window.

    Args:
        symbol: Trading symbol
        bars_5m: Full day's 5-minute bars
        settings: Strategy settings
        prev_close: Previous day's closing price

    Returns:
        List of StrategySignal objects (at most 1)
    """
    if not bars_5m:
        return []

    strat = settings.get("strategy13", {})
    obs_minutes = int(strat.get("observationMinutes", 30))

    # Find observation end timestamp
    first_bar = bars_5m[0]
    first_dt = datetime.fromtimestamp(first_bar["time"], NY)
    market_open = datetime(first_dt.year, first_dt.month, first_dt.day, 9, 30, tzinfo=NY)
    obs_end_ts = int(market_open.timestamp()) + obs_minutes * 60

    # Walk through post-observation bars, checking for signal at each
    for b in bars_5m:
        if b["time"] < obs_end_ts:
            continue

        # Simulate "now" at the end of this bar
        bar_ts = b["time"] + 300  # end of 5m bar
        bars_up_to = [x for x in bars_5m if x["time"] <= b["time"]]

        signals = detect_opening_direction_signals(
            symbol=symbol,
            bars_5m=bars_up_to,
            settings=settings,
            prev_close=prev_close,
            at_timestamp=bar_ts,
        )

        if signals:
            return [s.signal for s in signals]

    return []
