import {
  Box,
  IconButton,
  Typography,
  Divider,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChartStore } from '@/store/chartStore';
import { useQuery } from '@tanstack/react-query';
import { fetchOptionChain, fetchOptionQuotes } from '@/services/api/marketData';

export function OptionsPanel({ open }: { open: boolean }) {
  const {
    optionsPanelWidth,
    setOptionsPanelWidth,
    setOptionsPanelOpen,
    symbol,
    bars,
  } =
    useChartStore();
  const resizingRef = useRef(false);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'LTP' | 'OI'>('LTP');
  const listRef = useRef<HTMLDivElement | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [selectedRight, setSelectedRight] = useState<'C' | 'P'>('C');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['options-chain', symbol],
    queryFn: () => fetchOptionChain(symbol),
    enabled: open,
  });

  const chainData = useMemo(() => {
    const expirations = data?.expirations ?? [];
    return expirations.map((exp) => ({
      date: exp.date,
      rows: exp.strikes.map((strike) => ({
        strike,
        callLtp: null,
        callChg: 0,
        callOi: 0,
        callOiChg: 0,
        iv: null,
        putLtp: null,
        putChg: 0,
        putOi: 0,
        putOiChg: 0,
      })),
    }));
  }, [data]);

  const quotesQuery = useQuery({
    queryKey: ['options-quotes', symbol, selectedExpiry],
    queryFn: async () => {
      if (!selectedExpiry) return null;
      const expiryData = chainData.find((exp) => exp.date === selectedExpiry);
      const strikes = expiryData?.rows.map((r) => r.strike) ?? [];
      if (strikes.length === 0) return null;
      return fetchOptionQuotes(symbol, selectedExpiry, strikes);
    },
    enabled: open && Boolean(selectedExpiry) && chainData.length > 0,
  });

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const nextWidth = Math.min(
        Math.max(320, window.innerWidth - event.clientX),
        window.innerWidth - 240
      );
      setOptionsPanelWidth(nextWidth);
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
  }, [setOptionsPanelWidth]);

  useEffect(() => {
    if (!selectedExpiry && chainData.length > 0) {
      const now = new Date();
      const day = now.getDay();
      const daysUntilFriday = (5 - day + 7) % 7 || 7;
      const nextFriday = new Date(now);
      nextFriday.setDate(now.getDate() + daysUntilFriday);
      const nextFridayKey = `${nextFriday.getFullYear()}-${String(
        nextFriday.getMonth() + 1
      ).padStart(2, '0')}-${String(nextFriday.getDate()).padStart(2, '0')}`;
      const available = chainData.map((exp) => exp.date).sort();
      const match = available.find((date) => date >= nextFridayKey) ?? available[0];
      setSelectedExpiry(match);
    }
  }, [chainData, selectedExpiry]);

  useEffect(() => {
    setSelectedExpiry(null);
    setSelectedStrike(null);
  }, [symbol]);

  const currentExpiry = chainData.find((exp) => exp.date === selectedExpiry);
  const quotesByKey = useMemo(() => {
    const map = new Map<string, NonNullable<typeof quotesQuery.data>['quotes'][number]>();
    if (!quotesQuery.data?.quotes) return map;
    for (const quote of quotesQuery.data.quotes) {
      map.set(`${quote.strike}-${quote.right}`, quote);
    }
    return map;
  }, [quotesQuery.data]);
  const filteredRows = useMemo(() => {
    if (!quotesQuery.data?.quotes) return [];
    const strikes = Array.from(
      new Set(quotesQuery.data.quotes.map((quote) => quote.strike))
    ).sort((a, b) => a - b);
    return strikes.map((strike) => ({ strike }));
  }, [quotesQuery.data]);

  const maxValues = useMemo(() => {
    if (filteredRows.length === 0) {
      return { callMax: 1, putMax: 1 };
    }
    const callValues = filteredRows.map((row) => {
      const quote = quotesByKey.get(`${row.strike}-C`);
      return viewMode === 'OI' ? quote?.oi ?? 0 : quote?.last ?? 0;
    });
    const putValues = filteredRows.map((row) => {
      const quote = quotesByKey.get(`${row.strike}-P`);
      return viewMode === 'OI' ? quote?.oi ?? 0 : quote?.last ?? 0;
    });
    return {
      callMax: Math.max(1, ...callValues),
      putMax: Math.max(1, ...putValues),
    };
  }, [filteredRows, quotesByKey, viewMode]);

  const underlyingPrice = bars.length > 0 ? bars[bars.length - 1].close : null;
  const selectedQuote = selectedStrike
    ? quotesByKey.get(`${selectedStrike}-${selectedRight}`)
    : undefined;
  const selectedBid =
    selectedQuote?.bid !== null && selectedQuote?.bid !== undefined && selectedQuote?.bid > 0
      ? selectedQuote.bid
      : null;
  const selectedAsk =
    selectedQuote?.ask !== null && selectedQuote?.ask !== undefined && selectedQuote?.ask > 0
      ? selectedQuote.ask
      : null;
  const selectedLast =
    selectedQuote?.last !== null && selectedQuote?.last !== undefined && selectedQuote?.last > 0
      ? selectedQuote.last
      : null;
  const selectedMid =
    selectedBid !== null && selectedAsk !== null ? (selectedBid + selectedAsk) / 2 : null;
  const selectedPrice = selectedLast ?? selectedMid ?? 0;
  const hasPrice = selectedLast !== null || selectedMid !== null;
  const dte = selectedExpiry
    ? Math.max(
        0,
        Math.ceil(
          (new Date(selectedExpiry).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        )
      )
    : null;

  useEffect(() => {
    if (!listRef.current || filteredRows.length === 0) return;
    const middleIndex = Math.floor(filteredRows.length / 2);
    const row = listRef.current.children[middleIndex] as HTMLElement | undefined;
    if (!row) return;
    const offset = row.offsetTop - listRef.current.clientHeight / 2 + row.clientHeight / 2;
    listRef.current.scrollTop = Math.max(0, offset);
  }, [filteredRows]);

  useEffect(() => {
    if (filteredRows.length === 0) return;
    if (selectedStrike === null) {
      setSelectedStrike(filteredRows[Math.floor(filteredRows.length / 2)].strike);
      setSelectedRight('C');
    }
  }, [filteredRows, selectedStrike]);

  return (
    <Box
      sx={{
        width: optionsPanelWidth,
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
          Options Chain
        </Typography>
        <IconButton
          onClick={() => setOptionsPanelOpen(false)}
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
          padding: 2,
        }}
      >
        <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 1 }}>
          {symbol} option chain
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, marginBottom: 2 }}>
          <TextField
            type="date"
            size="small"
            value={selectedExpiry ?? ''}
            onChange={(event) => {
              const next = event.target.value;
    const available = chainData.map((exp) => exp.date).sort();
              if (available.includes(next)) {
                setSelectedExpiry(next);
                return;
              }
              const nextMatch = available.find((date) => date >= next) ?? available[0];
              setSelectedExpiry(nextMatch);
            }}
            sx={{
              minWidth: 130,
              '& .MuiOutlinedInput-root': {
                height: 32,
                borderRadius: 999,
                fontSize: 12,
                color: '#d1d4dc',
                paddingRight: 1,
              },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: '#2b2b43' },
              '&:hover .MuiOutlinedInput-notchedOutline': {
                borderColor: '#4b4b63',
              },
              '& input': {
                paddingY: 0,
                paddingX: 1,
              },
              '& input::-webkit-calendar-picker-indicator': {
                filter: 'invert(0.8)',
              },
            }}
            inputProps={{
              min: chainData[0]?.date,
              max: chainData[chainData.length - 1]?.date,
            }}
          />
          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={(_event, value) => value && setViewMode(value)}
            size="small"
            sx={{
              '& .MuiToggleButton-root': {
                textTransform: 'none',
                fontSize: 11,
                color: '#d1d4dc',
                borderColor: '#2b2b43',
                paddingX: 1.5,
                '&.Mui-selected': {
                  backgroundColor: '#2962ff',
                  color: '#ffffff',
                  '&:hover': { backgroundColor: '#1e53e5' },
                },
              },
            }}
          >
            <ToggleButton value="LTP">LTP</ToggleButton>
            <ToggleButton value="OI">OI</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 80px 60px 1fr',
            gap: 1,
            paddingY: 1,
            borderBottom: '1px solid #2b2b43',
            fontSize: 11,
            color: '#9aa0a6',
          }}
        >
          <Box>{viewMode === 'OI' ? 'Call OI' : 'Call LTP'}</Box>
          <Box sx={{ textAlign: 'center' }}>Strike</Box>
          <Box sx={{ textAlign: 'center' }}>IV</Box>
          <Box sx={{ textAlign: 'right' }}>{viewMode === 'OI' ? 'Put OI' : 'Put LTP'}</Box>
        </Box>

        {(isLoading || quotesQuery.isFetching) && (
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Processing…
          </Typography>
        )}
        {isError && (
          <Typography sx={{ fontSize: 12, color: '#ef5350' }}>
            Failed to load option chain.
          </Typography>
        )}
        {currentExpiry && !isLoading && !isError ? (
          <>
            <Box
              ref={listRef}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                marginTop: 1,
                maxHeight: '320px',
                overflowY: 'auto',
                scrollbarWidth: 'none',
                '&::-webkit-scrollbar': { display: 'none' },
              }}
            >
              {filteredRows.map((row) => {
                const callQuote = quotesByKey.get(`${row.strike}-C`);
                const putQuote = quotesByKey.get(`${row.strike}-P`);
                const callLast =
                  callQuote?.last !== undefined && callQuote?.last !== null && callQuote.last > 0
                    ? callQuote.last
                    : null;
                const callBid =
                  callQuote?.bid !== undefined && callQuote?.bid !== null && callQuote.bid > 0
                    ? callQuote.bid
                    : null;
                const callAsk =
                  callQuote?.ask !== undefined && callQuote?.ask !== null && callQuote.ask > 0
                    ? callQuote.ask
                    : null;
                const callValue =
                  viewMode === 'OI'
                    ? callQuote?.oi ?? 0
                    : callLast ??
                      (callBid !== null && callAsk !== null ? (callBid + callAsk) / 2 : null);
                const putLast =
                  putQuote?.last !== undefined && putQuote?.last !== null && putQuote.last > 0
                    ? putQuote.last
                    : null;
                const putBid =
                  putQuote?.bid !== undefined && putQuote?.bid !== null && putQuote.bid > 0
                    ? putQuote.bid
                    : null;
                const putAsk =
                  putQuote?.ask !== undefined && putQuote?.ask !== null && putQuote.ask > 0
                    ? putQuote.ask
                    : null;
                const putValue =
                  viewMode === 'OI'
                    ? putQuote?.oi ?? 0
                    : putLast ??
                      (putBid !== null && putAsk !== null ? (putBid + putAsk) / 2 : null);
                const ivValue = callQuote?.iv ?? putQuote?.iv ?? null;
                return (
                  <Box
                    key={row.strike}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 80px 60px 1fr',
                      gap: 1,
                      alignItems: 'center',
                      fontSize: 12,
                    }}
                  >
                    <Box
                      onClick={() => {
                        setSelectedStrike(row.strike);
                        setSelectedRight('C');
                      }}
                      sx={{
                        position: 'relative',
                        borderRadius: 1,
                        paddingY: 0.5,
                        paddingX: 1,
                        color: '#26a69a',
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontWeight: 600,
                        overflow: 'hidden',
                        fontVariantNumeric: 'tabular-nums',
                        cursor: 'pointer',
                        outline:
                          selectedStrike === row.strike && selectedRight === 'C'
                            ? '1px solid #26a69a'
                            : 'none',
                      }}
                    >
                      <Box
                        sx={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${
                            (callValue ?? 0) === 0
                              ? 0
                              : Math.max(
                                  8,
                                  Math.round(((callValue ?? 0) / maxValues.callMax) * 100)
                                )
                          }%`,
                          backgroundColor:
                            viewMode === 'OI'
                              ? 'rgba(38, 166, 154, 0.2)'
                              : 'rgba(239, 83, 80, 0.15)',
                        }}
                      />
                      <Box sx={{ position: 'relative', zIndex: 1 }}>
                        {viewMode === 'OI'
                          ? '--'
                          : callValue === null || callValue === undefined
                            ? '--'
                            : (callValue as number).toFixed(2)}
                      </Box>
                      <Box sx={{ position: 'relative', zIndex: 1 }}>
                        {viewMode === 'OI' ? (callValue ?? 0).toLocaleString() : '--'}
                      </Box>
                    </Box>
                    <Box sx={{ textAlign: 'center', color: '#d1d4dc', fontWeight: 600 }}>
                      {row.strike}
                    </Box>
                    <Box sx={{ textAlign: 'center', color: '#d1d4dc' }}>
                      {ivValue === null ? '--' : ivValue.toFixed(1)}
                    </Box>
                    <Box
                      onClick={() => {
                        setSelectedStrike(row.strike);
                        setSelectedRight('P');
                      }}
                      sx={{
                        position: 'relative',
                        borderRadius: 1,
                        paddingY: 0.5,
                        paddingX: 1,
                        color: '#ef5350',
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontWeight: 600,
                        overflow: 'hidden',
                        fontVariantNumeric: 'tabular-nums',
                        cursor: 'pointer',
                        outline:
                          selectedStrike === row.strike && selectedRight === 'P'
                            ? '1px solid #ef5350'
                            : 'none',
                      }}
                    >
                      <Box
                        sx={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: `${
                            (putValue ?? 0) === 0
                              ? 0
                              : Math.max(
                                  8,
                                  Math.round(((putValue ?? 0) / maxValues.putMax) * 100)
                                )
                          }%`,
                          backgroundColor:
                            viewMode === 'OI'
                              ? 'rgba(239, 83, 80, 0.15)'
                              : 'rgba(38, 166, 154, 0.2)',
                        }}
                      />
                      <Box sx={{ position: 'relative', zIndex: 1 }}>
                        {viewMode === 'OI'
                          ? '--'
                          : putValue === null || putValue === undefined
                            ? '--'
                            : (putValue as number).toFixed(2)}
                      </Box>
                      <Box sx={{ position: 'relative', zIndex: 1 }}>
                        {viewMode === 'OI' ? (putValue ?? 0).toLocaleString() : '--'}
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </Box>
            <Box sx={{ marginTop: 2 }}>
              {selectedStrike && underlyingPrice !== null ? (
                <>
                  <Typography sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 1 }}>
                    {symbol} {selectedExpiry} {selectedRight === 'C' ? 'Call' : 'Put'}{' '}
                    {selectedStrike}
                  </Typography>
                  {!hasPrice && (
                    <Typography sx={{ fontSize: 11, color: '#9aa0a6', marginBottom: 1 }}>
                      No option price available — showing intrinsic payoff only.
                    </Typography>
                  )}
                  <Box sx={{ fontSize: 12, color: '#9aa0a6', marginBottom: 2 }}>
                    <Box>Bid: {selectedBid ?? '--'}</Box>
                    <Box>Ask: {selectedAsk ?? '--'}</Box>
                    <Box>Last: {selectedLast ?? '--'}</Box>
                    <Box>Mid: {selectedMid ? selectedMid.toFixed(2) : '--'}</Box>
                    <Box>DTE: {dte ?? '--'}</Box>
                  </Box>
                  <Box
                    sx={{
                      width: '100%',
                      height: 160,
                      border: '1px solid #2b2b43',
                      borderRadius: 1,
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    {(() => {
                      const width = 320;
                      const height = 160;
                      const padding = 18;
                      const base = underlyingPrice;
                      const range = base * 0.15;
                      const min = base - range;
                      const max = base + range;
                      const points = 50;
                      const payoff = (s: number) => {
                        if (selectedRight === 'C') {
                          return Math.max(s - selectedStrike, 0) - selectedPrice;
                        }
                        return Math.max(selectedStrike - s, 0) - selectedPrice;
                      };
                      const values = Array.from({ length: points }, (_, i) => {
                        const s = min + (i / (points - 1)) * (max - min);
                        return { s, p: payoff(s) };
                      });
                      const pMin = Math.min(...values.map((v) => v.p));
                      const pMax = Math.max(...values.map((v) => v.p));
                      const pRange = pMax - pMin || 1;
                      const toX = (s: number) =>
                        padding + ((s - min) / (max - min)) * (width - padding * 2);
                      const toY = (p: number) =>
                        padding + (1 - (p - pMin) / pRange) * (height - padding * 2);
                      const path = values
                        .map((v) => `${toX(v.s)},${toY(v.p)}`)
                        .join(' ');
                      const zeroY = toY(0);
                      const spotX = toX(base);
                      const minLabel = min.toFixed(0);
                      const maxLabel = max.toFixed(0);
                      const spotLabel = base.toFixed(0);
                      const pMinLabel = pMin.toFixed(2);
                      const pMaxLabel = pMax.toFixed(2);
                      const zeroLabel = '0';
                      return (
                        <svg width={width} height={height} style={{ display: 'block' }}>
                          <text x={padding} y={height - 4} fill="#9aa0a6" fontSize="10">
                            {minLabel}
                          </text>
                          <text
                            x={width - padding}
                            y={height - 4}
                            fill="#9aa0a6"
                            fontSize="10"
                            textAnchor="end"
                          >
                            {maxLabel}
                          </text>
                          <text
                            x={spotX}
                            y={height - 4}
                            fill="#ffd54f"
                            fontSize="10"
                            textAnchor="middle"
                          >
                            {spotLabel}
                          </text>
                          <text x={4} y={padding + 4} fill="#9aa0a6" fontSize="10">
                            {pMaxLabel}
                          </text>
                          <text x={4} y={height - padding} fill="#9aa0a6" fontSize="10">
                            {pMinLabel}
                          </text>
                          <text x={4} y={zeroY - 4} fill="#9aa0a6" fontSize="10">
                            {zeroLabel}
                          </text>
                          <line
                            x1={padding}
                            x2={width - padding}
                            y1={zeroY}
                            y2={zeroY}
                            stroke="rgba(154, 160, 166, 0.4)"
                          />
                          <line
                            x1={spotX}
                            x2={spotX}
                            y1={padding}
                            y2={height - padding}
                            stroke="rgba(255, 213, 79, 0.6)"
                            strokeDasharray="4 4"
                          />
                          <polyline
                            fill="none"
                            stroke="#26a69a"
                            strokeWidth="2"
                            points={path}
                          />
                        </svg>
                      );
                    })()}
                  </Box>
                </>
              ) : (
                <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
                  Select a call or put to view the payoff chart.
                </Typography>
              )}
            </Box>
          </>
        ) : (
          <Typography sx={{ fontSize: 12, color: '#9aa0a6' }}>
            Select an expiration to see strikes.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
