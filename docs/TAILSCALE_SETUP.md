# Tailscale Remote Access Setup

This guide explains how to access the trading platform remotely via Tailscale.

## Configuration Summary

**Tailscale IP:** `100.77.82.104`

### Backend Configuration

✅ **Server binding:** Already configured to listen on `0.0.0.0` (all network interfaces)
✅ **CORS origins:** Updated to accept connections from Tailscale IP
✅ **Port:** 8000

**File:** `backend/.env`
```
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:5173,http://100.77.82.104:3000,http://100.77.82.104:8000
```

### Frontend Configuration

✅ **Server binding:** Configured to listen on `0.0.0.0` (all network interfaces)
✅ **Port:** 3000

**File:** `frontend/vite.config.ts`
```typescript
server: {
  host: '0.0.0.0', // Listen on all network interfaces
  port: 3000,
  // ...
}
```

## Starting the Servers

### Backend (Terminal 1)
```bash
cd backend
source venv/bin/activate  # or: . venv/bin/activate
python -m app.main
```

The backend will be accessible at:
- Local: `http://localhost:8000`
- Tailscale: `http://100.77.82.104:8000`

### Frontend (Terminal 2)
```bash
cd frontend
npm run dev
```

The frontend will be accessible at:
- Local: `http://localhost:3000`
- Tailscale: `http://100.77.82.104:3000`

## Mobile Access

### From Your Phone (via Tailscale app)

1. Install the Tailscale app on your phone
2. Sign in with the same Tailscale account
3. Open your mobile browser (Safari/Chrome)
4. Navigate to: `http://100.77.82.104:3000`

The mobile-responsive view will automatically activate for viewports < 768px.

### Features Available on Mobile

- ✅ Auto-trader status monitoring
- ✅ Start/Stop auto-trader controls
- ✅ Real-time P&L tracking
- ✅ Open positions monitoring
- ✅ Trading mode indicator (paper/live)
- ✅ Capital spent tracking

## Troubleshooting

### Can't Connect from Mobile

1. **Check Tailscale is running on both devices:**
   - On Mac: Tailscale icon should show in menu bar
   - On phone: Tailscale app should show "Connected"

2. **Verify IP address hasn't changed:**
   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
   ```
   If different from `100.77.82.104`, update `backend/.env` CORS_ORIGINS

3. **Check servers are running:**
   ```bash
   # Backend
   curl http://100.77.82.104:8000/health

   # Frontend
   curl http://100.77.82.104:3000
   ```

4. **Restart servers after config changes:**
   - Changes to `.env` or `vite.config.ts` require server restart

### CORS Errors in Browser Console

If you see CORS errors, ensure the backend `.env` includes your access URL:
```bash
# Check current CORS settings
grep CORS_ORIGINS backend/.env

# Should include your Tailscale IP
```

## Security Notes

- Tailscale creates a private network - only devices on your Tailscale network can access these endpoints
- The server is NOT exposed to the public internet
- Keep your Tailscale account secure with 2FA
- Consider using Tailscale ACLs for additional access control

## Firewall Configuration

macOS may prompt you to allow incoming connections the first time:
- **Backend (Python):** Allow incoming connections on port 8000
- **Frontend (Node):** Allow incoming connections on port 3000

Click "Allow" when prompted.
