/**
 * Backtesting View Component
 *
 * Tests strategy entry point detection on historical data.
 * Shows all detected signals on a single chart with interval switching.
 * Includes tab toggle for Single Day vs Range Analysis modes.
 */
import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Alert,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Menu,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  TextField,
  Tooltip,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import TuneIcon from '@mui/icons-material/Tune';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { useQuery } from '@tanstack/react-query';
import { fetchBacktest, fetchStrategySettings, saveStrategySettings } from '@/services/api/marketData';
import { DEFAULT_STRATEGY_SETTINGS, mergeStrategySettings, StrategySettings } from '@/analysis/strategyDefaults';
import { LightweightChart } from '@/components/chart/LightweightChart';
import { TickerSelectionModal, CompanyLogo } from '@/components/backtesting/TickerSelectionModal';
import { SignalDetailsPopup } from '@/components/backtesting/SignalDetailsPopup';
import { BacktestRangeView } from '@/components/backtesting/BacktestRangeView';
import { BacktestCrossSymbolView } from '@/components/backtesting/BacktestCrossSymbolView';
import { useChartStore } from '@/store/chartStore';
import { SYMBOL_NAMES } from '@/constants/symbols';
import { Bar, StrategySignal, Interval } from '@/types/chart.types';
import { subDays } from 'date-fns';

const INTERVAL_OPTIONS: Interval[] = ['1m', '5m', '15m', '1h', '1d'];

type ViewMode = 'single' | 'range' | 'cross-symbol';

export function BacktestingView() {
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const handleSetViewMode = (v: string) => setViewMode(v as ViewMode);

  if (viewMode === 'range') {
    return <BacktestRangeView viewMode={viewMode} setViewMode={handleSetViewMode} />;
  }

  if (viewMode === 'cross-symbol') {
    return <BacktestCrossSymbolView viewMode={viewMode} setViewMode={handleSetViewMode} />;
  }

  return <SingleDayView viewMode={viewMode} setViewMode={handleSetViewMode} />;
}

function SingleDayView({ viewMode, setViewMode }: { viewMode: string; setViewMode: (v: string) => void }) {
  const [selectedDate, setSelectedDate] = useState<Date | null>(subDays(new Date(), 1));
  const [selectedSymbol, setSelectedSymbol] = useState('SPX');
  const [selectedInterval, setSelectedInterval] = useState<Interval>('1m');
  const [triggerFetch, setTriggerFetch] = useState(0); // Counter to trigger refetch
  const [visibleSignalCount, setVisibleSignalCount] = useState(0);
  const [tickerModalOpen, setTickerModalOpen] = useState(false);
  const [chartFocusRange, setChartFocusRange] = useState<{ from: number; to: number } | undefined>(undefined);

  const { setBars, setStrategySignals, setSrLevels, setSymbol, setInterval, selectedSignalId, setSelectedSignalId, signalClickPosition, strategySignals, showMA20, showMA40, showMA100, showMA200, showVWAP, showBollinger, showVolume, showWorden, setIndicator } = useChartStore();
  const [indicatorsAnchor, setIndicatorsAnchor] = useState<HTMLElement | null>(null);

  // Strategy settings state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<StrategySettings>(DEFAULT_STRATEGY_SETTINGS);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Strategy enable/disable for backtesting — maps strategy number to enabled
  const [enabledStrategies, setEnabledStrategies] = useState<Record<number, boolean>>({
    1: true, 2: true, 3: true, 4: true, 5: true,
    6: true, 60: true,
    7: true, 8: true, 9: true, 10: true, 11: true,
  });

  const loadStrategySettings = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const response = await fetchStrategySettings(selectedSymbol);
      const merged = mergeStrategySettings(
        (response.settings as Partial<typeof DEFAULT_STRATEGY_SETTINGS>) ?? undefined
      );
      setSettingsDraft(merged);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Failed to load settings');
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleOpenSettings = () => {
    setSettingsOpen(true);
    void loadStrategySettings();
  };

  const handleSaveSettings = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await saveStrategySettings(selectedSymbol, settingsDraft);
      const merged = mergeStrategySettings(settingsDraft);
      setSettingsDraft(merged);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleResetSettings = () => {
    setSettingsDraft(DEFAULT_STRATEGY_SETTINGS);
  };

  const handleNumberChange = <Section extends keyof StrategySettings>(
    section: Section,
    key: keyof StrategySettings[Section],
    value: string,
    parser: (input: string) => number
  ) => {
    const nextValue = parser(value);
    if (Number.isNaN(nextValue)) return;
    setSettingsDraft((prev) => ({
      ...prev,
      [section]: { ...prev[section], [key]: nextValue },
    }));
  };

  // Strategy number mapping for enable/disable toggles
  const STRATEGY_NUMBER_MAP: Record<string, number> = {
    strategy1: 1,
    strategy2: 2,
    strategy3: 3,
    strategy4: 4,
    strategy5: 5,
    ct15: 6,
    ct_open: 60,
    strategy7: 7,
    strategy8: 8,
    strategy9: 9,
    strategy10: 10,
    strategy11: 11,
  };

  const percentHelper = 'Decimal value (0.004 = 0.4%).';
  const settingsSections: {
    title: string;
    section: keyof StrategySettings;
    fields: {
      key: string;
      label: string;
      type: 'int' | 'float' | 'percent' | 'bool';
      step?: number;
      min?: number;
      helper?: string;
    }[];
  }[] = [
    {
      title: 'Strategy 1 — MA20 Crossover',
      section: 'strategy1',
      fields: [
        { key: 'window15m', label: '15m confirm window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'int', min: 1, step: 1 },
        { key: 'trendLookback', label: 'Trend lookback', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 2 — Midline Bounce',
      section: 'strategy2',
      fields: [
        { key: 'dailyTrendLookback', label: 'Daily trend lookback', type: 'int', min: 1, step: 1 },
        { key: 'touchPct', label: 'Touch %', type: 'percent', helper: percentHelper },
        { key: 'window1h', label: '1h window', type: 'int', min: 1, step: 1 },
        { key: 'window15m', label: '15m window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 3 — Open Gap Fade',
      section: 'strategy3',
      fields: [
        { key: 'minGapPct', label: 'Min gap %', type: 'percent', helper: percentHelper },
        { key: 'tightLookback', label: 'Tight lookback', type: 'int', min: 10, step: 10 },
        { key: 'tightPercentile', label: 'Tight percentile', type: 'int', min: 1, step: 5 },
        { key: 'bandOutsideTol', label: 'Band outside tolerance', type: 'percent', helper: percentHelper },
        { key: 'entryWindowMinutes', label: 'Entry window (min)', type: 'int', min: 1, step: 1 },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 4 — Magnet Effect',
      section: 'strategy4',
      fields: [
        { key: 'minDistPct', label: 'Min distance %', type: 'percent', helper: percentHelper },
        { key: 'firstBarWindow', label: 'First bar window', type: 'int', min: 1, step: 1 },
        { key: 'confirmWindow', label: 'Confirm window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 5 — Lateral Open Outside BB',
      section: 'strategy5',
      fields: [
        { key: 'minGapPct', label: 'Min gap %', type: 'percent', helper: percentHelper },
        { key: 'tightLookback', label: 'Tight lookback', type: 'int', min: 10, step: 10 },
        { key: 'tightPercentile', label: 'Tight percentile', type: 'int', min: 1, step: 5 },
        { key: 'bandOutsideTol', label: 'Band outside tolerance', type: 'percent', helper: percentHelper },
        { key: 'flatLookback', label: 'Flat lookback', type: 'int', min: 1, step: 1 },
        { key: 'flatEpsilon', label: 'Flat epsilon', type: 'percent', helper: percentHelper },
        { key: 'entryWindowMinutes', label: 'Entry window (min)', type: 'int', min: 1, step: 1 },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'CT15 — Open Gap Trendline',
      section: 'ct15',
      fields: [
        { key: 'minGapPct', label: 'Min gap %', type: 'percent', helper: percentHelper },
        { key: 'bwSlopeLookback', label: 'BW slope lookback', type: 'int', min: 1, step: 1 },
        { key: 'bwAvgRatio', label: 'BW avg ratio', type: 'float', helper: '1.0 = exact average, lower = more permissive' },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'CT-Open — Squeeze Breakout',
      section: 'ct_open',
      fields: [
        { key: 'requireSqueeze', label: 'Require squeeze', type: 'bool', helper: 'When off, skips squeeze check and BW expansion — uses only 1m momentum' },
        { key: 'squeezeLookback', label: 'Squeeze lookback bars', type: 'int', min: 10, step: 10, helper: 'How many 15m bars to compute BW percentile over' },
        { key: 'squeezePercentile', label: 'Squeeze percentile', type: 'int', min: 1, step: 5, helper: 'BW must be below this percentile to qualify as squeeze' },
        { key: 'entryWindowMinutes', label: 'Entry window (min)', type: 'int', min: 5, step: 5, helper: 'Minutes after 9:30 to monitor for breakout' },
        { key: 'minBreakoutBars', label: 'Min breakout bars', type: 'int', min: 1, step: 1, helper: 'Consecutive 1m bars above/below opening price to confirm direction' },
        { key: 'minDisplacementPct', label: 'Min displacement %', type: 'float', min: 0, step: 0.02, helper: 'Price must move this % from open before signal fires (0.10 = 0.10%)' },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 7 — 0DTE Scalper',
      section: 'strategy7',
      fields: [
        { key: 'profitTargetPct', label: 'Profit target %', type: 'percent', helper: percentHelper },
        { key: 'stopLossPct', label: 'Stop loss %', type: 'percent', helper: percentHelper },
        { key: 'maxHoldMinutes', label: 'Max hold (min)', type: 'int', min: 1, step: 1 },
        { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'int', min: 1, step: 1 },
        { key: 'useTrailingStop', label: 'Use trailing stop', type: 'bool' },
        { key: 'trailingStopPct', label: 'Trailing stop %', type: 'percent', helper: percentHelper },
        { key: 'volumeSpikePct', label: 'Volume spike multiplier', type: 'float', min: 1, step: 0.1 },
        { key: 'minConsecutiveBars', label: 'Min consecutive bars', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 8 — 0DTE Momentum Rider',
      section: 'strategy8',
      fields: [
        { key: 'profitTargetPct', label: 'Profit target %', type: 'percent', helper: percentHelper },
        { key: 'stopLossPct', label: 'Stop loss %', type: 'percent', helper: percentHelper },
        { key: 'useTrailingStop', label: 'Use trailing stop', type: 'bool' },
        { key: 'trailingStopPct', label: 'Trailing stop %', type: 'percent', helper: percentHelper },
        { key: 'trailingActivationPct', label: 'Trailing activation %', type: 'percent', helper: percentHelper },
        { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'int', min: 1, step: 1 },
        { key: 'rsiOverbought', label: 'RSI overbought', type: 'int', min: 50, step: 5 },
        { key: 'rsiOversold', label: 'RSI oversold', type: 'int', min: 10, step: 5 },
        { key: 'rsiPeriod', label: 'RSI period', type: 'int', min: 5, step: 1 },
        { key: 'volumeSpikeMult', label: 'Volume spike multiplier', type: 'float', min: 1, step: 0.5 },
      ],
    },
    {
      title: 'Strategy 9 — 0DTE Gap Fade',
      section: 'strategy9',
      fields: [
        { key: 'profitTargetPct', label: 'Profit target %', type: 'percent', helper: percentHelper },
        { key: 'stopLossPct', label: 'Stop loss %', type: 'percent', helper: percentHelper },
        { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'int', min: 1, step: 1 },
        { key: 'minGapPct', label: 'Min gap %', type: 'percent', helper: percentHelper },
      ],
    },
    {
      title: 'Strategy 10 — 0DTE Trend Following',
      section: 'strategy10',
      fields: [
        { key: 'profitTargetPct', label: 'Profit target %', type: 'percent', helper: percentHelper },
        { key: 'stopLossPct', label: 'Stop loss %', type: 'percent', helper: percentHelper },
        { key: 'useTrailingStop', label: 'Use trailing stop', type: 'bool' },
        { key: 'trailingStopPct', label: 'Trailing stop %', type: 'percent', helper: percentHelper },
        { key: 'trailingActivationPct', label: 'Trailing activation %', type: 'percent', helper: percentHelper },
        { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'int', min: 1, step: 1 },
        { key: 'minTrendBars', label: 'Min trend bars', type: 'int', min: 1, step: 1 },
        { key: 'rsiTrendCallMin', label: 'RSI CALL min', type: 'int', min: 0, step: 5 },
        { key: 'rsiTrendCallMax', label: 'RSI CALL max', type: 'int', min: 0, step: 5 },
        { key: 'rsiTrendPutMin', label: 'RSI PUT min', type: 'int', min: 0, step: 5 },
        { key: 'rsiTrendPutMax', label: 'RSI PUT max', type: 'int', min: 0, step: 5 },
        { key: 'rsiPeriod', label: 'RSI period', type: 'int', min: 5, step: 1 },
        { key: 'requireSmaBreakout', label: 'Require SMA breakout', type: 'bool' },
        { key: 'smaFastPeriod', label: 'Fast SMA period', type: 'int', min: 2, step: 1 },
        { key: 'smaSlowPeriod', label: 'Slow SMA period', type: 'int', min: 20, step: 5 },
        { key: 'signalMaxAgeSecs', label: 'Max signal age (sec)', type: 'int', min: 0, step: 30 },
        { key: 'requireEntryPriceConfirmation', label: 'Require price confirmation', type: 'bool' },
        { key: 'requireVwapTrend', label: 'Require VWAP trend', type: 'bool' },
        { key: 'vwapSlopeLookback', label: 'VWAP slope lookback', type: 'int', min: 1, step: 1 },
        { key: 'failedBreakoutBlockMinutes', label: 'Failed breakout block (min)', type: 'int', min: 0, step: 5 },
        { key: 'minDelta', label: 'Minimum delta', type: 'float', min: 0, step: 0.05 },
      ],
    },
    {
      title: 'Strategy 11 — ICT Price Action',
      section: 'strategy11',
      fields: [
        { key: 'swingLookback', label: 'Swing lookback', type: 'int', min: 1, step: 1 },
        { key: 'minDisplacementPct', label: 'Min displacement %', type: 'percent', helper: percentHelper },
        { key: 'avgBodyLookback', label: 'Avg body lookback', type: 'int', min: 5, step: 5 },
        { key: 'avgBodyMult', label: 'Avg body multiplier', type: 'float', min: 1, step: 0.1 },
        { key: 'cooldownMinutes', label: 'Cooldown (min)', type: 'int', min: 1, step: 1 },
        { key: 'minRiskReward', label: 'Min risk/reward', type: 'float', min: 1, step: 0.5 },
        { key: 'sweepWindowBars', label: 'Sweep window bars', type: 'int', min: 1, step: 1 },
        { key: 'mssLookbackBars', label: 'MSS lookback bars', type: 'int', min: 1, step: 1 },
        { key: 'useSRFilter', label: 'S/R level filter', type: 'bool' },
        { key: 'srProximityPct', label: 'S/R proximity %', type: 'percent', helper: percentHelper },
        { key: 'allowSREntry', label: 'Allow S/R entry (no FVG)', type: 'bool' },
      ],
    },
  ];

  // Update chart symbol and interval when component mounts
  useEffect(() => {
    setSymbol(selectedSymbol);
    setInterval(selectedInterval);
  }, []);

  // Format date to YYYY-MM-DD
  const formatDate = (date: Date | null) => {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Query to fetch backtest data - only runs when button clicked
  const backtestQuery = useQuery({
    queryKey: ['backtest', triggerFetch], // Only trigger changes the key
    queryFn: () => {
      if (!selectedDate) throw new Error('No date selected');
      const activeStrategies = Object.entries(enabledStrategies)
        .filter(([, v]) => v)
        .map(([k]) => Number(k));
      console.log('Fetching backtest data for:', selectedSymbol, formatDate(selectedDate), 'strategies:', activeStrategies);
      return fetchBacktest(selectedSymbol, formatDate(selectedDate), 10, activeStrategies);
    },
    enabled: triggerFetch > 0, // Only run when button has been clicked
    staleTime: 0, // Don't cache - always fetch fresh data
  });

  // Update chart when data arrives or interval changes
  useEffect(() => {
    if (!backtestQuery.data) {
      console.log('No backtest data yet');
      return;
    }

    console.log('Backtest data received:', backtestQuery.data);
    console.log('Available intervals:', Object.keys(backtestQuery.data.bars));
    console.log('Bars count per interval:', {
      '1m': backtestQuery.data.bars['1m']?.length || 0,
      '5m': backtestQuery.data.bars['5m']?.length || 0,
      '15m': backtestQuery.data.bars['15m']?.length || 0,
      '1h': backtestQuery.data.bars['1h']?.length || 0,
      '1d': backtestQuery.data.bars['1d']?.length || 0,
    });

    const allBars = (backtestQuery.data.bars as Record<string, Bar[]>)[selectedInterval] || [];
    const dateRange = backtestQuery.data.date_range;

    console.log('Date range from backend:', {
      start: dateRange.start,
      end: dateRange.end,
      startTime: new Date(dateRange.start * 1000).toLocaleString(),
      endTime: new Date(dateRange.end * 1000).toLocaleString(),
    });

    // Show first few bar times to understand the data
    if (allBars.length > 0) {
      const first = allBars[0];
      const last = allBars[allBars.length - 1];
      console.log('First bar:', first.time, '=', new Date(first.time * 1000).toLocaleString());
      console.log('Last bar:', last.time, '=', new Date(last.time * 1000).toLocaleString());
      console.log('Date range:', dateRange.start, 'to', dateRange.end);
      console.log('First bar < start?', first.time < dateRange.start, 'diff:', dateRange.start - first.time, 'seconds');
      console.log('Last bar > end?', last.time > dateRange.end, 'diff:', last.time - dateRange.end, 'seconds');
    }

    // Pass all bars (including lookback) so indicators like BB(20) have warmup data.
    // The chart will zoom to the selected day via focusRange.
    let filteredBars = allBars;
    if (selectedInterval === '1d') {
      // For daily interval, show the selected day plus some context (e.g., last 30 days)
      const thirtyDaysAgo = dateRange.start - (30 * 24 * 60 * 60);
      filteredBars = allBars.filter((bar) => bar.time >= thirtyDaysAgo);
    }
    // Set focus range so the chart zooms to the selected day
    if (selectedInterval !== '1d') {
      setChartFocusRange({ from: dateRange.start, to: dateRange.end });
    } else {
      setChartFocusRange(undefined);
    }
    console.log(`Passing ${filteredBars.length} bars (from ${allBars.length} total) for interval ${selectedInterval}`);

    const allSignals = backtestQuery.data.signals || [];
    console.log('All signals from backend:', allSignals);

    // Filter signals to the selected day range (not the full bar range which includes lookback)
    let filteredSignals = allSignals;
    const sigMinTime = dateRange.start;
    const sigMaxTime = dateRange.end;
    console.log('Signal filter range:', {
      minTime: sigMinTime,
      maxTime: sigMaxTime,
      minTimeStr: new Date(sigMinTime * 1000).toLocaleString(),
      maxTimeStr: new Date(sigMaxTime * 1000).toLocaleString(),
    });

    filteredSignals = allSignals.filter(
      (signal) => signal.entry_time >= sigMinTime && signal.entry_time <= sigMaxTime
    );

    console.log(`Updating chart with ${filteredBars.length} bars (filtered from ${allBars.length}) and ${filteredSignals.length} signals (filtered from ${allSignals.length}) for interval ${selectedInterval}`);

    if (filteredBars.length > 0) {
      const firstBar = new Date(filteredBars[0].time * 1000).toLocaleTimeString();
      const lastBar = new Date(filteredBars[filteredBars.length - 1].time * 1000).toLocaleTimeString();
      console.log(`Bar range: ${firstBar} to ${lastBar}`);
    }

    if (filteredSignals.length > 0) {
      filteredSignals.forEach((sig: StrategySignal) => {
        const sigTime = new Date(sig.entry_time * 1000).toLocaleTimeString();
        console.log(`Signal: ${sig.strategy_id} ${sig.direction} at ${sigTime} (${sig.entry_time})`);
      });
    }

    // Update Zustand store with filtered bars for the selected interval
    setBars(filteredBars as Bar[]);

    // Convert backend signals to chart store format
    // Backend signals have snake_case fields; chart store expects camelCase + extra debug fields.
    // We cast because the chart only uses id/entryTime/direction/strategyId for markers.
    const chartSignals = filteredSignals.map((signal: StrategySignal) => ({
      id: signal.id,
      symbol: signal.symbol,
      strategyId: signal.strategy_id,
      direction: signal.direction,
      entryTime: signal.entry_time,
      anchorTime1H: signal.anchor_time ?? 0,
      chopFiltered: signal.chop_filtered ?? false,
      chopReason: signal.chop_reason ?? null,
      adx: signal.adx ?? null,
      diGap: signal.di_gap ?? null,
      reasons: [] as string[],
      debug: {} as any,
    }));

    console.log('Setting chart signals:', chartSignals);
    setStrategySignals(chartSignals as any);
    setVisibleSignalCount(filteredSignals.length);

    // Pass S/R levels to chart if backend returned them
    const srData = backtestQuery.data?.sr_levels;
    setSrLevels(srData ? { support: srData.support, resistance: srData.resistance } : null);
  }, [backtestQuery.data, selectedInterval, setBars, setStrategySignals, setSrLevels]);

  // Change interval (useEffect will handle updating the chart)
  const handleIntervalChange = (interval: Interval) => {
    setSelectedInterval(interval);
  };

  const handleRunBacktest = () => {
    if (!selectedDate) {
      console.error('No date selected');
      return;
    }
    console.log('Running backtest for:', {
      symbol: selectedSymbol,
      date: formatDate(selectedDate),
    });
    // Increment trigger to force new fetch
    setTriggerFetch(prev => prev + 1);
  };

  const handlePreviousDay = () => {
    if (!selectedDate) return;
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() - 1);
    setSelectedDate(newDate);
    setTriggerFetch(prev => prev + 1);
  };

  const handleNextDay = () => {
    if (!selectedDate) return;
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + 1);
    setSelectedDate(newDate);
    setTriggerFetch(prev => prev + 1);
  };

  // Validate date (not weekend, not future)
  const isWeekend = (date: Date | null) => {
    if (!date) return false;
    const day = date.getDay();
    return day === 0 || day === 6;
  };

  const isFutureDate = (date: Date | null) => {
    if (!date) return false;
    return date > new Date();
  };

  const hasData = backtestQuery.data && ((backtestQuery.data.bars as Record<string, Bar[]>)[selectedInterval]?.length ?? 0) > 0;

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Controls Bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderBottom: '1px solid #2b2b43',
            backgroundColor: '#0c111a',
          }}
        >
          <Typography sx={{ fontSize: 16, fontWeight: 600, color: '#d1d4dc' }}>
            Backtesting
          </Typography>

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

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <IconButton
              size="small"
              onClick={handlePreviousDay}
              disabled={!selectedDate}
              sx={{
                color: '#d1d4dc',
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
                '&.Mui-disabled': { color: '#4b4b63' },
              }}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>

            <DatePicker
              label="Select Date"
              value={selectedDate}
              onChange={setSelectedDate}
              maxDate={new Date()}
              format="EEE, MMM d, yyyy"
              slotProps={{
                textField: {
                  size: 'small',
                  sx: {
                    minWidth: 220,
                    '& .MuiOutlinedInput-root': {
                      color: '#d1d4dc',
                      '& fieldset': { borderColor: '#2b2b43' },
                      '&:hover fieldset': { borderColor: '#4b4b63' },
                    },
                    '& .MuiInputLabel-root': { color: '#787b86' },
                  },
                },
              }}
            />

            <IconButton
              size="small"
              onClick={handleNextDay}
              disabled={!selectedDate || selectedDate >= new Date()}
              sx={{
                color: '#d1d4dc',
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
                '&.Mui-disabled': { color: '#4b4b63' },
              }}
            >
              <ArrowForwardIcon fontSize="small" />
            </IconButton>
          </Box>

          <Box
            onClick={() => setTickerModalOpen(true)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              pl: 0.5,
              pr: 2,
              py: 0.5,
              borderRadius: '20px',
              backgroundColor: '#2b2b43',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
              '&:hover': {
                backgroundColor: '#3b3b53',
              },
            }}
          >
            <CompanyLogo symbol={selectedSymbol} size={28} />
            <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc' }}>
              {selectedSymbol}
            </Typography>
            <Typography sx={{ fontSize: 12, color: '#787b86', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {SYMBOL_NAMES[selectedSymbol]?.split(',')[0] || ''}
            </Typography>
          </Box>

          <Button
            variant="contained"
            onClick={handleRunBacktest}
            disabled={!selectedDate || backtestQuery.isFetching || backtestQuery.isLoading}
            sx={{
              textTransform: 'none',
              backgroundColor: '#2962ff',
              '&:hover': { backgroundColor: '#1e53e5' },
            }}
          >
            {(backtestQuery.isFetching || backtestQuery.isLoading) ? (
              <>
                <CircularProgress size={16} sx={{ mr: 1, color: 'white' }} />
                Running...
              </>
            ) : (
              'Run Backtest'
            )}
          </Button>

          {hasData && (
            <Typography sx={{ fontSize: 14, color: '#787b86', ml: 2 }}>
              Signals Found: <span style={{ color: '#39d98a', fontWeight: 600 }}>{visibleSignalCount}</span>
            </Typography>
          )}

          {backtestQuery.data?.actual_date && backtestQuery.data.actual_date !== backtestQuery.data.date && (
            <Alert severity="info" sx={{ py: 0, ml: 2, '& .MuiAlert-message': { py: 0.5 } }}>
              Market closed on {backtestQuery.data.date}. Showing {backtestQuery.data.actual_date}
            </Alert>
          )}
        </Box>

        {/* Warnings */}
        {isWeekend(selectedDate) && (
          <Alert severity="warning" sx={{ m: 2 }}>
            Market closed on weekends. Try a weekday date.
          </Alert>
        )}

        {isFutureDate(selectedDate) && (
          <Alert severity="error" sx={{ m: 2 }}>
            Cannot backtest future dates.
          </Alert>
        )}

        {backtestQuery.isError && (
          <Alert severity="error" sx={{ m: 2 }}>
            Error loading backtest data: {(backtestQuery.error as Error).message}
          </Alert>
        )}

        {/* Chart Toolbar */}
        {hasData && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              padding: 1,
              borderBottom: '1px solid #2b2b43',
              backgroundColor: '#0c111a',
            }}
          >
            {INTERVAL_OPTIONS.map((interval) => (
              <Button
                key={interval}
                onClick={() => handleIntervalChange(interval)}
                variant={selectedInterval === interval ? 'contained' : 'outlined'}
                size="small"
                sx={{
                  textTransform: 'none',
                  minWidth: 50,
                  ...(selectedInterval === interval
                    ? {
                        backgroundColor: '#2962ff',
                        '&:hover': { backgroundColor: '#1e53e5' },
                      }
                    : {
                        color: '#d1d4dc',
                        borderColor: '#2b2b43',
                        '&:hover': { borderColor: '#4b4b63' },
                      }),
                }}
              >
                {interval.toUpperCase()}
              </Button>
            ))}

            <Box sx={{ borderLeft: '1px solid #2b2b43', height: 24, mx: 0.5 }} />

            <Button
              size="small"
              onClick={(e) => setIndicatorsAnchor(e.currentTarget)}
              sx={{
                textTransform: 'none',
                color: '#d1d4dc',
                borderColor: '#2b2b43',
                '&:hover': { borderColor: '#4b4b63' },
              }}
              variant="outlined"
            >
              Indicators
            </Button>
            <Menu
              anchorEl={indicatorsAnchor}
              open={Boolean(indicatorsAnchor)}
              onClose={() => setIndicatorsAnchor(null)}
              PaperProps={{
                sx: {
                  backgroundColor: '#1e222d',
                  border: '1px solid #2b2b43',
                  minWidth: 160,
                },
              }}
            >
              <FormGroup sx={{ px: 2, py: 0.5 }}>
                {([
                  { key: 'showMA20', label: 'MA 20', color: '#f5a623' },
                  { key: 'showMA40', label: 'MA 40', color: '#50e3c2' },
                  { key: 'showMA100', label: 'MA 100', color: '#4a90e2' },
                  { key: 'showMA200', label: 'MA 200', color: '#9013fe' },
                  { key: 'showVWAP', label: 'VWAP', color: '#ffcc00' },
                  { key: 'showBollinger', label: 'Bollinger', color: '#b0bec5' },
                  { key: 'showVolume', label: 'Volume', color: '#9e9e9e' },
                  { key: 'showWorden', label: 'Worden', color: '#ff9800' },
                ] as const).map(({ key, label, color }) => (
                  <FormControlLabel
                    key={key}
                    control={
                      <Checkbox
                        checked={
                          key === 'showMA20' ? showMA20 :
                          key === 'showMA40' ? showMA40 :
                          key === 'showMA100' ? showMA100 :
                          key === 'showMA200' ? showMA200 :
                          key === 'showVWAP' ? showVWAP :
                          key === 'showBollinger' ? showBollinger :
                          key === 'showVolume' ? showVolume :
                          showWorden
                        }
                        onChange={(e) => setIndicator(key, e.target.checked)}
                        size="small"
                        sx={{ color: '#787b86', '&.Mui-checked': { color } }}
                      />
                    }
                    label={
                      <Typography sx={{ fontSize: 13, color: '#d1d4dc' }}>
                        <span style={{ color, marginRight: 6 }}>●</span>
                        {label}
                      </Typography>
                    }
                    sx={{ mr: 0 }}
                  />
                ))}
              </FormGroup>
            </Menu>

            <Tooltip title="Strategy Settings">
              <span>
                <IconButton
                  size="small"
                  onClick={handleOpenSettings}
                  sx={{
                    marginLeft: 0.5,
                    color: '#d1d4dc',
                    border: '1px solid #2b2b43',
                    borderRadius: 1,
                    '&:hover': { borderColor: '#4b4b63' },
                  }}
                >
                  <TuneIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}

        {/* Chart */}
        {hasData && (
          <Box sx={{ flex: 1, overflow: 'hidden' }}>
            <LightweightChart showSessionLines={false} focusRange={chartFocusRange} />
          </Box>
        )}

        {/* Empty State */}
        {!hasData && !backtestQuery.isFetching && !backtestQuery.isError && !backtestQuery.data && (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <Typography sx={{ fontSize: 18, color: '#787b86' }}>
              Select a date and symbol, then click "Run Backtest" to analyze historical entry points
            </Typography>
          </Box>
        )}

        {/* No Data Warning */}
        {backtestQuery.data && !hasData && !backtestQuery.isFetching && (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <Alert severity="warning" sx={{ maxWidth: 600 }}>
              No historical data available for {selectedSymbol} on {formatDate(selectedDate)}.
              <br />
              This could mean:
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li>IB Gateway doesn't have data for this date/symbol combination</li>
                <li>The date is too far in the past (older than IB's data retention)</li>
                <li>The market was closed on this date</li>
              </ul>
              Try a different date or symbol (SPY usually has the most complete data).
            </Alert>
          </Box>
        )}

        {/* Ticker Selection Modal */}
        <TickerSelectionModal
          open={tickerModalOpen}
          onClose={() => setTickerModalOpen(false)}
          onSelect={setSelectedSymbol}
          selectedSymbol={selectedSymbol}
        />

        {/* Signal Details Popup */}
        <SignalDetailsPopup
          signal={selectedSignalId ? strategySignals.find(s => s.id === selectedSignalId) || null : null}
          clickPosition={signalClickPosition}
          onClose={() => setSelectedSignalId(null)}
        />

        {/* Strategy Settings Dialog */}
        <Dialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          maxWidth="md"
          fullWidth
        >
          <DialogTitle>Strategy Settings (per symbol)</DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Symbol: {selectedSymbol} · Use checkboxes to select which strategies to backtest.
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  size="small"
                  onClick={() => setEnabledStrategies(Object.fromEntries(Object.keys(enabledStrategies).map(k => [k, true])))}
                  sx={{ textTransform: 'none', fontSize: 11, minWidth: 0, px: 1 }}
                >
                  All
                </Button>
                <Button
                  size="small"
                  onClick={() => setEnabledStrategies(Object.fromEntries(Object.keys(enabledStrategies).map(k => [k, false])))}
                  sx={{ textTransform: 'none', fontSize: 11, minWidth: 0, px: 1 }}
                >
                  None
                </Button>
              </Box>
            </Box>
            {settingsSections.map((section, index) => {
              const stratNum = STRATEGY_NUMBER_MAP[section.section];
              const isEnabled = stratNum !== undefined ? enabledStrategies[stratNum] !== false : true;
              return (
              <Accordion key={section.title} defaultExpanded={index === 0}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    {stratNum !== undefined && (
                      <Checkbox
                        size="small"
                        checked={isEnabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setEnabledStrategies(prev => ({ ...prev, [stratNum]: e.target.checked }));
                        }}
                        sx={{ p: 0, mr: 0.5 }}
                      />
                    )}
                    <Typography sx={{ fontWeight: 600, fontSize: 14, opacity: isEnabled ? 1 : 0.4 }}>{section.title}</Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  <Box
                    sx={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 2,
                      alignItems: 'flex-start',
                    }}
                  >
                    {section.fields.map((field) => {
                      const fieldKey = field.key as keyof StrategySettings[typeof section.section];
                      if (field.type === 'bool') {
                        const checked = settingsDraft[section.section][fieldKey] as unknown as boolean;
                        return (
                          <FormControlLabel
                            key={`${section.title}-${field.key}`}
                            control={
                              <Checkbox
                                checked={checked}
                                onChange={(e) =>
                                  setSettingsDraft((prev) => ({
                                    ...prev,
                                    [section.section]: {
                                      ...prev[section.section],
                                      [fieldKey]: e.target.checked,
                                    },
                                  }))
                                }
                              />
                            }
                            label={field.label}
                            sx={{ alignSelf: 'center' }}
                          />
                        );
                      }
                      const fieldValue = settingsDraft[section.section][fieldKey] as number;
                      const parser = field.type === 'int' ? parseInt : parseFloat;
                      const step = field.step ?? (field.type === 'int' ? 1 : 0.001);
                      return (
                        <TextField
                          key={`${section.title}-${field.key}`}
                          label={field.label}
                          type="number"
                          size="small"
                          value={fieldValue}
                          inputProps={{ step, min: field.min }}
                          onChange={(e) =>
                            handleNumberChange(section.section, fieldKey, e.target.value, parser)
                          }
                          helperText={field.helper ?? ''}
                        />
                      );
                    })}
                  </Box>
                </AccordionDetails>
              </Accordion>
              );
            })}
            {settingsError && (
              <Typography sx={{ fontSize: 12, color: '#ff6b6b' }}>
                {settingsError}
              </Typography>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={handleResetSettings} sx={{ textTransform: 'none' }}>
              Reset to Defaults
            </Button>
            <Button onClick={() => setSettingsOpen(false)} sx={{ textTransform: 'none' }}>
              Close
            </Button>
            <Button
              variant="contained"
              onClick={handleSaveSettings}
              disabled={settingsBusy}
              sx={{ textTransform: 'none' }}
            >
              {settingsBusy ? 'Saving...' : 'Save'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </LocalizationProvider>
  );
}
