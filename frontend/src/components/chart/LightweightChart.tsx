/**
 * TradingView Lightweight Charts component
 */
import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
  TickMarkType,
  CustomData,
  CustomSeriesOptions,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  IPriceLine,
  CustomSeriesWhitespaceData,
  SeriesMarker,
  BusinessDay,
  SeriesMarkerPosition,
  SeriesMarkerShape,
} from 'lightweight-charts';
import { useChartStore } from '@/store/chartStore';
import { Box } from '@mui/material';
import { CanvasRenderingTarget2D } from 'fancy-canvas';
import { Bar, Interval } from '@/types/chart.types';
import { analyzeBarAtTime, analyzeVisibleRange } from '@/analysis/strategyAnalysis';
import { fetchTvAlerts, TvAlert } from '@/services/api/marketData';

interface LightweightChartProps {
  showSessionLines?: boolean;
  /** When set, the chart zooms to this time range after loading data instead of auto-fit. */
  focusRange?: { from: number; to: number };
}

export function LightweightChart({ showSessionLines = true, focusRange }: LightweightChartProps = {}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma40Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma100Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbFillRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const daySeparatorRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const sessionLineRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const entryLineRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const anchorLineRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const targetLinesRef = useRef<IPriceLine[]>([]);
  const srLinesRef = useRef<IPriceLine[]>([]);
  const nextSlotRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const extHoursRef = useRef<ISeriesApi<'Custom'> | null>(null);
  const analysisTargetModeRef = useRef(false);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const wordenKRef = useRef<ISeriesApi<'Line'> | null>(null);
  const wordenDRef = useRef<ISeriesApi<'Line'> | null>(null);
  const barByTimeRef = useRef<Map<number, Bar>>(new Map());
  const prevIntervalRef = useRef<Interval | null>(null);
  const nextSlotBusyRef = useRef(false);
  const [nextSlotSignal, setNextSlotSignal] = useState<{
    time: number;
    direction: 'CALL' | 'PUT';
    id: string;
  } | null>(null);
  const [tvAlerts, setTvAlerts] = useState<TvAlert[]>([]);
  const {
    bars,
    symbol,
    interval,
    showMA20,
    showMA40,
    showMA100,
    showMA200,
    showVWAP,
    showBollinger,
    showVolume,
    showWorden,
    useRth,
    setHoverBar,
    setHoverPoint,
    setVisibleRange,
    strategySignals,
    selectedSignalId,
    setSelectedSignalId,
    setSignalClickPosition,
    hoverBar,
    hoverPoint,
    analysisTargetMode,
    setAnalysisTargetMode,
    setBarAnalysis,
    setBarAnalysisLoading,
    setStrategyPanelOpen,
    barAnalysis,
    selectedContract,
    strategySettingsBySymbol,
    srLevels,
  } = useChartStore();

  useEffect(() => {
    analysisTargetModeRef.current = analysisTargetMode;
  }, [analysisTargetMode]);

  useEffect(() => {
    setSelectedSignalId(null);
  }, [symbol, setSelectedSignalId]);

  const nyDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  });

  const nyTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const nyPartsFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const getNyDate = (time: Time) => {
    const date =
      typeof time === 'number'
        ? new Date(time * 1000)
        : typeof time === 'string'
          ? new Date(time)
          : new Date(Date.UTC(time.year, time.month - 1, time.day));
    return date;
  };

  const formatNyDate = (time: Time) => nyDateFormatter.format(getNyDate(time));

  const formatNyTime = (time: Time) => nyTimeFormatter.format(getNyDate(time));

  const getNyHourMinute = (unixSeconds: number) => {
    const parts = nyPartsFormatter.formatToParts(new Date(unixSeconds * 1000));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return { hour, minute };
  };

  const timeToSeconds = (time: Time) => {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  };

  const isExtendedSession = (time: Time) => {
    if (useRth || interval === '1d' || interval === '1w') return false;
    if (typeof time !== 'number') return false;
    const { hour, minute } = getNyHourMinute(time);
    const inRth =
      (hour > 9 || (hour === 9 && minute >= 30)) &&
      (hour < 16 || (hour === 16 && minute === 0));
    return !inRth;
  };

  const applyLineOpacity = (
    data: { time: Time; value: number }[],
    color: string,
    alpha: number
  ) =>
    data.map((point) =>
      isExtendedSession(point.time)
        ? {
            time: point.time,
            value: point.value,
            color: `rgba(${color}, ${alpha})`,
          }
        : point
    );


  type BollingerFillData = CustomData<Time> & {
    upper?: number;
    lower?: number;
  };

  class BollingerBandFillRenderer implements ICustomSeriesPaneRenderer {
    private _data: PaneRendererCustomData<Time, BollingerFillData> | null = null;
    private _color = 'rgba(84, 84, 84, 0.2)';

    update(
      data: PaneRendererCustomData<Time, BollingerFillData>,
      options: CustomSeriesOptions
    ) {
      this._data = data;
      if (options.color) {
        this._color = options.color;
      }
    }

    draw(
      target: CanvasRenderingTarget2D,
      priceConverter: PriceToCoordinateConverter
    ) {
      if (!this._data || this._data.bars.length === 0) return;
      target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
        const bars = this._data?.bars ?? [];
        if (bars.length === 0) return;
        context.save();
        context.fillStyle = this._color;
        context.beginPath();
        let started = false;
        for (let i = 0; i < bars.length; i += 1) {
          const bar = bars[i];
          const y = priceConverter(bar.originalData.upper ?? 0);
          if (y === null || y === undefined) continue;
          const x = bar.x * horizontalPixelRatio;
          const py = y * verticalPixelRatio;
          if (!started) {
            context.moveTo(x, py);
            started = true;
          } else {
            context.lineTo(x, py);
          }
        }
        for (let i = bars.length - 1; i >= 0; i -= 1) {
          const bar = bars[i];
          const y = priceConverter(bar.originalData.lower ?? 0);
          if (y === null || y === undefined) continue;
          const x = bar.x * horizontalPixelRatio;
          const py = y * verticalPixelRatio;
          context.lineTo(x, py);
        }
        if (started) {
          context.closePath();
          context.fill();
        }
        context.restore();
      });
    }
  }

  class BollingerBandFillView {
    private _renderer = new BollingerBandFillRenderer();

    renderer() {
      return this._renderer;
    }

    update(data: PaneRendererCustomData<Time, BollingerFillData>, options: CustomSeriesOptions) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(plotRow: BollingerFillData): number[] {
      return [plotRow.upper ?? 0, plotRow.lower ?? 0];
    }

    isWhitespace(data: BollingerFillData): boolean {
      return data.upper === undefined || data.lower === undefined;
    }

    defaultOptions(): CustomSeriesOptions {
      return { color: 'rgba(84, 84, 84, 0.2)' } as CustomSeriesOptions;
    }
  }

  const calculateMA = (period: number) => {
    const result: { time: Time; value: number }[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i += 1) {
      sum += bars[i].close;
      if (i >= period) {
        sum -= bars[i - period].close;
      }
      if (i >= period - 1) {
        result.push({ time: bars[i].time as Time, value: sum / period });
      }
    }
    return result;
  };

  const calculateVWAP = () => {
    const result: { time: Time; value: number }[] = [];
    let cumulativePV = 0;
    let cumulativeV = 0;
    for (const bar of bars) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      cumulativePV += typical * bar.volume;
      cumulativeV += bar.volume;
      if (cumulativeV > 0) {
        result.push({ time: bar.time as Time, value: cumulativePV / cumulativeV });
      }
    }
    return result;
  };

  const calculateBollinger = (period: number, stdDev: number) => {
    const upper: { time: Time; value: number }[] = [];
    const lower: { time: Time; value: number }[] = [];
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < bars.length; i += 1) {
      const close = bars[i].close;
      sum += close;
      sumSq += close * close;
      if (i >= period) {
        const old = bars[i - period].close;
        sum -= old;
        sumSq -= old * old;
      }
      if (i >= period - 1) {
        const mean = sum / period;
        const variance = sumSq / period - mean * mean;
        const deviation = Math.sqrt(Math.max(variance, 0));
        upper.push({ time: bars[i].time as Time, value: mean + stdDev * deviation });
        lower.push({ time: bars[i].time as Time, value: mean - stdDev * deviation });
      }
    }
    return { upper, lower };
  };

  const calculateWordenStochastic = (
    period: number,
    kSmooth: number,
    dSmooth: number
  ) => {
    const rawK: number[] = [];
    const times: Time[] = [];
    // O(n) sliding-window max/min via monotonic deques (index arrays)
    const maxDq: number[] = [];
    const minDq: number[] = [];
    for (let i = 0; i < bars.length; i += 1) {
      const highI = bars[i].high;
      const lowI = bars[i].low;
      // Keep maxDq decreasing in bar[].high value
      while (maxDq.length > 0 && bars[maxDq[maxDq.length - 1]].high <= highI) {
        maxDq.pop();
      }
      maxDq.push(i);
      // Keep minDq increasing in bar[].low value
      while (minDq.length > 0 && bars[minDq[minDq.length - 1]].low >= lowI) {
        minDq.pop();
      }
      minDq.push(i);
      // Evict indices outside the window (deques are small, ≤ period elements)
      if (maxDq[0] < i - period + 1) maxDq.shift();
      if (minDq[0] < i - period + 1) minDq.shift();
      if (i < period - 1) continue;
      const windowHigh = bars[maxDq[0]].high;
      const windowLow = bars[minDq[0]].low;
      const range = windowHigh - windowLow;
      const value = range === 0 ? 0 : ((bars[i].close - windowLow) / range) * 100;
      rawK.push(value);
      times.push(bars[i].time as Time);
    }

    const ema = (values: number[], length: number) => {
      if (values.length === 0) return [];
      const alpha = 2 / (length + 1);
      const result: number[] = [values[0]];
      for (let i = 1; i < values.length; i += 1) {
        result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
      }
      return result;
    };

    const kSmoothed = kSmooth > 1 ? ema(rawK, kSmooth) : rawK;
    const dSmoothed = dSmooth > 1 ? ema(kSmoothed, dSmooth) : kSmoothed;

    const kValues = kSmoothed.map((value, i) => ({
      time: times[i],
      value,
    }));
    const dValues = dSmoothed.map((value, i) => ({
      time: times[i],
      value,
    }));

    return { kValues, dValues };
  };

  type DaySeparatorData = CustomData<Time> & {
    time: Time;
  };

  class DaySeparatorRenderer implements ICustomSeriesPaneRenderer {
    private _data: PaneRendererCustomData<Time, DaySeparatorData> | null = null;

    update(
      data: PaneRendererCustomData<Time, DaySeparatorData>,
      _options: CustomSeriesOptions
    ) {
      this._data = data;
    }

    draw(target: CanvasRenderingTarget2D) {
      if (!this._data || this._data.bars.length === 0) return;
      target.useBitmapCoordinateSpace(
        ({ context, bitmapSize, horizontalPixelRatio }) => {
          context.save();
          const gradient = context.createLinearGradient(0, 0, 0, bitmapSize.height);
          gradient.addColorStop(0, 'rgba(126, 200, 255, 0)');
          gradient.addColorStop(1, 'rgba(126, 200, 255, 0.5)');
          context.strokeStyle = gradient;
          context.lineWidth = 2 * horizontalPixelRatio;
          context.setLineDash([2 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
          for (const bar of this._data?.bars ?? []) {
            const x = bar.x * horizontalPixelRatio;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, bitmapSize.height);
            context.stroke();
          }
          context.restore();
        }
      );
    }
  }

  class DaySeparatorView {
    private _renderer = new DaySeparatorRenderer();

    renderer() {
      return this._renderer;
    }

    update(
      data: PaneRendererCustomData<Time, DaySeparatorData>,
      options: CustomSeriesOptions
    ) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(_plotRow: DaySeparatorData) {
      return [];
    }

    isWhitespace(data: DaySeparatorData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
      return (data as DaySeparatorData).time === undefined;
    }

    defaultOptions() {
      return { color: '#7ec8ff' } as CustomSeriesOptions;
    }
  }

  type EntryLineData = CustomData<Time> & {
    time: Time;
  };

  class EntryLineRenderer implements ICustomSeriesPaneRenderer {
    private _data: PaneRendererCustomData<Time, EntryLineData> | null = null;

    update(
      data: PaneRendererCustomData<Time, EntryLineData>,
      _options: CustomSeriesOptions
    ) {
      this._data = data;
    }

    draw(target: CanvasRenderingTarget2D) {
      if (!this._data || this._data.bars.length === 0) return;
      target.useBitmapCoordinateSpace(
        ({ context, bitmapSize, horizontalPixelRatio }) => {
          context.save();
          const gradient = context.createLinearGradient(0, 0, 0, bitmapSize.height);
          gradient.addColorStop(0, 'rgba(255, 213, 79, 0.5)');
          gradient.addColorStop(1, 'rgba(255, 213, 79, 0)');
          context.strokeStyle = gradient;
          context.lineWidth = 2 * horizontalPixelRatio;
          context.setLineDash([2 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
          for (const bar of this._data?.bars ?? []) {
            const x = bar.x * horizontalPixelRatio;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, bitmapSize.height);
            context.stroke();
          }
          context.restore();
        }
      );
    }
  }

  class EntryLineView {
    private _renderer = new EntryLineRenderer();

    renderer() {
      return this._renderer;
    }

    update(
      data: PaneRendererCustomData<Time, EntryLineData>,
      options: CustomSeriesOptions
    ) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(_plotRow: EntryLineData) {
      return [];
    }

    isWhitespace(data: EntryLineData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
      return (data as EntryLineData).time === undefined;
    }

    defaultOptions() {
      return { color: '#ffd54f' } as CustomSeriesOptions;
    }
  }

  class AnchorLineView {
    private _renderer = new EntryLineRenderer();

    renderer() {
      return this._renderer;
    }

    update(
      data: PaneRendererCustomData<Time, EntryLineData>,
      options: CustomSeriesOptions
    ) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(_plotRow: EntryLineData) {
      return [];
    }

    isWhitespace(data: EntryLineData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
      return (data as EntryLineData).time === undefined;
    }

    defaultOptions() {
      return { color: '#ffd54f' } as CustomSeriesOptions;
    }
  }

  type ExtHoursData = CustomData<Time> & {
    time: Time;
    extended: boolean;
  };

  class ExtHoursRenderer implements ICustomSeriesPaneRenderer {
    private _data: PaneRendererCustomData<Time, ExtHoursData> | null = null;
    private _color = 'rgba(40, 40, 40, 0.45)';

    update(
      data: PaneRendererCustomData<Time, ExtHoursData>,
      options: CustomSeriesOptions
    ) {
      this._data = data;
      if (options.color) {
        this._color = options.color;
      }
    }

    draw(target: CanvasRenderingTarget2D) {
      if (!this._data || this._data.bars.length === 0) return;
      target.useBitmapCoordinateSpace(
        ({ context, bitmapSize, horizontalPixelRatio }) => {
          context.save();
          const bars = this._data?.bars ?? [];
          for (let i = 0; i < bars.length; i += 1) {
            const barItem = bars[i];
            if (!barItem.originalData.extended) continue;
            const x = barItem.x * horizontalPixelRatio;
            const prevX = i > 0 ? bars[i - 1].x * horizontalPixelRatio : x;
            const nextX =
              i < bars.length - 1 ? bars[i + 1].x * horizontalPixelRatio : x;
            const halfWidth =
              nextX !== prevX ? Math.max(6, (nextX - prevX) / 2) : 6 * horizontalPixelRatio;
            context.fillStyle = this._color;
            context.fillRect(x - halfWidth, 0, halfWidth * 2, bitmapSize.height);
          }
          context.restore();
        }
      );
    }
  }

  class ExtHoursView {
    private _renderer = new ExtHoursRenderer();

    renderer() {
      return this._renderer;
    }

    update(
      data: PaneRendererCustomData<Time, ExtHoursData>,
      options: CustomSeriesOptions
    ) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(_plotRow: ExtHoursData) {
      return [];
    }

    isWhitespace(data: ExtHoursData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
      return (data as ExtHoursData).time === undefined;
    }

    defaultOptions() {
      return { color: 'rgba(40, 40, 40, 0.45)' } as CustomSeriesOptions;
    }
  }

  type NextSlotData = CustomData<Time> & {
    time: Time;
    color?: string;
  };

  class NextSlotRenderer implements ICustomSeriesPaneRenderer {
    private _data: PaneRendererCustomData<Time, NextSlotData> | null = null;
    private _color = 'rgba(255, 255, 255, 0.08)';

    update(
      data: PaneRendererCustomData<Time, NextSlotData>,
      options: CustomSeriesOptions
    ) {
      this._data = data;
      if (options.color) {
        this._color = options.color;
      }
    }

    draw(target: CanvasRenderingTarget2D) {
      if (!this._data || this._data.bars.length === 0) return;
      target.useBitmapCoordinateSpace(
        ({ context, bitmapSize, horizontalPixelRatio }) => {
          context.save();
          for (const bar of this._data?.bars ?? []) {
            const x = bar.x * horizontalPixelRatio;
            const width = 8 * horizontalPixelRatio;
            const color = bar.originalData.color ?? this._color;
            context.fillStyle = color;
            context.fillRect(x - width / 2, 0, width, bitmapSize.height);
          }
          context.restore();
        }
      );
    }
  }

  class NextSlotView {
    private _renderer = new NextSlotRenderer();

    renderer() {
      return this._renderer;
    }

    update(
      data: PaneRendererCustomData<Time, NextSlotData>,
      options: CustomSeriesOptions
    ) {
      this._renderer.update(data, options);
    }

    priceValueBuilder(_plotRow: NextSlotData) {
      return [];
    }

    isWhitespace(data: NextSlotData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
      return (data as NextSlotData).time === undefined;
    }

    defaultOptions() {
      return { color: 'rgba(255, 255, 255, 0.08)' } as CustomSeriesOptions;
    }
  }



  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const tickMarkFormatter = (time: Time, tickMarkType: TickMarkType) => {
      if (
        tickMarkType === TickMarkType.DayOfMonth ||
        tickMarkType === TickMarkType.Month ||
        tickMarkType === TickMarkType.Year
      ) {
        return formatNyDate(time);
      }
      return formatNyTime(time);
    };

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      layout: {
        background: { color: '#000000' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(43, 43, 67, 0.5)' },
        horzLines: { color: 'rgba(43, 43, 67, 0.5)' },
      },
      crosshair: {
        mode: 1, // Normal crosshair mode
        vertLine: {
          labelVisible: true,
          labelBackgroundColor: '#f5e13a',
        },
      },
      rightPriceScale: {
        borderColor: '#2b2b43',
      },
      timeScale: {
        borderColor: '#2b2b43',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter,
      },
      localization: {
        timeFormatter: (time: Time) => `${formatNyDate(time)}, ${formatNyTime(time)}`,
      },
    });

    const bbFill = chart.addCustomSeries(new BollingerBandFillView() as unknown as ICustomSeriesPaneView<Time, BollingerFillData, CustomSeriesOptions>, {
      color: 'rgba(84, 84, 84, 0.2)',
    });
    const extHours = chart.addCustomSeries(new ExtHoursView() as unknown as ICustomSeriesPaneView<Time, ExtHoursData, CustomSeriesOptions>, {
      color: 'rgba(30, 30, 30, 0.7)',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceLineVisible: false,
    });

    const ma20 = chart.addLineSeries({
      color: '#f5a623',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const ma40 = chart.addLineSeries({
      color: '#50e3c2',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const ma100 = chart.addLineSeries({
      color: '#4a90e2',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const ma200 = chart.addLineSeries({
      color: '#9013fe',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const vwap = chart.addLineSeries({
      color: '#ffcc00',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const bbUpper = chart.addLineSeries({
      color: '#b0bec5',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const bbLower = chart.addLineSeries({
      color: '#b0bec5',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const daySeparators = chart.addCustomSeries(new DaySeparatorView() as unknown as ICustomSeriesPaneView<Time, DaySeparatorData, CustomSeriesOptions>, {
      color: 'rgba(126, 200, 255, 0.65)',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const sessionLines = chart.addCustomSeries(new DaySeparatorView() as unknown as ICustomSeriesPaneView<Time, DaySeparatorData, CustomSeriesOptions>, {
      color: 'rgba(126, 200, 255, 0.65)',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const entryLines = chart.addCustomSeries(new EntryLineView() as unknown as ICustomSeriesPaneView<Time, EntryLineData, CustomSeriesOptions>, {
      color: '#ffd54f',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const nextSlot = chart.addCustomSeries(new NextSlotView() as unknown as ICustomSeriesPaneView<Time, NextSlotData, CustomSeriesOptions>, {
      color: 'rgba(255, 255, 255, 0.08)',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const anchorLines = chart.addCustomSeries(new AnchorLineView() as unknown as ICustomSeriesPaneView<Time, EntryLineData, CustomSeriesOptions>, {
      color: '#7ec8ff',
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: '',
    });
    const volume = chart.addHistogramSeries({
      priceScaleId: 'volume',
      color: 'rgba(75, 75, 99, 0.5)',
      priceLineVisible: false,
    });
    const wordenK = chart.addLineSeries({
      priceScaleId: 'worden',
      color: '#ff9800',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const wordenD = chart.addLineSeries({
      priceScaleId: 'worden',
      color: '#03a9f4',
      lineWidth: 1,
      priceLineVisible: false,
    });

    wordenK.createPriceLine({
      price: 80,
      color: '#8a8a8a',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: '80',
    });
    wordenK.createPriceLine({
      price: 20,
      color: '#8a8a8a',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: '20',
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.75, bottom: 0.2 },
      borderColor: '#2b2b43',
    });

    chart.priceScale('worden').applyOptions({
      scaleMargins: { top: 0.88, bottom: 0.05 },
      borderColor: '#2b2b43',
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;
    ma20Ref.current = ma20;
    ma40Ref.current = ma40;
    ma100Ref.current = ma100;
    ma200Ref.current = ma200;
    vwapRef.current = vwap;
    bbUpperRef.current = bbUpper;
    bbLowerRef.current = bbLower;
    bbFillRef.current = bbFill;
    extHoursRef.current = extHours;
    daySeparatorRef.current = daySeparators;
    sessionLineRef.current = sessionLines;
    entryLineRef.current = entryLines;
    anchorLineRef.current = anchorLines;
    nextSlotRef.current = nextSlot;
    volumeRef.current = volume;
    wordenKRef.current = wordenK;
    wordenDRef.current = wordenD;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    if (chartContainerRef.current) {
      resizeObserver.observe(chartContainerRef.current);
    }

    const handleVisibleRangeChange = (range: { from: Time; to: Time } | null) => {
      if (!range) {
        setVisibleRange(null);
        return;
      }
      setVisibleRange({
        from: timeToSeconds(range.from),
        to: timeToSeconds(range.to),
      });
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    const handleCrosshairMove = (param: {
      time?: Time;
      seriesData?: Map<any, any>;
      point?: { x: number; y: number };
    }) => {
      if (!param || !param.time || !param.seriesData || !seriesRef.current) {
        setHoverBar(null);
        setHoverPoint(null);
        return;
      }
      const data = param.seriesData.get(seriesRef.current);
      if (!data) {
        setHoverBar(null);
        setHoverPoint(null);
        return;
      }
      const timeValue =
        typeof param.time === 'number'
          ? (param.time as number)
          : typeof param.time === 'object'
            ? Date.UTC((param.time as BusinessDay).year, (param.time as BusinessDay).month - 1, (param.time as BusinessDay).day) / 1000
            : 0;
      const bar = barByTimeRef.current.get(timeValue);
      setHoverBar({
        time: timeValue,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: bar?.volume ?? 0,
      });
      if (param.point) {
        setHoverPoint({ x: param.point.x, y: param.point.y });
      } else {
        setHoverPoint(null);
      }
    };

    const handleClick = async (param: { hoveredObjectId?: unknown; time?: Time; point?: { x: number; y: number } }) => {
      if (analysisTargetModeRef.current) {
        const sourceTime =
          param?.time ??
          (hoverBar ? (hoverBar.time as unknown as Time) : undefined);
        if (!sourceTime) {
          return;
        }
        const targetTime =
          typeof sourceTime === 'number'
            ? (sourceTime as number)
            : typeof sourceTime === 'object'
              ? Math.floor(
                  Date.UTC((sourceTime as BusinessDay).year, (sourceTime as BusinessDay).month - 1, (sourceTime as BusinessDay).day) / 1000
                )
              : Math.floor(new Date(sourceTime as string).getTime() / 1000);
        setAnalysisTargetMode(false);
        setBarAnalysisLoading(true);
        setBarAnalysis(null);
        setSelectedSignalId(null);
        setStrategyPanelOpen(true);
        try {
          const result = await analyzeBarAtTime(
            symbol,
            targetTime,
            selectedContract ?? undefined,
            strategySettingsBySymbol[symbol]
          );
          setBarAnalysis(result);
        } finally {
          setBarAnalysisLoading(false);
        }
        return;
      }
      if (!param?.hoveredObjectId) {
        setSelectedSignalId(null);
        setSignalClickPosition(null);
        return;
      }
      const id = String(param.hoveredObjectId);
      setSelectedSignalId(id);
      if (param.point && chartContainerRef.current) {
        const rect = chartContainerRef.current.getBoundingClientRect();
        setSignalClickPosition({
          x: rect.left + param.point.x,
          y: rect.top + param.point.y,
        });
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.subscribeClick(handleClick);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeClick(handleClick);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      chart.remove();
    };
  }, []);

  const nyDateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const getNyDayKey = (unixSeconds: number) => {
    const parts = nyDateParts.formatToParts(new Date(unixSeconds * 1000));
    const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const month = parts.find((p) => p.type === 'month')?.value ?? '00';
    const day = parts.find((p) => p.type === 'day')?.value ?? '00';
    return `${year}-${month}-${day}`;
  };

  const nyDateTimeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const getNyParts = (unixSeconds: number) => {
    const parts = nyDateTimeParts.formatToParts(new Date(unixSeconds * 1000));
    return {
      year: Number(parts.find((p) => p.type === 'year')?.value ?? '0'),
      month: Number(parts.find((p) => p.type === 'month')?.value ?? '1'),
      day: Number(parts.find((p) => p.type === 'day')?.value ?? '1'),
      hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
    };
  };

  // Update main chart data when bars change
  useEffect(() => {
    if (!seriesRef.current || bars.length === 0) return;

    const timeScale = chartRef.current?.timeScale();
    const previousRange = timeScale?.getVisibleLogicalRange() ?? null;

    const chartData: CandlestickData[] = bars.map((bar) => {
      let colorOverride: { color?: string; borderColor?: string; wickColor?: string } = {};
      if (!useRth && (interval === '15m' || interval === '1h' || interval === '1m')) {
        const { hour, minute } = getNyHourMinute(bar.time);
        const inRth =
          (hour > 9 || (hour === 9 && minute >= 30)) &&
          (hour < 16 || (hour === 16 && minute === 0));
        if (!inRth) {
          const baseColor = bar.close >= bar.open ? '38,166,154' : '239,83,80';
          colorOverride = {
            color: `rgba(${baseColor}, 0.45)`,
            borderColor: `rgba(${baseColor}, 0.45)`,
            wickColor: `rgba(${baseColor}, 0.45)`,
          };
        }
      }
      return {
        time: bar.time as any,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        ...colorOverride,
      };
    });

    seriesRef.current.setData(chartData);

    if (daySeparatorRef.current) {
      const separators: { time: Time }[] = [];
      if (interval === '1d' || interval === '1w') {
        for (const bar of bars) {
          separators.push({ time: bar.time as Time });
        }
      }
      daySeparatorRef.current.setData(separators);
    }

    if (sessionLineRef.current) {
      const sessionLines: { time: Time }[] = [];
      if (showSessionLines && (interval === '1h' || interval === '15m' || interval === '1m')) {
        const seen: Record<string, { open: boolean; close: boolean }> = {};
        for (const bar of bars) {
          const dayKey = getNyDayKey(bar.time);
          if (!seen[dayKey]) {
            seen[dayKey] = { open: false, close: false };
          }
          const { hour, minute } = getNyHourMinute(bar.time);
          if (!seen[dayKey].open && hour === 9 && minute === 30) {
            sessionLines.push({ time: bar.time as Time });
            seen[dayKey].open = true;
          }
          if (!seen[dayKey].close && hour === 16 && minute === 0) {
            sessionLines.push({ time: bar.time as Time });
            seen[dayKey].close = true;
          }
        }
      }
      sessionLineRef.current.setData(sessionLines);
    }

    if (timeScale) {
      const visibleRange = timeScale.getVisibleRange();
      if (visibleRange) {
        setVisibleRange({
          from: timeToSeconds(visibleRange.from),
          to: timeToSeconds(visibleRange.to),
        });
      }
      if (focusRange) {
        // Zoom to the requested focus range (e.g., backtesting single day)
        requestAnimationFrame(() => {
          let fromIndex = 0;
          let toIndex = bars.length - 1;
          for (let i = 0; i < bars.length; i += 1) {
            if (bars[i].time >= focusRange.from) {
              fromIndex = i;
              break;
            }
          }
          for (let i = bars.length - 1; i >= 0; i -= 1) {
            if (bars[i].time <= focusRange.to) {
              toIndex = i;
              break;
            }
          }
          timeScale.setVisibleLogicalRange({
            from: fromIndex,
            to: toIndex,
          });
        });
      } else if (interval === '1m') {
        const lastBarTime = bars[bars.length - 1].time;
        requestAnimationFrame(() => {
          const lastNy = getNyParts(lastBarTime);
          const prevDay = new Date(Date.UTC(lastNy.year, lastNy.month - 1, lastNy.day));
          prevDay.setUTCDate(prevDay.getUTCDate() - 1);
          const prevDayKey = `${prevDay.getUTCFullYear()}-${String(
            prevDay.getUTCMonth() + 1
          ).padStart(2, '0')}-${String(prevDay.getUTCDate()).padStart(2, '0')}`;
          let fromIndex = 0;
          for (let i = 0; i < bars.length; i += 1) {
            const p = getNyParts(bars[i].time);
            const dayKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(
              p.day
            ).padStart(2, '0')}`;
            if (dayKey > prevDayKey || (dayKey === prevDayKey && p.hour >= 14)) {
              fromIndex = i;
              break;
            }
          }
          timeScale.setVisibleLogicalRange({
            from: fromIndex,
            to: bars.length - 1,
          });
        });
      } else if (previousRange) {
        timeScale.setVisibleLogicalRange(previousRange);
      } else {
        timeScale.fitContent();
      }
    }
    prevIntervalRef.current = interval;
  }, [bars, interval, useRth, focusRange]);

  // Keep barByTimeRef in sync whenever bars change (used by mouse hover handler)
  useEffect(() => {
    barByTimeRef.current = new Map(bars.map((bar) => [bar.time, bar]));
  }, [bars]);

  // --- Per-indicator effects: each only re-runs when its own toggle or bars change ---

  useEffect(() => {
    if (!ma20Ref.current || bars.length === 0) return;
    const data = showMA20 ? calculateMA(20) : [];
    ma20Ref.current.setData(applyLineOpacity(data, '245,166,35', 0.35));
    ma20Ref.current.applyOptions({ visible: showMA20 });
  }, [bars, showMA20, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ma40Ref.current || bars.length === 0) return;
    const data = showMA40 ? calculateMA(40) : [];
    ma40Ref.current.setData(applyLineOpacity(data, '80,227,194', 0.35));
    ma40Ref.current.applyOptions({ visible: showMA40 });
  }, [bars, showMA40, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ma100Ref.current || bars.length === 0) return;
    const data = showMA100 ? calculateMA(100) : [];
    ma100Ref.current.setData(applyLineOpacity(data, '74,144,226', 0.35));
    ma100Ref.current.applyOptions({ visible: showMA100 });
  }, [bars, showMA100, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ma200Ref.current || bars.length === 0) return;
    const data = showMA200 ? calculateMA(200) : [];
    ma200Ref.current.setData(applyLineOpacity(data, '144,19,254', 0.35));
    ma200Ref.current.applyOptions({ visible: showMA200 });
  }, [bars, showMA200, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!vwapRef.current || bars.length === 0) return;
    const data = showVWAP ? calculateVWAP() : [];
    vwapRef.current.setData(applyLineOpacity(data, '255,204,0', 0.35));
    vwapRef.current.applyOptions({ visible: showVWAP });
  }, [bars, showVWAP, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bbUpperRef.current || !bbLowerRef.current || !bbFillRef.current || bars.length === 0) return;
    if (showBollinger) {
      const bands = calculateBollinger(20, 2);
      bbUpperRef.current.setData(applyLineOpacity(bands.upper, '176,190,197', 0.35));
      bbLowerRef.current.setData(applyLineOpacity(bands.lower, '176,190,197', 0.35));
      const fillData = bands.upper.map((upper, idx) => ({
        time: upper.time,
        upper: upper.value,
        lower: bands.lower[idx]?.value ?? upper.value,
      }));
      bbFillRef.current.setData(fillData);
    } else {
      bbUpperRef.current.setData([]);
      bbLowerRef.current.setData([]);
      bbFillRef.current.setData([]);
    }
    bbUpperRef.current.applyOptions({ visible: showBollinger });
    bbLowerRef.current.applyOptions({ visible: showBollinger });
    bbFillRef.current.applyOptions({ visible: showBollinger, color: 'rgba(84, 84, 84, 0.2)' });
  }, [bars, showBollinger, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!volumeRef.current || bars.length === 0) return;
    const volumeData = bars.map((bar) => ({
      time: bar.time as Time,
      value: bar.volume,
      color:
        bar.close >= bar.open
          ? isExtendedSession(bar.time as Time)
            ? 'rgba(38, 166, 154, 0.25)'
            : 'rgba(38, 166, 154, 0.5)'
          : isExtendedSession(bar.time as Time)
            ? 'rgba(239, 83, 80, 0.25)'
            : 'rgba(239, 83, 80, 0.5)',
    }));
    volumeRef.current.setData(showVolume ? volumeData : []);
    volumeRef.current.applyOptions({ visible: showVolume });
  }, [bars, showVolume, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!wordenKRef.current || !wordenDRef.current || bars.length === 0) return;
    if (showWorden) {
      const { kValues, dValues } = calculateWordenStochastic(14, 3, 3);
      wordenKRef.current.setData(applyLineOpacity(kValues, '255,152,0', 0.35));
      wordenDRef.current.setData(applyLineOpacity(dValues, '3,169,244', 0.35));
    } else {
      wordenKRef.current.setData([]);
      wordenDRef.current.setData([]);
    }
    wordenKRef.current.applyOptions({ visible: showWorden });
    wordenDRef.current.applyOptions({ visible: showWorden });
  }, [bars, showWorden, interval, useRth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scale margins only need to update when the lower-panel visibility changes
  useEffect(() => {
    if (!chartRef.current) return;
    const showLowerPanels = showVolume || showWorden;
    const bottomMargin = showVolume && showWorden ? 0.35 : showLowerPanels ? 0.25 : 0.1;
    chartRef.current.priceScale('right').applyOptions({
      scaleMargins: { top: 0.05, bottom: bottomMargin },
    });
    chartRef.current.priceScale('volume').applyOptions({
      scaleMargins: showWorden ? { top: 0.7, bottom: 0.2 } : { top: 0.75, bottom: 0.05 },
    });
    chartRef.current.priceScale('worden').applyOptions({
      scaleMargins: showVolume ? { top: 0.88, bottom: 0.05 } : { top: 0.75, bottom: 0.05 },
    });
  }, [showVolume, showWorden]);

  useEffect(() => {
    if (!extHoursRef.current) return;
    if (useRth || interval === '1d' || interval === '1w') {
      extHoursRef.current.setData([]);
      return;
    }
    const extData = bars.map((bar) => {
      const { hour, minute } = getNyHourMinute(bar.time);
      const inRth =
        (hour > 9 || (hour === 9 && minute >= 30)) &&
        (hour < 16 || (hour === 16 && minute === 0));
      return {
        time: bar.time as Time,
        extended: !inRth,
      };
    });
    extHoursRef.current.setData(extData);
  }, [bars, interval, useRth]);

  // Poll TradingView webhook alerts for the current symbol.
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    const load = async () => {
      try {
        const alerts = await fetchTvAlerts(symbol);
        if (!cancelled) setTvAlerts(alerts);
      } catch {
        // ignore transient errors; keep last known alerts
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (bars.length === 0) {
      seriesRef.current.setMarkers([]);
      targetLinesRef.current = [];
      return;
    }
    const minTime = bars[0].time;
    const maxTime = bars[bars.length - 1].time;
    const inRange = (time: number) => time >= minTime && time <= maxTime;
    // Snap an arbitrary unix time to the nearest bar (O(log n), bars sorted).
    const snapToBar = (time: number) => {
      let lo = 0;
      let hi = bars.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (bars[mid].time <= time) lo = mid;
        else hi = mid - 1;
      }
      if (lo + 1 < bars.length && Math.abs(bars[lo + 1].time - time) < Math.abs(bars[lo].time - time)) {
        return bars[lo + 1].time;
      }
      return bars[lo].time;
    };
    const markers: SeriesMarker<Time>[] = strategySignals.map((signal) => {
      const isSelected = signal.id === selectedSignalId;
      const isCall = signal.direction === 'CALL';
      const isChopFiltered = (signal as any).chopFiltered === true;
      const markerColor = isSelected ? '#d100ff' : isChopFiltered ? '#666666' : '#ffd54f';
      const label = isChopFiltered ? `${signal.direction} (CHOP)` : signal.direction;
      return {
        id: signal.id,
        time: signal.entryTime as unknown as Time,
        position: (isCall ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
        color: markerColor,
        shape: (isCall ? 'arrowUp' : 'arrowDown') as SeriesMarkerShape,
        size: isSelected ? 5 : isChopFiltered ? 2 : 4,
        text: label,
      };
    }).filter((marker) => inRange(Number(marker.time)));
    if (nextSlotSignal && inRange(nextSlotSignal.time)) {
      markers.push({
        id: nextSlotSignal.id,
        time: nextSlotSignal.time as unknown as Time,
        position: (nextSlotSignal.direction === 'CALL' ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
        color: '#ffd54f',
        shape: (nextSlotSignal.direction === 'CALL' ? 'arrowUp' : 'arrowDown') as SeriesMarkerShape,
        size: 4,
        text: nextSlotSignal.direction,
      });
    }
    if (barAnalysis && !selectedSignalId) {
      // O(log n) binary search — bars are sorted by time
      const findNearestTime = (time: number) => {
        if (bars.length === 0) return time;
        let lo = 0;
        let hi = bars.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1;
          if (bars[mid].time <= time) lo = mid;
          else hi = mid - 1;
        }
        // lo is now the last index with time <= target; check neighbour
        if (lo + 1 < bars.length && Math.abs(bars[lo + 1].time - time) < Math.abs(bars[lo].time - time)) {
          return bars[lo + 1].time;
        }
        return bars[lo].time;
      };
      const snappedTime = findNearestTime(barAnalysis.time);
      markers.push({
        id: 'target-bar',
        time: snappedTime as unknown as Time,
        position: 'aboveBar' as SeriesMarkerPosition,
        color: '#ffd54f',
        shape: 'circle' as SeriesMarkerShape,
        size: 4,
        text: 'TARGET',
      });
    }
    // TradingView webhook alerts — snap each to the nearest visible bar.
    tvAlerts.forEach((alert, idx) => {
      const alertTime =
        typeof alert.time === 'number'
          ? alert.time
          : typeof alert.time === 'string' && !Number.isNaN(Date.parse(alert.time))
            ? Math.floor(Date.parse(alert.time) / 1000)
            : alert.received_at;
      // Drop only alerts older than the earliest visible bar. Alerts newer than
      // the last bar (e.g. fired live while the chart data is stale/closed) snap
      // forward to the most recent candle rather than being discarded.
      if (alertTime < minTime - 86400) return;
      const snapped = snapToBar(alertTime);
      if (!inRange(snapped)) return;
      const isBuy = (alert.action ?? '').toLowerCase() === 'buy';
      const isSell = (alert.action ?? '').toLowerCase() === 'sell';
      markers.push({
        id: `tv-alert-${alert.received_at}-${idx}`,
        time: snapped as unknown as Time,
        position: (isBuy ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
        color: isBuy ? '#26a69a' : isSell ? '#ef5350' : '#42a5f5',
        shape: (isBuy ? 'arrowUp' : 'arrowDown') as SeriesMarkerShape,
        size: 3,
        text: alert.signal ?? alert.raw ?? 'TV',
      });
    });
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    seriesRef.current.setMarkers(markers);
    if (entryLineRef.current) {
      entryLineRef.current.setData([]);
    }
    if (anchorLineRef.current) {
      anchorLineRef.current.setData([]);
    }
  }, [bars, strategySignals, selectedSignalId, barAnalysis, nextSlotSignal, tvAlerts]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (targetLinesRef.current.length > 0) {
      targetLinesRef.current.forEach((line) => {
        try {
          seriesRef.current?.removePriceLine(line);
        } catch {
          // no-op
        }
      });
      targetLinesRef.current = [];
    }
    if (!selectedSignalId) return;
    const selected = strategySignals.find((signal) => signal.id === selectedSignalId);
    if (!selected) return;
    if (!bars.length) return;
    let entryBar = bars.find((bar) => bar.time === selected.entryTime);
    if (!entryBar) {
      let closest = bars[0];
      let minDiff = Math.abs(closest.time - selected.entryTime);
      for (const bar of bars) {
        const diff = Math.abs(bar.time - selected.entryTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = bar;
        }
      }
      entryBar = closest;
    }
    if (!entryBar) return;
    const basePrice = entryBar.close;
    const isCall = selected.direction === 'CALL';
    const levels = [0, 0.01, 0.05, 0.1];
    const color = isCall ? '#39d98a' : '#ff6b6b';
    targetLinesRef.current = levels.map((pct) =>
      seriesRef.current!.createPriceLine({
        price: isCall ? basePrice * (1 + pct) : basePrice * (1 - pct),
        color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `${Math.round(pct * 100)}%`,
      })
    );
  }, [bars, strategySignals, selectedSignalId]);

  // ── S/R horizontal lines ──────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current) return;
    // Clean up previous S/R lines
    if (srLinesRef.current.length > 0) {
      srLinesRef.current.forEach((line) => {
        try {
          seriesRef.current?.removePriceLine(line);
        } catch {
          // no-op
        }
      });
      srLinesRef.current = [];
    }
    if (!srLevels) return;

    const lines: IPriceLine[] = [];
    // Support lines — green dashed
    for (const price of srLevels.support) {
      lines.push(
        seriesRef.current.createPriceLine({
          price,
          color: 'rgba(38, 166, 91, 0.6)',
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: false,
          title: 'S',
        })
      );
    }
    // Resistance lines — red dashed
    for (const price of srLevels.resistance) {
      lines.push(
        seriesRef.current.createPriceLine({
          price,
          color: 'rgba(239, 83, 80, 0.6)',
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: false,
          title: 'R',
        })
      );
    }
    srLinesRef.current = lines;
  }, [srLevels, bars]);

  useEffect(() => {
    if (!nextSlotRef.current || bars.length === 0 || interval !== '15m') {
      nextSlotRef.current?.setData([]);
      return;
    }
    const updateNextSlot = async () => {
      if (nextSlotBusyRef.current) return;
      nextSlotBusyRef.current = true;
      try {
        const lastBar = bars[bars.length - 1];
        const nextTime = lastBar.time + 15 * 60;
        const from = lastBar.time - 7 * 86400;
        const to = nextTime;
        const signals = await analyzeVisibleRange(
          symbol,
          { from, to },
          8,
          selectedContract ?? undefined,
          strategySettingsBySymbol[symbol]
        );
        const upcoming = signals.filter(
          (signal) => signal.entryTime > lastBar.time && signal.entryTime <= nextTime
        );
        let color = 'rgba(255, 255, 255, 0.08)';
        if (upcoming.length > 0) {
          const latest = upcoming.reduce((prev, curr) =>
            curr.entryTime > prev.entryTime ? curr : prev
          );
          color =
            latest.direction === 'CALL'
              ? 'rgba(57, 217, 138, 0.35)'
              : 'rgba(255, 107, 107, 0.35)';
          setNextSlotSignal({
            time: latest.entryTime,
            direction: latest.direction,
            id: `next-slot-${latest.id}`,
          });
        } else {
          setNextSlotSignal(null);
        }
        nextSlotRef.current?.setData([{ time: nextTime as Time, color }]);
      } catch {
        nextSlotRef.current?.setData([]);
        setNextSlotSignal(null);
      } finally {
        nextSlotBusyRef.current = false;
      }
    };
    updateNextSlot();
  }, [bars, interval, symbol, selectedContract]);

  const tooltipWidth = 280;
  const containerWidth = chartContainerRef.current?.clientWidth ?? 0;
  const hoverX = hoverPoint?.x ?? 0;
  const tooltipLeft =
    containerWidth && hoverX + 12 + tooltipWidth > containerWidth
      ? Math.max(8, hoverX - 6 - tooltipWidth)
      : Math.max(8, hoverX + 12);


  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        position: 'relative',
        minHeight: '400px',
      }}
    >
      <Box
        ref={chartContainerRef}
        sx={{
          width: '100%',
          height: '100%',
        }}
      />
      {hoverBar && (
        <Box
          sx={{
            position: 'absolute',
            left: tooltipLeft,
            top: Math.max(8, (hoverPoint?.y ?? 0) + 12),
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: '#d1d4dc',
            border: '1px solid #2b2b43',
            borderRadius: '4px',
            padding: '12px 16px',
            fontSize: '28px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <Box sx={{ fontSize: '14px', color: '#9aa0a6' }}>
            {interval === '1d'
              ? formatNyDate(hoverBar.time as Time)
              : formatNyTime(hoverBar.time as Time)}
          </Box>
          {hoverBar.close >= hoverBar.open ? (
            <>
              <Box sx={{ fontSize: '20px' }}>{`H ${hoverBar.high.toFixed(2)}`}</Box>
              <Box sx={{ color: '#26a69a' }}>{`C ${hoverBar.close.toFixed(2)}`}</Box>
              <Box sx={{ fontSize: '20px' }}>{`Δ ${(hoverBar.close - hoverBar.open).toFixed(2)} (${(((hoverBar.close - hoverBar.open) / hoverBar.open) * 100).toFixed(2)}%)`}</Box>
              <Box sx={{ color: '#26a69a' }}>{`O ${hoverBar.open.toFixed(2)}`}</Box>
              <Box sx={{ fontSize: '20px' }}>{`L ${hoverBar.low.toFixed(2)}`}</Box>
            </>
          ) : (
            <>
              <Box sx={{ fontSize: '20px' }}>{`H ${hoverBar.high.toFixed(2)}`}</Box>
              <Box sx={{ color: '#ef5350' }}>{`O ${hoverBar.open.toFixed(2)}`}</Box>
              <Box sx={{ fontSize: '20px' }}>{`Δ ${(hoverBar.close - hoverBar.open).toFixed(2)} (${(((hoverBar.close - hoverBar.open) / hoverBar.open) * 100).toFixed(2)}%)`}</Box>
              <Box sx={{ color: '#ef5350' }}>{`C ${hoverBar.close.toFixed(2)}`}</Box>
              <Box sx={{ fontSize: '20px' }}>{`L ${hoverBar.low.toFixed(2)}`}</Box>
            </>
          )}
        </Box>
      )}
      <Box
        sx={{
          position: 'absolute',
          top: 10,
          left: 10,
          color: '#d1d4dc',
          fontSize: '14px',
          fontWeight: 'bold',
          pointerEvents: 'none',
        }}
      >
        {symbol} - {interval}
      </Box>
    </Box>
  );
}
