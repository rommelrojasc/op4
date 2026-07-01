import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, IPriceLine, ISeriesApi, Time, SeriesMarkerPosition, SeriesMarkerShape, SeriesMarker, TickMarkType } from 'lightweight-charts';
import { Box, CircularProgress, Typography } from '@mui/material';
import { fetchHistoricalData, fetchGexAnalysis } from '@/services/api/marketData';

// NY timezone formatters for chart axis labels and crosshair tooltip
const _nyDateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
});
const _nyTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
});
const _nyPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function getNyDate(time: Time): Date {
  const ts = typeof time === 'number' ? time : Number(time);
  return new Date(ts * 1000);
}
function formatNyDate(time: Time): string {
  return _nyDateFmt.format(getNyDate(time));
}
function formatNyTime(time: Time): string {
  return _nyTimeFmt.format(getNyDate(time));
}

function isExtendedHours(utcSeconds: number): boolean {
  const parts = _nyPartsFmt.formatToParts(new Date(utcSeconds * 1000));
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  const mins = hour * 60 + minute;
  // RTH = 9:30 (570) to 16:00 (960)
  return mins < 570 || mins >= 960;
}

export interface MiniChartSignal {
  time: number;       // unix timestamp
  direction: 'CALL' | 'PUT';
  label?: string;     // e.g. strategy name
  chopFiltered?: boolean;
  skipReason?: string; // e.g. "settle_cash", "available_funds", "cooldown", etc.
}

export interface MiniChartTrade {
  entryTime: number;  // unix timestamp
  exitTime?: number;  // unix timestamp
  action: 'BUY' | 'SELL';
  right?: string;
  strike?: number;
  price: number;
  pnl?: number;
  type: 'OPEN' | 'CLOSE';
}

export interface MiniChartAlert {
  received_at: number;
  time?: string | number;
  action?: string;      // 'buy' | 'sell'
  signal?: string;      // human-readable label
  raw?: string;
}

interface MiniChartProps {
  symbol: string;
  entryPrice?: number;
  height?: number;
  interval?: string;
  refreshSeconds?: number;
  useRth?: boolean;
  signals?: MiniChartSignal[];
  trades?: MiniChartTrade[];
  alerts?: MiniChartAlert[];
  /** Show S14 GEX horizontal lines (Call Wall / Put Wall / Gamma Flip).
   *  Only takes effect for SPY and SPX symbols (others ignore). Default: false. */
  showGex?: boolean;
}

function buildMarkers(sigs: MiniChartSignal[], trds: MiniChartTrade[], minT: number, maxT: number, alerts: MiniChartAlert[] = []): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];

  // TradingView webhook alerts. Use the alert's own time if present, else the
  // received time. Alerts newer than the last bar (e.g. fired live while the
  // chart data is stale/after-hours) snap forward to the last candle.
  alerts.forEach((alert) => {
    const t =
      typeof alert.time === 'number'
        ? alert.time
        : typeof alert.time === 'string' && !Number.isNaN(Date.parse(alert.time))
          ? Math.floor(Date.parse(alert.time) / 1000)
          : alert.received_at;
    if (t < minT - 86400) return; // older than the visible window
    const snapped = t > maxT ? maxT : t;
    if (snapped < minT || snapped > maxT) return;
    const isBuy = (alert.action ?? '').toLowerCase() === 'buy';
    const isSell = (alert.action ?? '').toLowerCase() === 'sell';
    markers.push({
      time: snapped as unknown as Time,
      position: (isBuy ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
      color: isBuy ? '#26a69a' : isSell ? '#ef5350' : '#42a5f5',
      shape: (isBuy ? 'arrowUp' : 'arrowDown') as SeriesMarkerShape,
      size: 3,
      text: alert.signal ?? alert.raw ?? 'TV',
    });
  });

  sigs
    .filter((sig) => sig.time >= minT && sig.time <= maxT)
    .forEach((sig) => {
      const isCall = sig.direction === 'CALL';
      const isSkipped = sig.chopFiltered || !!sig.skipReason;
      let color = '#ffd54f'; // default: active signal
      let label: string = sig.direction;
      let size = 2;
      if (sig.chopFiltered) {
        color = '#666666';
        label = `${sig.direction} (CHOP)`;
        size = 1;
      } else if (sig.skipReason) {
        color = '#f5a623'; // orange for skipped
        const reason = sig.skipReason.replace(/_/g, ' ');
        label = `${isCall ? 'C' : 'P'} SKIP: ${reason}`;
        size = 1;
      }
      markers.push({
        time: sig.time as unknown as Time,
        position: (isCall ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
        color,
        shape: (isSkipped ? 'square' : (isCall ? 'arrowUp' : 'arrowDown')) as SeriesMarkerShape,
        size,
        text: label,
      });
    });

  trds
    .filter((t) => t.entryTime >= minT && t.entryTime <= maxT)
    .forEach((t) => {
      const isCall = t.right === 'C';
      if (t.type === 'OPEN') {
        markers.push({
          time: t.entryTime as unknown as Time,
          position: (isCall ? 'belowBar' : 'aboveBar') as SeriesMarkerPosition,
          color: '#00e676',
          shape: (isCall ? 'arrowUp' : 'arrowDown') as SeriesMarkerShape,
          size: 3,
          text: `BUY ${t.right || ''}${t.strike || ''} $${t.price.toFixed(2)}`,
        });
      } else if (t.type === 'CLOSE' && t.exitTime && t.exitTime >= minT && t.exitTime <= maxT) {
        const pnlColor = (t.pnl ?? 0) >= 0 ? '#00e676' : '#ff1744';
        const pnlLabel = (t.pnl ?? 0) >= 0 ? `+$${(t.pnl ?? 0).toFixed(0)}` : `-$${Math.abs(t.pnl ?? 0).toFixed(0)}`;
        markers.push({
          time: t.exitTime as unknown as Time,
          position: (isCall ? 'aboveBar' : 'belowBar') as SeriesMarkerPosition,
          color: pnlColor,
          shape: 'circle' as SeriesMarkerShape,
          size: 3,
          text: `EXIT ${pnlLabel}`,
        });
      }
    });

  markers.sort((a, b) => Number(a.time) - Number(b.time));
  return markers;
}

export function MiniChart({ symbol, entryPrice, height = 250, interval = '1m', refreshSeconds = 15, useRth = false, signals = [], trades = [], alerts = [], showGex = false }: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // GEX overlay (S14): controlled entirely by the `showGex` prop now that the
  // toggle lives in the parent toolbar. Only meaningful for SPY/SPX.
  const gexLinesRef = useRef<Array<{ series: ISeriesApi<'Candlestick'>; line: IPriceLine }>>([]);
  const gexEligible = symbol.toUpperCase() === 'SPY' || symbol.toUpperCase() === 'SPX';
  const gexEnabled = showGex && gexEligible;
  // Keep latest signals/trades in refs so the polling closure always reads current values
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  // Create chart + initial load + polling — all in one effect
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#16162a' },
        textColor: '#7c8190',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: 2 },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: 2 },
      },
      rightPriceScale: { borderColor: '#2b2b43' },
      timeScale: {
        borderColor: '#2b2b43',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
          if (tickMarkType === TickMarkType.DayOfMonth || tickMarkType === TickMarkType.Month || tickMarkType === TickMarkType.Year) {
            return formatNyDate(time);
          }
          return formatNyTime(time);
        },
      },
      localization: {
        timeFormatter: (time: Time) => `${formatNyDate(time)}, ${formatNyTime(time)}`,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#39d98a',
      downColor: '#ff6b6b',
      borderUpColor: '#39d98a',
      borderDownColor: '#ff6b6b',
      wickUpColor: '#39d98a',
      wickDownColor: '#ff6b6b',
    });
    candleRef.current = candleSeries;

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeRef.current = volumeSeries;
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    if (entryPrice != null) {
      candleSeries.createPriceLine({
        price: entryPrice,
        color: '#f5a623',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Entry',
      });
    }

    const loadData = async (fitContent: boolean) => {
      if (cancelled) return;
      try {
        const res = await fetchHistoricalData(symbol, interval as any, 500, undefined, undefined, useRth);
        if (cancelled) return;
        const candles = res.bars.map((b) => {
          const ext = isExtendedHours(b.time);
          const up = b.close >= b.open;
          return {
            time: b.time as unknown as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            color: ext ? (up ? '#1a5c3a' : '#5c1a1a') : undefined,
            borderColor: ext ? (up ? '#1a5c3a' : '#5c1a1a') : undefined,
            wickColor: ext ? (up ? '#1a5c3a' : '#5c1a1a') : undefined,
          };
        });
        const volumes = res.bars.map((b) => {
          const ext = isExtendedHours(b.time);
          return {
            time: b.time as unknown as Time,
            value: b.volume,
            color: b.close >= b.open
              ? (ext ? 'rgba(57,217,138,0.10)' : 'rgba(57,217,138,0.25)')
              : (ext ? 'rgba(255,107,107,0.10)' : 'rgba(255,107,107,0.25)'),
          };
        });
        candleSeries.setData(candles);
        volumeSeries.setData(volumes);
        // Render signal + trade markers
        const minT = candles.length > 0 ? Number(candles[0].time) : 0;
        const maxT = candles.length > 0 ? Number(candles[candles.length - 1].time) : 0;
        const markers = buildMarkers(signalsRef.current, tradesRef.current, minT, maxT, alertsRef.current);
        candleSeries.setMarkers(markers);
        if (fitContent) chart.timeScale().fitContent();
        setLoading(false);
        setError(null);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Failed to load chart');
          setLoading(false);
        }
      }
    };

    setLoading(true);
    loadData(true);

    const pollTimer = setInterval(() => loadData(false), refreshSeconds * 1000);

    // Track both width AND height so the user can stretch the container
    // vertically via the CSS resize handle (bottom-right corner of the chart).
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [symbol, interval, height, entryPrice, refreshSeconds, useRth]);

  // Re-render markers when signals or trades change without waiting for the next poll
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    fetchHistoricalData(symbol, interval as any, 500, undefined, undefined, useRth).then((res) => {
      const bars = res.bars;
      if (!bars.length) return;
      const minT = bars[0].time;
      const maxT = bars[bars.length - 1].time;
      candle.setMarkers(buildMarkers(signalsRef.current, tradesRef.current, minT, maxT, alertsRef.current));
    }).catch(() => {});
  }, [signals, trades, alerts, symbol, interval, useRth]);

  // GEX overlay: fetch SPX 0DTE GEX and draw Call Wall / Put Wall / Gamma Flip
  // as horizontal price lines. Refreshes every 5 minutes.
  useEffect(() => {
    // Always start by clearing whatever's there
    const cleanup = () => {
      gexLinesRef.current.forEach(({ series, line }) => {
        try { series.removePriceLine(line); } catch { /* series may be destroyed */ }
      });
      gexLinesRef.current = [];
    };
    cleanup();

    if (!gexEnabled) return;

    let cancelled = false;
    const fetchAndDraw = async () => {
      try {
        const data = await fetchGexAnalysis('SPX', '0dte', 100);
        if (cancelled || !candleRef.current || data.error) return;
        // Drop stale lines from any previous fetch
        cleanup();
        // GEX is computed on SPX (~$7000); scale ÷10 if rendering on SPY (~$700).
        const scale = symbol.toUpperCase() === 'SPY' ? 0.1 : 1.0;
        const lines: Array<{ series: ISeriesApi<'Candlestick'>; line: IPriceLine }> = [];
        const series = candleRef.current;

        const cw = data.call_wall?.strike;
        if (cw != null) {
          lines.push({
            series,
            line: series.createPriceLine({
              price: cw * scale, color: '#ff6b6b', lineWidth: 3,
              lineStyle: 0, axisLabelVisible: true, title: 'Call Wall',
            }),
          });
        }
        const pw = data.put_wall?.strike;
        if (pw != null) {
          lines.push({
            series,
            line: series.createPriceLine({
              price: pw * scale, color: '#39d98a', lineWidth: 3,
              lineStyle: 0, axisLabelVisible: true, title: 'Put Wall',
            }),
          });
        }
        const flip = data.gamma_flip?.strike;
        if (flip != null) {
          lines.push({
            series,
            line: series.createPriceLine({
              price: flip * scale, color: '#7c4dff', lineWidth: 2,
              lineStyle: 2, axisLabelVisible: true, title: 'Gamma Flip',
            }),
          });
        }
        gexLinesRef.current = lines;
      } catch {
        // Silent failure — IB may be disconnected or symbol unsupported.
      }
    };
    fetchAndDraw();
    const t = setInterval(fetchAndDraw, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(t);
      cleanup();
    };
  }, [gexEnabled, symbol]);

  return (
    <Box sx={{ position: 'relative', mb: 1.5, borderRadius: 1, overflow: 'hidden', border: '1px solid #2b2b43' }}>
      {loading && (
        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, backgroundColor: '#16162a' }}>
          <CircularProgress size={24} sx={{ color: '#7c8190' }} />
        </Box>
      )}
      {error && (
        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, backgroundColor: '#16162a' }}>
          <Typography sx={{ fontSize: 11, color: '#7c8190' }}>{error}</Typography>
        </Box>
      )}
      {/* minHeight (not height) so the browser's CSS resize handle can grow
          the div without React clobbering the user's drag on re-render. The
          chart's ResizeObserver inside the effect picks up the new height. */}
      <div
        ref={containerRef}
        style={{ minHeight: height, resize: 'vertical', overflow: 'hidden' }}
        title="Drag the bottom-right corner to resize"
      />
    </Box>
  );
}
