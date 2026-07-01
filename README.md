# OP3 Trading Platform

A TradingView-style web app for options-focused analysis using Interactive Brokers (IB) data.

## Highlights

- **Multi-interval charting** (1D, 1H, 15M, 5M, 1M)
- **Indicator toggles** (MAs 20/40/100/200, Bollinger, VWAP, Volume, Worden Stochastic)
- **11 Trading Strategies:**
  - Strategies 1-5: Mean reversion, gap fades, multi-touch reversals
  - CT15: Extended hours trading
  - **Strategies 7-10: 0DTE (same-day expiration)** - Scalper, Momentum Rider, Gap Fade Enhanced, Trend Following
- **Strategy Settings UI** with configurable parameters and defaults
- **Target-bar analysis mode** (evaluate a single bar across strategies)
- **Overview page** with grouped tickers, favorites, compact mode, and per-group scan controls
- **Options Chain panel** (expirations + strikes, LTP/OI view)
- **Finviz analyst recommendation** + target price (cached)
- **IB Gateway status indicator** (frontend)
- **Auto Trader worker** (paper/live) with activity feed + Orders panel
- **Mobile-responsive UI** for trading on the go
- **Per-position TP overrides** and trailing stops
- **Position history** with detailed trade logs

## Architecture

- **Frontend**: React 18 + TypeScript + Vite + MUI + lightweight-charts
- **Backend**: FastAPI + ib-insync
- **Data**: IB Gateway + Redis (for cached Finviz data)

## Prerequisites

1. **IB Gateway** (paper trading recommended)
   - Paper port: **4002**
   - Live port: **4001**
2. **Python 3.11+**
3. **Node.js 18+**
4. **Docker Desktop** (for Redis)

## Setup

### 1) Start Redis

```bash
docker-compose up -d redis
```

### 2) Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.main
```

Backend: http://localhost:8000
Docs: http://localhost:8000/docs

### 3) Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Frontend: http://localhost:3000

## Core UI

### Overview Page
- **Grouped ticker grid** (Bloques)
- **Favorites group** at the top
- Per-group **Check Strategies** and **Check Options** controls
- **CT15 scan** + global scan controls
- **Compact view** toggle (ticker + price only)
- **Option range** (nearest strike for next Friday) + Optimal range (static)
- **Auto Trader panel:**
  - Start/Stop controls
  - **Strategy Settings tab** - Configure all 11 strategies with defaults and reset
  - **Ticker selection** - Choose which tickers can use 0DTE strategies
  - Activity feed with real-time events
  - Trading mode switcher (paper/live)
- **Orders panel:**
  - Open/closed positions with P&L
  - Position history modal
  - Per-position TP overrides
  - Custom TP settings
  - Cash refresh

### Company Page
- Interval toggle: **1D / 1H / 15M / 1M**
- Indicators dropdown (MAs, Bollinger, VWAP, Volume, Worden Stoch)
- Strategy Analysis button + target-bar mode
- Right-side Strategy Panel with reasons, debug, post-entry outcomes
- Options Chain side panel
- Finviz recom + target price
- Favorite (star) toggle

## Data Sources & Notes

- **IB Gateway** provides historical bars and live market data (entitlements apply).
- **Options data** (bid/ask/last/OI/IV) can be missing outside market hours or without the right subscriptions.
- **Finviz data** is scraped and cached in Redis (monthly refresh).
- **Account summary** is cached via an IB account summary subscription (cash refresh is on-demand in UI).
- **No real-time streaming** (no WebSockets); data is fetched on demand.
- Local data files live in `backend/data/` (gitignored).

## Trading Strategies

### Standard Strategies (1-5 + CT15)
- **Strategy 1:** Intraday Mean Reversion (Bollinger Bands + Stochastic)
- **Strategy 2:** Daily Trend Reversal (Multi-timeframe)
- **Strategy 3:** Opening Gap Fade
- **Strategy 4:** Multi-Touch Reversal
- **Strategy 5:** Gap Fade with Flat Confirmation
- **CT15:** Extended Hours Trading

### 0DTE Strategies (7-10) - Same-Day Expiration
- **Strategy 7:** 0DTE Scalper (1m bars, 10% target, 5min hold)
- **Strategy 8:** 0DTE Momentum Rider (1m+5m bars, 50% target, trailing stop)
- **Strategy 9:** 0DTE Gap Fade Enhanced (gap reversal, 20% target)
- **Strategy 10:** 0DTE Trend Following (1m+2m bars, 75% target)

**0DTE Safety Features:**
- Auto-close all positions by 15:45 ET (15 min before expiration)
- Configurable ticker selection (default: SPX only)
- Aggressive position sizing: $500-1000 per trade
- Time-windowed entries (9:30-15:45 ET)

See `docs/strategies.md` for detailed documentation.

## API Endpoints

Base: `/api/v1`

- `GET /market-data/historical` (symbol, interval, bars_count, use_rth, con_id, sec_type, exchange, currency)
- `GET /market-data/timeframes`
- `GET /market-data/validate-symbol`
- `GET /market-data/search-symbols`
- `GET /market-data/options-chain`
- `GET /market-data/options-quotes`
- `GET /market-data/finviz-recom-target`
- `GET /market-data/strategy-report` (mode=paper|live)
- `GET /market-data/trading/account-summary`
- `GET /market-data/trading/orders`
- `GET /market-data/trading/positions`
- `GET /market-data/trading/worker/status`
- `GET /market-data/trading/worker/events`
- `GET/POST /market-data/trading/worker/settings`
- `GET/POST/DELETE /market-data/position-tp-overrides`
- `GET /health`

## Troubleshooting

### IB connection issues
- Ensure IB Gateway is fully logged in
- Confirm port **4002** (paper) in `backend/.env`
- Ensure `127.0.0.1` is in Trusted IPs
- Try changing `IB_CLIENT_ID`

### Options data is empty
- IB entitlements may be missing (OPRA required for US options)
- Outside market hours, bid/ask/last may be unavailable

### Blank page / console errors
- Check frontend console and backend logs
- Ensure API endpoints are reachable at http://localhost:8000

## License

MIT
