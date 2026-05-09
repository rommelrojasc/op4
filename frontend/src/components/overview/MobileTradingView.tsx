/**
 * Mobile-optimized trading view
 * Full-featured interface for monitoring and controlling the auto-trader on iPhone
 */
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Typography,
  IconButton,
  Stack,
  Tabs,
  Tab,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import {
  fetchAutoTraderStatus,
  fetchAutoTraderSettings,
  fetchAutoTraderEvents,
  fetchOrders,
  fetchOrdersSummary,
  fetchIbPositions,
  fetchIbAccountSummary,
  fetchTradingMode,
  startAutoTrader,
  stopAutoTrader,
  resetCapitalSpent,
  flushTrackedPosition,
  closeIbPosition,
  closeAllIbPositions,
  switchTradingMode,
} from '@/services/api/marketData';
import { fmtMoney, fmtPnl } from '@/utils/format';

export function MobileTradingView() {
  const queryClient = useQueryClient();
  const [actionBusy, setActionBusy] = useState(false);
  const [selectedTab, setSelectedTab] = useState<'open' | 'closed' | 'ibkr' | 'feed'>('open');
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; action: () => void } | null>(null);
  const [closedFromDate, setClosedFromDate] = useState<string | null>(() => {
    const now = new Date();
    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return ny.toISOString().slice(0, 10);
  });

  // Queries
  const statusQuery = useQuery({
    queryKey: ['autoTraderStatus'],
    queryFn: fetchAutoTraderStatus,
    refetchInterval: 3000,
    retry: 2,
    staleTime: 2000,
  });

  const ordersQuery = useQuery({
    queryKey: ['orders-log'],
    queryFn: () => fetchOrders(400),
    refetchInterval: 5000,
    retry: 2,
    staleTime: 4000,
  });

  const ibPositionsQuery = useQuery({
    queryKey: ['ib-positions'],
    queryFn: () => fetchIbPositions(false),
    refetchInterval: 5000,
    retry: 2,
    staleTime: 4000,
  });

  const ibAccountQuery = useQuery({
    queryKey: ['ib-account'],
    queryFn: fetchIbAccountSummary,
    refetchInterval: 15000,
    retry: 2,
    staleTime: 10000,
  });

  const settingsQuery = useQuery({
    queryKey: ['autoTraderSettings'],
    queryFn: fetchAutoTraderSettings,
    staleTime: 30000,
  });

  const summaryQuery = useQuery({
    queryKey: ['ordersSummary'],
    queryFn: () => fetchOrdersSummary(),
    refetchInterval: 10000,
    retry: 2,
    staleTime: 8000,
  });

  const tradingModeQuery = useQuery({
    queryKey: ['tradingMode'],
    queryFn: fetchTradingMode,
    refetchInterval: 30000,
    staleTime: 10000,
  });

  const eventsQuery = useQuery({
    queryKey: ['autoTraderEvents'],
    queryFn: () => fetchAutoTraderEvents(200),
    refetchInterval: 5000,
    retry: 2,
    staleTime: 3000,
  });

  const status = statusQuery.data;
  const orders = ordersQuery.data;
  const ibPositions = ibPositionsQuery.data?.positions ?? [];
  const summary = summaryQuery.data;
  const currentMode = tradingModeQuery.data?.mode ?? 'paper';

  // Filter positions by mode
  const openPositions = useMemo(
    () => (orders?.open_positions ?? []).filter(
      (o: any) => !o.mode || o.mode === currentMode
    ),
    [orders?.open_positions, currentMode],
  );

  // Actions
  async function handleStart() {
    setActionBusy(true);
    try {
      await startAutoTrader();
      queryClient.invalidateQueries({ queryKey: ['autoTraderStatus'] });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleStop() {
    setActionBusy(true);
    try {
      await stopAutoTrader();
      queryClient.invalidateQueries({ queryKey: ['autoTraderStatus'] });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSwitchMode() {
    const newMode = currentMode === 'live' ? 'paper' : 'live';
    const isRunning = status?.running ?? false;
    if (isRunning) {
      setConfirmDialog({
        title: 'Stop Required',
        message: 'Stop the auto trader before switching modes.',
        action: () => {},
      });
      return;
    }
    setConfirmDialog({
      title: `Switch to ${newMode.toUpperCase()}?`,
      message: newMode === 'live'
        ? 'This will trade with real money on your live IBKR account.'
        : 'This will switch to paper trading mode.',
      action: async () => {
        setActionBusy(true);
        try {
          await switchTradingMode(newMode);
          queryClient.invalidateQueries();
        } finally {
          setActionBusy(false);
        }
      },
    });
  }

  function handleRefresh() {
    queryClient.invalidateQueries();
  }

  async function handleFlushPosition(positionId: string) {
    setConfirmDialog({
      title: 'Flush Position',
      message: `Remove ${positionId} from tracking? (Does not close the position on IBKR)`,
      action: async () => {
        await flushTrackedPosition(positionId);
        queryClient.invalidateQueries({ queryKey: ['orders-log'] });
      },
    });
  }

  async function handleCloseIbPosition(pos: any) {
    setConfirmDialog({
      title: 'Close IBKR Position',
      message: `Close ${pos.symbol} ${pos.right || ''} ${pos.strike || ''} (${pos.quantity} contracts) at market?`,
      action: async () => {
        await closeIbPosition({
          symbol: pos.symbol,
          sec_type: pos.sec_type || 'OPT',
          right: pos.right,
          strike: pos.strike,
          expiration: pos.expiration,
          quantity: Math.abs(pos.quantity),
        });
        queryClient.invalidateQueries();
      },
    });
  }

  async function handleCloseAllIbPositions() {
    setConfirmDialog({
      title: 'Close ALL IBKR Positions',
      message: `Close all ${ibPositions.length} positions at market?`,
      action: async () => {
        await closeAllIbPositions();
        queryClient.invalidateQueries();
      },
    });
  }

  async function handleResetCapital() {
    await resetCapitalSpent();
    queryClient.invalidateQueries({ queryKey: ['autoTraderStatus'] });
  }

  const isRunning = status?.running ?? false;
  const totalPnl = summary?.total_pnl ?? 0;
  const capitalSpent = status?.capital_spent ?? 0;
  const capitalLimit = (settingsQuery.data?.settings as any)?.capitalLimit ?? 0;

  return (
    <Box sx={{ height: '100dvh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f1117' }}>
      {/* Sticky Header */}
      <Box sx={{
        p: 1.5,
        borderBottom: '1px solid #1f2533',
        backgroundColor: '#16162a',
        flexShrink: 0,
      }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Chip
              label={currentMode}
              size="small"
              onClick={handleSwitchMode}
              sx={{
                height: 24, fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                backgroundColor: currentMode === 'live' ? 'rgba(239,83,80,0.2)' : 'rgba(121,134,203,0.2)',
                color: currentMode === 'live' ? '#ef5350' : '#7986cb',
                border: `1px solid ${currentMode === 'live' ? 'rgba(239,83,80,0.5)' : 'rgba(121,134,203,0.4)'}`,
              }}
            />
            <Box sx={{
              width: 8, height: 8, borderRadius: '50%',
              backgroundColor: isRunning ? '#39d98a' : '#787b86',
              animation: isRunning ? 'pulse 2s infinite' : 'none',
              '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.4 } },
            }} />
            <Typography sx={{ fontSize: 13, fontWeight: 600, color: isRunning ? '#39d98a' : '#787b86' }}>
              {isRunning ? 'Running' : 'Stopped'}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5}>
            <IconButton onClick={handleRefresh} size="small" sx={{ color: '#787b86' }}>
              <RefreshIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Stack>
        </Stack>

        {/* Start/Stop Button */}
        <Button
          fullWidth
          size="small"
          onClick={isRunning ? handleStop : handleStart}
          disabled={actionBusy}
          startIcon={actionBusy ? <CircularProgress size={14} /> : isRunning ? <StopIcon /> : <PlayArrowIcon />}
          sx={{
            mt: 1, py: 0.75, fontSize: 13, fontWeight: 600, textTransform: 'none',
            borderRadius: 1.5,
            backgroundColor: isRunning ? 'rgba(239,83,80,0.15)' : 'rgba(57,217,138,0.15)',
            color: isRunning ? '#ef5350' : '#39d98a',
            border: `1px solid ${isRunning ? 'rgba(239,83,80,0.3)' : 'rgba(57,217,138,0.3)'}`,
            '&:active': { backgroundColor: isRunning ? 'rgba(239,83,80,0.3)' : 'rgba(57,217,138,0.3)' },
          }}
        >
          {isRunning ? 'Stop' : 'Start'}
        </Button>
      </Box>

      {/* Current Activity Alert */}
      {isRunning && status?.current_symbol && (
        <Box sx={{ px: 1.5, py: 1, backgroundColor: 'rgba(41,98,255,0.08)', borderBottom: '1px solid #1f2533' }}>
          <Typography sx={{ fontSize: 12, color: '#5b8def' }}>
            <strong>{status.current_stage || 'Scanning'}</strong> {status.current_symbol}
            {status.current_index != null && status.current_total != null && (
              <span style={{ color: '#787b86', marginLeft: 4 }}>
                ({status.current_index + 1}/{status.current_total})
              </span>
            )}
          </Typography>
        </Box>
      )}

      {/* Stats Row */}
      <Box sx={{ display: 'flex', gap: 1, p: 1.5, borderBottom: '1px solid #1f2533', flexShrink: 0 }}>
        <Box sx={{ flex: 1, backgroundColor: '#1a1d28', borderRadius: 1.5, p: 1.25, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.5 }}>P&L</Typography>
          <Typography sx={{ fontSize: 18, fontWeight: 700, color: totalPnl >= 0 ? '#39d98a' : '#ef5350', mt: 0.25 }}>
            {fmtPnl(totalPnl)}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, backgroundColor: '#1a1d28', borderRadius: 1.5, p: 1.25, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.5 }}>Open</Typography>
          <Typography sx={{ fontSize: 18, fontWeight: 700, mt: 0.25 }}>{openPositions.length}</Typography>
        </Box>
        <Box
          onClick={handleResetCapital}
          sx={{ flex: 1, backgroundColor: '#1a1d28', borderRadius: 1.5, p: 1.25, textAlign: 'center', cursor: 'pointer' }}
        >
          <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.5 }}>Capital</Typography>
          <Typography sx={{ fontSize: 14, fontWeight: 700, mt: 0.25 }}>
            {fmtMoney(capitalSpent)}
            <span style={{ color: '#787b86', fontSize: 11 }}> / {fmtMoney(capitalLimit)}</span>
          </Typography>
        </Box>
        {ibAccountQuery.data && (
          <Box sx={{ flex: 1, backgroundColor: '#1a1d28', borderRadius: 1.5, p: 1.25, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.5 }}>Funds</Typography>
            <Typography sx={{ fontSize: 14, fontWeight: 700, mt: 0.25 }}>
              {fmtMoney(ibAccountQuery.data.available_funds ?? 0)}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Tabs */}
      <Tabs
        value={selectedTab}
        onChange={(_, v) => setSelectedTab(v)}
        variant="fullWidth"
        sx={{
          minHeight: 36, flexShrink: 0,
          borderBottom: '1px solid #1f2533',
          '& .MuiTab-root': { minHeight: 36, fontSize: 12, fontWeight: 600, textTransform: 'none', py: 0.5, color: '#787b86' },
          '& .Mui-selected': { color: '#d1d4dc !important' },
          '& .MuiTabs-indicator': { backgroundColor: '#2962ff' },
        }}
      >
        <Tab label={`Open (${openPositions.length})`} value="open" />
        <Tab label="Closed" value="closed" />
        <Tab label={`IBKR (${ibPositions.length})`} value="ibkr" />
        <Tab label="Feed" value="feed" />
      </Tabs>

      {/* Scrollable Content */}
      <Box sx={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', p: 1.5 }}>

        {/* ═══ OPEN POSITIONS ═══ */}
        {selectedTab === 'open' && (
          <>
            {openPositions.length === 0 ? (
              <Box sx={{ py: 6, textAlign: 'center', color: '#787b86' }}>
                <Typography sx={{ fontSize: 13 }}>No open positions</Typography>
              </Box>
            ) : (
              openPositions.slice().sort((a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).map((pos: any, idx: number) => {
                const ibPos = ibPositions.find(
                  (p: any) => p.symbol === pos.symbol && p.right === pos.right && p.strike === pos.strike
                );
                const entryPrice = pos.price ?? 0;
                const currentPrice = ibPos?.market_price ?? null;
                const pnl = currentPrice != null ? (currentPrice - entryPrice) * (pos.quantity ?? 1) * 100 : null;
                const pnlPct = currentPrice != null && entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
                const holdMin = pos.timestamp ? Math.floor((Date.now() / 1000 - pos.timestamp) / 60) : 0;
                const holdStr = holdMin >= 60 ? `${Math.floor(holdMin / 60)}h ${holdMin % 60}m` : `${holdMin}m`;
                const hwm = pos.high_water_mark ?? 0;
                const tp = pos.target_price ?? 0;
                const isTrailing = hwm >= tp && tp > 0;

                return (
                  <Box key={idx} sx={{
                    mb: 1, p: 1.25, borderRadius: 1.5,
                    backgroundColor: '#1a1d28', border: '1px solid #1f2533',
                  }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                          {pos.symbol}
                          <span style={{ color: pos.right === 'C' ? '#4fc3f7' : '#ff8a80', fontWeight: 700, marginLeft: 4 }}>
                            {pos.right}
                          </span>
                          <span style={{ marginLeft: 4 }}>{pos.strike}</span>
                        </Typography>
                        {isTrailing && (
                          <Chip label="Trail" size="small" sx={{ height: 16, fontSize: 9, fontWeight: 600, backgroundColor: 'rgba(57,217,138,0.15)', color: '#39d98a' }} />
                        )}
                      </Stack>
                      {pnl !== null && (
                        <Typography sx={{ fontSize: 14, fontWeight: 700, color: pnl >= 0 ? '#39d98a' : '#ef5350' }}>
                          {fmtPnl(pnl)}
                          {pnlPct !== null && <span style={{ fontSize: 11, marginLeft: 3 }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</span>}
                        </Typography>
                      )}
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
                      <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                        Entry ${entryPrice.toFixed(2)} · Qty {pos.quantity ?? 1} · {holdStr}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                        {currentPrice != null && `Now $${currentPrice.toFixed(2)} · `}TP ${tp.toFixed(2)}
                      </Typography>
                    </Stack>
                    {hwm > 0 && (
                      <Typography sx={{ fontSize: 10, color: '#5b5e6b', mt: 0.25 }}>
                        HWM ${hwm.toFixed(2)} · {pos.expiration}
                      </Typography>
                    )}
                    <Button
                      size="small"
                      onClick={() => handleFlushPosition(pos.position_id)}
                      sx={{ mt: 0.75, fontSize: 10, color: '#ef5350', textTransform: 'none', p: 0, minWidth: 0 }}
                    >
                      Flush
                    </Button>
                  </Box>
                );
              })
            )}
          </>
        )}

        {/* ═══ CLOSED POSITIONS ═══ */}
        {selectedTab === 'closed' && (() => {
          const allOrders = orders?.orders ?? [];
          const openTsByPid: Record<string, number> = {};
          for (const e of allOrders) {
            if (e.type === 'OPEN' && e.position_id && e.timestamp) openTsByPid[e.position_id] = e.timestamp;
          }
          const allClosed = allOrders.filter((o: any) => o.type === 'CLOSE' && (!o.mode || o.mode === currentMode));
          const filtered = closedFromDate
            ? allClosed.filter((o: any) => {
                const openTs = o.position_id ? openTsByPid[o.position_id] : null;
                const ts = openTs ?? o.timestamp;
                if (!ts) return false;
                const nyDate = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
                return nyDate >= closedFromDate;
              })
            : allClosed;
          const sorted = filtered.slice().sort((a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 50);
          const totalPnlFiltered = filtered.reduce((acc: number, o: any) => acc + (o.pnl ?? 0), 0);

          return (
            <>
              {/* Date filter */}
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1.5 }}>
                <Chip
                  label="All"
                  size="small"
                  onClick={() => setClosedFromDate(null)}
                  sx={{
                    height: 24, fontSize: 11, fontWeight: 600,
                    backgroundColor: closedFromDate === null ? 'rgba(41,98,255,0.2)' : 'transparent',
                    color: closedFromDate === null ? '#2962ff' : '#787b86',
                    border: closedFromDate === null ? '1px solid rgba(41,98,255,0.4)' : '1px solid #2b2b43',
                  }}
                />
                <input
                  type="date"
                  value={closedFromDate ?? ''}
                  onChange={(e) => setClosedFromDate(e.target.value || null)}
                  style={{
                    height: 24, fontSize: 11, fontWeight: 600, padding: '0 8px',
                    border: closedFromDate ? '1px solid rgba(41,98,255,0.4)' : '1px solid #2b2b43',
                    borderRadius: 12, backgroundColor: closedFromDate ? 'rgba(41,98,255,0.2)' : 'transparent',
                    color: closedFromDate ? '#2962ff' : '#787b86', outline: 'none', colorScheme: 'dark',
                  }}
                />
                <Typography sx={{ fontSize: 12, color: '#787b86', ml: 'auto' }}>
                  {filtered.length} trades · <span style={{ color: totalPnlFiltered >= 0 ? '#39d98a' : '#ef5350', fontWeight: 600 }}>{fmtPnl(totalPnlFiltered)}</span>
                </Typography>
              </Stack>

              {sorted.length === 0 ? (
                <Box sx={{ py: 6, textAlign: 'center', color: '#787b86' }}>
                  <Typography sx={{ fontSize: 13 }}>No closed positions</Typography>
                </Box>
              ) : (
                sorted.map((order: any, idx: number) => {
                  const openTs = order.position_id ? openTsByPid[order.position_id] : null;
                  const holdMin = openTs && order.timestamp ? Math.floor((order.timestamp - openTs) / 60) : null;
                  const holdStr = holdMin != null ? (holdMin >= 60 ? `${Math.floor(holdMin / 60)}h ${holdMin % 60}m` : `${holdMin}m`) : null;
                  const pnl = order.pnl ?? 0;
                  const pnlPct = order.pnl_pct ?? 0;

                  return (
                    <Box key={idx} sx={{
                      mb: 1, p: 1.25, borderRadius: 1.5,
                      backgroundColor: '#1a1d28', border: '1px solid #1f2533',
                    }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                          {order.symbol}
                          <span style={{ color: order.right === 'C' ? '#4fc3f7' : '#ff8a80', fontWeight: 700, marginLeft: 4 }}>
                            {order.right}
                          </span>
                          <span style={{ marginLeft: 4 }}>{order.strike}</span>
                        </Typography>
                        <Typography sx={{ fontSize: 14, fontWeight: 700, color: pnl >= 0 ? '#39d98a' : '#ef5350' }}>
                          {fmtPnl(pnl)}
                          <span style={{ fontSize: 11, marginLeft: 3 }}>({(pnlPct * 100).toFixed(1)}%)</span>
                        </Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
                        <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                          {order.strategy_id?.replace('strategy', 's').replace('_0dte_trend', '10').replace('_ict_price_action', '11') ?? '—'}
                          {' · '}{order.action} {order.quantity} @ ${order.price?.toFixed(2)}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                          {order.timestamp && new Date(order.timestamp * 1000).toLocaleTimeString('en-US', {
                            hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
                          })}
                          {holdStr && ` · ${holdStr}`}
                        </Typography>
                      </Stack>
                      {order.close_reason && (
                        <Typography sx={{ fontSize: 10, color: '#5b5e6b', mt: 0.25 }}>{order.close_reason}</Typography>
                      )}
                    </Box>
                  );
                })
              )}
            </>
          );
        })()}

        {/* ═══ IBKR POSITIONS ═══ */}
        {selectedTab === 'ibkr' && (
          <>
            {/* Account summary */}
            {ibAccountQuery.data && (
              <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 1.5, backgroundColor: '#1a1d28', border: '1px solid #1f2533' }}>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography sx={{ fontSize: 11, color: '#787b86' }}>Account</Typography>
                  <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{ibAccountQuery.data.account}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography sx={{ fontSize: 11, color: '#787b86' }}>Available Funds</Typography>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#39d98a' }}>{fmtMoney(ibAccountQuery.data.available_funds ?? 0)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography sx={{ fontSize: 11, color: '#787b86' }}>Net Liquidation</Typography>
                  <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{fmtMoney(ibAccountQuery.data.net_liquidation ?? 0)}</Typography>
                </Stack>
              </Box>
            )}

            {ibPositions.length > 0 && (
              <Button
                fullWidth size="small"
                onClick={handleCloseAllIbPositions}
                sx={{ mb: 1.5, fontSize: 11, color: '#ef5350', border: '1px solid rgba(239,83,80,0.3)', textTransform: 'none' }}
              >
                Close All ({ibPositions.length})
              </Button>
            )}

            {ibPositions.length === 0 ? (
              <Box sx={{ py: 6, textAlign: 'center', color: '#787b86' }}>
                <Typography sx={{ fontSize: 13 }}>No IBKR positions</Typography>
              </Box>
            ) : (
              ibPositions.slice().sort((a: any, b: any) => {
                if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
                return (a.expiration || '').localeCompare(b.expiration || '');
              }).map((pos: any, idx: number) => {
                const pnl = pos.unrealized_pnl ?? 0;
                const pnlPct = pos.pnl_pct ?? 0;

                return (
                  <Box key={idx} sx={{
                    mb: 1, p: 1.25, borderRadius: 1.5,
                    backgroundColor: '#1a1d28', border: '1px solid #1f2533',
                  }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                        {pos.symbol}
                        {pos.right && <span style={{ color: pos.right === 'C' ? '#4fc3f7' : '#ff8a80', fontWeight: 700, marginLeft: 4 }}>{pos.right}</span>}
                        {pos.strike && <span style={{ marginLeft: 4 }}>{pos.strike}</span>}
                      </Typography>
                      <Typography sx={{ fontSize: 14, fontWeight: 700, color: pnl >= 0 ? '#39d98a' : '#ef5350' }}>
                        {fmtPnl(pnl)}
                        {pnlPct !== 0 && <span style={{ fontSize: 11, marginLeft: 3 }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</span>}
                      </Typography>
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
                      <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                        Qty {pos.quantity} · Avg {fmtMoney(pos.avg_cost)} · Last {fmtMoney(pos.market_price)}
                      </Typography>
                      {pos.expiration && (
                        <Typography sx={{ fontSize: 11, color: '#787b86' }}>
                          {pos.expiration}{pos.days_to_expiry != null && ` (${pos.days_to_expiry}d)`}
                        </Typography>
                      )}
                    </Stack>
                    <Button
                      size="small"
                      onClick={() => handleCloseIbPosition(pos)}
                      sx={{ mt: 0.75, fontSize: 10, color: '#ef5350', textTransform: 'none', p: 0, minWidth: 0 }}
                    >
                      Close at Market
                    </Button>
                  </Box>
                );
              })
            )}
          </>
        )}

        {/* ═══ ACTIVITY FEED ═══ */}
        {selectedTab === 'feed' && (() => {
          const events = eventsQuery.data?.events ?? [];
          const recentEvents = events.slice(-100).reverse();
          const typeColors: Record<string, string> = {
            trade_open: '#39d98a', trade_close: '#ef5350',
            order_submitted: '#5b8def', order_request: '#5b8def',
            signal_skipped: '#f5a623', signal_stage: '#787b86',
            position_check: '#3d3f4a',
          };

          // Filter out noisy position_check events
          const filtered = recentEvents.filter((e: any) => e.type !== 'position_check');

          return filtered.length === 0 ? (
            <Box sx={{ py: 6, textAlign: 'center', color: '#787b86' }}>
              <Typography sx={{ fontSize: 13 }}>No activity yet</Typography>
            </Box>
          ) : (
            filtered.slice(0, 50).map((event: any, idx: number) => (
              <Box key={idx} sx={{ mb: 0.75, p: 1, borderRadius: 1, backgroundColor: '#1a1d28', borderLeft: `3px solid ${typeColors[event.type] ?? '#3d3f4a'}` }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography sx={{ fontSize: 11, fontWeight: 600, color: typeColors[event.type] ?? '#787b86' }}>
                    {event.type?.replace(/_/g, ' ')}
                  </Typography>
                  {event.timestamp && (
                    <Typography sx={{ fontSize: 10, color: '#5b5e6b' }}>
                      {new Date(event.timestamp * 1000).toLocaleTimeString('en-US', {
                        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York',
                      })}
                    </Typography>
                  )}
                </Stack>
                <Typography sx={{ fontSize: 11, color: '#9aa0a6', mt: 0.25 }}>
                  {event.message?.substring(0, 120)}
                </Typography>
              </Box>
            ))
          );
        })()}
      </Box>

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmDialog !== null}
        onClose={() => setConfirmDialog(null)}
        PaperProps={{ sx: { backgroundColor: '#1a1d28', border: '1px solid #2b2b43', borderRadius: 2, m: 2, width: '100%' } }}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pb: 1 }}>{confirmDialog?.title}</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13, color: '#9aa0a6' }}>{confirmDialog?.message}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmDialog(null)} sx={{ color: '#787b86', textTransform: 'none' }}>Cancel</Button>
          <Button
            onClick={async () => {
              await confirmDialog?.action();
              setConfirmDialog(null);
            }}
            variant="contained"
            sx={{ textTransform: 'none', backgroundColor: '#2962ff' }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
