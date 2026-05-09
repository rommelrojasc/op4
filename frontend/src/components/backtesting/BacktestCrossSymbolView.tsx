/**
 * BacktestCrossSymbolView — Cross-company hourly analysis
 *
 * Runs range analysis across multiple selected symbols and aggregates results:
 * 1. Hourly win/loss outcomes (butterfly chart)
 * 2. Strategy × Hour heatmap
 * 3. Symbol performance rankings
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Alert,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Paper,
  LinearProgress,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  InputAdornment,
  Checkbox,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { API_BASE_URL } from '@/services/api/marketData';
import { StrategyFilterButton, DEFAULT_ENABLED, enabledStrategiesToParam, type EnabledStrategies } from '@/components/backtesting/StrategyFilterButton';
import { playDoneSound } from '@/utils/sound';
import { CompanyLogo } from '@/components/backtesting/TickerSelectionModal';
import { SYMBOL_NAMES, SYMBOL_GROUPS } from '@/constants/symbols';
import { subDays } from 'date-fns';
import type { BacktestCrossSymbolResponse, CrossSymbolSignalDetail } from '@/types/chart.types';

const cellSx = { color: '#d1d4dc', borderColor: '#2b2b43', fontSize: 13, py: 1 };
const headerCellSx = { ...cellSx, fontWeight: 600, color: '#787b86', fontSize: 12 };
const TRADING_HOURS = ['9', '10', '11', '12', '13', '14', '15'];

function formatDate(date: Date | null): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip
      title={text}
      placement="top"
      arrow
      slotProps={{
        tooltip: { sx: { bgcolor: '#1e2433', color: '#d1d4dc', fontSize: 12, maxWidth: 280, border: '1px solid #2b2b43' } },
        arrow: { sx: { color: '#1e2433' } },
      }}
    >
      <InfoOutlinedIcon sx={{ fontSize: 14, color: '#787b86', ml: 0.5, verticalAlign: 'middle', cursor: 'help' }} />
    </Tooltip>
  );
}

// ─── Multi-Symbol Picker Dialog (grouped by sector) ───────────────────

function SymbolPickerDialog({
  open,
  onClose,
  selected,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onConfirm: (symbols: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set(selected));

  // Reset when dialog opens
  useEffect(() => {
    if (open) { setChecked(new Set(selected)); setSearch(''); }
  }, [open, selected]);

  const q = search.toLowerCase();

  // Filter groups: keep a group if its label matches OR any of its symbols match
  const filteredGroups = useMemo(() => {
    if (!q) return SYMBOL_GROUPS;
    return SYMBOL_GROUPS
      .map((g) => ({
        ...g,
        symbols: g.label.toLowerCase().includes(q)
          ? g.symbols // group label matches → show all symbols
          : g.symbols.filter((s) => s.toLowerCase().includes(q) || SYMBOL_NAMES[s]?.toLowerCase().includes(q)),
      }))
      .filter((g) => g.symbols.length > 0);
  }, [q]);

  const toggle = (sym: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      return next;
    });
  };

  const toggleGroup = (symbols: string[]) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const allSelected = symbols.every((s) => next.has(s));
      if (allSelected) {
        symbols.forEach((s) => next.delete(s));
      } else {
        symbols.forEach((s) => next.add(s));
      }
      return next;
    });
  };

  const selectAll = () => {
    const all = new Set<string>();
    SYMBOL_GROUPS.forEach((g) => g.symbols.forEach((s) => all.add(s)));
    setChecked(all);
  };
  const deselectAll = () => setChecked(new Set());

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { bgcolor: '#1e1e1e', border: '1px solid #2b2b43', minHeight: 500 } }}
    >
      <DialogTitle sx={{ fontSize: 18, fontWeight: 600, pb: 1 }}>Select Symbols</DialogTitle>

      <Box sx={{ px: 3, pb: 1, display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          fullWidth
          placeholder="Search by symbol, company, or group..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          size="small"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ color: '#787b86' }} />
              </InputAdornment>
            ),
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              color: '#d1d4dc',
              '& fieldset': { borderColor: '#2b2b43' },
              '&:hover fieldset': { borderColor: '#4b4b63' },
              '&.Mui-focused fieldset': { borderColor: '#2962ff' },
            },
          }}
        />
        <Button size="small" onClick={selectAll} sx={{ textTransform: 'none', color: '#2962ff', whiteSpace: 'nowrap' }}>
          Select All
        </Button>
        <Button size="small" onClick={deselectAll} sx={{ textTransform: 'none', color: '#787b86', whiteSpace: 'nowrap' }}>
          Deselect All
        </Button>
      </Box>

      <DialogContent sx={{ pt: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {filteredGroups.map((group) => {
            const groupCheckedCount = group.symbols.filter((s) => checked.has(s)).length;
            const allGroupChecked = groupCheckedCount === group.symbols.length;
            const someGroupChecked = groupCheckedCount > 0 && !allGroupChecked;

            return (
              <Box key={group.id}>
                {/* Group header */}
                <Box
                  onClick={() => toggleGroup(group.symbols)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    mb: 0.75,
                    cursor: 'pointer',
                    '&:hover .group-label': { color: '#d1d4dc' },
                  }}
                >
                  <Checkbox
                    checked={allGroupChecked}
                    indeterminate={someGroupChecked}
                    size="small"
                    sx={{ p: 0, color: '#4b4b63', '&.Mui-checked': { color: '#2962ff' }, '&.MuiCheckbox-indeterminate': { color: '#2962ff' } }}
                  />
                  <Typography className="group-label" sx={{ fontSize: 13, fontWeight: 600, color: '#787b86', transition: 'color 0.15s' }}>
                    {group.label}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: '#4b4b63' }}>
                    ({groupCheckedCount}/{group.symbols.length})
                  </Typography>
                </Box>

                {/* Symbol cards grid */}
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 1, pl: 1 }}>
                  {group.symbols.map((symbol) => {
                    const isChecked = checked.has(symbol);
                    return (
                      <Box
                        key={symbol}
                        onClick={() => toggle(symbol)}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          p: 0.75,
                          borderRadius: '6px',
                          border: isChecked ? '2px solid #2962ff' : '1px solid #2b2b43',
                          bgcolor: isChecked ? 'rgba(41, 98, 255, 0.1)' : '#131722',
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                          '&:hover': { borderColor: isChecked ? '#2962ff' : '#4b4b63', bgcolor: isChecked ? 'rgba(41, 98, 255, 0.15)' : '#1a1a2e' },
                        }}
                      >
                        <Checkbox
                          checked={isChecked}
                          size="small"
                          sx={{ p: 0, color: '#4b4b63', '&.Mui-checked': { color: '#2962ff' } }}
                        />
                        <CompanyLogo symbol={symbol} size={24} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#d1d4dc', lineHeight: 1.2 }}>{symbol}</Typography>
                          <Typography sx={{ fontSize: 10, color: '#787b86', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {SYMBOL_NAMES[symbol]?.split(',')[0] || ''}
                          </Typography>
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}

          {filteredGroups.length === 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 6 }}>
              <Typography sx={{ color: '#787b86', fontSize: 14 }}>
                No symbols found matching "{search}"
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2, borderTop: '1px solid #2b2b43' }}>
        <Typography sx={{ fontSize: 13, color: '#787b86', mr: 'auto' }}>{checked.size} selected</Typography>
        <Button onClick={onClose} sx={{ textTransform: 'none', color: '#787b86' }}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => { onConfirm(Array.from(checked)); onClose(); }}
          disabled={checked.size === 0}
          sx={{ textTransform: 'none', bgcolor: '#2962ff', '&:hover': { bgcolor: '#1e53e5' } }}
        >
          Analyze {checked.size} Symbol{checked.size !== 1 ? 's' : ''}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── Section 1: Hourly Outcome Chart (butterfly) ──────────────────────

function HourlyOutcomeChart({ signals }: { signals: CrossSymbolSignalDetail[] }) {
  const hourData = TRADING_HOURS.map((h) => {
    const hourSignals = signals.filter((s) => s.session === h && s.mfe_pct != null && s.mae_pct != null);
    const wins = hourSignals.filter((s) => s.mfe_pct! > s.mae_pct!).length;
    const losses = hourSignals.length - wins;
    const winRate = hourSignals.length > 0 ? (wins / hourSignals.length) * 100 : 0;
    return { hour: h, wins, losses, total: hourSignals.length, winRate };
  });

  const maxCount = Math.max(...hourData.map((d) => Math.max(d.wins, d.losses)), 1);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {hourData.map((d) => (
        <Box key={d.hour} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 11, color: '#26a69a', width: 24, textAlign: 'right', flexShrink: 0 }}>{d.wins}</Typography>
          <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end' }}>
            <Box sx={{ height: '100%', width: `${(d.wins / maxCount) * 100}%`, bgcolor: '#26a69a', borderRadius: 0.5, minWidth: d.wins > 0 ? 4 : 0 }} />
          </Box>
          <Box sx={{ width: 80, textAlign: 'center', flexShrink: 0 }}>
            <Typography sx={{ fontSize: 11, color: '#d1d4dc', fontWeight: 500, lineHeight: 1.2 }}>
              {d.hour === '9' ? '9:30' : `${d.hour}:00`}
            </Typography>
            {d.total > 0 && (
              <Typography sx={{ fontSize: 10, color: d.winRate >= 50 ? '#26a69a' : '#ef5350', lineHeight: 1.2 }}>
                {d.winRate.toFixed(0)}% win
              </Typography>
            )}
          </Box>
          <Box sx={{ flex: 1, height: 18, bgcolor: '#1a1f2e', borderRadius: 0.5, overflow: 'hidden' }}>
            <Box sx={{ height: '100%', width: `${(d.losses / maxCount) * 100}%`, bgcolor: '#ef5350', borderRadius: 0.5, minWidth: d.losses > 0 ? 4 : 0 }} />
          </Box>
          <Typography sx={{ fontSize: 11, color: '#ef5350', width: 24, textAlign: 'left', flexShrink: 0 }}>{d.losses}</Typography>
        </Box>
      ))}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mt: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#26a69a', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>Win (MFE {'>'} MAE)</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 10, height: 10, bgcolor: '#ef5350', borderRadius: 0.5 }} />
          <Typography sx={{ fontSize: 11, color: '#787b86' }}>Loss (MFE {'≤'} MAE)</Typography>
        </Box>
      </Box>
    </Box>
  );
}

// ─── Section 2: Strategy × Hour Heatmap ───────────────────────────────

function StrategyHourHeatmap({ signals }: { signals: CrossSymbolSignalDetail[] }) {
  // Build strategy × hour data
  const strategies = useMemo(() => {
    const map: Record<string, Record<string, { wins: number; total: number }>> = {};
    for (const sig of signals) {
      if (sig.mfe_pct == null || sig.mae_pct == null) continue;
      const sid = sig.strategy_id;
      const h = sig.session;
      if (!map[sid]) map[sid] = {};
      if (!map[sid][h]) map[sid][h] = { wins: 0, total: 0 };
      map[sid][h].total++;
      if (sig.mfe_pct > sig.mae_pct) map[sid][h].wins++;
    }
    return map;
  }, [signals]);

  const strategyIds = Object.keys(strategies).sort();
  if (strategyIds.length === 0) return null;

  return (
    <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={headerCellSx}>Strategy</TableCell>
            {TRADING_HOURS.map((h) => (
              <TableCell key={h} sx={{ ...headerCellSx, textAlign: 'center', minWidth: 70 }}>
                {h === '9' ? '9:30' : `${h}:00`}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {strategyIds.map((sid) => (
            <TableRow key={sid}>
              <TableCell sx={cellSx}>{sid}</TableCell>
              {TRADING_HOURS.map((h) => {
                const cell = strategies[sid]?.[h];
                if (!cell || cell.total === 0) {
                  return <TableCell key={h} sx={{ ...cellSx, textAlign: 'center', bgcolor: 'transparent', color: '#4b4b63' }}>—</TableCell>;
                }
                const winRate = cell.wins / cell.total;
                const distance = Math.abs(winRate - 0.5) / 0.5; // 0 at 50%, 1 at 0% or 100%
                const intensity = 0.15 + distance * 0.5;
                const bg = winRate > 0.5
                  ? `rgba(38, 166, 154, ${intensity})`
                  : `rgba(239, 83, 80, ${intensity})`;
                const textColor = winRate > 0.5 ? '#26a69a' : '#ef5350';
                return (
                  <TableCell key={h} sx={{ ...cellSx, textAlign: 'center', bgcolor: bg }}>
                    <Typography sx={{ fontSize: 12, color: textColor, fontWeight: 500 }}>
                      {(winRate * 100).toFixed(0)}%
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: '#787b86' }}>
                      ({cell.wins}/{cell.total})
                    </Typography>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ─── Section 3: Symbol Performance Table ──────────────────────────────

type SortKey = 'symbol' | 'signals' | 'winRate' | 'avgMfe' | 'avgMae' | 'bestHour';

interface SymbolRow {
  symbol: string;
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgMfe: number;
  avgMae: number;
  bestHour: string;
}

function SymbolPerformanceTable({ signals }: { signals: CrossSymbolSignalDetail[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('winRate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const rows: SymbolRow[] = useMemo(() => {
    const map: Record<string, CrossSymbolSignalDetail[]> = {};
    for (const sig of signals) {
      if (!map[sig.symbol]) map[sig.symbol] = [];
      map[sig.symbol].push(sig);
    }

    return Object.entries(map).map(([symbol, sigs]) => {
      const withData = sigs.filter((s) => s.mfe_pct != null && s.mae_pct != null);
      const wins = withData.filter((s) => s.mfe_pct! > s.mae_pct!).length;
      const winRate = withData.length > 0 ? (wins / withData.length) * 100 : 0;
      const mfeVals = withData.filter((s) => s.mfe_pct != null).map((s) => s.mfe_pct!);
      const maeVals = withData.filter((s) => s.mae_pct != null).map((s) => s.mae_pct!);
      const avgMfe = mfeVals.length > 0 ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : 0;
      const avgMae = maeVals.length > 0 ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : 0;

      // Best hour: highest win rate with min 2 signals
      let bestHour = '—';
      let bestRate = -1;
      for (const h of TRADING_HOURS) {
        const hSigs = withData.filter((s) => s.session === h);
        if (hSigs.length >= 2) {
          const hWins = hSigs.filter((s) => s.mfe_pct! > s.mae_pct!).length;
          const hRate = hWins / hSigs.length;
          if (hRate > bestRate) {
            bestRate = hRate;
            bestHour = h === '9' ? '9:30' : `${h}:00`;
          }
        }
      }

      return { symbol, signals: withData.length, wins, losses: withData.length - wins, winRate, avgMfe, avgMae, bestHour };
    });
  }, [signals]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const aVal = a[sortKey] as number | string;
      const bVal = b[sortKey] as number | string;
      if (typeof aVal === 'string') return sortDir === 'asc' ? (aVal as string).localeCompare(bVal as string) : (bVal as string).localeCompare(aVal as string);
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  // Top symbols per hour
  const topPerHour = useMemo(() => {
    return TRADING_HOURS.map((h) => {
      // For each symbol, compute win rate for this hour (min 2 signals)
      const symbolRates: { symbol: string; winRate: number; count: number }[] = [];
      const map: Record<string, CrossSymbolSignalDetail[]> = {};
      for (const sig of signals) {
        if (sig.session !== h || sig.mfe_pct == null || sig.mae_pct == null) continue;
        if (!map[sig.symbol]) map[sig.symbol] = [];
        map[sig.symbol].push(sig);
      }
      for (const [symbol, sigs] of Object.entries(map)) {
        if (sigs.length >= 2) {
          const wins = sigs.filter((s) => s.mfe_pct! > s.mae_pct!).length;
          symbolRates.push({ symbol, winRate: (wins / sigs.length) * 100, count: sigs.length });
        }
      }
      symbolRates.sort((a, b) => b.winRate - a.winRate);
      return { hour: h, top: symbolRates.slice(0, 3) };
    });
  }, [signals]);

  return (
    <Box>
      <TableContainer component={Paper} sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={headerCellSx}>
                <TableSortLabel active={sortKey === 'symbol'} direction={sortKey === 'symbol' ? sortDir : 'asc'} onClick={() => handleSort('symbol')} sx={{ color: '#787b86 !important', '& .MuiTableSortLabel-icon': { color: '#787b86 !important' } }}>
                  Symbol
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>
                <TableSortLabel active={sortKey === 'signals'} direction={sortKey === 'signals' ? sortDir : 'asc'} onClick={() => handleSort('signals')} sx={{ color: '#787b86 !important', '& .MuiTableSortLabel-icon': { color: '#787b86 !important' } }}>
                  Signals
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>
                <TableSortLabel active={sortKey === 'winRate'} direction={sortKey === 'winRate' ? sortDir : 'asc'} onClick={() => handleSort('winRate')} sx={{ color: '#787b86 !important', '& .MuiTableSortLabel-icon': { color: '#787b86 !important' } }}>
                  Win Rate
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>W / L</TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                <TableSortLabel active={sortKey === 'avgMfe'} direction={sortKey === 'avgMfe' ? sortDir : 'asc'} onClick={() => handleSort('avgMfe')} sx={{ color: '#787b86 !important', '& .MuiTableSortLabel-icon': { color: '#787b86 !important' } }}>
                  Avg MFE%
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'right' }}>
                <TableSortLabel active={sortKey === 'avgMae'} direction={sortKey === 'avgMae' ? sortDir : 'asc'} onClick={() => handleSort('avgMae')} sx={{ color: '#787b86 !important', '& .MuiTableSortLabel-icon': { color: '#787b86 !important' } }}>
                  Avg MAE%
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ ...headerCellSx, textAlign: 'center' }}>Best Hour</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.symbol}>
                <TableCell sx={cellSx}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CompanyLogo symbol={row.symbol} size={24} />
                    <Typography sx={{ fontSize: 13, fontWeight: 600, color: '#d1d4dc' }}>{row.symbol}</Typography>
                  </Box>
                </TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'center' }}>{row.signals}</TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'center' }}>
                  <Chip
                    label={`${row.winRate.toFixed(0)}%`}
                    size="small"
                    sx={{
                      fontSize: 11,
                      bgcolor: row.winRate >= 50 ? '#1b5e20' : '#5c1a1a',
                      color: row.winRate >= 50 ? '#81c784' : '#ef9a9a',
                      minWidth: 48,
                    }}
                  />
                </TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'center' }}>
                  <Typography component="span" sx={{ color: '#26a69a', fontSize: 13 }}>{row.wins}</Typography>
                  <Typography component="span" sx={{ color: '#787b86', fontSize: 13 }}> / </Typography>
                  <Typography component="span" sx={{ color: '#ef5350', fontSize: 13 }}>{row.losses}</Typography>
                </TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'right', color: '#26a69a' }}>{row.avgMfe.toFixed(3)}</TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'right', color: '#ef5350' }}>{row.avgMae.toFixed(3)}</TableCell>
                <TableCell sx={{ ...cellSx, textAlign: 'center' }}>{row.bestHour}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Top Symbols per Hour */}
      <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
        Top Symbols per Hour
        <InfoTip text="Top 3 symbols by win rate for each trading hour (minimum 2 signals)" />
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 1.5 }}>
        {topPerHour.map(({ hour, top }) => (
          <Box
            key={hour}
            sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', borderRadius: 1, p: 1.5 }}
          >
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#787b86', mb: 1 }}>
              {hour === '9' ? '9:30' : `${hour}:00`}
            </Typography>
            {top.length === 0 ? (
              <Typography sx={{ fontSize: 11, color: '#4b4b63' }}>Insufficient data</Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                {top.map((entry, idx) => (
                  <Box key={entry.symbol} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography sx={{ fontSize: 11, color: '#4b4b63', width: 14 }}>{idx + 1}.</Typography>
                    <CompanyLogo symbol={entry.symbol} size={18} />
                    <Typography sx={{ fontSize: 12, color: '#d1d4dc', fontWeight: 500, flex: 1 }}>{entry.symbol}</Typography>
                    <Chip
                      label={`${entry.winRate.toFixed(0)}%`}
                      size="small"
                      sx={{
                        fontSize: 10,
                        height: 20,
                        bgcolor: entry.winRate >= 50 ? '#1b5e20' : '#5c1a1a',
                        color: entry.winRate >= 50 ? '#81c784' : '#ef9a9a',
                      }}
                    />
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── Main View ────────────────────────────────────────────────────────

export function BacktestCrossSymbolView({
  viewMode,
  setViewMode,
}: {
  viewMode: string;
  setViewMode: (v: string) => void;
}) {
  const [startDate, setStartDate] = useState<Date | null>(subDays(new Date(), 7));
  const [endDate, setEndDate] = useState<Date | null>(subDays(new Date(), 1));
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(['SPY', 'QQQ', 'AAPL']);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enabledStrategies, setEnabledStrategies] = useState<EnabledStrategies>(DEFAULT_ENABLED);

  const [data, setData] = useState<BacktestCrossSymbolResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const handleRun = () => {
    if (!startDate || !endDate || selectedSymbols.length === 0) return;

    esRef.current?.close();
    setIsLoading(true);
    setError(null);
    setData(null);
    setStatusMessage('Starting cross-symbol analysis...');
    setProgress(0);

    const params = new URLSearchParams({
      symbols: selectedSymbols.join(','),
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
    });
    const esParam = enabledStrategiesToParam(enabledStrategies);
    if (esParam) params.set('enabled_strategies', esParam);

    const es = new EventSource(`${API_BASE_URL}/api/v1/market-data/backtest-cross-symbol-stream?${params}`);
    esRef.current = es;

    es.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'progress') {
        setStatusMessage(msg.message);
        // Parse progress from "(i/total)" pattern
        const match = msg.message.match(/\((\d+)\/(\d+)\)/);
        if (match) {
          setProgress(Math.round((parseInt(match[1]) / parseInt(match[2])) * 100));
        }
      } else if (msg.type === 'result') {
        setData(msg.data);
        setIsLoading(false);
        setStatusMessage('');
        setProgress(100);
        playDoneSound();
        es.close();
      } else if (msg.type === 'error') {
        setError(msg.message);
        setIsLoading(false);
        setStatusMessage('');
        es.close();
      }
    };

    es.onerror = () => {
      setError('Connection lost during analysis');
      setIsLoading(false);
      setStatusMessage('');
      es.close();
    };
  };

  const datePickerSx = {
    minWidth: 160,
    '& .MuiOutlinedInput-root': {
      color: '#d1d4dc',
      '& fieldset': { borderColor: '#2b2b43' },
      '&:hover fieldset': { borderColor: '#4b4b63' },
    },
    '& .MuiInputLabel-root': { color: '#787b86' },
  };

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Controls */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderBottom: '1px solid #2b2b43', bgcolor: '#0c111a', flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 16, fontWeight: 600, color: '#d1d4dc' }}>Backtesting</Typography>

          <ToggleButtonGroup value={viewMode} exclusive onChange={(_, v) => v && setViewMode(v)} size="small">
            <ToggleButton value="single" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Single Day
            </ToggleButton>
            <ToggleButton value="range" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Range Analysis
            </ToggleButton>
            <ToggleButton value="cross-symbol" sx={{ textTransform: 'none', color: '#787b86', '&.Mui-selected': { color: '#d1d4dc', bgcolor: '#2b2b43' } }}>
              Cross-Symbol
            </ToggleButton>
          </ToggleButtonGroup>

          <DatePicker
            label="Start"
            value={startDate}
            onChange={setStartDate}
            maxDate={new Date()}
            format="MMM d, yyyy"
            slotProps={{ textField: { size: 'small', sx: datePickerSx } }}
          />
          <Typography sx={{ color: '#787b86', fontSize: 13 }}>to</Typography>
          <DatePicker
            label="End"
            value={endDate}
            onChange={setEndDate}
            maxDate={new Date()}
            format="MMM d, yyyy"
            slotProps={{ textField: { size: 'small', sx: datePickerSx } }}
          />

          <Chip
            label={`${selectedSymbols.length} symbol${selectedSymbols.length !== 1 ? 's' : ''} selected`}
            onClick={() => setPickerOpen(true)}
            sx={{
              bgcolor: '#2b2b43',
              color: '#d1d4dc',
              cursor: 'pointer',
              '&:hover': { bgcolor: '#3b3b53' },
              fontSize: 13,
            }}
          />

          <StrategyFilterButton enabled={enabledStrategies} onChange={setEnabledStrategies} />

          <Button
            variant="contained"
            onClick={handleRun}
            disabled={!startDate || !endDate || selectedSymbols.length === 0 || isLoading}
            sx={{ textTransform: 'none', bgcolor: '#2962ff', '&:hover': { bgcolor: '#1e53e5' }, minWidth: 120 }}
          >
            {isLoading ? (
              <>
                <CircularProgress size={16} sx={{ mr: 1, color: 'white' }} />
                Analyzing...
              </>
            ) : (
              'Run Analysis'
            )}
          </Button>

          {statusMessage && (
            <Typography sx={{ fontSize: 13, color: '#787b86', fontStyle: 'italic' }}>{statusMessage}</Typography>
          )}
        </Box>

        {/* Progress bar */}
        {isLoading && (
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{ bgcolor: '#1a1f2e', '& .MuiLinearProgress-bar': { bgcolor: '#2962ff' } }}
          />
        )}

        {/* Error */}
        {error && <Alert severity="error" sx={{ m: 2 }}>Error: {error}</Alert>}

        {/* Results */}
        {data && !isLoading && (
          <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Overview */}
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Box sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', borderRadius: 1, p: 1.5, flex: 1 }}>
                <Typography sx={{ fontSize: 11, color: '#787b86', mb: 0.5 }}>Symbols</Typography>
                <Typography sx={{ fontSize: 18, fontWeight: 600, color: '#d1d4dc' }}>{data.symbols.length}</Typography>
              </Box>
              <Box sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', borderRadius: 1, p: 1.5, flex: 1 }}>
                <Typography sx={{ fontSize: 11, color: '#787b86', mb: 0.5 }}>Total Signals</Typography>
                <Typography sx={{ fontSize: 18, fontWeight: 600, color: '#d1d4dc' }}>{data.total_signals}</Typography>
              </Box>
              <Box sx={{ bgcolor: '#151b28', border: '1px solid #2b2b43', borderRadius: 1, p: 1.5, flex: 1 }}>
                <Typography sx={{ fontSize: 11, color: '#787b86', mb: 0.5 }}>Date Range</Typography>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc' }}>{data.start_date} to {data.end_date}</Typography>
              </Box>
            </Box>

            {/* Section 1: Hourly Outcomes */}
            {data.signals_detail.length > 0 && (
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  Hourly Signal Outcomes (All Symbols)
                  <InfoTip text="Win/loss distribution by hour across all symbols. A win means the stock's favorable move (MFE) exceeded its adverse move (MAE) after the signal." />
                </Typography>
                <HourlyOutcomeChart signals={data.signals_detail} />
              </Box>
            )}

            {/* Section 2: Strategy × Hour Heatmap */}
            {data.signals_detail.length > 0 && (
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  Strategy × Hour Heatmap
                  <InfoTip text="Win rate by strategy and hour. Green = above 50% win rate, red = below 50%. Intensity scales with distance from 50%." />
                </Typography>
                <StrategyHourHeatmap signals={data.signals_detail} />
              </Box>
            )}

            {/* Section 3: Symbol Performance */}
            {data.signals_detail.length > 0 && (
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: '#d1d4dc', mb: 1 }}>
                  Symbol Performance Rankings
                  <InfoTip text="Performance breakdown by symbol. Best Hour shows the hour with highest win rate (minimum 2 signals)." />
                </Typography>
                <SymbolPerformanceTable signals={data.signals_detail} />
              </Box>
            )}

            {data.signals_detail.length === 0 && (
              <Alert severity="info" sx={{ mt: 2 }}>
                No signals found across the selected symbols and date range.
              </Alert>
            )}
          </Box>
        )}

        {/* Empty State */}
        {!data && !isLoading && !error && (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontSize: 16, color: '#787b86' }}>
              Select symbols and a date range, then click "Run Analysis"
            </Typography>
          </Box>
        )}

        {/* Symbol Picker Dialog */}
        <SymbolPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          selected={selectedSymbols}
          onConfirm={setSelectedSymbols}
        />
      </Box>
    </LocalizationProvider>
  );
}
