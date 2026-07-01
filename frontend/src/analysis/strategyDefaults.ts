export type StrategySettings = {
  global: {
    warmup: number;
    minBars1h: number;
    minBars15m: number;
    minBars1d: number;
    minBars1m: number;
    successThresholdPct: number;
  };
  strategy1: {
    window15m: number;
    cooldownHours: number;
    trendLookback: number;
  };
  strategy2: {
    dailyTrendLookback: number;
    touchPct: number;
    window1h: number;
    window15m: number;
    cooldownHours: number;
  };
  strategy3: {
    minGapPct: number;
    tightLookback: number;
    tightPercentile: number;
    bandOutsideTol: number;
    entryWindowMinutes: number;
    maxSignalsPerDay: number;
  };
  strategy4: {
    minDistPct: number;
    firstBarWindow: number;
    confirmWindow: number;
    cooldownHours: number;
  };
  strategy5: {
    minGapPct: number;
    tightLookback: number;
    tightPercentile: number;
    bandOutsideTol: number;
    maxSignalsPerDay: number;
    flatLookback: number;
    flatEpsilon: number;
    entryWindowMinutes: number;
  };
  ct15: {
    minGapPct: number;
    bwSlopeLookback: number;
    bwAvgRatio: number;
    maxSignalsPerDay: number;
    strictExposedMode: boolean;
  };
  ct_open: {
    requireSqueeze: boolean;
    squeezeLookback: number;
    squeezePercentile: number;
    entryWindowMinutes: number;
    minBreakoutBars: number;
    minDisplacementPct: number;
    maxSignalsPerDay: number;
  };
  strategy7: {
    profitTargetPct: number;
    stopLossPct: number;
    maxHoldMinutes: number;
    cooldownMinutes: number;
    useTrailingStop: boolean;
    trailingStopPct: number;
    volumeSpikePct: number;
    minConsecutiveBars: number;
  };
  strategy8: {
    profitTargetPct: number;
    stopLossPct: number;
    useTrailingStop: boolean;
    trailingStopPct: number;
    trailingActivationPct: number;
    cooldownMinutes: number;
    rsiOverbought: number;
    rsiOversold: number;
    rsiPeriod: number;
    volumeSpikeMult: number;
  };
  strategy9: {
    profitTargetPct: number;
    stopLossPct: number;
    cooldownMinutes: number;
    minGapPct: number;
  };
  strategy10: {
    profitTargetPct: number;
    stopLossPct: number;
    useTrailingStop: boolean;
    trailingStopPct: number;
    trailingActivationPct: number;
    cooldownMinutes: number;
    minTrendBars: number;
    rsiTrendCallMin: number;
    rsiTrendCallMax: number;
    rsiTrendPutMin: number;
    rsiTrendPutMax: number;
    rsiPeriod: number;
    requireSmaBreakout: boolean;
    smaFastPeriod: number;
    smaSlowPeriod: number;
    signalMaxAgeSecs: number;
    requireEntryPriceConfirmation: boolean;
    requireVwapTrend: boolean;
    vwapSlopeLookback: number;
    failedBreakoutBlockMinutes: number;
    minDelta: number;
  };
  strategy11: {
    swingLookback: number;
    minDisplacementPct: number;
    avgBodyLookback: number;
    avgBodyMult: number;
    cooldownMinutes: number;
    minRiskReward: number;
    sweepWindowBars: number;
    mssLookbackBars: number;
    useSRFilter: boolean;
    srProximityPct: number;
    allowSREntry: boolean;
  };
};

export const DEFAULT_STRATEGY_SETTINGS: StrategySettings = {
  global: {
    warmup: 100,
    minBars1h: 400,
    minBars15m: 800,
    minBars1d: 200,
    minBars1m: 2000,
    successThresholdPct: 0.005,
  },
  strategy1: {
    window15m: 4,
    cooldownHours: 3,
    trendLookback: 3,
  },
  strategy2: {
    dailyTrendLookback: 3,
    touchPct: 0.0015,
    window1h: 2,
    window15m: 4,
    cooldownHours: 6,
  },
  strategy3: {
    minGapPct: 0.004,
    tightLookback: 100,
    tightPercentile: 20,
    bandOutsideTol: 0,
    entryWindowMinutes: 5,
    maxSignalsPerDay: 1,
  },
  strategy4: {
    minDistPct: 0.012,
    firstBarWindow: 2,
    confirmWindow: 6,
    cooldownHours: 6,
  },
  strategy5: {
    minGapPct: 0.004,
    tightLookback: 100,
    tightPercentile: 20,
    bandOutsideTol: 0.0005,
    maxSignalsPerDay: 1,
    flatLookback: 6,
    flatEpsilon: 0.0005,
    entryWindowMinutes: 5,
  },
  ct15: {
    minGapPct: 0.002,
    bwSlopeLookback: 3,
    bwAvgRatio: 1.0,
    maxSignalsPerDay: 1,
    strictExposedMode: false,
  },
  ct_open: {
    requireSqueeze: true,
    squeezeLookback: 100,
    squeezePercentile: 15,
    entryWindowMinutes: 15,
    minBreakoutBars: 3,
    minDisplacementPct: 0.10,
    maxSignalsPerDay: 1,
  },
  strategy7: {
    profitTargetPct: 0.10,
    stopLossPct: 0.50,
    maxHoldMinutes: 5,
    cooldownMinutes: 3,
    useTrailingStop: true,
    trailingStopPct: 0.05,
    volumeSpikePct: 1.5,
    minConsecutiveBars: 2,
  },
  strategy8: {
    profitTargetPct: 0.20,
    stopLossPct: 0.50,
    useTrailingStop: true,
    trailingStopPct: 0.10,
    trailingActivationPct: 0.15,
    cooldownMinutes: 10,
    rsiOverbought: 65,
    rsiOversold: 35,
    rsiPeriod: 14,
    volumeSpikeMult: 2.0,
  },
  strategy9: {
    profitTargetPct: 0.20,
    stopLossPct: 0.50,
    cooldownMinutes: 30,
    minGapPct: 0.005,
  },
  strategy10: {
    profitTargetPct: 0.30,
    stopLossPct: 0.50,
    useTrailingStop: true,
    trailingStopPct: 0.15,
    trailingActivationPct: 0.20,
    cooldownMinutes: 60,
    minTrendBars: 3,
    rsiTrendCallMin: 50,
    rsiTrendCallMax: 70,
    rsiTrendPutMin: 30,
    rsiTrendPutMax: 50,
    rsiPeriod: 14,
    requireSmaBreakout: false,
    smaFastPeriod: 20,
    smaSlowPeriod: 200,
    signalMaxAgeSecs: 180,
    requireEntryPriceConfirmation: true,
    requireVwapTrend: true,
    vwapSlopeLookback: 5,
    failedBreakoutBlockMinutes: 30,
    minDelta: 0.35,
  },
  strategy11: {
    swingLookback: 3,
    minDisplacementPct: 0.0005,
    avgBodyLookback: 20,
    avgBodyMult: 1.0,
    cooldownMinutes: 30,
    minRiskReward: 1.5,
    sweepWindowBars: 36,
    mssLookbackBars: 6,
    useSRFilter: false,
    srProximityPct: 0.002,
    allowSREntry: false,
  },
};

export const mergeStrategySettings = (
  overrides?: Partial<StrategySettings>
): StrategySettings => {
  if (!overrides) return DEFAULT_STRATEGY_SETTINGS;
  return {
    global: { ...DEFAULT_STRATEGY_SETTINGS.global, ...overrides.global },
    strategy1: { ...DEFAULT_STRATEGY_SETTINGS.strategy1, ...overrides.strategy1 },
    strategy2: { ...DEFAULT_STRATEGY_SETTINGS.strategy2, ...overrides.strategy2 },
    strategy3: { ...DEFAULT_STRATEGY_SETTINGS.strategy3, ...overrides.strategy3 },
    strategy4: { ...DEFAULT_STRATEGY_SETTINGS.strategy4, ...overrides.strategy4 },
    strategy5: { ...DEFAULT_STRATEGY_SETTINGS.strategy5, ...overrides.strategy5 },
    ct15: { ...DEFAULT_STRATEGY_SETTINGS.ct15, ...overrides.ct15 },
    ct_open: { ...DEFAULT_STRATEGY_SETTINGS.ct_open, ...overrides.ct_open },
    strategy7: { ...DEFAULT_STRATEGY_SETTINGS.strategy7, ...overrides.strategy7 },
    strategy8: { ...DEFAULT_STRATEGY_SETTINGS.strategy8, ...overrides.strategy8 },
    strategy9: { ...DEFAULT_STRATEGY_SETTINGS.strategy9, ...overrides.strategy9 },
    strategy10: { ...DEFAULT_STRATEGY_SETTINGS.strategy10, ...overrides.strategy10 },
    strategy11: { ...DEFAULT_STRATEGY_SETTINGS.strategy11, ...overrides.strategy11 },
  };
};
