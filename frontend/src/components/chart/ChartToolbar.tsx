/**
 * Chart toolbar with symbol and interval controls
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  Box,
  Select,
  MenuItem,
  FormControl,
  SelectChangeEvent,
  FormGroup,
  FormControlLabel,
  Checkbox,
  IconButton,
  Tooltip,
  ToggleButtonGroup,
  ToggleButton,
  Menu,
  Button,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import TuneIcon from '@mui/icons-material/Tune';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { useChartStore } from '@/store/chartStore';
import { Interval } from '@/types/chart.types';
import { analyzeVisibleRangeWithContext } from '@/analysis/strategyAnalysis';
import {
  DEFAULT_STRATEGY_SETTINGS,
  mergeStrategySettings,
  StrategySettings,
} from '@/analysis/strategyDefaults';
import {
  checkHealth,
  fetchFinvizRecomTarget,
  fetchStrategySettings,
  saveStrategySettings,
  searchSymbols,
  fetchAutoTraderStatus,
  updateTradingFavorites,
} from '@/services/api/marketData';
import { SYMBOLS, SYMBOL_NAMES } from '@/constants/symbols';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import optimalRanges from '@/data/optimalRanges.json';

const INTERVAL_OPTIONS: Interval[] = ['1d', '1h', '15m', '1m'];
 

export function ChartToolbar({ onBack }: { onBack?: () => void }) {
  const {
    symbol,
    interval,
    setSymbol,
    setSelectedContract,
    setInterval,
    loading,
    bars,
    showMA20,
    showMA40,
    showMA100,
    showMA200,
    showVWAP,
    showBollinger,
    showVolume,
    showWorden,
    useRth,
    setUseRth,
    setIndicator,
    visibleRange,
    setStrategySignals,
    setSelectedSignalId,
    isAnalyzing,
    setIsAnalyzing,
    setStrategyPanelOpen,
    setLastAnalysis,
    outcomeHorizonBars,
    setAnalysisContext,
    setOptionsPanelOpen,
    analysisTargetMode,
    setAnalysisTargetMode,
    setBarAnalysis,
    selectedContract,
    favorites,
    toggleFavorite,
    strategySettingsBySymbol,
    setStrategySettingsForSymbol,
  } = useChartStore();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching({
    queryKey: ['historical-data', symbol, interval],
  });
  const [indicatorsAnchor, setIndicatorsAnchor] = useState<null | HTMLElement>(
    null
  );
  const indicatorsOpen = Boolean(indicatorsAnchor);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [elapsedText, setElapsedText] = useState<string>('');
  const prevLoadingRef = useRef<boolean>(false);
  const prevFetchingRef = useRef<number>(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<StrategySettings>(
    DEFAULT_STRATEGY_SETTINGS
  );
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<
    {
      symbol: string;
      name: string;
      secType: string;
      exchange: string;
      currency: string;
      conId: number;
    }[]
  >([]);
  const finvizQuery = useQuery({
    queryKey: ['finviz-recom-target', symbol],
    queryFn: () => fetchFinvizRecomTarget(symbol),
  });
  useEffect(() => {
    updateTradingFavorites(favorites).catch((error) => {
      console.warn('Failed to sync favorites to backend', error);
    });
  }, [favorites]);
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: checkHealth,
    refetchInterval: 30000,
    staleTime: 10000,
  });
  const autoTraderQuery = useQuery({
    queryKey: ['auto-trader-status'],
    queryFn: fetchAutoTraderStatus,
    refetchInterval: 15000,
    staleTime: 5000,
  });

  const currentStrategySettings =
    strategySettingsBySymbol[symbol] ?? DEFAULT_STRATEGY_SETTINGS;

  const loadStrategySettings = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const response = await fetchStrategySettings(symbol);
      const merged = mergeStrategySettings(
        (response.settings as Partial<typeof DEFAULT_STRATEGY_SETTINGS>) ?? undefined
      );
      setStrategySettingsForSymbol(symbol, merged);
      setSettingsDraft(merged);
    } catch (error) {
      setSettingsDraft(currentStrategySettings);
      setSettingsError(
        error instanceof Error ? error.message : 'Failed to load settings'
      );
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
      await saveStrategySettings(symbol, settingsDraft);
      const merged = mergeStrategySettings(settingsDraft);
      setStrategySettingsForSymbol(symbol, merged);
      setSettingsDraft(merged);
    } catch (error) {
      setSettingsError(
        error instanceof Error ? error.message : 'Failed to save settings'
      );
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleResetSettings = () => {
    setSettingsDraft(DEFAULT_STRATEGY_SETTINGS);
  };

  const updateSettings = <Section extends keyof StrategySettings>(
    section: Section,
    key: keyof StrategySettings[Section],
    value: StrategySettings[Section][keyof StrategySettings[Section]]
  ) => {
    setSettingsDraft((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [key]: value,
      },
    }));
  };

  const handleNumberChange = <Section extends keyof StrategySettings>(
    section: Section,
    key: keyof StrategySettings[Section],
    value: string,
    parser: (input: string) => number
  ) => {
    const nextValue = parser(value);
    if (Number.isNaN(nextValue)) {
      return;
    }
    updateSettings(section, key, nextValue as StrategySettings[Section][keyof StrategySettings[Section]]);
  };


  const handleRefresh = () => {
    queryClient.invalidateQueries({
      queryKey: ['historical-data', symbol, interval],
      refetchType: 'active',
    });
  };

  const handleIndicatorsOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setIndicatorsAnchor(event.currentTarget);
  };

  const handleIndicatorsClose = () => {
    setIndicatorsAnchor(null);
  };

  const handleSymbolChange = (event: SelectChangeEvent) => {
    setSymbol(event.target.value as string);
  };

  const handleIntervalChange = (
    _event: MouseEvent<HTMLElement>,
    value: Interval | null
  ) => {
    if (value) {
      setInterval(value);
    }
  };

  const handleSearch = async () => {
    const query = searchInput.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const result = await searchSymbols(query);
      setSearchResults(
        result.results.map((item) => ({
          symbol: item.symbol,
          name: item.description || item.symbol,
          secType: item.secType,
          exchange: item.primaryExchange || item.exchange,
          currency: item.currency,
          conId: item.conId,
        }))
      );
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (searchOpen) {
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchOpen]);

  useEffect(() => {
    if (searchResults.length > 0) {
      setSearchSelectedIndex(0);
    } else {
      setSearchSelectedIndex(-1);
    }
  }, [searchResults]);

  const handleSelectResult = (result: {
    symbol: string;
    conId: number;
    secType: string;
    exchange: string;
  }) => {
    setSymbol(result.symbol);
    setSelectedContract({
      symbol: result.symbol,
      conId: result.conId,
      secType: result.secType,
      exchange: result.exchange,
    });
    setSearchOpen(false);
    setSearchInput('');
    setSearchResults([]);
  };

  const handleStrategyAnalysis = async () => {
    if (!visibleRange) return;
    setStrategyPanelOpen(true);
    setBarAnalysis(null);
    setSelectedSignalId(null);
    setIsAnalyzing(true);
    setLastAnalysis(null);
    const start = performance.now();
    try {
      let settingsOverride = strategySettingsBySymbol[symbol];
      if (!settingsOverride) {
        try {
          const response = await fetchStrategySettings(symbol);
          settingsOverride = mergeStrategySettings(
            (response.settings as Partial<typeof DEFAULT_STRATEGY_SETTINGS>) ?? undefined
          );
          setStrategySettingsForSymbol(symbol, settingsOverride);
        } catch {
          settingsOverride = currentStrategySettings;
        }
      }
      const result = await analyzeVisibleRangeWithContext(
        symbol,
        visibleRange,
        outcomeHorizonBars,
        selectedContract ?? undefined,
        settingsOverride
      );
      setStrategySignals(result.signals);
      setAnalysisContext(result.context);
      setSelectedSignalId(null);
      const durationMs = Math.round(performance.now() - start);
      setLastAnalysis({ durationMs, count: result.signals.length });
    } finally {
      setIsAnalyzing(false);
    }
  };

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    if (wasLoading && !loading) {
      setLastRefreshedAt(new Date());
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    const prev = prevFetchingRef.current;
    if (prev > 0 && isFetching === 0) {
      setLastRefreshedAt(new Date());
    }
    prevFetchingRef.current = isFetching;
  }, [isFetching]);

  useEffect(() => {
    if (!lastRefreshedAt && bars.length > 0) {
      setLastRefreshedAt(new Date());
    }
  }, [bars.length, lastRefreshedAt]);

  useEffect(() => {
    if (!lastRefreshedAt) {
      setElapsedText('');
      return;
    }
    const updateElapsed = () => {
      const seconds = Math.max(
        0,
        Math.floor((Date.now() - lastRefreshedAt.getTime()) / 1000)
      );
      if (seconds < 60) {
        setElapsedText(`${seconds}s ago`);
      } else if (seconds < 3600) {
        setElapsedText(`${Math.floor(seconds / 60)}m ago`);
      } else {
        setElapsedText(`${Math.floor(seconds / 3600)}h ago`);
      }
    };
    updateElapsed();
    const id = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(id);
  }, [lastRefreshedAt]);

  const nyTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  const companyName = SYMBOL_NAMES[symbol] || symbol;
  const optimalRange = (optimalRanges as Record<string, { min: number; max: number; currency?: string } | null>)[
    symbol
  ];
  const isFavorite = favorites.includes(symbol);
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
      title: 'Global',
      section: 'global',
      fields: [
        { key: 'warmup', label: 'Warmup bars', type: 'int', min: 0, step: 1 },
        { key: 'minBars1h', label: 'Minimum 1H bars', type: 'int', min: 0, step: 1 },
        { key: 'minBars15m', label: 'Minimum 15M bars', type: 'int', min: 0, step: 1 },
        { key: 'minBars1d', label: 'Minimum 1D bars', type: 'int', min: 0, step: 1 },
        { key: 'minBars1m', label: 'Minimum 1M bars', type: 'int', min: 0, step: 1 },
        {
          key: 'successThresholdPct',
          label: 'Success threshold %',
          type: 'percent',
          step: 0.001,
          min: 0,
          helper: percentHelper,
        },
      ],
    },
    {
      title: 'Strategy 1 — Trend Change',
      section: 'strategy1',
      fields: [
        { key: 'window15m', label: '15M confirm window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'float', min: 0, step: 0.5 },
        { key: 'trendLookback', label: 'Trend lookback (bars)', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 2 — Midline Bounce',
      section: 'strategy2',
      fields: [
        { key: 'dailyTrendLookback', label: 'Daily trend lookback', type: 'int', min: 1, step: 1 },
        { key: 'touchPct', label: 'Touch tolerance %', type: 'percent', step: 0.0001, min: 0, helper: percentHelper },
        { key: 'window1h', label: '1H confirm window', type: 'int', min: 1, step: 1 },
        { key: 'window15m', label: '15M entry window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'float', min: 0, step: 0.5 },
      ],
    },
    {
      title: 'Strategy 3 — Gap Fade (Low Vol)',
      section: 'strategy3',
      fields: [
        { key: 'minGapPct', label: 'Minimum gap %', type: 'percent', step: 0.0005, min: 0, helper: percentHelper },
        { key: 'tightLookback', label: 'Tight lookback', type: 'int', min: 1, step: 1 },
        { key: 'tightPercentile', label: 'Tight percentile', type: 'float', min: 1, step: 1 },
        { key: 'bandOutsideTol', label: 'Band outside tol %', type: 'percent', step: 0.0001, min: 0, helper: percentHelper },
        { key: 'entryWindowMinutes', label: 'Entry window (minutes)', type: 'int', min: 1, step: 1 },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'Strategy 4 — Magnet Effect',
      section: 'strategy4',
      fields: [
        { key: 'minDistPct', label: 'Min distance from MA20 %', type: 'percent', step: 0.0005, min: 0, helper: percentHelper },
        { key: 'firstBarWindow', label: 'First-bar window', type: 'int', min: 1, step: 1 },
        { key: 'confirmWindow', label: 'Confirm window', type: 'int', min: 1, step: 1 },
        { key: 'cooldownHours', label: 'Cooldown hours', type: 'float', min: 0, step: 0.5 },
      ],
    },
    {
      title: 'Strategy 5 — Lateral Open Outside Bollinger',
      section: 'strategy5',
      fields: [
        { key: 'minGapPct', label: 'Minimum gap %', type: 'percent', step: 0.0005, min: 0, helper: percentHelper },
        { key: 'tightLookback', label: 'Tight lookback', type: 'int', min: 1, step: 1 },
        { key: 'tightPercentile', label: 'Tight percentile', type: 'float', min: 1, step: 1 },
        { key: 'bandOutsideTol', label: 'Band outside tol %', type: 'percent', step: 0.0001, min: 0, helper: percentHelper },
        { key: 'maxSignalsPerDay', label: 'Max signals per day', type: 'int', min: 1, step: 1 },
        { key: 'flatLookback', label: 'Flat lookback', type: 'int', min: 1, step: 1 },
        { key: 'flatEpsilon', label: 'Flat epsilon', type: 'percent', step: 0.0001, min: 0, helper: percentHelper },
        { key: 'entryWindowMinutes', label: 'Entry window (minutes)', type: 'int', min: 1, step: 1 },
      ],
    },
    {
      title: 'CT15 — Opening Gap Reversal',
      section: 'ct15',
      fields: [
        { key: 'minGapPct', label: 'Minimum gap %', type: 'percent', step: 0.0005, min: 0, helper: percentHelper },
        { key: 'bwSlopeLookback', label: 'Bandwidth slope lookback', type: 'int', min: 1, step: 1 },
        { key: 'bwAvgRatio', label: 'BW avg ratio', type: 'float', step: 0.05, min: 0, helper: 'BW must exceed avg × ratio (1.0 = exact, 0.75 = relaxed)' },
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
  ];

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        padding: 0.5,
        alignItems: 'center',
        position: 'relative',
      }}
    >
      {onBack && (
        <IconButton
          size="small"
          onClick={onBack}
          sx={{
            color: '#d1d4dc',
            border: '1px solid #2b2b43',
            borderRadius: 1,
            '&:hover': { borderColor: '#4b4b63' },
          }}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>
      )}
      <FormControl size="small" sx={{ minWidth: 80 }}>
        <Select
          value={symbol}
          onChange={handleSymbolChange}
          sx={{
            color: '#d1d4dc',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: '#2b2b43' },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: '#4b4b63',
            },
            '& .MuiSvgIcon-root': { color: '#d1d4dc' },
            '& .MuiSelect-select': { paddingY: 0.5 },
          }}
        >
          {SYMBOLS.map((ticker) => (
            <MenuItem key={ticker} value={ticker}>
              {ticker}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Tooltip title="Search ticker">
        <span>
          <IconButton
            size="small"
            onClick={() => setSearchOpen(true)}
            sx={{
              color: '#d1d4dc',
              border: '1px solid #2b2b43',
              borderRadius: 1,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            <SearchIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={isFavorite ? 'Unfavorite' : 'Favorite'}>
        <span>
          <IconButton
            size="small"
            onClick={() => toggleFavorite(symbol)}
            sx={{
              color: isFavorite ? '#ffd54f' : '#d1d4dc',
              border: '1px solid #2b2b43',
              borderRadius: 1,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            {isFavorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>

      <ToggleButtonGroup
        value={interval}
        exclusive
        onChange={handleIntervalChange}
        size="small"
        sx={{
          border: '1px solid #2b2b43',
          '& .MuiToggleButton-root': {
            color: '#d1d4dc',
            borderColor: '#2b2b43',
            textTransform: 'none',
            paddingY: 0.5,
            '&.Mui-selected': {
              color: '#ffffff',
              backgroundColor: '#2962ff',
              '&:hover': { backgroundColor: '#1e53e5' },
            },
          },
        }}
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <ToggleButton key={opt} value={opt}>
            {opt.toUpperCase()}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Button
        variant="outlined"
        onClick={handleIndicatorsOpen}
        sx={{
          color: '#d1d4dc',
          borderColor: '#2b2b43',
          textTransform: 'none',
          marginLeft: 1,
          paddingY: 0.5,
          '&:hover': { borderColor: '#4b4b63' },
        }}
      >
        Indicators
      </Button>
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
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={!useRth}
            onChange={(e) => setUseRth(!e.target.checked)}
            sx={{
              color: '#d1d4dc',
              '&.Mui-checked': { color: '#d1d4dc' },
            }}
          />
        }
        label="Ext Hrs"
        sx={{ color: '#9aa0a6', marginLeft: 1 }}
      />
      <Menu
        anchorEl={indicatorsAnchor}
        open={indicatorsOpen}
        onClose={handleIndicatorsClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        MenuListProps={{ sx: { paddingX: 1, paddingY: 0.5 } }}
      >
        <FormGroup>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showMA20}
                onChange={(e) => setIndicator('showMA20', e.target.checked)}
                sx={{
                  color: '#f5a623',
                  '&.Mui-checked': { color: '#f5a623' },
                }}
              />
            }
            label="MA 20"
            sx={{ color: '#f5a623' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showMA40}
                onChange={(e) => setIndicator('showMA40', e.target.checked)}
                sx={{
                  color: '#50e3c2',
                  '&.Mui-checked': { color: '#50e3c2' },
                }}
              />
            }
            label="MA 40"
            sx={{ color: '#50e3c2' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showMA100}
                onChange={(e) => setIndicator('showMA100', e.target.checked)}
                sx={{
                  color: '#4a90e2',
                  '&.Mui-checked': { color: '#4a90e2' },
                }}
              />
            }
            label="MA 100"
            sx={{ color: '#4a90e2' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showMA200}
                onChange={(e) => setIndicator('showMA200', e.target.checked)}
                sx={{
                  color: '#9013fe',
                  '&.Mui-checked': { color: '#9013fe' },
                }}
              />
            }
            label="MA 200"
            sx={{ color: '#9013fe' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showVWAP}
                onChange={(e) => setIndicator('showVWAP', e.target.checked)}
                sx={{
                  color: '#ffcc00',
                  '&.Mui-checked': { color: '#ffcc00' },
                }}
              />
            }
            label="VWAP"
            sx={{ color: '#ffcc00' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showBollinger}
                onChange={(e) => setIndicator('showBollinger', e.target.checked)}
                sx={{
                  color: '#b0bec5',
                  '&.Mui-checked': { color: '#b0bec5' },
                }}
              />
            }
            label="Bollinger"
            sx={{ color: '#b0bec5' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showVolume}
                onChange={(e) => setIndicator('showVolume', e.target.checked)}
                sx={{
                  color: '#9e9e9e',
                  '&.Mui-checked': { color: '#9e9e9e' },
                }}
              />
            }
            label="Volume"
            sx={{ color: '#9e9e9e' }}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showWorden}
                onChange={(e) => setIndicator('showWorden', e.target.checked)}
                sx={{
                  color: '#ff9800',
                  '&.Mui-checked': { color: '#ff9800' },
                }}
              />
            }
            label="Worden"
            sx={{ color: '#ff9800' }}
          />
        </FormGroup>
      </Menu>
      <Button
        variant="outlined"
        onClick={handleStrategyAnalysis}
        disabled={!visibleRange || isAnalyzing}
        sx={{
          color: '#d1d4dc',
          borderColor: '#2b2b43',
          textTransform: 'none',
          marginLeft: 1,
          paddingY: 0.5,
          '&:hover': { borderColor: '#4b4b63' },
        }}
      >
        {isAnalyzing ? 'Analyzing…' : 'Strategy Analysis'}
      </Button>
      <Tooltip title="Target bar analysis">
        <span>
          <IconButton
            onClick={() => {
              setAnalysisTargetMode(!analysisTargetMode);
              setBarAnalysis(null);
              setSelectedSignalId(null);
              setStrategyPanelOpen(true);
            }}
            sx={{
              color: analysisTargetMode ? '#ffd54f' : '#d1d4dc',
              padding: 0.5,
              border: '1px solid #2b2b43',
              borderRadius: 1,
              marginLeft: 1,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            <GpsFixedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Button
        variant="outlined"
        onClick={() => setOptionsPanelOpen(true)}
        sx={{
          color: '#d1d4dc',
          borderColor: '#2b2b43',
          textTransform: 'none',
          marginLeft: 1,
          paddingY: 0.5,
          '&:hover': { borderColor: '#4b4b63' },
        }}
      >
        Options Chain
      </Button>

      <Box sx={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
        {lastRefreshedAt && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
              {`Last: ${nyTimeFormatter.format(lastRefreshedAt)} ET`}
            </Typography>
            {elapsedText && (
              <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
                {elapsedText}
              </Typography>
            )}
          </Box>
        )}
      <Tooltip title="Refresh data">
        <span>
          <IconButton
              onClick={handleRefresh}
              disabled={loading || isFetching > 0}
              sx={{
                color: '#d1d4dc',
                padding: 0.5,
                animation: loading ? 'spin 1s linear infinite' : 'none',
                '@keyframes spin': {
                  from: { transform: 'rotate(0deg)' },
                  to: { transform: 'rotate(360deg)' },
                },
              }}
            >
              <RefreshIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip
        title={
          healthQuery.isLoading
            ? 'IB Gateway: checking…'
            : healthQuery.isError
              ? 'IB Gateway: unavailable'
              : `IB Gateway: ${healthQuery.data?.ib_connected ? 'connected' : 'disconnected'}${
                  healthQuery.data?.message ? ` — ${healthQuery.data.message}` : ''
                }`
        }
      >
        <span>
          <FiberManualRecordIcon
            fontSize="small"
            sx={{
              color: healthQuery.isLoading
                ? '#7c8190'
                : healthQuery.isError
                  ? '#ef5350'
                  : healthQuery.data?.ib_connected
                    ? '#39d98a'
                    : '#f5a623',
              marginLeft: 0.5,
            }}
          />
        </span>
      </Tooltip>
      <Tooltip
        title={
          autoTraderQuery.isLoading
            ? 'Auto Trader: checking…'
            : autoTraderQuery.isError
              ? 'Auto Trader: unavailable'
              : autoTraderQuery.data?.running
                ? 'Auto Trader: running'
                : 'Auto Trader: stopped'
        }
      >
        <span>
          <FiberManualRecordIcon
            fontSize="small"
            sx={{
              color: autoTraderQuery.isLoading
                ? '#7c8190'
                : autoTraderQuery.isError
                  ? '#ef5350'
                  : autoTraderQuery.data?.running
                    ? '#39d98a'
                    : '#f5a623',
              marginLeft: 0.5,
            }}
          />
        </span>
      </Tooltip>
      </Box>
      <Box
        sx={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: 0.5,
          color: 'rgba(154, 160, 166, 0.8)',
          fontSize: '24px',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        <Box>{companyName}</Box>
        <Box sx={{ fontSize: '12px', color: '#9aa0a6', marginTop: 0.25 }}>
          {finvizQuery.isFetching ? (
            'Fetching…'
          ) : (
            <>
              <Box>Recom: {finvizQuery.data?.recom ?? '--'}</Box>
              <Box>Target: {finvizQuery.data?.target_price ?? '--'}</Box>
            </>
          )}
          <Box>
            Optimal: {optimalRange ? `$${optimalRange.min} - $${optimalRange.max}` : '--'}
          </Box>
        </Box>
      </Box>
      <Dialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Search Ticker</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Type company name or ticker"
            size="small"
            inputRef={searchInputRef}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (searchResults.length > 0) {
                  setSearchSelectedIndex((prev) =>
                    Math.min(prev + 1, searchResults.length - 1)
                  );
                }
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (searchResults.length > 0) {
                  setSearchSelectedIndex((prev) => Math.max(prev - 1, 0));
                }
              }
              if (e.key === 'Enter') {
                if (searchSelectedIndex >= 0 && searchResults[searchSelectedIndex]) {
                  handleSelectResult(searchResults[searchSelectedIndex]);
                } else {
                  handleSearch();
                }
              }
            }}
          />
          <Button
            variant="contained"
            onClick={handleSearch}
            disabled={searching}
            sx={{ alignSelf: 'flex-start', textTransform: 'none' }}
          >
            {searching ? 'Searching…' : 'Search'}
          </Button>
          <List dense sx={{ border: '1px solid #2b2b43', borderRadius: 1 }}>
            {searchResults.length === 0 && (
              <ListItemText
                primary="No results yet"
                primaryTypographyProps={{ sx: { padding: 1, color: '#9aa0a6' } }}
              />
            )}
            {searchResults.map((result, index) => (
              <ListItemButton
                key={`${result.symbol}-${result.secType}-${result.exchange}`}
                selected={index === searchSelectedIndex}
                onMouseEnter={() => setSearchSelectedIndex(index)}
                onClick={() => handleSelectResult(result)}
                sx={{
                  '&.Mui-selected': {
                    backgroundColor: 'rgba(126, 200, 255, 0.12)',
                  },
                }}
              >
                <ListItemText
                  primary={`${result.symbol} (${result.secType})`}
                  secondary={`${result.name} • ${result.exchange} • ${result.currency}`}
                  secondaryTypographyProps={{ sx: { color: '#9aa0a6' } }}
                />
              </ListItemButton>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setSearchOpen(false)}
            sx={{ textTransform: 'none' }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Strategy Settings (per symbol)</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Symbol: {symbol} · Settings are stored as JSON per symbol.
          </Typography>
          {settingsSections.map((section, index) => (
            <Accordion key={section.title} defaultExpanded={index === 0}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography sx={{ fontWeight: 600 }}>{section.title}</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 2,
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
                    const step =
                      field.step ?? (field.type === 'int' ? 1 : 0.001);
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
                  {section.section === 'ct15' && (
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={settingsDraft.ct15.strictExposedMode}
                          onChange={(e) =>
                            updateSettings('ct15', 'strictExposedMode', e.target.checked)
                          }
                        />
                      }
                      label="Strict exposed mode"
                      sx={{ alignSelf: 'center' }}
                    />
                  )}
                </Box>
              </AccordionDetails>
            </Accordion>
          ))}
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
            {settingsBusy ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
