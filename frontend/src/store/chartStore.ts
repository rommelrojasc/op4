/**
 * Zustand store for chart state management
 */
import { create } from 'zustand';
import { Bar, Interval } from '@/types/chart.types';
import { StrategySignal } from '@/types/strategy';
import { StrategySettings } from '@/analysis/strategyDefaults';

const FAVORITES_KEY = 'op2.favorites';
const loadFavorites = () => {
  if (typeof window === 'undefined') return [] as string[];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const persistFavorites = (favorites: string[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // ignore storage errors
  }
};

interface ChartStore {
  // State
  symbol: string;
  selectedContract: {
    symbol: string;
    conId: number;
    secType: string;
    exchange: string;
  } | null;
  interval: Interval;
  useRth: boolean;
  bars: Bar[];
  loading: boolean;
  error: string | null;
  hoverBar: Bar | null;
  hoverPoint: { x: number; y: number } | null;
  visibleRange: { from: number; to: number } | null;
  strategySignals: StrategySignal[];
  selectedSignalId: string | null;
  signalClickPosition: { x: number; y: number } | null;
  isAnalyzing: boolean;
  strategyPanelOpen: boolean;
  strategyPanelWidth: number;
  optionsPanelOpen: boolean;
  optionsPanelWidth: number;
  analysisTargetMode: boolean;
  barAnalysis: {
    time: number;
    strategies: {
      id: string;
      name: string;
      conditions: { label: string; pass: boolean }[];
      matched: boolean;
    }[];
  } | null;
  barAnalysisLoading: boolean;
  lastAnalysis: { durationMs: number; count: number } | null;
  outcomeHorizonBars: number;
  analysisContext: {
    symbol: string;
    visibleRange: { from: number; to: number };
    bars1h: Bar[];
    bars15m: Bar[];
    bars1d: Bar[];
    bars1m: Bar[];
  } | null;
  showMA20: boolean;
  showMA40: boolean;
  showMA100: boolean;
  showMA200: boolean;
  showVWAP: boolean;
  showBollinger: boolean;
  showVolume: boolean;
  showWorden: boolean;
  favorites: string[];
  srLevels: { support: number[]; resistance: number[] } | null;
  strategySettingsBySymbol: Record<string, StrategySettings>;

  // Actions
  setSymbol: (symbol: string) => void;
  setSelectedContract: (value: {
    symbol: string;
    conId: number;
    secType: string;
    exchange: string;
  } | null) => void;
  setInterval: (interval: Interval) => void;
  setUseRth: (value: boolean) => void;
  setBars: (bars: Bar[]) => void;
  addBar: (bar: Bar) => void;
  updateLastBar: (bar: Bar) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setIndicator: (key: keyof IndicatorState, value: boolean) => void;
  setHoverBar: (bar: Bar | null) => void;
  setHoverPoint: (point: { x: number; y: number } | null) => void;
  setVisibleRange: (range: { from: number; to: number } | null) => void;
  setStrategySignals: (signals: StrategySignal[]) => void;
  setSelectedSignalId: (id: string | null) => void;
  setSignalClickPosition: (pos: { x: number; y: number } | null) => void;
  setIsAnalyzing: (value: boolean) => void;
  setStrategyPanelOpen: (open: boolean) => void;
  setStrategyPanelWidth: (value: number) => void;
  setOptionsPanelOpen: (open: boolean) => void;
  setOptionsPanelWidth: (value: number) => void;
  setAnalysisTargetMode: (value: boolean) => void;
  setBarAnalysis: (
    value: {
      time: number;
      strategies: {
        id: string;
        name: string;
        conditions: { label: string; pass: boolean }[];
        matched: boolean;
      }[];
    } | null
  ) => void;
  setBarAnalysisLoading: (value: boolean) => void;
  setLastAnalysis: (value: { durationMs: number; count: number } | null) => void;
  setOutcomeHorizonBars: (value: number) => void;
  setAnalysisContext: (value: {
    symbol: string;
    visibleRange: { from: number; to: number };
    bars1h: Bar[];
    bars15m: Bar[];
    bars1d: Bar[];
    bars1m: Bar[];
  } | null) => void;
  toggleFavorite: (symbol: string) => void;
  setSrLevels: (levels: { support: number[]; resistance: number[] } | null) => void;
  setStrategySettingsForSymbol: (symbol: string, settings: StrategySettings) => void;
  reset: () => void;
}

interface IndicatorState {
  showMA20: boolean;
  showMA40: boolean;
  showMA100: boolean;
  showMA200: boolean;
  showVWAP: boolean;
  showBollinger: boolean;
  showVolume: boolean;
  showWorden: boolean;
}

const initialState = {
  symbol: 'SPY',
  selectedContract: null,
  interval: '1d' as Interval,
  useRth: true,
  bars: [],
  loading: false,
  error: null,
  hoverBar: null,
  hoverPoint: null,
  visibleRange: null,
  strategySignals: [],
  selectedSignalId: null,
  signalClickPosition: null,
  isAnalyzing: false,
  strategyPanelOpen: false,
  strategyPanelWidth: 360,
  optionsPanelOpen: false,
  optionsPanelWidth: 320,
  analysisTargetMode: false,
  barAnalysis: null,
  barAnalysisLoading: false,
  lastAnalysis: null,
  outcomeHorizonBars: 8,
  analysisContext: null,
  showMA20: false,
  showMA40: false,
  showMA100: false,
  showMA200: false,
  showVWAP: false,
  showBollinger: false,
  showVolume: false,
  showWorden: false,
  favorites: loadFavorites(),
  srLevels: null,
  strategySettingsBySymbol: {},
};

export const useChartStore = create<ChartStore>((set) => ({
  ...initialState,

  setSymbol: (symbol) =>
    set({
      symbol: symbol.toUpperCase(),
      bars: [],
      error: null,
      strategySignals: [],
      selectedSignalId: null,
      signalClickPosition: null,
      strategyPanelOpen: false,
      analysisContext: null,
      selectedContract: null,
    }),
  setSelectedContract: (value) => set({ selectedContract: value }),

  setInterval: (interval) =>
    set((state) => ({
      interval,
      bars: [],
      error: null,
      showMA20: interval === '15m' ? true : state.showMA20,
      showBollinger: interval === '15m' ? true : state.showBollinger,
    })),
  setUseRth: (value) => set({ useRth: value }),

  setBars: (bars) =>
    set({
      bars,
      loading: false,
      error: null,
    }),

  addBar: (bar) =>
    set((state) => ({
      bars: [...state.bars, bar],
    })),

  updateLastBar: (bar) =>
    set((state) => {
      if (state.bars.length === 0) {
        return { bars: [bar] };
      }
      const bars = [...state.bars];
      bars[bars.length - 1] = bar;
      return { bars };
    }),

  setLoading: (loading) => set({ loading }),

  setError: (error) =>
    set({
      error,
      loading: false,
    }),

  // Zustand's set() merges automatically — no need to spread full state
  setIndicator: (key, value) => set({ [key]: value }),

  setHoverBar: (bar) => set({ hoverBar: bar }),
  setHoverPoint: (point) => set({ hoverPoint: point }),
  setVisibleRange: (range) => set({ visibleRange: range }),
  setStrategySignals: (signals) => set({ strategySignals: signals }),
  setSelectedSignalId: (id) => set({ selectedSignalId: id }),
  setSignalClickPosition: (pos) => set({ signalClickPosition: pos }),
  setIsAnalyzing: (value) => set({ isAnalyzing: value }),
  setStrategyPanelOpen: (open) => set({ strategyPanelOpen: open }),
  setStrategyPanelWidth: (value) => set({ strategyPanelWidth: value }),
  setOptionsPanelOpen: (open) => set({ optionsPanelOpen: open }),
  setOptionsPanelWidth: (value) => set({ optionsPanelWidth: value }),
  setAnalysisTargetMode: (value) => set({ analysisTargetMode: value }),
  setBarAnalysis: (value) => set({ barAnalysis: value }),
  setBarAnalysisLoading: (value) => set({ barAnalysisLoading: value }),
  setLastAnalysis: (value) => set({ lastAnalysis: value }),
  setOutcomeHorizonBars: (value) => set({ outcomeHorizonBars: value }),
  setAnalysisContext: (value) => set({ analysisContext: value }),
  setSrLevels: (levels) => set({ srLevels: levels }),
  toggleFavorite: (symbol) =>
    set((state) => {
      const normalized = symbol.toUpperCase();
      const exists = state.favorites.includes(normalized);
      const favorites = exists
        ? state.favorites.filter((item) => item !== normalized)
        : [...state.favorites, normalized];
      persistFavorites(favorites);
      return { favorites };
    }),
  setStrategySettingsForSymbol: (symbol, settings) =>
    set((state) => ({
      strategySettingsBySymbol: {
        ...state.strategySettingsBySymbol,
        [symbol]: settings,
      },
    })),

  reset: () => set(initialState),
}));
