# OP3 Trading Strategies Reference

> Last updated: 2026-03-01

---

## Table of Contents

1. [Overview](#overview)
2. [Swing Strategies (1-5)](#swing-strategies)
   - [Strategy 1 — MA Trend Reversal](#strategy-1--ma-trend-reversal)
   - [Strategy 2 — Daily Midline Bounce](#strategy-2--daily-midline-bounce)
   - [Strategy 3 — Open Gap Fade (Low Vol)](#strategy-3--open-gap-fade-low-vol)
   - [Strategy 4 — Bollinger Magnet Effect](#strategy-4--bollinger-magnet-effect)
   - [Strategy 5 — Lateral Open Outside Bollinger](#strategy-5--lateral-open-outside-bollinger)
3. [Opening Strategies (CT15, CT-Open)](#opening-strategies)
   - [CT15 — Gap Trendline Reversal](#ct15--gap-trendline-reversal)
   - [CT-Open — Squeeze Breakout](#ct-open--squeeze-breakout)
4. [0DTE Strategies (7-10)](#0dte-strategies)
   - [Strategy 7 — Scalper](#strategy-7--scalper)
   - [Strategy 8 — Momentum Rider](#strategy-8--momentum-rider)
   - [Strategy 9 — Gap Fade Enhanced](#strategy-9--gap-fade-enhanced)
   - [Strategy 10 — Trend Following](#strategy-10--trend-following)
5. [Risk Management](#risk-management)
6. [Global Settings](#global-settings)
7. [Quick Reference Table](#quick-reference-table)

---

## Overview

OP3 runs 12 strategy detectors organized into three groups:

| Group | Strategies | Tickers | Holding Period | Timeframes |
|-------|-----------|---------|---------------|------------|
| **Swing** | 1, 2, 3, 4, 5 | All watchlist | Hours to days | 1D, 1H, 15M, 1M |
| **Opening** | CT15, CT-Open | All watchlist | Hours to days | 15M, 1M |
| **0DTE** | 7, 8, 9, 10 | SPX only | Minutes to hours | 5M, 1M |

**Common indicators across strategies:**
- Moving Averages (MA20, MA40)
- Bollinger Bands (20-period, 2.0 std dev)
- Worden Stochastic Oscillator (14, 3, 3)
- RSI (14-period) — 0DTE strategies only
- Linear regression trendlines

All strategies output a **direction** (CALL or PUT) and an **entry time** (Unix timestamp). The auto-trader uses these signals to buy options contracts.

---

## Swing Strategies

These strategies operate on any ticker in the watchlist during regular trading hours (9:30 AM - 4:00 PM ET). They use multi-timeframe analysis combining daily, hourly, 15-minute, and 1-minute bars.

---

### Strategy 1 — MA Trend Reversal

**ID:** `strategy-1`
**Concept:** Detects when price crosses back above/below the hourly MA20 after trending in the opposite direction, confirmed by 15-minute stochastic momentum.

#### How It Works

```
Timeframes: 1H (trend) + 15M (confirmation)
```

**CALL signal (bullish reversal):**
1. The last 3 hourly bars all closed **below** MA40 — establishing a downtrend
2. The current hourly bar closes **above** MA20 — a potential reversal
3. Within the next 4 fifteen-minute bars, stochastic confirms:
   - K crosses above 20 (leaving oversold), OR
   - K crosses above D (bullish crossover), OR
   - Price closes above 15M MA20

**PUT signal (bearish reversal):**
1. The last 3 hourly bars all closed **above** MA40 — establishing an uptrend
2. The current hourly bar closes **below** MA20 — a potential reversal
3. Within the next 4 fifteen-minute bars, stochastic confirms:
   - K crosses below 80 (leaving overbought), OR
   - K crosses below D (bearish crossover), OR
   - Price closes below 15M MA20

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trendLookback` | 3 | Number of prior hourly bars that must be on the same side of MA40 |
| `window15m` | 4 | Number of 15M bars to scan for stochastic confirmation |
| `cooldownHours` | 3 | Minimum hours between signals in the same direction |
| `operatingStartTime` | 09:30 | Start of operating window (ET) |
| `operatingEndTime` | 16:00 | End of operating window (ET) |
| `minDTE` | 1 | Minimum days to expiration for option selection |

---

### Strategy 2 — Daily Midline Bounce

**ID:** `strategy2_midline_bounce_1d_1h_15m`
**Concept:** Trades reversals when price returns to the daily MA20 "midline" after a sustained trend, using three timeframes for confirmation.

#### How It Works

```
Timeframes: 1D (trend) + 1H (touch) + 15M (confirmation)
```

**PUT signal (gap-up reversal):**
1. Daily MA20 slope is **downward** over the last 3 days
2. All 3 prior daily bars closed **below** daily MA40 — sustained downtrend
3. Within the current hour, a bar closes **below** daily MA20 AND below the prior bar's low — price returning to the downtrend
4. 15M stochastic confirms within 4 bars (K-cross above 20 or K > D)

**CALL signal (gap-down reversal):**
1. Daily MA20 slope is **upward** over the last 3 days
2. All 3 prior daily bars closed **above** daily MA40 — sustained uptrend
3. Within the current hour, a bar closes **above** daily MA20 AND above the prior bar's high — price bouncing off the midline
4. 15M stochastic confirms within 4 bars (K-cross below 80 or K < D)

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dailyTrendLookback` | 3 | Days to check for MA40 trend consistency |
| `touchPct` | 0.0015 | Price can be within 0.15% of daily MA20 and still count as a "touch" |
| `window1h` | 2 | Hourly bars to scan for the midline touch |
| `window15m` | 4 | 15M bars to scan for stochastic confirmation |
| `cooldownHours` | 6 | Minimum hours between signals |
| `minDTE` | 1 | Minimum days to expiration |

---

### Strategy 3 — Open Gap Fade (Low Vol)

**ID:** `strategy3_open_gap_fade_lowvol_15m_1m`
**Concept:** Fades morning gaps when Bollinger bands are very tight (compressed volatility), expecting the gap to fill.

#### How It Works

```
Timeframes: 1D (gap) + 15M (squeeze) + 1M (entry)
```

1. **Gap detection at 9:30 AM:**
   - Gap up: today's open > prior close + 0.4%
   - Gap down: today's open < prior close - 0.4%

2. **Squeeze check on 15M bars:**
   - Bollinger bandwidth must be in the **bottom 20th percentile** of the last 100 bars — this means bands are very tight, indicating compressed volatility
   - The open must be **inside** the Bollinger bands (not already breaking out)

3. **1-minute entry (9:30 - 9:35 AM):**
   - **Gap up -> PUT:** Find a 1M bar where close < open AND close < prior bar's low (first sign of reversal down)
   - **Gap down -> CALL:** Find a 1M bar where close > open AND close > prior bar's high (first sign of reversal up)

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minGapPct` | 0.004 | Minimum gap size (0.4%) |
| `tightLookback` | 100 | Number of 15M bars to compute bandwidth percentile |
| `tightPercentile` | 20 | Bandwidth must be below this percentile (tight bands) |
| `bandOutsideTol` | 0 | Tolerance for "outside band" check (0 = strict) |
| `entryWindowMinutes` | 5 | Minutes after 9:30 to scan for 1M entry |
| `maxSignalsPerDay` | 1 | Maximum signals per day per symbol |
| `minDTE` | 1 | Minimum days to expiration |

---

### Strategy 4 — Bollinger Magnet Effect

**ID:** `strategy4_magnet_effect_gap_far_from_ma20_15m`
**Concept:** When price opens far outside Bollinger bands, it tends to get "pulled back" toward the MA20 midline (magnet effect). This strategy trades that mean reversion.

#### How It Works

```
Timeframes: 1H (trend context) + 15M (bands + confirmation)
```

1. **Band breakout detection (first 2 bars of the day on 15M):**
   - Price closes outside the upper or lower Bollinger band
   - Must be at least **1.2%** away from the 15M MA20

2. **Trend context (hourly):**
   - Confirms the move is counter-trend or from a weak trend (MA20 slope near zero)

3. **Stochastic confirmation (within 6 bars):**
   - **Outside upper band -> PUT:** K-cross below 80 or K < D
   - **Outside lower band -> CALL:** K-cross above 20 or K > D

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minDistPct` | 0.012 | Price must be 1.2% from MA20 to qualify |
| `firstBarWindow` | 2 | First N bars of the day to check for band break |
| `confirmWindow` | 6 | Bars after breakout to scan for stochastic confirmation |
| `cooldownHours` | 6 | Minimum hours between signals |
| `minDTE` | 1 | Minimum days to expiration |

---

### Strategy 5 — Lateral Open Outside Bollinger

**ID:** `strategy5_lateral_open_outside_bollinger_no_vol`
**Concept:** Similar to Strategy 3 but adds a "no volume drift" filter — bandwidth must be **flat** (not expanding), confirming true compression rather than a developing breakout.

#### How It Works

```
Timeframes: 1D (gap) + 15M (squeeze + flat check) + 1M (entry)
```

1. **Gap detection:** Same as Strategy 3 (min 0.4% gap)

2. **Squeeze + flat bandwidth check on 15M:**
   - Bandwidth in bottom 20th percentile (tight bands)
   - Bandwidth slope over last 6 bars must be < 0.0005 (flat, not expanding)
   - Open must be outside Bollinger bands (with 0.05% tolerance)

3. **1-minute entry (9:30 - 9:35 AM):**
   - Same reversal logic as Strategy 3

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minGapPct` | 0.004 | Minimum gap size (0.4%) |
| `tightLookback` | 100 | Bars for bandwidth percentile |
| `tightPercentile` | 20 | Must be below 20th percentile |
| `bandOutsideTol` | 0.0005 | Open must be outside band by this margin (0.05%) |
| `flatLookback` | 6 | Bars to compute bandwidth slope |
| `flatEpsilon` | 0.0005 | Maximum allowed bandwidth slope (must be flat) |
| `entryWindowMinutes` | 5 | Minutes after 9:30 for entry |
| `maxSignalsPerDay` | 1 | Maximum signals per day |
| `minDTE` | 1 | Minimum days to expiration |

---

## Opening Strategies

These strategies fire exclusively at the market open (9:30 AM ET). They analyze the gap and the first few minutes of trading to catch the initial directional move.

---

### CT15 — Gap Trendline Reversal

**ID:** `ct15_open_gap_trendline_midline_volatility_15m`
**Concept:** The most sophisticated opening strategy. Combines gap analysis, prior-day trendline projection, Bollinger midline position, and bandwidth expansion to detect high-conviction opening moves.

#### How It Works

```
Timeframes: 15M (bands, trendline, gap)
Operating window: 9:30 - 9:45 AM ET (first 15M bar only)
Entry: On the NEXT 15M bar close (9:45 AM) — avoids look-ahead bias
```

1. **Gap detection at the 9:30 bar:**
   - Gap > 0.2% from prior session close

2. **Volatility expansion check:**
   - Current Bollinger bandwidth > average of last 20 bars (bandwidth expanding, not squeezing)
   - Bandwidth slope > 0 over 3 bars (confirming expansion direction)

3. **Prior-day trendline analysis:**
   - Compute linear regression on all prior day's 15M closes
   - Project the trendline to the end of the prior session
   - Slope determines prior-day direction: slope <= 0 = downtrend, slope >= 0 = uptrend

4. **Entry conditions:**

   **CALL (bullish — reversal from prior-day downtrend):**
   - Prior day trending DOWN (slope <= 0)
   - Last prior-day bar closed below Bollinger midline
   - Today's open is ABOVE: prior close, Bollinger midline, AND trendline projection
   - Interpretation: market gaps above the declining trendline, breaking resistance

   **PUT (bearish — reversal from prior-day uptrend):**
   - Prior day trending UP (slope >= 0)
   - Last prior-day bar closed above Bollinger midline
   - Today's open is BELOW: prior close, Bollinger midline, AND trendline projection
   - Interpretation: market gaps below the rising trendline, breaking support

5. **Exposure filter (optional):**
   - If `strictExposedMode: true`, rejects signals where the open is outside Bollinger bands

#### Parameters

| Parameter | Default | Live Override | Description |
|-----------|---------|---------------|-------------|
| `minGapPct` | 0.002 | — | Minimum gap size (0.2%) |
| `bwSlopeLookback` | 3 | — | Bars for bandwidth slope direction |
| `bwAvgRatio` | 1.0 | — | BW must exceed this multiple of 20-bar average |
| `strictExposedMode` | false | — | Reject if open is outside bands |
| `maxSignalsPerDay` | 1 | — | Maximum signals per day |
| `operatingEndTime` | 16:00 | **09:45** | Live: only operates first 15 min |
| `minDTE` | 1 | — | Minimum days to expiration |

---

### CT-Open — Squeeze Breakout

**ID:** `ct_open_squeeze_breakout_15m_1m`
**Concept:** Detects Bollinger Band squeezes on 15M bars, then waits for a confirmed 1-minute breakout with directional displacement at the market open.

#### How It Works

```
Timeframes: 15M (squeeze detection) + 1M (breakout confirmation)
Operating window: 9:30 - 9:45 AM ET
Entry: On the confirming 1M bar
```

**Phase 1 — Squeeze Detection (at 9:30 AM on 15M bars):**
1. Bollinger bandwidth is in the **bottom 15th percentile** of the last 100 bars — very tight squeeze
2. The opening price is **inside** the Bollinger bands (between lower and upper)
3. If `requireSqueeze: false`, this phase is skipped

**Phase 2 — Breakout Confirmation (9:30 - 9:45 AM on 1M bars):**
1. 1M Bollinger bandwidth must be **expanding** (current > baseline at 9:30)
2. Price forms a directional run using the **opening price** as reference:
   - **CALL:** 3+ consecutive 1M bars close above the opening price AND price has moved at least 0.10% above the open
   - **PUT:** 3+ consecutive 1M bars close below the opening price AND price has moved at least 0.10% below the open
3. The displacement gate (0.10%) filters out slow drifts — only real breakouts qualify

#### Parameters

| Parameter | Default | Live Override | Description |
|-----------|---------|---------------|-------------|
| `requireSqueeze` | true | — | Require Phase 1 squeeze check |
| `squeezeLookback` | 100 | — | Bars for bandwidth percentile calc |
| `squeezePercentile` | 15 | — | BW must be below this percentile |
| `entryWindowMinutes` | 15 | — | Minutes after 9:30 to scan |
| `minBreakoutBars` | 3 | — | Consecutive bars needed for confirmation |
| `minDisplacementPct` | 0.10 | — | Price must move this % from open |
| `maxSignalsPerDay` | 1 | — | Maximum signals per day |
| `bwAvgRatio` | — | **0.6** | Live override for BW expansion threshold |
| `minDTE` | 1 | — | Minimum days to expiration |

---

## 0DTE Strategies

Zero Days To Expiration strategies trade **SPX only** using intraday options that expire the same day. They use faster timeframes (5M, 1M) and have tighter risk parameters.

> **Important:** These strategies are restricted to tickers listed in `allowedTickers` (default: `["SPX"]`). They are enabled per-ticker via the `enabledStrategies` array in ticker settings. SPX currently has strategies `[7, 8, 9, 10]` enabled.

---

### Strategy 7 — Scalper

**ID:** `strategy7_0dte_scalper`
**Concept:** Ultra-short-term momentum scalping. Detects consecutive bullish/bearish 1M bars with a volume spike, enters for a quick 5-minute trade.

#### How It Works

```
Timeframes: 1M only
Hold time: Maximum 5 minutes
```

1. **Momentum detection:** Find 2+ consecutive 1M bars in the same direction:
   - **CALL:** All bars close > open (bullish)
   - **PUT:** All bars close < open (bearish)

2. **Volume confirmation:** Current bar's volume must exceed the 5-bar volume average by at least 1.5x (volume spike)

3. **Entry:** Immediately on the confirming bar

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `allowedTickers` | ["SPX"] | Only these tickers can trade |
| `minConsecutiveBars` | 2 | Bars of same direction needed |
| `volumeSpikePct` | 1.5 | Volume must be 1.5x the 5-bar average |
| `maxHoldMinutes` | 5 | Force-close after 5 minutes |
| `cooldownMinutes` | 3 | Minimum minutes between signals |
| `profitTargetPct` | 0.10 | 10% profit target |
| `stopLossPct` | 0.20 | 20% stop loss |
| `maxSpreadDollar` | 0.30 | Maximum bid-ask spread allowed |
| `useTrailingStop` | false | No trailing stop |

---

### Strategy 8 — Momentum Rider

**ID:** `strategy8_0dte_momentum`
**Concept:** Rides strong RSI-confirmed momentum using both 1M and 5M timeframe alignment. Designed for larger moves with trailing stop.

#### How It Works

```
Timeframes: 1M + 5M (alignment)
```

1. **RSI entry zone (on 1M bars):**
   - **CALL:** RSI(14) > 65 (strong upward momentum)
   - **PUT:** RSI(14) < 35 (strong downward momentum)

2. **Timeframe alignment:**
   - 5M bar closes in the same direction as 1M bar
   - 1M volume exceeds the 5M average volume

3. **Entry:** On the confirming 1M bar

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `allowedTickers` | ["SPX"] | Only these tickers can trade |
| `rsiPeriod` | 14 | RSI calculation period |
| `rsiOverbought` | 65 | RSI threshold for CALL entry |
| `rsiOversold` | 35 | RSI threshold for PUT entry |
| `cooldownMinutes` | 10 | Minimum minutes between signals |
| `profitTargetPct` | 0.50 | 50% profit target |
| `stopLossPct` | 0.25 | 25% stop loss |
| `useTrailingStop` | true | Trailing stop enabled |
| `trailingStopPct` | 0.30 | 30% trail below high water mark |
| `trailingActivationPct` | 0.25 | Trail activates at 25% profit |

---

### Strategy 9 — Gap Fade Enhanced

**ID:** `strategy9_0dte_gap_fade`
**Concept:** Fades large morning gaps during mid-day trading when the gap begins to fill, confirmed by multi-timeframe alignment.

#### How It Works

```
Timeframes: 1D (gap) + 15M + 1M (alignment)
Entry window: 10:00 AM - 2:00 PM ET
```

1. **Gap detection (daily):**
   - Gap must be > 0.5% (larger than swing strategies)

2. **Gap fill confirmation (10:00 AM - 2:00 PM):**
   - **Gap up -> PUT:** 1M bar closes below today's open AND 15M bar closes below its open
   - **Gap down -> CALL:** 1M bar closes above today's open AND 15M bar closes above its open

3. **Time-based exit:** Force-close all positions at 3:30 PM ET

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `allowedTickers` | ["SPX"] | Only these tickers can trade |
| `minGapPct` | 0.005 | Minimum gap size (0.5%) |
| `entryStartTime` | 10:00 | Start scanning (waits for gap to develop) |
| `entryEndTime` | 14:00 | Stop scanning at 2:00 PM |
| `timeExitAt` | 15:30 | Force-close at 3:30 PM |
| `cooldownMinutes` | 30 | Minimum minutes between signals |
| `profitTargetPct` | 0.20 | 20% profit target |
| `stopLossPct` | 0.30 | 30% stop loss |

---

### Strategy 10 — Trend Following

**ID:** `strategy10_0dte_trend`
**Concept:** Catches sustained intraday trends using consecutive 1M bars, a 1M SMA20/SMA200 breakout, RSI confirmation in a trend-following zone, and 2M alignment. The widest profit target of all 0DTE strategies.

#### How It Works

```
Timeframes: 1M (trend, RSI, SMA breakout) + 2M (alignment)
Entry window: 9:45 AM - 1:00 PM ET
```

1. **Trend detection (1M bars):**
   - 3+ consecutive bars closing in the same direction (all close > open or all close < open)

2. **Optional SMA breakout filter (1M bars):**
   - **CALL:** price starts at/below the SMA20/SMA200 zone and closes above both averages
   - **PUT:** price starts at/above the SMA20/SMA200 zone and closes below both averages

3. **RSI confirmation (1M, period 14):**
   - **CALL:** RSI between 50-70 (trending up but not overextended)
   - **PUT:** RSI between 30-50 (trending down but not overextended)

4. **2M alignment:**
   - Most recent 2M bar must close in the same direction as the 1M trend

5. **VWAP trend filter:**
   - **CALL:** price must be above VWAP and VWAP must be rising
   - **PUT:** price must be below VWAP and VWAP must be falling

6. **Freshness and continuation checks:**
   - Signal must be recent enough to trade
   - Live price must still be beyond the signal candle in the trade direction
   - Recent failed SMA breakouts temporarily block new entries

7. **Time-based exit:** Force-close at 3:30 PM ET

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `allowedTickers` | ["SPX"] | Only these tickers can trade |
| `minTrendBars` | 3 | Consecutive 1M bars same direction |
| `rsiPeriod` | 14 | RSI calculation period |
| `rsiTrendCallMin` | 50 | Lower RSI bound for CALL |
| `rsiTrendCallMax` | 70 | Upper RSI bound for CALL |
| `rsiTrendPutMin` | 30 | Lower RSI bound for PUT |
| `rsiTrendPutMax` | 50 | Upper RSI bound for PUT |
| `requireSmaBreakout` | false | Optionally require 1M price to break out from the SMA20/SMA200 zone |
| `smaFastPeriod` | 20 | Fast SMA period on 1M bars |
| `smaSlowPeriod` | 200 | Slow SMA period on 1M bars |
| `signalMaxAgeSecs` | 180 | Maximum signal age before the auto-trader rejects it |
| `requireEntryPriceConfirmation` | true | Require live price to remain beyond the signal candle before entry |
| `requireVwapTrend` | true | Require VWAP side and VWAP slope to confirm direction |
| `vwapSlopeLookback` | 5 | Number of 1M bars used to confirm VWAP slope |
| `failedBreakoutBlockMinutes` | 30 | Minutes to block entries after an SMA breakout fails |
| `minDelta` | 0.35 | Minimum absolute option delta for contract selection |
| `entryStartTime` | 09:45 | Start scanning |
| `entryEndTime` | 13:00 | Stop scanning at 1:00 PM |
| `timeExitAt` | 15:30 | Force-close at 3:30 PM |
| `cooldownMinutes` | 60 | Minimum minutes between signals |
| `profitTargetPct` | 0.75 | 75% profit target |
| `stopLossPct` | 0.30 | 30% stop loss |
| `useTrailingStop` | true | Trailing stop enabled |
| `trailingStopPct` | 0.40 | 40% trail below HWM |
| `trailingActivationPct` | 0.50 | Trail activates at 50% profit |

---

## Risk Management

### Take Profit & Trailing Stop

The trailing stop system applies **globally** to all positions (not per-strategy). Per-position overrides are available via the UI.

**Current live settings:**

| Setting | Value | Description |
|---------|-------|-------------|
| `profitTargetPct` | **0.30** (30%) | Premium must gain 30% to activate trailing |
| `trailingStopPct` | **0.07** (7%) | Once active, trail 7% below the high water mark |
| `useTrailingStop` | true | Trailing stop enabled |
| `stopLossPct` | **0.17** (17%) | Hard stop loss at -17% |

**How the trailing stop works:**

```
Entry premium = $10.00
TP activation = $10.00 x 1.30 = $13.00

1. Premium rises to $13.00 -> Trail ACTIVATES
2. Trail stop = $13.00 x 0.93 = $12.09 (but clamped to $10.00 breakeven floor)
3. Premium rises to $15.00 -> HWM updates
   Trail stop = $15.00 x 0.93 = $13.95
4. Premium drops to $13.95 -> TRAIL STOP TRIGGERED -> position closed at +39.5%
```

**Key rules:**
- Trail stop price is never set below entry price (breakeven floor)
- If price gaps through both trail stop AND entry in one check, position closes immediately
- Stop loss (-17%) overrides everything — fires even if trail hasn't activated
- Settings can be overridden per-position via "Set Custom TP" in the UI

### Stop Loss

| Setting | Value |
|---------|-------|
| `stopLossPct` | 0.17 (17%) |

Applied to all positions. If premium drops 17% below entry, the position is closed regardless of trailing stop status.

### Position Sizing

| Setting | Default | SPX Override |
|---------|---------|-------------|
| `positionSizing` | "fixed" | "fixed_risk" |
| `riskPerTrade` | $1,000 | $750 |
| `capitalLimit` | $10,000 | — |
| `maxConcurrentPositions` | 20 | — |
| `maxContractsPerTrade` | 100 | — |
| `onePositionPerSymbol` | true | — |

### Settings Hierarchy

Settings are resolved in this order (later overrides earlier):

1. **Global defaults** — `auto_trader_settings.json` base settings
2. **Symbol overrides** — `auto_trader_settings.json` -> `overrides.{SYMBOL}`
3. **Per-position overrides** — `position_tp_overrides.json` (set via UI)

Note: Strategy-level TP settings (defined in `strategy_defaults.py` for strategies 7-10) are **not** applied during TP checks. Only the three tiers above are used.

---

## Global Settings

### Auto-Trader Operating Parameters

| Setting | Value | Description |
|---------|-------|-------------|
| `intervalSeconds` | 60 | Scan for new signals every 60s |
| `tpCheckIntervalSeconds` | 10 | Check open positions every 10s |
| `rthOnly` | true | Only trade during regular trading hours |
| `maxTradesPerDay` | 3 | Maximum new positions per day |
| `signalMaxAgeSecs` | 600 | Signals older than 10 min are ignored |
| `allowOpenPositions` | true | Can open new positions |
| `openPositionsUntil` | 15:45 | Stop opening positions after 3:45 PM |
| `allowClosePositions` | true | Can close existing positions |
| `expiryCloseTime` | 14:45 | Close expiring-today positions by 2:45 PM |
| `skipEarningsDay` | true | Skip tickers reporting earnings today |
| `allowCalls` | true | CALL signals are allowed |
| `allowPuts` | true | PUT signals are allowed |

### Order Execution

| Setting | Value | Description |
|---------|-------|-------------|
| `useMarketOrders` | true | Use market orders for entry |
| `useLimitOrdersForEntry` | true | Use limit orders for entry |
| `useLimitOrdersForTrailExit` | false | Use market orders for trail exits |
| `limitOrderTimeoutSecs` | 60 | Cancel unfilled limit orders after 60s |
| `filterBySpread` | true | Reject wide spreads |
| `maxSpreadPct` | 15.0% | Maximum bid-ask spread percentage |
| `maxSpreadDollar` | $0.20 | Maximum bid-ask spread in dollars |
| `preferTightSpreads` | true | Prefer options with tighter spreads |

### Minimum Bar Requirements

| Interval | Minimum Bars | Purpose |
|----------|-------------|---------|
| 1D | 200 | MA200 on daily chart |
| 1H | 400 | Hourly indicators |
| 15M | 800 | 15-minute indicators |
| 5M | 600 | 5-minute indicators (0DTE) |
| 1M | 2000 | 1-minute entry logic |

---

## Quick Reference Table

| Strategy | Name | Tickers | Hours (ET) | Timeframes | Entry Style | Key Indicator |
|----------|------|---------|-----------|------------|-------------|---------------|
| **1** | MA Trend Reversal | All | 09:30-16:00 | 1H, 15M | Crossover + stochastic | MA20/MA40 |
| **2** | Daily Midline Bounce | All | 09:30-16:00 | 1D, 1H, 15M | Touch + stochastic | Daily MA20 |
| **3** | Open Gap Fade | All | 09:30-09:35 | 1D, 15M, 1M | Gap + squeeze + 1M reversal | BB bandwidth pctl |
| **4** | BB Magnet Effect | All | 09:30-16:00 | 1H, 15M | Far from MA20 + stochastic | BB distance |
| **5** | Lateral Open Outside BB | All | 09:30-09:35 | 1D, 15M, 1M | Gap + flat squeeze + 1M reversal | BB bandwidth slope |
| **CT15** | Gap Trendline Reversal | All | 09:30-09:45 | 15M | Gap + trendline + midline | Prior-day regression |
| **CT-Open** | Squeeze Breakout | All | 09:30-09:45 | 15M, 1M | Squeeze + consecutive bars + displacement | BB squeeze pctl |
| **7** | 0DTE Scalper | SPX | 09:30-15:45 | 1M | Momentum + volume spike | Volume SMA |
| **8** | 0DTE Momentum | SPX | 09:30-15:45 | 1M, 5M | RSI zone + alignment | RSI(14) |
| **9** | 0DTE Gap Fade | SPX | 10:00-14:00 | 1D, 15M, 1M | Large gap + fill confirmation | Gap % |
| **10** | 0DTE Trend | SPX | 09:45-13:00 | 1M, 2M | Consecutive bars + RSI zone + SMA breakout | RSI(14), SMA20/200 |

| Strategy | TP | Stop Loss | Trail | Trail Activation | Max Hold |
|----------|-----|----------|-------|-----------------|----------|
| **1-5, CT15, CT-Open** | 30%* | 17%* | 7%* | 30%* | EOD / multi-day |
| **7** | 10% | 20% | — | — | 5 min |
| **8** | 50% | 25% | 30% | 25% | EOD |
| **9** | 20% | 30% | — | — | 3:30 PM |
| **10** | 75% | 30% | 40% | 50% | 3:30 PM |

*\* Uses global auto-trader settings, not per-strategy. Can be overridden per-position.*

---

## Implementation Status

| Strategy | Status | Backend | Frontend | Testing |
|----------|--------|---------|----------|---------|
| Strategy 1 | Live | Done | Done | Live |
| Strategy 2 | Live | Done | Done | Live |
| Strategy 3 | Live | Done | Done | Live |
| Strategy 4 | Live | Done | Done | Live |
| Strategy 5 | Live | Done | Done | Live |
| CT15 | Live | Done | Done | Live |
| CT-Open | Live | Done | Done | Backtested |
| Strategy 7 (0DTE Scalper) | Live | Done | Done | Paper |
| Strategy 8 (0DTE Momentum) | Live | Done | Done | Paper |
| Strategy 9 (0DTE Gap Fade) | Live | Done | Done | Paper |
| Strategy 10 (0DTE Trend) | Live | Done | Done | Paper |

---

## References

- Backend strategy detection: `backend/app/services/strategy_analysis.py`
- Default parameters: `backend/app/services/strategy_defaults.py`
- Auto-trader logic: `backend/app/services/auto_trader.py`
- Live settings: `backend/data/auto_trader_settings.json`
- Frontend analysis: `frontend/src/analysis/strategyAnalysis.ts`
- Frontend defaults: `frontend/src/analysis/strategyDefaults.ts`
- Settings UI: `frontend/src/components/chart/ChartToolbar.tsx`
- Auto-trader UI: `frontend/src/components/overview/TradingDashboard.tsx`
