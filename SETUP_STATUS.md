# Setup Status (Current)

This file is a quick checklist for a clean setup.

## Required
- IB Gateway running on **4002** (paper)
- Redis running via Docker
- Backend virtualenv + deps installed
- Frontend deps installed

## Quick Commands

```bash
# Redis
docker-compose up -d redis

# Backend
./start-backend.sh

# Frontend
./start-frontend.sh
```

## Health Check

```bash
curl http://localhost:8000/health
```

Expected:
```json
{"status":"healthy","ib_connected":true}
```

## Notes
- Account summary is pulled via an IB subscription; cash is refreshed on-demand in the Orders panel.
