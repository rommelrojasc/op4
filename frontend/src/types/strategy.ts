export type StrategyDirection = 'CALL' | 'PUT';

export interface StrategySignal {
  id: string;
  symbol: string;
  strategyId:
    | 'strategy-1'
    | 'strategy2_midline_bounce_1d_1h_15m'
    | 'strategy3_open_gap_fade_lowvol_15m_1m'
    | 'strategy4_magnet_effect_gap_far_from_ma20_15m'
    | 'strategy5_lateral_open_outside_bollinger_no_vol'
    | 'ct15_open_gap_trendline_midline_volatility_15m'
    | 'ct_open_squeeze_breakout_15m_1m';
  direction: StrategyDirection;
  entryTime: number; // epoch seconds
  anchorTime1H: number; // epoch seconds
  reasons: string[];
  debug: {
    anchor1H: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      ma20: number;
      ma40: number;
      slopeMa20: number;
      prevTrendChecks: string[];
    };
    confirm15M: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      ma20?: number;
      stochK?: number;
      stochD?: number;
      rule: 'ma20' | 'stoch' | 'open';
    };
    params: Record<string, unknown>;
    strategy2?: {
      ma20_1d?: number;
      ma40_1d?: number;
      slope_ma20_1d?: number;
      touchPct: number;
      w1h: number;
      w15m: number;
      cooldownHours: number;
      touchCandle1H: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        distancePct: number;
      };
      confirmCandle1H: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        closedBeyondTouch: boolean;
        closedBeyondMidline: boolean;
      };
      entryCandle15M: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        ma20?: number;
        stochK?: number;
        stochD?: number;
        rule: 'ma20' | 'stoch';
      };
    };
    strategy3?: {
      dayKey: string;
      priorClose: number;
      open1m: number;
      gapPct: number;
      bbUpper15m: number;
      bbMid15m: number;
      bbLower15m: number;
      bbBandwidth15m: number;
      percentile: number;
      entryCandle1m: {
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        triggerRule: 'A' | 'B';
      };
      params: {
        minGapPct: number;
        entryWindowMinutes: number;
        tightLookback: number;
        tightPercentile: number;
        bandOutsideTol: number;
        maxSignalsPerDay: number;
      };
    };
    strategy4?: {
      trend1h: {
        slope_ma20_1h: number;
        ma20_1h: number | null;
        ma40_1h: number | null;
        closes_below_ma40: boolean[];
        closes_above_ma40: boolean[];
      };
      stretch15m: {
        time: number;
        close: number;
        ma20: number | null;
        distPct: number;
        bbUpper: number | null;
        bbLower: number | null;
      };
      earlyExtension: {
        firstOutsideTime: number | null;
        direction: 'upper' | 'lower' | null;
      };
      confirmation: {
        time: number | null;
        rule: 'stoch';
        stochK?: number | null;
        stochD?: number | null;
      };
      params: {
        minDistFromMA20Pct: number;
        firstBarWindow: number;
        confirmWindow: number;
        cooldownHours: number;
      };
    };
    strategy5?: {
      dayKey: string;
      priorClose: number | null;
      open1m: number | null;
      gapPct: number | null;
      bbUpper15m: number | null;
      bbMid15m: number | null;
      bbLower15m: number | null;
      bbBandwidth15m: number | null;
      percentile: number | null;
      midlineSlope: number | null;
      entryCandle1m: {
        time: number | null;
        open: number | null;
        high: number | null;
        low: number | null;
        close: number | null;
        volume: number | null;
        triggerRule: 'A' | 'B' | null;
      };
      params: {
        minGapPct: number;
        entryWindowMinutes: number;
        tightLookback: number;
        tightPercentile: number;
        bandOutsideTol: number;
        maxSignalsPerDay: number;
        flatMidlineLookback: number;
        flatMidlineEpsilon: number;
      };
    };
    ct15?: {
      dayKey: string;
      priorClose: number;
      openBar0: number;
      gapPct: number;
      regression: { a: number; b: number; trendlineLevelAtOpen: number; source: string };
      priorDayLastMid: number;
      bbMid15m: number;
      bbUpper15m: number;
      bbLower15m: number;
      bandwidth: number;
      bandwidthSma: number;
      bandwidthSlope: number;
      volOpen: boolean;
      exposed: boolean;
    };
    ct_open?: {
      dayKey: string;
      bbUpper15m: number;
      bbMid15m: number;
      bbLower15m: number;
      bandwidth: number;
      squeezePercentile: number;
      priceAtOpen: number;
      insideBands: boolean;
      entryBar1m: {
        time: number;
        close: number;
      } | null;
      breakDirection: string | null;
    };
    outcome?: {
      horizonBars: number;
      barsAvailable: number;
      entryPrice: number;
      endPrice?: number;
      endReturnPct?: number;
      maxFavorablePct?: number;
      maxAdversePct?: number;
      horizonReturnsPct?: number[];
      success?: boolean;
      notes?: string;
    };
  };
}
