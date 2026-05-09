# Strategy 14 — Gamma Zero (SPY 0DTE)

> Settings reference and operator's guide.
> Implements the *cero_gamma_v4* spec on SPY 0DTE options using GEX levels derived from the SPX 0DTE option chain.

---

## At a glance

| Field | Value |
|---|---|
| **Strategy ID** | `strategy14_gamma_zero` |
| **Settings key** | `strategy14` |
| **Default ticker** | SPY (GEX still derived from SPX) |
| **Timeframes** | 1m (entry timing) + 5m (reclaim candle) |
| **Holding period** | Minutes to a few hours, force-closed before 3:00 PM ET |
| **Source files** | [`strategy14_gamma_zero.py`](../backend/app/services/strategy14_gamma_zero.py), [`strategy_defaults.py`](../backend/app/services/strategy_defaults.py) |

---

## Concept

The strategy maps current price against three GEX-derived levels — Call Wall, Put Wall, and Gamma Flip — refreshed every few minutes from the live SPX option chain. Based on where price sits, it picks one of four "positions":

| # | Position | Trigger | Direction |
|---|---|---|---|
| 1 | Between walls + POSITIVE_GAMMA | Price within `wallProximityPct` of put wall (bounce) | CALL |
| 1 | Between walls + POSITIVE_GAMMA | Price within `wallProximityPct` of call wall (rejection) | PUT |
| 1 | Between walls + NEGATIVE_GAMMA | Price within `wallProximityPct` of call wall | PUT |
| 2 | Above call wall | Price > call wall (gamma squeeze) | CALL |
| 3 | Below put wall | Price < put wall (free fall) | PUT |
| 4 | Reclaim of broken put wall | All 3 reclaim conditions met (off by default) | CALL |

A no-go zone of `±gammaZeroBufferPct` around the gamma flip suppresses all entries (matches the "wait 15–30 min at gamma zero" spec rule).

Two entry windows are enforced inside the detector: **10:00–11:30 ET** and **14:00–15:00 ET**. Outside these, no signals fire regardless of `entryStartTime` / `entryEndTime`.

---

## All settings

Settings live under the `strategy14` key in `strategy_defaults.py` and may be overridden per-ticker in `tickerSettings` or globally in `strategy_settings_overrides`.

### Time & lifecycle

| Setting | Default | Description |
|---|---|---|
| `enabled` | `false` | Master toggle. Setting `true` here enables S14 globally; you can also enable per-ticker by adding `14` to `tickerSettings[symbol].enabledStrategies`. |
| `operatingStartTime` | `"10:00"` | Outer bound checked by the auto-trader before invoking the detector. The detector itself enforces the dual entry windows below this layer. |
| `operatingEndTime` | `"15:00"` | Outer bound checked by the auto-trader. Keep ≥ end of the second window (15:00). |
| `entryStartTime` | `"10:00"` | Outer entry window start. **Not used by the detector** — the dual 10:00–11:30 and 14:00–15:00 windows are hardcoded. Kept for compatibility with the `_strategy_settings_key` plumbing. |
| `entryEndTime` | `"15:00"` | Outer entry window end. Same caveat as above. |
| `timeExitAt` | `"15:00"` | **Hard force-close time.** All open S14 positions are flat-closed at this time regardless of P&L (Golden Rule 5: "always close before 3:00 PM"). |
| `cooldownMinutes` | `30` | Minimum minutes between successive S14 signals. Prevents the same wall-proximity condition from firing every detector tick. |

### Ticker & expiration

| Setting | Default | Description |
|---|---|---|
| `allowedTickers` | `["SPY"]` | Tickers the detector will trade. SPY is the default execution vehicle because Polygon retains historical SPY option contracts (needed for backtest), and IB Greeks for SPY are widely available. The walls themselves are still derived from the SPX 0DTE chain (more institutional liquidity); auto-trader scales them by ÷10 before passing to the detector. |
| `targetDTE` | `0` | Target days to expiration. 0 = same-day. Do not change unless you understand the implications for theta. |
| `limitOrderTimeoutSecs` | `60` | Seconds the auto-trader waits for the limit order to fill before falling back to a market order. |

### GEX & wall logic

| Setting | Default | Description |
|---|---|---|
| `gexRefreshMinutes` | `10` | Minutes between GEX refresh calls. The auto-trader caches the SPX option chain pull. Lower = fresher levels but more IB load; per the spec the Classic levels don't change intraday so 10–15 min is plenty. |
| `gammaZeroBufferPct` | `0.0015` | No-entry zone around the gamma flip, expressed as a decimal fraction of spot. `0.0015` = 0.15%. If `|spot − flip| / spot ≤ buffer`, no signal fires. Implements "DO NOT ENTER at Gamma Zero — wait 15–30 min". |
| `wallProximityPct` | `0.002` | Distance threshold (decimal fraction of spot) for the "near a wall" check used by Position 1. `0.002` = 0.2%. On SPY at ~$700 this is ~$1.40. Looser = more between-walls entries; tighter = wait for a true wall touch. |

### Put Wall reclaim (Position 4)

| Setting | Default | Description |
|---|---|---|
| `enableReclaimEntries` | `false` | Master toggle for Position 4 (CALL on a Put Wall reclaim in NEGATIVE_GAMMA). **Off by default** because it's the highest-risk path in the spec. Turn on only after backtesting shows positive expectancy. |
| `minBounceVolumeRatio` | `1.0` | Volume confirmation for the reclaim candle. The current 5m bar's volume must be ≥ this multiple of the average of the prior 5 bars. `1.0` = at-or-above average; `1.5` = +50% volume spike. |

### Profit target & stop

| Setting | Default | Description |
|---|---|---|
| `profitTargetPct` | `0.50` | Take-profit on **option premium** (not underlying), expressed as decimal. `0.50` = +50% gain — the T1 target from the spec. (MVP path: single TP, no T2 partial.) |
| `stopLossPct` | `0.20` | Hard stop on option premium. `0.20` = −20% — Golden Rule 7. |
| `useTrailingStop` | `false` | Enable a trailing stop (off by default for S14; the spec doesn't call for one). |
| `trailingStopPct` | `0.10` | If trailing is on: distance below high-water mark. |
| `trailingActivationPct` | `0.50` | If trailing is on: profit level at which trailing activates. |

---

## Live vs backtest behavior

| Aspect | Live | Backtest (HTML form) |
|---|---|---|
| **GEX source** | Real IB option chain via `gex_analysis.compute_gex(symbol="SPX")` — uses streamed Greeks. | Polygon SPY option bars; gamma approximated via Black-Scholes; total volume used as OI proxy ([`strategy12_gex.py:189–262`](../backend/app/services/strategy12_gex.py)). |
| **Strike scale** | SPX (~7000); auto-trader divides walls by 10 before passing to S14 since `allowedTickers=["SPY"]`. | SPY (~700) directly — no scaling. |
| **Regime values** | `"POSITIVE_GAMMA"` / `"NEGATIVE_GAMMA"` from compute_gex. | `"BULLISH"` / `"BEARISH"` from `compute_gex_levels_from_quotes`; backtester adapts to the live shape via `adapt_backtest_gex_for_s14()`. |
| **Spot used for entries** | Most recent 1m bar close. | Most recent 1m bar close from the `scan_day_for_gamma_zero_signals` walker. |
| **Position management** | Auto-trader places real orders, monitors until TP/SL/timeExit. | `simulate_day_trades` in `backtest_core.py` — applies the same TP/SL settings against historical option premiums. |

> ⚠️ Backtest results are a **logic sanity check**, not a faithful predictor of live performance. The backtest GEX is approximated and the live signal will differ.

---

## Enabling the strategy

### Live (auto-trader)

Two ways:

1. **Globally** — set `strategy14.enabled = true` in your auto-trader strategy settings.
2. **Per-ticker** — add `14` to the `enabledStrategies` array for the ticker (e.g. SPY) in the Strategy Settings UI's per-ticker table. Useful when you want different strategy mixes per symbol.

Either way, the auto-trader will:
- During the 09:30–09:47 priority window, scan the ticker first (S14 is in `_0dte_ids`).
- Refresh the SPX-derived GEX every `gexRefreshMinutes`.
- Pass the scaled GEX into the S14 detector at every scan tick.
- Honor `cooldownMinutes` between signals.
- Force-close all S14 positions at `timeExitAt`.

### Backtester (HTML form)

1. Open `GET /api/v1/market-data/options-backtest` in a browser.
2. Symbol: `SPY` (default).
3. Strategy: choose **S14 — Gamma Zero (SPY)** (or **All (S10–S14)**).
4. Pick a date range and submit. The backtester reuses cached GEX from S12 if it ran for the same day; otherwise it computes GEX once per day.

---

## Operator playbook

| Scenario | Action |
|---|---|
| First time enabling | Start in **paper mode**. Leave `enableReclaimEntries=false`, `profitTargetPct=0.50`, `stopLossPct=0.20`. Run for a week. |
| Too few signals | Loosen `wallProximityPct` (e.g. 0.002 → 0.003). Verify GEX is refreshing — check `gex_refresh` events in the activity feed. |
| Signal storm in a chop day | Verify `cooldownMinutes ≥ 15`. The detector emits one signal per 1m tick when a condition holds, so cooldown is what spaces them out. |
| Stuck at gamma zero | Working as intended — `gammaZeroBufferPct` blocks entries near the flip. If price oscillates around the flip all day, no signal. |
| Want to test reclaim | Set `enableReclaimEntries=true` and tighten `minBounceVolumeRatio=1.5`. Watch the `s14_signal` events for `position=reclaim_pw`. |
| Need to stop trading early | Lower `timeExitAt` (e.g. to 14:30). Anything earlier than the second window's start (14:00) effectively disables that window. |

---

## Diagnostics

Activity feed events emitted by S14:

| Event | When | Useful fields |
|---|---|---|
| `gex_refresh` | When the GEX cache is refreshed | `regime`, `call_wall`, `put_wall`, `gamma_flip` |
| `s14_signal` | When a signal is generated | `direction`, `position` (`between_walls`/`above_call_wall`/`below_put_wall`/`reclaim_pw`), `regime`, `call_wall`, `put_wall`, `gamma_flip` |

If S14 is enabled but no signals appear:

1. Check `gex_refresh` is firing — if not, IB Greeks subscription may be missing, and `compute_gex()` is returning `{"error": ...}`.
2. Check the time — outside 10:00–11:30 ET and 14:00–15:00 ET, no signals fire by design.
3. Check spot vs flip — if price is hovering near the flip, `gammaZeroBufferPct` will silently suppress entries.

---

## Out of scope (intentionally — MVP)

These were considered and deferred. If you want to add them, the natural insertion points are noted.

| Feature | Why deferred | Where it would go |
|---|---|---|
| Partial exits (T1 +50% sell half, T2 +100% close rest) | Requires position-management refactor in the auto-trader (~`auto_trader.py:2110`, `:2366`, `:2509`). |
| VIX-based sizing (half size > 20, skip > 30) | Would require a VIX quote subscription and a sizing hook. | Pre-multiply `maxPositionSize` in the auto-trader before order placement. |
| Worker-level kill switch (e.g. global VIX > 30) | Belongs above per-strategy logic. | New `_should_emergency_halt()` check in the worker loop. |
| Cross-position emergency exit (SPX crosses Gamma Zero against position) | Spec §6 Step 9. | Position-monitoring loop; check spot vs flip on each tick. |
