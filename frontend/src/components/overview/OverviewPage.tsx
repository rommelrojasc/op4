import { useEffect, useMemo, useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  CircularProgress,
  Typography,
  IconButton,
  Tooltip,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ViewCompactIcon from '@mui/icons-material/ViewCompact';
import type { Bar } from '@/types/chart.types';
import { SYMBOLS, SYMBOL_NAMES, SYMBOL_GROUPS } from '@/constants/symbols';
import {
  checkHealth,
  fetchHistoricalData,
  fetchOptionChain,
  fetchOptionQuotes,
  fetchEarnings,
  fetchStrategySettings,
  searchSymbols,
  fetchAutoTraderStatus,
  updateTradingFavorites,
  fetchIbMetrics,
} from '@/services/api/marketData';
import { analyzeVisibleRange } from '@/analysis/strategyAnalysis';
import { mergeStrategySettings } from '@/analysis/strategyDefaults';
import { useChartStore } from '@/store/chartStore';
import optimalRanges from '@/data/optimalRanges.json';

interface OverviewCardState {
  symbol: string;
  bars: Bar[];
  sparklineBars: Bar[];
  latestPrice: number | null;
  prevClose: number | null;
  loading: boolean;
  analyzing: boolean;
  error: string | null;
  signalsCount: number;
  strategyHits: Record<string, boolean>;
  latestSignal: {
    time: number;
    direction: 'CALL' | 'PUT';
    strategyId: string;
  } | null;
  optionRange: {
    min: number;
    max: number;
    strike: number;
    expiration: string;
  } | null;
  earningsDate: string | null;
  analysisMetrics: {
    signalCount: number;
    lastSignalAgeHours: number | null;
    strategyDiversity: number;
    volatility: number | null;
    distanceToMA20: number | null;
    liquidity: number | null;
  } | null;
  lastUpdated: Date | null;
  lastAnalysisMs: number | null;
}

const nyDateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const nyTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
});

const getNyDayKey = (unixSeconds: number) => {
  const parts = nyDateParts.formatToParts(new Date(unixSeconds * 1000));
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
};

const isTodayNy = (unixSeconds: number) => {
  const todayKey = getNyDayKey(Math.floor(Date.now() / 1000));
  return getNyDayKey(unixSeconds) === todayKey;
};

const isTodayNyDateString = (dateString: string | null) => {
  if (!dateString) return false;
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const todayKey = getNyDayKey(Math.floor(Date.now() / 1000));
  const valueKey = getNyDayKey(Math.floor(date.getTime() / 1000));
  return valueKey === todayKey;
};



const dedupeBars = (bars: Bar[]) => {
  const seen = new Set<number>();
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  return sorted.filter((bar) => {
    if (seen.has(bar.time)) return false;
    seen.add(bar.time);
    return true;
  });
};

const buildSparklineBars = (bars: Bar[], count = 48) => {
  if (bars.length === 0) return [] as Bar[];
  return bars.slice(-count);
};

const renderSparklineCandles = (bars: Bar[]) => {
  if (bars.length < 2) return null;
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const candleWidth = 100 / bars.length;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
      {bars.map((bar, index) => {
        const open = bar.open;
        const close = bar.close;
        const high = bar.high;
        const low = bar.low;
        const isUp = close >= open;
        const color = isUp ? '#39d98a' : '#ff6b6b';
        const x = index * candleWidth + candleWidth * 0.1;
        const bodyWidth = candleWidth * 0.8;
        const yHigh = 100 - ((high - min) / range) * 100;
        const yLow = 100 - ((low - min) / range) * 100;
        const yOpen = 100 - ((open - min) / range) * 100;
        const yClose = 100 - ((close - min) / range) * 100;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
        return (
          <g key={`${bar.time}-${index}`}>
            <line
              x1={x + bodyWidth / 2}
              x2={x + bodyWidth / 2}
              y1={yHigh}
              y2={yLow}
              stroke={color}
              strokeWidth={1}
              strokeLinecap="round"
            />
            <rect
              x={x}
              y={bodyTop}
              width={bodyWidth}
              height={bodyHeight}
              fill={color}
              rx={0.6}
            />
          </g>
        );
      })}
    </svg>
  );
};


const calculateMA = (bars: Bar[], period: number) => {
  const values: Array<number | null> = Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close;
    if (i >= period) {
      sum -= bars[i - period].close;
    }
    if (i >= period - 1) {
      values[i] = sum / period;
    }
  }
  return values;
};

const calculateATR = (bars: Bar[], period: number) => {
  if (bars.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const slice = trs.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / period;
};

const nextFridayKey = () => {
  const now = new Date();
  const day = now.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  const nextFriday = new Date(now);
  nextFriday.setDate(now.getDate() + daysUntilFriday);
  return `${nextFriday.getFullYear()}-${String(nextFriday.getMonth() + 1).padStart(2, '0')}-${String(
    nextFriday.getDate()
  ).padStart(2, '0')}`;
};

const STRATEGIES = [
  { id: 'strategy1_trend_change_1h_15m', label: 'S1' },
  { id: 'strategy2_midline_bounce_1d_1h_15m', label: 'S2' },
  { id: 'strategy3_open_gap_fade_lowvol_15m_1m', label: 'S3' },
  { id: 'strategy4_magnet_effect_gap_far_from_ma20_15m', label: 'S4' },
  { id: 'strategy5_lateral_open_outside_bollinger_no_vol', label: 'S5' },
  { id: 'ct15_open_gap_trendline_midline_volatility_15m', label: 'CT15' },
];
const CT15_STRATEGY_ID = 'ct15_open_gap_trendline_midline_volatility_15m';
const OVERVIEW_SCAN_CONCURRENCY = Math.max(
  1,
  Number(import.meta.env.VITE_OVERVIEW_SCAN_CONCURRENCY ?? 3)
);

const optimalRangeBySymbol = optimalRanges as Record<
  string,
  { min: number; max: number; currency?: string } | null
>;


const BLOQUES = SYMBOL_GROUPS;

const getBlockLabel = (blockId: string) =>
  BLOQUES.find((block) => block.id === blockId)?.label ?? blockId;

async function runWithLimit<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await task(items[current], current);
    }
  });
  await Promise.all(runners);
}

export function OverviewPage({
  onSelectSymbol,
  onSelectContract,
}: {
  onSelectSymbol: (symbol: string) => void;
  onSelectContract: (contract: {
    symbol: string;
    conId: number;
    secType: string;
    exchange: string;
    currency: string;
  }) => void;
}) {
  const [cards, setCards] = useState<OverviewCardState[]>(() =>
    SYMBOLS.map((symbol) => ({
      symbol,
      bars: [],
      sparklineBars: [],
      latestPrice: null,
      prevClose: null,
      loading: false,
      analyzing: false,
      error: null,
      signalsCount: 0,
      strategyHits: STRATEGIES.reduce<Record<string, boolean>>((acc, strategy) => {
        acc[strategy.id] = false;
        return acc;
      }, {}),
      latestSignal: null,
      optionRange: null,
      earningsDate: null,
      analysisMetrics: null,
      lastUpdated: null,
      lastAnalysisMs: null,
    }))
  );
  const [refreshingBlocks, setRefreshingBlocks] = useState<Record<string, boolean>>({});
  const [analysisBlocks, setAnalysisBlocks] = useState<Record<string, boolean>>({});
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Record<string, Date>>({});
  const [elapsedText, setElapsedText] = useState<Record<string, string>>({});
  const [ct15Scanning, setCt15Scanning] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [scanAllBusy, setScanAllBusy] = useState(false);
  const [compactView, setCompactView] = useState(true);
  const [ibMetricsOpen, setIbMetricsOpen] = useState(false);
  const [scanResultsOpen, setScanResultsOpen] = useState(false);
  const [scanResults, setScanResults] = useState<{
    title: string;
    durationMs: number;
    totalSymbols: number;
    detectedSignals: number;
    errorCount: number;
    strategyCounts: Record<string, number>;
  } | null>(null);
  const scanContextRef = useRef<{
    title: string;
    symbols: string[];
    startedAt: number;
  } | null>(null);
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
  const favorites = useChartStore((state) => state.favorites);
  const cardsRef = useRef<OverviewCardState[]>(cards);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const syncFavorites = useMemo(
    () =>
      async (list: string[]) => {
        try {
          await updateTradingFavorites(list);
        } catch (error) {
          console.warn('Failed to sync favorites to backend', error);
        }
      },
    []
  );
  useEffect(() => {
    syncFavorites(favorites);
  }, [favorites, syncFavorites]);

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
  const ibMetricsQuery = useQuery({
    queryKey: ['ib-metrics'],
    queryFn: fetchIbMetrics,
    refetchInterval: ibMetricsOpen ? 2000 : false,
  });
  const updateCard = (symbol: string, patch: Partial<OverviewCardState>) => {
    setCards((prev) =>
      prev.map((card) =>
        card.symbol === symbol ? { ...card, ...patch } : card
      )
    );
  };

  const loadSymbol = async (
    symbol: string,
    runAnalysis: boolean,
    strategyId?: string,
    analysisWindowSeconds?: number,
    fetchOptions = true
  ) => {
    updateCard(symbol, { loading: true, error: null, analyzing: runAnalysis });
    try {
      const [data1m, data1d, data15m] = await Promise.all([
        fetchHistoricalData(symbol, '1m', 700, undefined, undefined, false),
        fetchHistoricalData(symbol, '1d', 2),
        fetchHistoricalData(symbol, '15m', 200),
      ]);
      const latestPrice =
        data1m.bars.length > 0 ? data1m.bars[data1m.bars.length - 1].close : null;
      const sparklineBars = buildSparklineBars(data15m.bars);
      const prevClose =
        data1d.bars.length > 0 ? data1d.bars[data1d.bars.length - 1].close : null;

      updateCard(symbol, {
        bars: [],
        lastUpdated: new Date(),
        latestPrice,
        prevClose,
        sparklineBars,
      });

      try {
        const earnings = await fetchEarnings(symbol);
        updateCard(symbol, { earningsDate: earnings.earnings_date ?? null });
      } catch {
        updateCard(symbol, { earningsDate: null });
      }

      if (!fetchOptions) {
        updateCard(symbol, { optionRange: null });
      } else if (latestPrice !== null) {
        try {
          const chain = await fetchOptionChain(symbol);
          const targetFriday = nextFridayKey();
          const expirations = chain.expirations.map((exp) => exp.date).sort();
          const expiration = expirations.find((date) => date >= targetFriday) ?? expirations[0];
          const strikes = chain.expirations.find((exp) => exp.date === expiration)?.strikes ?? [];
          if (expiration && strikes.length > 0) {
            const nearestStrike = strikes.reduce((prev, curr) =>
              Math.abs(curr - latestPrice) < Math.abs(prev - latestPrice) ? curr : prev
            );
            const quotes = await fetchOptionQuotes(symbol, expiration, [nearestStrike]);
            const prices: number[] = [];
            for (const quote of quotes.quotes) {
              if (quote.last) prices.push(quote.last);
              if (quote.bid) prices.push(quote.bid);
              if (quote.ask) prices.push(quote.ask);
            }
            if (prices.length > 0) {
              const min = Math.min(...prices) * 100;
              const max = Math.max(...prices) * 100;
              updateCard(symbol, {
                optionRange: { min, max, strike: nearestStrike, expiration },
              });
            } else {
              updateCard(symbol, { optionRange: null });
            }
          } else {
            updateCard(symbol, { optionRange: null });
          }
        } catch {
          updateCard(symbol, { optionRange: null });
        }
      } else if (latestPrice === null) {
        updateCard(symbol, { optionRange: null });
      }

      let signalsCount = 0;
      let analysisMs: number | null = null;
      let strategyHits: Record<string, boolean> | null = null;
      let latestSignal: OverviewCardState['latestSignal'] = null;
      let analysisMetrics: OverviewCardState['analysisMetrics'] = null;
      if (runAnalysis) {
        let settingsOverrides: Record<string, unknown> | undefined;
        try {
          const settingsResponse = await fetchStrategySettings(symbol);
          settingsOverrides = settingsResponse.settings ?? undefined;
        } catch {
          settingsOverrides = undefined;
        }
        const data15m = await fetchHistoricalData(symbol, '15m', 300);
        const bars = dedupeBars(data15m.bars);
        const lastTime = bars[bars.length - 1]?.time ?? 0;
        const windowStart = lastTime
          ? lastTime - (analysisWindowSeconds ?? 7 * 86400)
          : 0;
        const analysisBars = lastTime
          ? bars.filter((bar) => bar.time >= windowStart)
          : bars;
        updateCard(symbol, { bars: analysisBars });
        if (analysisBars.length === 0) {
          updateCard(symbol, { analyzing: false });
        }
        const visibleRange = {
          from: analysisBars[0]?.time ?? 0,
          to: analysisBars[analysisBars.length - 1]?.time ?? 0,
        };
        const start = performance.now();
        const signals = await analyzeVisibleRange(
          symbol,
          visibleRange,
          8,
          undefined,
          settingsOverrides as Parameters<typeof mergeStrategySettings>[0]
        );
        const filteredSignals = strategyId
          ? signals.filter((signal) => signal.strategyId === strategyId)
          : signals;
        analysisMs = Math.round(performance.now() - start);
        signalsCount = filteredSignals.length;
        strategyHits = STRATEGIES.reduce<Record<string, boolean>>(
          (acc, strategy) => {
            if (strategyId && strategy.id !== strategyId) {
              acc[strategy.id] = false;
            } else {
              acc[strategy.id] = filteredSignals.some(
                (signal) => signal.strategyId === strategy.id
              );
            }
            return acc;
          },
          {}
        );
        if (filteredSignals.length > 0) {
          const latest = filteredSignals.reduce((prev, curr) =>
            curr.entryTime > prev.entryTime ? curr : prev
          );
          latestSignal = {
            time: latest.entryTime,
            direction: latest.direction,
            strategyId: latest.strategyId,
          };
        }
        const uniqueStrategies = new Set(filteredSignals.map((s) => s.strategyId));
        const lastSignalTime = latestSignal ? latestSignal.time : null;
        const lastSignalAgeHours =
          lastSignalTime !== null
            ? (Date.now() - lastSignalTime * 1000) / 3600000
            : null;
        const ma20 = calculateMA(analysisBars, 20);
        const latestBar = analysisBars[analysisBars.length - 1];
        const ma20Value = ma20[ma20.length - 1];
        const distanceToMA20 =
          ma20Value && latestBar ? Math.abs(latestBar.close - ma20Value) / ma20Value : null;
        const atr = calculateATR(analysisBars, 14);
        const volatility = atr && latestBar ? atr / latestBar.close : null;
        const recentVolumeBars = analysisBars.slice(-20);
        const liquidity =
          recentVolumeBars.length > 0
            ? recentVolumeBars.reduce((acc, bar) => acc + (bar.volume ?? 0), 0) /
              recentVolumeBars.length
            : null;
        analysisMetrics = {
          signalCount: filteredSignals.length,
          lastSignalAgeHours,
          strategyDiversity: uniqueStrategies.size,
          volatility,
          distanceToMA20,
          liquidity,
        };
      }

      updateCard(symbol, {
        loading: false,
        analyzing: false,
        signalsCount,
        lastAnalysisMs: analysisMs,
        latestSignal,
        analysisMetrics,
        ...(strategyHits ? { strategyHits } : null),
      });
    } catch (error) {
      updateCard(symbol, {
        loading: false,
        analyzing: false,
        error: error instanceof Error ? error.message : 'Failed to load',
      });
    }
  };

  const refreshBlock = async (
    blockId: string,
    symbols: string[],
    strategyId?: string
  ) => {
    const start = performance.now();
    scanContextRef.current = {
      title: `${getBlockLabel(blockId)} Scan`,
      symbols,
      startedAt: start,
    };
    setRefreshingBlocks((prev) => ({ ...prev, [blockId]: true }));
    setAnalysisBlocks((prev) => ({ ...prev, [blockId]: true }));
    await runWithLimit(symbols, 3, async (symbol) => {
      await loadSymbol(symbol, true, strategyId, undefined, false);
    });
    setRefreshingBlocks((prev) => ({ ...prev, [blockId]: false }));
    setAnalysisBlocks((prev) => ({ ...prev, [blockId]: false }));
    setLastRefreshedAt((prev) => ({ ...prev, [blockId]: new Date() }));
    const durationMs = performance.now() - start;
    const cardsMap = new Map(cardsRef.current.map((card) => [card.symbol, card]));
    const strategyCounts: Record<string, number> = {};
    STRATEGIES.forEach((strategy) => {
      strategyCounts[strategy.label] = 0;
    });
    let detectedSignals = 0;
    let errorCount = 0;
    symbols.forEach((symbol) => {
      const card = cardsMap.get(symbol);
      if (!card) return;
      if (card.error) errorCount += 1;
      if (card.signalsCount > 0) detectedSignals += 1;
      STRATEGIES.forEach((strategy) => {
        if (card.strategyHits[strategy.id]) {
          strategyCounts[strategy.label] += 1;
        }
      });
    });
    setScanResults({
      title: `${getBlockLabel(blockId)} Scan`,
      durationMs,
      totalSymbols: symbols.length,
      detectedSignals,
      errorCount,
      strategyCounts,
    });
    setScanResultsOpen(true);
    scanContextRef.current = null;
  };

  const refreshOptionsBlock = async (blockId: string, symbols: string[]) => {
    setRefreshingBlocks((prev) => ({ ...prev, [blockId]: true }));
    await runWithLimit(symbols, 3, async (symbol) => {
      await loadSymbol(symbol, false, undefined, undefined, true);
    });
    setRefreshingBlocks((prev) => ({ ...prev, [blockId]: false }));
    setLastRefreshedAt((prev) => ({ ...prev, [blockId]: new Date() }));
  };

  const runCt15ScanAll = async () => {
    const start = performance.now();
    scanContextRef.current = {
      title: 'CT15 Scan',
      symbols: [...SYMBOLS],
      startedAt: start,
    };
    setCt15Scanning(true);
    await runWithLimit([...SYMBOLS], OVERVIEW_SCAN_CONCURRENCY, async (symbol) => {
      await loadSymbol(symbol, true, CT15_STRATEGY_ID, undefined, false);
    });
    setCt15Scanning(false);
    const durationMs = performance.now() - start;
    const cardsMap = new Map(cardsRef.current.map((card) => [card.symbol, card]));
    let detectedSignals = 0;
    let errorCount = 0;
    SYMBOLS.forEach((symbol) => {
      const card = cardsMap.get(symbol);
      if (!card) return;
      if (card.error) errorCount += 1;
      if (card.strategyHits[CT15_STRATEGY_ID]) detectedSignals += 1;
    });
    setScanResults({
      title: 'CT15 Scan',
      durationMs,
      totalSymbols: SYMBOLS.length,
      detectedSignals,
      errorCount,
      strategyCounts: { CT15: detectedSignals },
    });
    setScanResultsOpen(true);
    scanContextRef.current = null;
  };

  const runScanAll = async () => {
    const start = performance.now();
    scanContextRef.current = {
      title: 'Scan All',
      symbols: [...SYMBOLS],
      startedAt: start,
    };
    setScanAllBusy(true);
    await runWithLimit([...SYMBOLS], OVERVIEW_SCAN_CONCURRENCY, async (symbol) => {
      await loadSymbol(symbol, true, undefined, 15 * 60, false);
    });
    setScanAllBusy(false);
    const durationMs = performance.now() - start;
    const cardsMap = new Map(cardsRef.current.map((card) => [card.symbol, card]));
    const strategyCounts: Record<string, number> = {};
    STRATEGIES.forEach((strategy) => {
      strategyCounts[strategy.label] = 0;
    });
    let detectedSignals = 0;
    let errorCount = 0;
    SYMBOLS.forEach((symbol) => {
      const card = cardsMap.get(symbol);
      if (!card) return;
      if (card.error) errorCount += 1;
      if (card.signalsCount > 0) detectedSignals += 1;
      STRATEGIES.forEach((strategy) => {
        if (card.strategyHits[strategy.id]) {
          strategyCounts[strategy.label] += 1;
        }
      });
    });
    setScanResults({
      title: 'Scan All',
      durationMs,
      totalSymbols: SYMBOLS.length,
      detectedSignals,
      errorCount,
      strategyCounts,
    });
    setScanResultsOpen(true);
    scanContextRef.current = null;
  };

  useEffect(() => {
    if (!scanResultsOpen) return;
    const intervalId = window.setInterval(() => {
      const ctx = scanContextRef.current;
      if (!ctx) return;
      const cardsMap = new Map(cardsRef.current.map((card) => [card.symbol, card]));
      const strategyCounts: Record<string, number> = {};
      STRATEGIES.forEach((strategy) => {
        strategyCounts[strategy.label] = 0;
      });
      let detectedSignals = 0;
      let errorCount = 0;
      ctx.symbols.forEach((symbol) => {
        const card = cardsMap.get(symbol);
        if (!card) return;
        if (card.error) errorCount += 1;
        if (card.signalsCount > 0) detectedSignals += 1;
        STRATEGIES.forEach((strategy) => {
          if (card.strategyHits[strategy.id]) {
            strategyCounts[strategy.label] += 1;
          }
        });
      });
      setScanResults({
        title: ctx.title,
        durationMs: performance.now() - ctx.startedAt,
        totalSymbols: ctx.symbols.length,
        detectedSignals,
        errorCount,
        strategyCounts,
      });
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [scanResultsOpen]);


  useEffect(() => {
    const updateElapsed = () => {
      setElapsedText((prev) => {
        const next: Record<string, string> = { ...prev };
        Object.entries(lastRefreshedAt).forEach(([blockId, timestamp]) => {
          const diffSeconds = Math.floor((Date.now() - timestamp.getTime()) / 1000);
          if (diffSeconds < 10) {
            next[blockId] = 'just now';
          } else if (diffSeconds < 60) {
            next[blockId] = `${diffSeconds}s ago`;
          } else if (diffSeconds < 3600) {
            next[blockId] = `${Math.floor(diffSeconds / 60)}m ago`;
          } else {
            next[blockId] = `${Math.floor(diffSeconds / 3600)}h ago`;
          }
        });
        return next;
      });
    };
    updateElapsed();
    const id = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(id);
  }, [lastRefreshedAt]);

  const filteredCards = useMemo(() => {
    return [...cards].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [cards]);

  const favoriteCards = useMemo(() => {
    if (favorites.length === 0) return [] as OverviewCardState[];
    return favorites
      .map((symbol) => filteredCards.find((card) => card.symbol === symbol))
      .filter(Boolean) as OverviewCardState[];
  }, [favorites, filteredCards]);

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

  // no gap settings to recompute

  const handleSelectResult = (result: {
    symbol: string;
    conId: number;
    secType: string;
    exchange: string;
    currency: string;
  }) => {
    onSelectContract({
      symbol: result.symbol,
      conId: result.conId,
      secType: result.secType,
      exchange: result.exchange,
      currency: result.currency,
    });
    setSearchOpen(false);
    setSearchInput('');
    setSearchResults([]);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 's') {
        const target = event.target as HTMLElement | null;
        if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) {
          return;
        }
        setSearchOpen(true);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#0b0f15',
        color: '#d1d4dc',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          padding: '12px 14px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            Overview
          </Typography>
          <IconButton
            onClick={() => setSearchOpen(true)}
            sx={{
              color: '#d1d4dc',
              border: '1px solid #2b2b43',
              borderRadius: 2,
              padding: 0.5,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            <SearchIcon fontSize="small" />
          </IconButton>
          <IconButton
            onClick={() => setCompactView((prev) => !prev)}
            sx={{
              color: compactView ? '#39d98a' : '#d1d4dc',
              border: '1px solid #2b2b43',
              borderRadius: 2,
              padding: 0.5,
              '&:hover': { borderColor: '#4b4b63' },
            }}
          >
            <ViewCompactIcon fontSize="small" />
          </IconButton>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Button
              variant="outlined"
              onClick={runScanAll}
              disabled={scanAllBusy}
              sx={{
                color: '#d1d4dc',
                borderColor: '#2b2b43',
                textTransform: 'none',
                paddingY: 0.5,
                '&:hover': { borderColor: '#4b4b63' },
              }}
            >
              {scanAllBusy ? 'Scanning…' : 'Scan All'}
            </Button>
            <IconButton
              onClick={() => setScanResultsOpen(true)}
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
            <Button
              variant="outlined"
              onClick={runCt15ScanAll}
              disabled={ct15Scanning}
              sx={{
                color: '#d1d4dc',
                borderColor: '#2b2b43',
                textTransform: 'none',
                paddingY: 0.5,
                '&:hover': { borderColor: '#4b4b63' },
              }}
            >
              {ct15Scanning ? 'CT15 Scanning…' : 'CT15 Scan'}
            </Button>
          </Box>
          <Tooltip
            title={
              healthQuery.isLoading
                ? 'IB Gateway: checking…'
                : healthQuery.isError
                  ? 'IB Gateway: unavailable'
                  : `IB Gateway: ${
                      healthQuery.data?.ib_connected ? 'connected' : 'disconnected'
                    }${healthQuery.data?.message ? ` — ${healthQuery.data.message}` : ''}`
            }
          >
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
              }}
            />
          </Tooltip>
        </Box>
      </Box>
      <Box
        sx={{
          padding: 0,
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            '&::-webkit-scrollbar': { display: 'none', width: 0, height: 0 },
          }}
        >
        {compactView ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 0,
            }}
          >
            {filteredCards.map((card) => {
              const inFlightSymbols = autoTraderQuery.data?.in_flight_symbols ?? [];
              const autoTraderScanning =
                Boolean(autoTraderQuery.data?.running) &&
                (inFlightSymbols.includes(card.symbol) ||
                  autoTraderQuery.data?.current_symbol === card.symbol);
              const scanning = card.loading || card.analyzing || autoTraderScanning;
              return (
              <Box
                key={card.symbol}
                onClick={() => onSelectSymbol(card.symbol)}
                sx={{
                  border: '1px solid rgba(255,255,255,0.08)',
                  backgroundColor: '#0f131b',
                  cursor: 'pointer',
                  padding: '10px 12px',
                  ...(scanning && {
                    border: '1px solid rgba(57,217,138,0.8)',
                    boxShadow: '0 0 0 1px rgba(57,217,138,0.5) inset',
                    animation: 'pulseBorder 1.6s ease-in-out infinite',
                  }),
                  '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)' },
                  '@keyframes pulseBorder': {
                    '0%': {
                      boxShadow: '0 0 0 1px rgba(57,217,138,0.35) inset',
                    },
                    '50%': {
                      boxShadow: '0 0 0 3px rgba(57,217,138,0.65) inset',
                    },
                    '100%': {
                      boxShadow: '0 0 0 1px rgba(57,217,138,0.35) inset',
                    },
                  },
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                  {card.symbol}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 600,
                    color:
                      card.latestPrice !== null &&
                      card.prevClose !== null &&
                      card.latestPrice - card.prevClose >= 0
                        ? '#39d98a'
                        : '#ff6b6b',
                  }}
                >
                  {card.latestPrice !== null ? card.latestPrice.toFixed(2) : '—'}
                </Typography>
              </Box>
              );
            })}
          </Box>
        ) : (
          <>
        {favoriteCards.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <Box
              sx={{
                padding: '6px 12px',
                backgroundColor: 'rgba(255,255,255,0.04)',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Box
                sx={{
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#ffd54f',
                }}
              >
                Favorites
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                  {favoriteCards.reduce((acc, card) => acc + (card.signalsCount ?? 0), 0) > 0
                    ? `${favoriteCards.reduce(
                        (acc, card) => acc + (card.signalsCount ?? 0),
                        0
                      )} signals`
                    : 'No signals'}
                </Typography>
                {lastRefreshedAt.favorites && (
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      lineHeight: 1.1,
                    }}
                  >
                    <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
                      {`Last: ${nyTimeFormatter.format(lastRefreshedAt.favorites)} ET`}
                    </Typography>
                    {elapsedText.favorites && (
                      <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
                        {elapsedText.favorites}
                      </Typography>
                    )}
                  </Box>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() =>
                    refreshBlock(
                      'favorites',
                      favoriteCards.map((card) => card.symbol)
                    )
                  }
                  disabled={
                    refreshingBlocks.favorites ||
                    analysisBlocks.favorites ||
                    favoriteCards.length === 0
                  }
                  sx={{
                    color: '#d1d4dc',
                    borderColor: '#2b2b43',
                    textTransform: 'none',
                    paddingY: 0.25,
                    minWidth: 120,
                    '&:hover': { borderColor: '#4b4b63' },
                  }}
                >
                  {refreshingBlocks.favorites ? 'Checking…' : 'Check Strategies'}
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() =>
                    refreshOptionsBlock(
                      'favorites',
                      favoriteCards.map((card) => card.symbol)
                    )
                  }
                  disabled={refreshingBlocks.favorites || favoriteCards.length === 0}
                  sx={{
                    color: '#d1d4dc',
                    borderColor: '#2b2b43',
                    textTransform: 'none',
                    paddingY: 0.25,
                    minWidth: 96,
                    '&:hover': { borderColor: '#4b4b63' },
                  }}
                >
                  Check Options
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() =>
                    refreshBlock(
                      'favorites',
                      favoriteCards.map((card) => card.symbol),
                      CT15_STRATEGY_ID
                    )
                  }
                  disabled={
                    refreshingBlocks.favorites ||
                    analysisBlocks.favorites ||
                    favoriteCards.length === 0
                  }
                  sx={{
                    color: '#d1d4dc',
                    borderColor: '#2b2b43',
                    textTransform: 'none',
                    paddingY: 0.25,
                    minWidth: 72,
                    '&:hover': { borderColor: '#4b4b63' },
                  }}
                >
                  CT15
                </Button>
              </Box>
            </Box>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 0,
              }}
            >
              {favoriteCards.map((card) => {
                const name = SYMBOL_NAMES[card.symbol] ?? card.symbol;
                const signalToday = card.latestSignal ? isTodayNy(card.latestSignal.time) : false;
                const earningsToday = isTodayNyDateString(card.earningsDate);
                const optimalRange = optimalRangeBySymbol[card.symbol];
                const optionWithinOptimal =
                  card.optionRange && optimalRange
                    ? (card.optionRange.min >= optimalRange.min &&
                        card.optionRange.min <= optimalRange.max) ||
                      (card.optionRange.max >= optimalRange.min &&
                        card.optionRange.max <= optimalRange.max)
                    : false;
                const volValue = card.analysisMetrics?.volatility ?? null;
                const distValue = card.analysisMetrics?.distanceToMA20 ?? null;
                const tags: string[] = [];
                if (card.latestSignal?.strategyId === 'strategy1_trend_change_1h_15m') {
                  tags.push('Trend');
                }
                if (
                  card.latestSignal?.strategyId ===
                    'strategy3_open_gap_fade_lowvol_15m_1m' ||
                  card.latestSignal?.strategyId ===
                    'strategy5_lateral_open_outside_bollinger_no_vol' ||
                  card.latestSignal?.strategyId ===
                    'ct15_open_gap_trendline_midline_volatility_15m'
                ) {
                  tags.push('Gap');
                }
                if (
                  card.latestSignal?.strategyId ===
                  'ct15_open_gap_trendline_midline_volatility_15m'
                ) {
                  tags.push('CT15');
                }
                if (
                  card.latestSignal?.strategyId ===
                    'strategy2_midline_bounce_1d_1h_15m' ||
                  card.latestSignal?.strategyId ===
                    'strategy4_magnet_effect_gap_far_from_ma20_15m'
                ) {
                  tags.push('Mean-revert');
                }
                if (volValue !== null && volValue > 0.02) {
                  tags.push('High Vol');
                } else if (volValue !== null && volValue < 0.008) {
                  tags.push('Low Vol');
                }
                if (distValue !== null && distValue > 0.02) {
                  tags.push('Far MA20');
                }
                return (
                  <Box
                    key={card.symbol}
                    onClick={() => onSelectSymbol(card.symbol)}
                    sx={{
                      position: 'relative',
                      border: '1px solid rgba(255,255,255,0.08)',
                      backgroundColor: '#0f131b',
                      boxShadow: signalToday ? '0 0 0 2px rgba(57, 217, 138, 0.6) inset' : 'none',
                      cursor: 'pointer',
                      transition: 'background-color 120ms ease',
                      padding: '12px',
                      overflow: 'hidden',
                      '&:hover': {
                        backgroundColor: 'rgba(255,255,255,0.04)',
                      },
                    }}
                  >
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        opacity: 0.35,
                        pointerEvents: 'none',
                      }}
                    >
                      {renderSparklineCandles(card.sparklineBars)}
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <Box>
                        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                          {card.symbol}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#c2c7d0', opacity: 0.8 }}>
                          {name}
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography
                          sx={{
                            fontSize: 16,
                            fontWeight: 600,
                            color:
                              card.latestPrice !== null &&
                              card.prevClose !== null &&
                              card.latestPrice - card.prevClose >= 0
                                ? '#39d98a'
                                : '#ff6b6b',
                          }}
                        >
                          {card.latestPrice !== null ? card.latestPrice.toFixed(2) : '—'}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#7c8190' }}>
                          {card.prevClose !== null ? card.prevClose.toFixed(2) : '—'}
                        </Typography>
                        {signalToday && (
                          <Box
                            sx={{
                              marginTop: 0.5,
                              paddingX: 0.75,
                              paddingY: 0.25,
                              borderRadius: 6,
                              backgroundColor: 'rgba(57, 217, 138, 0.2)',
                              fontSize: 10,
                              color: '#39d98a',
                              display: 'inline-block',
                            }}
                          >
                            Today
                          </Box>
                        )}
                        {earningsToday && (
                          <Box
                            sx={{
                              marginTop: 0.5,
                              paddingX: 0.75,
                              paddingY: 0.25,
                              borderRadius: 6,
                              backgroundColor: 'rgba(255, 193, 7, 0.18)',
                              fontSize: 10,
                              color: '#ffc107',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 0.5,
                            }}
                          >
                            <WarningAmberIcon sx={{ fontSize: 12 }} />
                            Earnings Today
                          </Box>
                        )}
                      </Box>
                    </Box>
                    <Box sx={{ marginTop: 1 }}>
                      {card.loading ? (
                        <CircularProgress size={16} />
                      ) : (
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <Typography
                            sx={{
                              fontSize: 11,
                              color: card.latestSignal?.direction === 'CALL'
                                ? '#39d98a'
                                : card.latestSignal?.direction === 'PUT'
                                  ? '#ff6b6b'
                                  : '#7c8190',
                              fontWeight: 600,
                            }}
                          >
                            {card.latestSignal?.direction
                              ? `Signal: ${card.latestSignal.direction}`
                              : 'No signal'}
                          </Typography>
                          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {optionWithinOptimal && (
                                <CheckCircleIcon sx={{ fontSize: 12, color: '#39d98a' }} />
                              )}
                              <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                                {card.optionRange
                                  ? `Opt $${card.optionRange.min.toFixed(2)}-$${card.optionRange.max.toFixed(
                                      2
                                    )}`
                                  : 'Opt --'}
                              </Typography>
                            </Box>
                            <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                              {optimalRange
                                ? `Optimal $${optimalRange.min} - $${optimalRange.max}`
                                : 'Optimal --'}
                            </Typography>
                          </Box>
                        </Box>
                      )}
                    </Box>
                    {tags.length > 0 && (
                      <Box sx={{ marginTop: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {tags.slice(0, 3).map((tag) => (
                          <Box
                            key={tag}
                            sx={{
                              paddingX: 0.75,
                              paddingY: 0.25,
                              borderRadius: 6,
                              backgroundColor: 'rgba(255,255,255,0.06)',
                              fontSize: 10,
                              color: '#9aa0a6',
                            }}
                          >
                            {tag}
                          </Box>
                        ))}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}
        {BLOQUES.map((block) => {
          const blockCards = block.symbols
            .map((symbol) => filteredCards.find((card) => card.symbol === symbol))
            .filter(Boolean) as OverviewCardState[];
          if (blockCards.length === 0) return null;
          const sortedBlockCards = [...blockCards];
          const blockSignalCount = sortedBlockCards.reduce(
            (acc, card) => acc + (card.signalsCount ?? 0),
            0
          );
          return (
            <Box key={block.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Box
                sx={{
                  padding: '6px 12px',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <Box
                  sx={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: '#9aa1ad',
                  }}
                >
                  {block.label}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                    {blockSignalCount > 0 ? `${blockSignalCount} signals` : 'No signals'}
                  </Typography>
                  {lastRefreshedAt[block.id] && (
                    <Box
                      sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        lineHeight: 1.1,
                      }}
                    >
                      <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
                        {`Last: ${nyTimeFormatter.format(lastRefreshedAt[block.id])} ET`}
                      </Typography>
                      {elapsedText[block.id] && (
                        <Typography sx={{ fontSize: '11px', color: '#9aa0a6' }}>
                          {elapsedText[block.id]}
                        </Typography>
                      )}
                    </Box>
                  )}
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => refreshBlock(block.id, block.symbols)}
                    disabled={refreshingBlocks[block.id] || analysisBlocks[block.id]}
                    sx={{
                      color: '#d1d4dc',
                      borderColor: '#2b2b43',
                      textTransform: 'none',
                      paddingY: 0.25,
                      minWidth: 120,
                      '&:hover': { borderColor: '#4b4b63' },
                    }}
                  >
                    {refreshingBlocks[block.id] ? 'Checking…' : 'Check Strategies'}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => refreshOptionsBlock(block.id, block.symbols)}
                    disabled={refreshingBlocks[block.id]}
                    sx={{
                      color: '#d1d4dc',
                      borderColor: '#2b2b43',
                      textTransform: 'none',
                      paddingY: 0.25,
                      minWidth: 96,
                      '&:hover': { borderColor: '#4b4b63' },
                    }}
                  >
                    Check Options
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => refreshBlock(block.id, block.symbols, CT15_STRATEGY_ID)}
                    disabled={refreshingBlocks[block.id] || analysisBlocks[block.id]}
                    sx={{
                      color: '#d1d4dc',
                      borderColor: '#2b2b43',
                      textTransform: 'none',
                      paddingY: 0.25,
                      minWidth: 72,
                      '&:hover': { borderColor: '#4b4b63' },
                    }}
                  >
                    CT15
                  </Button>
                </Box>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: 0,
                }}
              >
                {sortedBlockCards.map((card) => {
                  const name = SYMBOL_NAMES[card.symbol] ?? card.symbol;
                  const signalToday = card.latestSignal ? isTodayNy(card.latestSignal.time) : false;
                  const earningsToday = isTodayNyDateString(card.earningsDate);
                  const optimalRange = optimalRangeBySymbol[card.symbol];
                  const optionWithinOptimal =
                    card.optionRange && optimalRange
                      ? (card.optionRange.min >= optimalRange.min &&
                          card.optionRange.min <= optimalRange.max) ||
                        (card.optionRange.max >= optimalRange.min &&
                          card.optionRange.max <= optimalRange.max)
                      : false;
                  const volValue = card.analysisMetrics?.volatility ?? null;
                  const distValue = card.analysisMetrics?.distanceToMA20 ?? null;
                  const tags: string[] = [];
                  if (card.latestSignal?.strategyId === 'strategy1_trend_change_1h_15m') {
                    tags.push('Trend');
                  }
                  if (
                    card.latestSignal?.strategyId ===
                      'strategy3_open_gap_fade_lowvol_15m_1m' ||
                    card.latestSignal?.strategyId ===
                      'strategy5_lateral_open_outside_bollinger_no_vol' ||
                    card.latestSignal?.strategyId ===
                      'ct15_open_gap_trendline_midline_volatility_15m'
                  ) {
                    tags.push('Gap');
                  }
                  if (
                    card.latestSignal?.strategyId ===
                    'ct15_open_gap_trendline_midline_volatility_15m'
                  ) {
                    tags.push('CT15');
                  }
                  if (
                    card.latestSignal?.strategyId ===
                      'strategy2_midline_bounce_1d_1h_15m' ||
                    card.latestSignal?.strategyId ===
                      'strategy4_magnet_effect_gap_far_from_ma20_15m'
                  ) {
                    tags.push('Mean-revert');
                  }
                  if (volValue !== null && volValue > 0.02) {
                    tags.push('High Vol');
                  } else if (volValue !== null && volValue < 0.008) {
                    tags.push('Low Vol');
                  }
                  if (distValue !== null && distValue > 0.02) {
                    tags.push('Far MA20');
                  }
                  return (
                    <Box
                      key={card.symbol}
                      onClick={() => onSelectSymbol(card.symbol)}
                    sx={{
                      position: 'relative',
                      border: '1px solid rgba(255,255,255,0.08)',
                      backgroundColor: '#0f131b',
                      boxShadow: signalToday ? '0 0 0 2px rgba(57, 217, 138, 0.6) inset' : 'none',
                      cursor: 'pointer',
                      transition: 'background-color 120ms ease',
                      padding: '12px',
                        overflow: 'hidden',
                        '&:hover': {
                          backgroundColor: 'rgba(255,255,255,0.04)',
                        },
                      }}
                    >
                      <Box
                        sx={{
                          position: 'absolute',
                          inset: 0,
                          opacity: 0.35,
                          pointerEvents: 'none',
                        }}
                      >
                        {renderSparklineCandles(card.sparklineBars)}
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                        <Box>
                          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                            {card.symbol}
                          </Typography>
                          <Typography
                            sx={{ fontSize: 11, color: '#c2c7d0', opacity: 0.8 }}
                          >
                            {name}
                          </Typography>
                        </Box>
                        <Box sx={{ textAlign: 'right' }}>
                          <Typography
                            sx={{
                              fontSize: 16,
                              fontWeight: 600,
                              color:
                                card.latestPrice !== null &&
                                card.prevClose !== null &&
                                card.latestPrice - card.prevClose >= 0
                                  ? '#39d98a'
                                  : '#ff6b6b',
                            }}
                          >
                            {card.latestPrice !== null
                              ? card.latestPrice.toFixed(2)
                              : '—'}
                          </Typography>
                          <Typography sx={{ fontSize: 11, color: '#7c8190' }}>
                            {card.prevClose !== null
                              ? card.prevClose.toFixed(2)
                              : '—'}
                          </Typography>
                        {signalToday && (
                          <Box
                              sx={{
                                marginTop: 0.5,
                                paddingX: 0.75,
                                paddingY: 0.25,
                                borderRadius: 6,
                                backgroundColor: 'rgba(57, 217, 138, 0.2)',
                                fontSize: 10,
                                color: '#39d98a',
                                display: 'inline-block',
                              }}
                          >
                            Today
                          </Box>
                        )}
                        {earningsToday && (
                          <Box
                            sx={{
                              marginTop: 0.5,
                              paddingX: 0.75,
                              paddingY: 0.25,
                              borderRadius: 6,
                              backgroundColor: 'rgba(255, 193, 7, 0.18)',
                              fontSize: 10,
                              color: '#ffc107',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 0.5,
                            }}
                          >
                            <WarningAmberIcon sx={{ fontSize: 12 }} />
                            Earnings Today
                          </Box>
                        )}
                        </Box>
                      </Box>
                      <Box sx={{ marginTop: 1 }}>
                        {card.loading ? (
                          <CircularProgress size={16} />
                        ) : (
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <Typography
                              sx={{
                                fontSize: 11,
                                color: card.latestSignal?.direction === 'CALL'
                                  ? '#39d98a'
                                  : card.latestSignal?.direction === 'PUT'
                                    ? '#ff6b6b'
                                    : '#7c8190',
                                fontWeight: 600,
                              }}
                            >
                              {card.latestSignal?.direction
                                ? `Signal: ${card.latestSignal.direction}`
                                : 'No signal'}
                            </Typography>
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                {optionWithinOptimal && (
                                  <CheckCircleIcon sx={{ fontSize: 12, color: '#39d98a' }} />
                                )}
                                <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                                  {card.optionRange
                                    ? `Opt $${card.optionRange.min.toFixed(2)}-$${card.optionRange.max.toFixed(
                                        2
                                      )}`
                                    : 'Opt --'}
                                </Typography>
                              </Box>
                              <Typography sx={{ fontSize: 10, color: '#9aa0a6' }}>
                                {optimalRange
                                  ? `Optimal $${optimalRange.min} - $${optimalRange.max}`
                                  : 'Optimal --'}
                              </Typography>
                            </Box>
                          </Box>
                        )}
                      </Box>
                      {tags.length > 0 && (
                        <Box sx={{ marginTop: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {tags.slice(0, 3).map((tag) => (
                            <Box
                              key={tag}
                              sx={{
                                paddingX: 0.75,
                                paddingY: 0.25,
                                borderRadius: 6,
                                backgroundColor: 'rgba(255,255,255,0.06)',
                                fontSize: 10,
                                color: '#9aa0a6',
                              }}
                            >
                              {tag}
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
          );
        })}
          </>
        )}
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
        open={scanResultsOpen}
        onClose={() => setScanResultsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Scan Results</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {!scanResults && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              No scan data yet.
            </Typography>
          )}
          {scanResults && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                {scanResults.title}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Scan time</Typography>
                <Typography sx={{ fontSize: 12 }}>
                  {(scanResults.durationMs / 1000).toFixed(1)}s
                </Typography>
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Symbols</Typography>
                <Typography sx={{ fontSize: 12 }}>{scanResults.totalSymbols}</Typography>
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Detections</Typography>
                <Typography sx={{ fontSize: 12 }}>{scanResults.detectedSignals}</Typography>
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>Errors</Typography>
                <Typography sx={{ fontSize: 12 }}>{scanResults.errorCount}</Typography>
              </Box>
              <Divider sx={{ borderColor: '#2b2b43' }} />
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Strategy hits
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1 }}>
                {Object.entries(scanResults.strategyCounts).map(([label, count]) => (
                  <Box
                    key={label}
                    sx={{
                      border: '1px solid #2b2b43',
                      borderRadius: 1,
                      padding: '6px 8px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                    }}
                  >
                    <span>{label}</span>
                    <span>{count}</span>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScanResultsOpen(false)} sx={{ textTransform: 'none' }}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={ibMetricsOpen}
        onClose={() => setIbMetricsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>IB Gateway Metrics</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {ibMetricsQuery.isLoading && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              Loading metrics…
            </Typography>
          )}
          {ibMetricsQuery.isError && (
            <Typography sx={{ fontSize: 12, color: '#ef5350' }}>
              Failed to load metrics.
            </Typography>
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
        <DialogActions>
          <Button onClick={() => setIbMetricsOpen(false)} sx={{ textTransform: 'none' }}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}
