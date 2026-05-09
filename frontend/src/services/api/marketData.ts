/**
 * Market data API client
 */
import axios from 'axios';
import { HistoricalDataResponse, Interval } from '@/types/chart.types';

// Dynamic API URL detection for Tailscale/remote access
function getApiBaseUrl(): string {
  // If VITE_API_URL is explicitly set, use it
  if (import.meta.env.VITE_API_URL) {
    console.log('[API] Using VITE_API_URL:', import.meta.env.VITE_API_URL);
    return import.meta.env.VITE_API_URL;
  }

  // For remote access via Tailscale, use the same host as the frontend
  // but change port from 3000 to 8000
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;

    // If accessing via Tailscale IP or non-localhost, use same host with port 8000
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const apiUrl = `${protocol}//${hostname}:8000`;
      console.log('[API] Detected remote access from', hostname, '→ using API URL:', apiUrl);
      return apiUrl;
    }
  }

  // Default to localhost for development
  console.log('[API] Using localhost API URL');
  return 'http://localhost:8000';
}

export const API_BASE_URL = getApiBaseUrl();
console.log('[API] Final API_BASE_URL:', API_BASE_URL);
const API_V1_PREFIX = '/api/v1';

const apiClient = axios.create({
  baseURL: `${API_BASE_URL}${API_V1_PREFIX}`,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Fetch historical OHLCV data
 */
export async function fetchHistoricalData(
  symbol: string,
  interval: Interval,
  barsCount: number = 500,
  conId?: number | null,
  contract?: {
    secType?: string;
    exchange?: string;
    currency?: string;
  },
  useRth: boolean = true
): Promise<HistoricalDataResponse> {
  const response = await apiClient.get<HistoricalDataResponse>(
    '/market-data/historical',
    {
      params: {
        symbol: symbol.toUpperCase(),
        interval,
        bars_count: barsCount,
        con_id: conId ?? undefined,
        sec_type: contract?.secType,
        exchange: contract?.exchange,
        currency: contract?.currency,
        use_rth: useRth,
      },
    }
  );
  return response.data;
}

/**
 * Get supported timeframes
 */
export async function fetchSupportedTimeframes(): Promise<string[]> {
  const response = await apiClient.get<string[]>('/market-data/timeframes');
  return response.data;
}

/**
 * Validate symbol
 */
export async function validateSymbol(
  symbol: string
): Promise<{ symbol: string; valid: boolean }> {
  const response = await apiClient.get('/market-data/validate-symbol', {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

/**
 * Health check
 */
export async function checkHealth(): Promise<{
  status: string;
  ib_connected: boolean;
  message?: string;
}> {
  const response = await axios.get(`${API_BASE_URL}/health`);
  return response.data;
}


export async function fetchOptionChain(symbol: string): Promise<{
  symbol: string;
  expirations: { date: string; strikes: number[] }[];
}> {
  const response = await apiClient.get('/market-data/options-chain', {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

export async function fetchOptionQuotes(
  symbol: string,
  expiration: string,
  strikes: number[]
): Promise<{
  symbol: string;
  expiration: string;
  quotes: {
    strike: number;
    right: string;
    last: number | null;
    bid: number | null;
    ask: number | null;
    oi: number | null;
    iv: number | null;
  }[];
}> {
  const response = await apiClient.get('/market-data/options-quotes', {
    params: {
      symbol: symbol.toUpperCase(),
      expiration,
      strikes: strikes.join(','),
      limit: 40,
    },
  });
  return response.data;
}

export async function fetchFinvizRecomTarget(symbol: string): Promise<{
  symbol: string;
  recom: string | null;
  target_price: string | null;
  cached_at: string | null;
}> {
  const response = await apiClient.get('/market-data/finviz-recom-target', {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

/** Live GEX analysis from IB. Always pass symbol="SPX" for institutional gamma;
 *  scale strikes ÷10 client-side if rendering on SPY. */
export interface GexLevels {
  symbol?: string;
  spot?: number;
  call_wall?: { strike: number; gex: number; distance: number };
  put_wall?: { strike: number; gex: number; distance: number };
  gamma_flip?: { strike: number | null; distance: number | null };
  regime?: 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA' | string;
  timestamp?: string;
  error?: string;
}

export async function fetchGexAnalysis(
  symbol: string = 'SPX',
  dteFilter: string = '0dte',
  strikeRange: number = 100,
): Promise<GexLevels> {
  const response = await apiClient.get('/market-data/gex-analysis', {
    params: { symbol: symbol.toUpperCase(), dte_filter: dteFilter, strike_range: strikeRange },
  });
  return response.data;
}

export async function fetchEarnings(symbol: string): Promise<{
  symbol: string;
  earnings_date: string | null;
  cached_at: string | null;
}> {
  const response = await apiClient.get('/market-data/earnings', {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

export async function fetchStrategySettings(symbol: string): Promise<{
  symbol: string;
  settings: Record<string, unknown> | null;
}> {
  const response = await apiClient.get('/market-data/strategy-settings', {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

export async function saveStrategySettings(
  symbol: string,
  settings: Record<string, unknown>
): Promise<{ symbol: string; settings: Record<string, unknown> | null }> {
  const response = await apiClient.put('/market-data/strategy-settings', settings, {
    params: { symbol: symbol.toUpperCase() },
  });
  return response.data;
}

export async function searchSymbols(query: string): Promise<{
  query: string;
  results: {
    symbol: string;
    secType: string;
    exchange: string;
    primaryExchange: string;
    currency: string;
    conId: number;
    description?: string;
  }[];
}> {
  const response = await apiClient.get('/market-data/search-symbols', {
    params: { query },
  });
  return response.data;
}

export async function fetchIbMetrics(): Promise<{
  total_requests: number;
  total_errors: number;
  in_flight: number;
  last_kind: string | null;
  last_symbol: string | null;
  last_duration_ms: number | null;
  avg_duration_ms: number | null;
  last_response_items: number | null;
  last_error: string | null;
  last_status: string | null;
  updated_at: number;
}> {
  const response = await apiClient.get('/market-data/ib-metrics');
  return response.data;
}

export async function fetchOrders(limit: number = 200): Promise<{
  orders: {
    timestamp: number;
    symbol: string;
    action: string;
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
    quantity: number;
    price: number;
    status?: string | null;
    strategy_id?: string | null;
    signal_id?: string | null;
    position_id?: string | null;
    pnl?: number | null;
    pnl_pct?: number | null;
    type?: string | null;
    entry_price?: number | null;
    target_price?: number | null;
    high_water_mark?: number | null;
    close_reason?: string | null;
    mode?: string | null;
  }[];
  open_positions: {
    timestamp: number;
    symbol: string;
    action: string;
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
    quantity: number;
    price: number;
    status?: string | null;
    strategy_id?: string | null;
    signal_id?: string | null;
    position_id?: string | null;
    pnl?: number | null;
    pnl_pct?: number | null;
    type?: string | null;
    entry_price?: number | null;
    target_price?: number | null;
    high_water_mark?: number | null;
    close_reason?: string | null;
    mode?: string | null;
  }[];
  count: number;
}> {
  const response = await apiClient.get('/market-data/trading/orders', {
    params: { limit },
  });
  return response.data;
}

export async function fetchOrdersSummary(limit: number = 2000): Promise<{
  total_pnl: number;
  daily_pnl: Record<string, number>;
}> {
  const response = await apiClient.get('/market-data/trading/orders/summary', {
    params: { limit },
  });
  return response.data;
}

export async function clearOrders(): Promise<{ ok: boolean }> {
  const response = await apiClient.post('/market-data/trading/orders/clear');
  return response.data;
}

export async function fetchIbPositions(force = false): Promise<{
  positions: {
    symbol: string;
    sec_type: string;
    local_symbol?: string | null;
    exchange?: string | null;
    currency?: string | null;
    con_id?: number | null;
    multiplier?: number | null;
    quantity: number;
    avg_cost: number;
    market_price?: number | null;
    market_value?: number | null;
    unrealized_pnl?: number | null;
    realized_pnl?: number | null;
    cost_basis?: number | null;
    pnl_pct?: number | null;
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
    days_to_expiry?: number | null;
  }[];
}> {
  const response = await apiClient.get('/market-data/trading/positions', { params: force ? { force: true } : {} });
  return response.data;
}

export async function fetchIbAccountSummary(): Promise<{
  account: string | null;
  available_funds: number | null;
  total_cash_value: number | null;
  net_liquidation: number | null;
  settle_cash: number | null;
  currency: string | null;
}> {
  const response = await apiClient.get('/market-data/trading/account-summary');
  return response.data;
}

export async function fetchIbOrdersHistory(limit: number = 200): Promise<{
  orders: {
    timestamp?: number | null;
    symbol?: string | null;
    sec_type?: string | null;
    exchange?: string | null;
    currency?: string | null;
    action?: string | null;
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
    quantity?: number | null;
    filled?: number | null;
    avg_fill_price?: number | null;
    last_fill_price?: number | null;
    status?: string | null;
    order_type?: string | null;
    limit_price?: number | null;
    aux_price?: number | null;
    order_id?: number | null;
    perm_id?: number | null;
    client_id?: number | null;
  }[];
}> {
  const response = await apiClient.get('/market-data/trading/ib-orders', {
    params: { limit },
  });
  return response.data;
}

export async function submitTradeOrder(payload: {
  symbol: string;
  expiration: string;
  strike: number;
  right: string;
  action: string;
  quantity: number;
  price: number;
  status?: string | null;
  strategy_id?: string | null;
  signal_id?: string | null;
  position_id?: string | null;
  type?: string | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  entry_price?: number | null;
  target_price?: number | null;
}): Promise<{
  timestamp: number;
  symbol: string;
  action: string;
  right?: string | null;
  expiration?: string | null;
  strike?: number | null;
  quantity: number;
  price: number;
  status?: string | null;
  strategy_id?: string | null;
  signal_id?: string | null;
  position_id?: string | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  type?: string | null;
  entry_price?: number | null;
  target_price?: number | null;
}> {
  const response = await apiClient.post('/market-data/trading/order', payload);
  return response.data;
}

export async function fetchAutoTraderStatus(): Promise<{
  running: boolean;
  interval_seconds: number;
  rth_only: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  current_symbol?: string | null;
  in_flight_symbols?: string[] | null;
  current_stage?: string | null;
  current_strategy?: string | null;
  current_started_at?: number | null;
  last_symbol?: string | null;
  current_index?: number | null;
  current_total?: number | null;
  trading_mode?: string | null;
  scan_results?: Record<string, { status: string; right?: string; strike?: number; reason?: string }> | null;
  capital_spent?: number;
  daily_realized_loss?: number;
}> {
  const response = await apiClient.get('/market-data/trading/worker/status');
  return response.data;
}

export async function fetchAutoTraderEvents(limit: number = 2000): Promise<{
  events: {
    timestamp: number;
    type: string;
    message: string;
    details?: Record<string, unknown> | null;
  }[];
}> {
  const response = await apiClient.get('/market-data/trading/worker/events', {
    params: { limit },
  });
  return response.data;
}

export async function startAutoTrader(): Promise<{
  running: boolean;
  interval_seconds: number;
  rth_only: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
}> {
  const response = await apiClient.post('/market-data/trading/worker/start');
  return response.data;
}

export async function stopAutoTrader(): Promise<{
  running: boolean;
  interval_seconds: number;
  rth_only: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
}> {
  const response = await apiClient.post('/market-data/trading/worker/stop');
  return response.data;
}

export async function closeIbPosition(payload: {
  symbol: string;
  sec_type: string;
  quantity: number;
  exchange?: string;
  currency?: string;
  expiration?: string | null;
  strike?: number | null;
  right?: string | null;
}): Promise<{
  symbol: string;
  sec_type: string;
  action: string;
  quantity: number;
  order_id?: number | null;
  status?: string | null;
}> {
  const response = await apiClient.post('/market-data/trading/close-position', payload);
  return response.data;
}

export async function closeAllIbPositions(): Promise<{
  results: { symbol: string; sec_type: string; status: string; error?: string }[];
}> {
  const response = await apiClient.post('/market-data/trading/close-all-positions');
  return response.data;
}

export async function resetCapitalSpent(): Promise<{ capital_spent: number }> {
  const response = await apiClient.post('/market-data/trading/worker/reset-capital');
  return response.data;
}

export async function flushTrackedPosition(positionId: string, closePrice?: number | null): Promise<{ ok: boolean; position_id: string }> {
  const params = closePrice != null ? `?close_price=${closePrice}` : '';
  const response = await apiClient.post(`/market-data/trading/worker/flush-position/${encodeURIComponent(positionId)}${params}`);
  return response.data;
}

export interface TradingModeResponse {
  mode: 'paper' | 'live';
  port: number;
  connected: boolean;
}

export async function fetchTradingMode(): Promise<TradingModeResponse> {
  const response = await apiClient.get('/market-data/trading/mode');
  return response.data;
}

export async function switchTradingMode(mode: 'paper' | 'live'): Promise<TradingModeResponse> {
  const response = await apiClient.post('/market-data/trading/switch-mode', { mode });
  return response.data;
}

export async function fetchAutoTraderSettings(): Promise<{
  settings: {
    enabled: boolean;
    intervalSeconds: number;
    tpCheckIntervalSeconds: number;
    rthOnly: boolean;
    profitTargetPct: number;
    maxTradesPerDay: number;
    useOptimalRange: boolean;
    skipEarningsDay: boolean;
    useMarketOrders: boolean;
    maxConcurrentPositions: number;
    onlyFavorites: boolean;
    capitalLimit: number;
    allowOpenPositions: boolean;
    allowClosePositions: boolean;
    expiryCloseTime: string;
    overrides: Record<string, any>;
    tickerSettings: Record<string, { enabled: boolean; optimalMin: number | null; optimalMax: number | null }>;
    allowCalls: boolean;
    allowPuts: boolean;
    paperAccount: string;
    liveAccount: string;
    tradingMode: 'paper' | 'live';
    positionSizing: string;
    riskPerTrade: number;
    riskPctPerTrade: number;
    maxContractsPerTrade: number;
    minContractsPerTrade: number;
    strikeWindow: number;
    filterBySpread: boolean;
    maxSpreadPct: number;
    maxSpreadDollar: number;
    preferTightSpreads: boolean;
    minDelta: number;
  };
}> {
  const response = await apiClient.get('/market-data/trading/worker/settings');
  return response.data;
}

export async function fetchTradingFavorites(): Promise<{ favorites: string[] }> {
  const response = await apiClient.get('/market-data/trading/favorites');
  return response.data;
}

export async function updateTradingFavorites(
  favorites: string[]
): Promise<{ favorites: string[] }> {
  const response = await apiClient.post('/market-data/trading/favorites', {
    favorites,
  });
  return response.data;
}

export async function saveAutoTraderSettings(payload: {
  enabled: boolean;
  intervalSeconds: number;
  rthOnly: boolean;
  profitTargetPct: number;
  useTrailingStop?: boolean;
  trailingStopPct?: number;
  maxTradesPerDay: number;
  useOptimalRange: boolean;
  skipEarningsDay: boolean;
  useMarketOrders: boolean;
  maxConcurrentPositions: number;
  onlyFavorites?: boolean;
  capitalLimit?: number;
  allowOpenPositions: boolean;
  allowClosePositions: boolean;
  expiryCloseTime?: string;
  overrides?: Record<string, any>;
  tickerSettings?: Record<string, { enabled: boolean; optimalMin: number | null; optimalMax: number | null }>;
  allowCalls?: boolean;
  allowPuts?: boolean;
  paperAccount?: string;
  liveAccount?: string;
  tradingMode?: 'paper' | 'live';
  positionSizing?: string;
  riskPerTrade?: number;
  riskPctPerTrade?: number;
  maxContractsPerTrade?: number;
  minContractsPerTrade?: number;
  strikeWindow?: number;
  filterBySpread?: boolean;
  maxSpreadPct?: number;
  maxSpreadDollar?: number;
  preferTightSpreads?: boolean;
  minDelta?: number;
  strategySettings?: Record<string, Record<string, any>>;
}): Promise<{
  settings: {
    enabled: boolean;
    intervalSeconds: number;
    tpCheckIntervalSeconds: number;
    rthOnly: boolean;
    profitTargetPct: number;
    useTrailingStop?: boolean;
    trailingStopPct?: number;
    maxTradesPerDay: number;
    useOptimalRange: boolean;
    skipEarningsDay: boolean;
    useMarketOrders: boolean;
    maxConcurrentPositions: number;
    onlyFavorites: boolean;
    capitalLimit: number;
    allowOpenPositions: boolean;
    allowClosePositions: boolean;
    expiryCloseTime: string;
    overrides: Record<string, any>;
    tickerSettings: Record<string, { enabled: boolean; optimalMin: number | null; optimalMax: number | null }>;
    allowCalls: boolean;
    allowPuts: boolean;
    paperAccount: string;
    liveAccount: string;
    tradingMode: 'paper' | 'live';
    positionSizing: string;
    riskPerTrade: number;
    riskPctPerTrade: number;
    maxContractsPerTrade: number;
    minContractsPerTrade: number;
    strikeWindow: number;
    filterBySpread: boolean;
    maxSpreadPct: number;
    maxSpreadDollar: number;
    preferTightSpreads: boolean;
    minDelta: number;
    strategySettings: Record<string, Record<string, any>>;
  };
}> {
  const response = await apiClient.post('/market-data/trading/worker/settings', payload);
  return response.data;
}

export interface TickerPostExitStat {
  symbol: string;
  sample: number;
  avg_left_pct: number;
  p25_left_pct: number;
  p50_left_pct: number;
  p75_left_pct: number;
  avg_mins_to_peak: number;
  avg_hold_min: number | null;
  avg_stock_price: number | null;
  avg_option_entry: number | null;
  avg_delta: number | null;
  delta_estimated: boolean;
  avg_leverage: number | null;
  current_tp_pct: number | null;
  suggested_tp_pct: number | null;
}

export interface TickerTpStat {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  expected_value: number | null;
  breakeven_wr: number | null;
  margin_of_safety: number | null;
  current_tp_pct: number | null;
}

export interface StrategyAgg {
  trades: number;
  pnl: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_return: number | null;
  avg_hold: number | null;
}

export interface StrategyReportResponse {
  date_range: { start: string | null; end: string | null };
  overview: {
    sessions: number;
    completed_trades: number;
    total_pnl: number;
    win_rate: number | null;
    winners: number;
    losers: number;
  };
  open_positions_detail: {
    position_id: string | null;
    symbol: string;
    right: string | null;
    strike: number | null;
    expiration: string | null;
    price: number | null;
    quantity: number;
    strategy_id: string | null;
    timestamp: number | null;
    target_price: number | null;
    mode: string | null;
    // activity enrichment
    signal_id: string;
    check_count: number;
    last_check_ts: number | null;
    last_premium: number | null;
    last_target: number | null;
    pct_to_tp: number | null;
    max_premium: number | null;
    max_pct_gain: number | null;
    max_pct_to_tp: number | null;
    status_reason: 'tp_not_reached' | 'close_order_cancelled' | 'close_retry_pending' | 'worker_stopped' | 'no_data';
    close_attempts: number;
    key_events: { type: string; time_et: string | null; message: string }[];
    price_bars: { time: number; price: number }[];
  }[];
  open_tp_analysis: {
    total_positions: number;
    current_tp_pct: number;
    avg_max_gain: number;
    capture_rates: { tp_pct: number; captured: number; rate: number }[];
    recommended_tp: number;
    positions_detail: {
      symbol: string;
      entry: number;
      target: number;
      max_premium: number;
      max_pct_gain: number;
    }[];
  };
  sessions: {
    date_key: string;
    date_label: string;
    trades: number;
    pnl: number;
    win_rate: number | null;
    wins: number;
    losses: number;
    capital_deployed?: number;
  }[];
  strategy_keys: string[];
  strategies: Record<string, StrategyAgg & {
    name: string;
    by_hour: (StrategyAgg & { hour: string; tickers: string[] })[];
    trade_list: {
      win: boolean;
      symbol: string;
      right: string | null;
      close_time: string;
      date: string;
      pnl: number;
      pnl_pct: number | null;
      hold_min: number;
    }[];
  }>;
  cross_hour: Record<string, Record<string, StrategyAgg> & { total: StrategyAgg }>;
  cross_hour_opens: Record<string, Record<string, number>>;
  ticker_summary: (StrategyAgg & {
    symbol: string;
    calls: StrategyAgg | null;
    puts: StrategyAgg | null;
  })[];
  best_trades: {
    win: boolean;
    symbol: string;
    right: string | null;
    date: string;
    pnl: number;
    pnl_pct: number | null;
    hold_min: number;
    strategy: string;
    close_time: string;
  }[];
  worst_trades: {
    win: boolean;
    symbol: string;
    right: string | null;
    date: string;
    pnl: number;
    pnl_pct: number | null;
    hold_min: number;
    strategy: string;
    close_time: string;
  }[];
  calls_puts: {
    calls: StrategyAgg;
    puts: StrategyAgg;
    by_hour: { hour: string; calls: StrategyAgg | null; puts: StrategyAgg | null }[];
    by_strategy: { strategy: string; calls: StrategyAgg | null; puts: StrategyAgg | null }[];
    by_ticker: { symbol: string; calls: StrategyAgg | null; puts: StrategyAgg | null }[];
  };
  signal_stats: {
    total_evaluated: number;
    total_acted_on: number;
    total_skipped: number;
    conversion_rate: number | null;
    skip_reasons: Record<string, number>;
    by_strategy: Record<string, {
      evaluated: number;
      acted_on: number;
      skipped: number;
      conversion_rate: number | null;
      skip_reasons: Record<string, number>;
    }>;
    by_ticker: { symbol: string; total: number; top_reason: string; reasons: Record<string, number> }[];
    by_hour: { hour: string; skipped: number }[];
    entries: {
      timestamp: number | null;
      time_et: string | null;
      symbol: string;
      direction: string | null;
      strategy: string;
      reason_code: string;
      stage: string | null;
      latest_price: number | null;
      nearest_strike: number | null;
      min_premium: number | null;
      max_premium: number | null;
      range_reason: string | null;
      range_diff_pct: number | null;
      candidate_count: number | null;
      quote_count: number | null;
    }[];
  };
  iv_mfe_mae: {
    by_strategy: Record<string, {
      avg_delta_entry: number | null;
      avg_iv_entry: number | null;
      avg_iv_exit: number | null;
      avg_iv_crush: number | null;
      avg_mfe_pct: number | null;
      avg_mae_pct: number | null;
      iv_entry_count: number;
      mfe_count: number;
      delta_count: number;
    }>;
  };
  market_context: {
    by_spy_direction: Record<string, StrategyAgg>;
    days_with_context: number;
  };
  ticker_tp_analysis: TickerTpStat[];
  capital_timeline: {
    rows: ({
      bucket: string;
      capital: number;
      opens: number;
      cumulative_capital: number;
      pnl: number;
      closes: number;
      cumulative_pnl: number;
    } & Record<string, number>)[];
    date_keys: string[];
  };
  post_exit_opportunity: TickerPostExitStat[];
  post_exit_debug: {
    winning_trades?: number;
    unique_sym_dates?: number;
    sym_dates_with_bars?: number;
    trades_with_ref_bar?: number;
    trades_with_post_bars?: number;
    trades_with_positive_move?: number;
    delta_fallback?: number | null;
    delta_real_count?: number;
    errors?: string[];
  };
}

export async function fetchStrategyReport(
  startDate?: string,
  endDate?: string
): Promise<StrategyReportResponse> {
  const response = await apiClient.get('/market-data/strategy-report', {
    params: {
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    },
    timeout: 120000, // 2 minutes for strategy report (can be slow for large date ranges)
  });
  return response.data;
}

export async function fetchPostExitOpportunity(
  startDate?: string,
  endDate?: string
): Promise<Pick<StrategyReportResponse, 'post_exit_opportunity' | 'post_exit_debug'>> {
  const response = await apiClient.get('/market-data/strategy-report', {
    params: {
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      include_post_exit: true,
    },
    timeout: 300000, // 5 minutes — many sequential IB calls
  });
  return {
    post_exit_opportunity: response.data.post_exit_opportunity,
    post_exit_debug: response.data.post_exit_debug,
  };
}

// Position TP Overrides
export async function fetchPositionTpOverrides(): Promise<{ overrides: Record<string, any> }> {
  const response = await apiClient.get('/market-data/trading/position-tp-overrides');
  return response.data;
}

export async function setPositionTpOverride(
  signalId: string,
  settings: {
    profitTargetPct: number;
    useTrailingStop?: boolean;
    trailingStopPct?: number;
  }
): Promise<{ signal_id: string; override: any }> {
  const response = await apiClient.post(
    `/market-data/trading/position-tp-override/${encodeURIComponent(signalId)}`,
    settings
  );
  return response.data;
}

export async function deletePositionTpOverride(signalId: string): Promise<{ signal_id: string; deleted: boolean }> {
  const response = await apiClient.delete(
    `/market-data/trading/position-tp-override/${encodeURIComponent(signalId)}`
  );
  return response.data;
}

/**
 * Fetch backtest data for a specific symbol and date
 */
export async function fetchBacktest(
  symbol: string,
  date: string,
  lookbackDays: number = 10,
  enabledStrategies?: number[]
): Promise<import('@/types/chart.types').BacktestResponse> {
  const response = await apiClient.get('/market-data/backtest', {
    params: {
      symbol: symbol.toUpperCase(),
      date,
      lookback_days: lookbackDays,
      ...(enabledStrategies && { enabled_strategies: enabledStrategies.join(',') }),
    },
    timeout: 120000, // 2 minutes (fetching multiple intervals can be slow)
  });
  return response.data;
}

/**
 * Fetch multi-day backtest range analysis
 */
export async function fetchBacktestRange(
  symbol: string,
  startDate: string,
  endDate: string,
  lookbackDays: number = 10
): Promise<import('@/types/chart.types').BacktestRangeResponse> {
  const response = await apiClient.get('/market-data/backtest-range', {
    params: {
      symbol: symbol.toUpperCase(),
      start_date: startDate,
      end_date: endDate,
      lookback_days: lookbackDays,
    },
    timeout: 600000, // 10 minutes (multi-day analysis can be very slow)
  });
  return response.data;
}
