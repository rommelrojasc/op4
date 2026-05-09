# Daily Auto Trader Report Prompt

Copy and paste this prompt at the end of each trading day:

---

Analyze today's auto trader performance. Run all of the following analysis steps using the actual data files — do NOT fabricate or estimate data.

## Data Sources

Read these files for today's date:
- **Trade log**: `backend/data/trade_log.jsonl` — filter for today's date
- **Activity log**: `backend/data/auto_trader_activity.jsonl` — filter for today's date
- **Option chain snapshots**: `backend/data/option_chain_snapshots.jsonl` — filter for today's date
- **Settings**: `backend/data/auto_trader_settings.json` — current config
- **SPY price data**: use the `/api/v1/market-data/historical?symbol=SPY&timeframe=5m&count=200` endpoint

## Analysis Sections

### 1. Market Context
- SPY open, close, high, low, range, direction
- Hourly breakdown (price at each hour, direction, magnitude)
- First 30-min analysis: direction, range, did it predict the day?
- Gap from previous close (gap up/down?)
- Was it a trend day or chop day? (count direction changes on 5m bars)

### 2. Trade Summary Table
For each trade show: entry time, exit time, contract (right+strike), quantity, entry premium, exit premium, P&L ($), P&L (%), MFE, MAE, hold time, exit reason, strategy ID.

### 3. Signal Analysis
- How many signals were detected? (from backtest endpoint or activity log)
- How many were chop-filtered? What were the ADX/DI values?
- How many were skipped? (from `signal_skipped` events in activity log). Group by reason: settle_cash, capital_limit, cooldown, no_strike_match, signal_too_old, etc.
- For each signal that was acted on: was the direction correct given what happened after? Would holding longer have been profitable?

### 4. Entry Quality
- For each trade: what was SPY doing at entry time? Was it entering at a good price or chasing?
- Was the strike selection optimal? (how far OTM, what was delta at entry)
- Entry slippage: fill price vs mid price at the time

### 5. Exit Quality
- For each exit: was it premature? Calculate what P&L would have been with:
  - 10% trail (vs current setting)
  - 15% trail
  - 20% trail
  - Time exit only (hold until 15:30)
  - Perfect exit (at MFE peak)
- How much of MFE was captured? (exit premium - entry) / (peak premium - entry)
- Was the trailing stop too tight? (triggered on noise vs real reversal)

### 6. What Was Left on the Table
- For each trade: track SPY price from entry to close of day. How much further did price move in the trade's direction?
- Estimate what the option premium would have been at the day's best price for that direction
- Total P&L captured vs total P&L available

### 7. Skipped Signals — Missed Opportunities
- For each skipped signal: what would have happened if it had been traded?
- Track SPY from signal time to close — did it move in the signal direction?
- Were the skips correct (would have lost money) or missed opportunities?

### 8. Strategy Performance
- Which strategies generated signals? (S10, S11, S12, S13)
- Win/loss by strategy
- Are any strategies producing consistently bad signals?

### 9. Settings Assessment
- Are current settings appropriate given today's results?
- Specific recommendations with reasoning:
  - Trail stop % (too tight? too loose?)
  - Profit target activation
  - Stop loss (is one needed?)
  - Stale exit timing and threshold
  - Capital limit
  - Chop filter thresholds

### 10. Running Tally
- Show last 10 trading days: date, trades, P&L, wins, losses
- Cumulative P&L
- Overall win rate, avg winner, avg loser, profit factor
- Trend: is performance improving or degrading?

### 11. Actionable Recommendations
- Rank by impact: what single change would have improved today's results the most?
- Should any settings be changed before tomorrow?
- Any patterns emerging over the last few days?
