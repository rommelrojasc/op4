/**
 * Chart-related TypeScript types
 */

export interface Bar {
  time: number; // Unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoricalDataResponse {
  symbol: string;
  interval: string;
  bars: Bar[];
  count: number;
}

export type Interval = '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface ChartState {
  symbol: string;
  interval: Interval;
  bars: Bar[];
  loading: boolean;
  error: string | null;
}

export interface StrategySignal {
  id: string;
  symbol: string;
  strategy_id: string;
  direction: 'CALL' | 'PUT';
  entry_time: number;
  anchor_time?: number | null;
  chop_filtered?: boolean;
  chop_reason?: string | null;
  adx?: number | null;
  di_gap?: number | null;
}

export interface BacktestResponse {
  symbol: string;
  date: string;
  actual_date?: string;
  bars: {
    '1d': Bar[];
    '1h': Bar[];
    '15m': Bar[];
    '5m': Bar[];
    '1m': Bar[];
  };
  signals: StrategySignal[];
  date_range: {
    start: number;
    end: number;
  };
  sr_levels?: {
    support: number[];
    resistance: number[];
  };
}

export interface BacktestRangeStrategy {
  name: string;
  total: number;
  calls: number;
  puts: number;
  by_session: { open: number; midday: number; close: number };
  avg_mfe_pct: number | null;
  avg_mae_pct: number | null;
  median_mfe_pct: number | null;
  median_mae_pct: number | null;
}

export interface BacktestRangeSessionRow {
  strategy_id: string;
  name: string;
  hours: Record<string, number>;
  total: number;
}

export interface BacktestRangeDaySummary {
  date: string;
  signal_count: number;
  choppiness_avg: number | null;
  regime: string | null;
  has_data: boolean;
}

export interface BacktestRangeDistributionBucket {
  label: string;
  count: number;
}

export interface BacktestRangeSignalDetail {
  date: string;
  strategy_id: string;
  direction: string;
  entry_time: number;
  session: string;
  mfe_pct: number | null;
  mae_pct: number | null;
}

export interface BacktestRangeResponse {
  symbol: string;
  start_date: string;
  end_date: string;
  trading_days_requested: number;
  trading_days_with_data: number;
  total_signals: number;
  strategies: Record<string, BacktestRangeStrategy>;
  session_matrix: BacktestRangeSessionRow[];
  days: BacktestRangeDaySummary[];
  choppiness: {
    avg_ci: number | null;
    trending_days: number;
    choppy_days: number;
    mixed_days: number;
    total_days: number;
  };
  trailing_stop_analysis: {
    total_signals_with_data: number;
    avg_mfe_pct: number | null;
    median_mfe_pct: number | null;
    p25_mfe_pct: number | null;
    p75_mfe_pct: number | null;
    avg_mae_pct: number | null;
    median_mae_pct: number | null;
    p25_mae_pct: number | null;
    p75_mae_pct: number | null;
    mfe_distribution: BacktestRangeDistributionBucket[];
    mae_distribution: BacktestRangeDistributionBucket[];
  };
  signals_detail: BacktestRangeSignalDetail[];
  bars_15m: Bar[];
}

export interface CrossSymbolSignalDetail {
  symbol: string;
  date: string;
  strategy_id: string;
  direction: 'CALL' | 'PUT';
  entry_time: number;
  session: string;
  mfe_pct: number | null;
  mae_pct: number | null;
}

export interface BacktestCrossSymbolResponse {
  symbols: string[];
  start_date: string;
  end_date: string;
  total_signals: number;
  signals_detail: CrossSymbolSignalDetail[];
}
