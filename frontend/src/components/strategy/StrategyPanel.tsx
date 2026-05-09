import {
  Box,
  IconButton,
  Typography,
  Divider,
  FormControl,
  Select,
  MenuItem,
  SelectChangeEvent,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useChartStore } from '@/store/chartStore';
import { recomputeOutcomesForSignals } from '@/analysis/strategyAnalysis';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  Time,
  CustomData,
  CustomSeriesOptions,
  ICustomSeriesPaneRenderer,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { CanvasRenderingTarget2D } from 'fancy-canvas';

function OutcomeTable({ values }: { values: number[] }) {
  return (
    <Box
      sx={{
        border: '1px solid #2b2b43',
        borderRadius: 1,
        overflow: 'hidden',
        fontSize: 11,
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '60px 1fr',
          gap: 1,
          padding: '6px 8px',
          backgroundColor: 'rgba(255,255,255,0.04)',
          color: '#9aa0a6',
        }}
      >
        <Box>Bar</Box>
        <Box>% from entry</Box>
      </Box>
      <Box sx={{ maxHeight: 160, overflowY: 'auto' }}>
        {values.map((value, idx) => (
          <Box
            key={idx}
            sx={{
              display: 'grid',
              gridTemplateColumns: '60px 1fr',
              gap: 1,
              padding: '4px 8px',
              borderTop: '1px solid rgba(255,255,255,0.04)',
              color: value >= 0 ? '#39d98a' : '#ff6b6b',
            }}
          >
            <Box>#{idx + 1}</Box>
            <Box>{(value * 100).toFixed(2)}%</Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function OutcomeList({ values }: { values: number[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {values.map((value, idx) => (
        <Box
          key={idx}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px',
            borderRadius: 1,
            backgroundColor: 'rgba(255,255,255,0.04)',
            color: value >= 0 ? '#39d98a' : '#ff6b6b',
            fontSize: 11,
          }}
        >
          <Box>#{idx + 1}</Box>
          <Box>{(value * 100).toFixed(2)}%</Box>
        </Box>
      ))}
    </Box>
  );
}

function OutcomeHeatmap({ values }: { values: number[] }) {
  const maxAbs = Math.max(...values.map((v) => Math.abs(v)), 0.001);
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {values.map((value, idx) => {
        const intensity = Math.min(1, Math.abs(value) / maxAbs);
        const color =
          value >= 0
            ? `rgba(57, 217, 138, ${0.2 + intensity * 0.6})`
            : `rgba(255, 107, 107, ${0.2 + intensity * 0.6})`;
        return (
          <Box
            key={idx}
            sx={{
              width: 16,
              height: 16,
              borderRadius: 0.5,
              backgroundColor: color,
            }}
            title={`#${idx + 1}: ${(value * 100).toFixed(2)}%`}
          />
        );
      })}
    </Box>
  );
}

function OutcomeTopMoves({ values }: { values: number[] }) {
  const sorted = values
    .map((value, idx) => ({ value, idx: idx + 1 }))
    .sort((a, b) => b.value - a.value);
  const topFavorable = sorted.slice(0, 3);
  const topAdverse = [...sorted].reverse().slice(0, 3);
  return (
    <Box sx={{ display: 'flex', gap: 2 }}>
      <Box sx={{ flex: 1 }}>
        <Typography sx={{ fontSize: 11, color: '#9aa0a6', marginBottom: 0.5 }}>
          Top favorable
        </Typography>
        {topFavorable.map((item) => (
          <Box
            key={item.idx}
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '4px 8px',
              borderRadius: 1,
              backgroundColor: 'rgba(57, 217, 138, 0.12)',
              color: '#39d98a',
              fontSize: 11,
              marginBottom: 0.5,
            }}
          >
            <Box>#{item.idx}</Box>
            <Box>{(item.value * 100).toFixed(2)}%</Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography sx={{ fontSize: 11, color: '#9aa0a6', marginBottom: 0.5 }}>
          Top adverse
        </Typography>
        {topAdverse.map((item) => (
          <Box
            key={item.idx}
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '4px 8px',
              borderRadius: 1,
              backgroundColor: 'rgba(255, 107, 107, 0.12)',
              color: '#ff6b6b',
              fontSize: 11,
              marginBottom: 0.5,
            }}
          >
            <Box>#{item.idx}</Box>
            <Box>{(item.value * 100).toFixed(2)}%</Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function calculateMA(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }
  return result;
}

type BollingerFillData = CustomData<Time> & {
  upper: number;
  lower: number;
};

class MiniBollingerFillRenderer implements ICustomSeriesPaneRenderer {
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
        const y = priceConverter(bar.originalData.upper);
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
        const y = priceConverter(bar.originalData.lower);
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

class MiniBollingerFillView {
  private _renderer = new MiniBollingerFillRenderer();

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

function calculateBollinger(values: number[], period: number, mult: number) {
  const upper: Array<number | null> = Array(values.length).fill(null);
  const lower: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) {
      const mean = sum / period;
      let variance = 0;
      for (let j = i - period + 1; j <= i; j += 1) {
        variance += (values[j] - mean) ** 2;
      }
      const std = Math.sqrt(variance / period);
      upper[i] = mean + mult * std;
      lower[i] = mean - mult * std;
    }
  }
  return { upper, lower };
}

function ReasonMiniChart({
  bars,
  entryTime,
  showMA40,
  height = 180,
}: {
  bars: { time: number; open: number; high: number; low: number; close: number }[];
  entryTime: number;
  showMA40?: boolean;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma40Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbFillRef = useRef<ISeriesApi<'Custom'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#000000' },
        textColor: '#9aa0a6',
      },
      grid: {
        vertLines: { color: 'rgba(43, 43, 67, 0.5)' },
        horzLines: { color: 'rgba(43, 43, 67, 0.5)' },
      },
      rightPriceScale: {
        borderColor: '#2b2b43',
      },
      timeScale: {
        borderColor: '#2b2b43',
        timeVisible: true,
      },
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
    });
    const candles = chart.addCandlestickSeries({
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
    const bbFill = chart.addCustomSeries(new MiniBollingerFillView() as any, {
      color: 'rgba(84, 84, 84, 0.2)',
    });

    chartRef.current = chart;
    candleRef.current = candles;
    ma20Ref.current = ma20;
    ma40Ref.current = ma40;
    bbUpperRef.current = bbUpper;
    bbLowerRef.current = bbLower;
    bbFillRef.current = bbFill;

    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
        });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [height]);

  useEffect(() => {
    if (
      !candleRef.current ||
      !ma20Ref.current ||
      !ma40Ref.current ||
      !bbUpperRef.current ||
      !bbLowerRef.current ||
      !bbFillRef.current
    )
      return;
    if (bars.length < 2) {
      candleRef.current.setData([]);
      ma20Ref.current.setData([]);
      ma40Ref.current.setData([]);
      bbUpperRef.current.setData([]);
      bbLowerRef.current.setData([]);
      bbFillRef.current.setData([]);
      return;
    }
    const index = bars.findIndex((b) => b.time >= entryTime);
    const start = Math.max(0, index - 24);
    const end = Math.min(bars.length, index + 24);
    const slice = bars.slice(start, end);
    if (slice.length < 2) return;

    candleRef.current.setData(
      slice.map((bar) => ({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }))
    );
    const closes = slice.map((b) => b.close);
    const ma20 = calculateMA(closes, 20);
    const ma40 = showMA40 ? calculateMA(closes, 40) : null;
    ma20Ref.current.setData(
      ma20.flatMap((value, i) =>
        value === null ? [] : [{ time: slice[i].time as Time, value }]
      )
    );
    if (showMA40 && ma40) {
      ma40Ref.current.setData(
        ma40.flatMap((value, i) =>
          value === null ? [] : [{ time: slice[i].time as Time, value }]
        )
      );
      ma40Ref.current.applyOptions({ visible: true });
    } else {
      ma40Ref.current.setData([]);
      ma40Ref.current.applyOptions({ visible: false });
    }

    const bands = calculateBollinger(closes, 20, 2);
    bbUpperRef.current.setData(
      bands.upper.flatMap((value, i) =>
        value === null ? [] : [{ time: slice[i].time as Time, value }]
      )
    );
    bbLowerRef.current.setData(
      bands.lower.flatMap((value, i) =>
        value === null ? [] : [{ time: slice[i].time as Time, value }]
      )
    );
    const fillData = slice.flatMap((bar, i) => {
      const upper = bands.upper[i];
      const lower = bands.lower[i];
      if (upper === null || lower === null) return [];
      return [{ time: bar.time as Time, upper, lower }];
    });
    bbFillRef.current.setData(fillData);
    bbUpperRef.current.applyOptions({ visible: true });
    bbLowerRef.current.applyOptions({ visible: true });
    bbFillRef.current.applyOptions({ visible: true, color: 'rgba(84, 84, 84, 0.2)' });

    const markerIndex = Math.max(0, Math.min(slice.length - 1, index - start));
    const markerTime = slice[markerIndex]?.time as Time | undefined;
    if (markerTime) {
      candleRef.current.setMarkers([
        {
          time: markerTime,
          position: 'aboveBar',
          color: '#ffd54f',
          shape: 'circle',
          size: 2,
        },
      ]);
    }
    chartRef.current?.timeScale().fitContent();
  }, [bars, entryTime, showMA40]);

  return <Box ref={containerRef} sx={{ width: '100%', height }} />;
}

export function StrategyPanel({ open }: { open: boolean }) {
  const {
    strategySignals,
    selectedSignalId,
    setSelectedSignalId,
    isAnalyzing,
    setStrategyPanelOpen,
    lastAnalysis,
    symbol,
    outcomeHorizonBars,
    setOutcomeHorizonBars,
    setIsAnalyzing,
    setStrategySignals,
    analysisContext,
    strategyPanelWidth,
    setStrategyPanelWidth,
    barAnalysis,
    barAnalysisLoading,
    strategySettingsBySymbol,
  } = useChartStore();
  const selected = strategySignals.find((s) => s.id === selectedSignalId) || null;
  const horizonOptions = [4, 8, 12, 16, 24];
  const resizingRef = useRef(false);
  const lastBarClose = analysisContext?.bars15m?.length
    ? analysisContext.bars15m[analysisContext.bars15m.length - 1].close
    : null;
  const entryPrice =
    selected && analysisContext?.bars15m
      ? analysisContext.bars15m.find((b) => b.time === selected.entryTime)?.close ?? null
      : null;
  const entryDelta =
    lastBarClose !== null && entryPrice !== null
      ? lastBarClose - entryPrice
      : null;
  const entryDeltaPct =
    entryDelta !== null && entryPrice
      ? (entryDelta / entryPrice) * 100
      : null;

  const nyDateTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const conditionExplanation = (label: string) => {
    const lower = label.toLowerCase();
    if (lower.includes('prior downtrend')) {
      return 'Checks the last 3 1H closes are below MA40 and MA20 slope ≤ 0 (lookback N=3).';
    }
    if (lower.includes('prior uptrend')) {
      return 'Checks the last 3 1H closes are above MA40 and MA20 slope ≥ 0 (lookback N=3).';
    }
    if (lower.includes('cross above ma20')) {
      return 'Requires a 1H close to move from below MA20 to above MA20.';
    }
    if (lower.includes('cross below ma20')) {
      return 'Requires a 1H close to move from above MA20 to below MA20.';
    }
    if (lower.includes('confirm window')) {
      return 'The selected bar must fall inside the confirmation window (W=4 bars).';
    }
    if (lower.includes('15m confirmation')) {
      return 'Confirmation via 15M MA20 or Worden Stoch cross (20/80 or signal cross).';
    }
    if (lower.includes('daily uptrend')) {
      return 'Daily trend is positive (last 3 closes above MA40, MA20 slope ≥ 0).';
    }
    if (lower.includes('daily downtrend')) {
      return 'Daily trend is negative (last 3 closes below MA40, MA20 slope ≤ 0).';
    }
    if (lower.includes('touched daily ma20')) {
      return 'A 1H bar touched the daily MA20 within ~0.15% tolerance.';
    }
    if (lower.includes('1h bounce')) {
      return 'A 1H bar closed above touch high and above daily MA20 (within W1H=2).';
    }
    if (lower.includes('1h rejection')) {
      return 'A 1H bar closed below touch low and below daily MA20 (within W1H=2).';
    }
    if (lower.includes('entry within 09:30-09:35')) {
      return 'Signal must occur inside the first 5 minutes after the open (09:30–09:35 ET).';
    }
    if (lower.includes('ct15') && lower.includes('opening bar')) {
      return 'CT15 only evaluates the very first 15M bar of the session (09:30–09:45 ET).';
    }
    if (lower.includes('ct15') && lower.includes('gap up')) {
      return 'Requires a positive gap of at least 0.2% vs the prior close.';
    }
    if (lower.includes('ct15') && lower.includes('gap down')) {
      return 'Requires a negative gap of at least 0.2% vs the prior close.';
    }
    if (lower.includes('ct15') && lower.includes('prior day slope')) {
      return 'Uses a regression slope of prior-day 15M closes to approximate the trendline.';
    }
    if (lower.includes('ct15') && lower.includes('prior close')) {
      return 'Checks the prior-day final 15M close is on the required side of the midline.';
    }
    if (lower.includes('ct15') && lower.includes('midline')) {
      return 'Open must be above/below the 15M midline to confirm direction.';
    }
    if (lower.includes('ct15') && lower.includes('trendline')) {
      return 'Open must break the extrapolated prior-day trendline level.';
    }
    if (lower.includes('ct15') && lower.includes('volatility')) {
      return 'Bollinger bandwidth must be expanding at the open (volOpen).';
    }
    if (lower.includes('gap down')) {
      return 'Open price is at least 0.4% below the prior close.';
    }
    if (lower.includes('gap up')) {
      return 'Open price is at least 0.4% above the prior close.';
    }
    if (lower.includes('tight 15m bands')) {
      return '15M Bollinger bandwidth is in the lowest 20% of the last 100 bars.';
    }
    if (lower.includes('open below lower band')) {
      return 'Open price is below the 15M Bollinger lower band.';
    }
    if (lower.includes('open above upper band')) {
      return 'Open price is above the 15M Bollinger upper band.';
    }
    if (lower.includes('reversal confirmation')) {
      return 'A 1M reversal candle confirms the snap back.';
    }
    if (lower.includes('stretch below ma20')) {
      return 'Price is ≥ 1.2% below MA20 (magnet stretch threshold).';
    }
    if (lower.includes('stretch above ma20')) {
      return 'Price is ≥ 1.2% above MA20 (magnet stretch threshold).';
    }
    if (lower.includes('outside lower band')) {
      return 'First session 15M bar closed below the Bollinger lower band.';
    }
    if (lower.includes('outside upper band')) {
      return 'First session 15M bar closed above the Bollinger upper band.';
    }
    if (lower.includes('trend gate')) {
      return 'Allows the trade only if trend is aligned or weakening (|slope| ≤ 0.01).';
    }
    if (lower.includes('stoch')) {
      return 'Worden Stochastic confirms reversal via 20/80 thresholds or signal cross.';
    }
    return 'Condition check for this strategy.';
  };

  const reasonExplanation = (reason: string) => {
    const lower = reason.toLowerCase();
    if (lower.includes('stretched') && lower.includes('ma20')) {
      return 'Measures how far price moved away from the 15M MA20 midline (threshold 1.2%).';
    }
    if (lower.includes('outside bollinger')) {
      return 'Confirms the move extended beyond the Bollinger envelope within the first 2 bars.';
    }
    if (lower.includes('trend context')) {
      return 'Checks higher‑timeframe trend to avoid fighting strong momentum (slope near 0 allowed).';
    }
    if (lower.includes('stochastic')) {
      return 'Uses Worden Stochastic (20/80 or signal cross) to confirm timing.';
    }
    if (lower.includes('entry marked')) {
      return 'Marks the first bar that satisfied the confirmation rule.';
    }
    if (lower.includes('daily')) {
      return 'Uses daily MA20/MA40 for context and midline touch.';
    }
    if (lower.includes('tight bollinger')) {
      return 'Requires low volatility at the open (bandwidth ≤ 20th percentile of last 100).';
    }
    if (lower.includes('gap')) {
      return 'Compares open price vs prior close to detect a large gap (≥ 0.4%).';
    }
    return 'Why this signal condition was considered.';
  };

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const nextWidth = Math.min(
        Math.max(360, window.innerWidth - event.clientX),
        window.innerWidth - 240
      );
      setStrategyPanelWidth(nextWidth);
    };
    const handleUp = () => {
      resizingRef.current = false;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [setStrategyPanelWidth]);

  const handleHorizonChange = async (event: SelectChangeEvent) => {
    const nextValue = Number(event.target.value);
    setOutcomeHorizonBars(nextValue);
    if (!analysisContext || analysisContext.symbol !== symbol) return;
    setIsAnalyzing(true);
    try {
      const successThreshold =
        strategySettingsBySymbol[symbol]?.global?.successThresholdPct;
      const updatedSignals = recomputeOutcomesForSignals(
        strategySignals,
        analysisContext.bars15m,
        analysisContext.bars1m,
        nextValue,
        successThreshold
      );
      setStrategySignals(updatedSignals);
      const stillSelected = updatedSignals.some((s) => s.id === selectedSignalId);
      setSelectedSignalId(stillSelected ? selectedSignalId : null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <Box
      sx={{
        width: strategyPanelWidth,
        height: '100%',
        backgroundColor: '#0b0b0b',
        color: '#d1d4dc',
        borderLeft: '1px solid #2b2b43',
        display: 'flex',
        flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 250ms ease',
        pointerEvents: open ? 'auto' : 'none',
        position: 'relative',
      }}
    >
      <Box
        onMouseDown={() => {
          resizingRef.current = true;
        }}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 2,
          backgroundColor: 'transparent',
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', padding: 2 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          Strategy Details
        </Typography>
        <IconButton
          onClick={() => {
            setSelectedSignalId(null);
            setStrategyPanelOpen(false);
          }}
          sx={{ color: '#d1d4dc' }}
        >
          <CloseIcon />
        </IconButton>
      </Box>
      <Divider sx={{ borderColor: '#2b2b43' }} />
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
      {isAnalyzing && (
        <Box sx={{ padding: 2 }}>
          <Typography sx={{ fontSize: 14, marginBottom: 1 }}>
            Running strategy analysis…
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            This may take a few seconds.
          </Typography>
        </Box>
      )}
      {!isAnalyzing && lastAnalysis && !selected && (
        <Box sx={{ padding: 2 }}>
          <Typography sx={{ fontSize: 14, marginBottom: 1 }}>
            Analysis complete
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Time: {lastAnalysis.durationMs} ms
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Entry points: {lastAnalysis.count}
          </Typography>
        </Box>
      )}
      {barAnalysisLoading && (
        <Box sx={{ padding: 2 }}>
          <Typography sx={{ fontSize: 14, marginBottom: 1 }}>
            Running bar analysis…
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Evaluating strategy conditions for the selected bar.
          </Typography>
        </Box>
      )}
      {barAnalysis && !selected && (
        <Box sx={{ padding: 2 }}>
          <Typography sx={{ fontSize: 13, marginBottom: 1 }}>
            Bar Analysis
          </Typography>
          {barAnalysis.strategies.map((strategy) => (
            <Accordion
              key={strategy.id}
              sx={{
                backgroundColor: 'transparent',
                boxShadow: 'none',
                '&:before': { display: 'none' },
              }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: '#9aa0a6' }} />}>
                <Typography sx={{ fontSize: 12 }}>
                  {strategy.name}
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ paddingTop: 0 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {strategy.conditions.map((condition) => (
                    <Box
                      key={condition.label}
                      sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 0.25,
                        color: condition.pass ? '#26a69a' : '#ef5350',
                        fontSize: 12,
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <span>{condition.pass ? '✓' : '✕'}</span>
                        <span style={{ color: '#d1d4dc' }}>{condition.label}</span>
                      </Box>
                      <Typography sx={{ fontSize: 11, color: '#9aa0a6' }}>
                        {conditionExplanation(condition.label)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}
      {selected && (
        <Box sx={{ padding: 2 }}>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            {selected.symbol}
          </Typography>
          <Typography sx={{ fontSize: 14, marginBottom: 1 }}>
            {selected.strategyId === 'strategy-1'
              ? 'Strategy 1 — Trend Change (1H + 15M Confirmation)'
              : selected.strategyId === 'strategy2_midline_bounce_1d_1h_15m'
                ? 'Strategy 2 — Midline Bounce / Rejection (1D + 1H + 15M)'
                : selected.strategyId === 'strategy3_open_gap_fade_lowvol_15m_1m'
                  ? 'Strategy 3 — Low-Vol Open + Extreme Gap Fade (15M + 1M)'
                  : selected.strategyId === 'strategy4_magnet_effect_gap_far_from_ma20_15m'
                    ? 'Strategy 4 — Magnet Effect (Gap far from MA20)'
                    : selected.strategyId === 'strategy5_lateral_open_outside_bollinger_no_vol'
                      ? 'Strategy 5 — Lateral Open Outside Bollinger (No Vol)'
                      : 'CT15 — Opening Gap Reversal (15M + Volatility)'}
          </Typography>
          <Typography
            sx={{
              fontSize: 14,
              marginBottom: 1,
              color: selected.direction === 'CALL' ? '#26a69a' : '#ef5350',
              fontWeight: 'bold',
            }}
          >
            {selected.direction}
          </Typography>
          <Typography
            sx={{
              fontSize: 12,
              marginBottom: 1,
              color:
                entryDelta === null
                  ? '#9aa0a6'
                  : entryDelta >= 0
                    ? '#39d98a'
                    : '#ff6b6b',
            }}
          >
            {entryDelta !== null && entryDeltaPct !== null
              ? `Δ ${entryDelta >= 0 ? '+' : ''}${entryDelta.toFixed(2)} (${entryDeltaPct >= 0 ? '+' : ''}${entryDeltaPct.toFixed(2)}%) vs last`
              : 'Δ —'}
          </Typography>
          <Typography sx={{ fontSize: 13, color: '#9aa0a6' }}>
            Entry: {nyDateTime.format(new Date(selected.entryTime * 1000))} ET
          </Typography>
          <Typography sx={{ fontSize: 13, color: '#9aa0a6', marginBottom: 2 }}>
            Anchor 1H: {nyDateTime.format(new Date(selected.anchorTime1H * 1000))} ET
          </Typography>

          <Typography sx={{ fontSize: 13, marginBottom: 1 }}>Reasons</Typography>
          <Box sx={{ marginBottom: 2 }}>
            {selected.reasons.map((reason) => {
              const lower = reason.toLowerCase();
              const useDaily = lower.includes('daily');
              const use1h = lower.includes('1h');
              const use1m = lower.includes('1m');
              const barsSource = useDaily
                ? analysisContext?.bars1d
                : use1h
                  ? analysisContext?.bars1h
                  : use1m
                    ? analysisContext?.bars1m
                    : analysisContext?.bars15m;
              return (
                <Accordion
                  key={reason}
                  sx={{
                    backgroundColor: 'transparent',
                    boxShadow: 'none',
                    '&:before': { display: 'none' },
                  }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: '#9aa0a6' }} />}>
                    <Typography sx={{ fontSize: 12 }}>{reason}</Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ paddingTop: 0 }}>
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6', marginBottom: 1 }}>
                      {reasonExplanation(reason)}
                    </Typography>
                    {barsSource ? (
                      <ReasonMiniChart
                        bars={barsSource}
                        entryTime={selected.entryTime}
                        showMA40={use1h || useDaily}
                        height={180}
                      />
                    ) : (
                      <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                        No chart data available for this reason.
                      </Typography>
                    )}
                  </AccordionDetails>
                </Accordion>
              );
            })}
          </Box>

          <Divider sx={{ borderColor: '#2b2b43', marginY: 2 }} />

          <Typography sx={{ fontSize: 13, marginBottom: 1 }}>1H Anchor</Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Close: {selected.debug.anchor1H.close.toFixed(2)} | MA20:{' '}
            {selected.debug.anchor1H.ma20.toFixed(2)} | MA40:{' '}
            {selected.debug.anchor1H.ma40.toFixed(2)}
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Slope MA20: {selected.debug.anchor1H.slopeMa20.toFixed(4)}
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 2 }}>
            Trend checks: {selected.debug.anchor1H.prevTrendChecks.join(', ')}
          </Typography>

          <Typography sx={{ fontSize: 13, marginBottom: 1 }}>15M Confirmation</Typography>
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Close: {selected.debug.confirm15M.close.toFixed(2)} | Rule:{' '}
            {selected.debug.confirm15M.rule}
          </Typography>
          {selected.debug.confirm15M.ma20 !== undefined && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              MA20: {selected.debug.confirm15M.ma20.toFixed(2)}
            </Typography>
          )}
          {(selected.debug.confirm15M.stochK !== undefined ||
            selected.debug.confirm15M.stochD !== undefined) && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              Stoch: K {selected.debug.confirm15M.stochK?.toFixed(2)} / D{' '}
              {selected.debug.confirm15M.stochD?.toFixed(2)}
            </Typography>
          )}

          {selected.debug.strategy2 && (
            <>
              <Divider sx={{ borderColor: '#2b2b43', marginY: 2 }} />
              <Typography sx={{ fontSize: 13, marginBottom: 1 }}>
                Daily Midline Context
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                MA20_1D: {selected.debug.strategy2.ma20_1d?.toFixed(2)} | MA40_1D:{' '}
                {selected.debug.strategy2.ma40_1d?.toFixed(2)}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Slope MA20_1D: {selected.debug.strategy2.slope_ma20_1d?.toFixed(4)}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Touch tolerance: {(selected.debug.strategy2.touchPct * 100).toFixed(2)}% | W1H:{' '}
                {selected.debug.strategy2.w1h} | W15M: {selected.debug.strategy2.w15m}
              </Typography>
            </>
          )}

          <Divider sx={{ borderColor: '#2b2b43', marginY: 2 }} />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, marginBottom: 1 }}>
            <Typography sx={{ fontSize: 13 }}>
              Post‑Entry Outcome
            </Typography>
            {selected.debug.outcome?.notes ? null : (
              <Box
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.75,
                  paddingX: 1,
                  paddingY: 0.5,
                  borderRadius: 1,
                  backgroundColor: selected.debug.outcome?.success
                    ? 'rgba(38, 166, 154, 0.2)'
                    : 'rgba(239, 83, 80, 0.2)',
                  border: `1px solid ${
                    selected.debug.outcome?.success ? '#26a69a' : '#ef5350'
                  }`,
                }}
              >
                <Typography
                  sx={{
                    fontSize: 12,
                    color: selected.debug.outcome?.success ? '#26a69a' : '#ef5350',
                    fontWeight: 600,
                  }}
                >
                  {selected.debug.outcome?.success ? 'Success' : 'No Success'}
                </Typography>
              </Box>
            )}
          </Box>
          {!selected.debug.outcome?.notes && (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 1 }}>
              {selected.debug.outcome?.success ? (
                <>
                  Successful because the price moved in the{' '}
                  {selected.direction === 'CALL' ? 'call' : 'put'} direction early, with the{' '}
                  <Tooltip title="Maximum favorable move: the largest gain (in %) reached during the look‑ahead window.">
                    <Box component="span" sx={{ textDecoration: 'underline dotted', cursor: 'help' }}>
                      maximum favorable move
                    </Box>
                  </Tooltip>{' '}
                  ({((selected.debug.outcome?.maxFavorablePct ?? 0) * 100).toFixed(2)}%)
                  exceeding the{' '}
                  <Tooltip title="Maximum adverse move: the largest drawdown (in %) during the look‑ahead window.">
                    <Box component="span" sx={{ textDecoration: 'underline dotted', cursor: 'help' }}>
                      adverse move
                    </Box>
                  </Tooltip>{' '}
                  ({((selected.debug.outcome?.maxAdversePct ?? 0) * 100).toFixed(2)}%).
                </>
              ) : (
                <>
                  Not successful because the price did not move far enough in the{' '}
                  {selected.direction === 'CALL' ? 'call' : 'put'} direction; the{' '}
                  <Tooltip title="Maximum adverse move: the largest drawdown (in %) during the look‑ahead window.">
                    <Box component="span" sx={{ textDecoration: 'underline dotted', cursor: 'help' }}>
                      maximum adverse move
                    </Box>
                  </Tooltip>{' '}
                  ({((selected.debug.outcome?.maxAdversePct ?? 0) * 100).toFixed(2)}%)
                  outweighed the{' '}
                  <Tooltip title="Maximum favorable move: the largest gain (in %) reached during the look‑ahead window.">
                    <Box component="span" sx={{ textDecoration: 'underline dotted', cursor: 'help' }}>
                      favorable move
                    </Box>
                  </Tooltip>{' '}
                  ({((selected.debug.outcome?.maxFavorablePct ?? 0) * 100).toFixed(2)}%).
                </>
              )}
            </Typography>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, marginBottom: 1 }}>
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              Bars
            </Typography>
            <FormControl size="small">
              <Select
                value={String(outcomeHorizonBars)}
                onChange={handleHorizonChange}
                sx={{
                  minWidth: 64,
                  fontSize: 12,
                  height: 28,
                  color: '#d1d4dc',
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#2b2b43',
                  },
                  '&:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#4b4b63',
                  },
                  '& .MuiSvgIcon-root': { color: '#d1d4dc' },
                }}
              >
                {horizonOptions.map((opt) => (
                  <MenuItem key={opt} value={opt}>
                    {opt}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          {selected.debug.outcome?.notes ? (
            <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
              {selected.debug.outcome.notes}
            </Typography>
          ) : (
            <>
              {selected.debug.outcome?.horizonReturnsPct &&
                selected.debug.outcome.horizonReturnsPct.length > 0 && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 1 }}>
                    <Box>
                      <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
                        Option A — Table
                      </Typography>
                      <OutcomeTable values={selected.debug.outcome.horizonReturnsPct} />
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
                        Option B — Distance List
                      </Typography>
                      <OutcomeList values={selected.debug.outcome.horizonReturnsPct} />
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
                        Option C — Heatmap Strip
                      </Typography>
                      <OutcomeHeatmap values={selected.debug.outcome.horizonReturnsPct} />
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 0.5 }}>
                        Option D — Top 3 Favorable/Adverse
                      </Typography>
                      <OutcomeTopMoves values={selected.debug.outcome.horizonReturnsPct} />
                    </Box>
                  </Box>
                )}
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Bars: {selected.debug.outcome?.barsAvailable}/
                {selected.debug.outcome?.horizonBars}
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Max favorable:{' '}
                {((selected.debug.outcome?.maxFavorablePct ?? 0) * 100).toFixed(2)}%
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                Max adverse:{' '}
                {((selected.debug.outcome?.maxAdversePct ?? 0) * 100).toFixed(2)}%
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                End return:{' '}
                {((selected.debug.outcome?.endReturnPct ?? 0) * 100).toFixed(2)}
                %
              </Typography>
            </>
          )}
        </Box>
      )}
      </Box>
    </Box>
  );
}
