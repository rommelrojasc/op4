# Verification Checklist

Use this to confirm the current build is working end-to-end.

## 1) IB Gateway
- [ ] Gateway logged in
- [ ] API enabled
- [ ] Port **4002** (paper)
- [ ] `127.0.0.1` in Trusted IPs

## 2) Redis
```bash
docker-compose up -d redis
```
- [ ] Container running

## 3) Backend
```bash
./start-backend.sh
```
- [ ] `/health` returns `ib_connected: true`

### API quick checks
- [ ] `/api/v1/market-data/historical` returns bars
- [ ] `/api/v1/market-data/options-chain` returns expirations
- [ ] `/api/v1/market-data/finviz-recom-target` returns values

## 4) Frontend
```bash
./start-frontend.sh
```
- [ ] Overview page loads
- [ ] Company page loads from a selected ticker
- [ ] Strategy Analysis button produces markers
- [ ] Options Chain panel opens
- [ ] Orders panel shows cash refresh control

## 5) UI sanity
- [ ] Indicators toggles work
- [ ] Extended-hours toggle works
- [ ] IB status icon reflects connection
- [ ] Favorites group shows in overview
- [ ] Auto Trader panel loads and updates
- [ ] Trading mode badge (paper/live) shows in Auto Trader header
- [ ] "Entry Point Scan" column shows per-symbol color-coded chips when worker runs
- [ ] Symbol chips animate while scanning, turn green on signal
