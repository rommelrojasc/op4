import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Typography,
  IconButton,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  List,
  ListItemButton,
  ListItemText,
  Switch,
  FormControlLabel,
  FormControl,
  InputLabel,
  Select,
  InputAdornment,
  MenuItem,
  Menu,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Slider,
} from '@mui/material';
import optimalRangesData from '@/data/optimalRanges.json';
import { fmtMoney, fmtPnl } from '@/utils/format';
import SettingsIcon from '@mui/icons-material/Settings';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import RefreshIcon from '@mui/icons-material/Refresh';
import RadarIcon from '@mui/icons-material/Radar';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { SYMBOLS } from '@/constants/symbols';
import {
  fetchAutoTraderStatus,
  fetchAutoTraderEvents,
  fetchAutoTraderSettings,
  fetchBacktest,
  saveAutoTraderSettings,
  startAutoTrader,
  stopAutoTrader,
  fetchOrders,


  fetchIbPositions,
  fetchIbOrdersHistory,
  fetchIbAccountSummary,
  fetchIbMetrics,
  resetCapitalSpent,
  flushTrackedPosition,
  closeAllIbPositions,
  closeIbPosition,
  fetchTradingMode,
  fetchPositionTpOverrides,
  setPositionTpOverride,
  deletePositionTpOverride,
} from '@/services/api/marketData';
import { useIsMobile } from '@/hooks/useIsMobile';
import { MobileTradingView } from './MobileTradingView';
import { MiniChart, MiniChartSignal, MiniChartTrade } from './MiniChart';
import PriceRangeBar from './PriceRangeBar';

const SCAN_CATEGORIES = [
  { key: 'signals', label: 'Signals', color: '#81c784', types: new Set(['signals_detected', 'signal_stage', 'signal_skipped', 'signal_error']) },
  { key: 'orders',  label: 'Orders',  color: '#90caf9', types: new Set(['order_submitted', 'order_request', 'order_status', 'order_failed', 'order_fill_timeout', 'limit_order_submitted', 'limit_order_timeout']) },
  { key: 'trades',  label: 'Trades',  color: '#39d98a', types: new Set(['trade_open']) },
  { key: 'scan',    label: 'Scan',    color: '#d4a030', types: new Set(['scan_start', 'scan_complete', 'scan_context', 'worker_start', 'worker_stop']) },
];

const TP_EVENT_TYPES = new Set([
  'position_check', 'trailing_hwm_update', 'trailing_activated', 'trailing_breakeven_blocked',
  'stop_loss_triggered', 'trade_close', 'expiry_close_skipped', 'expiry_close_forced',
  'expiry_close_summary', 'close_positions_disabled', 'close_fill_timeout',
  'close_retry_scheduled', 'max_positions_warning',
]);

// TP events shown by default (exclude noisy position_check)
const TP_HIGHLIGHT_TYPES = new Set([
  'trailing_hwm_update', 'trailing_activated', 'trailing_breakeven_blocked',
  'stop_loss_triggered', 'trade_close', 'expiry_close_skipped', 'expiry_close_forced',
  'expiry_close_summary', 'close_positions_disabled', 'close_fill_timeout',
  'close_retry_scheduled', 'max_positions_warning',
]);

// Strategy metadata for UI configuration with defaults
const STRATEGY_METADATA: Record<string, { name: string; params: Array<{ key: string; label: string; type: 'number' | 'boolean' | 'time' | 'tickers' | 'percent'; description: string; default: any; min?: number; max?: number; step?: number }> }> = {
  strategy1: {
    name: 'Intraday Mean Reversion',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'window15m', label: '15m Window', type: 'number', description: 'Number of 15-minute bars to analyze', default: 4 },
      { key: 'cooldownHours', label: 'Cooldown (hours)', type: 'number', description: 'Hours between signals', default: 3 },
      { key: 'trendLookback', label: 'Trend Lookback', type: 'number', description: 'Bars to look back for trend', default: 3 },
    ],
  },
  strategy2: {
    name: 'Daily Trend Reversal',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'dailyTrendLookback', label: 'Daily Lookback', type: 'number', description: 'Days to analyze for trend', default: 3 },
      { key: 'touchPct', label: 'Touch %', type: 'number', description: 'Price touch threshold (decimal)', default: 0.0015 },
      { key: 'window1h', label: '1h Window', type: 'number', description: 'Number of 1-hour bars', default: 2 },
      { key: 'window15m', label: '15m Window', type: 'number', description: 'Number of 15-minute bars', default: 4 },
      { key: 'cooldownHours', label: 'Cooldown (hours)', type: 'number', description: 'Hours between signals', default: 6 },
    ],
  },
  strategy3: {
    name: 'Opening Gap Fade',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'minGapPct', label: 'Min Gap %', type: 'number', description: 'Minimum gap size (decimal)', default: 0.004 },
      { key: 'tightLookback', label: 'Tight Lookback', type: 'number', description: 'Bars for tight range', default: 100 },
      { key: 'tightPercentile', label: 'Tight Percentile', type: 'number', description: 'Percentile for tight detection', default: 20 },
      { key: 'bandOutsideTol', label: 'Band Outside Tolerance', type: 'number', description: 'Bollinger band tolerance', default: 0 },
      { key: 'entryWindowMinutes', label: 'Entry Window (min)', type: 'number', description: 'Minutes after open to enter', default: 5 },
      { key: 'maxSignalsPerDay', label: 'Max Signals/Day', type: 'number', description: 'Maximum signals per day', default: 1 },
    ],
  },
  strategy4: {
    name: 'Multi-Touch Reversal',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'minDistPct', label: 'Min Distance %', type: 'number', description: 'Minimum distance from MA (decimal)', default: 0.012 },
      { key: 'firstBarWindow', label: 'First Bar Window', type: 'number', description: 'Bars for first touch', default: 2 },
      { key: 'confirmWindow', label: 'Confirm Window', type: 'number', description: 'Bars for confirmation', default: 6 },
      { key: 'cooldownHours', label: 'Cooldown (hours)', type: 'number', description: 'Hours between signals', default: 6 },
    ],
  },
  strategy5: {
    name: 'Gap Fade with Flat Confirmation',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'minGapPct', label: 'Min Gap %', type: 'number', description: 'Minimum gap size (decimal)', default: 0.004 },
      { key: 'tightLookback', label: 'Tight Lookback', type: 'number', description: 'Bars for tight range', default: 100 },
      { key: 'tightPercentile', label: 'Tight Percentile', type: 'number', description: 'Percentile for tight detection', default: 20 },
      { key: 'bandOutsideTol', label: 'Band Outside Tolerance', type: 'number', description: 'Bollinger band tolerance', default: 0.0005 },
      { key: 'maxSignalsPerDay', label: 'Max Signals/Day', type: 'number', description: 'Maximum signals per day', default: 1 },
      { key: 'flatLookback', label: 'Flat Lookback', type: 'number', description: 'Bars for flat detection', default: 6 },
      { key: 'flatEpsilon', label: 'Flat Epsilon', type: 'number', description: 'Threshold for flat (decimal)', default: 0.0005 },
      { key: 'entryWindowMinutes', label: 'Entry Window (min)', type: 'number', description: 'Minutes after open to enter', default: 5 },
    ],
  },
  ct15: {
    name: 'CT15 Extended Hours',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'minGapPct', label: 'Min Gap %', type: 'number', description: 'Minimum gap size (decimal)', default: 0.002 },
      { key: 'bwSlopeLookback', label: 'BW Slope Lookback', type: 'number', description: 'Bars for bandwidth slope', default: 3 },
      { key: 'bwAvgRatio', label: 'BW Avg Ratio', type: 'number', description: 'BW must exceed avg × ratio (1.0=exact, 0.75=relaxed)', default: 1.0 },
      { key: 'maxSignalsPerDay', label: 'Max Signals/Day', type: 'number', description: 'Maximum signals per day', default: 1 },
      { key: 'strictExposedMode', label: 'Strict Exposed Mode', type: 'boolean', description: 'Enable strict mode', default: false },
    ],
  },
  ct_open: {
    name: 'CT-Open Squeeze Breakout',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'requireSqueeze', label: 'Require Squeeze', type: 'boolean', description: 'When off, skips squeeze check — uses only 1m momentum', default: true },
      { key: 'squeezeLookback', label: 'Squeeze Lookback', type: 'number', description: '15m bars for BW percentile', default: 100 },
      { key: 'squeezePercentile', label: 'Squeeze Percentile', type: 'number', description: 'BW must be below this percentile', default: 30 },
      { key: 'entryWindowMinutes', label: 'Entry Window (min)', type: 'number', description: 'Minutes after 9:30 to monitor for breakout', default: 15 },
      { key: 'minBreakoutBars', label: 'Min Breakout Bars', type: 'number', description: 'Consecutive 1m bars above/below opening price to confirm', default: 3 },
      { key: 'minDisplacementPct', label: 'Min Displacement %', type: 'number', description: 'Price must move this % from open (0.10 = 0.10%)', default: 0.10 },
      { key: 'maxSignalsPerDay', label: 'Max Signals/Day', type: 'number', description: 'Maximum signals per day', default: 1 },
    ],
  },
  strategy7: {
    name: '0DTE Scalper',
    params: [
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPX', 'SPY', 'QQQ', 'IWM'] },
      { key: 'targetDTE', label: 'Target DTE', type: 'number', description: 'Target days to expiration (0 = same-day)', default: 0 },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '15:00' },
      { key: 'limitOrderTimeoutSecs', label: 'Limit Timeout (s)', type: 'number', description: 'Seconds to wait for limit fill before market fallback', default: 15 },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 3 },
      { key: 'volumeSpikePct', label: 'Volume Spike %', type: 'number', description: 'Volume spike multiplier (e.g., 1.5 for 150%)', default: 1.5 },
      { key: 'minConsecutiveBars', label: 'Min Consecutive Bars', type: 'number', description: 'Minimum consecutive bars in same direction', default: 2 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.10, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.20, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop for this strategy', default: false },
    ],
  },
  strategy8: {
    name: '0DTE Momentum Rider',
    params: [
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPX', 'SPY', 'QQQ', 'IWM'] },
      { key: 'targetDTE', label: 'Target DTE', type: 'number', description: 'Target days to expiration (0 = same-day)', default: 0 },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '15:00' },
      { key: 'limitOrderTimeoutSecs', label: 'Limit Timeout (s)', type: 'number', description: 'Seconds to wait for limit fill before market fallback', default: 15 },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 10 },
      { key: 'rsiOverbought', label: 'RSI Overbought', type: 'number', description: 'RSI overbought threshold (0-100)', default: 65 },
      { key: 'rsiOversold', label: 'RSI Oversold', type: 'number', description: 'RSI oversold threshold (0-100)', default: 35 },
      { key: 'rsiPeriod', label: 'RSI Period', type: 'number', description: 'RSI calculation period', default: 14 },
      { key: 'volumeSpikeMult', label: 'Volume Spike Mult', type: 'number', description: 'Volume spike multiplier (1m vol > Nx avg 1m vol)', default: 2.0 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.50, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.25, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop for this strategy', default: true },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.30, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.25, min: 0, max: 1, step: 0.05 },
    ],
  },
  strategy9: {
    name: '0DTE Gap Fade Enhanced',
    params: [
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPX', 'SPY', 'QQQ', 'IWM'] },
      { key: 'targetDTE', label: 'Target DTE', type: 'number', description: 'Target days to expiration (0 = same-day)', default: 0 },
      { key: 'entryStartTime', label: 'Entry Start', type: 'time', description: 'Earliest time to open new entries (ET)', default: '10:00' },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '14:00' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET)', default: '15:30' },
      { key: 'limitOrderTimeoutSecs', label: 'Limit Timeout (s)', type: 'number', description: 'Seconds to wait for limit fill before market fallback', default: 15 },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 30 },
      { key: 'minGapPct', label: 'Min Gap %', type: 'number', description: 'Minimum gap size (decimal)', default: 0.005 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.20, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.30, min: 0, max: 1, step: 0.05 },
    ],
  },
  strategy10: {
    name: '0DTE Trend Following',
    params: [
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPX', 'SPY', 'QQQ', 'IWM'] },
      { key: 'targetDTE', label: 'Target DTE', type: 'number', description: 'Target days to expiration (0 = same-day)', default: 0 },
      { key: 'entryStartTime', label: 'Entry Start', type: 'time', description: 'Earliest time to open new entries (ET)', default: '09:45' },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '13:00' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET)', default: '15:30' },
      { key: 'limitOrderTimeoutSecs', label: 'Limit Timeout (s)', type: 'number', description: 'Seconds to wait for limit fill before market fallback', default: 15 },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 60 },
      { key: 'minTrendBars', label: 'Min Trend Bars', type: 'number', description: 'Minimum bars for trend confirmation', default: 3 },
      { key: 'rsiTrendCallMin', label: 'RSI Call Min', type: 'number', description: 'Minimum RSI for call signals (0-100)', default: 50 },
      { key: 'rsiTrendCallMax', label: 'RSI Call Max', type: 'number', description: 'Maximum RSI for call signals (0-100)', default: 70 },
      { key: 'rsiTrendPutMin', label: 'RSI Put Min', type: 'number', description: 'Minimum RSI for put signals (0-100)', default: 30 },
      { key: 'rsiTrendPutMax', label: 'RSI Put Max', type: 'number', description: 'Maximum RSI for put signals (0-100)', default: 50 },
      { key: 'rsiPeriod', label: 'RSI Period', type: 'number', description: 'RSI calculation period', default: 14 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.75, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.30, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop for this strategy', default: true },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.40, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.50, min: 0, max: 1, step: 0.05 },
    ],
  },
  strategy11: {
    name: 'ICT Price Action',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: true },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'targetDTE', label: 'Target DTE', type: 'number', description: 'Target days to expiration (0 = same-day)', default: 0 },
      { key: 'entryStartTime', label: 'Entry Start', type: 'time', description: 'Earliest time to open new entries (ET)', default: '09:30' },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '15:45' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET)', default: '15:30' },
      { key: 'limitOrderTimeoutSecs', label: 'Limit Timeout (s)', type: 'number', description: 'Seconds to wait for limit fill before market fallback', default: 15 },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 60 },
      { key: 'swingLookback', label: 'Swing Lookback', type: 'number', description: 'Bars on each side to confirm swing point', default: 3 },
      { key: 'minDisplacementPct', label: 'Min Displacement %', type: 'number', description: 'MSS candle must displace this % beyond swing (decimal)', default: 0.0005 },
      { key: 'avgBodyLookback', label: 'Avg Body Lookback', type: 'number', description: 'Bars to compute average candle body', default: 20 },
      { key: 'avgBodyMult', label: 'Avg Body Mult', type: 'number', description: 'MSS candle body must exceed avg × this multiplier', default: 1.0 },
      { key: 'minRiskReward', label: 'Min Risk/Reward', type: 'number', description: 'Minimum reward-to-risk ratio for entry', default: 2.0 },
      { key: 'sweepWindowBars', label: 'Sweep Window', type: 'number', description: 'Max bars back to look for liquidity sweep', default: 36 },
      { key: 'mssLookbackBars', label: 'MSS Lookback', type: 'number', description: 'Bars back to search for market structure shift', default: 6 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.20, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.50, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop for this strategy', default: true },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.10, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.15, min: 0, max: 1, step: 0.05 },
      { key: 'useSRFilter', label: 'S/R Level Filter', type: 'boolean', description: 'Only enter when price is near a support (CALL) or resistance (PUT) level', default: false },
      { key: 'srProximityPct', label: 'S/R Proximity %', type: 'number', description: 'How close price must be to S/R level (decimal, e.g. 0.002 = 0.2%)', default: 0.002 },
      { key: 'allowSREntry', label: 'Allow S/R Entry (no FVG)', type: 'boolean', description: 'When sweep+MSS found but no FVG, allow entry if price is at an S/R level', default: false },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy (empty = all)', default: [] },
    ],
  },
  strategy12: {
    name: 'GEX Mean Reversion',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: false },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:45' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '15:00' },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPY'] },
      { key: 'entryStartTime', label: 'Entry Start', type: 'time', description: 'Earliest time to open new entries (ET)', default: '09:45' },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open new entries (ET)', default: '15:00' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET)', default: '15:00' },
      { key: 'lateCutoffTime', label: 'Late Cutoff', type: 'time', description: 'No entries after this (theta crush)', default: '15:00' },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 5 },
      { key: 'gexRefreshMinutes', label: 'GEX Refresh (min)', type: 'number', description: 'How often to refresh GEX levels from SPX', default: 5 },
      { key: 'proximityThreshold', label: 'Proximity ($)', type: 'number', description: 'Max distance from gamma node to trigger signal', default: 2.0 },
      { key: 'minVelocity', label: 'Min Velocity ($)', type: 'number', description: 'Min price momentum to qualify as hot tape', default: 0.3 },
      { key: 'velocityLookback', label: 'Velocity Lookback', type: 'number', description: 'Number of 1m bars to measure momentum', default: 5 },
      { key: 'stopDistance', label: 'Stop Distance ($)', type: 'number', description: 'Stop loss placed this far behind the gamma node', default: 1.5 },
      { key: 'requireWick', label: 'Require Wick', type: 'boolean', description: 'Require impulse wick at the node for entry', default: false },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.20, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.0, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop', default: true },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.05, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.15, min: 0, max: 1, step: 0.05 },
    ],
  },
  strategy13: {
    name: 'Opening Direction',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: false },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '09:30' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '16:00' },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers that can use this strategy', default: ['SPY'] },
      { key: 'entryStartTime', label: 'Entry Start', type: 'time', description: 'Earliest time to open entries (ET)', default: '10:00' },
      { key: 'entryEndTime', label: 'Entry End', type: 'time', description: 'Last time to open entries (ET)', default: '11:30' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET)', default: '15:30' },
      { key: 'lateCutoffTime', label: 'Late Cutoff', type: 'time', description: 'No entries after this', default: '11:30' },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 60 },
      { key: 'observationMinutes', label: 'Observation Window (min)', type: 'number', description: 'Minutes from open to watch before confirming', default: 30 },
      { key: 'confirmationBars', label: 'Confirmation Bars', type: 'number', description: 'Consecutive 5m bars confirming direction', default: 3 },
      { key: 'minRangeDollars', label: 'Min Range ($)', type: 'number', description: 'Min opening range in dollars to qualify', default: 1.50 },
      { key: 'maxRangeDollars', label: 'Max Range ($)', type: 'number', description: 'Max opening range (move already done)', default: 5.00 },
      { key: 'enableGapFade', label: 'Gap Fade Filter', type: 'boolean', description: 'Block gap-continuation signals', default: true },
      { key: 'requireRetest', label: 'Require Retest', type: 'boolean', description: 'Require pullback to range boundary before entry', default: false },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target', default: 0.30, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Stop loss', default: 0.50, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop', default: true },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.10, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.30, min: 0, max: 1, step: 0.05 },
    ],
  },
  strategy14: {
    name: 'Gamma Zero (SPY 0DTE)',
    params: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', description: 'Enable this strategy', default: false },
      { key: 'operatingStartTime', label: 'Hours Start', type: 'time', description: 'Operating hours start (ET)', default: '10:00' },
      { key: 'operatingEndTime', label: 'Hours End', type: 'time', description: 'Operating hours end (ET)', default: '15:00' },
      { key: 'allowedTickers', label: 'Allowed Tickers', type: 'tickers', description: 'Tickers to trade (GEX is still derived from SPX 0DTE; defaults to SPY for execution).', default: ['SPY'] },
      { key: 'entryStartTime', label: 'Entry Start (outer)', type: 'time', description: 'Outer entry start. Detector enforces 10:00–11:30 + 14:00–15:00 internally.', default: '10:00' },
      { key: 'entryEndTime', label: 'Entry End (outer)', type: 'time', description: 'Outer entry end. Detector enforces dual windows internally.', default: '15:00' },
      { key: 'timeExitAt', label: 'Time Exit', type: 'time', description: 'Force-close open positions at this time (ET) — Golden Rule: close before 3pm', default: '15:00' },
      { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'number', description: 'Minutes between signals', default: 30 },
      { key: 'gexRefreshMinutes', label: 'GEX Refresh (min)', type: 'number', description: 'How often to refresh Call Wall / Put Wall / Gamma Flip', default: 10 },
      { key: 'gammaZeroBufferPct', label: 'Gamma Zero Buffer', type: 'number', description: 'Skip entries when |spot − flip|/spot ≤ this (decimal). Calibrated for SPY: 0.0003 = 0.03% ≈ $0.22. For SPX, use 5–10× larger.', default: 0.0003 },
      { key: 'wallProximityPct', label: 'Wall Proximity', type: 'number', description: 'How close to a wall (decimal) to consider “near” for between-walls entries. SPY default 0.0007 = 0.07% ≈ $0.52. For SPX, use 5–10× larger.', default: 0.0007 },
      { key: 'enableReclaimEntries', label: 'Enable Put Wall Reclaim', type: 'boolean', description: 'Position 4: CALL exception when price reclaims a broken Put Wall. Off until backtested.', default: false },
      { key: 'minBounceVolumeRatio', label: 'Min Bounce Volume Ratio', type: 'number', description: 'Reclaim bounce candle volume must beat avg of prior 5 by this multiplier', default: 1.0 },
      { key: 'profitTargetPct', label: 'Profit Target %', type: 'percent', description: 'TP target (T1, +50% per spec)', default: 0.50, min: 0, max: 2, step: 0.05 },
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'percent', description: 'Hard stop on option premium (–20% per spec)', default: 0.20, min: 0, max: 1, step: 0.05 },
      { key: 'useTrailingStop', label: 'Use Trailing Stop', type: 'boolean', description: 'Enable trailing stop', default: false },
      { key: 'trailingStopPct', label: 'Trailing Stop %', type: 'percent', description: 'Trail distance from peak', default: 0.10, min: 0, max: 0.5, step: 0.01 },
      { key: 'trailingActivationPct', label: 'Trail Activation %', type: 'percent', description: 'Profit level to start trailing', default: 0.50, min: 0, max: 1, step: 0.05 },
    ],
  },
};

/** Map a full strategy_id to the short key used in STRATEGY_METADATA. */
function strategySettingsKey(strategyId: string): string {
  if (strategyId.startsWith('ct_open')) return 'ct_open';
  if (strategyId.startsWith('ct15')) return 'ct15';
  const m = strategyId.match(/strategy[_-]?(\d+)/);
  if (m) return `strategy${m[1]}`;
  return strategyId;
}

/** Resolve effective TP settings for a position: global → strategy → per-position override. */
function getEffectiveTpSettings(
  order: { strategy_id?: string | null; signal_id?: string | null },
  globalSettings: any,
  strategySettingsOverrides: Record<string, Record<string, any>> | undefined,
  tpOverrides: Record<string, any> | undefined,
) {
  const tpKeys = ['profitTargetPct', 'stopLossPct', 'useTrailingStop', 'trailingStopPct', 'trailingActivationPct'] as const;
  // Start with global
  const result: Record<string, any> = {};
  for (const k of tpKeys) result[k] = globalSettings?.[k];

  // Layer strategy defaults from STRATEGY_METADATA
  if (order.strategy_id) {
    const sKey = strategySettingsKey(order.strategy_id);
    const meta = STRATEGY_METADATA[sKey];
    if (meta) {
      for (const p of meta.params) {
        if ((tpKeys as readonly string[]).includes(p.key)) {
          result[p.key] = p.default;
        }
      }
    }
    // Layer user strategy overrides from settings
    const userOverrides = strategySettingsOverrides?.[sKey];
    if (userOverrides) {
      for (const k of tpKeys) {
        if (userOverrides[k] !== undefined) result[k] = userOverrides[k];
      }
    }
  }

  // Layer per-position override (highest precedence)
  if (order.signal_id && tpOverrides?.[order.signal_id]) {
    const posOverride = tpOverrides[order.signal_id];
    for (const k of tpKeys) {
      if (posOverride[k] !== undefined) result[k] = posOverride[k];
    }
  }

  return {
    profitTargetPct: Number(result.profitTargetPct ?? 0.35),
    stopLossPct: Number(result.stopLossPct ?? 0),
    useTrailingStop: Boolean(result.useTrailingStop ?? false),
    trailingStopPct: Number(result.trailingStopPct ?? 0.07),
    trailingActivationPct: Number(result.trailingActivationPct ?? 0),
  };
}

// Minimal/invisible scrollbar styles like dashboard panels
const SCROLLBAR_STYLES = {
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  '&::-webkit-scrollbar': {
    display: 'none',
  },
};

export function TradingDashboard() {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  // Render mobile view for small screens
  if (isMobile) {
    return <MobileTradingView />;
  }

  // Column resize state
  const [col1Width, setCol1Width] = useState(() => Math.floor(window.innerWidth / 4));
  const [col2Width, setCol2Width] = useState(() => Math.floor(window.innerWidth / 4));
  const [col3Width, setCol3Width] = useState(() => Math.floor(window.innerWidth / 4));
  const [col1Resizing, setCol1Resizing] = useState(false);
  const [col2Resizing, setCol2Resizing] = useState(false);
  const [col3Resizing, setCol3Resizing] = useState(false);
  // closedFromDate: ISO date string (YYYY-MM-DD) to filter closed positions from that date onward, or null for all
  const [closedFromDate, setClosedFromDate] = useState<string | null>(() => {
    const now = new Date();
    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return ny.toISOString().slice(0, 10);
  });
  const [openTodayOnly, setOpenTodayOnly] = useState(false);
  const [openPosModalOpen, setOpenPosModalOpen] = useState(false);
  const [closedPosModalOpen, setClosedPosModalOpen] = useState(false);
  const [expandedStrategies, setExpandedStrategies] = useState<Set<string>>(new Set());
  const [expandedClosedStrategies, setExpandedClosedStrategies] = useState<Set<string>>(new Set());
  const prevWindowWidthRef = useRef(window.innerWidth);

  // Track position updates for flash animation
  const [flashingPositionIds, setFlashingPositionIds] = useState<Set<string>>(new Set());
  const prevOpenPositionsRef = useRef<any[]>([]);
  const prevOpenPosJsonRef = useRef<string | null>(null);

  // Auto trader settings dialog state
  const [autoTraderSettingsOpen, setAutoTraderSettingsOpen] = useState(false);
  const [autoTraderSettingsBusy, setAutoTraderSettingsBusy] = useState(false);
  const [autoTraderSettingsError, setAutoTraderSettingsError] = useState<string | null>(null);
  const [autoTraderSettingsDraft, setAutoTraderSettingsDraft] = useState({
    enabled: false,
    intervalSeconds: 60,
    tpCheckIntervalSeconds: 15,
    rthOnly: true,
    profitTargetPct: 0.35,
    maxTradesPerDay: 2,
    useOptimalRange: true,
    skipEarningsDay: true,
    useMarketOrders: true,
    maxConcurrentPositions: 20,
    onlyFavorites: false,
    capitalLimit: 0,
    capitalLimitEnabled: false,
    maxDailyLossDollar: 0,
    allowOpenPositions: true,
    allowClosePositions: true,
    expiryCloseTime: '14:00',
    overrides: {} as Record<string, any>,
    tickerSettings: {} as Record<string, { enabled: boolean; optimalMin: number | null; optimalMax: number | null; optimalMin0DTE: number | null; optimalMax0DTE: number | null }>,
    strategySettings: {} as Record<string, Record<string, any>>,
    allowCalls: true,
    allowPuts: true,
    blockCounterTrend: true,
    paperAccount: '',
    liveAccount: '',
    tradingMode: 'paper' as 'paper' | 'live',
  });
  const [dashboardChartSymbol, setDashboardChartSymbol] = useState('SPY');
  const [dashboardChartInterval, setDashboardChartInterval] = useState('5m');
  const [dashboardChartRth, setDashboardChartRth] = useState(true);
  const [dashboardChartGex, setDashboardChartGex] = useState(true);
  const dashboardChartGexEligible =
    dashboardChartSymbol.toUpperCase() === 'SPY' || dashboardChartSymbol.toUpperCase() === 'SPX';
  const [overrideSymbol, setOverrideSymbol] = useState('');
  const [settingsTab, setSettingsTab] = useState<'global' | 'open-positions' | 'take-profit' | 'position-sizing' | 'trading-mode' | 'strategies' | 'override' | 'tickers'>('global');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('strategy1');
  const [overrideDraft, setOverrideDraft] = useState({
    enabled: false,
    intervalSeconds: 60,
    rthOnly: true,
    profitTargetPct: 0.35,
    maxTradesPerDay: 2,
    useOptimalRange: true,
    skipEarningsDay: true,
    useMarketOrders: true,
    maxConcurrentPositions: 20,
    capitalLimit: 0,
  });

  // Other state
  const [autoTraderBusy, setAutoTraderBusy] = useState(false);

  const [closingAllPositions, setClosingAllPositions] = useState(false);
  const [closingPositionKeys, setClosingPositionKeys] = useState<Set<string>>(new Set());
  const [hideClosingPositions, setHideClosingPositions] = useState(false);
  const [positionCloseError, setPositionCloseError] = useState<string | null>(null);
  const [scanFeedTab, setScanFeedTab] = useState<'feed' | 'skips' | 'tp'>('feed');
  const [tpShowAll, setTpShowAll] = useState(false);
  const [scanFeedCategories, setScanFeedCategories] = useState<Set<string>>(
    new Set(['signals', 'orders', 'trades', 'scan'])
  );
  const [scanFeedSymbol, setScanFeedSymbol] = useState('');
  const [openPosMenuAnchor, setOpenPosMenuAnchor] = useState<{ el: HTMLElement; order: any } | null>(null);
  const [ibPosMenuAnchor, setIbPosMenuAnchor] = useState<{ el: HTMLElement; pos: any } | null>(null);
  const [openPosBlink, setOpenPosBlink] = useState(false);
  const [customTpDialog, setCustomTpDialog] = useState<{ order: any } | null>(null);
  const [customTpValues, setCustomTpValues] = useState({ profitTargetPct: 8, useTrailingStop: false, trailingStopPct: 3 });
  const [positionHistoryDialog, setPositionHistoryDialog] = useState<{ order: any; events: any[] } | null>(null);
  const [skipChainModal, setSkipChainModal] = useState<Record<string, unknown> | null>(null);
  const [positionDetailModal, setPositionDetailModal] = useState<{ order: any; ibPos: any } | null>(null);

  // Trading mode (paper / live)
  const tradingModeQuery = useQuery({
    queryKey: ['tradingMode'],
    queryFn: fetchTradingMode,
    refetchInterval: 30000,
    staleTime: 10000,
  });


  // Confirmation dialog state
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [confirmDialogTitle, setConfirmDialogTitle] = useState('');
  const [confirmDialogMessage, setConfirmDialogMessage] = useState('');
  const confirmActionRef = useRef<(() => void) | null>(null);

  const openConfirmDialog = (title: string, message: string, onConfirm: () => void) => {
    setConfirmDialogTitle(title);
    setConfirmDialogMessage(message);
    confirmActionRef.current = onConfirm;
    setConfirmDialogOpen(true);
  };

  const handleConfirmDialogConfirm = () => {
    setConfirmDialogOpen(false);
    const action = confirmActionRef.current;
    confirmActionRef.current = null;
    if (action) {
      Promise.resolve(action()).catch((err) => {
        const msg = err?.response?.data?.detail ?? err?.message ?? 'Unknown error';
        setPositionCloseError(`Action failed: ${msg}`);
      });
    }
  };

  const handleConfirmDialogCancel = () => {
    setConfirmDialogOpen(false);
    confirmActionRef.current = null;
  };
  const [ibMetricsOpen, setIbMetricsOpen] = useState(false);
  const lastOrdersTsRef = useRef<number | null>(null);

  // Track fetch latencies (ms) per query key
  const fetchLatencies = useRef<Record<string, number>>({});
  const timedFetch = <T,>(key: string, fn: () => Promise<T>) => async (): Promise<T> => {
    const t0 = performance.now();
    const result = await fn();
    fetchLatencies.current[key] = Math.round(performance.now() - t0);
    return result;
  };

  // Queries
  const ibMetricsQuery = useQuery({
    queryKey: ['ib-metrics'],
    queryFn: fetchIbMetrics,
    refetchInterval: ibMetricsOpen ? 2000 : false,
  });

  const autoTraderQuery = useQuery({
    queryKey: ['auto-trader-status'],
    queryFn: fetchAutoTraderStatus,
    refetchInterval: 5000,
    staleTime: 3000,
  });

  const isAutoTraderRunning = autoTraderQuery.data?.running ?? false;

  const autoTraderEventsQuery = useQuery({
    queryKey: ['auto-trader-events'],
    queryFn: () => fetchAutoTraderEvents(2000),
    refetchInterval: isAutoTraderRunning ? 5000 : 30000,
  });

  // Fetch signals for the chart via backtest endpoint (works without auto trader running)
  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const backtestSignalsQuery = useQuery({
    queryKey: ['dashboard-signals', dashboardChartSymbol, today],
    queryFn: () => fetchBacktest(dashboardChartSymbol, today, 5),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const chartSignals = useMemo<MiniChartSignal[]>(() => {
    const signals = backtestSignalsQuery.data?.signals;
    const result: MiniChartSignal[] = [];
    if (signals) {
      for (const sig of signals) {
        result.push({
          time: sig.entry_time,
          direction: sig.direction,
          label: sig.strategy_id,
          chopFiltered: sig.chop_filtered ?? false,
        });
      }
    }
    // Add skipped signals from auto trader events (settle cash, capital, cooldown, etc.)
    const events = autoTraderEventsQuery.data?.events;
    if (events) {
      const seenSkips = new Set<string>();
      for (const ev of events) {
        const d = (ev.details ?? {}) as Record<string, any>;
        if (ev.type === 'signal_skipped' && d.symbol === dashboardChartSymbol && d.entry_time && d.direction) {
          const key = `${d.signal_id || d.entry_time}`;
          if (seenSkips.has(key)) continue;
          seenSkips.add(key);
          // Don't duplicate signals already shown from backtest endpoint
          const entryTime = d.entry_time as number;
          const direction = d.direction as 'CALL' | 'PUT';
          const alreadyShown = result.some(s => Math.abs(s.time - entryTime) < 60 && s.direction === direction);
          if (!alreadyShown) {
            result.push({
              time: entryTime,
              direction,
              label: d.strategy_id as string,
              skipReason: (d.reason_code as string) || 'skipped',
            });
          }
        }
      }
    }
    return result;
  }, [backtestSignalsQuery.data?.signals, autoTraderEventsQuery.data?.events, dashboardChartSymbol]);

  const ordersQuery = useQuery({
    queryKey: ['orders-log'],
    queryFn: timedFetch('orders', () => fetchOrders(400)),
    refetchInterval: isAutoTraderRunning ? 5000 : 15000,
  });

  // Extract executed trades for chart markers
  const chartTrades = useMemo<MiniChartTrade[]>(() => {
    const orders = ordersQuery.data?.orders;
    if (!orders) return [];
    return orders
      .filter((o: any) => o.symbol === dashboardChartSymbol)
      .map((o: any) => ({
        entryTime: o.timestamp,
        exitTime: o.timestamp,
        action: o.action,
        right: o.right,
        strike: o.strike,
        price: o.price,
        pnl: o.pnl ?? undefined,
        type: o.type,
      }));
  }, [ordersQuery.data?.orders, dashboardChartSymbol]);


  const ibPositionsQuery = useQuery({
    queryKey: ['ib-positions'],
    queryFn: timedFetch('ib-positions', fetchIbPositions),
    refetchInterval: isAutoTraderRunning ? 10000 : 30000,
  });

  const ibOrdersQuery = useQuery({
    queryKey: ['ib-orders-history'],
    queryFn: () => fetchIbOrdersHistory(200),
    refetchInterval: isAutoTraderRunning ? 15000 : 60000,
  });

  const ibAccountSummaryQuery = useQuery({
    queryKey: ['ib-account-summary'],
    queryFn: fetchIbAccountSummary,
    refetchInterval: 30000,
  });

  const autoTraderSettingsQuery = useQuery({
    queryKey: ['auto-trader-settings-orders'],
    queryFn: fetchAutoTraderSettings,
    staleTime: 30000,
  });

  const tpOverridesQuery = useQuery({
    queryKey: ['position-tp-overrides'],
    queryFn: fetchPositionTpOverrides,
    refetchInterval: 30000,
    staleTime: 20000,
  });

  // ── Memoized derived data ─────────────────────────────────────────
  // These prevent re-computing expensive filters/maps on every render
  // triggered by unrelated state changes (hover, menus, dialogs, etc.)

  const todayStr = useMemo(
    () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
    // Recalc once per minute to handle day rollover
    [Math.floor(Date.now() / 60000)],
  );

  const currentMode = tradingModeQuery.data?.mode ?? 'paper';

  const openPositions = useMemo(
    () => (ordersQuery.data?.open_positions ?? []).filter(
      (o: any) => !o.mode || o.mode === currentMode
    ),
    [ordersQuery.data?.open_positions, currentMode],
  );

  const todayOpenPositions = useMemo(
    () => openPositions.filter((o: any) => {
      const dateKey = o.timestamp
        ? new Date(o.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
        : '';
      return dateKey === todayStr;
    }),
    [openPositions, todayStr],
  );

  const openByDate = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    const source = openTodayOnly ? todayOpenPositions : openPositions;
    [...source].reverse().forEach((order: any) => {
      const dateKey = order.timestamp
        ? new Date(order.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
        : 'Unknown';
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(order);
    });
    return grouped;
  }, [openPositions, todayOpenPositions, openTodayOnly]);

  const ibPositions = useMemo(
    () => ibPositionsQuery.data?.positions ?? [],
    [ibPositionsQuery.data?.positions],
  );

  // Build a quick-lookup map for IB positions by symbol+right+strike
  const ibPositionMap = useMemo(() => {
    const map = new Map<string, any>();
    ibPositions.forEach((p: any) => {
      map.set(`${p.symbol}|${p.right}|${p.strike}`, p);
    });
    return map;
  }, [ibPositions]);

  const events = useMemo(
    () => autoTraderEventsQuery.data?.events ?? [],
    [autoTraderEventsQuery.data?.events],
  );

  // Refetch account summary when new orders arrive
  useEffect(() => {
    const entries = ordersQuery.data?.orders ?? [];
    if (!entries.length) return;
    const latestTs = entries[entries.length - 1]?.timestamp ?? null;
    if (!latestTs || lastOrdersTsRef.current === latestTs) return;
    lastOrdersTsRef.current = latestTs;
    ibAccountSummaryQuery.refetch();
  }, [ordersQuery.data?.orders, ibAccountSummaryQuery]);

  // Detect position updates and trigger flash animation
  useEffect(() => {
    const currentPositions = ordersQuery.data?.open_positions ?? [];
    const prevPositions = prevOpenPositionsRef.current;

    if (prevPositions.length === 0) {
      prevOpenPositionsRef.current = currentPositions;
      return;
    }

    const updatedIds = new Set<string>();

    currentPositions.forEach((current: any) => {
      const prev = prevPositions.find((p: any) => p.position_id === current.position_id);
      if (prev && (
        prev.price !== current.price ||
        prev.status !== current.status ||
        prev.target_price !== current.target_price
      )) {
        updatedIds.add(current.position_id);
      }
    });

    if (updatedIds.size > 0) {
      setFlashingPositionIds(updatedIds);
      setTimeout(() => setFlashingPositionIds(new Set()), 800);
    }

    prevOpenPositionsRef.current = currentPositions;
  }, [ordersQuery.data?.open_positions]);

  // Column 1 resize
  useEffect(() => {
    if (!col1Resizing) return;
    const handleMove = (e: MouseEvent) => {
      setCol1Width(Math.max(240, Math.min(600, e.clientX)));
    };
    const handleUp = () => setCol1Resizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [col1Resizing]);

  // Column 2 resize
  useEffect(() => {
    if (!col2Resizing) return;
    const handleMove = (e: MouseEvent) => {
      setCol2Width(Math.max(200, Math.min(600, e.clientX - col1Width)));
    };
    const handleUp = () => setCol2Resizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [col2Resizing, col1Width]);

  // Column 3 resize
  useEffect(() => {
    if (!col3Resizing) return;
    const handleMove = (e: MouseEvent) => {
      setCol3Width(Math.max(200, Math.min(600, e.clientX - col1Width - col2Width)));
    };
    const handleUp = () => setCol3Resizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [col3Resizing, col1Width, col2Width]);

  // Keep column proportions on window resize
  useEffect(() => {
    const handleResize = () => {
      const prevW = prevWindowWidthRef.current;
      const nextW = window.innerWidth;
      if (prevW === nextW) return;
      const ratio = nextW / prevW;
      setCol1Width((w) => Math.max(160, Math.round(w * ratio)));
      setCol2Width((w) => Math.max(160, Math.round(w * ratio)));
      setCol3Width((w) => Math.max(160, Math.round(w * ratio)));
      prevWindowWidthRef.current = nextW;
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Settings helpers
  const buildSettingsPayload = (source: any, opts: { includeOnlyFavorites?: boolean } = {}) => {
    const payload = {
      enabled: Boolean(source.enabled),
      intervalSeconds: Number(source.intervalSeconds),
      tpCheckIntervalSeconds: Number(source.tpCheckIntervalSeconds ?? 15),
      rthOnly: Boolean(source.rthOnly),
      profitTargetPct: Number(source.profitTargetPct),
      useTrailingStop: Boolean(source.useTrailingStop ?? false),
      trailingStopPct: Number(source.trailingStopPct ?? 0.1),
      maxTradesPerDay: Number(source.maxTradesPerDay),
      useOptimalRange: Boolean(source.useOptimalRange),
      skipEarningsDay: Boolean(source.skipEarningsDay),
      useMarketOrders: Boolean(source.useMarketOrders),
      useLimitOrdersForTrailExit: source.useLimitOrdersForTrailExit !== false,
      useLimitOrdersForEntry: Boolean(source.useLimitOrdersForEntry ?? false),
      limitOrderTimeoutSecs: Number(source.limitOrderTimeoutSecs ?? 30),
      stopLossPct: Number(source.stopLossPct ?? 0),
      signalMaxAgeSecs: Number(source.signalMaxAgeSecs ?? 0),
      onePositionPerSymbol: Boolean(source.onePositionPerSymbol ?? false),
      maxConcurrentPositions: Number(source.maxConcurrentPositions),
      capitalLimit: Number(source.capitalLimit ?? 0),
      capitalLimitEnabled: Boolean((source as any).capitalLimitEnabled ?? false),
      maxDailyLossDollar: Number(source.maxDailyLossDollar ?? 0),
      allowOpenPositions: source.allowOpenPositions !== false,
      allowClosePositions: source.allowClosePositions !== false,
    };
    if (opts.includeOnlyFavorites !== false) {
      return { ...payload, onlyFavorites: Boolean(source.onlyFavorites) };
    }
    return payload;
  };

  const handleResetCapital = async () => {
    try {
      await resetCapitalSpent();
      await autoTraderQuery.refetch();
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!overrideSymbol) return;
    const overrides = (autoTraderSettingsDraft as any).overrides || {};
    const base = buildSettingsPayload(autoTraderSettingsDraft, { includeOnlyFavorites: false });
    const existing = overrides[overrideSymbol] || {};
    setOverrideDraft({ ...base, ...existing });
  }, [overrideSymbol, autoTraderSettingsDraft]);

  // Blink open positions panel on data update
  useEffect(() => {
    const key = JSON.stringify(ordersQuery.data?.open_positions ?? []);
    if (prevOpenPosJsonRef.current && prevOpenPosJsonRef.current !== key) {
      setOpenPosBlink(true);
      const t = setTimeout(() => setOpenPosBlink(false), 600);
      return () => clearTimeout(t);
    }
    prevOpenPosJsonRef.current = key;
  }, [ordersQuery.data?.open_positions]);

  const loadAutoTraderSettings = async () => {
    setAutoTraderSettingsBusy(true);
    setAutoTraderSettingsError(null);
    try {
      const response = await fetchAutoTraderSettings();
      const loadedTickers = response.settings.tickerSettings || {};
      // Preserve all fields from loaded tickers (including enabledStrategies, positionSizing, riskPerTrade, etc.)
      const seeded: Record<string, any> = { ...loadedTickers };
      for (const [sym, range] of Object.entries(optimalRangesData as Record<string, { min: number; max: number } | null>)) {
        if (!seeded[sym]) {
          seeded[sym] = { enabled: true, optimalMin: range?.min ?? null, optimalMax: range?.max ?? null };
        }
      }
      setAutoTraderSettingsDraft({ ...response.settings, tpCheckIntervalSeconds: (response.settings as any).tpCheckIntervalSeconds ?? 15, tickerSettings: seeded } as any);
    } catch (error) {
      setAutoTraderSettingsError(error instanceof Error ? error.message : 'Failed to load settings');
    } finally {
      setAutoTraderSettingsBusy(false);
    }
  };

  const handleOpenAutoTraderSettings = () => {
    setAutoTraderSettingsOpen(true);
    void loadAutoTraderSettings();
  };

  const handleSaveAutoTraderSettings = async () => {
    setAutoTraderSettingsBusy(true);
    setAutoTraderSettingsError(null);
    try {
      const response = await saveAutoTraderSettings(autoTraderSettingsDraft);
      setAutoTraderSettingsDraft(response.settings as any);
      await Promise.all([autoTraderQuery.refetch(), autoTraderSettingsQuery.refetch(), tradingModeQuery.refetch()]);
    } catch (error: any) {
      setAutoTraderSettingsError(error?.response?.data?.detail ?? (error instanceof Error ? error.message : 'Failed to save settings'));
    } finally {
      setAutoTraderSettingsBusy(false);
    }
  };

  const handleApplyOverride = async () => {
    if (!overrideSymbol) return;
    const overrides = (autoTraderSettingsDraft as any).overrides || {};
    const nextOverrides = {
      ...overrides,
      [overrideSymbol]: buildSettingsPayload(overrideDraft, { includeOnlyFavorites: false }),
    };
    const nextDraft = { ...autoTraderSettingsDraft, overrides: nextOverrides };
    setAutoTraderSettingsBusy(true);
    setAutoTraderSettingsError(null);
    try {
      const response = await saveAutoTraderSettings(nextDraft as any);
      setAutoTraderSettingsDraft(response.settings as any);
    } catch (error) {
      setAutoTraderSettingsError(error instanceof Error ? error.message : 'Failed to save override');
    } finally {
      setAutoTraderSettingsBusy(false);
    }
  };

  const handleRemoveOverride = async () => {
    if (!overrideSymbol) return;
    const overrides = { ...((autoTraderSettingsDraft as any).overrides || {}) };
    if (!overrides[overrideSymbol]) return;
    delete overrides[overrideSymbol];
    const nextDraft = { ...autoTraderSettingsDraft, overrides };
    setAutoTraderSettingsBusy(true);
    setAutoTraderSettingsError(null);
    try {
      const response = await saveAutoTraderSettings(nextDraft as any);
      setAutoTraderSettingsDraft(response.settings as any);
      setOverrideSymbol('');
    } catch (error) {
      setAutoTraderSettingsError(error instanceof Error ? error.message : 'Failed to remove override');
    } finally {
      setAutoTraderSettingsBusy(false);
    }
  };

  const handleAutoTraderToggle = () => {
    if (autoTraderBusy) return;
    const isRunning = autoTraderQuery.data?.running ?? false;
    openConfirmDialog(
      isRunning ? 'Stop Auto Trader' : 'Start Auto Trader',
      isRunning
        ? 'This will stop the auto trader. No new positions will be opened or closed until it is restarted. Continue?'
        : 'This will start the auto trader and it will begin placing real orders. Make sure your settings are correct. Continue?',
      async () => {
        const nextRunning = !isRunning;
        setAutoTraderBusy(true);
        queryClient.setQueryData(['auto-trader-status'], (prev: any) => ({
          ...(prev ?? {}),
          running: nextRunning,
        }));
        try {
          if (nextRunning === false) {
            await stopAutoTrader();
          } else {
            await startAutoTrader();
          }
          await autoTraderQuery.refetch();
        } finally {
          setAutoTraderBusy(false);
        }
      }
    );
  };


  const handleShowPositionHistory = async (order: any) => {
    if (!order.position_id && !order.signal_id) {
      alert('This position does not have tracking information.');
      return;
    }
    try {
      // Fetch all trade log entries
      const ordersData = await fetchOrders(2000);

      // Find all entries related to this position
      const relevantEntries = ordersData.orders.filter((entry: any) => {
        if (order.position_id && entry.position_id === order.position_id) return true;
        if (order.signal_id && entry.signal_id === order.signal_id) return true;
        return false;
      });

      // Sort by timestamp (oldest first for chronological history)
      relevantEntries.sort((a: any, b: any) => a.timestamp - b.timestamp);

      // Convert trade log entries to event-like format for display
      const events = relevantEntries.map((entry: any) => ({
        timestamp: entry.timestamp,
        type: entry.type || 'unknown',
        message: `${entry.action} ${entry.quantity} ${entry.symbol} ${entry.right || ''} $${entry.strike || ''} @ $${entry.price}`,
        details: entry,
      }));

      setPositionHistoryDialog({ order, events });
    } catch (err) {
      console.error('Failed to fetch position history:', err);
      alert('Failed to load position history. Check console for details.');
    }
  };

  const handleCloseAllPositions = () => {
    openConfirmDialog(
      'Close All Positions',
      'This will place market orders to close ALL open IBKR positions. This action cannot be undone. Continue?',
      async () => {
        setClosingAllPositions(true);
        try {
          await closeAllIbPositions();
          await ibPositionsQuery.refetch();
        } finally {
          setClosingAllPositions(false);
        }
      }
    );
  };

  const handleClosePosition = (pos: {
    symbol: string;
    sec_type: string;
    quantity: number;
    exchange?: string | null;
    currency?: string | null;
    expiration?: string | null;
    strike?: number | null;
    right?: string | null;
  }) => {
    const label =
      pos.sec_type === 'OPT'
        ? `${pos.symbol} ${pos.right} ${pos.strike} ${pos.expiration ? pos.expiration.slice(2) : ''}`
        : pos.symbol;
    openConfirmDialog(
      'Close Position',
      `Place a market order to close ${pos.quantity} × ${label}? This action cannot be undone.`,
      async () => {
        const key = `${pos.symbol}-${pos.sec_type}-${pos.expiration ?? ''}-${pos.strike ?? ''}-${pos.right ?? ''}`;
        setPositionCloseError(null);
        setClosingPositionKeys((prev) => new Set(prev).add(key));
        try {
          await closeIbPosition({
            symbol: pos.symbol,
            sec_type: pos.sec_type,
            quantity: pos.quantity,
            exchange: pos.exchange ?? 'SMART',
            currency: pos.currency ?? 'USD',
            expiration: pos.expiration,
            strike: pos.strike,
            right: pos.right,
          });
          // Poll with force=true (forces IB Gateway to push fresh data) until
          // the position disappears or 30s timeout.
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const data = await fetchIbPositions(true);
            queryClient.setQueryData(['ib-positions'], data);
            const stillExists = data?.positions?.some(
              (p: { symbol: string; sec_type: string; expiration?: string | null; strike?: number | null; right?: string | null }) =>
                `${p.symbol}-${p.sec_type}-${p.expiration ?? ''}-${p.strike ?? ''}-${p.right ?? ''}` === key
            );
            if (!stillExists) break;
          }
        } catch (err: any) {
          const msg = err?.response?.data?.detail ?? err?.message ?? 'Unknown error';
          setPositionCloseError(`Close failed: ${msg}`);
        } finally {
          setClosingPositionKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    );
  };

  const handleCloseOpenLogPosition = (order: {
    symbol: string;
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
    quantity: number;
    position_id?: string | null;
  }) => {
    const label = `${order.symbol} ${order.right ?? ''} ${order.strike ?? ''} ${order.expiration ? order.expiration.slice(2) : ''}`.trim();
    openConfirmDialog(
      'Force Close Position',
      `Place a market SELL order to close ${order.quantity} × ${label}? This action cannot be undone.`,
      async () => {
        const key = `local-${order.position_id ?? order.symbol}`;
        setClosingPositionKeys((prev) => new Set(prev).add(key));
        try {
          // Find the current market premium from IB positions
          const matchedIbPos = ibPositionsQuery.data?.positions?.find(
            (p) => p.symbol === order.symbol && p.right === order.right && p.strike === order.strike
          );
          const currentPremium = matchedIbPos?.market_price ?? null;

          await closeIbPosition({
            symbol: order.symbol,
            sec_type: 'OPT',
            quantity: order.quantity,
            expiration: order.expiration ?? undefined,
            strike: order.strike ?? undefined,
            right: order.right ?? undefined,
          });

          // Flush from auto-trader tracking and log CLOSE with actual sell price
          if (order.position_id) {
            try {
              await flushTrackedPosition(order.position_id, currentPremium);
            } catch (err: any) {
              // 404 = position not in tracker (already flushed or never tracked) — ignore
              if (err?.response?.status !== 404) console.warn('Flush after sell failed:', err);
            }
          }

          await Promise.all([ibPositionsQuery.refetch(), ordersQuery.refetch()]);
        } finally {
          setClosingPositionKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    );
  };

  const isRunning = Boolean(autoTraderQuery.data?.running);

  return (
    <Box
      sx={{
        width: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: '#0b0f15',
        color: '#d1d4dc',
      }}
    >
      {/* Status Bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '8px 14px',
          borderBottom: '1px solid #1f2533',
          backgroundColor: '#0c111a',
          flexShrink: 0,
        }}
      >
        {/* Auto trader status */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {tradingModeQuery.data && (
            <Box
              sx={{
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 7px',
                borderRadius: 1,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                backgroundColor:
                  tradingModeQuery.data.mode === 'live'
                    ? 'rgba(239,83,80,0.18)'
                    : 'rgba(57,217,138,0.15)',
                color:
                  tradingModeQuery.data.mode === 'live'
                    ? '#ef5350'
                    : '#39d98a',
                border: `1px solid ${tradingModeQuery.data.mode === 'live' ? 'rgba(239,83,80,0.5)' : 'rgba(57,217,138,0.4)'}`,
                userSelect: 'none',
              }}
            >
              {tradingModeQuery.data.mode}
            </Box>
          )}
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Auto Trader</Typography>
          <FiberManualRecordIcon
            fontSize="small"
            sx={{
              color: autoTraderQuery.isLoading
                ? '#7c8190'
                : autoTraderQuery.isError
                  ? '#ef5350'
                  : isRunning
                    ? '#39d98a'
                    : '#f5a623',
              animation: isRunning ? 'statusPulse 2s ease-in-out infinite' : 'none',
              '@keyframes statusPulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.4 },
              },
            }}
          />
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
            {isRunning ? 'Running' : 'Stopped'}
          </Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={handleAutoTraderToggle}
            disabled={autoTraderBusy}
            sx={{
              color: isRunning ? '#ff6b6b' : '#39d98a',
              borderColor: isRunning ? 'rgba(255,107,107,0.4)' : 'rgba(57,217,138,0.4)',
              textTransform: 'none',
              paddingY: 0.25,
              paddingX: 1.5,
              minWidth: 50,
              fontSize: 12,
              '&:hover': {
                borderColor: isRunning ? '#ff6b6b' : '#39d98a',
              },
            }}
          >
            {autoTraderBusy ? '…' : isRunning ? 'Stop' : 'Start'}
          </Button>
          <IconButton
            size="small"
            onClick={handleOpenAutoTraderSettings}
            sx={{
              color: '#d1d4dc',
              border: '1px solid #2b2b43',
              borderRadius: 2,
              padding: 0.5,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ flex: 1 }} />
      </Box>

      {/* Dashboard Chart */}
      <Box sx={{ px: 1.5, pt: 1, flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <TextField
            select
            size="small"
            value={dashboardChartSymbol}
            onChange={(e) => setDashboardChartSymbol(e.target.value)}
            sx={{
              width: 120,
              '& .MuiInputBase-root': { fontSize: 12, height: 28, backgroundColor: '#1a1f2e', color: '#d1d4dc' },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: '#2b2b43' },
              '& .MuiSvgIcon-root': { color: '#7c8190', fontSize: 16 },
            }}
          >
            {SYMBOLS.map((s: string) => (
              <MenuItem key={s} value={s} sx={{ fontSize: 12 }}>{s}</MenuItem>
            ))}
          </TextField>
          {['1m', '5m', '15m', '1h', '1d'].map((tf) => (
            <Box
              key={tf}
              onClick={() => setDashboardChartInterval(tf)}
              sx={{
                fontSize: 11,
                px: 0.75,
                py: 0.25,
                borderRadius: 0.5,
                cursor: 'pointer',
                color: dashboardChartInterval === tf ? '#fff' : '#7c8190',
                backgroundColor: dashboardChartInterval === tf ? 'rgba(255,255,255,0.1)' : 'transparent',
                '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
              }}
            >
              {tf}
            </Box>
          ))}
          <Box
            onClick={() => setDashboardChartRth((v) => !v)}
            sx={{
              fontSize: 11,
              px: 0.75,
              py: 0.25,
              borderRadius: 0.5,
              cursor: 'pointer',
              ml: 1,
              color: !dashboardChartRth ? '#f5a623' : '#7c8190',
              backgroundColor: !dashboardChartRth ? 'rgba(245,166,35,0.12)' : 'transparent',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
            }}
          >
            EXT
          </Box>
          {dashboardChartGexEligible && (
            <Box
              onClick={() => setDashboardChartGex((v) => !v)}
              title={dashboardChartGex ? 'Hide Gamma Zero levels (Call Wall / Put Wall / Flip)' : 'Show Gamma Zero levels (Call Wall / Put Wall / Flip) from SPX 0DTE'}
              sx={{
                fontSize: 11,
                px: 0.75,
                py: 0.25,
                borderRadius: 0.5,
                cursor: 'pointer',
                color: dashboardChartGex ? '#b39dff' : '#7c8190',
                backgroundColor: dashboardChartGex ? 'rgba(124,77,255,0.12)' : 'transparent',
                '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
              }}
            >
              GEX
            </Box>
          )}
        </Box>
        <MiniChart symbol={dashboardChartSymbol} height={220} interval={dashboardChartInterval} useRth={dashboardChartRth} signals={chartSignals} trades={chartTrades} showGex={dashboardChartGex} />
      </Box>

      {/* Three-column layout */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        {/* Column 1: Entry Point Scan */}
        <Box
          sx={{
            width: col1Width,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #2b2b43',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              minHeight: 46,
              borderBottom: '1px solid #1f2533',
              flexShrink: 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <RadarIcon sx={{ fontSize: 16, color: '#2962ff' }} />
              <Typography sx={{ fontWeight: 600, fontSize: 13 }}>Entry Point Scan</Typography>
            </Box>
            <IconButton
              size="small"
              onClick={() => autoTraderEventsQuery.refetch()}
              sx={{ color: '#9aa0a6', padding: 0.25 }}
            >
              <RefreshIcon
                fontSize="inherit"
                sx={{
                  animation: autoTraderEventsQuery.isFetching
                    ? 'spin 1s linear infinite'
                    : 'none',
                  '@keyframes spin': {
                    '0%': { transform: 'rotate(0deg)' },
                    '100%': { transform: 'rotate(360deg)' },
                  },
                }}
              />
            </IconButton>
          </Box>

          {/* Activity status */}
          <Box
            sx={{
              padding: '6px 10px',
              borderBottom: '1px solid #1a1f2a',
              flexShrink: 0,
            }}
          >
            <Typography sx={{ fontSize: 11, color: '#7c8190' }}>
              {autoTraderQuery.data?.running
                ? (() => {
                    const idx = autoTraderQuery.data.current_index;
                    const total = autoTraderQuery.data.current_total;
                    const pct = idx && total ? Math.round((idx / total) * 100) : null;
                    const progress = idx && total ? `${idx}/${total}${pct ? ` (${pct}%)` : ''}` : '';
                    const symbol = autoTraderQuery.data.current_symbol ?? 'Idle';
                    return `Scanning: ${symbol}${progress ? ` — ${progress}` : ''}`;
                  })()
                : 'Scanner stopped'}
            </Typography>
          </Box>

          {/* Symbol scan grid */}
          {(() => {
            const scanResults = autoTraderQuery.data?.scan_results ?? {};
            const inFlight = new Set(autoTraderQuery.data?.in_flight_symbols ?? []);
            const isRunning = autoTraderQuery.data?.running ?? false;
            const statusColor: Record<string, string> = {
              pending:   '#3a3f52',
              scanning:  '#1565c0',
              signal:    '#2e7d32',
              no_signal: '#2a2e3d',
              skipped:   '#4a3f10',
              error:     '#7f1d1d',
            };
            const statusText: Record<string, string> = {
              pending:   '#6b7280',
              scanning:  '#90caf9',
              signal:    '#81c784',
              no_signal: '#4a5060',
              skipped:   '#d4a030',
              error:     '#f87171',
            };
            // Show only tickers enabled in "Optimal Premium Ranges" — these
            // are the ones the auto-trader actually scans. Fall back to the
            // full list while tickerSettings is still loading (empty object).
            const tickerCfg = (autoTraderSettingsDraft as any).tickerSettings || {};
            const tickerCfgKeys = Object.keys(tickerCfg);
            const visibleSymbols = tickerCfgKeys.length === 0
              ? SYMBOLS
              : SYMBOLS.filter((sym) => tickerCfg[sym]?.enabled !== false);
            return (
              <Box
                sx={{
                  padding: '6px 10px 8px',
                  borderBottom: '1px solid #1a1f2a',
                  flexShrink: 0,
                }}
              >
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {visibleSymbols.length === 0 && (
                    <Typography sx={{ fontSize: 10, color: '#7c8190', fontStyle: 'italic' }}>
                      No tickers enabled in Optimal Premium Ranges.
                    </Typography>
                  )}
                  {visibleSymbols.map((sym) => {
                    const info = scanResults[sym] ?? { status: 'pending' };
                    const status = info.status as string;
                    const isScanning = isRunning && inFlight.has(sym);
                    return (
                      <Box
                        key={sym}
                        title={
                          status === 'signal'
                            ? `${info.right ?? ''} ${info.strike ?? ''}`
                            : status === 'skipped'
                            ? `skipped: ${info.reason ?? ''}`
                            : status
                        }
                        sx={{
                          fontSize: 10,
                          fontWeight: 600,
                          px: '5px',
                          py: '2px',
                          borderRadius: '3px',
                          backgroundColor: isScanning ? statusColor.scanning : (statusColor[status] ?? '#2a2e3d'),
                          color: isScanning ? statusText.scanning : (statusText[status] ?? '#6b7280'),
                          letterSpacing: '0.03em',
                          animation: isScanning ? 'scanPulse 1s ease-in-out infinite' : 'none',
                          '@keyframes scanPulse': {
                            '0%, 100%': { opacity: 1 },
                            '50%': { opacity: 0.45 },
                          },
                        }}
                      >
                        {sym}
                        {status === 'signal' && info.right ? ` ${info.right[0]}` : ''}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })()}

          {/* Feed/Skips tabs + filters */}
          <Box sx={{ flexShrink: 0, borderBottom: '1px solid #1a1f2a' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0, px: '10px', pt: '4px' }}>
              {(['feed', 'skips', 'tp'] as const).map((tab) => (
                <Box
                  key={tab}
                  onClick={() => setScanFeedTab(tab)}
                  sx={{
                    fontSize: 11, fontWeight: 600, px: 1.5, py: '4px',
                    cursor: 'pointer', userSelect: 'none',
                    color: scanFeedTab === tab ? '#d1d4dc' : '#4a5060',
                    borderBottom: scanFeedTab === tab ? '2px solid #2962ff' : '2px solid transparent',
                    '&:hover': { color: '#9aa0a6' },
                  }}
                >
                  {tab === 'feed' ? 'Feed' : tab === 'skips' ? 'Skip Log' : 'TP Log'}
                </Box>
              ))}
              <Box sx={{ flex: 1 }} />
              <input
                value={scanFeedSymbol}
                onChange={(e) => setScanFeedSymbol(e.target.value.toUpperCase())}
                placeholder="SYM"
                style={{
                  width: 48, background: 'transparent',
                  border: '1px solid #2b2b43', borderRadius: 4,
                  color: '#d1d4dc', fontSize: 10, padding: '2px 6px', outline: 'none',
                }}
              />
            </Box>
            {scanFeedTab === 'tp' && (
              <Box sx={{ padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box
                  onClick={() => setTpShowAll(prev => !prev)}
                  sx={{
                    fontSize: 10, fontWeight: 600, px: '6px', py: '2px', borderRadius: '4px',
                    cursor: 'pointer', userSelect: 'none',
                    backgroundColor: tpShowAll ? '#4a506022' : 'transparent',
                    color: tpShowAll ? '#9aa0a6' : '#3a3f52',
                    border: `1px solid ${tpShowAll ? '#4a506055' : '#2b2b43'}`,
                    '&:hover': { borderColor: '#4a506088' },
                  }}
                >
                  Show Checks
                </Box>
              </Box>
            )}
            {scanFeedTab === 'feed' && (
              <Box
                sx={{
                  padding: '5px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  flexWrap: 'wrap',
                }}
              >
                {SCAN_CATEGORIES.map((cat) => {
                  const active = scanFeedCategories.has(cat.key);
                  return (
                    <Box
                      key={cat.key}
                      onClick={() => setScanFeedCategories(prev => {
                        const next = new Set(prev);
                        if (next.has(cat.key)) next.delete(cat.key); else next.add(cat.key);
                        return next;
                      })}
                      sx={{
                        fontSize: 10, fontWeight: 600, px: '6px', py: '2px', borderRadius: '4px',
                        cursor: 'pointer', userSelect: 'none',
                        backgroundColor: active ? `${cat.color}22` : 'transparent',
                        color: active ? cat.color : '#3a3f52',
                        border: `1px solid ${active ? cat.color + '55' : '#2b2b43'}`,
                        '&:hover': { borderColor: cat.color + '88' },
                      }}
                    >
                      {cat.label}
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '8px 10px',
              ...SCROLLBAR_STYLES,
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
            }}
          >
            {autoTraderEventsQuery.isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', padding: 2 }}>
                <CircularProgress size={20} />
              </Box>
            ) : !events.length ? (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No activity yet.</Typography>
            ) : scanFeedTab === 'skips' ? (
              /* Skip Log tab */
              (() => {
                const skipEvents = events
                  .filter((event) => {
                    if (event.type !== 'signal_skipped') return false;
                    if (scanFeedSymbol) {
                      const sym = (event.details as any)?.symbol;
                      if (!sym || !String(sym).toUpperCase().includes(scanFeedSymbol)) return false;
                    }
                    return true;
                  })
                  .slice()
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .slice(0, 120);
                if (!skipEvents.length) return <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No skipped signals.</Typography>;
                return skipEvents.map((event, idx) => {
                  const d = (event.details ?? {}) as Record<string, unknown>;
                  const headerParts: string[] = [];
                  if (d.symbol) headerParts.push(String(d.symbol));
                  if (d.strategy_id) headerParts.push(String(d.strategy_id));
                  if (d.signal_id) headerParts.push(String(d.signal_id));
                  const reason = d.reason_code
                    ? String(d.reason_code).replace(/_/g, ' ')
                    : 'skip';
                  const stage = d.stage ? String(d.stage).replace(/_/g, ' ') : null;
                  const metaParts: string[] = [];
                  if (d.direction) metaParts.push(String(d.direction));
                  if (stage) metaParts.push(`stage ${stage}`);
                  if (typeof d.latest_price === 'number') metaParts.push(`last ${fmtMoney(d.latest_price)}`);
                  if (typeof d.nearest_strike === 'number') metaParts.push(`near ${d.nearest_strike}`);
                  if (typeof d.candidate_count === 'number') metaParts.push(`${d.candidate_count} checked`);
                  // Rejection breakdown
                  const rejectParts: string[] = [];
                  if (typeof d.no_quote === 'number' && d.no_quote > 0) rejectParts.push(`${d.no_quote} no quote`);
                  if (typeof d.no_premium === 'number' && d.no_premium > 0) rejectParts.push(`${d.no_premium} no price`);
                  if (typeof d.range_filtered === 'number' && d.range_filtered > 0) rejectParts.push(`${d.range_filtered} out of range`);
                  if (typeof d.spread_filtered === 'number' && d.spread_filtered > 0) rejectParts.push(`${d.spread_filtered} wide spread`);
                  if (rejectParts.length) metaParts.push(rejectParts.join(', '));
                  if (typeof d.min === 'number' && typeof d.max === 'number') metaParts.push(`range ${fmtMoney(d.min)}-${fmtMoney(d.max)}`);
                  if (typeof d.last_range_premium === 'number') metaParts.push(`nearest ${fmtMoney(d.last_range_premium)}`);
                  if (typeof d.range_diff_pct === 'number') {
                    const pct = d.range_diff_pct * 100;
                    metaParts.push(`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`);
                  }
                  if (typeof d.required === 'number' && typeof d.available === 'number') {
                    metaParts.push(`need ${fmtMoney(d.required)} avail ${fmtMoney(d.available)}`);
                  }
                  if (typeof d.capital_limit === 'number') metaParts.push(`cap ${fmtMoney(d.capital_limit)}`);
                  if (d.expiration) metaParts.push(`exp ${String(d.expiration)}`);
                  if (d.right) metaParts.push(String(d.right));
                  const hasChainData = Array.isArray(d.candidate_details) && (d.candidate_details as unknown[]).length > 0;
                  return (
                    <Box
                      key={`${event.timestamp}-skip-${idx}`}
                      onClick={hasChainData ? () => setSkipChainModal(d) : undefined}
                      sx={{
                        display: 'flex', flexDirection: 'column', gap: 0.15, marginBottom: 0.6,
                        ...(hasChainData && {
                          cursor: 'pointer', borderRadius: 1, px: 0.5, mx: -0.5,
                          '&:hover': { backgroundColor: 'rgba(41,98,255,0.08)' },
                        }),
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 11,
                          color: '#c7ccd6',
                          gap: 1,
                        }}
                      >
                        <span>{headerParts.join(' • ')}</span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {reason} · {new Date(event.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })}
                        </span>
                      </Box>
                      <Typography sx={{ fontSize: 10, color: '#7c8190' }}>
                        {event.message}
                        {metaParts.length ? ` · ${metaParts.join(' • ')}` : ''}
                        {hasChainData && <span style={{ color: '#5b86e5', marginLeft: 4 }}>view chain</span>}
                      </Typography>
                    </Box>
                  );
                });
              })()
            ) : scanFeedTab === 'tp' ? (
              /* TP Log tab */
              (() => {
                const tpFilter = tpShowAll ? TP_EVENT_TYPES : TP_HIGHLIGHT_TYPES;
                const tpEvents = events
                  .filter((event) => {
                    if (!tpFilter.has(event.type)) return false;
                    if (scanFeedSymbol) {
                      const sym = (event.details as any)?.symbol;
                      if (!sym || !String(sym).toUpperCase().includes(scanFeedSymbol)) return false;
                    }
                    return true;
                  })
                  .slice()
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .slice(0, 120);
                if (!tpEvents.length) return <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No TP events yet.</Typography>;
                return tpEvents.map((event, idx) => {
                  const d = (event.details ?? {}) as Record<string, unknown>;
                  const headerParts: string[] = [];
                  if (d.symbol) headerParts.push(String(d.symbol));
                  if (d.strategy_id) headerParts.push(String(d.strategy_id));
                  if (d.right) headerParts.push(String(d.right));
                  if (typeof d.strike === 'number') headerParts.push(`${d.strike}`);
                  if (d.expiration) headerParts.push(String(d.expiration));
                  const typeLabel = event.type.replace(/_/g, ' ');
                  const metaParts: string[] = [];
                  if (typeof d.premium === 'number') metaParts.push(`prem ${fmtMoney(d.premium)}`);
                  if (typeof d.entry_price === 'number') metaParts.push(`entry ${fmtMoney(d.entry_price)}`);
                  if (typeof d.target_price === 'number') metaParts.push(`target ${fmtMoney(d.target_price)}`);
                  if (typeof d.high_water_mark === 'number') metaParts.push(`hwm ${fmtMoney(d.high_water_mark)}`);
                  if (typeof d.trail_stop_price === 'number') metaParts.push(`trail ${fmtMoney(d.trail_stop_price)}`);
                  if (typeof d.delta_pct === 'number') {
                    const pct = (d.delta_pct as number) * 100;
                    metaParts.push(`Δ ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`);
                  }
                  if (typeof d.pnl === 'number') metaParts.push(`pnl ${fmtMoney(d.pnl)}`);
                  if (typeof d.pnl_pct === 'number') metaParts.push(`${((d.pnl_pct as number) * 100).toFixed(1)}%`);
                  if (typeof d.quotes_fetched === 'number') metaParts.push(`${d.quotes_fetched}/${d.quotes_requested ?? '?'} quotes`);
                  if (typeof d.elapsed_secs === 'number') metaParts.push(`${(d.elapsed_secs as number).toFixed(1)}s`);
                  return (
                    <Box
                      key={`${event.timestamp}-tp-${idx}`}
                      sx={{ display: 'flex', flexDirection: 'column', gap: 0.15, marginBottom: 0.6 }}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#c7ccd6', gap: 1 }}>
                        <span>{headerParts.length ? headerParts.join(' • ') : event.message}</span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {typeLabel} · {new Date(event.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })}
                        </span>
                      </Box>
                      <Typography sx={{ fontSize: 10, color: '#7c8190' }}>
                        {event.message}
                        {metaParts.length ? ` · ${metaParts.join(' • ')}` : ''}
                      </Typography>
                    </Box>
                  );
                });
              })()
            ) : (
              /* Feed tab */
              <>
              {events
                .slice()
                .reverse()
                .filter((event) => {
                  if (event.type === 'signal_skipped') return false;
                  if (TP_EVENT_TYPES.has(event.type)) return false;
                  if (scanFeedSymbol) {
                    const sym = (event.details as any)?.symbol;
                    if (!sym || !String(sym).toUpperCase().includes(scanFeedSymbol)) return false;
                  }
                  const cat = SCAN_CATEGORIES.find(c => c.types.has(event.type));
                  if (cat && !scanFeedCategories.has(cat.key)) return false;
                  return true;
                })
                .slice(0, 120)
                .map((event, idx) => {
                    const details = (event.details ?? {}) as Record<string, unknown>;
                    const parts: string[] = [];
                    if (details.symbol) parts.push(String(details.symbol));
                    if (details.strategy_id) parts.push(String(details.strategy_id));
                    if (Array.isArray(details.directions) && details.directions.length) {
                      const dirSet = Array.from(new Set(details.directions as string[]));
                      parts.push(dirSet.join(', '));
                    }
                    if (details.right) parts.push(String(details.right));
                    if (typeof details.strike === 'number') parts.push(`strike ${details.strike}`);
                    if (details.expiration) parts.push(`exp ${details.expiration}`);
                    if (typeof details.premium === 'number') {
                      if (typeof details.contract_premium === 'number') {
                        parts.push(`prem ${fmtMoney(details.premium)} (${fmtMoney(details.contract_premium)})`);
                      } else {
                        parts.push(`prem ${fmtMoney(details.premium)}`);
                      }
                    }
                    if (typeof details.min === 'number' && typeof details.max === 'number') {
                      parts.push(`range ${fmtMoney(details.min)}-${fmtMoney(details.max)}`);
                    }
                    if (typeof details.range_diff_pct === 'number') {
                      const pct = (details.range_diff_pct as number) * 100;
                      parts.push(`(${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
                    }
                    if (typeof details.target_price === 'number') {
                      parts.push(`target ${fmtMoney(details.target_price)}`);
                    }
                    if (details.order_id) parts.push(`order ${details.order_id}`);
                    if (details.status) parts.push(`status ${details.status}`);
                    if (typeof details.delta_pct === 'number') {
                      const pct = (details.delta_pct as number) * 100;
                      parts.push(`Δ ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`);
                    }
                    if (typeof details.target_delta_pct === 'number') {
                      const pct = (details.target_delta_pct as number) * 100;
                      parts.push(`target Δ ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`);
                    }
                    if (details.error) parts.push(`error: ${String(details.error)}`);
                    const detailText = parts.length ? parts.join(' • ') : null;

                    return (
                      <Box
                        key={`${event.timestamp}-${event.type}-${idx}`}
                        sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, marginBottom: 0.6 }}
                      >
                        <Box
                          sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: '#9aa0a6',
                            gap: 1,
                          }}
                        >
                          <span>{event.message}</span>
                          <span>
                            {new Date(event.timestamp * 1000).toLocaleTimeString('en-US', {
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'America/New_York',
                            })}
                          </span>
                        </Box>
                        {detailText && (
                          <Typography sx={{ fontSize: 10, color: '#6f7688' }}>{detailText}</Typography>
                        )}
                      </Box>
                    );
                  })}
              </>
            )}
          </Box>
        </Box>

        {/* Drag handle between col1 and col2 */}
        <Box
          onMouseDown={() => setCol1Resizing(true)}
          sx={{
            width: 5,
            flexShrink: 0,
            cursor: 'col-resize',
            backgroundColor: col1Resizing ? 'rgba(41,98,255,0.4)' : 'transparent',
            '&:hover': { backgroundColor: 'rgba(41,98,255,0.2)' },
            transition: 'background-color 0.15s',
            zIndex: 1,
          }}
        />

        {/* Column 2: Open Positions */}
        <Box
          sx={{
            width: col2Width,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #2b2b43',
            overflow: 'hidden',
            transition: 'background-color 0.3s ease',
            backgroundColor: openPosBlink ? 'rgba(41,98,255,0.08)' : 'transparent',
          }}
        >
          {/* Header */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              minHeight: 46,
              borderBottom: '1px solid #1f2533',
              flexShrink: 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <CandlestickChartIcon sx={{ fontSize: 16, color: '#2962ff' }} />
              <Typography
                onClick={() => setOpenPosModalOpen(true)}
                sx={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', '&:hover': { color: '#5e9cff' } }}
              >Open Positions</Typography>
              {autoTraderSettingsQuery.data?.settings?.profitTargetPct != null && (
                <Chip
                  label={`TP ${(autoTraderSettingsQuery.data.settings.profitTargetPct * 100).toFixed(0)}%`}
                  size="small"
                  sx={{
                    height: 16,
                    fontSize: 9,
                    fontWeight: 600,
                    backgroundColor: 'rgba(41,98,255,0.15)',
                    color: '#5e9cff',
                    '& .MuiChip-label': { px: 0.75, py: 0 }
                  }}
                />
              )}
              {(autoTraderSettingsQuery.data?.settings as any)?.useTrailingStop && (
                <Chip
                  label={`Trail ${(((autoTraderSettingsQuery.data?.settings as any)?.trailingStopPct ?? 0) * 100).toFixed(2)}%`}
                  size="small"
                  sx={{
                    height: 16,
                    fontSize: 9,
                    fontWeight: 600,
                    backgroundColor: 'rgba(57,217,138,0.15)',
                    color: '#39d98a',
                    '& .MuiChip-label': { px: 0.75, py: 0 }
                  }}
                />
              )}
              {(() => {
                const isRunning = autoTraderQuery.data?.running ?? false;
                const allowClose = (autoTraderSettingsQuery.data?.settings as any)?.allowClosePositions ?? false;
                const hasPositions = openPositions.length > 0;
                const isMonitoring = isRunning && allowClose && hasPositions;

                return isMonitoring ? (
                  <Chip
                    label="Monitoring"
                    size="small"
                    sx={{
                      height: 16,
                      fontSize: 9,
                      fontWeight: 600,
                      backgroundColor: 'rgba(57,217,138,0.15)',
                      color: '#39d98a',
                      '& .MuiChip-label': { px: 0.75, py: 0 },
                      animation: 'pulse 2s ease-in-out infinite',
                      '@keyframes pulse': {
                        '0%, 100%': { opacity: 1 },
                        '50%': { opacity: 0.6 }
                      }
                    }}
                  />
                ) : null;
              })()}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              {(() => {
                const parts: string[] = [];
                // IB positions API latency
                const posLatency = fetchLatencies.current['ib-positions'];
                if (posLatency != null) parts.push(`pos ${posLatency}ms`);
                // Orders API latency
                const ordLatency = fetchLatencies.current['orders'];
                if (ordLatency != null) parts.push(`log ${ordLatency}ms`);
                // Last TP batch fetch from auto-trader events
                const batchEvts = events
                  .filter((e: any) => e.type === 'tp_batch_fetch');
                const batchEvt = batchEvts[batchEvts.length - 1];
                if (batchEvt?.details?.elapsed_secs != null) {
                  parts.push(`quotes ${(batchEvt.details.elapsed_secs as number).toFixed(1)}s`);
                }
                // Staleness
                if (ibPositionsQuery.dataUpdatedAt) {
                  const ago = Math.round((Date.now() - ibPositionsQuery.dataUpdatedAt) / 1000);
                  parts.push(`${ago}s ago`);
                }
                return parts.length > 0 ? (
                  <span style={{ fontSize: 9, color: '#5a5f6b', fontWeight: 400, whiteSpace: 'nowrap' }}>
                    {parts.join(' · ')}
                  </span>
                ) : null;
              })()}
              <Chip
                label="Today"
                size="small"
                onClick={() => setOpenTodayOnly(prev => !prev)}
                sx={{
                  height: 22,
                  fontSize: 11,
                  fontWeight: 600,
                  backgroundColor: openTodayOnly ? 'rgba(41, 98, 255, 0.2)' : 'transparent',
                  color: openTodayOnly ? '#2962ff' : '#787b86',
                  border: openTodayOnly ? '1px solid rgba(41, 98, 255, 0.4)' : '1px solid #2b2b43',
                  cursor: 'pointer',
                  '&:hover': { backgroundColor: openTodayOnly ? 'rgba(41, 98, 255, 0.3)' : 'rgba(255,255,255,0.05)' },
                }}
              />
            </Box>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '10px 12px',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
            }}
          >
            {/* Open Positions list */}
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', marginBottom: 0.5 }}>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                {(() => {
                  const displayList = openTodayOnly ? todayOpenPositions : openPositions;
                  const count = displayList.length;
                  const capital = displayList.reduce((acc: number, order: any) => acc + (order.price ?? 0) * 100 * (order.quantity ?? 1), 0);

                  return count > 0
                    ? openTodayOnly
                      ? `${count} open today · ${fmtMoney(capital)}`
                      : `${openPositions.length} open (${todayOpenPositions.length} today) · ${fmtMoney(capital)} (${fmtMoney(todayOpenPositions.reduce((acc: number, o: any) => acc + (o.price ?? 0) * 100 * (o.quantity ?? 1), 0))} today)`
                    : openTodayOnly ? 'No positions opened today' : '0 open · $0.00';
                })()}
              </Typography>
              {(() => {
                const spent = autoTraderQuery.data?.capital_spent ?? 0;
                const limitEnabled = (autoTraderSettingsQuery.data?.settings as any)?.capitalLimitEnabled;
                const limit = Number((autoTraderSettingsQuery.data?.settings as any)?.capitalLimit ?? 0);
                const pct = limit > 0 ? spent / limit * 100 : null;
                const remaining = limit > 0 ? limit - spent : null;
                const overLimit = remaining != null && remaining < 0;
                return (
                  <Typography sx={{ fontSize: 10, color: '#5c6370', lineHeight: 1.4 }}>
                    {'cap '}
                    <span style={{ color: overLimit ? '#ff6b6b' : '#9aa0a6' }}>{fmtMoney(spent)}</span>
                    {limitEnabled && limit > 0 && (
                      <>
                        {' / '}
                        <span>{fmtMoney(limit)}</span>
                        {pct != null && (
                          <span style={{ color: overLimit ? '#ff6b6b' : pct >= 80 ? '#ffb74d' : '#9aa0a6' }}>
                            {` (${pct.toFixed(0)}%)`}
                          </span>
                        )}
                        {remaining != null && (
                          <span style={{ color: overLimit ? '#ff6b6b' : '#5c6370' }}>
                            {overLimit ? ` · $${Math.abs(remaining).toFixed(2)} over` : ` · ${fmtMoney(remaining)} left`}
                          </span>
                        )}
                      </>
                    )}
                  </Typography>
                );
              })()}
              {(() => {
                const dailyLoss = autoTraderQuery.data?.daily_realized_loss ?? 0;
                const limit = Number((autoTraderSettingsQuery.data?.settings as any)?.maxDailyLossDollar ?? 0);
                if (limit <= 0) return null;
                const overLimit = Math.abs(dailyLoss) >= limit;
                return (
                  <Typography sx={{ fontSize: 10, color: '#5c6370', lineHeight: 1.4 }}>
                    {'loss '}
                    <span style={{ color: overLimit ? '#ff6b6b' : dailyLoss < 0 ? '#ffb74d' : '#9aa0a6' }}>
                      {dailyLoss < 0 ? `-$${Math.abs(dailyLoss).toFixed(2)}` : '$0.00'}
                    </span>
                    {' / '}
                    <span>${limit.toFixed(2)}</span>
                    {overLimit && <span style={{ color: '#ff6b6b' }}> STOPPED</span>}
                  </Typography>
                );
              })()}
            </Box>
          {/* Open Positions actions menu */}
          <Menu
            anchorEl={openPosMenuAnchor?.el}
            open={Boolean(openPosMenuAnchor)}
            onClose={() => setOpenPosMenuAnchor(null)}
            slotProps={{ paper: { sx: { backgroundColor: '#1a1f2e', border: '1px solid #2b2b43', minWidth: 140 } } }}
          >
            <MenuItem
              disabled={openPosMenuAnchor?.order && closingPositionKeys.has(`local-${openPosMenuAnchor.order.position_id ?? openPosMenuAnchor.order.symbol}`)}
              onClick={() => {
                if (openPosMenuAnchor) handleCloseOpenLogPosition(openPosMenuAnchor.order);
                setOpenPosMenuAnchor(null);
              }}
              sx={{ fontSize: 12, color: '#ff6b6b' }}
            >
              Sell
            </MenuItem>
            {openPosMenuAnchor?.order?.position_id && (
              <MenuItem
                onClick={() => {
                  const order = openPosMenuAnchor!.order;
                  setOpenPosMenuAnchor(null);
                  openConfirmDialog(
                    'Flush Position',
                    `Remove ${order.symbol} ${order.right ?? ''} ${order.strike ?? ''} from auto-trader tracking? Use this only if the position was already closed outside the auto-trader.`,
                    async () => {
                      try {
                        await flushTrackedPosition(order.position_id!);
                      } catch (err: any) {
                        if (err?.response?.status !== 404) throw err;
                      }
                      await ordersQuery.refetch();
                    }
                  );
                }}
                sx={{ fontSize: 12, color: '#9aa0a6' }}
              >
                Flush
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                if (openPosMenuAnchor) {
                  const order = openPosMenuAnchor.order;
                  setCustomTpDialog({ order });
                  setCustomTpValues({
                    profitTargetPct: 8,
                    useTrailingStop: true,
                    trailingStopPct: 3
                  });
                }
                setOpenPosMenuAnchor(null);
              }}
              sx={{ fontSize: 12, color: '#90caf9' }}
            >
              Set Custom TP
            </MenuItem>
          </Menu>

            {Object.entries(openByDate).map(([dateKey, orders]) => (
                <Box key={dateKey}>
                  <Typography sx={{ fontSize: 10, fontWeight: 600, color: '#7c8190', marginBottom: 0.5, marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {dateKey}
                  </Typography>
                  {orders.map((order) => {
                    const holdMin = Math.floor((Date.now() / 1000 - order.timestamp) / 60);
                    const holdDays = Math.floor(holdMin / (60 * 24));
                    const holdHours = Math.floor((holdMin % (60 * 24)) / 60);
                    const holdRemainingMin = holdMin % 60;
                    const holdTimeStr = holdDays > 0
                      ? `${holdDays}d ${holdHours}h`
                      : holdHours > 0
                        ? `${holdHours}h ${holdRemainingMin}m`
                        : `${holdMin}m`;
                    const ibPos = ibPositionMap.get(`${order.symbol}|${order.right}|${order.strike}`) ?? null;
                    const currentPremium = ibPos?.market_price ?? null;
                    const targetPrice = order.target_price ?? null;

                    return (
                  <Box
                    key={`${order.position_id ?? order.timestamp}-${order.symbol}`}
                    onClick={() => setPositionDetailModal({ order, ibPos })}
                    sx={{
                      padding: '6px 8px',
                      marginBottom: 0.75,
                      borderRadius: 1,
                      cursor: 'pointer',
                      border: (ibPositionsQuery.data?.positions != null && ibPos == null) ? '1px solid #3a2a1a' : '1px solid #1f2533',
                      backgroundColor: (ibPositionsQuery.data?.positions != null && ibPos == null) ? 'rgba(255,120,0,0.04)' : 'rgba(255,255,255,0.02)',
                      '&:hover': { borderColor: '#3b4a6b' },
                      animation: (order.position_id && flashingPositionIds.has(order.position_id)) ? 'cardFlash 0.8s ease-in-out' : 'none',
                      '@keyframes cardFlash': {
                        '0%, 100%': { backgroundColor: (ibPositionsQuery.data?.positions != null && ibPos == null) ? 'rgba(255,120,0,0.04)' : 'rgba(255,255,255,0.02)' },
                        '50%': { backgroundColor: 'rgba(57,217,138,0.15)' }
                      }
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 600, color: '#d1d4dc', marginBottom: 0.25 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <span>{order.symbol} <span style={{ color: order.right === 'C' ? '#4fc3f7' : '#ff8a80', fontWeight: 700 }}>{order.right ?? ''}</span> {order.strike ?? ''}</span>
                        {ibPositionsQuery.data?.positions != null && ibPos == null && (
                          <Chip label="not in IB" size="small" sx={{ height: 14, fontSize: 9, backgroundColor: 'rgba(255,120,0,0.15)', color: '#e08030', '& .MuiChip-label': { px: 0.75 } }} />
                        )}
                        {order.signal_id && tpOverridesQuery.data?.overrides?.[order.signal_id] && (
                          <Chip label="Custom TP" size="small" sx={{ height: 14, fontSize: 9, backgroundColor: 'rgba(144,202,249,0.15)', color: '#90caf9', '& .MuiChip-label': { px: 0.75 } }} />
                        )}
                        {(() => {
                          const eff = getEffectiveTpSettings(order, autoTraderSettingsQuery.data?.settings, (autoTraderSettingsQuery.data?.settings as any)?.strategySettings, tpOverridesQuery.data?.overrides);
                          const highWaterMark = order.high_water_mark ?? null;
                          const isTrailing = eff.useTrailingStop && highWaterMark != null && targetPrice != null && highWaterMark >= targetPrice;
                          return isTrailing ? (
                            <Chip label="Trailing" size="small" sx={{ height: 14, fontSize: 9, backgroundColor: 'rgba(57,217,138,0.15)', color: '#39d98a', '& .MuiChip-label': { px: 0.75 } }} />
                          ) : null;
                        })()}
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <span style={{ fontSize: 11, color: '#9aa0a6', fontWeight: 400 }}>
                          {order.timestamp
                            ? new Date(order.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
                            : ''}
                        </span>
                        <IconButton
                          size="small"
                          onClick={(e) => { e.stopPropagation(); setOpenPosMenuAnchor({ el: e.currentTarget, order }); }}
                          sx={{ color: '#9aa0a6', padding: 0.25 }}
                        >
                          <MoreVertIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Box>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9aa0a6' }}>
                      <span>{order.strategy_id ? order.strategy_id.substring(0, 10) : '—'}</span>
                      <span>{order.action} {order.quantity} @ {order.price} · {holdTimeStr} hold</span>
                    </Box>
                    <Box sx={{ fontSize: 10, color: '#7c8190', marginTop: 0.25 }}>
                      {order.expiration ? `exp ${order.expiration}` : ''}
                      {targetPrice != null && (
                        <span style={{ marginLeft: 6 }}>
                          tp {targetPrice.toFixed(2)}
                          {currentPremium != null && (
                            <span style={{ marginLeft: 4, color: currentPremium >= targetPrice ? '#39d98a' : '#c7ccd6' }}>
                              · now {currentPremium < 0.01 ? currentPremium.toFixed(4) : currentPremium.toFixed(2)}
                            </span>
                          )}
                        </span>
                      )}
                    </Box>
                    {(() => {
                      const eff = getEffectiveTpSettings(order, autoTraderSettingsQuery.data?.settings, (autoTraderSettingsQuery.data?.settings as any)?.strategySettings, tpOverridesQuery.data?.overrides);
                      const effectiveTargetPrice = order.price * (1 + eff.profitTargetPct);
                      const stopLossPrice = eff.stopLossPct > 0 ? order.price * (1 - eff.stopLossPct) : undefined;
                      const hwm = order.high_water_mark ?? undefined;
                      const trailStopPrice = eff.useTrailingStop && hwm != null && hwm >= effectiveTargetPrice
                        ? hwm * (1 - eff.trailingStopPct)
                        : undefined;
                      // TP settings summary line
                      const trailActive = eff.useTrailingStop && hwm != null && hwm >= effectiveTargetPrice;
                      const parts: string[] = [];
                      parts.push(`TP ${(eff.profitTargetPct * 100).toFixed(0)}%`);
                      if (eff.stopLossPct > 0) parts.push(`SL ${(eff.stopLossPct * 100).toFixed(0)}%`);
                      if (eff.useTrailingStop) {
                        if (trailActive) {
                          parts.push(`trail ${(eff.trailingStopPct * 100).toFixed(0)}% ACTIVE`);
                        } else {
                          parts.push(`trail ${(eff.trailingStopPct * 100).toFixed(0)}%`);
                        }
                      }
                      return (
                        <>
                          <Box sx={{ fontSize: 9, color: '#5c6370', marginTop: 0.25 }}>
                            {parts.map((p, i) => (
                              <span key={i}>
                                {i > 0 && ' · '}
                                {p.includes('ACTIVE') ? (
                                  <span style={{ color: '#39d98a', fontWeight: 600 }}>{p}</span>
                                ) : p}
                              </span>
                            ))}
                          </Box>
                          {currentPremium != null && targetPrice != null && (
                            <PriceRangeBar
                              entryPrice={order.price}
                              targetPrice={effectiveTargetPrice}
                              stopLossPrice={stopLossPrice ?? 0}
                              currentPremium={currentPremium}
                              highWaterMark={hwm}
                              trailStopPrice={trailStopPrice}
                              width={220}
                            />
                          )}
                        </>
                      );
                    })()}
                    {ibPos != null && (ibPos.market_value != null || ibPos.unrealized_pnl != null) && (
                      <Box sx={{ fontSize: 10, color: '#7c8190', marginTop: 0.25, display: 'flex', gap: 1 }}>
                        {ibPos.market_value != null && (
                          <span>MV <strong style={{ color: '#9aa0a6' }}>{fmtMoney(ibPos.market_value)}</strong></span>
                        )}
                        {ibPos.unrealized_pnl != null && (
                          <span>
                            P&L{' '}
                            <strong style={{ color: ibPos.unrealized_pnl >= 0 ? '#39d98a' : '#ff6b6b' }}>
                              {fmtPnl(ibPos.unrealized_pnl)}
                              {ibPos.pnl_pct != null && ` (${ibPos.pnl_pct >= 0 ? '+' : ''}${ibPos.pnl_pct.toFixed(1)}%)`}
                            </strong>
                          </span>
                        )}
                      </Box>
                    )}
                  </Box>
                    );
                  })}
                </Box>
              ))}
            {(ibPositionsQuery.data?.positions ?? []).flatMap((ibPos) => {
              const trackedQty = openPositions
                .filter((o: any) => o.symbol === ibPos.symbol && o.right === ibPos.right && o.strike === ibPos.strike)
                .reduce((sum: number, o: any) => sum + (o.quantity ?? 1), 0);
              const excess = Math.floor((ibPos.quantity ?? 1) - trackedQty);
              if (excess <= 0) return [];
              return [(
                <Box
                  key={`ib-untracked-${ibPos.symbol}-${ibPos.right}-${ibPos.strike}`}
                  sx={{ padding: '6px 8px', marginBottom: 0.75, borderRadius: 1, border: '1px solid rgba(255,98,255,0.25)', backgroundColor: 'rgba(255,0,255,0.04)' }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 600, color: '#d1d4dc', marginBottom: 0.25 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <span>{ibPos.symbol} {ibPos.right ?? ''} {ibPos.strike ?? ''} × {excess}</span>
                      <Chip label="IB only" size="small" sx={{ height: 14, fontSize: 9, backgroundColor: 'rgba(255,0,255,0.15)', color: '#cc66cc', '& .MuiChip-label': { px: 0.75 } }} />
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => handleClosePosition({ ...ibPos, quantity: excess })}
                      sx={{ fontSize: 9, py: 0, px: 0.75, minWidth: 0, height: 18, borderColor: '#cc66cc', color: '#cc66cc', '&:hover': { borderColor: '#ff88ff', color: '#ff88ff', backgroundColor: 'rgba(255,0,255,0.08)' } }}
                    >
                      Close
                    </Button>
                  </Box>
                  <Box sx={{ fontSize: 11, color: '#9aa0a6' }}>
                    untracked contract · close fill unconfirmed
                  </Box>
                  {(ibPos.market_value != null || ibPos.unrealized_pnl != null) && (
                    <Box sx={{ fontSize: 10, color: '#7c8190', marginTop: 0.25, display: 'flex', gap: 1 }}>
                      {ibPos.market_value != null && (
                        <span>MV <strong style={{ color: '#9aa0a6' }}>{fmtMoney(ibPos.market_value)}</strong></span>
                      )}
                      {ibPos.unrealized_pnl != null && (
                        <span>P&L <strong style={{ color: ibPos.unrealized_pnl >= 0 ? '#39d98a' : '#ff6b6b' }}>{fmtPnl(ibPos.unrealized_pnl)}</strong></span>
                      )}
                    </Box>
                  )}
                </Box>
              )];
            })}
            {!ordersQuery.data?.open_positions?.length && !ibPositionsQuery.data?.positions?.length && (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No open positions.</Typography>
            )}
            {openTodayOnly && (ordersQuery.data?.open_positions?.length ?? 0) > 0 && (() => {
              const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
              const hasTodayPositions = (ordersQuery.data?.open_positions ?? []).some((o) => {
                const dateKey = o.timestamp
                  ? new Date(o.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
                  : '';
                return dateKey === todayStr;
              });
              return !hasTodayPositions ? (
                <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No positions opened today.</Typography>
              ) : null;
            })()}
          </Box>
        </Box>

        {/* Drag handle between col2 and col3 */}
        <Box
          onMouseDown={() => setCol2Resizing(true)}
          sx={{
            width: 5,
            flexShrink: 0,
            cursor: 'col-resize',
            backgroundColor: col2Resizing ? 'rgba(41,98,255,0.4)' : 'transparent',
            '&:hover': { backgroundColor: 'rgba(41,98,255,0.2)' },
            transition: 'background-color 0.15s',
            zIndex: 1,
          }}
        />

        {/* Column 3: Closed Positions */}
        <Box
          sx={{
            width: col3Width,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #2b2b43',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              minHeight: 46,
              borderBottom: '1px solid #1f2533',
              flexShrink: 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <MonetizationOnIcon sx={{ fontSize: 16, color: '#2962ff' }} />
              <Typography
                onClick={() => setClosedPosModalOpen(true)}
                sx={{ fontWeight: 600, fontSize: 13, cursor: 'pointer', '&:hover': { color: '#5e9cff' } }}
              >Closed Positions</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Chip
                label="All"
                size="small"
                onClick={() => setClosedFromDate(null)}
                sx={{
                  height: 22,
                  fontSize: 11,
                  fontWeight: 600,
                  backgroundColor: closedFromDate === null ? 'rgba(41, 98, 255, 0.2)' : 'transparent',
                  color: closedFromDate === null ? '#2962ff' : '#787b86',
                  border: closedFromDate === null ? '1px solid rgba(41, 98, 255, 0.4)' : '1px solid #2b2b43',
                  cursor: 'pointer',
                  '&:hover': { backgroundColor: closedFromDate === null ? 'rgba(41, 98, 255, 0.3)' : 'rgba(255,255,255,0.05)' },
                }}
              />
              <input
                type="date"
                value={closedFromDate ?? ''}
                onChange={(e) => setClosedFromDate(e.target.value || null)}
                style={{
                  height: 22,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '0 6px',
                  border: closedFromDate ? '1px solid rgba(41, 98, 255, 0.4)' : '1px solid #2b2b43',
                  borderRadius: 11,
                  backgroundColor: closedFromDate ? 'rgba(41, 98, 255, 0.2)' : 'transparent',
                  color: closedFromDate ? '#2962ff' : '#787b86',
                  outline: 'none',
                  cursor: 'pointer',
                  colorScheme: 'dark',
                }}
              />
            </Box>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '10px 12px',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
            }}
          >
            {/* Closed positions summary */}
            <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
              {(() => {
                const allOrders = ordersQuery.data?.orders ?? [];
                const openTsMap: Record<string, number> = {};
                for (const e of allOrders) {
                  if (e.type === 'OPEN' && e.position_id && e.timestamp) openTsMap[e.position_id] = e.timestamp;
                }
                const allClosed = allOrders.filter((o) => o.type === 'CLOSE' && (!o.mode || o.mode === currentMode));
                const filtered = closedFromDate
                  ? allClosed.filter((o) => {
                      const openTs = o.position_id ? openTsMap[o.position_id] : null;
                      const ts = openTs ?? o.timestamp;
                      if (!ts) return false;
                      const nyDate = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
                      return nyDate >= closedFromDate;
                    })
                  : allClosed;
                const count = filtered.length;
                const pnl = filtered.reduce((acc, o) => acc + (o.pnl ?? 0), 0);
                const label = closedFromDate
                  ? `since ${new Date(closedFromDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : '';

                return count > 0
                  ? `${count} closed${label ? ` ${label}` : ''} · ${fmtPnl(pnl)}`
                  : closedFromDate ? `No positions closed ${label}` : '0 closed · $0.00';
              })()}
            </Typography>

            {ordersQuery.isLoading ? (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
            ) : ordersQuery.data?.orders?.some((o) => o.type === 'CLOSE') ? (
              (() => {
                const openTsByPid: Record<string, number> = {};
                for (const e of ordersQuery.data.orders) {
                  if (e.type === 'OPEN' && e.position_id && e.timestamp) {
                    openTsByPid[e.position_id] = e.timestamp;
                  }
                }

                // Get closed positions, filtered by mode + date picker (shows trades opened on or after selected date)
                const closedOrders = ordersQuery.data.orders
                  .filter((o) => {
                    if (o.type !== 'CLOSE') return false;
                    if (o.mode && o.mode !== currentMode) return false;
                    if (!closedFromDate) return true;
                    // Filter by the OPEN timestamp of this position
                    const openTs = o.position_id ? openTsByPid[o.position_id] : null;
                    const ts = openTs ?? o.timestamp;
                    if (!ts) return false;
                    const nyDate = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
                    return nyDate >= closedFromDate;
                  })
                  .slice()
                  .reverse()
                  .slice(0, 100);

                return closedOrders.map((order) => {
                  const openTs = order.position_id ? openTsByPid[order.position_id] : null;
                  const holdMin = openTs ? Math.floor((order.timestamp - openTs) / 60) : null;
                  return (
                    <Box
                      key={`${order.timestamp}-${order.symbol}-${order.action}`}
                      onClick={() => handleShowPositionHistory(order)}
                      sx={{
                        padding: '6px 8px',
                        marginBottom: 0.75,
                        borderRadius: 1,
                        border: '1px solid #1f2533',
                        backgroundColor: 'rgba(255,255,255,0.02)',
                        cursor: 'pointer',
                        '&:hover': {
                          backgroundColor: 'rgba(255,255,255,0.04)',
                          borderColor: '#2b2b43',
                        },
                      }}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 0.25 }}>
                        <span style={{ color: '#d1d4dc' }}>{order.symbol} <span style={{ color: order.right === 'C' ? '#4fc3f7' : '#ff8a80', fontWeight: 700 }}>{order.right ?? ''}</span> {order.strike ?? ''}</span>
                        <span style={{ color: order.pnl != null && order.pnl >= 0 ? '#39d98a' : '#ff6b6b' }}>
                          {order.pnl != null ? fmtPnl(order.pnl) : '—'}
                        </span>
                      </Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9aa0a6' }}>
                        <span>{order.strategy_id ?? '—'}</span>
                        <span>
                          {order.action} {order.quantity} @ {order.price}
                          {order.timestamp
                            ? ` · ${new Date(order.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })}`
                            : ''}
                          {holdMin != null ? ` · ${holdMin}m` : ''}
                        </span>
                      </Box>
                      {order.pnl_pct != null && (
                        <Box sx={{ fontSize: 10, color: order.pnl_pct >= 0 ? '#39d98a' : '#ff6b6b', marginTop: 0.25 }}>
                          {(order.pnl_pct * 100).toFixed(1)}%
                          {order.expiration ? ` · exp ${order.expiration}` : ''}
                        </Box>
                      )}
                      {order.close_reason && (
                        <Box sx={{ fontSize: 9, color: '#7c8190', marginTop: 0.25 }}>
                          {order.close_reason}
                        </Box>
                      )}
                    </Box>
                  );
                });
              })()
            ) : (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No closed positions yet.</Typography>
            )}

          </Box>
        </Box>

        {/* Drag handle between col3 and col4 */}
        <Box
          onMouseDown={() => setCol3Resizing(true)}
          sx={{
            width: 5,
            flexShrink: 0,
            cursor: 'col-resize',
            backgroundColor: col3Resizing ? 'rgba(41,98,255,0.4)' : 'transparent',
            '&:hover': { backgroundColor: 'rgba(41,98,255,0.2)' },
            transition: 'background-color 0.15s',
            zIndex: 1,
          }}
        />

        {/* Column 3: IBKR Account */}
        <Box
          sx={{
            flex: 1,
            minWidth: 240,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              minHeight: 46,
              borderBottom: '1px solid #1f2533',
              flexShrink: 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <img src="/ibkr-icon.webp" alt="IBKR" style={{ width: 16, height: 16, borderRadius: 4 }} />
              <Typography sx={{ fontWeight: 600, fontSize: 13 }}>IBKR Account</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <IconButton
                size="small"
                onClick={async () => {
                  await Promise.all([
                    ibAccountSummaryQuery.refetch(),
                    fetchIbPositions(true).then(data =>
                      queryClient.setQueryData(['ib-positions'], data)
                    ),
                  ]);
                }}
                sx={{ color: '#9aa0a6', padding: 0.25 }}
              >
                <RefreshIcon
                  fontSize="inherit"
                  sx={{
                    animation: (ibAccountSummaryQuery.isFetching || ibPositionsQuery.isFetching) ? 'spin 1s linear infinite' : 'none',
                    '@keyframes spin': {
                      '0%': { transform: 'rotate(0deg)' },
                      '100%': { transform: 'rotate(360deg)' },
                    },
                  }}
                />
              </IconButton>
            </Box>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '10px 12px',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
            }}
          >
            {/* Account summary card */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 1.5,
                padding: '6px 10px',
                borderRadius: 1,
                border: '1px solid #1f2533',
                backgroundColor: 'rgba(255,255,255,0.02)',
              }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Available funds</Typography>
                <Typography sx={{ fontSize: 10, color: '#7c8190' }}>Total cash</Typography>
                <Typography sx={{ fontSize: 10, color: '#7c8190' }}>Settled cash (GFV safe)</Typography>
                <Typography sx={{ fontSize: 10, color: '#7c8190' }}>Capital limit (settings)</Typography>
                <Typography sx={{ fontSize: 10, color: '#7c8190' }}>Account</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
                  {ibAccountSummaryQuery.isLoading
                    ? 'Loading…'
                    : ibAccountSummaryQuery.isError
                      ? 'Unavailable'
                      : ibAccountSummaryQuery.data?.available_funds != null
                        ? `${ibAccountSummaryQuery.data.currency ?? 'USD'} ${ibAccountSummaryQuery.data.available_funds.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'}
                </Typography>
                <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                  {ibAccountSummaryQuery.isLoading
                    ? 'Loading…'
                    : ibAccountSummaryQuery.data?.total_cash_value != null
                      ? `${ibAccountSummaryQuery.data.currency ?? 'USD'} ${ibAccountSummaryQuery.data.total_cash_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : '—'}
                </Typography>
                <Typography sx={{ fontSize: 10, color: ibAccountSummaryQuery.data?.settle_cash != null ? '#4caf50' : '#7c8190' }}>
                  {ibAccountSummaryQuery.isLoading
                    ? 'Loading…'
                    : ibAccountSummaryQuery.data?.settle_cash != null
                      ? `${ibAccountSummaryQuery.data.currency ?? 'USD'} ${ibAccountSummaryQuery.data.settle_cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : 'N/A (paper acct)'}
                </Typography>
                <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                  {autoTraderSettingsQuery.isLoading
                    ? 'Loading…'
                    : (autoTraderSettingsQuery.data?.settings as any)?.capitalLimitEnabled
                      ? fmtMoney((autoTraderSettingsQuery.data!.settings as any).capitalLimit)
                      : 'Disabled'}
                </Typography>
                <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                  {ibAccountSummaryQuery.isLoading
                    ? 'Loading…'
                    : ibAccountSummaryQuery.data?.account || '—'}
                </Typography>
              </Box>
            </Box>

            {/* IBKR Positions */}
            {positionCloseError && (
              <Typography
                onClick={() => setPositionCloseError(null)}
                sx={{ fontSize: 11, color: '#ff6b6b', backgroundColor: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.3)', borderRadius: 1, padding: '4px 8px', marginBottom: 1, cursor: 'pointer' }}
              >
                {positionCloseError} (click to dismiss)
              </Typography>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0.5 }}>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                IBKR Positions ({ibPositionsQuery.data?.positions?.length ?? 0})
              </Typography>
              {ibPositionsQuery.data?.positions?.length ? (
                <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setHideClosingPositions(v => !v)}
                    sx={{
                      fontSize: 10,
                      paddingX: 0.75,
                      paddingY: 0,
                      minWidth: 0,
                      flexShrink: 0,
                      color: hideClosingPositions ? '#f5a623' : '#787b86',
                      borderColor: hideClosingPositions ? 'rgba(245,166,35,0.5)' : 'rgba(120,123,134,0.3)',
                      textTransform: 'none',
                      lineHeight: '20px',
                      '&:hover': { borderColor: hideClosingPositions ? 'rgba(245,166,35,0.8)' : 'rgba(120,123,134,0.6)' },
                    }}
                  >
                    {hideClosingPositions ? 'Show All' : 'Hide Closing'}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={closingAllPositions}
                    onClick={handleCloseAllPositions}
                    sx={{
                      fontSize: 10,
                      paddingX: 0.75,
                      paddingY: 0,
                      minWidth: 0,
                      flexShrink: 0,
                      color: '#ff6b6b',
                      borderColor: 'rgba(255,107,107,0.4)',
                      textTransform: 'none',
                      lineHeight: '20px',
                      '&:hover': { borderColor: '#ff6b6b' },
                    }}
                  >
                    {closingAllPositions ? '…' : 'Close All'}
                  </Button>
                </Box>
              ) : null}
            </Box>
            {ibPositionsQuery.isLoading ? (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
            ) : ibPositionsQuery.data?.positions?.length ? (
              (() => {
                const tpByKey: Record<string, number> = {};
                for (const op of ordersQuery.data?.open_positions ?? []) {
                  if (op.target_price != null) {
                    tpByKey[`${op.symbol}-${op.right ?? ''}-${op.strike ?? ''}`] = op.target_price;
                  }
                }
                // Normalize expiration to YYYYMMDD (no dashes):
                // IBKR returns "20260221"; local log stores "2026-02-21".
                const normExp = (e: string | null | undefined) => (e ?? '').replace(/-/g, '');
                // Build lookup sets for ghost detection.
                // A position is a ghost if the auto-trader has a RECENT CLOSE entry
                // (within the last 8 hours) for it but it is no longer tracked as open
                // locally — meaning the close order was submitted but IBKR hasn't cleared
                // the position yet. Older CLOSE entries are historical trades, not
                // pending fills, so we exclude them to avoid false positives.
                const eightHoursAgo = Date.now() / 1000 - 8 * 3600;
                const closingLogKeys = new Set<string>(
                  (ordersQuery.data?.orders ?? [])
                    .filter(o => o.right != null && o.strike != null && (o.timestamp ?? 0) > eightHoursAgo)
                    .map(o => `${o.symbol}-${o.right ?? ''}-${o.strike ?? ''}-${normExp(o.expiration)}`)
                );
                const localOpenKeys = new Set<string>(
                  (ordersQuery.data?.open_positions ?? [])
                    .filter(o => o.right != null && o.strike != null)
                    .map(o => `${o.symbol}-${o.right ?? ''}-${o.strike ?? ''}-${normExp(o.expiration)}`)
                );
                // Build contract-key → OPEN timestamp map for sort order
                const openTsByKey: Record<string, number> = {};
                for (const op of ordersQuery.data?.open_positions ?? []) {
                  const k = `${op.symbol}-${op.right ?? ''}-${op.strike ?? ''}-${normExp(op.expiration)}`;
                  if (op.timestamp != null) openTsByKey[k] = op.timestamp;
                }

                const rawPositions = hideClosingPositions
                  ? ibPositionsQuery.data.positions.filter(pos => {
                      const k = `${pos.symbol}-${pos.right ?? ''}-${pos.strike ?? ''}-${normExp(pos.expiration)}`;
                      return !(pos.sec_type === 'OPT' && closingLogKeys.has(k) && !localOpenKeys.has(k));
                    })
                  : ibPositionsQuery.data.positions;

                // Sort latest-first using the open-log timestamp; positions
                // without a matching log entry fall to the end.
                const visiblePositions = rawPositions.slice().sort((a, b) => {
                  const ka = `${a.symbol}-${a.right ?? ''}-${a.strike ?? ''}-${normExp(a.expiration)}`;
                  const kb = `${b.symbol}-${b.right ?? ''}-${b.strike ?? ''}-${normExp(b.expiration)}`;
                  return (openTsByKey[kb] ?? 0) - (openTsByKey[ka] ?? 0);
                });

                return visiblePositions.map((pos) => {
                const posKey = `${pos.symbol}-${pos.sec_type}-${pos.expiration ?? ''}-${pos.strike ?? ''}-${pos.right ?? ''}`;

                const posContractKey = `${pos.symbol}-${pos.right ?? ''}-${pos.strike ?? ''}-${normExp(pos.expiration)}`;
                const isGhost = pos.sec_type === 'OPT'
                  && closingLogKeys.has(posContractKey)
                  && !localOpenKeys.has(posContractKey);
                const pnlColor = pos.unrealized_pnl == null
                  ? '#9aa0a6'
                  : pos.unrealized_pnl >= 0 ? '#39d98a' : '#ff6b6b';
                const targetPremium = pos.sec_type === 'OPT'
                  ? (tpByKey[`${pos.symbol}-${pos.right ?? ''}-${pos.strike ?? ''}`] ?? null)
                  : null;
                return (
                  <Box
                    key={posKey}
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.3,
                      marginBottom: 1,
                      padding: '6px 8px',
                      borderRadius: 1,
                      border: isGhost ? '1px solid rgba(245,166,35,0.35)' : '1px solid #1f2533',
                      backgroundColor: isGhost ? 'rgba(245,166,35,0.04)' : 'rgba(255,255,255,0.02)',
                      opacity: isGhost ? 0.7 : 1,
                    }}
                  >
                    {/* Row 1: symbol / contract identifier + Close button */}
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#d1d4dc' }}>
                        {pos.sec_type === 'OPT'
                          ? `${pos.symbol} ${pos.right} ${pos.strike} ${pos.expiration ? pos.expiration.slice(2) : ''}`
                          : pos.symbol}
                        {pos.sec_type === 'OPT' && pos.days_to_expiry != null && (
                          <span style={{ fontSize: 10, color: '#787b86', marginLeft: 4 }}>
                            ({pos.days_to_expiry}d)
                          </span>
                        )}
                        {isGhost && (
                          <span style={{ fontSize: 9, color: '#f5a623', border: '1px solid rgba(245,166,35,0.4)', borderRadius: 3, padding: '1px 4px', marginLeft: 6 }}>
                            Closing…
                          </span>
                        )}
                      </Typography>
                      <IconButton
                        size="small"
                        onClick={(e) => setIbPosMenuAnchor({ el: e.currentTarget, pos })}
                        sx={{ color: '#9aa0a6', padding: 0.25 }}
                      >
                        <MoreVertIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Box>

                    {/* Row 2: qty · avg cost · market price */}
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        Qty <strong style={{ color: '#d1d4dc' }}>{pos.quantity}</strong>
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        Avg <strong style={{ color: '#d1d4dc' }}>
                          {fmtMoney(pos.avg_cost)}
                        </strong>
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        Last <strong style={{ color: '#d1d4dc' }}>
                          {fmtMoney(pos.market_price)}
                        </strong>
                      </Typography>
                      {pos.multiplier != null && pos.sec_type === 'OPT' && (
                        <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                          ×<strong style={{ color: '#d1d4dc' }}>{pos.multiplier}</strong>
                        </Typography>
                      )}
                    </Box>

                    {/* Row 3: market value · cost basis · unrealized P&L */}
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        MV <strong style={{ color: '#d1d4dc' }}>
                          {fmtMoney(pos.market_value)}
                        </strong>
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        Cost <strong style={{ color: '#d1d4dc' }}>
                          {fmtMoney(pos.cost_basis)}
                        </strong>
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: pnlColor }}>
                        P&L <strong>
                          {pos.unrealized_pnl != null
                            ? fmtPnl(pos.unrealized_pnl)
                            : '—'}
                          {pos.pnl_pct != null
                            ? ` (${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(1)}%)`
                            : ''}
                        </strong>
                      </Typography>
                    </Box>
                    {/* Row 4: delta-to-target (when target found in local log) */}
                    {targetPremium != null && pos.market_price != null && (
                      <Box sx={{ display: 'flex', gap: 1, fontSize: 11, color: '#9aa0a6' }}>
                        <span>TP</span>
                        <strong style={{ color: pos.market_price >= targetPremium ? '#39d98a' : '#c7ccd6' }}>
                          {pos.market_price.toFixed(2)} / {targetPremium.toFixed(2)}
                          {' '}({(pos.market_price / targetPremium * 100).toFixed(0)}%)
                        </strong>
                      </Box>
                    )}
                  </Box>
                );
              });
              })()
            ) : (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No IBKR positions yet.</Typography>
            )}

            {/* IBKR positions actions menu */}
            <Menu
              anchorEl={ibPosMenuAnchor?.el}
              open={Boolean(ibPosMenuAnchor)}
              onClose={() => setIbPosMenuAnchor(null)}
              slotProps={{ paper: { sx: { backgroundColor: '#1a1f2e', border: '1px solid #2b2b43', minWidth: 140 } } }}
            >
              <MenuItem
                onClick={() => {
                  if (ibPosMenuAnchor) handleClosePosition(ibPosMenuAnchor.pos);
                  setIbPosMenuAnchor(null);
                }}
                sx={{ fontSize: 12, color: '#ff6b6b' }}
              >
                Close Position
              </MenuItem>
            </Menu>

            <Divider sx={{ marginY: 1.5, borderColor: '#1f2533' }} />

            {/* IBKR Orders History */}
            <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
              IBKR Orders History
            </Typography>
            {ibOrdersQuery.isLoading ? (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>Loading…</Typography>
            ) : ibOrdersQuery.data?.orders?.length ? (
              ibOrdersQuery.data.orders.slice(0, 40).map((order, index) => {
                const ts = order.timestamp
                  ? new Date(order.timestamp * 1000)
                  : null;
                const dateLabel = ts
                  ? ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
                  : null;
                const timeLabel = ts
                  ? ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
                  : null;
                const isFilled = order.status === 'Filled';
                return (
                  <Box
                    key={`${order.order_id ?? 'ib'}-${order.perm_id ?? index}`}
                    sx={{
                      padding: '5px 7px',
                      marginBottom: 0.5,
                      borderRadius: 1,
                      border: '1px solid #1a1d27',
                      backgroundColor: 'rgba(255,255,255,0.015)',
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontWeight: 600, color: '#c5c8d0', marginBottom: 0.15 }}>
                      <span>
                        {order.symbol ?? '—'}
                        {order.right ? ` ${order.right}` : ''}
                        {order.strike != null ? ` ${order.strike}` : ''}
                        {order.expiration ? ` · exp ${order.expiration}` : ''}
                      </span>
                      {(dateLabel || timeLabel) && (
                        <span style={{ fontSize: 10, fontWeight: 400, color: '#5c6370' }}>
                          {dateLabel} {timeLabel} ET
                        </span>
                      )}
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#7c8190' }}>
                      <span>
                        {order.action ?? ''} {order.quantity ?? ''}
                        {order.avg_fill_price != null ? ` @ ${order.avg_fill_price}` : ''}
                        {order.order_type ? ` · ${order.order_type}` : ''}
                      </span>
                      <span style={{ color: isFilled ? '#39d98a' : '#9aa0a6' }}>
                        {order.status ?? '—'}
                      </span>
                    </Box>
                  </Box>
                );
              })
            ) : (
              <Typography sx={{ fontSize: 12, color: '#7c8190' }}>No IBKR orders yet.</Typography>
            )}
          </Box>
        </Box>
      </Box>

      {/* Auto Trader Settings Dialog */}
      <Dialog
        open={autoTraderSettingsOpen}
        onClose={() => setAutoTraderSettingsOpen(false)}
        maxWidth="lg"
        fullWidth
        PaperProps={{
          sx: { backgroundColor: '#16162a' }
        }}
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a' }}>Auto Trader Settings</DialogTitle>
        <DialogContent sx={{ display: 'flex', gap: 2, height: 520, overflow: 'hidden', backgroundColor: '#16162a' }}>
          <Box sx={{ width: 280, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Settings</Typography>
            <List dense sx={{ border: '1px solid #2b2b43', borderRadius: 1 }}>
              <ListItemButton
                selected={settingsTab === 'global'}
                onClick={() => setSettingsTab('global')}
              >
                <ListItemText primary="General" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'open-positions'}
                onClick={() => setSettingsTab('open-positions')}
              >
                <ListItemText primary="Opening Positions" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'take-profit'}
                onClick={() => setSettingsTab('take-profit')}
              >
                <ListItemText primary="Take-profit" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'position-sizing'}
                onClick={() => setSettingsTab('position-sizing')}
              >
                <ListItemText primary="Position Sizing" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'tickers'}
                onClick={() => setSettingsTab('tickers')}
              >
                <ListItemText primary="Optimal Premium Ranges" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'strategies'}
                onClick={() => setSettingsTab('strategies')}
              >
                <ListItemText primary="Strategy Settings" />
              </ListItemButton>
              <ListItemButton
                selected={settingsTab === 'trading-mode'}
                onClick={() => setSettingsTab('trading-mode')}
              >
                <ListItemText primary="Trading Mode" />
              </ListItemButton>
            </List>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#9aa0a6' }}>
                Overrides
              </Typography>
              <Button
                variant="outlined"
                onClick={handleApplyOverride}
                disabled={!overrideSymbol || autoTraderSettingsBusy}
                size="small"
                sx={{ textTransform: 'none' }}
              >
                Add
              </Button>
            </Box>
            <TextField
              select
              size="small"
              label="Ticker"
              value={overrideSymbol}
              onChange={(e) => {
                setOverrideSymbol(e.target.value);
                setSettingsTab('override');
              }}
              sx={{ flex: 1 }}
            >
              <MenuItem value="">Select…</MenuItem>
              {SYMBOLS.map((symbol) => (
                <MenuItem key={symbol} value={symbol}>
                  {symbol}
                </MenuItem>
              ))}
            </TextField>
            <List dense sx={{ border: '1px solid #2b2b43', borderRadius: 1 }}>
              {Object.keys((autoTraderSettingsDraft as any).overrides || {}).length === 0 && (
                <ListItemText
                  primary="No overrides yet"
                  primaryTypographyProps={{ sx: { padding: 1, color: '#9aa0a6' } }}
                />
              )}
              {Object.keys((autoTraderSettingsDraft as any).overrides || {}).map((sym) => (
                <ListItemButton
                  key={sym}
                  selected={overrideSymbol === sym && settingsTab === 'override'}
                  onClick={() => {
                    setOverrideSymbol(sym);
                    setSettingsTab('override');
                  }}
                >
                  <ListItemText primary={sym} />
                </ListItemButton>
              ))}
            </List>
            <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
              Global settings apply unless an override exists.
            </Typography>
          </Box>
          <Divider orientation="vertical" flexItem sx={{ borderColor: '#2b2b43' }} />
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1.5, overflowY: 'auto', pl: 0.5, pr: 0.5, ...SCROLLBAR_STYLES }}>
            {settingsTab === 'trading-mode' ? (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Trading Mode</Typography>
                <Typography sx={{ fontSize: 11, color: '#9aa0a6', mb: 2 }}>
                  Select mode and enter your IB account IDs. Saving applies the mode change immediately.
                </Typography>

                {/* Mode selector */}
                <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#9aa0a6', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Mode</Typography>
                <Box sx={{ display: 'flex', gap: 1, mb: 3 }}>
                  {(['paper', 'live'] as const).map((m) => {
                    const isSelected = (autoTraderSettingsDraft as any).tradingMode === m;
                    const color = m === 'paper' ? '#39d98a' : '#ef5350';
                    const bg = m === 'paper' ? 'rgba(57,217,138,0.1)' : 'rgba(239,83,80,0.1)';
                    return (
                      <Box
                        key={m}
                        component="div"
                        onClick={() => setAutoTraderSettingsDraft((prev) => ({ ...prev, tradingMode: m }))}
                        sx={{
                          flex: 1, textAlign: 'center', cursor: 'pointer', py: 1, borderRadius: 1,
                          border: '1px solid', borderColor: isSelected ? color : '#2b2b43',
                          backgroundColor: isSelected ? bg : 'transparent',
                          transition: 'all 0.15s',
                        }}
                      >
                        <Typography sx={{ fontSize: 12, fontWeight: 700, color: isSelected ? color : '#9aa0a6', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                          {m}
                        </Typography>
                        <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                          port {m === 'paper' ? '4002' : '4001'}
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>

                {/* Account IDs */}
                <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#9aa0a6', mb: 1, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Account IDs</Typography>
                <TextField
                  label="Paper account ID"
                  size="small"
                  fullWidth
                  placeholder="e.g. DU1234567"
                  value={(autoTraderSettingsDraft as any).paperAccount ?? ''}
                  onChange={(e) => setAutoTraderSettingsDraft((prev) => ({ ...prev, paperAccount: e.target.value }))}
                  sx={{ mb: 1.5 }}
                />
                <TextField
                  label="Live account ID"
                  size="small"
                  fullWidth
                  placeholder="e.g. U9876543"
                  value={(autoTraderSettingsDraft as any).liveAccount ?? ''}
                  onChange={(e) => setAutoTraderSettingsDraft((prev) => ({ ...prev, liveAccount: e.target.value }))}
                />
                {(autoTraderSettingsDraft as any).tradingMode === 'live' && (
                  <Typography sx={{ fontSize: 11, color: '#f5a623', mt: 1.5 }}>
                    ⚠ Live mode — real money. Make sure IB Gateway is running on port 4001.
                  </Typography>
                )}
              </>
            ) : settingsTab === 'tickers' ? (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Optimal Premium Ranges</Typography>
                <Box sx={{ overflowY: 'auto', maxHeight: 460, ...SCROLLBAR_STYLES }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>Ticker</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>Enabled</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>Min ($)</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>Max ($)</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>0DTE Min ($)</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>0DTE Max ($)</TableCell>
                        <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>Strategies</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries((autoTraderSettingsDraft as any).tickerSettings || {}).map(([sym, cfg]: [string, any]) => (
                        <TableRow key={sym}>
                          <TableCell sx={{ fontSize: 12 }}>{sym}</TableCell>
                          <TableCell>
                            <Switch
                              size="small"
                              checked={cfg.enabled}
                              onChange={(e) =>
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, enabled: e.target.checked },
                                  },
                                }))
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              type="number"
                              size="small"
                              value={cfg.optimalMin ?? ''}
                              onChange={(e) =>
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, optimalMin: e.target.value === '' ? null : Number(e.target.value) },
                                  },
                                }))
                              }
                              sx={{ width: 80 }}
                              inputProps={{ min: 0, step: 1 }}
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              type="number"
                              size="small"
                              value={cfg.optimalMax ?? ''}
                              onChange={(e) =>
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, optimalMax: e.target.value === '' ? null : Number(e.target.value) },
                                  },
                                }))
                              }
                              sx={{ width: 80 }}
                              inputProps={{ min: 0, step: 1 }}
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              type="number"
                              size="small"
                              value={cfg.optimalMin0DTE ?? ''}
                              onChange={(e) =>
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, optimalMin0DTE: e.target.value === '' ? null : Number(e.target.value) },
                                  },
                                }))
                              }
                              sx={{ width: 80 }}
                              inputProps={{ min: 0, step: 0.5 }}
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              type="number"
                              size="small"
                              value={cfg.optimalMax0DTE ?? ''}
                              onChange={(e) =>
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, optimalMax0DTE: e.target.value === '' ? null : Number(e.target.value) },
                                  },
                                }))
                              }
                              sx={{ width: 80 }}
                              inputProps={{ min: 0, step: 0.5 }}
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              size="small"
                              value={cfg.enabledStrategies ? cfg.enabledStrategies.join(',') : ''}
                              onChange={(e) => {
                                const val = e.target.value.trim();
                                const parsed = val === '' ? undefined : val.split(',').map((s: string) => Number(s.trim())).filter((n: number) => !isNaN(n));
                                setAutoTraderSettingsDraft((prev) => ({
                                  ...prev,
                                  tickerSettings: {
                                    ...(prev as any).tickerSettings,
                                    [sym]: { ...cfg, enabledStrategies: parsed },
                                  },
                                }));
                              }}
                              placeholder="All"
                              sx={{ width: 90 }}
                              inputProps={{ style: { fontSize: 11 } }}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </>
            ) : settingsTab === 'take-profit' ? (
              <>
                {/* ── Profit Target ── */}
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Profit Target</Typography>
                <Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Profit target</Typography>
                    <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(autoTraderSettingsDraft.profitTargetPct * 100)}%</Typography>
                  </Box>
                  <Slider
                    value={Math.round(autoTraderSettingsDraft.profitTargetPct * 100)}
                    onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, profitTargetPct: (v as number) / 100 }))}
                    min={0} max={100} step={1} size="small"
                    valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                  />
                  <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Target option premium gain before closing</Typography>
                </Box>

                {/* ── Trailing Stop ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Trailing Stop</Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).useTrailingStop ?? false}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, useTrailingStop: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>Use trailing stop</Typography>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                        Lock in profits by trailing below peak premium
                      </Typography>
                    </Box>
                  }
                />
                {(autoTraderSettingsDraft as any).useTrailingStop && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, ml: 2, pl: 1.5, borderLeft: '2px solid rgba(255,255,255,0.06)' }}>
                    <Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                        <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Trailing stop %</Typography>
                        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(((autoTraderSettingsDraft as any).trailingStopPct ?? 0.1) * 100)}%</Typography>
                      </Box>
                      <Slider
                        value={Math.round(((autoTraderSettingsDraft as any).trailingStopPct ?? 0.1) * 100)}
                        onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, trailingStopPct: (v as number) / 100 }))}
                        min={0} max={100} step={1} size="small"
                        valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                      />
                      <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Default distance to trail below peak (used when no tiers match)</Typography>
                    </Box>

                    {/* ── Tiered Trailing Stop ── */}
                    <Box sx={{ mt: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#d1d4dc' }}>
                          Trailing Tiers
                        </Typography>
                        <Button
                          size="small"
                          onClick={() => {
                            const tiers = [...((autoTraderSettingsDraft as any).trailingTiers || [])];
                            tiers.push({ above: 0, trail: 0.07 });
                            setAutoTraderSettingsDraft((prev) => ({ ...prev, trailingTiers: tiers }));
                          }}
                          sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, px: 1 }}
                        >
                          + Add tier
                        </Button>
                      </Box>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af', mb: 1 }}>
                        Tighten the trail as gain increases. Highest matching tier wins.
                      </Typography>
                      {((autoTraderSettingsDraft as any).trailingTiers || []).map((tier: any, idx: number) => (
                        <Box key={idx} sx={{ mb: 1.5, p: 1, border: '1px solid rgba(255,255,255,0.06)', borderRadius: 1 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                            <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>When gain &ge;</Typography>
                            <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round((tier.above ?? 0) * 100)}%</Typography>
                          </Box>
                          <Slider
                            value={Math.round((tier.above ?? 0) * 100)}
                            onChange={(_, v) => {
                              const tiers = [...((autoTraderSettingsDraft as any).trailingTiers || [])];
                              tiers[idx] = { ...tiers[idx], above: (v as number) / 100 };
                              setAutoTraderSettingsDraft((prev) => ({ ...prev, trailingTiers: tiers }));
                            }}
                            min={0} max={100} step={5} size="small"
                            valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                          />
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5, mt: 1 }}>
                            <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Trail</Typography>
                            <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round((tier.trail ?? 0.07) * 100)}%</Typography>
                          </Box>
                          <Slider
                            value={Math.round((tier.trail ?? 0.07) * 100)}
                            onChange={(_, v) => {
                              const tiers = [...((autoTraderSettingsDraft as any).trailingTiers || [])];
                              tiers[idx] = { ...tiers[idx], trail: (v as number) / 100 };
                              setAutoTraderSettingsDraft((prev) => ({ ...prev, trailingTiers: tiers }));
                            }}
                            min={1} max={100} step={1} size="small"
                            valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                          />
                          <Button
                            size="small"
                            color="error"
                            onClick={() => {
                              const tiers = [...((autoTraderSettingsDraft as any).trailingTiers || [])];
                              tiers.splice(idx, 1);
                              setAutoTraderSettingsDraft((prev) => ({ ...prev, trailingTiers: tiers }));
                            }}
                            sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, px: 0.5, mt: 0.5 }}
                          >
                            Remove
                          </Button>
                        </Box>
                      ))}
                    </Box>

                    <FormControlLabel
                      control={
                        <Switch
                          checked={(autoTraderSettingsDraft as any).useLimitOrdersForTrailExit !== false}
                          onChange={(e) =>
                            setAutoTraderSettingsDraft((prev) => ({ ...prev, useLimitOrdersForTrailExit: e.target.checked }))
                          }
                        />
                      }
                      label={
                        <Box>
                          <Typography sx={{ fontSize: 13 }}>Use limit orders for trail exit</Typography>
                          <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                            Place limit sell at trail stop price instead of market
                          </Typography>
                        </Box>
                      }
                    />
                    {(autoTraderSettingsDraft as any).useLimitOrdersForTrailExit !== false && (
                      <TextField
                        label="Limit order timeout (seconds)"
                        type="number"
                        size="small"
                        value={(autoTraderSettingsDraft as any).limitOrderTimeoutSecs ?? 30}
                        onChange={(e) =>
                          setAutoTraderSettingsDraft((prev) => ({
                            ...prev,
                            limitOrderTimeoutSecs: Math.max(5, Number(e.target.value) || 30),
                          }))
                        }
                        helperText="Time to wait for limit fill before falling back to market"
                        sx={{ width: 220 }}
                        inputProps={{ min: 5, max: 300 }}
                      />
                    )}
                  </Box>
                )}

                {/* ── Stop Loss ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Stop Loss</Typography>
                <Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Stop loss %</Typography>
                    <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(((autoTraderSettingsDraft as any).stopLossPct ?? 0) * 100)}%</Typography>
                  </Box>
                  <Slider
                    value={Math.round(((autoTraderSettingsDraft as any).stopLossPct ?? 0) * 100)}
                    onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, stopLossPct: (v as number) / 100 }))}
                    min={0} max={100} step={1} size="small"
                    valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                  />
                  <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Close if premium drops this % below entry (0 = disabled). Uses market order.</Typography>
                </Box>

                {/* ── Stale Position Exit ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Stale Position Exit</Typography>
                <Typography sx={{ fontSize: 11, color: '#9ca3af', mb: 0.5 }}>
                  Close if position hasn't gained enough after a set time (fights theta decay on 0DTE)
                </Typography>
                <Box sx={{ display: 'flex', gap: 1.5 }}>
                  <TextField
                    label="Close after (min)"
                    type="number"
                    size="small"
                    value={(autoTraderSettingsDraft as any).staleAfterMinutes ?? 0}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, staleAfterMinutes: Math.max(0, Number(e.target.value)) }))
                    }
                    helperText="0 = disabled"
                    inputProps={{ min: 0, max: 300, step: 5 }}
                    sx={{ flex: 1 }}
                  />
                  <Box sx={{ flex: 1 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                      <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Min gain required</Typography>
                      <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(((autoTraderSettingsDraft as any).staleMinGainPct ?? 0.10) * 100)}%</Typography>
                    </Box>
                    <Slider
                      value={Math.round(((autoTraderSettingsDraft as any).staleMinGainPct ?? 0.10) * 100)}
                      onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, staleMinGainPct: (v as number) / 100 }))}
                      min={0} max={100} step={5} size="small"
                      valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                    />
                    <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Close if below this gain after time</Typography>
                  </Box>
                </Box>

                {/* ── Monitoring ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Monitoring</Typography>
                <TextField
                  label="TP check interval (seconds)"
                  type="number"
                  size="small"
                  value={(autoTraderSettingsDraft as any).tpCheckIntervalSeconds ?? 15}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({
                      ...prev,
                      tpCheckIntervalSeconds: Number(e.target.value),
                    }))
                  }
                  helperText="How often to check open positions for take-profit hits"
                />
                <TextField
                  label="Force-close time (ET)"
                  size="small"
                  placeholder="14:00"
                  value={(autoTraderSettingsDraft as any).expiryCloseTime}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({ ...prev, expiryCloseTime: e.target.value }))
                  }
                  helperText="HH:MM — close expiring options before this time (on expiration day)"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).allowClosePositions}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, allowClosePositions: e.target.checked }))
                      }
                    />
                  }
                  label="Allow closing positions"
                />
              </>
            ) : settingsTab === 'open-positions' ? (
              <>
                {/* ── Entry Controls ── */}
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Entry Controls</Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).allowOpenPositions}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, allowOpenPositions: e.target.checked }))
                      }
                    />
                  }
                  label="Allow opening new positions"
                />
                {(autoTraderSettingsDraft as any).allowOpenPositions && (
                  <TextField
                    label="Open positions until (ET)"
                    type="time"
                    value={(autoTraderSettingsDraft as any).openPositionsUntil || "14:30"}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, openPositionsUntil: e.target.value }))
                    }
                    size="small"
                    sx={{ ml: 2, width: 150 }}
                    InputLabelProps={{ shrink: true }}
                    helperText="No new positions after this time"
                  />
                )}
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={(autoTraderSettingsDraft as any).allowCalls}
                        onChange={(e) =>
                          setAutoTraderSettingsDraft((prev) => ({ ...prev, allowCalls: e.target.checked }))
                        }
                      />
                    }
                    label="Allow CALLs"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        checked={(autoTraderSettingsDraft as any).allowPuts}
                        onChange={(e) =>
                          setAutoTraderSettingsDraft((prev) => ({ ...prev, allowPuts: e.target.checked }))
                        }
                      />
                    }
                    label="Allow PUTs"
                  />
                </Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.useOptimalRange}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, useOptimalRange: e.target.checked }))
                      }
                    />
                  }
                  label="Require optimal premium range"
                />

                {/* ── Timing ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Timing</Typography>
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <TextField
                    label="Scan interval (sec)"
                    type="number"
                    size="small"
                    value={autoTraderSettingsDraft.intervalSeconds}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, intervalSeconds: Number(e.target.value) }))
                    }
                    helperText="How often to scan for signals"
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Signal max age (sec)"
                    type="number"
                    size="small"
                    value={(autoTraderSettingsDraft as any).signalMaxAgeSecs ?? 0}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({
                        ...prev,
                        signalMaxAgeSecs: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    helperText="Skip stale signals (0 = off)"
                    sx={{ flex: 1 }}
                  />
                </Box>

                {/* ── Limits ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Limits</Typography>
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <TextField
                    label="Max trades/day"
                    type="number"
                    size="small"
                    value={autoTraderSettingsDraft.maxTradesPerDay}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, maxTradesPerDay: Number(e.target.value) }))
                    }
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Max concurrent"
                    type="number"
                    size="small"
                    value={autoTraderSettingsDraft.maxConcurrentPositions}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, maxConcurrentPositions: Number(e.target.value) }))
                    }
                    sx={{ flex: 1 }}
                  />
                </Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).onePositionPerSymbol ?? false}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, onePositionPerSymbol: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>One position per symbol</Typography>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                        Block new positions if symbol already has an open position
                      </Typography>
                    </Box>
                  }
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).blockCounterTrend ?? true}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, blockCounterTrend: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>Block counter-trend signals</Typography>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                        Skip opposite-direction entries when profitable positions are open
                      </Typography>
                    </Box>
                  }
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).chopFilterEnabled ?? true}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, chopFilterEnabled: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>ADX chop filter</Typography>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                        Skip signals when market is range-bound (ADX below threshold)
                      </Typography>
                    </Box>
                  }
                />
                {(autoTraderSettingsDraft as any).chopFilterEnabled !== false && (
                  <Box sx={{ display: 'flex', gap: 1.5, ml: 2, pl: 1.5, borderLeft: '2px solid rgba(255,255,255,0.06)' }}>
                    <TextField
                      label="ADX threshold"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).chopFilterAdxThreshold ?? 20}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, chopFilterAdxThreshold: Number(e.target.value) }))
                      }
                      helperText="Skip when ADX < this (20 = standard)"
                      inputProps={{ min: 5, max: 50, step: 1 }}
                      sx={{ flex: 1 }}
                    />
                    <TextField
                      label="Timeframe"
                      select
                      size="small"
                      value={(autoTraderSettingsDraft as any).chopFilterTimeframe ?? '15m'}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, chopFilterTimeframe: e.target.value }))
                      }
                      helperText="Bar timeframe for ADX"
                      sx={{ flex: 1 }}
                    >
                      {['5m', '15m', '1h'].map((tf) => (
                        <MenuItem key={tf} value={tf}>{tf}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      label="DI gap threshold"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).chopFilterDiGap ?? 10}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, chopFilterDiGap: Number(e.target.value) }))
                      }
                      helperText="Skip when |+DI − −DI| < this (0 = off)"
                      inputProps={{ min: 0, max: 30, step: 1 }}
                      sx={{ flex: 1 }}
                    />
                  </Box>
                )}

                {/* ── Strike Selection ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Strike Selection</Typography>
                <TextField
                  label="Strike selection window"
                  type="number"
                  size="small"
                  value={(autoTraderSettingsDraft as any).strikeWindow || 12}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({ ...prev, strikeWindow: Number(e.target.value) }))
                  }
                  helperText="Strikes to search above/below current price (default: 12)"
                  inputProps={{ min: 5, max: 50, step: 1 }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={(autoTraderSettingsDraft as any).filterBySpread ?? true}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, filterBySpread: e.target.checked }))
                      }
                    />
                  }
                  label="Filter by bid-ask spread"
                />
                {(autoTraderSettingsDraft as any).filterBySpread !== false && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, ml: 2, pl: 1.5, borderLeft: '2px solid rgba(255,255,255,0.06)' }}>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                      <Box sx={{ flex: 1 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                          <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Max spread %</Typography>
                          <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{(autoTraderSettingsDraft as any).maxSpreadPct ?? 20}%</Typography>
                        </Box>
                        <Slider
                          value={(autoTraderSettingsDraft as any).maxSpreadPct ?? 20}
                          onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, maxSpreadPct: v as number }))}
                          min={0} max={100} step={5} size="small"
                          valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                        />
                        <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Skip if spread &gt; this %</Typography>
                      </Box>
                      <TextField
                        label="Max spread $"
                        type="number"
                        size="small"
                        value={(autoTraderSettingsDraft as any).maxSpreadDollar ?? 0.30}
                        onChange={(e) =>
                          setAutoTraderSettingsDraft((prev) => ({ ...prev, maxSpreadDollar: Number(e.target.value) }))
                        }
                        helperText="Skip if spread > this $"
                        inputProps={{ min: 0.05, max: 2.0, step: 0.05 }}
                        sx={{ flex: 1 }}
                      />
                    </Box>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={(autoTraderSettingsDraft as any).preferTightSpreads ?? true}
                          onChange={(e) =>
                            setAutoTraderSettingsDraft((prev) => ({ ...prev, preferTightSpreads: e.target.checked }))
                          }
                        />
                      }
                      label={
                        <Box>
                          <Typography sx={{ fontSize: 13 }}>Prefer tighter spreads</Typography>
                          <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                            Pick the strike with tightest spread when multiple pass
                          </Typography>
                        </Box>
                      }
                    />
                  </Box>
                )}

                <TextField
                  label="Min delta"
                  type="number"
                  size="small"
                  value={(autoTraderSettingsDraft as any).minDelta ?? 0.05}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({ ...prev, minDelta: Number(e.target.value) }))
                  }
                  helperText="Skip strikes with abs(delta) below this (0 = disabled)"
                  inputProps={{ min: 0, max: 0.5, step: 0.01 }}
                />

                <Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Slippage buffer %</Typography>
                    <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(((autoTraderSettingsDraft as any).slippageBufferPct ?? 0.08) * 100)}%</Typography>
                  </Box>
                  <Slider
                    value={Math.round(((autoTraderSettingsDraft as any).slippageBufferPct ?? 0.08) * 100)}
                    onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, slippageBufferPct: (v as number) / 100 }))}
                    min={0} max={100} step={1} size="small"
                    valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                  />
                  <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Extra % added to premium for capital checks (prevents IB rejection from price movement)</Typography>
                </Box>

                {/* ── Order Type ── */}
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Order Type</Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.useMarketOrders}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, useMarketOrders: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>Use market orders</Typography>
                      {!autoTraderSettingsDraft.useMarketOrders && (
                        <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                          Limit orders at mid-price with timeout, then fall back to market
                        </Typography>
                      )}
                    </Box>
                  }
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={Boolean((autoTraderSettingsDraft as any).useLimitOrdersForEntry)}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, useLimitOrdersForEntry: e.target.checked }))
                      }
                    />
                  }
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 13 }}>Use limit orders for entry</Typography>
                      <Typography sx={{ fontSize: 11, color: '#9ca3af' }}>
                        Buy at biased price instead of market. Falls back to market after timeout.
                      </Typography>
                    </Box>
                  }
                />
                {Boolean((autoTraderSettingsDraft as any).useLimitOrdersForEntry) && (
                  <Box sx={{ ml: 2, pl: 1.5, borderLeft: '2px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <TextField
                      label="Limit order bias"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).limitOrderBias ?? 0.25}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, limitOrderBias: Number(e.target.value) }))
                      }
                      helperText="0 = mid price, 0.5 = ask price. Higher = faster fills."
                      inputProps={{ min: 0, max: 0.5, step: 0.05 }}
                    />
                    <TextField
                      label="Limit order timeout (sec)"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).limitOrderTimeoutSecs ?? 60}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, limitOrderTimeoutSecs: Math.max(5, Number(e.target.value) || 60) }))
                      }
                      helperText="Cancel and fall back to market after this time"
                      inputProps={{ min: 5, max: 300 }}
                    />
                  </Box>
                )}
              </>
            ) : settingsTab === 'position-sizing' ? (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Position Sizing</Typography>
                <Typography sx={{ fontSize: 11, color: '#9aa0a6', mb: 1 }}>
                  Control how many contracts to buy per trade based on capital and risk management.
                </Typography>

                <FormControl size="small" fullWidth>
                  <InputLabel>Sizing Strategy</InputLabel>
                  <Select
                    value={(autoTraderSettingsDraft as any).positionSizing || 'hybrid'}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, positionSizing: e.target.value }))
                    }
                    label="Sizing Strategy"
                  >
                    <MenuItem value="fixed">Fixed Dollar Risk</MenuItem>
                    <MenuItem value="percentage">Percentage of Capital</MenuItem>
                    <MenuItem value="hybrid">Hybrid (Recommended)</MenuItem>
                  </Select>
                </FormControl>

                {(autoTraderSettingsDraft as any).positionSizing === 'fixed' && (
                  <>
                    <TextField
                      label="Risk per trade ($)"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).riskPerTrade || 300}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, riskPerTrade: Number(e.target.value) }))
                      }
                      helperText="Fixed dollar amount to risk per trade"
                      inputProps={{ min: 0, step: 50 }}
                    />
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                      Example: $300 risk with $2.50 premium → 1 contract ($250)
                    </Typography>
                  </>
                )}

                {(autoTraderSettingsDraft as any).positionSizing === 'percentage' && (
                  <>
                    <Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                        <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Risk percentage</Typography>
                        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{(autoTraderSettingsDraft as any).riskPctPerTrade || 2.0}%</Typography>
                      </Box>
                      <Slider
                        value={(autoTraderSettingsDraft as any).riskPctPerTrade || 2.0}
                        onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, riskPctPerTrade: v as number }))}
                        min={0} max={100} step={0.5} size="small"
                        valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                      />
                      <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Percentage of available capital to risk per trade</Typography>
                    </Box>
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                      Example: 2% of $10k = $200 with $1.50 premium → 1 contract
                    </Typography>
                  </>
                )}

                {(autoTraderSettingsDraft as any).positionSizing === 'hybrid' && (
                  <>
                    <Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                        <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Risk percentage</Typography>
                        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{(autoTraderSettingsDraft as any).riskPctPerTrade || 2.0}%</Typography>
                      </Box>
                      <Slider
                        value={(autoTraderSettingsDraft as any).riskPctPerTrade || 2.0}
                        onChange={(_, v) => setAutoTraderSettingsDraft((prev) => ({ ...prev, riskPctPerTrade: v as number }))}
                        min={0} max={100} step={0.5} size="small"
                        valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                      />
                      <Typography sx={{ fontSize: 11, color: '#9ca3af', mt: 0.5 }}>Percentage of available capital to risk per trade</Typography>
                    </Box>
                    <TextField
                      label="Max contracts per trade"
                      type="number"
                      size="small"
                      value={(autoTraderSettingsDraft as any).maxContractsPerTrade || 3}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, maxContractsPerTrade: Number(e.target.value) }))
                      }
                      helperText="Maximum contracts even if capital allows more"
                      inputProps={{ min: 1, max: 100, step: 1 }}
                    />
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                      Scales with account but caps at max contracts for safety
                    </Typography>
                  </>
                )}

                <TextField
                  label="Min contracts per trade"
                  type="number"
                  size="small"
                  value={(autoTraderSettingsDraft as any).minContractsPerTrade || 1}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({ ...prev, minContractsPerTrade: Number(e.target.value) }))
                  }
                  helperText="Skip trade if can't afford at least this many"
                  inputProps={{ min: 1, max: 10, step: 1 }}
                />

                <Divider sx={{ my: 2 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Daily Capital Limit</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Switch
                    size="small"
                    checked={Boolean((autoTraderSettingsDraft as any).capitalLimitEnabled)}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, capitalLimitEnabled: e.target.checked }))
                    }
                  />
                  <TextField
                    label="Capital limit"
                    type="number"
                    size="small"
                    disabled={!(autoTraderSettingsDraft as any).capitalLimitEnabled}
                    value={autoTraderSettingsDraft.capitalLimit}
                    onChange={(e) =>
                      setAutoTraderSettingsDraft((prev) => ({ ...prev, capitalLimit: Number(e.target.value) }))
                    }
                    InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                    helperText="Caps position size to fit within remaining daily budget"
                    sx={{ flex: 1 }}
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ fontSize: 12, color: '#9aa0a6', flex: 1 }}>
                    Capital spent:{' '}
                    <strong style={{ color: '#e8eaed' }}>
                      {fmtMoney(autoTraderQuery.data?.capital_spent ?? 0)}
                    </strong>
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    onClick={handleResetCapital}
                    disabled={autoTraderSettingsBusy}
                    sx={{ textTransform: 'none', fontSize: 11 }}
                  >
                    Reset
                  </Button>
                </Box>

                <Divider sx={{ my: 2 }} />
                <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Max Daily Loss Limit</Typography>
                <TextField
                  label="Max daily loss"
                  type="number"
                  size="small"
                  fullWidth
                  value={(autoTraderSettingsDraft as any).maxDailyLossDollar}
                  onChange={(e) =>
                    setAutoTraderSettingsDraft((prev) => ({ ...prev, maxDailyLossDollar: Number(e.target.value) }))
                  }
                  InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                  helperText="Stop opening new positions after realized losses exceed this amount (0 = disabled)"
                  inputProps={{ min: 0, step: 50 }}
                />
                {(() => {
                  const dailyLoss = autoTraderQuery.data?.daily_realized_loss ?? 0;
                  const limit = Number((autoTraderSettingsQuery.data?.settings as any)?.maxDailyLossDollar ?? 0);
                  const overLimit = limit > 0 && Math.abs(dailyLoss) >= limit;
                  return limit > 0 ? (
                    <Typography sx={{ fontSize: 12, color: '#9aa0a6', mt: 0.5 }}>
                      Today&apos;s realized loss:{' '}
                      <strong style={{ color: overLimit ? '#ff6b6b' : dailyLoss < 0 ? '#ffb74d' : '#39d98a' }}>
                        {dailyLoss < 0 ? `-$${Math.abs(dailyLoss).toFixed(2)}` : '$0.00'}
                      </strong>
                      {' / '}
                      <span>${limit.toFixed(2)}</span>
                      {overLimit && <span style={{ color: '#ff6b6b' }}> — LIMIT REACHED</span>}
                    </Typography>
                  ) : null;
                })()}

                <Box sx={{ mt: 2, p: 1.5, background: '#1a1a2e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, mb: 0.5 }}>Quick Guide</Typography>
                  <Typography sx={{ fontSize: 10, color: '#9aa0a6', lineHeight: 1.6 }}>
                    • <strong>Fixed:</strong> Always risk same $ amount<br />
                    • <strong>Percentage:</strong> Scales with account size<br />
                    • <strong>Hybrid:</strong> Best of both (scales but capped)
                  </Typography>
                </Box>
              </>
            ) : settingsTab === 'strategies' ? (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 2 }}>Strategy Settings</Typography>
                <Typography sx={{ fontSize: 11, color: '#9aa0a6', mb: 2 }}>
                  Configure strategy-specific parameters. These settings override defaults globally.
                </Typography>

                {/* Strategy selector */}
                <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                  <InputLabel>Strategy</InputLabel>
                  <Select
                    value={selectedStrategy}
                    label="Strategy"
                    onChange={(e) => setSelectedStrategy(e.target.value)}
                  >
                    {Object.entries(STRATEGY_METADATA).map(([key, meta]) => (
                      <MenuItem key={key} value={key}>
                        {meta.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {/* Reset to Defaults button */}
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 3 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    onClick={() => {
                      setAutoTraderSettingsDraft((prev: any) => {
                        const newSettings = { ...prev.strategySettings };
                        delete newSettings[selectedStrategy];
                        return { ...prev, strategySettings: newSettings };
                      });
                    }}
                    disabled={!((autoTraderSettingsDraft as any).strategySettings?.[selectedStrategy])}
                    sx={{ textTransform: 'none', fontSize: 11 }}
                  >
                    Reset to Defaults
                  </Button>
                </Box>

                {/* Strategy parameters */}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {STRATEGY_METADATA[selectedStrategy]?.params.map((param) => {
                    const storedValue = (autoTraderSettingsDraft as any).strategySettings?.[selectedStrategy]?.[param.key];
                    const currentValue = storedValue !== undefined ? storedValue : param.default;

                    if (param.type === 'boolean') {
                      return (
                        <FormControlLabel
                          key={param.key}
                          control={
                            <Switch
                              checked={currentValue === true}
                              onChange={(e) => {
                                setAutoTraderSettingsDraft((prev: any) => ({
                                  ...prev,
                                  strategySettings: {
                                    ...prev.strategySettings,
                                    [selectedStrategy]: {
                                      ...(prev.strategySettings?.[selectedStrategy] || {}),
                                      [param.key]: e.target.checked,
                                    },
                                  },
                                }));
                              }}
                            />
                          }
                          label={
                            <Box>
                              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{param.label}</Typography>
                              <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                                {param.description} (default: {param.default ? 'enabled' : 'disabled'})
                              </Typography>
                            </Box>
                          }
                        />
                      );
                    }

                    if (param.type === 'percent') {
                      const decimalValue = typeof currentValue === 'number' ? currentValue : parseFloat(currentValue) || param.default || 0;
                      const displayPct = Math.round(decimalValue * 100);
                      const minPct = Math.round((param.min ?? 0) * 100);
                      const maxPct = Math.round((param.max ?? 1) * 100);
                      const stepPct = Math.round((param.step ?? 0.05) * 100);
                      return (
                        <Box key={param.key}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{param.label}</Typography>
                            <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#ffd54f', minWidth: 40, textAlign: 'right' }}>
                              {displayPct}%
                            </Typography>
                          </Box>
                          <Slider
                            value={displayPct}
                            min={minPct}
                            max={maxPct}
                            step={stepPct}
                            onChange={(_e, val) => {
                              const decimal = (val as number) / 100;
                              setAutoTraderSettingsDraft((prev: any) => ({
                                ...prev,
                                strategySettings: {
                                  ...prev.strategySettings,
                                  [selectedStrategy]: {
                                    ...(prev.strategySettings?.[selectedStrategy] || {}),
                                    [param.key]: decimal,
                                  },
                                },
                              }));
                            }}
                            valueLabelDisplay="auto"
                            valueLabelFormat={(v) => `${v}%`}
                            sx={{
                              color: '#ffd54f',
                              height: 4,
                              '& .MuiSlider-thumb': { width: 14, height: 14, backgroundColor: '#ffd54f' },
                              '& .MuiSlider-track': { backgroundColor: '#ffd54f' },
                              '& .MuiSlider-rail': { backgroundColor: '#2b2b43' },
                              '& .MuiSlider-valueLabel': { fontSize: 10, backgroundColor: '#1a1f2e', border: '1px solid #2b2b43' },
                            }}
                          />
                          <Typography sx={{ fontSize: 10, color: '#9aa0a6', mt: -0.5 }}>
                            {param.description} (default: {Math.round((param.default ?? 0) * 100)}%)
                          </Typography>
                        </Box>
                      );
                    }

                    if (param.type === 'tickers') {
                      const selectedTickers = Array.isArray(currentValue) ? currentValue : (param.default || []);
                      return (
                        <FormControl key={param.key} fullWidth size="small">
                          <InputLabel>{param.label}</InputLabel>
                          <Select
                            multiple
                            value={selectedTickers}
                            label={param.label}
                            onChange={(e) => {
                              const value = typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value;
                              setAutoTraderSettingsDraft((prev: any) => ({
                                ...prev,
                                strategySettings: {
                                  ...prev.strategySettings,
                                  [selectedStrategy]: {
                                    ...(prev.strategySettings?.[selectedStrategy] || {}),
                                    [param.key]: value,
                                  },
                                },
                              }));
                            }}
                            renderValue={(selected) => (
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                {(selected as string[]).map((ticker) => (
                                  <Chip key={ticker} label={ticker} size="small" sx={{ height: 20, fontSize: 11 }} />
                                ))}
                              </Box>
                            )}
                          >
                            {SYMBOLS.map((sym) => (
                              <MenuItem key={sym} value={sym}>
                                {sym}
                              </MenuItem>
                            ))}
                          </Select>
                          <Typography sx={{ fontSize: 10, color: '#9aa0a6', mt: 0.5, ml: 1.75 }}>
                            {param.description} (default: {Array.isArray(param.default) ? param.default.join(', ') : 'none'})
                          </Typography>
                        </FormControl>
                      );
                    }

                    return (
                      <TextField
                        key={param.key}
                        label={param.label}
                        size="small"
                        fullWidth
                        placeholder={param.type === 'time' ? 'HH:MM' : 'Enter value'}
                        value={currentValue}
                        onChange={(e) => {
                          const value = param.type === 'number' ? parseFloat(e.target.value) || '' : e.target.value;
                          setAutoTraderSettingsDraft((prev: any) => ({
                            ...prev,
                            strategySettings: {
                              ...prev.strategySettings,
                              [selectedStrategy]: {
                                ...(prev.strategySettings?.[selectedStrategy] || {}),
                                [param.key]: value,
                              },
                            },
                          }));
                        }}
                        helperText={`${param.description} (default: ${param.default ?? 'none'})`}
                        FormHelperTextProps={{ sx: { fontSize: 10, color: '#9aa0a6' } }}
                      />
                    );
                  })}
                </Box>

                <Box sx={{ mt: 3, p: 1.5, background: '#1a1a2e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, mb: 0.5 }}>Note</Typography>
                  <Typography sx={{ fontSize: 10, color: '#9aa0a6', lineHeight: 1.6 }}>
                    • These settings override the defaults in <code>strategy_defaults.py</code><br />
                    • Leave fields empty to use default values<br />
                    • Changes apply on next auto-trader start
                  </Typography>
                </Box>
              </>
            ) : settingsTab === 'global' ? (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>General settings</Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.enabled}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, enabled: e.target.checked }))
                      }
                    />
                  }
                  label="Enabled on server start"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.rthOnly}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, rthOnly: e.target.checked }))
                      }
                    />
                  }
                  label="RTH only"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.onlyFavorites}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, onlyFavorites: e.target.checked }))
                      }
                    />
                  }
                  label="Only trade favorites"
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={autoTraderSettingsDraft.skipEarningsDay}
                      onChange={(e) =>
                        setAutoTraderSettingsDraft((prev) => ({ ...prev, skipEarningsDay: e.target.checked }))
                      }
                    />
                  }
                  label="Skip earnings day"
                />
              </>
            ) : (
              <>
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                  {overrideSymbol ? `${overrideSymbol} override` : 'Select a ticker'}
                </Typography>
                {overrideSymbol ? (
                  <>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={overrideDraft.rthOnly}
                          onChange={(e) =>
                            setOverrideDraft((prev) => ({ ...prev, rthOnly: e.target.checked }))
                          }
                        />
                      }
                      label="RTH only"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={overrideDraft.useOptimalRange}
                          onChange={(e) =>
                            setOverrideDraft((prev) => ({ ...prev, useOptimalRange: e.target.checked }))
                          }
                        />
                      }
                      label="Require optimal premium range"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={overrideDraft.skipEarningsDay}
                          onChange={(e) =>
                            setOverrideDraft((prev) => ({
                              ...prev,
                              skipEarningsDay: e.target.checked,
                            }))
                          }
                        />
                      }
                      label="Skip earnings day"
                    />
                    <Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                        <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Profit target</Typography>
                        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(overrideDraft.profitTargetPct * 100)}%</Typography>
                      </Box>
                      <Slider
                        value={Math.round(overrideDraft.profitTargetPct * 100)}
                        onChange={(_, v) => setOverrideDraft((prev) => ({ ...prev, profitTargetPct: (v as number) / 100 }))}
                        min={0} max={100} step={1} size="small"
                        valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                      />
                    </Box>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={(overrideDraft as any).useTrailingStop ?? false}
                          onChange={(e) =>
                            setOverrideDraft((prev) => ({ ...prev, useTrailingStop: e.target.checked }))
                          }
                        />
                      }
                      label="Use trailing stop"
                    />
                    {(overrideDraft as any).useTrailingStop && (
                      <Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                          <Typography sx={{ fontSize: 12, color: '#9ca3af' }}>Trailing stop %</Typography>
                          <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{Math.round(((overrideDraft as any).trailingStopPct ?? 0.1) * 100)}%</Typography>
                        </Box>
                        <Slider
                          value={Math.round(((overrideDraft as any).trailingStopPct ?? 0.1) * 100)}
                          onChange={(_, v) => setOverrideDraft((prev) => ({ ...prev, trailingStopPct: (v as number) / 100 }))}
                          min={0} max={100} step={1} size="small"
                          valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
                        />
                      </Box>
                    )}
                    <TextField
                      label="Max trades per day"
                      type="number"
                      size="small"
                      value={overrideDraft.maxTradesPerDay}
                      onChange={(e) =>
                        setOverrideDraft((prev) => ({
                          ...prev,
                          maxTradesPerDay: Number(e.target.value),
                        }))
                      }
                    />
                    <TextField
                      label="Interval (seconds)"
                      type="number"
                      size="small"
                      value={overrideDraft.intervalSeconds}
                      onChange={(e) =>
                        setOverrideDraft((prev) => ({
                          ...prev,
                          intervalSeconds: Number(e.target.value),
                        }))
                      }
                    />
                    <TextField
                      label="Max concurrent positions"
                      type="number"
                      size="small"
                      value={overrideDraft.maxConcurrentPositions}
                      onChange={(e) =>
                        setOverrideDraft((prev) => ({
                          ...prev,
                          maxConcurrentPositions: Number(e.target.value),
                        }))
                      }
                    />
                    <TextField
                      label="Capital limit"
                      type="number"
                      size="small"
                      value={overrideDraft.capitalLimit}
                      onChange={(e) =>
                        setOverrideDraft((prev) => ({
                          ...prev,
                          capitalLimit: Number(e.target.value),
                        }))
                      }
                      InputProps={{
                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                      }}
                    />
                    <Button
                      variant="contained"
                      onClick={handleApplyOverride}
                      disabled={autoTraderSettingsBusy}
                      sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
                    >
                      Save Override
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={handleRemoveOverride}
                      disabled={!overrideSymbol || autoTraderSettingsBusy}
                      sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
                    >
                      Remove Override
                    </Button>
                  </>
                ) : (
                  <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                    Pick a ticker on the left to edit per-company settings.
                  </Typography>
                )}
              </>
            )}
          </Box>
          {autoTraderSettingsError && (
            <Typography sx={{ fontSize: 12, color: '#ef5350' }}>
              {autoTraderSettingsError}
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button onClick={() => setAutoTraderSettingsOpen(false)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveAutoTraderSettings}
            disabled={autoTraderSettingsBusy}
            sx={{ textTransform: 'none' }}
          >
            {autoTraderSettingsBusy ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* IB Metrics Dialog */}
      <Dialog
        open={ibMetricsOpen}
        onClose={() => setIbMetricsOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: { backgroundColor: '#16162a' }
        }}
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a' }}>IB Gateway Metrics</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, backgroundColor: '#16162a' }}>
          {ibMetricsQuery.isLoading && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Loading metrics…</Typography>
          )}
          {ibMetricsQuery.isError && (
            <Typography sx={{ fontSize: 12, color: '#ef5350' }}>Failed to load metrics.</Typography>
          )}
          {ibMetricsQuery.data && (
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>In flight</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.in_flight}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Total requests</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.total_requests}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Total errors</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.total_errors}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last kind</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.last_kind ?? '—'}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last symbol</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.last_symbol ?? '—'}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last duration (ms)</Typography>
              <Typography sx={{ fontSize: 12 }}>
                {ibMetricsQuery.data.last_duration_ms
                  ? ibMetricsQuery.data.last_duration_ms.toFixed(0)
                  : '—'}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Avg duration (ms)</Typography>
              <Typography sx={{ fontSize: 12 }}>
                {ibMetricsQuery.data.avg_duration_ms
                  ? ibMetricsQuery.data.avg_duration_ms.toFixed(0)
                  : '—'}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last response items</Typography>
              <Typography sx={{ fontSize: 12 }}>
                {ibMetricsQuery.data.last_response_items ?? '—'}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last status</Typography>
              <Typography sx={{ fontSize: 12 }}>{ibMetricsQuery.data.last_status ?? '—'}</Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Last error</Typography>
              <Typography sx={{ fontSize: 12, color: '#ef5350' }}>
                {ibMetricsQuery.data.last_error ?? '—'}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button onClick={() => setIbMetricsOpen(false)} sx={{ textTransform: 'none' }}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmDialogOpen}
        onClose={handleConfirmDialogCancel}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a' }}>
          {confirmDialogTitle}
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#16162a' }}>
          <Typography sx={{ fontSize: 13, color: '#9aa0a6', pt: 1 }}>
            {confirmDialogMessage}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button
            onClick={handleConfirmDialogCancel}
            sx={{ textTransform: 'none', color: '#9aa0a6' }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmDialogConfirm}
            variant="contained"
            sx={{
              textTransform: 'none',
              backgroundColor: '#ff6b6b',
              '&:hover': { backgroundColor: '#e05555' },
            }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Custom TP Dialog */}
      <Dialog
        open={Boolean(customTpDialog)}
        onClose={() => setCustomTpDialog(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a' }}>
          Set Custom Take-Profit
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#16162a', pt: 3 }}>
          {customTpDialog && (
            <>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6', mb: 2 }}>
                {customTpDialog.order.symbol} {customTpDialog.order.right} ${customTpDialog.order.strike}
              </Typography>
              <TextField
                fullWidth
                label="Profit Target %"
                type="number"
                value={customTpValues.profitTargetPct}
                onChange={(e) => setCustomTpValues({ ...customTpValues, profitTargetPct: parseFloat(e.target.value) || 0 })}
                InputProps={{
                  endAdornment: <InputAdornment position="end">%</InputAdornment>,
                }}
                sx={{
                  mb: 2,
                  '& .MuiInputLabel-root': { color: '#9aa0a6' },
                  '& .MuiOutlinedInput-root': {
                    color: '#d1d4dc',
                    '& fieldset': { borderColor: '#2b2b43' },
                    '&:hover fieldset': { borderColor: '#3b3b53' },
                    '&.Mui-focused fieldset': { borderColor: '#90caf9' },
                  },
                }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={customTpValues.useTrailingStop}
                    onChange={(e) => setCustomTpValues({ ...customTpValues, useTrailingStop: e.target.checked })}
                    sx={{
                      '& .MuiSwitch-switchBase.Mui-checked': { color: '#90caf9' },
                      '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: '#90caf9' },
                    }}
                  />
                }
                label="Use Trailing Stop"
                sx={{ color: '#d1d4dc', mb: 2 }}
              />
              {customTpValues.useTrailingStop && (
                <TextField
                  fullWidth
                  label="Trailing Stop %"
                  type="number"
                  value={customTpValues.trailingStopPct}
                  onChange={(e) => setCustomTpValues({ ...customTpValues, trailingStopPct: parseFloat(e.target.value) || 0 })}
                  InputProps={{
                    endAdornment: <InputAdornment position="end">%</InputAdornment>,
                  }}
                  sx={{
                    mb: 2,
                    '& .MuiInputLabel-root': { color: '#9aa0a6' },
                    '& .MuiOutlinedInput-root': {
                      color: '#d1d4dc',
                      '& fieldset': { borderColor: '#2b2b43' },
                      '&:hover fieldset': { borderColor: '#3b3b53' },
                      '&.Mui-focused fieldset': { borderColor: '#90caf9' },
                    },
                  }}
                />
              )}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2, justifyContent: 'space-between' }}>
          <Button
            onClick={async () => {
              if (customTpDialog?.order?.signal_id) {
                try {
                  await deletePositionTpOverride(customTpDialog.order.signal_id);
                  await tpOverridesQuery.refetch();
                  await ordersQuery.refetch();
                  setCustomTpDialog(null);
                } catch (err) {
                  console.error('Failed to delete TP override:', err);
                }
              }
            }}
            sx={{ textTransform: 'none', color: '#ff6b6b' }}
          >
            Reset to Default
          </Button>
          <Box>
            <Button
              onClick={() => setCustomTpDialog(null)}
              sx={{ textTransform: 'none', color: '#9aa0a6', mr: 1 }}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (customTpDialog?.order?.signal_id) {
                  try {
                    await setPositionTpOverride(customTpDialog.order.signal_id, {
                      profitTargetPct: customTpValues.profitTargetPct / 100,
                      useTrailingStop: customTpValues.useTrailingStop,
                      trailingStopPct: customTpValues.trailingStopPct / 100,
                    });
                    await tpOverridesQuery.refetch();
                    await ordersQuery.refetch();
                    setCustomTpDialog(null);
                  } catch (err) {
                    console.error('Failed to set TP override:', err);
                  }
                }
              }}
              variant="contained"
              sx={{
                textTransform: 'none',
                backgroundColor: '#90caf9',
                '&:hover': { backgroundColor: '#64b5f6' },
              }}
            >
              Save
            </Button>
          </Box>
        </DialogActions>
      </Dialog>

      {/* Position History Dialog */}
      <Dialog
        open={Boolean(positionHistoryDialog)}
        onClose={() => setPositionHistoryDialog(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a' }}>
          Position History
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#16162a', pt: 3 }}>
          {positionHistoryDialog && (
            <>
              <Box sx={{ mb: 3, pb: 2, borderBottom: '1px solid #2b2b43' }}>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  {positionHistoryDialog.order.symbol} {positionHistoryDialog.order.right} ${positionHistoryDialog.order.strike}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, fontSize: 12, color: '#9aa0a6' }}>
                  <span>Strategy: {positionHistoryDialog.order.strategy_id || '—'}</span>
                  <span>Signal ID: {positionHistoryDialog.order.signal_id || '—'}</span>
                  {positionHistoryDialog.order.pnl != null && (
                    <span style={{ color: positionHistoryDialog.order.pnl >= 0 ? '#39d98a' : '#ff6b6b' }}>
                      P&L: {fmtPnl(positionHistoryDialog.order.pnl)}
                    </span>
                  )}
                </Box>
              </Box>
              {(() => {
                const openEntry = positionHistoryDialog.events.find((e: any) => e.type === 'OPEN');
                const closeEntry = positionHistoryDialog.events.find((e: any) => e.type === 'CLOSE');

                if (!openEntry && !closeEntry) {
                  return (
                    <Typography sx={{ fontSize: 13, color: '#7c8190', textAlign: 'center', py: 4 }}>
                      No trade history found for this position.
                    </Typography>
                  );
                }

                const renderDetails = (entry: any, label: string, color: string) => {
                  const isTrailingStop = entry?.details?.high_water_mark != null &&
                                        entry?.details?.high_water_mark > (entry?.details?.entry_price || 0);

                  return (
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 600, color }}>
                        {label}
                      </Typography>
                      {label === 'CLOSE' && isTrailingStop && (
                        <Chip
                          label="Trailing Stop"
                          size="small"
                          sx={{
                            height: 18,
                            fontSize: 10,
                            backgroundColor: 'rgba(57,217,138,0.15)',
                            color: '#39d98a',
                            '& .MuiChip-label': { px: 1 }
                          }}
                        />
                      )}
                    </Box>
                    {entry ? (
                      <Box sx={{ p: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid #2b2b43' }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 12 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#7c8190' }}>Time:</span>
                            <span style={{ color: '#d1d4dc' }}>
                              {new Date(entry.timestamp * 1000).toLocaleString('en-US', {
                                timeZone: 'America/New_York',
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </span>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#7c8190' }}>Action:</span>
                            <span style={{ color: '#d1d4dc' }}>{entry.details.action}</span>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#7c8190' }}>Quantity:</span>
                            <span style={{ color: '#d1d4dc' }}>{entry.details.quantity}</span>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#7c8190' }}>Price:</span>
                            <span style={{ color: '#d1d4dc' }}>${entry.details.price?.toFixed(2)}</span>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#7c8190' }}>Premium:</span>
                            <span style={{ color: '#d1d4dc' }}>{fmtMoney((entry.details.price || 0) * 100 * (entry.details.quantity || 0))}</span>
                          </Box>
                          {entry.details.entry_price != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>Entry Price:</span>
                              <span style={{ color: '#d1d4dc' }}>${entry.details.entry_price?.toFixed(2)}</span>
                            </Box>
                          )}
                          {entry.details.target_price != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>Target Price:</span>
                              <span style={{ color: '#d1d4dc' }}>${entry.details.target_price?.toFixed(2)}</span>
                            </Box>
                          )}
                          {entry.details.pnl != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>P&L:</span>
                              <span style={{ color: entry.details.pnl >= 0 ? '#39d98a' : '#ff6b6b', fontWeight: 600 }}>
                                {fmtPnl(entry.details.pnl)}
                              </span>
                            </Box>
                          )}
                          {entry.details.pnl_pct != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>P&L %:</span>
                              <span style={{ color: entry.details.pnl_pct >= 0 ? '#39d98a' : '#ff6b6b' }}>
                                {(entry.details.pnl_pct * 100).toFixed(1)}%
                              </span>
                            </Box>
                          )}
                          {entry.details.iv_at_entry != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>IV at Entry:</span>
                              <span style={{ color: '#d1d4dc' }}>{(entry.details.iv_at_entry * 100).toFixed(1)}%</span>
                            </Box>
                          )}
                          {entry.details.iv_at_exit != null && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>IV at Exit:</span>
                              <span style={{ color: '#d1d4dc' }}>{(entry.details.iv_at_exit * 100).toFixed(1)}%</span>
                            </Box>
                          )}
                          {entry.details.high_water_mark != null && entry.details.high_water_mark > 0 && (
                            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#7c8190' }}>Peak Premium:</span>
                              <span style={{ color: '#39d98a', fontWeight: 600 }}>${entry.details.high_water_mark?.toFixed(2)}</span>
                            </Box>
                          )}
                        </Box>
                      </Box>
                    ) : (
                      <Typography sx={{ fontSize: 12, color: '#7c8190', fontStyle: 'italic' }}>
                        No {label.toLowerCase()} data
                      </Typography>
                    )}
                  </Box>
                  );
                };

                return (
                  <Box sx={{ display: 'flex', gap: 3 }}>
                    {renderDetails(openEntry, 'OPEN', '#39d98a')}
                    {renderDetails(closeEntry, 'CLOSE', '#ff6b6b')}
                  </Box>
                );
              })()}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button
            onClick={() => setPositionHistoryDialog(null)}
            sx={{ textTransform: 'none', color: '#9aa0a6' }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Skip Chain Data Dialog */}
      <Dialog
        open={Boolean(skipChainModal)}
        onClose={() => setSkipChainModal(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a', pb: 1 }}>
          Option Chain — Skipped Signal
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#16162a', pt: 1, px: 2 }}>
          {skipChainModal && (() => {
            const d = skipChainModal;
            const candidates = (d.candidate_details ?? []) as Array<Record<string, unknown>>;
            const rangeMin = typeof d.min === 'number' ? d.min : null;
            const rangeMax = typeof d.max === 'number' ? d.max : null;
            const rejectionColors: Record<string, string> = {
              no_quote: 'rgba(120,120,120,0.15)',
              no_conid: 'rgba(120,120,120,0.15)',
              no_premium: 'rgba(180,130,50,0.12)',
              out_of_range: 'rgba(180,80,50,0.12)',
              wide_spread: 'rgba(130,50,180,0.12)',
            };
            const rejectionLabels: Record<string, string> = {
              no_quote: 'No Quote',
              no_conid: 'No ConID',
              no_premium: 'No Premium',
              out_of_range: 'Out of Range',
              wide_spread: 'Wide Spread',
            };
            return (
              <>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1.5, fontSize: 12, color: '#9aa0a6' }}>
                  <span><b style={{ color: '#d1d4dc' }}>{String(d.symbol ?? '')}</b></span>
                  {Boolean(d.right) && <span>{String(d.right) === 'C' ? 'CALL' : 'PUT'}</span>}
                  {Boolean(d.expiration) && <span>{'Exp: '}{String(d.expiration)}</span>}
                  {typeof d.latest_price === 'number' && <span>{'Price: '}{fmtMoney(d.latest_price)}</span>}
                  {typeof d.nearest_strike === 'number' && <span>{'ATM: $'}{String(d.nearest_strike)}</span>}
                  {rangeMin !== null && rangeMax !== null && (
                    <span>{'Range: '}{fmtMoney(rangeMin)}{' – '}{fmtMoney(rangeMax)}</span>
                  )}
                </Box>
                <Box sx={{ overflowX: 'auto' }}>
                  <Table size="small" sx={{ '& th, & td': { fontSize: 11, color: '#c7ccd6', borderColor: '#2b2b43', py: 0.4, px: 1 } }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>Strike</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Bid</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Ask</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Last</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Premium</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Range %</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Spread</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Sprd%</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">IV</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">Delta</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="right">OI</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {candidates.map((c, i) => {
                        const rejection = c.rejection ? String(c.rejection) : null;
                        const bgColor = rejection ? (rejectionColors[rejection] ?? 'transparent') : 'rgba(46,125,50,0.10)';
                        const prem = typeof c.premium === 'number' ? c.premium : null;
                        const inRange = prem !== null && rangeMin !== null && rangeMax !== null && prem >= rangeMin && prem <= rangeMax;
                        return (
                          <TableRow key={i} sx={{ backgroundColor: bgColor }}>
                            <TableCell sx={{ fontWeight: 600 }}>
                              ${typeof c.strike === 'number' ? c.strike : '—'}
                            </TableCell>
                            <TableCell align="right">{typeof c.bid === 'number' ? c.bid.toFixed(2) : '—'}</TableCell>
                            <TableCell align="right">{typeof c.ask === 'number' ? c.ask.toFixed(2) : '—'}</TableCell>
                            <TableCell align="right">{typeof c.last === 'number' ? c.last.toFixed(2) : '—'}</TableCell>
                            <TableCell align="right" sx={{
                              fontWeight: 600,
                              color: prem === null ? '#7c8190' : inRange ? '#39d98a' : '#ff8a65',
                            }}>
                              {prem !== null ? fmtMoney(prem) : '—'}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 10 }}>
                              {(() => {
                                if (prem === null || rangeMin === null || rangeMax === null) return '—';
                                if (prem < rangeMin) {
                                  const pct = ((rangeMin - prem) / rangeMin * 100).toFixed(0);
                                  return <span style={{ color: '#ff8a65' }}>-{pct}%</span>;
                                }
                                if (prem > rangeMax) {
                                  const pct = ((prem - rangeMax) / rangeMax * 100).toFixed(0);
                                  return <span style={{ color: '#ff8a65' }}>+{pct}%</span>;
                                }
                                return <span style={{ color: '#39d98a' }}>in range</span>;
                              })()}
                            </TableCell>
                            <TableCell align="right">{typeof c.spread === 'number' ? `$${c.spread.toFixed(2)}` : '—'}</TableCell>
                            <TableCell align="right">{typeof c.spread_pct === 'number' ? `${c.spread_pct.toFixed(1)}%` : '—'}</TableCell>
                            <TableCell align="right">{typeof c.iv === 'number' ? `${(c.iv * 100).toFixed(1)}%` : '—'}</TableCell>
                            <TableCell align="right">{typeof c.delta === 'number' ? c.delta.toFixed(3) : '—'}</TableCell>
                            <TableCell align="right">{typeof c.oi === 'number' ? c.oi.toLocaleString() : '—'}</TableCell>
                            <TableCell>
                              {rejection ? (
                                <Chip label={rejectionLabels[rejection] ?? rejection} size="small"
                                  sx={{ fontSize: 10, height: 20, backgroundColor: rejectionColors[rejection] ?? '#333', color: '#e0e0e0' }} />
                              ) : (
                                <Chip label="Passed" size="small"
                                  sx={{ fontSize: 10, height: 20, backgroundColor: 'rgba(46,125,50,0.25)', color: '#39d98a' }} />
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
                {rangeMin !== null && rangeMax !== null && (
                  <Typography sx={{ fontSize: 10, color: '#7c8190', mt: 1 }}>
                    Optimal premium range: {fmtMoney(rangeMin)} – {fmtMoney(rangeMax)}. Green premiums are within range.
                  </Typography>
                )}
              </>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button
            onClick={() => setSkipChainModal(null)}
            sx={{ textTransform: 'none', color: '#9aa0a6' }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Position Detail Modal */}
      <Dialog
        open={Boolean(positionDetailModal)}
        onClose={() => setPositionDetailModal(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ color: '#d1d4dc', backgroundColor: '#16162a', pb: 1 }}>
          Position Details
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#16162a', pt: 1, px: 2 }}>
          {positionDetailModal && (() => {
            const { order, ibPos } = positionDetailModal;
            const entryPrice = order.entry_price ?? order.price;
            const targetPrice = order.target_price;
            const currentPremium = ibPos?.market_price ?? null;
            const costBasis = entryPrice != null ? entryPrice * 100 * (order.quantity ?? 1) : null;
            const hwm = order.high_water_mark ?? 0;

            // Trailing stop info
            const globalSettings = autoTraderSettingsQuery.data?.settings as any;
            const override = order.signal_id ? tpOverridesQuery.data?.overrides?.[order.signal_id] : null;
            const useTrailing = override?.useTrailingStop ?? globalSettings?.useTrailingStop ?? false;
            const profitTargetPct = (override?.profitTargetPct ?? globalSettings?.profitTargetPct ?? 8) / 100;
            const trailingStopPct = (override?.trailingStopPct ?? globalSettings?.trailingStopPct ?? 3) / 100;
            const isTrailingActivated = useTrailing && targetPrice != null && hwm >= targetPrice;

            // Hold time
            const holdSec = order.timestamp ? Math.floor(Date.now() / 1000 - order.timestamp) : 0;
            const holdDays = Math.floor(holdSec / 86400);
            const holdHours = Math.floor((holdSec % 86400) / 3600);
            const holdMins = Math.floor((holdSec % 3600) / 60);
            const holdStr = holdDays > 0 ? `${holdDays}d ${holdHours}h` : holdHours > 0 ? `${holdHours}h ${holdMins}m` : `${holdMins}m`;

            // Current P&L from IB
            const livePnl = ibPos?.unrealized_pnl ?? null;
            const livePnlPct = ibPos?.pnl_pct ?? null;

            // Recent auto-trader events for this position
            const posEvents = events
              .filter((e: any) => {
                const d = e.details as any;
                return d?.signal_id === order.signal_id || d?.position_id === order.position_id;
              })
              .slice()
              .sort((a: any, b: any) => b.timestamp - a.timestamp)
              .slice(0, 15);

            // Days to expiry
            let daysToExpiry: number | null = ibPos?.days_to_expiry ?? null;
            if (daysToExpiry == null && order.expiration) {
              const exp = new Date(order.expiration + 'T16:00:00-05:00');
              daysToExpiry = Math.ceil((exp.getTime() - Date.now()) / 86400000);
            }

            const DetailRow = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.3 }}>
                <span style={{ color: '#7c8190', fontSize: 12 }}>{label}</span>
                <span style={{ color: color ?? '#d1d4dc', fontSize: 12, fontWeight: 500 }}>{value}</span>
              </Box>
            );

            return (
              <>
                {/* Header */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontSize: 16, fontWeight: 700, color: '#d1d4dc' }}>
                    {order.symbol}
                  </Typography>
                  <Chip label={order.right === 'C' ? 'CALL' : 'PUT'} size="small"
                    sx={{ height: 20, fontSize: 10, fontWeight: 700,
                      backgroundColor: order.right === 'C' ? 'rgba(57,217,138,0.15)' : 'rgba(255,107,107,0.15)',
                      color: order.right === 'C' ? '#39d98a' : '#ff6b6b' }} />
                  <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc' }}>
                    ${order.strike}
                  </Typography>
                  {order.expiration && (
                    <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                      {order.expiration}{daysToExpiry != null && ` (${daysToExpiry}d)`}
                    </Typography>
                  )}
                  {order.mode && (
                    <Chip label={order.mode} size="small"
                      sx={{ height: 18, fontSize: 9,
                        backgroundColor: order.mode === 'live' ? 'rgba(255,107,107,0.15)' : 'rgba(144,202,249,0.15)',
                        color: order.mode === 'live' ? '#ff6b6b' : '#90caf9' }} />
                  )}
                </Box>

                {/* 1-Minute Chart */}
                <MiniChart symbol={order.symbol} entryPrice={entryPrice} />

                {/* Entry / Target / Live — 3-column layout */}
                <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
                  {/* Entry Details */}
                  <Box sx={{ flex: 1, p: 1.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid #2b2b43' }}>
                    <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#7c8190', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Entry</Typography>
                    <DetailRow label="Opened" value={order.timestamp
                      ? new Date(order.timestamp * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : '—'} />
                    <DetailRow label="Quantity" value={`${order.quantity} contracts`} />
                    <DetailRow label="Entry Price" value={entryPrice != null ? `$${entryPrice.toFixed(2)}` : '—'} />
                    <DetailRow label="Cost Basis" value={costBasis != null ? fmtMoney(costBasis) : '—'} />
                    <DetailRow label="Hold Time" value={holdStr} />
                    {order.strategy_id && <DetailRow label="Strategy" value={order.strategy_id} />}
                    {order.iv_at_entry != null && (
                      <DetailRow label="IV at Entry" value={`${(order.iv_at_entry * 100).toFixed(1)}%`} />
                    )}
                    {order.delta_at_entry != null && (
                      <DetailRow label="Delta at Entry" value={order.delta_at_entry.toFixed(3)} />
                    )}
                  </Box>

                  {/* Target & Trailing Stop */}
                  <Box sx={{ flex: 1, p: 1.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid #2b2b43' }}>
                    <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#7c8190', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Target & Stop
                      {override && <Chip label="Custom TP" size="small" sx={{ height: 16, fontSize: 9, ml: 1, backgroundColor: 'rgba(144,202,249,0.15)', color: '#90caf9', '& .MuiChip-label': { px: 0.75 } }} />}
                    </Typography>
                    <DetailRow label="Target Price" value={targetPrice != null ? `$${targetPrice.toFixed(2)}` : '—'} />
                    <DetailRow label="Profit Target" value={`${(profitTargetPct * 100).toFixed(1)}%`} />
                    {currentPremium != null && targetPrice != null && (
                      <DetailRow label="Progress to TP" value={`${((currentPremium / targetPrice) * 100).toFixed(1)}%`}
                        color={currentPremium >= targetPrice ? '#39d98a' : '#f5a623'} />
                    )}
                    <DetailRow label="Trailing Stop" value={useTrailing ? 'Enabled' : 'Disabled'}
                      color={useTrailing ? '#39d98a' : '#7c8190'} />
                    {useTrailing && (
                      <>
                        <DetailRow label="Trail %" value={`${(trailingStopPct * 100).toFixed(2)}%`} />
                        <DetailRow label="High Water Mark" value={hwm > 0 ? `$${hwm.toFixed(2)}` : '—'}
                          color={hwm > 0 ? '#39d98a' : undefined} />
                        <DetailRow label="Trailing Activated" value={isTrailingActivated ? 'Yes' : 'No'}
                          color={isTrailingActivated ? '#39d98a' : '#7c8190'} />
                        {isTrailingActivated && hwm > 0 && (
                          <DetailRow label="Trail Stop Price" value={`$${(hwm * (1 - trailingStopPct)).toFixed(2)}`} color="#f5a623" />
                        )}
                      </>
                    )}
                  </Box>

                  {/* Live Data */}
                  <Box sx={{ flex: 1, p: 1.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid #2b2b43' }}>
                    <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#7c8190', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live (IBKR)</Typography>
                    {ibPos ? (
                      <>
                        {currentPremium != null && (
                          <DetailRow label="Current Premium" value={`$${currentPremium < 0.01 ? currentPremium.toFixed(4) : currentPremium.toFixed(2)}`}
                            color={entryPrice != null && currentPremium >= entryPrice ? '#39d98a' : '#ff6b6b'} />
                        )}
                        {ibPos.market_value != null && <DetailRow label="Market Value" value={fmtMoney(ibPos.market_value)} />}
                        {livePnl != null && (
                          <DetailRow label="Unrealized P&L" value={fmtPnl(livePnl)}
                            color={livePnl >= 0 ? '#39d98a' : '#ff6b6b'} />
                        )}
                        {livePnlPct != null && (
                          <DetailRow label="P&L %" value={`${livePnlPct >= 0 ? '+' : ''}${livePnlPct.toFixed(1)}%`}
                            color={livePnlPct >= 0 ? '#39d98a' : '#ff6b6b'} />
                        )}
                        {ibPos.avg_cost != null && <DetailRow label="Avg Cost" value={`$${ibPos.avg_cost.toFixed(2)}`} />}
                      </>
                    ) : (
                      <Typography sx={{ fontSize: 11, color: '#555', fontStyle: 'italic' }}>Not in IBKR</Typography>
                    )}
                  </Box>
                </Box>

                {/* Recent Events */}
                {posEvents.length > 0 && (
                  <Box sx={{ p: 1.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid #2b2b43' }}>
                    <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#7c8190', mb: 0.75, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recent Events</Typography>
                    {posEvents.map((evt: any, i: number) => {
                      const typeColors: Record<string, string> = {
                        trade_open: '#39d98a',
                        trailing_hwm_update: '#f5a623',
                        trailing_activated: '#90caf9',
                        trailing_breakeven_blocked: '#ff8a65',
                        position_check: '#7c8190',
                        expiry_close_forced: '#ff6b6b',
                      };
                      return (
                        <Box key={`${evt.timestamp}-${i}`} sx={{ mb: 0.5, fontSize: 11 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                            <span style={{ color: typeColors[evt.type] ?? '#9aa0a6', fontWeight: 600 }}>
                              {evt.type.replace(/_/g, ' ')}
                            </span>
                            <span style={{ color: '#7c8190', whiteSpace: 'nowrap', fontSize: 10 }}>
                              {new Date(evt.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })}
                            </span>
                          </Box>
                          <Typography sx={{ fontSize: 10, color: '#7c8190', ml: 0 }}>{evt.message}</Typography>
                        </Box>
                      );
                    })}
                  </Box>
                )}

                {/* IDs */}
                <Box sx={{ mt: 1.5, fontSize: 10, color: '#555', display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                  {order.signal_id && <span>Signal: {order.signal_id}</span>}
                  {order.position_id && <span>Position: {order.position_id}</span>}
                </Box>
              </>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#16162a', px: 2, pb: 2 }}>
          <Button
            onClick={() => setPositionDetailModal(null)}
            sx={{ textTransform: 'none', color: '#9aa0a6' }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
      {/* Open Positions by Strategy Modal */}
      <Dialog
        open={openPosModalOpen}
        onClose={() => setOpenPosModalOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { backgroundColor: '#0d1117', color: '#d1d4dc', borderRadius: 2 } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, borderBottom: '1px solid #1f2533', pb: 1.5 }}>
          Open Positions by Strategy
        </DialogTitle>
        <DialogContent sx={{ pt: 2.5 }}>
          {(() => {
            const STRAT_COLORS: Record<string, string> = {
              strategy1: '#42a5f5', strategy2: '#66bb6a', strategy3: '#ab47bc',
              strategy4: '#ef5350', strategy5: '#ffa726', ct15: '#26c6da',
              ct_open: '#ec407a', strategy7: '#8d6e63', strategy8: '#78909c',
              strategy9: '#d4e157', strategy10: '#7e57c2', strategy11: '#29b6f6',
            };
            const allOpen = ordersQuery.data?.open_positions ?? [];
            const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
            const todayOpen = allOpen.filter((o: any) => {
              const dateKey = o.timestamp
                ? new Date(o.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
                : '';
              return dateKey === todayStr;
            });

            if (todayOpen.length === 0) {
              return <Typography sx={{ fontSize: 13, color: '#787b86', textAlign: 'center', py: 4 }}>No open positions today</Typography>;
            }

            // Group by strategy
            const byStrategy: Record<string, { count: number; capital: number; positions: any[] }> = {};
            todayOpen.forEach((o: any) => {
              const sid = o.strategy_id ?? 'unknown';
              if (!byStrategy[sid]) byStrategy[sid] = { count: 0, capital: 0, positions: [] };
              byStrategy[sid].count += 1;
              byStrategy[sid].capital += (o.price ?? 0) * 100 * (o.quantity ?? 1);
              byStrategy[sid].positions.push(o);
            });

            const entries = Object.entries(byStrategy).sort((a, b) => b[1].capital - a[1].capital);
            const maxCapital = Math.max(...entries.map(([, v]) => v.capital), 1);
            const totalCapital = entries.reduce((s, [, v]) => s + v.capital, 0);

            return (
              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                  <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>{todayOpen.length} position{todayOpen.length !== 1 ? 's' : ''} today</Typography>
                  <Typography sx={{ fontSize: 12, color: '#d1d4dc', fontWeight: 600 }}>Total: {fmtMoney(totalCapital)}</Typography>
                </Box>
                {entries.map(([sid, data]) => {
                  const color = STRAT_COLORS[sid] ?? '#888';
                  const pct = maxCapital > 0 ? (data.capital / maxCapital) * 100 : 0;
                  const label = (STRATEGY_METADATA[sid]?.name) ?? sid;
                  const isExpanded = expandedStrategies.has(sid);
                  return (
                    <Box key={sid} sx={{ mb: 1.5 }}>
                      <Box
                        onClick={() => setExpandedStrategies(prev => {
                          const next = new Set(prev);
                          next.has(sid) ? next.delete(sid) : next.add(sid);
                          return next;
                        })}
                        sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.3, cursor: 'pointer', '&:hover': { opacity: 0.85 } }}
                      >
                        <Typography sx={{ fontSize: 11, color: '#d1d4dc', fontWeight: 500 }}>
                          <span style={{ display: 'inline-block', width: 12, fontSize: 9, color: '#787b86' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          {label}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                          {data.count} pos · {fmtMoney(data.capital)} ({((data.capital / totalCapital) * 100).toFixed(0)}%)
                        </Typography>
                      </Box>
                      <Box sx={{ height: 18, backgroundColor: '#141926', borderRadius: 1, overflow: 'hidden' }}>
                        <Box sx={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 1, transition: 'width 0.3s ease' }} />
                      </Box>
                      {isExpanded && (
                        <Box sx={{ mt: 0.5, pl: 1.5, py: 0.5, backgroundColor: '#0a0e14', borderRadius: 1, borderLeft: `2px solid ${color}` }}>
                          {data.positions.map((p: any, i: number) => (
                            <Typography key={i} sx={{ fontSize: 10, color: '#9aa0a6', py: 0.2 }}>
                              {p.symbol} {p.direction === 'call' ? 'C' : p.direction === 'put' ? 'P' : p.direction} {p.strike} · {fmtMoney((p.price ?? 0) * 100 * (p.quantity ?? 1))}
                              {p.pnl_pct != null && (
                                <span style={{ color: p.pnl_pct >= 0 ? '#39d98a' : '#ff6b6b', marginLeft: 6 }}>
                                  {p.pnl_pct >= 0 ? '+' : ''}{(p.pnl_pct * 100).toFixed(1)}%
                                </span>
                              )}
                            </Typography>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#0d1117', borderTop: '1px solid #1a1e2e', px: 2, pb: 1.5 }}>
          <Button onClick={() => setOpenPosModalOpen(false)} sx={{ textTransform: 'none', color: '#9aa0a6' }}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Closed Positions by Strategy Modal */}
      <Dialog
        open={closedPosModalOpen}
        onClose={() => setClosedPosModalOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { backgroundColor: '#0d1117', color: '#d1d4dc', borderRadius: 2 } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, borderBottom: '1px solid #1f2533', pb: 1.5 }}>
          Closed Positions by Strategy
        </DialogTitle>
        <DialogContent sx={{ pt: 2.5 }}>
          {(() => {
            const STRAT_COLORS: Record<string, string> = {
              strategy1: '#42a5f5', strategy2: '#66bb6a', strategy3: '#ab47bc',
              strategy4: '#ef5350', strategy5: '#ffa726', ct15: '#26c6da',
              ct_open: '#ec407a', strategy7: '#8d6e63', strategy8: '#78909c',
              strategy9: '#d4e157', strategy10: '#7e57c2', strategy11: '#29b6f6',
            };
            const allClosed = ordersQuery.data?.orders?.filter((o: any) => o.type === 'CLOSE' && (!o.mode || o.mode === currentMode)) ?? [];
            const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
            const todayClosed = allClosed.filter((o: any) => {
              const dateKey = o.timestamp
                ? new Date(o.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
                : '';
              return dateKey === todayStr;
            });

            if (todayClosed.length === 0) {
              return <Typography sx={{ fontSize: 13, color: '#787b86', textAlign: 'center', py: 4 }}>No closed positions today</Typography>;
            }

            // Group by strategy
            const byStrategy: Record<string, { count: number; totalPnl: number; positions: any[] }> = {};
            todayClosed.forEach((o: any) => {
              const sid = o.strategy_id ?? 'unknown';
              if (!byStrategy[sid]) byStrategy[sid] = { count: 0, totalPnl: 0, positions: [] };
              byStrategy[sid].count += 1;
              byStrategy[sid].totalPnl += (o.pnl ?? 0);
              byStrategy[sid].positions.push(o);
            });

            const entries = Object.entries(byStrategy).sort((a, b) => b[1].totalPnl - a[1].totalPnl);
            const maxAbsPnl = Math.max(...entries.map(([, v]) => Math.abs(v.totalPnl)), 1);
            const totalPnl = entries.reduce((s, [, v]) => s + v.totalPnl, 0);
            const wins = todayClosed.filter((o: any) => (o.pnl ?? 0) > 0).length;
            const losses = todayClosed.filter((o: any) => (o.pnl ?? 0) < 0).length;

            return (
              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                  <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                    {todayClosed.length} closed today · {wins}W / {losses}L
                  </Typography>
                  <Typography sx={{ fontSize: 12, fontWeight: 600, color: totalPnl >= 0 ? '#39d98a' : '#ff6b6b' }}>
                    P&L: {fmtPnl(totalPnl)}
                  </Typography>
                </Box>
                {entries.map(([sid, data]) => {
                  const color = STRAT_COLORS[sid] ?? '#888';
                  const pct = maxAbsPnl > 0 ? (Math.abs(data.totalPnl) / maxAbsPnl) * 100 : 0;
                  const label = (STRATEGY_METADATA[sid]?.name) ?? sid;
                  const isExpanded = expandedClosedStrategies.has(sid);
                  const stratWins = data.positions.filter((p: any) => (p.pnl ?? 0) > 0).length;
                  const stratLosses = data.positions.filter((p: any) => (p.pnl ?? 0) < 0).length;
                  return (
                    <Box key={sid} sx={{ mb: 1.5 }}>
                      <Box
                        onClick={() => setExpandedClosedStrategies(prev => {
                          const next = new Set(prev);
                          next.has(sid) ? next.delete(sid) : next.add(sid);
                          return next;
                        })}
                        sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.3, cursor: 'pointer', '&:hover': { opacity: 0.85 } }}
                      >
                        <Typography sx={{ fontSize: 11, color: '#d1d4dc', fontWeight: 500 }}>
                          <span style={{ display: 'inline-block', width: 12, fontSize: 9, color: '#787b86' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          {label}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                          {data.count} trades · {stratWins}W/{stratLosses}L · <span style={{ color: data.totalPnl >= 0 ? '#39d98a' : '#ff6b6b' }}>{fmtPnl(data.totalPnl)}</span>
                        </Typography>
                      </Box>
                      <Box sx={{ height: 18, backgroundColor: '#141926', borderRadius: 1, overflow: 'hidden' }}>
                        <Box sx={{ width: `${pct}%`, height: '100%', backgroundColor: data.totalPnl >= 0 ? color : '#ef5350', borderRadius: 1, opacity: data.totalPnl >= 0 ? 1 : 0.7, transition: 'width 0.3s ease' }} />
                      </Box>
                      {isExpanded && (
                        <Box sx={{ mt: 0.5, pl: 1.5, py: 0.5, backgroundColor: '#0a0e14', borderRadius: 1, borderLeft: `2px solid ${color}` }}>
                          {data.positions.map((p: any, i: number) => (
                            <Typography key={i} sx={{ fontSize: 10, color: '#9aa0a6', py: 0.2 }}>
                              {p.symbol} {p.action === 'SELL' ? 'S' : 'B'} {p.right === 'C' ? 'Call' : p.right === 'P' ? 'Put' : (p.direction === 'call' ? 'C' : p.direction === 'put' ? 'P' : p.direction)} {p.strike}
                              {p.pnl != null && (
                                <span style={{ color: p.pnl >= 0 ? '#39d98a' : '#ff6b6b', marginLeft: 6 }}>
                                  {fmtPnl(p.pnl)}
                                </span>
                              )}
                              {p.pnl_pct != null && (
                                <span style={{ color: p.pnl_pct >= 0 ? '#39d98a' : '#ff6b6b', marginLeft: 4 }}>
                                  ({p.pnl_pct >= 0 ? '+' : ''}{(p.pnl_pct * 100).toFixed(1)}%)
                                </span>
                              )}
                            </Typography>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#0d1117', borderTop: '1px solid #1a1e2e', px: 2, pb: 1.5 }}>
          <Button onClick={() => setClosedPosModalOpen(false)} sx={{ textTransform: 'none', color: '#9aa0a6' }}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
