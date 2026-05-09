# Implementation Status (Current)

**Last updated**: 2026-02-17

## Core Features

### Charting
- Multi-interval toggle (1D, 1H, 15M, 1M)
- Extended-hours toggle
- Indicators: MAs 20/40/100/200, Bollinger, VWAP, Volume, Worden Stochastic
- Custom styling + overlays

### Strategy Analysis
- Strategy 1–4 + CT15 implemented
- Visible-range analysis + markers
- Target-bar analysis mode
- Right-side panel with reasons, debug, and post-entry outcomes

### Overview Page
- Grouped ticker grid (Bloques)
- Favorites group with same controls as blocks
- Per-group **Check Strategies** and **Check Options**
- CT15 scan + global scan buttons
- Compact view toggle
- Option range (nearest strike for next Friday)
- Optimal range (static)
- Auto Trader panel + Orders panel

### Options
- Options Chain panel (expirations/strikes)
- LTP / OI toggle visualization

### Data & Integrations
- IB Gateway historical data
- Symbol search via IB
- Finviz recom + target price (cached in Redis)
- IB connection status badge in UI
- Account summary cache via IB subscription
- Auto Trader worker (paper and live trading)
- Persistent bar caching to disk (cold-start speedup)

### Auto Trader
- Paper/live mode switching with per-mode account selection
- Account-scoped order placement
- Activity feed / event log (panel renamed to "Entry Point Scan")
- Per-symbol scan results grid: color-coded status chips (pending, scanning, signal, no_signal, skipped, error)
- `scan_results` exposed in worker status API response
- `_in_flight_symbols` cleared on worker stop
- Capital-spent tracking across the trading day

## Known Limitations

- No WebSocket real-time streaming
- Options quotes can be empty outside market hours or without entitlements
- Auto Trader defaults to paper mode; live mode requires explicit switch
