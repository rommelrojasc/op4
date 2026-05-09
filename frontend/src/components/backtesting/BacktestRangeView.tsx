/**
 * BacktestRangeView — Multi-day range analysis results UI
 */
import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Alert,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  LinearProgress,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts';
import { API_BASE_URL } from '@/services/api/marketData';
import { StrategyFilterButton, DEFAULT_ENABLED, enabledStrategiesToParam, type EnabledStrategies } from '@/components/backtesting/StrategyFilterButton';
import { playDoneSound } from '@/utils/sound';
import { TickerSelectionModal, CompanyLogo } from '@/components/backtesting/TickerSelectionModal';
import { SYMBOL_NAMES } from '@/constants/symbols';
import { subDays } from 'date-fns';
import type {
  BacktestRangeResponse,
  BacktestRangeDistributionBucket,
  BacktestRangeSignalDetail,
  Bar,
} from '@/types/chart.types';

const cellSx = { color: '#d1d4dc', borderColor: '#2b2b43', fontSize: 13, py: 1 };
const headerCellSx = { ...cellSx, fontWeight: 600, color: '#787b86', fontSize: 12 };

const TOOLTIPS = {
  mfe: 'Max Favorable Excursion — the largest price move in the profitable direction after entry, measured on the underlying stock',
  mae: 'Max Adverse Excursion — the largest price move against the position after entry, measured on the underlying stock',
  ci: 'Choppiness Index — measures whether the market is trending or range-bound. Below 38.2 = trending, above 61.8 = choppy',
  rr: 'Reward-to-Risk ratio — MFE divided by MAE. Above 1.0 means the favorable move was larger than the adverse move',
  med: 'Median — the middle value when all values are sorted. Less affected by outliers than the average',
  avg: 'Average (mean) — sum of all values divided by the count',
  regime: 'Market regime classification based on the Choppiness Index average for that day',
  session: 'Hour of the trading day (ET) when the signal was generated',
  outcome: 'Simulated trade outcome based on stock price movement. Win = MFE > MAE (price moved more favorably than adversely)',
  p25: '25th percentile — 25% of values fall below this threshold',
  p75: '75th percentile — 75% of values fall below this threshold',
};

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip
      title={text}
      placement="top"
      arrow
      slotProps={{
        tooltip: { sx: { bgcolor: '#1e2433', color: '#d1d4dc', fontSize: 12, maxWidth: 280, border: '1px solid #2b2b43' } },
        arrow: { sx: { color: '#1e2433' } },
      }}
    >
      <InfoOutlinedIcon sx={{ fontSize: 14, color: '#787b86', ml: 0.5, verticalAlign: 'middle', cursor: 'help' }} />
    </Tooltip>
  );
}

function HeaderWithInfo({ label, tooltip, align }: { label: string; tooltip: string; align?: 'left' | 'center' | 'right' }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', width: '100%' }}>
      {label}
      <InfoTip text={tooltip} />
    </Box>
  );
}

function formatDate(date: Date | null): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function RegimeChip({ regime }: { regime: string | null }) {
  if (!regime) return <Chip label="N/A" size="small" sx={{ fontSize: 11 }} />;
  const colors: Record<string, { bg: string; color: string }> = {
    trending: { bg: '#1b5e20', color: '#81c784' },
    choppy: { bg: '#4a3f10', color: '#ffd54f' },
    mixed: { bg: '#1a237e', color: '#90caf9' },
  };
  const c = colors[regime] || { bg: '#333', color: '#aaa' };
  return (
    <Chip
      label={regime}
      size="small"
      sx={{ fontSize: 11, backgroundColor: c.bg, color: c.color, textTransform: 'capitalize' }}
    />
  );
}

function OutcomeChip({ mfe, mae }: { mfe: number | null; mae: number | null }) {
  if (mfe == null || mae == null) return <Typography sx={{ fontSize: 12, color: '#787b86' }}>—</Typography>;
  const rr = mae > 0 ? mfe / mae : mfe > 0 ? 99 : 0;
  const isWin = mfe > mae;
  const isBigWin = rr >= 2;
  const isBigLoss = rr < 0.5 && !isWin;

  let bg: string, color: string, label: string;
  if (isBigWin) {
    bg = '#1b5e20'; color = '#81c784'; label = 'Strong';
  } else if (isWin) {
    bg = '#1b3a2a'; color = '#66bb6a'; label = 'Win';
  } else if (isBigLoss) {
    bg = '#5c1a1a'; color = '#ef9a9a'; label = 'Loss';
  } else {
    bg = '#4a3020'; color = '#ffab91'; label = 'Weak';
  }

  return (
    <Chip
      label={label}
      size="small"
      sx={{ fontSize: 11, backgroundColor: bg, color, minWidth: 50 }}
    />
  );
}

function StatCard({ label, value, suffix, tooltip }: { label: string; value: number | null; suffix?: string; tooltip?: string }) {
  return (
    <Box sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', borderRadius: 1, p: 1.5, minWidth: 120, flex: 1 }}>
      <Typography sx={{ fontSize: 11, color: '#787b86', mb: 0.5 }}>
        {label}
        {tooltip && <InfoTip text={tooltip} />}
      </Typography>
      <Typography sx={{ fontSize: 18, fontWeight: 600, color: '#d1d4dc' }}>
        {value != null ? `${value.toFixed(2)}${suffix || ''}` : '—'}
      </Typography>
    </Box>
  );
}

function CombinedDistribution({
  mfeBuckets,
  maeBuckets,
}: {
  mfeBuckets: BacktestRangeDistributionBucket[];
  maeBuckets: BacktestRangeDistributionBucket[];
}) {
  const max = Math.max(...mfeBuckets.map((b) => b.count), ...maeBuckets.map((b) => b.count), 1);
  // Both use same bucket labels
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {mfeBuckets.map((mfe, i) => {
        const mae = maeBuckets[i];
        return (
          <Box key={mfe.label} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {/* MFE count */}
            <Typography sx={{ fontSize: 11, color: '#26a69a', width: 24, textAlign: 'right', flexShrink: 0 }}>{mfe.count}</Typography>
            {/* MFE bar (right-aligned, grows leftward) */}
            <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end' }}>
              <Box
                sx={{
                  height: '100%',
                  width: `${(mfe.count / max) * 100}%`,
                  bgcolor: '#26a69a',
                  borderRadius: 0.5,
                  minWidth: mfe.count > 0 ? 4 : 0,
                }}
              />
            </Box>
            {/* Label */}
            <Typography sx={{ fontSize: 11, color: '#d1d4dc', width: 60, textAlign: 'center', flexShrink: 0, fontWeight: 500 }}>
              {mfe.label}
            </Typography>
            {/* MAE bar (left-aligned, grows rightward) */}
            <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden' }}>
              <Box
                sx={{
                  height: '100%',
                  width: `${(mae.count / max) * 100}%`,
                  bgcolor: '#ef5350',
                  borderRadius: 0.5,
                  minWidth: mae.count > 0 ? 4 : 0,
                }}
              />
            </Box>
            {/* MAE count */}
            <Typography sx={{ fontSize: 11, color: '#ef5350', width: 24, textAlign: 'left', flexShrink: 0 }}>{mae.count}</Typography>
          </Box>
        );
      })}
      {/* Legend */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mt: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#26a69a', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>MFE (favorable)<InfoTip text={TOOLTIPS.mfe} /></Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#ef5350', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>MAE (adverse)<InfoTip text={TOOLTIPS.mae} /></Typography>
        </Box>
      </Box>
    </Box>
  );
}

function HourlyOutcomeChart({ signals }: { signals: BacktestRangeSignalDetail[] }) {
  const HOURS = ['9', '10', '11', '12', '13', '14', '15'];

  // Aggregate wins/losses per hour
  const hourData = HOURS.map((h) => {
    const hourSignals = signals.filter(
      (s) => s.session === h && s.mfe_pct != null && s.mae_pct != null
    );
    const wins = hourSignals.filter((s) => s.mfe_pct! > s.mae_pct!).length;
    const losses = hourSignals.length - wins;
    const winRate = hourSignals.length > 0 ? (wins / hourSignals.length) * 100 : 0;
    return { hour: h, wins, losses, total: hourSignals.length, winRate };
  });

  const maxCount = Math.max(...hourData.map((d) => Math.max(d.wins, d.losses)), 1);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {hourData.map((d) => (
        <Box key={d.hour} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {/* Win count */}
          <Typography sx={{ fontSize: 11, color: '#26a69a', width: 24, textAlign: 'right', flexShrink: 0 }}>
            {d.wins}
          </Typography>
          {/* Win bar (right-aligned, grows leftward) */}
          <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end' }}>
            <Box
              sx={{
                height: '100%',
                width: `${(d.wins / maxCount) * 100}%`,
                bgcolor: '#26a69a',
                borderRadius: 0.5,
                minWidth: d.wins > 0 ? 4 : 0,
              }}
            />
          </Box>
          {/* Hour label + win rate */}
          <Box sx={{ width: 80, textAlign: 'center', flexShrink: 0 }}>
            <Typography sx={{ fontSize: 11, color: '#d1d4dc', fontWeight: 500, lineHeight: 1.2 }}>
              {d.hour === '9' ? '9:30' : `${d.hour}:00`}
            </Typography>
            {d.total > 0 && (
              <Typography sx={{ fontSize: 10, color: d.winRate >= 50 ? '#26a69a' : '#ef5350', lineHeight: 1.2 }}>
                {d.winRate.toFixed(0)}% win
              </Typography>
            )}
          </Box>
          {/* Loss bar (left-aligned, grows rightward) */}
          <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden' }}>
            <Box
              sx={{
                height: '100%',
                width: `${(d.losses / maxCount) * 100}%`,
                bgcolor: '#ef5350',
                borderRadius: 0.5,
                minWidth: d.losses > 0 ? 4 : 0,
              }}
            />
          </Box>
          {/* Loss count */}
          <Typography sx={{ fontSize: 11, color: '#ef5350', width: 24, textAlign: 'left', flexShrink: 0 }}>
            {d.losses}
          </Typography>
        </Box>
      ))}
      {/* Legend */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mt: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#26a69a', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>Win (MFE {'>'} MAE)</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#ef5350', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>Loss (MFE {'≤'} MAE)</Typography>
        </Box>
      </Box>
    </Box>
  );
}

function SessionHeatCell({ value, maxVal }: { value: number; maxVal: number }) {
  const intensity = maxVal > 0 ? value / maxVal : 0;
  const bg = intensity > 0 ? `rgba(41, 98, 255, ${0.15 + intensity * 0.5})` : 'transparent';
  return (
    <TableCell sx={{ ...cellSx, textAlign: 'center', backgroundColor: bg }}>
      {value}
    </TableCell>
  );
}

/** Standalone 15m candlestick chart with signal markers */
function RangeChart({ bars, signals }: { bars: Bar[]; signals: BacktestRangeSignalDetail[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    // Create chart
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0c111a' },
        textColor: '#787b86',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1a1f2e' },
        horzLines: { color: '#1a1f2e' },
      },
      crosshair: {
        vertLine: { color: '#4b4b63', width: 1, style: 2 },
        horzLine: { color: '#4b4b63', width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: '#2b2b43',
      },
      timeScale: {
        borderColor: '#2b2b43',
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: 300,
    });
    chartRef.current = chart;

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    seriesRef.current = series;

    // Set candlestick data
    const candleData: CandlestickData[] = bars.map((b) => ({
      time: b.time as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    series.setData(candleData);

    // Add signal markers
    if (signals.length > 0) {
      const markers = signals
        .filter((sig) => sig.entry_time > 0)
        .map((sig) => ({
          time: sig.entry_time as Time,
          position: sig.direction === 'CALL' ? 'belowBar' as const : 'aboveBar' as const,
          color: '#ffd54f',
          shape: sig.direction === 'CALL' ? 'arrowUp' as const : 'arrowDown' as const,
          text: sig.strategy_id.replace('strategy', 'S'),
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      series.setMarkers(markers);
    }

    chart.timeScale().fitContent();

    // Resize handler
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [bars, signals]);

  if (bars.length === 0) {
    return (
      <Box sx={{ border: '1px solid #2b2b43', borderRadius: 1, p: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography sx={{ fontSize: 13, color: '#787b86' }}>
          No 15-minute bar data available. Check that IB Gateway is connected and the market was open during the selected date range.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ border: '1px solid #2b2b43', borderRadius: 1, overflow: 'hidden', flexShrink: 0 }}>
      <Box ref={containerRef} sx={{ width: '100%', height: 300 }} />
    </Box>
  );
}

export function BacktestRangeView({ viewMode, setViewMode }: { viewMode: string; setViewMode: (v: string) => void }) {
  const [startDate, setStartDate] = useState<Date | null>(subDays(new Date(), 7));
  const [endDate, setEndDate] = useState<Date | null>(subDays(new Date(), 1));
  const [selectedSymbol, setSelectedSymbol] = useState('SPX');
  const [tickerModalOpen, setTickerModalOpen] = useState(false);

  const [enabledStrategies, setEnabledStrategies] = useState<EnabledStrategies>(DEFAULT_ENABLED);
  const [data, setData] = useState<BacktestRangeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const esRef = useRef<EventSource | null>(null);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const handleRun = () => {
    if (!startDate || !endDate) return;

    // Close any existing stream
    esRef.current?.close();

    setIsLoading(true);
    setError(null);
    setData(null);
    setStatusMessage('Starting analysis...');

    const params = new URLSearchParams({
      symbol: selectedSymbol.toUpperCase(),
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
    });
    const esParam = enabledStrategiesToParam(enabledStrategies);
    if (esParam) params.set('enabled_strategies', esParam);

    const es = new EventSource(
      `${API_BASE_URL}/api/v1/market-data/backtest-range-stream?${params}`
    );
    esRef.current = es;

    es.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'progress') {
        setStatusMessage(msg.message);
      } else if (msg.type === 'result') {
        setData(msg.data);
        setIsLoading(false);
        setStatusMessage('');
        playDoneSound();
        es.close();
      } else if (msg.type === 'error') {
        setError(msg.message);
        setIsLoading(false);
        setStatusMessage('');
        es.close();
      }
    };

    es.onerror = () => {
      setError('Connection lost during analysis');
      setIsLoading(false);
      setStatusMessage('');
      es.close();
    };
  };

  // Session heatmap max for intensity scaling
  const TRADING_HOURS = ['9', '10', '11', '12', '13', '14', '15'];
  const sessionMax = data
    ? Math.max(...(data.session_matrix || []).flatMap((r) => TRADING_HOURS.map((h) => r.hours[h] || 0)), 1)
    : 1;

  // Signals summary stats
  const signalStats = data ? (() => {
    const details = data.signals_detail;
    const withData = details.filter((s) => s.mfe_pct != null && s.mae_pct != null);
    const wins = withData.filter((s) => s.mfe_pct! > s.mae_pct!);
    return { total: withData.length, wins: wins.length, winRate: withData.length > 0 ? (wins.length / withData.length * 100) : 0 };
  })() : null;

  const datePickerSx = {
    minWidth: 160,
    '& .MuiOutlinedInput-root': {
      color: '#d1d4dc',
      '& fieldset': { borderColor: '#2b2b43' },
      '&:hover fieldset': { borderColor: '#4b4b63' },
    },
    '& .MuiInputLabel-root': { color: '#787b86' },
  };

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Controls — single row */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderBottom: '1px solid #2b2b43', bgcolor: '#0c111a', flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 16, fontWeight: 600, color: '#d1d4dc' }}>Backtesting</Typography>
          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={(_, v) => v && setViewMode(v)}
            size="small"
          >
            <ToggleButton value="single" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Single Day
            </ToggleButton>
            <ToggleButton value="range" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Range Analysis
            </ToggleButton>
            <ToggleButton value="cross-symbol" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Cross-Symbol
            </ToggleButton>
          </ToggleButtonGroup>

          <DatePicker
            label="Start"
            value={startDate}
            onChange={setStartDate}
            maxDate={new Date()}
            format="MMM d, yyyy"
            slotProps={{ textField: { size: 'small', sx: datePickerSx } }}
          />
          <Typography sx={{ color: '#787b86', fontSize: 13 }}>to</Typography>
          <DatePicker
            label="End"
            value={endDate}
            onChange={setEndDate}
            maxDate={new Date()}
            format="MMM d, yyyy"
            slotProps={{ textField: { size: 'small', sx: datePickerSx } }}
          />

          <Box
            onClick={() => setTickerModalOpen(true)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 1, pl: 0.5, pr: 2, py: 0.5,
              borderRadius: '20px', bgcolor: '#2b2b43', cursor: 'pointer',
              '&:hover': { bgcolor: '#3b3b53' },
            }}
          >
            <CompanyLogo symbol={selectedSymbol} size={28} />
            <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc' }}>{selectedSymbol}</Typography>
            <Typography sx={{ fontSize: 12, color: '#787b86', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {SYMBOL_NAMES[selectedSymbol]?.split(',')[0] || ''}
            </Typography>
          </Box>

          <StrategyFilterButton enabled={enabledStrategies} onChange={setEnabledStrategies} />

          <Button
            variant="contained"
            onClick={handleRun}
            disabled={!startDate || !endDate || isLoading}
            sx={{ textTransform: 'none', bgcolor: '#2962ff', '&:hover': { bgcolor: '#1e53e5' }, minWidth: 120 }}
          >
            {isLoading ? (
              <>
                <CircularProgress size={16} sx={{ mr: 1, color: 'white' }} />
                Analyzing...
              </>
            ) : (
              'Run Analysis'
            )}
          </Button>

          {/* Progress status */}
          {statusMessage && (
            <Typography sx={{ fontSize: 13, color: '#787b86', fontStyle: 'italic' }}>
              {statusMessage}
            </Typography>
          )}
        </Box>

        {/* Loading */}
        {isLoading && <LinearProgress sx={{ bgcolor: '#1a1f2e', '& .MuiLinearProgress-bar': { bgcolor: '#2962ff' } }} />}

        {/* Error */}
        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            Error: {error}
          </Alert>
        )}

        {/* Results */}
        {data && !isLoading && (
          <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* 15m Candlestick Chart */}
            <RangeChart bars={data.bars_15m} signals={data.signals_detail} />

            {/* Overview Banner */}
            <Box sx={{ display: 'flex', gap: 2 }}>
              <StatCard label="Total Signals" value={data.total_signals} />
              <StatCard label="Days Analyzed" value={data.trading_days_requested} />
              <StatCard label="Days With Data" value={data.trading_days_with_data} />
              <StatCard
                label="Signals / Day"
                value={data.trading_days_with_data > 0 ? data.total_signals / data.trading_days_with_data : 0}
              />
            </Box>

            {/* Strategy Summary Table */}
            <Box>
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>Strategy Summary</Typography>
              <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={headerCellSx}>Strategy</TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>Total</TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>CALL</TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>PUT</TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                        <HeaderWithInfo label="Avg MFE%" tooltip={`${TOOLTIPS.avg}\n\n${TOOLTIPS.mfe}`} align="right" />
                      </TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                        <HeaderWithInfo label="Avg MAE%" tooltip={`${TOOLTIPS.avg}\n\n${TOOLTIPS.mae}`} align="right" />
                      </TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                        <HeaderWithInfo label="Med MFE%" tooltip={`${TOOLTIPS.med}\n\n${TOOLTIPS.mfe}`} align="right" />
                      </TableCell>
                      <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                        <HeaderWithInfo label="Med MAE%" tooltip={`${TOOLTIPS.med}\n\n${TOOLTIPS.mae}`} align="right" />
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(data.strategies).map(([id, s]) => (
                      <TableRow key={id}>
                        <TableCell sx={cellSx}>{s.name}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'center' }}>{s.total}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'center', color: '#26a69a' }}>{s.calls}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'center', color: '#ef5350' }}>{s.puts}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'right' }}>
                          {s.avg_mfe_pct != null ? s.avg_mfe_pct.toFixed(3) : '—'}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'right' }}>
                          {s.avg_mae_pct != null ? s.avg_mae_pct.toFixed(3) : '—'}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'right' }}>
                          {s.median_mfe_pct != null ? s.median_mfe_pct.toFixed(3) : '—'}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'right' }}>
                          {s.median_mae_pct != null ? s.median_mae_pct.toFixed(3) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>

            {/* Choppiness Section */}
            <Box>
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                Market Regime
                <InfoTip text={TOOLTIPS.ci} />
              </Typography>
              <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                <StatCard label="Avg CI" value={data.choppiness.avg_ci} tooltip={TOOLTIPS.ci} />
                <StatCard label="Trending Days" value={data.choppiness.trending_days} tooltip="Days with CI below 38.2 — strong directional movement" />
                <StatCard label="Choppy Days" value={data.choppiness.choppy_days} tooltip="Days with CI above 61.8 — sideways, range-bound price action" />
                <StatCard label="Mixed Days" value={data.choppiness.mixed_days} tooltip="Days with CI between 38.2 and 61.8 — neither clearly trending nor choppy" />
              </Box>
              <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', maxHeight: 300 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28' }}>Date</TableCell>
                      <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'center' }}>Signals</TableCell>
                      <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'right' }}>
                        <HeaderWithInfo label="CI Avg" tooltip={TOOLTIPS.ci} align="right" />
                      </TableCell>
                      <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'center' }}>
                        <HeaderWithInfo label="Regime" tooltip={TOOLTIPS.regime} align="center" />
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.days.map((day) => (
                      <TableRow key={day.date} sx={{ opacity: day.has_data ? 1 : 0.4 }}>
                        <TableCell sx={cellSx}>{day.date}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'center' }}>{day.signal_count}</TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'right' }}>
                          {day.choppiness_avg != null ? day.choppiness_avg.toFixed(1) : '—'}
                        </TableCell>
                        <TableCell sx={{ ...cellSx, textAlign: 'center' }}>
                          <RegimeChip regime={day.regime} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>

            {/* Session Heatmap */}
            {data.session_matrix.length > 0 && (
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  Session Edge
                  <InfoTip text={TOOLTIPS.session} />
                </Typography>
                <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={headerCellSx}>Strategy</TableCell>
                        {TRADING_HOURS.map((h) => (
                          <TableCell key={h} sx={{ ...headerCellSx, textAlign: 'center' }}>
                            {h === '9' ? '9:30' : `${h}:00`}
                          </TableCell>
                        ))}
                        <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>Total</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.session_matrix.map((row) => (
                        <TableRow key={row.strategy_id}>
                          <TableCell sx={cellSx}>{row.name}</TableCell>
                          {TRADING_HOURS.map((h) => (
                            <SessionHeatCell key={h} value={row.hours[h] || 0} maxVal={sessionMax} />
                          ))}
                          <TableCell sx={{ ...cellSx, textAlign: 'center', fontWeight: 600 }}>{row.total}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}

            {/* Hourly Signal Outcomes */}
            {data.signals_detail.length > 0 && (
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  Hourly Signal Outcomes
                  <InfoTip text="Shows win/loss distribution by hour of day. A win means the stock's favorable move (MFE) exceeded its adverse move (MAE) after the signal." />
                </Typography>
                <HourlyOutcomeChart signals={data.signals_detail} />
              </Box>
            )}

            {/* Trailing Stop Analysis */}
            <Box>
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                Price Excursion Analysis
                <InfoTip text="Measures how far the underlying stock price moved favorably (MFE) and adversely (MAE) after each signal entry, through market close" />
              </Typography>
              <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                <StatCard label="Avg MFE" value={data.trailing_stop_analysis.avg_mfe_pct} suffix="%" tooltip={TOOLTIPS.mfe} />
                <StatCard label="Avg MAE" value={data.trailing_stop_analysis.avg_mae_pct} suffix="%" tooltip={TOOLTIPS.mae} />
                <StatCard label="P25 MFE" value={data.trailing_stop_analysis.p25_mfe_pct} suffix="%" tooltip={`${TOOLTIPS.p25}. ${TOOLTIPS.mfe}`} />
                <StatCard label="P75 MFE" value={data.trailing_stop_analysis.p75_mfe_pct} suffix="%" tooltip={`${TOOLTIPS.p75}. ${TOOLTIPS.mfe}`} />
              </Box>
              <CombinedDistribution
                mfeBuckets={data.trailing_stop_analysis.mfe_distribution}
                maeBuckets={data.trailing_stop_analysis.mae_distribution}
              />
            </Box>

            {/* Signals Detail */}
            {data.signals_detail.length > 0 && (
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc' }}>
                    All Signals ({data.signals_detail.length})
                  </Typography>
                  {signalStats && (
                    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
                      <Chip
                        label={`Win Rate: ${signalStats.winRate.toFixed(0)}%`}
                        size="small"
                        sx={{
                          fontSize: 11,
                          bgcolor: signalStats.winRate >= 50 ? '#1b5e20' : '#5c1a1a',
                          color: signalStats.winRate >= 50 ? '#81c784' : '#ef9a9a',
                        }}
                      />
                      <Typography sx={{ fontSize: 12, color: '#787b86' }}>
                        {signalStats.wins}W / {signalStats.total - signalStats.wins}L
                        <InfoTip text={TOOLTIPS.outcome} />
                      </Typography>
                    </Box>
                  )}
                </Box>
                <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', maxHeight: 400 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28' }}>Date</TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28' }}>Strategy</TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'center' }}>Dir</TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28' }}>Time</TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'center' }}>
                          <HeaderWithInfo label="Session" tooltip={TOOLTIPS.session} align="center" />
                        </TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'right' }}>
                          <HeaderWithInfo label="MFE%" tooltip={TOOLTIPS.mfe} align="right" />
                        </TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'right' }}>
                          <HeaderWithInfo label="MAE%" tooltip={TOOLTIPS.mae} align="right" />
                        </TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'right' }}>
                          <HeaderWithInfo label="R:R" tooltip={TOOLTIPS.rr} align="right" />
                        </TableCell>
                        <TableCell sx={{ ...headerCellSx, bgcolor: '#151b28', textAlign: 'center' }}>
                          <HeaderWithInfo label="Outcome" tooltip={TOOLTIPS.outcome} align="center" />
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.signals_detail.map((sig, i) => {
                        const entryDt = new Date(sig.entry_time * 1000);
                        const rr = sig.mfe_pct != null && sig.mae_pct != null && sig.mae_pct > 0
                          ? sig.mfe_pct / sig.mae_pct
                          : sig.mfe_pct != null && sig.mfe_pct > 0 ? 99 : null;
                        return (
                          <TableRow key={i}>
                            <TableCell sx={cellSx}>{sig.date}</TableCell>
                            <TableCell sx={cellSx}>{sig.strategy_id}</TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'center', color: sig.direction === 'CALL' ? '#26a69a' : '#ef5350' }}>
                              {sig.direction}
                            </TableCell>
                            <TableCell sx={cellSx}>
                              {entryDt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                            </TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'center' }}>{sig.session === '9' ? '9:30' : `${sig.session}:00`}</TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'right', color: '#26a69a' }}>
                              {sig.mfe_pct != null ? sig.mfe_pct.toFixed(3) : '—'}
                            </TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'right', color: '#ef5350' }}>
                              {sig.mae_pct != null ? sig.mae_pct.toFixed(3) : '—'}
                            </TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'right', color: rr != null && rr >= 1 ? '#26a69a' : rr != null ? '#ef5350' : '#787b86' }}>
                              {rr != null ? (rr >= 99 ? '99+' : rr.toFixed(1)) : '—'}
                            </TableCell>
                            <TableCell sx={{ ...cellSx, textAlign: 'center' }}>
                              <OutcomeChip mfe={sig.mfe_pct} mae={sig.mae_pct} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}
          </Box>
        )}

        {/* Empty State */}
        {!data && !isLoading && !error && (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontSize: 16, color: '#787b86' }}>
              Select a date range and symbol, then click "Run Analysis"
            </Typography>
          </Box>
        )}

        <TickerSelectionModal
          open={tickerModalOpen}
          onClose={() => setTickerModalOpen(false)}
          onSelect={setSelectedSymbol}
          selectedSymbol={selectedSymbol}
        />
      </Box>
    </LocalizationProvider>
  );
}
