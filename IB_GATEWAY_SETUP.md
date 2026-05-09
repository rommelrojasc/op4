# IB Gateway Setup (Paper Trading)

## Enable API

1. Open **IB Gateway**
2. Gear icon → **Global Configuration** → **API** → **Settings**
3. Enable API / Socket Clients (label varies on macOS)
4. Set **Socket Port** to:
   - Paper: **4002**
   - Live: **4001**
5. Add **127.0.0.1** to Trusted IPs
6. Optional: **Read-Only API** and **Create API message log file**
7. Restart IB Gateway

## Verify Port

```bash
nc -zv 127.0.0.1 4002
```

## Backend Settings

- Edit `backend/.env`
- Ensure `IB_PORT=4002`
- If connection errors persist, change `IB_CLIENT_ID`

## Notes on Market Data

- Options data requires proper entitlements (OPRA for US options)
- Outside market hours, bid/ask/last may be empty
- For paper trading, ensure your paper account has the same subscriptions

