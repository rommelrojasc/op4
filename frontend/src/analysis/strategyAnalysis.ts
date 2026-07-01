import { fetchHistoricalData } from '@/services/api/marketData';
import { Bar, Interval } from '@/types/chart.types';
import { StrategySignal, StrategyDirection } from '@/types/strategy';
import { mergeStrategySettings, StrategySettings } from '@/analysis/strategyDefaults';

const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
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

const calculateBollinger = (bars: Bar[], period: number, mult: number) => {
  const upper: Array<number | null> = Array(bars.length).fill(null);
  const lower: Array<number | null> = Array(bars.length).fill(null);
  const mid = calculateMA(bars, period);
  for (let i = 0; i < bars.length; i += 1) {
    if (i < period - 1 || mid[i] === null) continue;
    const mean = mid[i] as number;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = bars[j].close - mean;
      variance += diff * diff;
    }
    const std = Math.sqrt(variance / period);
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, lower, mid };
};

const calculateSMAValues = (values: Array<number | null>, period: number) => {
  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value !== null) {
      sum += value;
      count += 1;
    }
    if (i >= period) {
      const prev = values[i - period];
      if (prev !== null) {
        sum -= prev;
        count -= 1;
      }
    }
    if (i >= period - 1) {
      result[i] = count === period ? sum / period : null;
    }
  }
  return result;
};

const ema = (values: number[], length: number) => {
  if (values.length === 0) return [];
  const alpha = 2 / (length + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
  }
  return result;
};

const calculateWordenStoch = (bars: Bar[], period = 14, kSmooth = 3, dSmooth = 3) => {
  const rawK: Array<number | null> = Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i += 1) {
    if (i < period - 1) continue;
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      high = Math.max(high, bars[j].high);
      low = Math.min(low, bars[j].low);
    }
    const range = high - low;
    rawK[i] = range === 0 ? 0 : ((bars[i].close - low) / range) * 100;
  }
  const rawKCompact = rawK.filter((v): v is number => v !== null);
  const kSmoothed = kSmooth > 1 ? ema(rawKCompact, kSmooth) : rawKCompact;
  const dSmoothed = dSmooth > 1 ? ema(kSmoothed, dSmooth) : kSmoothed;
  const kValues: Array<number | null> = Array(bars.length).fill(null);
  const dValues: Array<number | null> = Array(bars.length).fill(null);
  let startIdx = rawK.findIndex((v) => v !== null);
  if (startIdx < 0) startIdx = bars.length;
  for (let i = 0; i < kSmoothed.length; i += 1) {
    kValues[startIdx + i] = kSmoothed[i];
  }
  for (let i = 0; i < dSmoothed.length; i += 1) {
    dValues[startIdx + i] = dSmoothed[i];
  }
  return { kValues, dValues };
};

const computeBarsCount = (
  visibleFrom: number,
  visibleTo: number,
  interval: Interval,
  warmup: number
) => {
  const duration = Math.max(0, visibleTo - visibleFrom);
  const intervalSeconds = INTERVAL_SECONDS[interval];
  const visibleBars = Math.ceil(duration / intervalSeconds);
  const total = visibleBars + warmup;
  return Math.min(2000, Math.max(200, total));
};

const withinVisibleRange = (time: number, range: { from: number; to: number }) =>
  time >= range.from && time <= range.to;

const nyDateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const getNyParts = (unixSeconds: number) => {
  const parts = nyDateParts.formatToParts(new Date(unixSeconds * 1000));
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { year, month, day, hour, minute };
};

const getNyDayKey = (unixSeconds: number) => {
  const parts = getNyParts(unixSeconds);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day
  ).padStart(2, '0')}`;
};

export interface AnalysisContext {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1h: Bar[];
  bars15m: Bar[];
  bars1d: Bar[];
  bars1m: Bar[];
}

export interface BarStrategyAnalysis {
  time: number;
  strategies: {
    id: string;
    name: string;
    matched: boolean;
    conditions: { label: string; pass: boolean }[];
  }[];
}

function runAnalysis({
  symbol,
  visibleRange,
  bars1h,
  bars15m,
  bars1d,
  bars1m,
  outcomeHorizonBars,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1h: Bar[];
  bars15m: Bar[];
  bars1d: Bar[];
  bars1m: Bar[];
  outcomeHorizonBars: number;
  settings: StrategySettings;
}): StrategySignal[] {
  const ma20_1h = calculateMA(bars1h, 20);
  const ma40_1h = calculateMA(bars1h, 40);
  const ma20_15m = calculateMA(bars15m, 20);
  const stoch15m = calculateWordenStoch(bars15m, 14, 3, 3);

  const ma20_1d = calculateMA(bars1d, 20);
  const ma40_1d = calculateMA(bars1d, 40);

  const strategy1 = detectStrategy1TrendChange({
    symbol,
    visibleRange,
    bars1h,
    bars15m,
    ma20_1h,
    ma40_1h,
    ma20_15m,
    stoch15m,
    outcomeHorizonBars,
    settings,
  });

  const strategy2 = detectStrategy2MidlineBounce({
    symbol,
    visibleRange,
    bars1d,
    bars1h,
    bars15m,
    ma20_1d,
    ma40_1d,
    ma20_15m,
    stoch15m,
    outcomeHorizonBars,
    settings,
  });

  const strategy3 = detectStrategy3OpenGapFade({
    symbol,
    visibleRange,
    bars1d,
    bars15m,
    bars1m,
    outcomeHorizonBars,
    settings,
  });

  const strategy4 = detectStrategy4MagnetEffect({
    symbol,
    visibleRange,
    bars1h,
    bars15m,
    ma20_1h,
    ma40_1h,
    ma20_15m,
    stoch15m,
    settings,
  });

  const strategy5 = detectStrategy5LateralOpenNoVol({
    symbol,
    visibleRange,
    bars1d,
    bars15m,
    bars1m,
    settings,
  });

  const strategyCT15 = detectStrategyCT15({
    symbol,
    visibleRange,
    bars1d,
    bars15m,
    settings,
  });

  const strategyCTOpen = detectStrategyCTOpen({
    symbol,
    visibleRange,
    bars15m,
    bars1m,
    settings,
  });

  return [
    ...strategy1,
    ...strategy2,
    ...strategy3,
    ...strategy4,
    ...strategy5,
    ...strategyCT15,
    ...strategyCTOpen,
  ];
}

export async function analyzeVisibleRange(
  symbol: string,
  visibleRange: { from: number; to: number },
  outcomeHorizonBars = 8,
  contract?: { conId?: number; secType?: string; exchange?: string; currency?: string },
  overrides?: Partial<StrategySettings>
): Promise<StrategySignal[]> {
  const settings = mergeStrategySettings(overrides);
  const barsCount1h = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1h', settings.global.warmup),
    settings.global.minBars1h
  );
  const barsCount15m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '15m', settings.global.warmup),
    settings.global.minBars15m
  );
  const barsCount1d = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1d', settings.global.warmup),
    settings.global.minBars1d
  );
  const barsCount1m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1m', settings.global.warmup),
    settings.global.minBars1m
  );

  const [data1h, data15m, data1d, data1m] = await Promise.all([
    fetchHistoricalData(symbol, '1h', barsCount1h, contract?.conId, contract),
    fetchHistoricalData(symbol, '15m', barsCount15m, contract?.conId, contract),
    fetchHistoricalData(symbol, '1d', barsCount1d, contract?.conId, contract),
    fetchHistoricalData(symbol, '1m', barsCount1m, contract?.conId, contract),
  ]);

  return runAnalysis({
    symbol,
    visibleRange,
    bars1h: data1h.bars,
    bars15m: data15m.bars,
    bars1d: data1d.bars,
    bars1m: data1m.bars,
    outcomeHorizonBars,
    settings,
  });
}

export async function analyzeBarAtTime(
  symbol: string,
  time: number,
  contract?: { conId?: number; secType?: string; exchange?: string; currency?: string },
  overrides?: Partial<StrategySettings>
): Promise<BarStrategyAnalysis> {
  const settings = mergeStrategySettings(overrides);
  const visibleRange = { from: time - 86400 * 10, to: time + 86400 * 2 };
  const barsCount1h = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1h', settings.global.warmup),
    settings.global.minBars1h
  );
  const barsCount15m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '15m', settings.global.warmup),
    settings.global.minBars15m
  );
  const barsCount1d = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1d', settings.global.warmup),
    settings.global.minBars1d
  );
  const barsCount1m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1m', settings.global.warmup),
    settings.global.minBars1m
  );

  const [data1h, data15m, data1d, data1m] = await Promise.all([
    fetchHistoricalData(symbol, '1h', barsCount1h, contract?.conId, contract),
    fetchHistoricalData(symbol, '15m', barsCount15m, contract?.conId, contract),
    fetchHistoricalData(symbol, '1d', barsCount1d, contract?.conId, contract),
    fetchHistoricalData(symbol, '1m', barsCount1m, contract?.conId, contract),
  ]);

  const bars1h = data1h.bars;
  const bars15m = data15m.bars;
  const bars1d = data1d.bars;
  const bars1m = data1m.bars;

  const ma20_1h = calculateMA(bars1h, 20);
  const ma40_1h = calculateMA(bars1h, 40);
  const ma20_15m = calculateMA(bars15m, 20);
  const stoch15m = calculateWordenStoch(bars15m, 14, 3, 3);
  const ma20_1d = calculateMA(bars1d, 20);
  const ma40_1d = calculateMA(bars1d, 40);
  const bands15m = calculateBollinger(bars15m, 20, 2);

  const nearestIndex = (bars: Bar[], t: number) => {
    let idx = -1;
    for (let i = 0; i < bars.length; i += 1) {
      if (bars[i].time <= t) idx = i;
    }
    return idx;
  };

  const idx1h = nearestIndex(bars1h, time);
  const idx15m = nearestIndex(bars15m, time);
  const idx1m = nearestIndex(bars1m, time);
  const idx1d = nearestIndex(bars1d, time);
  const s1 = settings.strategy1;
  const s2 = settings.strategy2;
  const s3 = settings.strategy3;
  const s4 = settings.strategy4;
  const s5 = settings.strategy5;
  const ct15 = settings.ct15;
  const entryWindowEnd3 = 30 + s3.entryWindowMinutes;
  const entryWindowEnd5 = 30 + s5.entryWindowMinutes;

  const strategy1Conditions: { label: string; pass: boolean }[] = [];
  let strategy1Matched = false;
  if (idx1h >= 3 && idx15m >= 1) {
    const prevDowntrend =
      bars1h[idx1h - 1].close < (ma40_1h[idx1h - 1] ?? Infinity) &&
      bars1h[idx1h - 2].close < (ma40_1h[idx1h - 2] ?? Infinity) &&
      bars1h[idx1h - 3].close < (ma40_1h[idx1h - 3] ?? Infinity) &&
      ma20_1h[idx1h] !== null &&
      ma20_1h[idx1h - 3] !== null &&
      (ma20_1h[idx1h]! - ma20_1h[idx1h - 3]!) / 3 <= 0;
    const prevUptrend =
      bars1h[idx1h - 1].close > (ma40_1h[idx1h - 1] ?? -Infinity) &&
      bars1h[idx1h - 2].close > (ma40_1h[idx1h - 2] ?? -Infinity) &&
      bars1h[idx1h - 3].close > (ma40_1h[idx1h - 3] ?? -Infinity) &&
      ma20_1h[idx1h] !== null &&
      ma20_1h[idx1h - 3] !== null &&
      (ma20_1h[idx1h]! - ma20_1h[idx1h - 3]!) / 3 >= 0;
    const crossUp =
      ma20_1h[idx1h - 1] !== null &&
      ma20_1h[idx1h] !== null &&
      bars1h[idx1h - 1].close <= (ma20_1h[idx1h - 1] as number) &&
      bars1h[idx1h].close > (ma20_1h[idx1h] as number);
    const crossDown =
      ma20_1h[idx1h - 1] !== null &&
      ma20_1h[idx1h] !== null &&
      bars1h[idx1h - 1].close >= (ma20_1h[idx1h - 1] as number) &&
      bars1h[idx1h].close < (ma20_1h[idx1h] as number);
    const confirmWindowStart = bars15m.findIndex((b) => b.time > bars1h[idx1h].time);
    const windowEnd = confirmWindowStart + s1.window15m - 1;
    const inWindow = idx15m >= confirmWindowStart && idx15m <= windowEnd;
    const confirmMaUp = ma20_15m[idx15m] !== null && bars15m[idx15m].close > (ma20_15m[idx15m] as number);
    const confirmMaDown = ma20_15m[idx15m] !== null && bars15m[idx15m].close < (ma20_15m[idx15m] as number);
    const kPrev = stoch15m.kValues[idx15m - 1];
    const k = stoch15m.kValues[idx15m];
    const dPrev = stoch15m.dValues[idx15m - 1];
    const d = stoch15m.dValues[idx15m];
    const confirmStochUp =
      (kPrev !== null && k !== null && kPrev <= 20 && k > 20) ||
      (kPrev !== null && k !== null && dPrev !== null && d !== null && kPrev <= dPrev && k > d);
    const confirmStochDown =
      (kPrev !== null && k !== null && kPrev >= 80 && k < 80) ||
      (kPrev !== null && k !== null && dPrev !== null && d !== null && kPrev >= dPrev && k < d);

    strategy1Conditions.push({ label: 'CALL: prior downtrend on 1H', pass: prevDowntrend });
    strategy1Conditions.push({ label: 'CALL: cross above MA20 on 1H', pass: crossUp });
    strategy1Conditions.push({ label: 'CALL: target bar within 15m confirm window', pass: inWindow });
    strategy1Conditions.push({ label: 'CALL: 15m confirmation (MA20 or Stoch)', pass: confirmMaUp || confirmStochUp });
    strategy1Conditions.push({ label: 'PUT: prior uptrend on 1H', pass: prevUptrend });
    strategy1Conditions.push({ label: 'PUT: cross below MA20 on 1H', pass: crossDown });
    strategy1Conditions.push({ label: 'PUT: target bar within 15m confirm window', pass: inWindow });
    strategy1Conditions.push({ label: 'PUT: 15m confirmation (MA20 or Stoch)', pass: confirmMaDown || confirmStochDown });

    strategy1Matched =
      prevDowntrend &&
      crossUp &&
      inWindow &&
      (confirmMaUp || confirmStochUp) ||
      (prevUptrend && crossDown && inWindow && (confirmMaDown || confirmStochDown));
  }

  const strategy2Conditions: { label: string; pass: boolean }[] = [];
  let strategy2Matched = false;
  if (idx1d >= s2.dailyTrendLookback && idx1h >= 1 && idx15m >= 0) {
    const ma20d = ma20_1d[idx1d];
    const slope =
      ma20_1d[idx1d] !== null && ma20_1d[idx1d - s2.dailyTrendLookback] !== null
        ? (ma20_1d[idx1d]! - ma20_1d[idx1d - s2.dailyTrendLookback]!) / s2.dailyTrendLookback
        : 0;
    const dailyDown = (() => {
      if (slope > 0) return false;
      for (let j = 1; j <= s2.dailyTrendLookback; j += 1) {
        const idx = idx1d - j;
        if (idx < 0) return false;
        if (bars1d[idx].close >= (ma40_1d[idx] ?? Infinity)) return false;
      }
      return true;
    })();
    const dailyUp = (() => {
      if (slope < 0) return false;
      for (let j = 1; j <= s2.dailyTrendLookback; j += 1) {
        const idx = idx1d - j;
        if (idx < 0) return false;
        if (bars1d[idx].close <= (ma40_1d[idx] ?? -Infinity)) return false;
      }
      return true;
    })();

    const touchIdx = (() => {
      for (let i = idx1h; i >= Math.max(0, idx1h - 10); i -= 1) {
        if (ma20d === null) continue;
        const bar = bars1h[i];
        const touch =
          (bar.low <= ma20d && bar.high >= ma20d) ||
          Math.abs(bar.close - ma20d) / ma20d <= s2.touchPct;
        if (touch) return i;
      }
      return -1;
    })();
    const touchFound = touchIdx >= 0;
    let confirmIdx = -1;
    if (touchFound && ma20d !== null) {
      for (let i = touchIdx + 1; i <= touchIdx + s2.window1h && i < bars1h.length; i += 1) {
        const bar = bars1h[i];
        if (dailyDown && bar.close < ma20d && bar.close < bars1h[touchIdx].low) {
          confirmIdx = i;
          break;
        }
        if (dailyUp && bar.close > ma20d && bar.close > bars1h[touchIdx].high) {
          confirmIdx = i;
          break;
        }
      }
    }
    const confirmFound = confirmIdx >= 0;
    const confirm15mStart = confirmFound
      ? bars15m.findIndex((b) => b.time > bars1h[confirmIdx].time)
      : -1;
    const inWindow = confirm15mStart >= 0 && idx15m >= confirm15mStart && idx15m <= confirm15mStart + s2.window15m - 1;
    const confirmMaUp = ma20_15m[idx15m] !== null && bars15m[idx15m].close > (ma20_15m[idx15m] as number);
    const confirmMaDown = ma20_15m[idx15m] !== null && bars15m[idx15m].close < (ma20_15m[idx15m] as number);

    strategy2Conditions.push({ label: 'CALL: daily uptrend', pass: dailyUp });
    strategy2Conditions.push({ label: 'CALL: touched daily MA20', pass: touchFound });
    strategy2Conditions.push({ label: 'CALL: 1H bounce confirmation', pass: confirmFound && dailyUp });
    strategy2Conditions.push({ label: 'CALL: target bar within 15m window', pass: inWindow });
    strategy2Conditions.push({ label: 'CALL: 15m confirmation', pass: confirmMaUp });
    strategy2Conditions.push({ label: 'PUT: daily downtrend', pass: dailyDown });
    strategy2Conditions.push({ label: 'PUT: touched daily MA20', pass: touchFound });
    strategy2Conditions.push({ label: 'PUT: 1H rejection confirmation', pass: confirmFound && dailyDown });
    strategy2Conditions.push({ label: 'PUT: target bar within 15m window', pass: inWindow });
    strategy2Conditions.push({ label: 'PUT: 15m confirmation', pass: confirmMaDown });

    strategy2Matched =
      (dailyUp && touchFound && confirmFound && inWindow && confirmMaUp) ||
      (dailyDown && touchFound && confirmFound && inWindow && confirmMaDown);
  }

  const strategy3Conditions: { label: string; pass: boolean }[] = [];
  let strategy3Matched = false;
  if (idx1m >= 1 && idx15m >= 1) {
    const dayKey = getNyDayKey(time);
    const openBar = bars1m.find((bar) => {
      const parts = getNyParts(bar.time);
      return getNyDayKey(bar.time) === dayKey && parts.hour === 9 && parts.minute === 30;
    });
    const targetParts = getNyParts(time);
    const inEntryWindow = targetParts.hour === 9 && targetParts.minute >= 30 && targetParts.minute < entryWindowEnd3;
    const priorDayKey = getNyDayKey(time - 86400);
    const priorClose1m = [...bars1m]
      .reverse()
      .find((bar) => getNyDayKey(bar.time) === priorDayKey && getNyParts(bar.time).hour === 16)?.close;
    const priorClose = priorClose1m ?? (bars1d[idx1d - 1]?.close ?? null);
    const gapPct = openBar && priorClose ? (openBar.open - priorClose) / priorClose : 0;
    const gapUp = gapPct >= s3.minGapPct;
    const gapDown = gapPct <= -s3.minGapPct;
    const open15m = bars15m.find((bar) => {
      const parts = getNyParts(bar.time);
      return getNyDayKey(bar.time) === dayKey && parts.hour === 9 && parts.minute === 30;
    });
    const open15mIndex = open15m ? bars15m.findIndex((bar) => bar.time === open15m.time) : -1;
    const bbUpper = open15mIndex >= 0 ? bands15m.upper[open15mIndex] : null;
    const bbLower = open15mIndex >= 0 ? bands15m.lower[open15mIndex] : null;
    const bbMid = open15mIndex >= 0 ? bands15m.mid[open15mIndex] : null;
    const bandwidth = open15mIndex >= 0 && bbUpper !== null && bbLower !== null && bbMid !== null
      ? ((bbUpper - bbLower) / bbMid)
      : null;
    let isTight = false;
    if (open15mIndex >= 0 && bandwidth !== null) {
      const windowStart = Math.max(0, open15mIndex - s3.tightLookback + 1);
      const window = [];
      for (let i = windowStart; i <= open15mIndex; i += 1) {
        const m = bands15m.mid[i];
        const u = bands15m.upper[i];
        const l = bands15m.lower[i];
        if (m !== null && u !== null && l !== null) {
          window.push((u - l) / m);
        }
      }
      if (window.length >= Math.min(20, s3.tightLookback)) {
        const sorted = [...window].sort((a, b) => a - b);
        const rank = sorted.findIndex((v) => v >= bandwidth);
        const percentile = ((rank < 0 ? sorted.length : rank + 1) / sorted.length) * 100;
        isTight = percentile <= s3.tightPercentile;
      }
    }
    const openOutsideUpper =
      openBar && bbUpper !== null ? openBar.open > bbUpper * (1 + s3.bandOutsideTol) : false;
    const openOutsideLower =
      openBar && bbLower !== null ? openBar.open < bbLower * (1 - s3.bandOutsideTol) : false;
    const targetBar = bars1m[idx1m];
    const prevBar = bars1m[idx1m - 1];
    const confirmPut =
      targetBar.close < targetBar.open && targetBar.close < prevBar.low;
    const confirmCall =
      targetBar.close > targetBar.open && targetBar.close > prevBar.high;

    strategy3Conditions.push({ label: 'CALL: entry within 09:30-09:35', pass: inEntryWindow });
    strategy3Conditions.push({ label: 'CALL: gap down >= 0.4%', pass: gapDown });
    strategy3Conditions.push({ label: 'CALL: tight 15m bands', pass: isTight });
    strategy3Conditions.push({ label: 'CALL: open below lower band', pass: openOutsideLower });
    strategy3Conditions.push({ label: 'CALL: 1m reversal confirmation', pass: confirmCall });
    strategy3Conditions.push({ label: 'PUT: entry within 09:30-09:35', pass: inEntryWindow });
    strategy3Conditions.push({ label: 'PUT: gap up >= 0.4%', pass: gapUp });
    strategy3Conditions.push({ label: 'PUT: tight 15m bands', pass: isTight });
    strategy3Conditions.push({ label: 'PUT: open above upper band', pass: openOutsideUpper });
    strategy3Conditions.push({ label: 'PUT: 1m reversal confirmation', pass: confirmPut });

    strategy3Matched =
      inEntryWindow &&
      ((gapDown && isTight && openOutsideLower && confirmCall) ||
        (gapUp && isTight && openOutsideUpper && confirmPut));
  }

  const strategy4Conditions: { label: string; pass: boolean }[] = [];
  let strategy4Matched = false;
  if (idx15m >= 1 && idx1h >= 3) {
    const ma20 = ma20_15m[idx15m];
    const distPct =
      ma20 !== null ? Math.abs(bars15m[idx15m].close - ma20) / ma20 : 0;
    const stretch = ma20 !== null && distPct >= s4.minDistPct;
    const belowMa = ma20 !== null && bars15m[idx15m].close < ma20;
    const aboveMa = ma20 !== null && bars15m[idx15m].close > ma20;
    const upper = bands15m.upper[idx15m];
    const lower = bands15m.lower[idx15m];
    const outsideUpper = upper !== null && bars15m[idx15m].close > upper;
    const outsideLower = lower !== null && bars15m[idx15m].close < lower;
    const slope =
      ma20_1h[idx1h] !== null && ma20_1h[idx1h - s1.trendLookback] !== null
        ? (ma20_1h[idx1h]! - ma20_1h[idx1h - s1.trendLookback]!) / s1.trendLookback
        : 0;
    const closesBelow = [
      bars1h[idx1h - 1].close < (ma40_1h[idx1h - 1] ?? Infinity),
      bars1h[idx1h - 2].close < (ma40_1h[idx1h - 2] ?? Infinity),
      bars1h[idx1h - 3].close < (ma40_1h[idx1h - 3] ?? Infinity),
    ];
    const closesAbove = [
      bars1h[idx1h - 1].close > (ma40_1h[idx1h - 1] ?? -Infinity),
      bars1h[idx1h - 2].close > (ma40_1h[idx1h - 2] ?? -Infinity),
      bars1h[idx1h - 3].close > (ma40_1h[idx1h - 3] ?? -Infinity),
    ];
    const intradayDowntrend = closesBelow.every(Boolean) && slope <= 0.0;
    const intradayUptrend = closesAbove.every(Boolean) && slope >= 0.0;
    const slopeWeak = Math.abs(slope) <= 0.01;
    const trendGateCall = intradayDowntrend || slopeWeak;
    const trendGatePut = intradayUptrend || slopeWeak;
    const kPrev = stoch15m.kValues[idx15m - 1];
    const kVal = stoch15m.kValues[idx15m];
    const dPrev = stoch15m.dValues[idx15m - 1];
    const dVal = stoch15m.dValues[idx15m];
    const bullish =
      (kPrev !== null && kVal !== null && kPrev <= 20 && kVal > 20) ||
      (kPrev !== null && kVal !== null && dPrev !== null && dVal !== null && kPrev <= dPrev && kVal > dVal);
    const bearish =
      (kPrev !== null && kVal !== null && kPrev >= 80 && kVal < 80) ||
      (kPrev !== null && kVal !== null && dPrev !== null && dVal !== null && kPrev >= dPrev && kVal < dVal);

    strategy4Conditions.push({ label: 'CALL: stretch below MA20 by threshold', pass: stretch && belowMa });
    strategy4Conditions.push({ label: 'CALL: first bar outside lower band', pass: outsideLower });
    strategy4Conditions.push({ label: 'CALL: trend gate (downtrend/weakening)', pass: trendGateCall });
    strategy4Conditions.push({ label: 'CALL: stoch bullish confirmation', pass: bullish });
    strategy4Conditions.push({ label: 'PUT: stretch above MA20 by threshold', pass: stretch && aboveMa });
    strategy4Conditions.push({ label: 'PUT: first bar outside upper band', pass: outsideUpper });
    strategy4Conditions.push({ label: 'PUT: trend gate (uptrend/weakening)', pass: trendGatePut });
    strategy4Conditions.push({ label: 'PUT: stoch bearish confirmation', pass: bearish });

    strategy4Matched =
      (stretch && belowMa && outsideLower && trendGateCall && bullish) ||
      (stretch && aboveMa && outsideUpper && trendGatePut && bearish);
  }

  const strategy5Conditions: { label: string; pass: boolean }[] = [];
  let strategy5Matched = false;
  if (idx15m >= 1 && idx1m >= 1) {
    const dayKey = getNyDayKey(time);
    const open1m = bars1m.find((bar) => {
      const parts = getNyParts(bar.time);
      return getNyDayKey(bar.time) === dayKey && parts.hour === 9 && parts.minute === 30;
    });
    const open15m = bars15m.find((bar) => {
      const parts = getNyParts(bar.time);
      return getNyDayKey(bar.time) === dayKey && parts.hour === 9 && parts.minute === 30;
    });
    const inEntryWindow = (() => {
      const parts = getNyParts(time);
      return parts.hour === 9 && parts.minute >= 30 && parts.minute < entryWindowEnd5;
    })();
    const priorDayKey = getNyDayKey(time - 86400);
    const priorClose = [...bars1m]
      .reverse()
      .find((bar) => getNyDayKey(bar.time) === priorDayKey && getNyParts(bar.time).hour === 16)
      ?.close ?? bars1d[idx1d - 1]?.close;
    const gapPct = open1m && priorClose ? (open1m.open - priorClose) / priorClose : 0;
    const gapUp = gapPct >= s5.minGapPct;
    const gapDown = gapPct <= -s5.minGapPct;
    const open15mIndex = open15m ? bars15m.findIndex((bar) => bar.time === open15m.time) : -1;
    const bbUpper = open15mIndex >= 0 ? bands15m.upper[open15mIndex] : null;
    const bbLower = open15mIndex >= 0 ? bands15m.lower[open15mIndex] : null;
    const bbMid = open15mIndex >= 0 ? bands15m.mid[open15mIndex] : null;
    const bbBw =
      open15mIndex >= 0 && bbUpper !== null && bbLower !== null && bbMid !== null
        ? (bbUpper - bbLower) / bbMid
        : null;
    let percentile = 100;
    if (open15mIndex >= 0 && bbBw !== null) {
      const windowStart = Math.max(0, open15mIndex - s5.tightLookback + 1);
      const window = [];
      for (let i = windowStart; i <= open15mIndex; i += 1) {
        const m = bands15m.mid[i];
        const u = bands15m.upper[i];
        const l = bands15m.lower[i];
        if (m !== null && u !== null && l !== null) {
          window.push((u - l) / m);
        }
      }
      if (window.length >= 20) {
        const sorted = [...window].sort((a, b) => a - b);
        const rank = sorted.findIndex((v) => v >= bbBw);
        percentile = ((rank < 0 ? sorted.length : rank + 1) / sorted.length) * 100;
      }
    }
    const isTight = percentile <= s5.tightPercentile;
    const midSlope =
      bbMid !== null && open15mIndex - s5.flatLookback >= 0
        ? (bbMid - (bands15m.mid[open15mIndex - s5.flatLookback] ?? bbMid)) /
          s5.flatLookback
        : 0;
    const isFlat = bbMid !== null && Math.abs(midSlope / bbMid) <= s5.flatEpsilon;
    const openOutsideUpper = open1m && bbUpper !== null ? open1m.open > bbUpper : false;
    const openOutsideLower = open1m && bbLower !== null ? open1m.open < bbLower : false;
    const target = bars1m[idx1m];
    const prev = bars1m[idx1m - 1];
    const confirmPut = target.close < target.open && target.close < prev.low;
    const confirmCall = target.close > target.open && target.close > prev.high;

    strategy5Conditions.push({ label: 'CALL: entry within 09:30-09:35', pass: inEntryWindow });
    strategy5Conditions.push({ label: 'CALL: tight/flat 15M regime', pass: isTight && isFlat });
    strategy5Conditions.push({ label: 'CALL: gap down >= 0.4%', pass: gapDown });
    strategy5Conditions.push({ label: 'CALL: open outside lower band', pass: openOutsideLower });
    strategy5Conditions.push({ label: 'CALL: 1m reversal confirmation', pass: confirmCall });
    strategy5Conditions.push({ label: 'PUT: entry within 09:30-09:35', pass: inEntryWindow });
    strategy5Conditions.push({ label: 'PUT: tight/flat 15M regime', pass: isTight && isFlat });
    strategy5Conditions.push({ label: 'PUT: gap up >= 0.4%', pass: gapUp });
    strategy5Conditions.push({ label: 'PUT: open outside upper band', pass: openOutsideUpper });
    strategy5Conditions.push({ label: 'PUT: 1m reversal confirmation', pass: confirmPut });

    strategy5Matched =
      inEntryWindow &&
      ((gapDown && isTight && isFlat && openOutsideLower && confirmCall) ||
        (gapUp && isTight && isFlat && openOutsideUpper && confirmPut));
  }

  const strategyCt15Conditions: { label: string; pass: boolean }[] = [];
  let strategyCt15Matched = false;
  if (idx15m >= 0) {
    const targetBar = bars15m[idx15m];
    const parts = getNyParts(targetBar.time);
    const isOpenBar = parts.hour === 9 && parts.minute === 30;
    const dayKey = getNyDayKey(targetBar.time);
    const todayKey = getNyDayKey(Math.floor(Date.now() / 1000));
    const isToday = dayKey === todayKey;
    const priorDayKey = getNyDayKey(targetBar.time - 86400);
    const priorBars = bars15m
      .filter((bar) => getNyDayKey(bar.time) === priorDayKey)
      .sort((a, b) => a.time - b.time);
    const priorLastBar = priorBars.length > 0 ? priorBars[priorBars.length - 1] : null;
    const priorClose = priorLastBar ? priorLastBar.close : null;
    const gapPct = priorClose ? (targetBar.open - priorClose) / priorClose : 0;
    const gapUp = gapPct >= ct15.minGapPct;
    const gapDown = gapPct <= -ct15.minGapPct;

    const bbMid = bands15m.mid[idx15m];
    const bandwidthSeries = bands15m.mid.map((mid, i) => {
      if (mid === null || bands15m.upper[i] === null || bands15m.lower[i] === null) {
        return null;
      }
      return ((bands15m.upper[i] as number) - (bands15m.lower[i] as number)) / (mid as number);
    });
    const bandwidthSma = calculateSMAValues(bandwidthSeries, 20);
    const bw = bandwidthSeries[idx15m];
    const bwAvg = bandwidthSma[idx15m];
    const bwPrev =
      idx15m - ct15.bwSlopeLookback >= 0
        ? bandwidthSeries[idx15m - ct15.bwSlopeLookback]
        : null;
    const bwSlope = bw !== null && bwPrev !== null ? (bw - bwPrev) / ct15.bwSlopeLookback : null;
    const volOpen = bw !== null && bwAvg !== null && bwSlope !== null ? bw > bwAvg * (ct15.bwAvgRatio ?? 1.0) && bwSlope > 0 : false;

    const regression = (() => {
      if (priorBars.length < 2) return null;
      const values = priorBars.map((bar) => bar.close);
      const n = values.length;
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumX2 = 0;
      for (let i = 0; i < n; i += 1) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
      }
      const denom = n * sumX2 - sumX * sumX;
      if (denom === 0) return null;
      const b = (n * sumXY - sumX * sumY) / denom;
      const a = (sumY - b * sumX) / n;
      return { a, b, levelAtOpen: a + b * n };
    })();

    const priorLastIndex = priorLastBar
      ? bars15m.findIndex((bar) => bar.time === priorLastBar.time)
      : -1;
    const priorMid = priorLastIndex >= 0 ? bands15m.mid[priorLastIndex] : null;

    const priorSlopeDown = regression ? regression.b <= 0 : false;
    const priorSlopeUp = regression ? regression.b >= 0 : false;
    const priorCloseBelowMid =
      priorMid !== null && priorLastBar ? priorLastBar.close < priorMid : false;
    const priorCloseAboveMid =
      priorMid !== null && priorLastBar ? priorLastBar.close > priorMid : false;
    const breakMidUp = bbMid !== null ? targetBar.open > bbMid : false;
    const breakMidDown = bbMid !== null ? targetBar.open < bbMid : false;
    const breakTrendUp = regression ? targetBar.open > regression.levelAtOpen : false;
    const breakTrendDown = regression ? targetBar.open < regression.levelAtOpen : false;

    strategyCt15Conditions.push({ label: 'CT15: opening bar (09:30)', pass: isOpenBar });
    strategyCt15Conditions.push({ label: 'CT15: current day only', pass: isToday });
    strategyCt15Conditions.push({ label: 'CT15 CALL: gap up >= 0.2%', pass: gapUp });
    strategyCt15Conditions.push({ label: 'CT15 CALL: prior day slope down/flat', pass: priorSlopeDown });
    strategyCt15Conditions.push({ label: 'CT15 CALL: prior close below midline', pass: priorCloseBelowMid });
    strategyCt15Conditions.push({ label: 'CT15 CALL: open above 15M midline', pass: breakMidUp });
    strategyCt15Conditions.push({ label: 'CT15 CALL: open above trendline', pass: breakTrendUp });
    strategyCt15Conditions.push({ label: 'CT15 CALL: volatility opened', pass: volOpen });
    strategyCt15Conditions.push({ label: 'CT15 PUT: gap down >= 0.2%', pass: gapDown });
    strategyCt15Conditions.push({ label: 'CT15 PUT: prior day slope up/flat', pass: priorSlopeUp });
    strategyCt15Conditions.push({ label: 'CT15 PUT: prior close above midline', pass: priorCloseAboveMid });
    strategyCt15Conditions.push({ label: 'CT15 PUT: open below 15M midline', pass: breakMidDown });
    strategyCt15Conditions.push({ label: 'CT15 PUT: open below trendline', pass: breakTrendDown });
    strategyCt15Conditions.push({ label: 'CT15 PUT: volatility opened', pass: volOpen });

    strategyCt15Matched =
      isOpenBar &&
      isToday &&
      volOpen &&
      ((gapUp &&
        priorSlopeDown &&
        priorCloseBelowMid &&
        breakMidUp &&
        breakTrendUp) ||
        (gapDown &&
          priorSlopeUp &&
          priorCloseAboveMid &&
          breakMidDown &&
          breakTrendDown));
  }


  return {
    time,
    strategies: [
      {
        id: 'strategy-1',
        name: 'Strategy 1 — Trend Change (1H + 15M Confirmation)',
        matched: strategy1Matched,
        conditions: strategy1Conditions,
      },
      {
        id: 'strategy2_midline_bounce_1d_1h_15m',
        name: 'Strategy 2 — Midline Bounce / Rejection (1D + 1H + 15M)',
        matched: strategy2Matched,
        conditions: strategy2Conditions,
      },
      {
        id: 'strategy3_open_gap_fade_lowvol_15m_1m',
        name: 'Strategy 3 — Low-Vol Open + Extreme Gap Fade (15M + 1M)',
        matched: strategy3Matched,
        conditions: strategy3Conditions,
      },
      {
        id: 'strategy4_magnet_effect_gap_far_from_ma20_15m',
        name: 'Strategy 4 — Magnet Effect (Gap far from MA20)',
        matched: strategy4Matched,
        conditions: strategy4Conditions,
      },
      {
        id: 'strategy5_lateral_open_outside_bollinger_no_vol',
        name: 'Strategy 5 — Lateral Open Outside Bollinger (No Vol)',
        matched: strategy5Matched,
        conditions: strategy5Conditions,
      },
      {
        id: 'ct15_open_gap_trendline_midline_volatility_15m',
        name: 'CT15 — Opening Gap Reversal (15M + Volatility)',
        matched: strategyCt15Matched,
        conditions: strategyCt15Conditions,
      },
    ],
  };
}

export async function analyzeVisibleRangeWithContext(
  symbol: string,
  visibleRange: { from: number; to: number },
  outcomeHorizonBars = 8,
  contract?: { conId?: number; secType?: string; exchange?: string; currency?: string },
  overrides?: Partial<StrategySettings>
): Promise<{ signals: StrategySignal[]; context: AnalysisContext }> {
  const settings = mergeStrategySettings(overrides);
  const barsCount1h = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1h', settings.global.warmup),
    settings.global.minBars1h
  );
  const barsCount15m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '15m', settings.global.warmup),
    settings.global.minBars15m
  );
  const barsCount1d = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1d', settings.global.warmup),
    settings.global.minBars1d
  );
  const barsCount1m = Math.max(
    computeBarsCount(visibleRange.from, visibleRange.to, '1m', settings.global.warmup),
    settings.global.minBars1m
  );

  const [data1h, data15m, data1d, data1m] = await Promise.all([
    fetchHistoricalData(symbol, '1h', barsCount1h, contract?.conId, contract),
    fetchHistoricalData(symbol, '15m', barsCount15m, contract?.conId, contract),
    fetchHistoricalData(symbol, '1d', barsCount1d, contract?.conId, contract),
    fetchHistoricalData(symbol, '1m', barsCount1m, contract?.conId, contract),
  ]);

  const signals = runAnalysis({
    symbol,
    visibleRange,
    bars1h: data1h.bars,
    bars15m: data15m.bars,
    bars1d: data1d.bars,
    bars1m: data1m.bars,
    outcomeHorizonBars,
    settings,
  });

  return {
    signals,
    context: {
      symbol,
      visibleRange,
      bars1h: data1h.bars,
      bars15m: data15m.bars,
      bars1d: data1d.bars,
      bars1m: data1m.bars,
    },
  };
}

export function analyzeWithBars({
  symbol,
  visibleRange,
  bars1h,
  bars15m,
  bars1d,
  bars1m,
  outcomeHorizonBars = 8,
  overrides,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1h: Bar[];
  bars15m: Bar[];
  bars1d: Bar[];
  bars1m: Bar[];
  outcomeHorizonBars?: number;
  overrides?: Partial<StrategySettings>;
}): StrategySignal[] {
  const settings = mergeStrategySettings(overrides);
  return runAnalysis({
    symbol,
    visibleRange,
    bars1h,
    bars15m,
    bars1d,
    bars1m,
    outcomeHorizonBars,
    settings,
  });
}

export function recomputeOutcomesForSignals(
  signals: StrategySignal[],
  bars15m: Bar[],
  bars1m: Bar[],
  horizonBars: number,
  successThresholdPct = mergeStrategySettings().global.successThresholdPct
): StrategySignal[] {
  return signals.map((signal) => {
    const use1m = signal.strategyId === 'strategy3_open_gap_fade_lowvol_15m_1m';
    const sourceBars = use1m ? bars1m : bars15m;
    const entryIndex = sourceBars.findIndex((bar) => bar.time === signal.entryTime);
    const entryPrice =
      signal.debug.outcome?.entryPrice ?? signal.debug.confirm15M.close;
    if (entryIndex < 0) {
      return {
        ...signal,
        debug: {
          ...signal.debug,
          outcome: {
            horizonBars,
            barsAvailable: 0,
            entryPrice,
            notes: `Entry time not found in ${use1m ? '1m' : '15m'} data`,
          },
        },
      };
    }
    const outcome = computeOutcome(
      sourceBars,
      entryIndex,
      entryPrice,
      signal.direction,
      horizonBars,
      successThresholdPct
    );
    return {
      ...signal,
      debug: {
        ...signal.debug,
        outcome,
      },
    };
  });
}

function detectStrategy1TrendChange({
  symbol,
  visibleRange,
  bars1h,
  bars15m,
  ma20_1h,
  ma40_1h,
  ma20_15m,
  stoch15m,
  outcomeHorizonBars,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1h: Bar[];
  bars15m: Bar[];
  ma20_1h: Array<number | null>;
  ma40_1h: Array<number | null>;
  ma20_15m: Array<number | null>;
  stoch15m: { kValues: Array<number | null>; dValues: Array<number | null> };
  outcomeHorizonBars: number;
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const cooldownSeconds = settings.strategy1.cooldownHours * 3600;
  const window15m = settings.strategy1.window15m;
  const trendLookback = settings.strategy1.trendLookback;
  const lastSignalTime: Record<StrategyDirection, number> = { CALL: 0, PUT: 0 };

  const tryConfirm = (
    confirmStartIndex: number,
    direction: StrategyDirection
  ): { bar: Bar; reason: string; rule: 'ma20' | 'stoch'; index: number } | null => {
    const windowBars = bars15m.slice(confirmStartIndex, confirmStartIndex + window15m);
    for (let i = 0; i < windowBars.length; i += 1) {
      const bar = windowBars[i];
      const idx = confirmStartIndex + i;
      const ma20 = ma20_15m[idx];
      if (ma20 !== null) {
        if (direction === 'CALL' && bar.close > ma20) {
          return { bar, reason: '15m close above MA20', rule: 'ma20', index: idx };
        }
        if (direction === 'PUT' && bar.close < ma20) {
          return { bar, reason: '15m close below MA20', rule: 'ma20', index: idx };
        }
      }

      const kPrev = stoch15m.kValues[idx - 1];
      const k = stoch15m.kValues[idx];
      const dPrev = stoch15m.dValues[idx - 1];
      const d = stoch15m.dValues[idx];
      if (kPrev === null || k === null) continue;

      if (direction === 'CALL') {
        if (kPrev <= 20 && k > 20) {
          return { bar, reason: '15m stoch crossed above 20', rule: 'stoch', index: idx };
        }
        if (dPrev !== null && d !== null && kPrev <= dPrev && k > d) {
          return { bar, reason: '15m stoch crossed above signal', rule: 'stoch', index: idx };
        }
      } else {
        if (kPrev >= 80 && k < 80) {
          return { bar, reason: '15m stoch crossed below 80', rule: 'stoch', index: idx };
        }
        if (dPrev !== null && d !== null && kPrev >= dPrev && k < d) {
          return { bar, reason: '15m stoch crossed below signal', rule: 'stoch', index: idx };
        }
      }
    }
    return null;
  };

  for (let t = trendLookback; t < bars1h.length; t += 1) {
    const ma20 = ma20_1h[t];
    const ma40 = ma40_1h[t];
    const ma20Prev = ma20_1h[t - 1];
    if (ma20 === null || ma40 === null || ma20Prev === null) continue;
    if (ma20_1h[t - trendLookback] === null) continue;

    const slope = (ma20 - (ma20_1h[t - trendLookback] as number)) / trendLookback;
    const prevTrendChecks: string[] = [];

    const prevDowntrend =
      bars1h[t - 1].close < (ma40_1h[t - 1] ?? Infinity) &&
      bars1h[t - 2].close < (ma40_1h[t - 2] ?? Infinity) &&
      bars1h[t - 3].close < (ma40_1h[t - 3] ?? Infinity) &&
      slope <= 0;
    if (prevDowntrend) {
      prevTrendChecks.push('Prev 3 closes below MA40');
      prevTrendChecks.push('MA20 slope <= 0');
    }

    const prevUptrend =
      bars1h[t - 1].close > (ma40_1h[t - 1] ?? -Infinity) &&
      bars1h[t - 2].close > (ma40_1h[t - 2] ?? -Infinity) &&
      bars1h[t - 3].close > (ma40_1h[t - 3] ?? -Infinity) &&
      slope >= 0;
    if (prevUptrend) {
      prevTrendChecks.push('Prev 3 closes above MA40');
      prevTrendChecks.push('MA20 slope >= 0');
    }

    const crossUp =
      bars1h[t - 1].close <= (ma20_1h[t - 1] ?? Infinity) &&
      bars1h[t].close > ma20;
    const crossDown =
      bars1h[t - 1].close >= (ma20_1h[t - 1] ?? -Infinity) &&
      bars1h[t].close < ma20;

    const anchorTime = bars1h[t].time;
    const confirmStartIndex = bars15m.findIndex((b) => b.time > anchorTime);
    if (confirmStartIndex < 0) continue;

    if (prevDowntrend && crossUp) {
      const confirmation = tryConfirm(confirmStartIndex, 'CALL');
      if (!confirmation) continue;
      if (!withinVisibleRange(confirmation.bar.time, visibleRange)) continue;
      if (confirmation.bar.time - lastSignalTime.CALL < cooldownSeconds) continue;
      lastSignalTime.CALL = confirmation.bar.time;

      const outcome = computeOutcome(
        bars15m,
        confirmation.index,
        confirmation.bar.close,
        'CALL',
        outcomeHorizonBars,
        settings.global.successThresholdPct
      );

      signals.push({
        id: `${symbol}-call-${confirmation.bar.time}`,
        symbol,
        strategyId: 'strategy-1',
        direction: 'CALL',
        entryTime: confirmation.bar.time,
        anchorTime1H: anchorTime,
        reasons: [
          '1H downtrend reversal',
          '1H close crossed above MA20',
          confirmation.reason,
        ],
        debug: {
          anchor1H: {
            time: anchorTime,
            open: bars1h[t].open,
            high: bars1h[t].high,
            low: bars1h[t].low,
            close: bars1h[t].close,
            ma20,
            ma40: ma40,
            slopeMa20: slope,
            prevTrendChecks,
          },
          confirm15M: {
            time: confirmation.bar.time,
            open: confirmation.bar.open,
            high: confirmation.bar.high,
            low: confirmation.bar.low,
            close: confirmation.bar.close,
            ma20: ma20_15m[confirmation.index] ?? undefined,
            stochK: stoch15m.kValues[confirmation.index] ?? undefined,
            stochD: stoch15m.dValues[confirmation.index] ?? undefined,
            rule: confirmation.rule,
          },
          params: {
            warmup: settings.global.warmup,
            window15m,
            cooldownHours: settings.strategy1.cooldownHours,
            trendLookback,
          },
          outcome,
        },
      });
    }

    if (prevUptrend && crossDown) {
      const confirmation = tryConfirm(confirmStartIndex, 'PUT');
      if (!confirmation) continue;
      if (!withinVisibleRange(confirmation.bar.time, visibleRange)) continue;
      if (confirmation.bar.time - lastSignalTime.PUT < cooldownSeconds) continue;
      lastSignalTime.PUT = confirmation.bar.time;

      const outcome = computeOutcome(
        bars15m,
        confirmation.index,
        confirmation.bar.close,
        'PUT',
        outcomeHorizonBars,
        settings.global.successThresholdPct
      );

      signals.push({
        id: `${symbol}-put-${confirmation.bar.time}`,
        symbol,
        strategyId: 'strategy-1',
        direction: 'PUT',
        entryTime: confirmation.bar.time,
        anchorTime1H: anchorTime,
        reasons: [
          '1H uptrend reversal',
          '1H close crossed below MA20',
          confirmation.reason,
        ],
        debug: {
          anchor1H: {
            time: anchorTime,
            open: bars1h[t].open,
            high: bars1h[t].high,
            low: bars1h[t].low,
            close: bars1h[t].close,
            ma20,
            ma40: ma40,
            slopeMa20: slope,
            prevTrendChecks,
          },
          confirm15M: {
            time: confirmation.bar.time,
            open: confirmation.bar.open,
            high: confirmation.bar.high,
            low: confirmation.bar.low,
            close: confirmation.bar.close,
            ma20: ma20_15m[confirmation.index] ?? undefined,
            stochK: stoch15m.kValues[confirmation.index] ?? undefined,
            stochD: stoch15m.dValues[confirmation.index] ?? undefined,
            rule: confirmation.rule,
          },
          params: {
            warmup: settings.global.warmup,
            window15m,
            cooldownHours: settings.strategy1.cooldownHours,
            trendLookback,
          },
          outcome,
        },
      });
    }
  }

  return signals;
}

function detectStrategy2MidlineBounce({
  symbol,
  visibleRange,
  bars1d,
  bars1h,
  bars15m,
  ma20_1d,
  ma40_1d,
  ma20_15m,
  stoch15m,
  outcomeHorizonBars,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1d: Bar[];
  bars1h: Bar[];
  bars15m: Bar[];
  ma20_1d: Array<number | null>;
  ma40_1d: Array<number | null>;
  ma20_15m: Array<number | null>;
  stoch15m: { kValues: Array<number | null>; dValues: Array<number | null> };
  outcomeHorizonBars: number;
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const cooldownSeconds = settings.strategy2.cooldownHours * 3600;
  const window15m = settings.strategy2.window15m;
  const window1h = settings.strategy2.window1h;
  const touchPct = settings.strategy2.touchPct;
  const dailyLookback = settings.strategy2.dailyTrendLookback;
  const lastSignalTime: Record<StrategyDirection, number> = { CALL: 0, PUT: 0 };
  const usedTouchTimes = new Set<number>();

  const dailyIndexForTime = (time: number) => {
    let idx = -1;
    for (let i = 0; i < bars1d.length; i += 1) {
      if (bars1d[i].time <= time) idx = i;
      else break;
    }
    return idx;
  };

  const tryConfirm15m = (
    confirmStartIndex: number,
    direction: StrategyDirection
  ): { bar: Bar; reason: string; rule: 'ma20' | 'stoch'; index: number } | null => {
    const windowBars = bars15m.slice(confirmStartIndex, confirmStartIndex + window15m);
    for (let i = 0; i < windowBars.length; i += 1) {
      const bar = windowBars[i];
      const idx = confirmStartIndex + i;
      const ma20 = ma20_15m[idx];
      if (ma20 !== null) {
        if (direction === 'CALL' && bar.close > ma20) {
          return { bar, reason: '15m close above MA20', rule: 'ma20', index: idx };
        }
        if (direction === 'PUT' && bar.close < ma20) {
          return { bar, reason: '15m close below MA20', rule: 'ma20', index: idx };
        }
      }

      const kPrev = stoch15m.kValues[idx - 1];
      const k = stoch15m.kValues[idx];
      const dPrev = stoch15m.dValues[idx - 1];
      const d = stoch15m.dValues[idx];
      if (kPrev === null || k === null) continue;

      if (direction === 'CALL') {
        if (kPrev <= 20 && k > 20) {
          return { bar, reason: '15m stoch crossed above 20', rule: 'stoch', index: idx };
        }
        if (dPrev !== null && d !== null && kPrev <= dPrev && k > d) {
          return { bar, reason: '15m stoch crossed above signal', rule: 'stoch', index: idx };
        }
      } else {
        if (kPrev >= 80 && k < 80) {
          return { bar, reason: '15m stoch crossed below 80', rule: 'stoch', index: idx };
        }
        if (dPrev !== null && d !== null && kPrev >= dPrev && k < d) {
          return { bar, reason: '15m stoch crossed below signal', rule: 'stoch', index: idx };
        }
      }
    }
    return null;
  };

  for (let i = 0; i < bars1h.length; i += 1) {
    const bar = bars1h[i];
    const dIdx = dailyIndexForTime(bar.time);
    if (dIdx < dailyLookback) continue;
    const ma20 = ma20_1d[dIdx];
    const ma40 = ma40_1d[dIdx];
    if (ma20 === null || ma40 === null || ma20_1d[dIdx - dailyLookback] === null) continue;
    const slope = (ma20 - (ma20_1d[dIdx - dailyLookback] as number)) / dailyLookback;

    const dailyDown = (() => {
      if (slope > 0) return false;
      for (let j = 1; j <= dailyLookback; j += 1) {
        const idx = dIdx - j;
        if (idx < 0) return false;
        if (bars1d[idx].close >= (ma40_1d[idx] ?? Infinity)) return false;
      }
      return true;
    })();
    const dailyUp = (() => {
      if (slope < 0) return false;
      for (let j = 1; j <= dailyLookback; j += 1) {
        const idx = dIdx - j;
        if (idx < 0) return false;
        if (bars1d[idx].close <= (ma40_1d[idx] ?? -Infinity)) return false;
      }
      return true;
    })();

    const distancePct = Math.abs(bar.close - ma20) / ma20;
    const highDistance = Math.abs(bar.high - ma20) / ma20;
    const lowDistance = Math.abs(bar.low - ma20) / ma20;
    const touch =
      (bar.low <= ma20 && bar.high >= ma20) ||
      distancePct <= touchPct ||
      highDistance <= touchPct ||
      lowDistance <= touchPct;
    if (!touch) continue;
    if (usedTouchTimes.has(bar.time)) continue;
    usedTouchTimes.add(bar.time);

    if (dailyDown) {
      const confirmIndex = bars1h.slice(i + 1, i + 1 + window1h).findIndex((b) =>
        b.close < ma20 && b.close < bar.low
      );
      if (confirmIndex >= 0) {
        const confirmBar = bars1h[i + 1 + confirmIndex];
        const confirmTime = confirmBar.time;
        const confirm15mStart = bars15m.findIndex((b) => b.time > confirmTime);
        if (confirm15mStart < 0) continue;
        const confirmation15m = tryConfirm15m(confirm15mStart, 'PUT');
        if (!confirmation15m) continue;
        if (!withinVisibleRange(confirmation15m.bar.time, visibleRange)) continue;
        if (confirmation15m.bar.time - lastSignalTime.PUT < cooldownSeconds) continue;
        lastSignalTime.PUT = confirmation15m.bar.time;

        const outcome = computeOutcome(
          bars15m,
          confirmation15m.index,
          confirmation15m.bar.close,
          'PUT',
          outcomeHorizonBars,
          settings.global.successThresholdPct
        );

        signals.push({
          id: `${symbol}-s2-put-${confirmation15m.bar.time}`,
          symbol,
          strategyId: 'strategy2_midline_bounce_1d_1h_15m',
          direction: 'PUT',
          entryTime: confirmation15m.bar.time,
          anchorTime1H: confirmTime,
          reasons: [
            'Daily downtrend confirmed',
            'Touched daily MA20 midline',
            '1H rejection below touch low and MA20_1d',
            confirmation15m.reason,
          ],
          debug: {
            anchor1H: {
              time: confirmTime,
              open: confirmBar.open,
              high: confirmBar.high,
              low: confirmBar.low,
              close: confirmBar.close,
              ma20: ma20,
              ma40: ma40,
              slopeMa20: slope,
              prevTrendChecks: ['Daily downtrend', 'MA20 slope <= 0'],
            },
            confirm15M: {
              time: confirmation15m.bar.time,
              open: confirmation15m.bar.open,
              high: confirmation15m.bar.high,
              low: confirmation15m.bar.low,
              close: confirmation15m.bar.close,
              ma20: ma20_15m[confirmation15m.index] ?? undefined,
              stochK: stoch15m.kValues[confirmation15m.index] ?? undefined,
              stochD: stoch15m.dValues[confirmation15m.index] ?? undefined,
              rule: confirmation15m.rule,
            },
            params: {
              warmup: settings.global.warmup,
              window15m,
              cooldownHours: settings.strategy2.cooldownHours,
              trendLookback: dailyLookback,
            },
            strategy2: {
              ma20_1d: ma20,
              ma40_1d: ma40,
              slope_ma20_1d: slope,
              touchPct,
              w1h: window1h,
              w15m: window15m,
              cooldownHours: settings.strategy2.cooldownHours,
              touchCandle1H: {
                time: bar.time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                distancePct,
              },
              confirmCandle1H: {
                time: confirmBar.time,
                open: confirmBar.open,
                high: confirmBar.high,
                low: confirmBar.low,
                close: confirmBar.close,
                closedBeyondTouch: confirmBar.close < bar.low,
                closedBeyondMidline: confirmBar.close < ma20,
              },
              entryCandle15M: {
                time: confirmation15m.bar.time,
                open: confirmation15m.bar.open,
                high: confirmation15m.bar.high,
                low: confirmation15m.bar.low,
                close: confirmation15m.bar.close,
                ma20: ma20_15m[confirmation15m.index] ?? undefined,
                stochK: stoch15m.kValues[confirmation15m.index] ?? undefined,
                stochD: stoch15m.dValues[confirmation15m.index] ?? undefined,
                rule: confirmation15m.rule,
              },
            },
            outcome,
          },
        });
      }
    }

    if (dailyUp) {
      const confirmIndex = bars1h.slice(i + 1, i + 1 + window1h).findIndex((b) =>
        b.close > ma20 && b.close > bar.high
      );
      if (confirmIndex >= 0) {
        const confirmBar = bars1h[i + 1 + confirmIndex];
        const confirmTime = confirmBar.time;
        const confirm15mStart = bars15m.findIndex((b) => b.time > confirmTime);
        if (confirm15mStart < 0) continue;
        const confirmation15m = tryConfirm15m(confirm15mStart, 'CALL');
        if (!confirmation15m) continue;
        if (!withinVisibleRange(confirmation15m.bar.time, visibleRange)) continue;
        if (confirmation15m.bar.time - lastSignalTime.CALL < cooldownSeconds) continue;
        lastSignalTime.CALL = confirmation15m.bar.time;

        const outcome = computeOutcome(
          bars15m,
          confirmation15m.index,
          confirmation15m.bar.close,
          'CALL',
          outcomeHorizonBars,
          settings.global.successThresholdPct
        );

        signals.push({
          id: `${symbol}-s2-call-${confirmation15m.bar.time}`,
          symbol,
          strategyId: 'strategy2_midline_bounce_1d_1h_15m',
          direction: 'CALL',
          entryTime: confirmation15m.bar.time,
          anchorTime1H: confirmTime,
          reasons: [
            'Daily uptrend confirmed',
            'Touched daily MA20 midline',
            '1H bounce above touch high and MA20_1d',
            confirmation15m.reason,
          ],
          debug: {
            anchor1H: {
              time: confirmTime,
              open: confirmBar.open,
              high: confirmBar.high,
              low: confirmBar.low,
              close: confirmBar.close,
              ma20: ma20,
              ma40: ma40,
              slopeMa20: slope,
              prevTrendChecks: ['Daily uptrend', 'MA20 slope >= 0'],
            },
            confirm15M: {
              time: confirmation15m.bar.time,
              open: confirmation15m.bar.open,
              high: confirmation15m.bar.high,
              low: confirmation15m.bar.low,
              close: confirmation15m.bar.close,
              ma20: ma20_15m[confirmation15m.index] ?? undefined,
              stochK: stoch15m.kValues[confirmation15m.index] ?? undefined,
              stochD: stoch15m.dValues[confirmation15m.index] ?? undefined,
              rule: confirmation15m.rule,
            },
            params: {
              warmup: settings.global.warmup,
              window15m,
              cooldownHours: settings.strategy2.cooldownHours,
              trendLookback: dailyLookback,
            },
            strategy2: {
              ma20_1d: ma20,
              ma40_1d: ma40,
              slope_ma20_1d: slope,
              touchPct,
              w1h: window1h,
              w15m: window15m,
              cooldownHours: settings.strategy2.cooldownHours,
              touchCandle1H: {
                time: bar.time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                distancePct,
              },
              confirmCandle1H: {
                time: confirmBar.time,
                open: confirmBar.open,
                high: confirmBar.high,
                low: confirmBar.low,
                close: confirmBar.close,
                closedBeyondTouch: confirmBar.close > bar.high,
                closedBeyondMidline: confirmBar.close > ma20,
              },
              entryCandle15M: {
                time: confirmation15m.bar.time,
                open: confirmation15m.bar.open,
                high: confirmation15m.bar.high,
                low: confirmation15m.bar.low,
                close: confirmation15m.bar.close,
                ma20: ma20_15m[confirmation15m.index] ?? undefined,
                stochK: stoch15m.kValues[confirmation15m.index] ?? undefined,
                stochD: stoch15m.dValues[confirmation15m.index] ?? undefined,
                rule: confirmation15m.rule,
              },
            },
            outcome,
          },
        });
      }
    }
  }

  return signals;
}

function detectStrategy3OpenGapFade({
  symbol,
  visibleRange,
  bars1d,
  bars15m,
  bars1m,
  outcomeHorizonBars,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1d: Bar[];
  bars15m: Bar[];
  bars1m: Bar[];
  outcomeHorizonBars: number;
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const {
    minGapPct,
    tightLookback,
    tightPercentile,
    bandOutsideTol,
    maxSignalsPerDay,
  } = settings.strategy3;
  const entryWindowEnd = 30 + settings.strategy3.entryWindowMinutes;

  if (bars1m.length === 0 || bars15m.length === 0) {
    return signals;
  }

  const bands15m = calculateBollinger(bars15m, 20, 2);
  const bandwidth15m = bands15m.mid.map((mid, idx) => {
    if (mid === null || bands15m.upper[idx] === null || bands15m.lower[idx] === null) {
      return null;
    }
    return ((bands15m.upper[idx] as number) - (bands15m.lower[idx] as number)) / (mid as number);
  });

  const bars1mByDay = new Map<string, Bar[]>();
  for (const bar of bars1m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars1mByDay.has(dayKey)) bars1mByDay.set(dayKey, []);
    bars1mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars1mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars15mByDay = new Map<string, Bar[]>();
  for (const bar of bars15m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars15mByDay.has(dayKey)) bars15mByDay.set(dayKey, []);
    bars15mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars15mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars1dByDay = new Map<string, Bar>();
  for (const bar of bars1d) {
    bars1dByDay.set(getNyDayKey(bar.time), bar);
  }

  for (const [dayKey, dayBars1m] of bars1mByDay) {
    if (signals.filter((s) => s.debug.strategy3?.dayKey === dayKey).length >= maxSignalsPerDay) {
      continue;
    }
    const openBar = dayBars1m.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!openBar) continue;
    if (!withinVisibleRange(openBar.time, visibleRange)) continue;

    const priorDayKey = getNyDayKey(openBar.time - 86400);
    const priorBars = bars1mByDay.get(priorDayKey);
    const priorCloseBar = priorBars
      ? [...priorBars].reverse().find((bar) => {
          const parts = getNyParts(bar.time);
          return parts.hour === 16 && parts.minute === 0;
        })
      : undefined;
    const priorClose = priorCloseBar?.close ?? bars1dByDay.get(priorDayKey)?.close;
    if (!priorClose) continue;

    const gapPct = (openBar.open - priorClose) / priorClose;
    const gapUp = gapPct >= minGapPct;
    const gapDown = gapPct <= -minGapPct;
    if (!gapUp && !gapDown) continue;

    const dayBars15m = bars15mByDay.get(dayKey) ?? [];
    const open15m = dayBars15m.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!open15m) continue;
    const open15mIndex = bars15m.findIndex((bar) => bar.time === open15m.time);
    if (open15mIndex < 0) continue;
    const bbUpper = bands15m.upper[open15mIndex];
    const bbLower = bands15m.lower[open15mIndex];
    const bbMid = bands15m.mid[open15mIndex];
    const bbBw = bandwidth15m[open15mIndex];
    if (bbUpper === null || bbLower === null || bbMid === null || bbBw === null) continue;

    const windowStart = Math.max(0, open15mIndex - tightLookback + 1);
    const window = bandwidth15m
      .slice(windowStart, open15mIndex + 1)
      .filter((v): v is number => v !== null);
    if (window.length < Math.min(20, tightLookback)) continue;
    const sorted = [...window].sort((a, b) => a - b);
    const rank = sorted.findIndex((v) => v >= bbBw);
    const percentile = ((rank < 0 ? sorted.length : rank + 1) / sorted.length) * 100;
    const isTight = percentile <= tightPercentile;
    if (!isTight) continue;

    const openOutsideUpper = openBar.open > bbUpper * (1 + bandOutsideTol);
    const openOutsideLower = openBar.open < bbLower * (1 - bandOutsideTol);
    if (gapUp && !openOutsideUpper) continue;
    if (gapDown && !openOutsideLower) continue;

    const entryWindow = dayBars1m.filter((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute >= 30 && parts.minute < entryWindowEnd;
    });
    let entryBar: Bar | undefined;
    let triggerRule: 'A' | 'B' | null = null;
    for (let i = 1; i < entryWindow.length; i += 1) {
      const prev = entryWindow[i - 1];
      const curr = entryWindow[i];
      if (gapUp) {
        if (curr.close < curr.open && curr.close < prev.low) {
          entryBar = curr;
          triggerRule = 'A';
          break;
        }
      } else if (gapDown) {
        if (curr.close > curr.open && curr.close > prev.high) {
          entryBar = curr;
          triggerRule = 'A';
          break;
        }
      }
    }
    if (!entryBar || !triggerRule) continue;
    if (!withinVisibleRange(entryBar.time, visibleRange)) continue;

    const direction: StrategyDirection = gapUp ? 'PUT' : 'CALL';
    const reasons = [
      'Tight Bollinger bands on 15M at the open (low volatility / sideways).',
      `Open gap was extreme (gapPct=${(gapPct * 100).toFixed(2)}%).`,
      `Open price was outside the Bollinger ${gapUp ? 'upper' : 'lower'} band.`,
      `Entry confirmed by 1M reversal trigger (${triggerRule}).`,
    ];

    const entryIndex = bars1m.findIndex((bar) => bar.time === entryBar.time);
    const outcome =
      entryIndex >= 0
        ? computeOutcome(
            bars1m,
            entryIndex,
            entryBar.close,
            direction,
            outcomeHorizonBars,
            settings.global.successThresholdPct
          )
        : {
            horizonBars: outcomeHorizonBars,
            barsAvailable: 0,
            entryPrice: entryBar.close,
            notes: 'Entry time not found in 1m data',
          };

    signals.push({
      id: `${symbol}-s3-${dayKey}-${entryBar.time}`,
      symbol,
      strategyId: 'strategy3_open_gap_fade_lowvol_15m_1m',
      direction,
      entryTime: entryBar.time,
      anchorTime1H: open15m.time,
      reasons,
      debug: {
        anchor1H: {
          time: open15m.time,
          open: open15m.open,
          high: open15m.high,
          low: open15m.low,
          close: open15m.close,
          ma20: bbMid,
          ma40: bbMid,
          slopeMa20: 0,
          prevTrendChecks: [`15M bandwidth percentile ${percentile.toFixed(1)}%`],
        },
        confirm15M: {
          time: entryBar.time,
          open: entryBar.open,
          high: entryBar.high,
          low: entryBar.low,
          close: entryBar.close,
          rule: 'ma20',
        },
        params: {
          warmup: settings.global.warmup,
          window15m: settings.strategy1.window15m,
          cooldownHours: 0,
          trendLookback: tightLookback,
        },
        strategy3: {
          dayKey,
          priorClose,
          open1m: openBar.open,
          gapPct,
          bbUpper15m: bbUpper,
          bbMid15m: bbMid,
          bbLower15m: bbLower,
          bbBandwidth15m: bbBw,
          percentile,
          entryCandle1m: {
            time: entryBar.time,
            open: entryBar.open,
            high: entryBar.high,
            low: entryBar.low,
            close: entryBar.close,
            volume: entryBar.volume,
            triggerRule,
          },
          params: {
            minGapPct,
            entryWindowMinutes: settings.strategy3.entryWindowMinutes,
            tightLookback,
            tightPercentile,
            bandOutsideTol,
            maxSignalsPerDay,
          },
        },
        outcome,
      },
    });
  }

  return signals;
}

function detectStrategy4MagnetEffect({
  symbol,
  visibleRange,
  bars1h,
  bars15m,
  ma20_1h,
  ma40_1h,
  ma20_15m,
  stoch15m,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1h: Bar[];
  bars15m: Bar[];
  ma20_1h: Array<number | null>;
  ma40_1h: Array<number | null>;
  ma20_15m: Array<number | null>;
  stoch15m: { kValues: Array<number | null>; dValues: Array<number | null> };
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const cooldownSeconds = settings.strategy4.cooldownHours * 3600;
  const minDistPct = settings.strategy4.minDistPct;
  const firstBarWindow = settings.strategy4.firstBarWindow;
  const confirmWindow = settings.strategy4.confirmWindow;
  const lastSignalTime: Record<StrategyDirection, number> = { CALL: 0, PUT: 0 };
  const bands15m = calculateBollinger(bars15m, 20, 2);

  const nearestIndex = (bars: Bar[], t: number) => {
    let idx = -1;
    for (let i = 0; i < bars.length; i += 1) {
      if (bars[i].time <= t) idx = i;
    }
    return idx;
  };

  const dayGroups = new Map<string, number[]>();
  for (let i = 0; i < bars15m.length; i += 1) {
    const dayKey = getNyDayKey(bars15m[i].time);
    if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
    dayGroups.get(dayKey)?.push(i);
  }

  for (const [, indices] of dayGroups) {
    indices.sort((a, b) => a - b);
    const openIdx = indices.find((idx) => {
      const parts = getNyParts(bars15m[idx].time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (openIdx === undefined) continue;

    const firstWindowIndices = indices.slice(
      indices.indexOf(openIdx),
      indices.indexOf(openIdx) + firstBarWindow
    );
    let firstOutsideIdx: number | null = null;
    let outsideDir: 'upper' | 'lower' | null = null;
    for (const idx of firstWindowIndices) {
      const upper = bands15m.upper[idx];
      const lower = bands15m.lower[idx];
      if (upper !== null && bars15m[idx].close > upper) {
        firstOutsideIdx = idx;
        outsideDir = 'upper';
        break;
      }
      if (lower !== null && bars15m[idx].close < lower) {
        firstOutsideIdx = idx;
        outsideDir = 'lower';
        break;
      }
    }
    if (firstOutsideIdx === null) continue;

    const k = firstOutsideIdx;
    const ma20 = ma20_15m[k];
    if (ma20 === null) continue;
    const distPct = Math.abs(bars15m[k].close - ma20) / ma20;
    if (distPct < minDistPct) continue;

    const idx1h = nearestIndex(bars1h, bars15m[k].time);
    if (idx1h < 3) continue;
    const slope =
      ma20_1h[idx1h] !== null && ma20_1h[idx1h - 3] !== null
        ? (ma20_1h[idx1h]! - ma20_1h[idx1h - 3]!) / 3
        : 0;
    const closesBelow = [
      bars1h[idx1h - 1].close < (ma40_1h[idx1h - 1] ?? Infinity),
      bars1h[idx1h - 2].close < (ma40_1h[idx1h - 2] ?? Infinity),
      bars1h[idx1h - 3].close < (ma40_1h[idx1h - 3] ?? Infinity),
    ];
    const closesAbove = [
      bars1h[idx1h - 1].close > (ma40_1h[idx1h - 1] ?? -Infinity),
      bars1h[idx1h - 2].close > (ma40_1h[idx1h - 2] ?? -Infinity),
      bars1h[idx1h - 3].close > (ma40_1h[idx1h - 3] ?? -Infinity),
    ];
    const intradayDowntrend = closesBelow.every(Boolean) && slope <= 0.0;
    const intradayUptrend = closesAbove.every(Boolean) && slope >= 0.0;
    const slopeWeak = Math.abs(slope) <= 0.01;

    const isCallStretch = bars15m[k].close < ma20 && outsideDir === 'lower';
    const isPutStretch = bars15m[k].close > ma20 && outsideDir === 'upper';

    const confirmStart = k + 1;
    const confirmEnd = Math.min(bars15m.length - 1, k + confirmWindow);
    let confirmIdx: number | null = null;
    let confirmRule: 'stoch' = 'stoch';
    for (let i = confirmStart; i <= confirmEnd; i += 1) {
      const kPrev = stoch15m.kValues[i - 1];
      const kVal = stoch15m.kValues[i];
      const dPrev = stoch15m.dValues[i - 1];
      const dVal = stoch15m.dValues[i];
      if (kPrev === null || kVal === null) continue;
      const bullish =
        (kPrev <= 20 && kVal > 20) ||
        (dPrev !== null && dVal !== null && kPrev <= dPrev && kVal > dVal);
      const bearish =
        (kPrev >= 80 && kVal < 80) ||
        (dPrev !== null && dVal !== null && kPrev >= dPrev && kVal < dVal);
      if (isCallStretch && bullish) {
        confirmIdx = i;
        break;
      }
      if (isPutStretch && bearish) {
        confirmIdx = i;
        break;
      }
    }

    if (confirmIdx === null) continue;
    const entryTime = bars15m[confirmIdx].time;
    if (!withinVisibleRange(entryTime, visibleRange)) continue;

    const direction: StrategyDirection = isCallStretch ? 'CALL' : 'PUT';
    if (entryTime - lastSignalTime[direction] < cooldownSeconds) continue;
    lastSignalTime[direction] = entryTime;

    const trendGatePass =
      direction === 'CALL'
        ? (intradayDowntrend || slopeWeak)
        : (intradayUptrend || slopeWeak);

    if (!trendGatePass) continue;

    signals.push({
      id: `${symbol}-s4-${entryTime}`,
      symbol,
      strategyId: 'strategy4_magnet_effect_gap_far_from_ma20_15m',
      direction,
      entryTime,
      anchorTime1H: bars15m[k].time,
      reasons: [
        `Price stretched ${(distPct * 100).toFixed(2)}% away from MA20 on 15M (magnet condition).`,
        `Early extension: first 15M candle closed outside Bollinger ${outsideDir} band.`,
        `Trend context gate passed (1H ${direction === 'CALL' ? 'downtrend/weakening' : 'uptrend/weakening'}).`,
        'Worden Stochastic confirmed reversal.',
        'Entry marked at first confirmation candle.',
      ],
      debug: {
        anchor1H: {
          time: bars15m[k].time,
          open: bars15m[k].open,
          high: bars15m[k].high,
          low: bars15m[k].low,
          close: bars15m[k].close,
          ma20: ma20,
          ma40: ma20,
          slopeMa20: slope,
          prevTrendChecks: [],
        },
        confirm15M: {
          time: entryTime,
          open: bars15m[confirmIdx].open,
          high: bars15m[confirmIdx].high,
          low: bars15m[confirmIdx].low,
          close: bars15m[confirmIdx].close,
          ma20: ma20_15m[confirmIdx] ?? undefined,
          stochK: stoch15m.kValues[confirmIdx] ?? undefined,
          stochD: stoch15m.dValues[confirmIdx] ?? undefined,
          rule: confirmRule,
        },
        params: {
          warmup: settings.global.warmup,
          window15m: confirmWindow,
          cooldownHours: settings.strategy4.cooldownHours,
          trendLookback: settings.strategy1.trendLookback,
        },
        strategy4: {
          trend1h: {
            slope_ma20_1h: slope,
            ma20_1h: ma20_1h[idx1h],
            ma40_1h: ma40_1h[idx1h],
            closes_below_ma40: closesBelow,
            closes_above_ma40: closesAbove,
          },
          stretch15m: {
            time: bars15m[k].time,
            close: bars15m[k].close,
            ma20,
            distPct,
            bbUpper: bands15m.upper[k],
            bbLower: bands15m.lower[k],
          },
          earlyExtension: {
            firstOutsideTime: bars15m[firstOutsideIdx].time,
            direction: outsideDir,
          },
          confirmation: {
            time: entryTime,
            rule: confirmRule,
            stochK: stoch15m.kValues[confirmIdx],
            stochD: stoch15m.dValues[confirmIdx],
          },
          params: {
            minDistFromMA20Pct: minDistPct,
            firstBarWindow: firstBarWindow,
            confirmWindow: confirmWindow,
            cooldownHours: settings.strategy4.cooldownHours,
          },
        },
      },
    });
  }

  return signals;
}

function detectStrategy5LateralOpenNoVol({
  symbol,
  visibleRange,
  bars1d,
  bars15m,
  bars1m,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1d: Bar[];
  bars15m: Bar[];
  bars1m: Bar[];
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const {
    minGapPct,
    tightLookback,
    tightPercentile,
    bandOutsideTol,
    maxSignalsPerDay,
    flatLookback,
    flatEpsilon,
    entryWindowMinutes,
  } = settings.strategy5;
  const entryWindowEnd = 30 + entryWindowMinutes;
  if (bars1m.length === 0 || bars15m.length === 0) return signals;

  const bands15m = calculateBollinger(bars15m, 20, 2);
  const bandwidth15m = bands15m.mid.map((mid, idx) => {
    if (mid === null || bands15m.upper[idx] === null || bands15m.lower[idx] === null) {
      return null;
    }
    return ((bands15m.upper[idx] as number) - (bands15m.lower[idx] as number)) / (mid as number);
  });

  const bars1mByDay = new Map<string, Bar[]>();
  for (const bar of bars1m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars1mByDay.has(dayKey)) bars1mByDay.set(dayKey, []);
    bars1mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars1mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars15mByDay = new Map<string, Bar[]>();
  for (const bar of bars15m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars15mByDay.has(dayKey)) bars15mByDay.set(dayKey, []);
    bars15mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars15mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars1dByDay = new Map<string, Bar>();
  for (const bar of bars1d) {
    bars1dByDay.set(getNyDayKey(bar.time), bar);
  }

  for (const [dayKey, dayBars1m] of bars1mByDay) {
    if (signals.filter((s) => s.debug.strategy5?.dayKey === dayKey).length >= maxSignalsPerDay) {
      continue;
    }
    const openBar = dayBars1m.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!openBar) continue;
    if (!withinVisibleRange(openBar.time, visibleRange)) continue;

    const priorDayKey = getNyDayKey(openBar.time - 86400);
    const priorBars = bars1mByDay.get(priorDayKey);
    const priorCloseBar = priorBars
      ? [...priorBars].reverse().find((bar) => {
          const parts = getNyParts(bar.time);
          return parts.hour === 16 && parts.minute === 0;
        })
      : undefined;
    const priorClose = priorCloseBar?.close ?? bars1dByDay.get(priorDayKey)?.close ?? null;
    if (!priorClose) continue;

    const gapPct = (openBar.open - priorClose) / priorClose;
    const gapUp = gapPct >= minGapPct;
    const gapDown = gapPct <= -minGapPct;
    if (!gapUp && !gapDown) continue;

    const dayBars15m = bars15mByDay.get(dayKey) ?? [];
    const open15m = dayBars15m.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!open15m) continue;
    const open15mIndex = bars15m.findIndex((bar) => bar.time === open15m.time);
    if (open15mIndex < 0) continue;

    const bbUpper = bands15m.upper[open15mIndex];
    const bbLower = bands15m.lower[open15mIndex];
    const bbMid = bands15m.mid[open15mIndex];
    const bbBw = bandwidth15m[open15mIndex];
    if (bbUpper === null || bbLower === null || bbMid === null || bbBw === null) continue;

    const windowStart = Math.max(0, open15mIndex - tightLookback + 1);
    const window = bandwidth15m
      .slice(windowStart, open15mIndex + 1)
      .filter((v): v is number => v !== null);
    if (window.length < Math.min(20, tightLookback)) continue;
    const sorted = [...window].sort((a, b) => a - b);
    const rank = sorted.findIndex((v) => v >= bbBw);
    const percentile = ((rank < 0 ? sorted.length : rank + 1) / sorted.length) * 100;
    const isTight = percentile <= tightPercentile;
    if (!isTight) continue;

    let midSlope = 0;
    if (open15mIndex - flatLookback >= 0) {
      const prevMid = bands15m.mid[open15mIndex - flatLookback];
      if (prevMid !== null) {
        midSlope = (bbMid - prevMid) / flatLookback;
      }
    }
    const isFlat = Math.abs(midSlope / bbMid) <= flatEpsilon;
    if (!isFlat) continue;

    const openOutsideUpper = openBar.open > bbUpper * (1 + bandOutsideTol);
    const openOutsideLower = openBar.open < bbLower * (1 - bandOutsideTol);
    if (gapUp && !openOutsideUpper) continue;
    if (gapDown && !openOutsideLower) continue;

    const entryWindow = dayBars1m.filter((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute >= 30 && parts.minute < entryWindowEnd;
    });
    let entryBar: Bar | undefined;
    let triggerRule: 'A' | 'B' | null = null;
    for (let i = 1; i < entryWindow.length; i += 1) {
      const prev = entryWindow[i - 1];
      const curr = entryWindow[i];
      if (gapUp) {
        if (curr.close < curr.open && curr.close < prev.low) {
          entryBar = curr;
          triggerRule = 'A';
          break;
        }
      } else if (gapDown) {
        if (curr.close > curr.open && curr.close > prev.high) {
          entryBar = curr;
          triggerRule = 'A';
          break;
        }
      }
    }
    if (!entryBar || !triggerRule) continue;
    if (!withinVisibleRange(entryBar.time, visibleRange)) continue;

    const direction: StrategyDirection = gapUp ? 'PUT' : 'CALL';
    const reasons = [
      '15M was fully sideways with very low volatility (tight Bollinger, flat midline).',
      'Open gap was extreme and opened outside the Bollinger band.',
      'Entry taken within first 5 minutes per strategy rule.',
      `Reversal confirmed by ${triggerRule === 'A' ? 'price-action break' : 'VWAP cross'}.`,
    ];

    signals.push({
      id: `${symbol}-s5-${dayKey}-${entryBar.time}`,
      symbol,
      strategyId: 'strategy5_lateral_open_outside_bollinger_no_vol',
      direction,
      entryTime: entryBar.time,
      anchorTime1H: open15m.time,
      reasons,
      debug: {
        anchor1H: {
          time: open15m.time,
          open: open15m.open,
          high: open15m.high,
          low: open15m.low,
          close: open15m.close,
          ma20: bbMid,
          ma40: bbMid,
          slopeMa20: midSlope,
          prevTrendChecks: [],
        },
        confirm15M: {
          time: entryBar.time,
          open: entryBar.open,
          high: entryBar.high,
          low: entryBar.low,
          close: entryBar.close,
          rule: 'ma20',
        },
        params: {
          warmup: settings.global.warmup,
          window15m: tightLookback,
          cooldownHours: 0,
          trendLookback: flatLookback,
        },
        strategy5: {
          dayKey,
          priorClose,
          open1m: openBar.open,
          gapPct,
          bbUpper15m: bbUpper,
          bbMid15m: bbMid,
          bbLower15m: bbLower,
          bbBandwidth15m: bbBw,
          percentile,
          midlineSlope: midSlope,
          entryCandle1m: {
            time: entryBar.time,
            open: entryBar.open,
            high: entryBar.high,
            low: entryBar.low,
            close: entryBar.close,
            volume: entryBar.volume,
            triggerRule,
          },
          params: {
            minGapPct,
            entryWindowMinutes: entryWindowMinutes,
            tightLookback,
            tightPercentile,
            bandOutsideTol,
            maxSignalsPerDay,
            flatMidlineLookback: flatLookback,
            flatMidlineEpsilon: flatEpsilon,
          },
        },
      },
    });
  }

  return signals;
}

function detectStrategyCT15({
  symbol,
  visibleRange,
  bars1d,
  bars15m,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars1d: Bar[];
  bars15m: Bar[];
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const { minGapPct, bwSlopeLookback, bwAvgRatio, maxSignalsPerDay, strictExposedMode } = settings.ct15;
  if (bars15m.length === 0) return signals;
  const todayKey = getNyDayKey(Math.floor(Date.now() / 1000));

  const bands15m = calculateBollinger(bars15m, 20, 2);
  const bandwidth15m = bands15m.mid.map((mid, idx) => {
    if (mid === null || bands15m.upper[idx] === null || bands15m.lower[idx] === null) {
      return null;
    }
    return ((bands15m.upper[idx] as number) - (bands15m.lower[idx] as number)) / (mid as number);
  });
  const bandwidthSma20 = calculateSMAValues(bandwidth15m, 20);

  const bars15mByDay = new Map<string, Bar[]>();
  for (const bar of bars15m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars15mByDay.has(dayKey)) bars15mByDay.set(dayKey, []);
    bars15mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars15mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars1dByDay = new Map<string, Bar>();
  for (const bar of bars1d) {
    bars1dByDay.set(getNyDayKey(bar.time), bar);
  }

  const computeRegression = (values: number[]) => {
    const n = values.length;
    if (n < 2) return null;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i += 1) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;
    const b = (n * sumXY - sumX * sumY) / denom;
    const a = (sumY - b * sumX) / n;
    return { a, b };
  };

  for (const [dayKey, dayBars] of bars15mByDay) {
    if (dayKey !== todayKey) continue;
    if (signals.filter((s) => s.debug.ct15?.dayKey === dayKey).length >= maxSignalsPerDay) {
      continue;
    }
    const bar0 = dayBars.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!bar0) continue;
    if (!withinVisibleRange(bar0.time, visibleRange)) continue;

    // CT15 requires the 9:30 bar to be closed (next bar must exist)
    const nextBar = dayBars.find((bar) => bar.time > bar0.time);
    if (!nextBar) continue;

    const openIndex = bars15m.findIndex((bar) => bar.time === bar0.time);
    if (openIndex < 0) continue;

    const priorDayKey = getNyDayKey(bar0.time - 86400);
    const priorBars = bars15mByDay.get(priorDayKey);
    if (!priorBars || priorBars.length < 2) continue;
    const priorClose = priorBars[priorBars.length - 1]?.close ?? bars1dByDay.get(priorDayKey)?.close ?? null;
    if (!priorClose) continue;

    const gapPct = (bar0.open - priorClose) / priorClose;
    if (Math.abs(gapPct) < minGapPct) continue;

    const bbMid = bands15m.mid[openIndex];
    const bbUpper = bands15m.upper[openIndex];
    const bbLower = bands15m.lower[openIndex];
    const bw = bandwidth15m[openIndex];
    const bwAvg = bandwidthSma20[openIndex];
    if (bbMid === null || bbUpper === null || bbLower === null || bw === null || bwAvg === null) continue;
    if (openIndex - bwSlopeLookback < 0) continue;
    const bwPrev = bandwidth15m[openIndex - bwSlopeLookback];
    if (bwPrev === null) continue;
    const bwSlope = (bw - bwPrev) / bwSlopeLookback;
    const volOpen = bw > bwAvg * (bwAvgRatio ?? 1.0) && bwSlope > 0;
    if (!volOpen) continue;

    const priorCloseIndex = bars15m.findIndex(
      (bar) => bar.time === priorBars[priorBars.length - 1].time
    );
    if (priorCloseIndex < 0) continue;
    const priorMid = bands15m.mid[priorCloseIndex];
    if (priorMid === null) continue;

    const regression = computeRegression(priorBars.map((bar) => bar.close));
    if (!regression) continue;
    const trendlineLevelAtOpen = regression.a + regression.b * priorBars.length;

    const openInside = bar0.open >= bbLower && bar0.open <= bbUpper;
    const exposed = !openInside;

    const callSetup =
      regression.b <= 0 &&
      priorBars[priorBars.length - 1].close < priorMid &&
      gapPct >= minGapPct &&
      bar0.open > bbMid &&
      bar0.open > trendlineLevelAtOpen;

    const putSetup =
      regression.b >= 0 &&
      priorBars[priorBars.length - 1].close > priorMid &&
      gapPct <= -minGapPct &&
      bar0.open < bbMid &&
      bar0.open < trendlineLevelAtOpen;

    if (strictExposedMode && exposed) continue;

    if (!callSetup && !putSetup) continue;

    const direction: StrategyDirection = callSetup ? 'CALL' : 'PUT';
    const outcome = computeOutcome(
      bars15m,
      openIndex,
      bar0.open,
      direction,
      settings.strategy1.window15m * 2,
      settings.global.successThresholdPct
    );
    const reasons = [
      'CT15 is opening-only: evaluated the first 15M bar.',
      `Gap detected: gapPct=${(gapPct * 100).toFixed(2)}% (>= ${(minGapPct * 100).toFixed(2)}%).`,
      `Prior day slope indicates ${regression.b <= 0 ? 'down/flat' : 'up/flat'}.`,
      `Prior day last close was ${callSetup ? 'below' : 'above'} 15M midline (required).`,
      'Open broke 15M midline and prior-day trendline proxy.',
      'Volatility opened (Bollinger bandwidth expanding).',
      `Open was ${exposed ? 'exposed (low quality)' : 'inside Bollinger (high quality)'}.`,
    ];

    signals.push({
      id: `${symbol}-ct15-${dayKey}-${bar0.time}`,
      symbol,
      strategyId: 'ct15_open_gap_trendline_midline_volatility_15m',
      direction,
      entryTime: nextBar.time,
      anchorTime1H: bar0.time,
      reasons,
      debug: {
        anchor1H: {
          time: bar0.time,
          open: bar0.open,
          high: bar0.high,
          low: bar0.low,
          close: bar0.close,
          ma20: bbMid,
          ma40: bbMid,
          slopeMa20: regression.b,
          prevTrendChecks: [],
        },
        confirm15M: {
          time: bar0.time,
          open: bar0.open,
          high: bar0.high,
          low: bar0.low,
          close: bar0.close,
          rule: 'open',
        },
        params: {
          minGapPct,
          bwSlopeLookback,
          bwAvgRatio,
          maxSignalsPerDay,
          strictExposedMode,
        },
        outcome,
        ct15: {
          dayKey,
          priorClose,
          openBar0: bar0.open,
          gapPct,
          regression: {
            a: regression.a,
            b: regression.b,
            trendlineLevelAtOpen,
            source: 'close',
          },
          priorDayLastMid: priorMid,
          bbMid15m: bbMid,
          bbUpper15m: bbUpper,
          bbLower15m: bbLower,
          bandwidth: bw,
          bandwidthSma: bwAvg,
          bandwidthSlope: bwSlope,
          volOpen,
          exposed,
        },
      },
    });
  }

  return signals;
}


function detectStrategyCTOpen({
  symbol,
  visibleRange,
  bars15m,
  bars1m,
  settings,
}: {
  symbol: string;
  visibleRange: { from: number; to: number };
  bars15m: Bar[];
  bars1m: Bar[];
  settings: StrategySettings;
}): StrategySignal[] {
  const signals: StrategySignal[] = [];
  const { requireSqueeze, squeezeLookback, squeezePercentile, entryWindowMinutes, minBreakoutBars, minDisplacementPct, maxSignalsPerDay } = settings.ct_open;
  if (bars15m.length === 0 || bars1m.length === 0) return signals;

  // 15m Bollinger for squeeze detection
  const bands15m = calculateBollinger(bars15m, 20, 2);
  const bandwidth15m = bands15m.mid.map((mid, idx) => {
    if (mid === null || bands15m.upper[idx] === null || bands15m.lower[idx] === null) {
      return null;
    }
    return ((bands15m.upper[idx] as number) - (bands15m.lower[idx] as number)) / (mid as number);
  });

  // 1m Bollinger for expansion confirmation
  const bands1m = calculateBollinger(bars1m, 20, 2);
  const bandwidth1m = bands1m.mid.map((mid, idx) => {
    if (mid === null || bands1m.upper[idx] === null || bands1m.lower[idx] === null) {
      return null;
    }
    return ((bands1m.upper[idx] as number) - (bands1m.lower[idx] as number)) / (mid as number);
  });

  // Build time -> index map for fast 1m bar lookup
  const bars1mTimeToIdx = new Map<number, number>();
  for (let i = 0; i < bars1m.length; i++) {
    bars1mTimeToIdx.set(bars1m[i].time, i);
  }

  // Group bars by day
  const bars15mByDay = new Map<string, Bar[]>();
  for (const bar of bars15m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars15mByDay.has(dayKey)) bars15mByDay.set(dayKey, []);
    bars15mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars15mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  const bars1mByDay = new Map<string, Bar[]>();
  for (const bar of bars1m) {
    const dayKey = getNyDayKey(bar.time);
    if (!bars1mByDay.has(dayKey)) bars1mByDay.set(dayKey, []);
    bars1mByDay.get(dayKey)?.push(bar);
  }
  for (const [, list] of bars1mByDay) {
    list.sort((a, b) => a.time - b.time);
  }

  for (const [dayKey, dayBars15m] of bars15mByDay) {
    if (signals.filter((s) => s.debug.ct_open?.dayKey === dayKey).length >= maxSignalsPerDay) {
      continue;
    }

    // Find the 9:30 opening 15m bar
    const bar0 = dayBars15m.find((bar) => {
      const parts = getNyParts(bar.time);
      return parts.hour === 9 && parts.minute === 30;
    });
    if (!bar0) continue;
    if (!withinVisibleRange(bar0.time, visibleRange)) continue;

    const openIndex = bars15m.findIndex((bar) => bar.time === bar0.time);
    if (openIndex < 0) continue;

    const bbUpper = bands15m.upper[openIndex] as number | null;
    const bbLower = bands15m.lower[openIndex] as number | null;
    const bbMid = bands15m.mid[openIndex] as number | null;
    const bw = bandwidth15m[openIndex];
    if (bbUpper === null || bbLower === null || bbMid === null || bw === null) continue;

    let percentile = 0;
    let insideBands = true;
    if (requireSqueeze) {
      // Phase 1a: Squeeze check — BW must be below squeezePercentile
      const windowStart = Math.max(0, openIndex - squeezeLookback + 1);
      const bwHistory = bandwidth15m.slice(windowStart, openIndex + 1).filter((v): v is number => v !== null);
      if (bwHistory.length < Math.min(20, squeezeLookback)) continue;
      const sortedBw = [...bwHistory].sort((a, b) => a - b);
      const rank = sortedBw.findIndex((v) => v >= bw);
      percentile = ((rank === -1 ? sortedBw.length : rank) + 1) / sortedBw.length * 100;
      if (percentile > squeezePercentile) continue;

      // Phase 1b: Price must open INSIDE the bands
      insideBands = bar0.open >= bbLower && bar0.open <= bbUpper;
      if (!insideBands) continue;
    }

    // Phase 2: Scan 1m bars for breakout with BW expansion
    const dayBars1m = bars1mByDay.get(dayKey) ?? [];
    if (dayBars1m.length === 0) continue;

    const entryWindowEndMinute = 30 + entryWindowMinutes;
    const entryWindow = dayBars1m.filter((bar) => {
      const p = getNyParts(bar.time);
      const totalMinutes = p.hour * 60 + p.minute;
      return totalMinutes >= 9 * 60 + 30 && totalMinutes < 9 * 60 + entryWindowEndMinute;
    });
    if (entryWindow.length === 0) continue;

    // Get 1m BW at 9:30 as baseline for expansion comparison
    let bw1mBaseline: number | null = null;
    if (requireSqueeze) {
      const open1mIdx = bars1mTimeToIdx.get(entryWindow[0].time);
      if (open1mIdx === undefined) continue;
      bw1mBaseline = bandwidth1m[open1mIdx];
      if (bw1mBaseline === null) continue;
    }

    // Use the opening price as the reference for direction — avoids
    // stale MA20 values from the prior session contaminating the signal.
    const openPrice = bar0.open;

    let entryBar: Bar | null = null;
    let direction: StrategyDirection | null = null;
    let consecAbove = 0;
    let consecBelow = 0;
    for (const bar1m of entryWindow) {
      const idx1m = bars1mTimeToIdx.get(bar1m.time);
      if (idx1m === undefined) continue;
      // Require 1m BW expansion: current > baseline at 9:30
      if (requireSqueeze && bw1mBaseline !== null) {
        const bw1mCurrent = bandwidth1m[idx1m];
        if (bw1mCurrent === null || bw1mCurrent <= bw1mBaseline) {
          consecAbove = 0;
          consecBelow = 0;
          continue;
        }
      }
      // Track consecutive closes above/below the opening price
      if (bar1m.close > openPrice) {
        consecAbove += 1;
        consecBelow = 0;
      } else if (bar1m.close < openPrice) {
        consecBelow += 1;
        consecAbove = 0;
      } else {
        consecAbove = 0;
        consecBelow = 0;
      }
      // Check displacement gate: price must have moved enough from open
      const displacementPct = Math.abs(bar1m.close - openPrice) / openPrice * 100;
      if (consecAbove >= minBreakoutBars && displacementPct >= minDisplacementPct) {
        entryBar = bar1m;
        direction = 'CALL';
        break;
      }
      if (consecBelow >= minBreakoutBars && displacementPct >= minDisplacementPct) {
        entryBar = bar1m;
        direction = 'PUT';
        break;
      }
    }
    if (!entryBar || !direction) continue;
    if (!withinVisibleRange(entryBar.time, visibleRange)) continue;

    const outcome = computeOutcome(
      bars15m,
      openIndex,
      entryBar.close,
      direction,
      settings.strategy1.window15m * 2,
      settings.global.successThresholdPct
    );

    const entryIdx1m = bars1mTimeToIdx.get(entryBar.time);
    const bw1mAtEntry = entryIdx1m !== undefined ? bandwidth1m[entryIdx1m] : null;
    const reasons: string[] = [
      requireSqueeze
        ? 'CT-Open: Bollinger Squeeze Breakout at market open.'
        : 'CT-Open: 1m Momentum Breakout at market open (squeeze disabled).',
    ];
    if (requireSqueeze) {
      reasons.push(`Squeeze detected: BW percentile ${percentile.toFixed(0)}% (< ${squeezePercentile}% threshold).`);
      reasons.push(`Price opened inside bands: ${bar0.open.toFixed(2)} between ${bbLower.toFixed(2)} and ${bbUpper.toFixed(2)}.`);
      reasons.push(`1m BW expanding: ${bw1mBaseline?.toFixed(5) ?? '?'} → ${bw1mAtEntry?.toFixed(5) ?? '?'} (volatility confirmed).`);
    }
    reasons.push(`Breakout confirmed: ${minBreakoutBars} consecutive 1m bars closed ${direction === 'CALL' ? 'above' : 'below'} opening price ${bar0.open.toFixed(2)}.`);

    signals.push({
      id: `${symbol}-ct-open-${direction.toLowerCase()}-${entryBar.time}`,
      symbol,
      strategyId: 'ct_open_squeeze_breakout_15m_1m',
      direction,
      entryTime: entryBar.time,
      anchorTime1H: bar0.time,
      reasons,
      debug: {
        anchor1H: {
          time: bar0.time,
          open: bar0.open,
          high: bar0.high,
          low: bar0.low,
          close: bar0.close,
          ma20: bbMid,
          ma40: bbMid,
          slopeMa20: 0,
          prevTrendChecks: [],
        },
        confirm15M: {
          time: entryBar.time,
          open: entryBar.open,
          high: entryBar.high,
          low: entryBar.low,
          close: entryBar.close,
          rule: 'open',
        },
        params: {
          squeezeLookback,
          squeezePercentile,
          entryWindowMinutes,
          maxSignalsPerDay,
        },
        outcome,
        ct_open: {
          dayKey,
          bbUpper15m: bbUpper,
          bbMid15m: bbMid,
          bbLower15m: bbLower,
          bandwidth: bw,
          squeezePercentile: percentile,
          priceAtOpen: bar0.open,
          insideBands,
          entryBar1m: {
            time: entryBar.time,
            close: entryBar.close,
          },
          breakDirection: direction,
        },
      },
    });
  }

  return signals;
}


function computeOutcome(
  bars15m: Bar[],
  confirmIndex: number,
  entryPrice: number,
  direction: StrategyDirection,
  horizonBars: number,
  successThresholdPct: number
) {
  const start = confirmIndex + 1;
  const end = Math.min(bars15m.length, start + horizonBars);
  const slice = bars15m.slice(start, end);
  if (slice.length === 0) {
    return {
      horizonBars,
      barsAvailable: 0,
      entryPrice,
      notes: 'Insufficient bars after entry',
    };
  }

  let maxFavorable = -Infinity;
  let maxAdverse = Infinity;
  const horizonReturns: number[] = [];
  for (const bar of slice) {
    if (direction === 'CALL') {
      const favorable = (bar.high - entryPrice) / entryPrice;
      const adverse = (bar.low - entryPrice) / entryPrice;
      maxFavorable = Math.max(maxFavorable, favorable);
      maxAdverse = Math.min(maxAdverse, adverse);
      horizonReturns.push((bar.close - entryPrice) / entryPrice);
    } else {
      const favorable = (entryPrice - bar.low) / entryPrice;
      const adverse = (entryPrice - bar.high) / entryPrice;
      maxFavorable = Math.max(maxFavorable, favorable);
      maxAdverse = Math.min(maxAdverse, adverse);
      horizonReturns.push((entryPrice - bar.close) / entryPrice);
    }
  }

  const endPrice = slice[slice.length - 1].close;
  const endReturn =
    direction === 'CALL'
      ? (endPrice - entryPrice) / entryPrice
      : (entryPrice - endPrice) / entryPrice;
  const success =
    maxFavorable >= successThresholdPct && maxFavorable >= Math.abs(maxAdverse);

  return {
    horizonBars,
    barsAvailable: slice.length,
    entryPrice,
    endPrice,
    endReturnPct: endReturn,
    maxFavorablePct: maxFavorable,
    maxAdversePct: maxAdverse,
    horizonReturnsPct: horizonReturns,
    success,
  };
}
