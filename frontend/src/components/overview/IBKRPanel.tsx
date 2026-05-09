import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Typography,
  IconButton,
  Button,
  Divider,
  Tooltip,
  CircularProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import {
  fetchIbAccountSummary,
  fetchIbPositions,
  fetchIbOrdersHistory,
  closeIbPosition,
} from '@/services/api/marketData';
import { fmtPnl, fmtPrice } from '@/utils/format';

interface Props {
  width: number;
  onResizeStart: () => void;
  onClose: () => void;
}

function PnlCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span style={{ color: '#7c8190' }}>—</span>;
  const color = value >= 0 ? '#39d98a' : '#ff6b6b';
  return <span style={{ color }}>{fmtPnl(value)}</span>;
}

export default function IBKRPanel({ width, onResizeStart, onClose }: Props) {
  const queryClient = useQueryClient();
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const accountQuery = useQuery({
    queryKey: ['ib-account-summary'],
    queryFn: fetchIbAccountSummary,
    refetchInterval: 30000,
  });

  const positionsQuery = useQuery({
    queryKey: ['ib-positions'],
    queryFn: () => fetchIbPositions(),
    refetchInterval: 10000,
  });

  const ordersQuery = useQuery({
    queryKey: ['ib-orders-history'],
    queryFn: () => fetchIbOrdersHistory(60),
    refetchInterval: 15000,
  });

  const positionKey = (pos: { symbol: string; sec_type: string; quantity: number }) =>
    `${pos.symbol}-${pos.sec_type}-${pos.quantity}`;

  const handleClose = async (pos: {
    symbol: string;
    sec_type: string;
    quantity: number;
    exchange?: string | null;
    currency?: string | null;
    expiration?: string | null;
    strike?: number | null;
    right?: string | null;
  }) => {
    const key = positionKey(pos);
    setClosingKey(key);
    setCloseError(null);
    try {
      await closeIbPosition({
        symbol: pos.symbol,
        sec_type: pos.sec_type,
        quantity: pos.quantity,
        exchange: pos.exchange ?? 'SMART',
        currency: pos.currency ?? 'USD',
        expiration: pos.sec_type === 'OPT' ? pos.expiration : undefined,
        strike: pos.sec_type === 'OPT' ? pos.strike : undefined,
        right: pos.sec_type === 'OPT' ? pos.right : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['ib-positions'] });
      queryClient.invalidateQueries({ queryKey: ['ib-orders-history'] });
    } catch (err: any) {
      setCloseError(err?.response?.data?.detail ?? err?.message ?? 'Close failed');
    } finally {
      setClosingKey(null);
    }
  };

  const handleCloseAll = async () => {
    const positions = positionsQuery.data?.positions ?? [];
    if (!positions.length) return;
    setClosingAll(true);
    setCloseError(null);
    for (const pos of positions) {
      try {
        await closeIbPosition({
          symbol: pos.symbol,
          sec_type: pos.sec_type,
          quantity: pos.quantity,
          exchange: pos.exchange ?? 'SMART',
          currency: pos.currency ?? 'USD',
          expiration: pos.sec_type === 'OPT' ? (pos as any).expiration : undefined,
          strike: pos.sec_type === 'OPT' ? (pos as any).strike : undefined,
          right: pos.sec_type === 'OPT' ? (pos as any).right : undefined,
        });
      } catch (err: any) {
        setCloseError(`${pos.symbol}: ${err?.response?.data?.detail ?? err?.message ?? 'failed'}`);
      }
    }
    setClosingAll(false);
    queryClient.invalidateQueries({ queryKey: ['ib-positions'] });
    queryClient.invalidateQueries({ queryKey: ['ib-orders-history'] });
  };

  const account = accountQuery.data;
  const positions = positionsQuery.data?.positions ?? [];
  const orders = ordersQuery.data?.orders ?? [];

  return (
    <Box
      sx={{
        width,
        borderLeft: '1px solid #2b2b43',
        backgroundColor: '#0c111a',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {/* Resize handle */}
      <Box
        onMouseDown={onResizeStart}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 6,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 2,
        }}
      />

      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px 10px 16px',
          borderBottom: '1px solid #1f2533',
          flexShrink: 0,
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600, color: '#e8eaed' }}>
          IBKR Account
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <IconButton
            size="small"
            onClick={() => {
              accountQuery.refetch();
              positionsQuery.refetch();
              ordersQuery.refetch();
            }}
            sx={{ color: '#9aa0a6', padding: 0.5 }}
          >
            <RefreshIcon
              fontSize="inherit"
              sx={{
                animation:
                  accountQuery.isFetching || positionsQuery.isFetching
                    ? 'spin 1s linear infinite'
                    : 'none',
                '@keyframes spin': {
                  '0%': { transform: 'rotate(0deg)' },
                  '100%': { transform: 'rotate(360deg)' },
                },
              }}
            />
          </IconButton>
          <IconButton size="small" onClick={onClose} sx={{ color: '#9aa0a6', padding: 0.5 }}>
            <CloseIcon fontSize="inherit" />
          </IconButton>
        </Box>
      </Box>

      {/* Body */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '12px',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        {/* Account Summary */}
        <Box
          sx={{
            padding: '10px 12px',
            borderRadius: 1,
            border: '1px solid #1f2533',
            backgroundColor: 'rgba(255,255,255,0.02)',
            marginBottom: 2,
          }}
        >
          <Typography sx={{ fontSize: 11, color: '#7c8190', marginBottom: 1 }}>
            Account Summary
          </Typography>
          {accountQuery.isLoading ? (
            <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
          ) : accountQuery.isError ? (
            <Typography sx={{ fontSize: 12, color: '#ff6b6b' }}>Unavailable</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {[
                { label: 'Account', value: account?.account ?? '—' },
                {
                  label: 'Net Liquidation',
                  value:
                    account?.net_liquidation != null
                      ? `${account.currency ?? 'USD'} ${account.net_liquidation.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : '—',
                },
                {
                  label: 'Available Funds',
                  value:
                    account?.available_funds != null
                      ? `${account.currency ?? 'USD'} ${account.available_funds.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : '—',
                },
                {
                  label: 'Total Cash',
                  value:
                    account?.total_cash_value != null
                      ? `${account.currency ?? 'USD'} ${account.total_cash_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : '—',
                },
              ].map(({ label, value }) => (
                <Box
                  key={label}
                  sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}
                >
                  <span style={{ color: '#9aa0a6' }}>{label}</span>
                  <span style={{ color: '#e8eaed', fontWeight: 500 }}>{value}</span>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Divider sx={{ borderColor: '#1f2533', marginBottom: 1.5 }} />

        {/* Positions */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 }}>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Positions{positions.length ? ` (${positions.length})` : ''}
          </Typography>
          {positions.length > 0 && (
            <Button
              size="small"
              variant="outlined"
              color="error"
              disabled={closingAll || !!closingKey}
              onClick={handleCloseAll}
              sx={{ fontSize: 10, textTransform: 'none', paddingX: 1, paddingY: 0.25 }}
            >
              {closingAll ? <CircularProgress size={10} color="error" /> : 'Close All'}
            </Button>
          )}
        </Box>

        {closeError && (
          <Typography sx={{ fontSize: 11, color: '#ff6b6b', marginBottom: 1 }}>
            {closeError}
          </Typography>
        )}

        {positionsQuery.isLoading ? (
          <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
        ) : positions.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No open positions.</Typography>
        ) : (
          positions.map((pos) => {
            const key = positionKey(pos);
            const isClosing = closingKey === key;
            const expiration = (pos as any).expiration;
            const strike = (pos as any).strike;
            const right = (pos as any).right;
            return (
              <Box
                key={key}
                sx={{
                  padding: '8px 10px',
                  borderRadius: 1,
                  border: '1px solid #1f2533',
                  backgroundColor: 'rgba(255,255,255,0.01)',
                  marginBottom: 1,
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Box>
                    <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#e8eaed' }}>
                      {pos.symbol}{' '}
                      <span style={{ fontSize: 10, color: '#7c8190', fontWeight: 400 }}>
                        {pos.sec_type}
                        {right ? ` ${right}` : ''}
                        {strike != null ? ` ${strike}` : ''}
                        {expiration ? ` exp ${expiration}` : ''}
                      </span>
                    </Typography>
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6', marginTop: 0.25 }}>
                      {pos.quantity > 0 ? 'Long' : 'Short'} {Math.abs(pos.quantity)} · avg{' '}
                      {fmtPrice(pos.avg_cost)}
                    </Typography>
                  </Box>
                  <Tooltip title="Close position at market">
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        color="warning"
                        disabled={isClosing || closingAll}
                        onClick={() => handleClose({ ...pos, expiration, strike, right })}
                        sx={{ fontSize: 10, textTransform: 'none', paddingX: 1, paddingY: 0.25, minWidth: 48 }}
                      >
                        {isClosing ? <CircularProgress size={10} color="warning" /> : 'Close'}
                      </Button>
                    </span>
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', gap: 2, marginTop: 0.5, fontSize: 11 }}>
                  <span style={{ color: '#9aa0a6' }}>
                    MV{' '}
                    <strong style={{ color: '#e8eaed' }}>
                      {fmtPrice(pos.market_value)}
                    </strong>
                  </span>
                  <span style={{ color: '#9aa0a6' }}>
                    uP&L <PnlCell value={pos.unrealized_pnl} />
                  </span>
                  <span style={{ color: '#9aa0a6' }}>
                    rP&L <PnlCell value={pos.realized_pnl} />
                  </span>
                </Box>
              </Box>
            );
          })
        )}

        <Divider sx={{ borderColor: '#1f2533', marginY: 1.5 }} />

        {/* Orders History */}
        <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 1 }}>
          Recent Orders
        </Typography>
        {ordersQuery.isLoading ? (
          <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
        ) : orders.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No orders.</Typography>
        ) : (
          orders.map((order, idx) => {
            const statusColor =
              order.status === 'Filled'
                ? '#39d98a'
                : order.status === 'Cancelled'
                ? '#ff6b6b'
                : '#9aa0a6';
            return (
              <Box
                key={`${order.order_id ?? 'o'}-${order.perm_id ?? idx}`}
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: '#9aa0a6',
                  marginBottom: 0.5,
                  paddingBottom: 0.5,
                  borderBottom: '1px solid #151b27',
                }}
              >
                <Box>
                  <span style={{ color: '#e8eaed' }}>{order.symbol ?? '—'}</span>
                  {order.right ? <span> {order.right}</span> : null}
                  {order.strike != null ? <span> {order.strike}</span> : null}
                  {order.expiration ? <span> {order.expiration}</span> : null}
                  <span style={{ color: order.action === 'BUY' ? '#39d98a' : '#f5a623' }}>
                    {' '}{order.action ?? ''}
                  </span>
                  <span> {order.quantity ?? ''}</span>
                  {order.order_type ? <span style={{ color: '#6b7280' }}> {order.order_type}</span> : null}
                </Box>
                <Box sx={{ textAlign: 'right', flexShrink: 0, paddingLeft: 1 }}>
                  <span style={{ color: statusColor }}>{order.status ?? '—'}</span>
                  {order.avg_fill_price ? (
                    <span style={{ color: '#7c8190' }}> · {order.avg_fill_price}</span>
                  ) : null}
                  {order.timestamp ? (
                    <div style={{ fontSize: 10, color: '#6b7280' }}>
                      {new Date(order.timestamp * 1000).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'America/New_York',
                      })}
                    </div>
                  ) : null}
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
