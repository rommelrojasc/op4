# Quick Start

Get the app running quickly with IB Gateway paper trading.

## Prerequisites

- IB Gateway (paper trading) on **4002**
- Python 3.11+
- Node.js 18+
- Docker Desktop

## 1) Start Redis

```bash
docker-compose up -d redis
```

## 2) Start Backend

```bash
./start-backend.sh
```

Expected log:
```
Connected to IB Gateway at 127.0.0.1:4002
```

## 3) Start Frontend

```bash
./start-frontend.sh
```

Open: http://localhost:3000

## Verify

- `curl http://localhost:8000/health`
- Overview page loads with company grid
- Select a ticker → company page shows chart

## Tips

- Backend env is `backend/.env` (not root)
- Options data may be empty outside market hours
- Use the IB status dot in the header to confirm connectivity
- Account cash refresh is on-demand from the Orders panel
- Auto Trader defaults to **paper mode** (port 4002); switch to live via the mode button
- The "Entry Point Scan" column shows per-symbol scan status in real time while the worker runs
- Live mode requires IB Gateway on port **4001** and a live account configured in `backend/.env`
