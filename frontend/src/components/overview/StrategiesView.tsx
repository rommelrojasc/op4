import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  CircularProgress,
  Typography,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Tooltip as MuiTooltip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import TableRowsIcon from '@mui/icons-material/TableRows';
import BarChartIcon from '@mui/icons-material/BarChart';
import {
  BarChart,
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
  Legend,
  LabelList,
  Tooltip,
} from 'recharts';
import { fetchStrategyReport, fetchPostExitOpportunity, fetchIbPositions, StrategyAgg, TickerTpStat, TickerPostExitStat } from '@/services/api/marketData';
import { fmtPnl, fmtMoney } from '@/utils/format';

const GREEN = '#4caf50';
const RED = '#ef5350';
const MUTED = '#9aa0a6';
const CARD_BG = '#1a1d27';
const BORDER = '#2b2b43';
const ROW_BG = '#12141e';

function pnlColor(v: number | null | undefined) {
  if (v == null) return MUTED;
  return v > 0 ? GREEN : v < 0 ? RED : MUTED;
}

function fmt(v: number | null | undefined) {
  return fmtPnl(v);
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtWr(v: number | null | undefined) {
  if (v == null) return '—';
  return `${v}%`;
}

function fmtHold(min: number | null | undefined) {
  if (min == null) return '—';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

const CHART_STYLE = {
  fontSize: 11,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

// ─── View toggle ──────────────────────────────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: 'table' | 'chart';
  onChange: (v: 'table' | 'chart') => void;
}) {
  return (
    <Box
      sx={{ display: 'flex', gap: 0.25, background: ROW_BG, borderRadius: 1, p: 0.25, border: `1px solid ${BORDER}` }}
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        size="small"
        onClick={(e) => { e.stopPropagation(); onChange('table'); }}
        sx={{
          color: view === 'table' ? '#7986cb' : MUTED,
          background: view === 'table' ? 'rgba(121,134,203,0.12)' : 'transparent',
          borderRadius: 0.75,
          padding: '3px',
          '&:hover': { color: '#7986cb' },
        }}
      >
        <TableRowsIcon sx={{ fontSize: 15 }} />
      </IconButton>
      <IconButton
        size="small"
        onClick={(e) => { e.stopPropagation(); onChange('chart'); }}
        sx={{
          color: view === 'chart' ? '#7986cb' : MUTED,
          background: view === 'chart' ? 'rgba(121,134,203,0.12)' : 'transparent',
          borderRadius: 0.75,
          padding: '3px',
          '&:hover': { color: '#7986cb' },
        }}
      >
        <BarChartIcon sx={{ fontSize: 15 }} />
      </IconButton>
    </Box>
  );
}

// ─── Strategy documentation ───────────────────────────────────────────────────

interface InfoSection {
  heading: string;
  items: string[];
}

interface StrategyDoc {
  name: string;
  tagline: string;
  timeframes: string;
  sections: InfoSection[];
}

const STRATEGY_INFO: Record<string, StrategyDoc> = {
  'strategy1': {
    name: 'Strategy 1 — MA20 Crossover',
    tagline: 'Trades a clean 1h MA20 breakout confirmed by 15m stochastic.',
    timeframes: '1h anchor · 15m confirmation',
    sections: [
      {
        heading: 'Setup (1h)',
        items: [
          'The last 3 consecutive 1h closes must all be on the same side of MA40 — establishing a clean trend context.',
          'MA20 slope must agree with that trend (positive in an uptrend, negative or flat in a downtrend).',
          'CALL setup: stock has been below MA40 for ≥3 bars, MA20 sloping down or flat.',
          'PUT setup: stock has been above MA40 for ≥3 bars, MA20 sloping up or flat.',
        ],
      },
      {
        heading: 'Trigger (1h)',
        items: [
          'CALL: 1h bar closes above MA20 after being below it (bullish crossover).',
          'PUT: 1h bar closes below MA20 after being above it (bearish crossover).',
        ],
      },
      {
        heading: 'Entry — 15m Confirmation (within 4 bars)',
        items: [
          '15m close crosses through MA20 in the signal direction, OR',
          'Stochastic %K exits oversold zone (crosses above 20) for CALL / exits overbought (crosses below 80) for PUT, OR',
          'Stochastic %K crosses above %D (bullish crossover) for CALL / crosses below %D for PUT.',
          'First qualifying bar in the window is the entry.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'trendLookback: 3 (number of 1h bars checked for MA40 alignment)',
          'window15m: 4 (bars to find 15m confirmation after the 1h cross)',
          'cooldownHours: 3 (minimum gap between signals in same direction)',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The MA40 alignment filter is key — it prevents trading crosses in choppy/ranging conditions.',
          'Works best on trending days. On flat/news-driven days signals are rare.',
          '3h cooldown avoids re-entering the same trend leg multiple times.',
          'Watch for IV drop after entry: short-dated options lose premium quickly if the move is slow.',
        ],
      },
    ],
  },

  'strategy2': {
    name: 'Strategy 2 — Midline Bounce',
    tagline: 'Trades the daily MA20 midline as a support/resistance level in a confirmed daily trend.',
    timeframes: '1d trend · 1h trigger · 15m confirmation',
    sections: [
      {
        heading: 'Context (Daily)',
        items: [
          'Requires a clean daily trend: all closes of the last 3 days must be on the same side of the daily MA40.',
          'Daily MA20 slope must agree (positive for uptrend, negative for downtrend).',
          'The daily MA20 acts as the "midline" — the key level to bounce from.',
        ],
      },
      {
        heading: 'Trigger (1h)',
        items: [
          'Price must touch or come within 0.15% of the daily MA20 on a 1h bar.',
          'CALL: After the touch, a subsequent 1h bar closes above MA20 AND above the high of the touch bar.',
          'PUT: After the touch, a subsequent 1h bar closes below MA20 AND below the low of the touch bar.',
          'This two-step logic (touch → break) filters fake touches.',
        ],
      },
      {
        heading: 'Entry — 15m Confirmation (within 4 bars)',
        items: [
          'Same stochastic/MA20 confirmation logic as Strategy 1 on the 15m chart.',
          'Close crosses MA20 on 15m, or stochastic exits oversold/overbought, or K/D crossover.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'dailyTrendLookback: 3 days',
          'touchPct: 0.15% proximity to daily MA20 counts as a touch',
          'window1h: 2 bars to find the 1h break after touch',
          'window15m: 4 bars for 15m confirmation',
          'cooldownHours: 6',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The daily MA20 has strong institutional significance — many algo systems treat it as a pivot.',
          'The touch-then-break sequence filters noise; a close above/below the touch bar\'s range is a clean rejection signal.',
          '6h cooldown means typically at most one signal per direction per day.',
          'Avoid trading this on earnings days or FOMC — the daily trend can reverse violently.',
        ],
      },
    ],
  },

  'strategy3': {
    name: 'Strategy 3 — Open Gap Fade (Low Vol)',
    tagline: 'Fades an opening gap when Bollinger Bands are compressed and the open price is outside them.',
    timeframes: '15m volatility context · 1m entry',
    sections: [
      {
        heading: 'Setup — Low Volatility Regime',
        items: [
          'At the 9:30 open, compute Bollinger Band width (upper − lower / mid) on the 15m chart.',
          'That bandwidth must rank in the bottom 20th percentile of the last 100 15m bars.',
          'This confirms the market has been in a compressed, low-volatility state before the gap.',
        ],
      },
      {
        heading: 'Setup — Gap + Outside Bands',
        items: [
          'Gap ≥ 0.4% vs prior day close (gap up or gap down).',
          'The opening price must be OUTSIDE the Bollinger Bands (above upper for gap up, below lower for gap down).',
          'Rationale: a gap into compressed bands is unsustainable — mean reversion is likely.',
        ],
      },
      {
        heading: 'Entry (1m, within first 5 minutes)',
        items: [
          'Wait for the first reversal 1m bar inside the opening window (9:30–9:34).',
          'Gap up → PUT: first 1m bar that closes bearish AND closes below the prior 1m bar\'s low.',
          'Gap down → CALL: first 1m bar that closes bullish AND closes above the prior 1m bar\'s high.',
          'Entry is the close of that confirmation bar.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'minGapPct: 0.4%',
          'tightLookback: 100 bars, tightPercentile: 20th',
          'bandOutsideTol: 0 (open must be strictly outside the bands)',
          'entryWindowMinutes: 5 (9:30–9:34)',
          'maxSignalsPerDay: 1',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The low-vol filter is the core edge: gaps during low-vol regimes revert far more reliably than gaps during high-vol.',
          'The "open outside band" condition rules out gaps that land inside the band range (not clean setups).',
          'Very short entry window — miss the first 5 min and there\'s no trade.',
          'Prefer liquid tickers (SPY, QQQ, AAPL, NVDA) where 1m bars are precise.',
          'Watch out for pre-market catalysts that can sustain the gap all day.',
        ],
      },
    ],
  },

  'strategy4': {
    name: 'Strategy 4 — Magnet Effect (Far From MA20)',
    tagline: 'Price gaps far outside Bollinger Bands at the open and is magnetically pulled back toward MA20.',
    timeframes: '15m entry · 1h trend gate',
    sections: [
      {
        heading: 'Setup — Open Bollinger Breakout',
        items: [
          'Within the first 2 15m bars of the day, one bar must close outside the Bollinger Bands (above upper or below lower).',
          'Additionally, that close must be > 1.2% away from the 15m MA20.',
          'This identifies extreme displacement from the mean at the open.',
        ],
      },
      {
        heading: 'Direction Logic',
        items: [
          'CALL: Open bars close BELOW the lower band but are already below MA20 (price overextended downward).',
          'PUT: Open bars close ABOVE the upper band but are already above MA20 (price overextended upward).',
          'The magnet thesis: the further price stretches from MA20, the stronger the gravitational pull back.',
        ],
      },
      {
        heading: '1h Trend Gate',
        items: [
          'The 1h context must support a mean-reversion (not a breakout).',
          'CALL requires: 1h chart is either flat/sideways OR in a downtrend (all 3 previous 1h closes below MA40, slope ≤ 0). A trending-down market with a sharp dip is more likely to snap back.',
          'PUT requires: 1h chart is flat/sideways OR in an uptrend (all closes above MA40, slope ≥ 0).',
        ],
      },
      {
        heading: 'Entry — 15m Stochastic Confirmation (within 6 bars)',
        items: [
          'Stochastic %K crosses out of oversold/overbought, or K/D crossover in the target direction.',
          'Entry is the close of the first confirming 15m bar within 6 bars of the setup.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'minDistPct: 1.2% (min distance from MA20 to qualify as "far")',
          'firstBarWindow: 2 (15m bars checked for the opening breakout)',
          'confirmWindow: 6 (bars to find stochastic confirmation)',
          'cooldownHours: 6',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The 1.2% distance filter is critical — closer setups have much lower snap-back probability.',
          'Combining band breakout + distance from MA20 gives a double confirmation of overextension.',
          'The 1h trend gate prevents trading against a strong breakout day.',
          'High IV at entry is common here (volatile open). Monitor for IV crush — option decay accelerates if the snap-back is slow.',
        ],
      },
    ],
  },

  'strategy5': {
    name: 'Strategy 5 — Lateral Open Outside Bollinger',
    tagline: 'Fades a gap that opens outside a compressed band in a sideways, consolidating market.',
    timeframes: '15m volatility context · 1m entry',
    sections: [
      {
        heading: 'How It Differs From Strategy 3',
        items: [
          'Strategy 3 only requires low volatility (bottom 20th percentile bandwidth).',
          'Strategy 5 adds a second filter: the Bollinger Band midline (MA20) must have been FLAT for the last 6 bars.',
          'Flatness threshold: midline slope ≤ 0.05% per bar — confirming the market has been truly sideways, not just quiet.',
          'This combination (low vol + flat midline) targets stocks in tight consolidation before the gap.',
        ],
      },
      {
        heading: 'Setup',
        items: [
          'Gap ≥ 0.4% from prior close.',
          'Bollinger bandwidth at open is in bottom 20th percentile of last 100 bars (low vol).',
          'Bollinger midline slope is within ±0.05% per bar over the last 6 15m bars (flat).',
          'Opening price is outside the Bollinger Bands (within 0.05% tolerance).',
        ],
      },
      {
        heading: 'Entry (1m, first 5 minutes)',
        items: [
          'Gap up → PUT: first bearish 1m bar closing below prior 1m bar\'s low.',
          'Gap down → CALL: first bullish 1m bar closing above prior 1m bar\'s high.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'minGapPct: 0.4%',
          'tightLookback: 100, tightPercentile: 20th',
          'flatLookback: 6 bars, flatEpsilon: 0.05% per bar',
          'bandOutsideTol: 0.05%',
          'entryWindowMinutes: 5',
          'maxSignalsPerDay: 1',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The flat midline requirement is a strong filter — many low-vol openings still have a directional drift that can sustain gaps.',
          'Sideways consolidation before the gap means there\'s no trend to fight; the gap is pure noise/gap fill territory.',
          'Slightly looser band tolerance (0.05%) vs Strategy 3 (0%) catches setups where the open is just inside the band edge.',
          'If both Strategy 3 and Strategy 5 signal the same day, it is a very high-conviction setup.',
        ],
      },
    ],
  },

  'ct15': {
    name: 'CT15 — Open Gap Trendline',
    tagline: 'Trades a gap that opens against a prior-day trendline in an expanding volatility environment.',
    timeframes: '15m (prior day trendline + current day open)',
    sections: [
      {
        heading: 'Volatility Expansion Requirement',
        items: [
          'At the open, the 15m Bollinger bandwidth must be ABOVE its 20-bar average × bwAvgRatio AND slope must be positive.',
          'This filters for days where volatility is expanding (not quiet or contracting).',
          'Rationale: gap trades during expanding vol have bigger moves and faster follow-through.',
        ],
      },
      {
        heading: 'Prior Day Trendline',
        items: [
          'A linear regression is computed over all 15m bars from the prior trading day.',
          'The trendline is projected forward to the open of the current day.',
          'CALL setup: prior day trendline is DOWNWARD (slope ≤ 0), and prior day closed BELOW the 15m Bollinger midline.',
          'PUT setup: prior day trendline is UPWARD (slope ≥ 0), and prior day closed ABOVE the 15m Bollinger midline.',
        ],
      },
      {
        heading: 'Entry Conditions',
        items: [
          'CALL: Today opens with a gap UP, above prior close, above current 15m midline, AND above the projected trendline level. — Trend reversal: prior day was falling, today gaps aggressively above all levels.',
          'PUT: Today opens with a gap DOWN, below prior close, below current 15m midline, AND below the projected trendline level. — Trend continuation: prior day was rising (but closing above midline suggests it may extend down on gap).',
          'Entry is at the market open (first 15m bar).',
        ],
      },
      {
        heading: 'Exposed Mode',
        items: [
          'An "exposed" open means the opening price is outside the Bollinger Bands.',
          'By default (strictExposedMode: false), exposed opens are allowed.',
          'In strict mode (strictExposedMode: true), exposed opens are skipped — more conservative.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'minGapPct: 0.2% (lower threshold than other gap strategies)',
          'bwSlopeLookback: 3 bars (for computing bandwidth slope)',
          'bwAvgRatio: 1.0 (bandwidth must exceed avg × this ratio; lower = more permissive)',
          'maxSignalsPerDay: 1',
          'strictExposedMode: false by default',
        ],
      },
      {
        heading: 'Notes & Edge',
        items: [
          'The trendline is the core concept — it models the prior day\'s dominant price direction and tests whether the open breaks it.',
          'Lower minGapPct (0.2%) captures more setups than other strategies; combine with the trendline filter for quality.',
          'Expanding vol at open increases the option premium at entry — be aware of IV sensitivity.',
          'Works best on tickers with smooth intraday trends (AAPL, MSFT, SPY). Noisy tickers produce unreliable trendlines.',
          'Because entry is at the open, execution timing matters — fill at the first 15m close is safest.',
        ],
      },
    ],
  },

  'ct_open': {
    name: 'CT-Open — Squeeze Breakout',
    tagline: 'Detects Bollinger squeeze at market open, then monitors 1m bars for a breakout through the bands to determine direction.',
    timeframes: '15m (for squeeze detection) + 1m (for breakout confirmation)',
    sections: [
      {
        heading: 'Phase 1: Squeeze Detection (at 9:30)',
        items: [
          'At the 9:30 15m bar, the Bollinger bandwidth must be below the squeezePercentile of the last squeezeLookback bars.',
          'This identifies days where volatility is compressed — a squeeze that is likely to expand.',
          'The opening price must be INSIDE the Bollinger bands (between upper and lower).',
        ],
      },
      {
        heading: 'Phase 2: Breakout Confirmation (1m bars)',
        items: [
          'After squeeze is detected, monitor 1m bars from 9:30 to 9:30 + entryWindowMinutes.',
          '1m Bollinger bandwidth must be expanding (current > value at 9:30) — confirms real volatility breakout.',
          'If minBreakoutBars consecutive 1m bars close ABOVE the 1m midline (MA20) → CALL.',
          'If minBreakoutBars consecutive 1m bars close BELOW the 1m midline (MA20) → PUT.',
          'First confirmed directional run with expanding BW wins — entry is at the last confirming bar.',
        ],
      },
      {
        heading: 'Key Difference from CT15',
        items: [
          'CT15 requires a gap + prior-day trendline + bandwidth expansion.',
          'CT-Open uses no prior-day data — only detects squeeze and monitors for directional breakout.',
          'Direction is determined by price action (which band breaks), not by gap direction.',
        ],
      },
      {
        heading: 'Parameters',
        items: [
          'squeezeLookback: Number of 15m bars to compute BW percentile over (default 100).',
          'squeezePercentile: BW must be below this percentile to qualify as a squeeze (default 30).',
          'entryWindowMinutes: Minutes after 9:30 to monitor for breakout (default 15).',
          'minBreakoutBars: Consecutive 1m bars above/below midline to confirm direction (default 3).',
          'maxSignalsPerDay: Maximum signals per day (default 1).',
        ],
      },
    ],
  },
};

// ─── Strategy Info Modal ──────────────────────────────────────────────────────

function StrategyInfoModal({
  strategyKey,
  onClose,
}: {
  strategyKey: string | null;
  onClose: () => void;
}) {
  const doc = strategyKey ? STRATEGY_INFO[strategyKey] : null;

  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          backgroundColor: '#12141e',
          border: `1px solid ${BORDER}`,
          maxHeight: '85vh',
        },
      }}
    >
      {doc && (
        <>
          <DialogTitle sx={{ pb: 0.5 }}>
            <Typography sx={{ fontSize: 16, fontWeight: 700, color: '#d1d4dc' }}>
              {doc.name}
            </Typography>
            <Typography sx={{ fontSize: 12, color: MUTED, mt: 0.5 }}>
              {doc.tagline}
            </Typography>
            <Box sx={{ mt: 1 }}>
              <Chip
                label={doc.timeframes}
                size="small"
                sx={{ fontSize: 10, background: '#1a1d27', color: '#7986cb', border: '1px solid #3f51b5' }}
              />
            </Box>
          </DialogTitle>

          <Divider sx={{ borderColor: BORDER, mt: 1.5 }} />

          <DialogContent sx={{ py: 2 }}>
            {doc.sections.map((section) => (
              <Box key={section.heading} sx={{ mb: 2.5 }}>
                <Typography sx={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#7986cb',
                  mb: 1,
                }}>
                  {section.heading}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {section.items.map((item, i) => (
                    <Box
                      key={i}
                      component="li"
                      sx={{
                        fontSize: 12,
                        color: '#c5cae9',
                        lineHeight: 1.7,
                        mb: 0.5,
                        '&::marker': { color: MUTED },
                      }}
                    >
                      {item}
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
          </DialogContent>

          <Divider sx={{ borderColor: BORDER }} />
          <DialogActions sx={{ px: 2, py: 1 }}>
            <Button onClick={onClose} size="small" sx={{ textTransform: 'none', fontSize: 13, color: MUTED }}>
              Close
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

// ─── Shared table helpers ─────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{
      background: ROW_BG,
      border: `1px solid ${BORDER}`,
      borderRadius: 1.5,
      px: 2,
      py: 1.5,
      minWidth: 110,
    }}>
      <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 20, fontWeight: 700, color: color || '#d1d4dc', mt: 0.5 }}>
        {value}
      </Typography>
    </Box>
  );
}

function AggCell({ agg }: { agg: StrategyAgg | null | undefined }) {
  if (!agg || agg.trades === 0) return <TableCell sx={{ color: '#333', fontSize: 12 }}>—</TableCell>;
  return (
    <TableCell sx={{ fontSize: 12 }}>
      <Box sx={{ color: pnlColor(agg.pnl), fontWeight: 600 }}>
        {fmt(agg.pnl)}
      </Box>
      <Box sx={{ color: MUTED, fontSize: 11 }}>
        {agg.trades} trade{agg.trades !== 1 ? 's' : ''}, {fmtWr(agg.win_rate)} WR
      </Box>
    </TableCell>
  );
}

function CpAggCell({ agg, right }: { agg: StrategyAgg | null | undefined; right: 'C' | 'P' }) {
  if (!agg || agg.trades === 0) return <TableCell sx={{ color: '#333', fontSize: 12 }}>—</TableCell>;
  const label = right === 'C' ? 'CALL' : 'PUT';
  const labelColor = right === 'C' ? GREEN : RED;
  return (
    <TableCell sx={{ fontSize: 12 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
        <Box sx={{ fontSize: 10, fontWeight: 700, color: labelColor, letterSpacing: '0.05em' }}>{label}</Box>
      </Box>
      <Box sx={{ color: pnlColor(agg.pnl), fontWeight: 600 }}>{fmt(agg.pnl)}</Box>
      <Box sx={{ color: MUTED, fontSize: 11 }}>
        {agg.trades}t · {fmtWr(agg.win_rate)} WR
        {agg.avg_return != null && ` · avg ${fmtPct(agg.avg_return)}`}
      </Box>
    </TableCell>
  );
}

const TH = ({ children }: { children: React.ReactNode }) => (
  <TableCell sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, borderBottom: `1px solid ${BORDER}`, py: 1 }}>
    {children}
  </TableCell>
);

const TD = ({ children, sx }: { children: React.ReactNode; sx?: object }) => (
  <TableCell sx={{ fontSize: 12, color: '#c5cae9', borderBottom: `1px solid #1e2030`, py: 0.75, ...sx }}>
    {children}
  </TableCell>
);

// ─── Section header with optional toggle ──────────────────────────────────────

function SectionHeader({
  title,
  sectionKey,
  view,
  onViewChange,
}: {
  title: string;
  sectionKey: string;
  view: 'table' | 'chart';
  onViewChange: (key: string, v: 'table' | 'chart') => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
      <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED }}>
        {title}
      </Typography>
      <ViewToggle view={view} onChange={(v) => onViewChange(sectionKey, v)} />
    </Box>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function StrategiesView() {
  const today = new Date();
  // Format in ET timezone instead of UTC to match trading hours
  const todayStr = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [startDate, setStartDate] = useState(todayStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [queryStart, setQueryStart] = useState(startDate);
  const [queryEnd, setQueryEnd] = useState(endDate);
  const [infoKey, setInfoKey] = useState<string | null>(null);
  const [sectionViews, setSectionViews] = useState<Record<string, 'table' | 'chart'>>({});
  const [activeSection, setActiveSection] = useState<string>('sec-overview');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['sec-sessions', 'sec-cross-hour'])
  );
  const [postExitData, setPostExitData] = useState<TickerPostExitStat[]>([]);
  const [postExitDebugData, setPostExitDebugData] = useState<Record<string, unknown>>({});
  const [postExitLoading, setPostExitLoading] = useState(false);
  const [postExitError, setPostExitError] = useState<string | null>(null);
  const [crossHourChartType, setCrossHourChartType] = useState<'heatmap' | 'positions'>('heatmap');

  const getView = (key: string): 'table' | 'chart' => sectionViews[key] ?? 'chart';
  const setView = (key: string, v: 'table' | 'chart') =>
    setSectionViews((prev) => ({ ...prev, [key]: v }));

  const { data, isFetching, error, isError } = useQuery({
    queryKey: ['strategy-report', queryStart, queryEnd],
    queryFn: () => fetchStrategyReport(queryStart, queryEnd),
    staleTime: 60000,
    retry: 2,
  });


  const ibPositionsQuery = useQuery({
    queryKey: ['ib-positions'],
    queryFn: () => fetchIbPositions(),
    refetchInterval: 15000,
  });

  const handleRun = () => {
    setQueryStart(startDate);
    setQueryEnd(endDate);
    // Reset post-exit results when date range changes
    setPostExitData([]);
    setPostExitDebugData({});
    setPostExitError(null);
  };

  const ov = data?.overview;
  const strategies = data?.strategies ?? {};
  const strategyKeys = data?.strategy_keys ?? [];
  const crossHour = data?.cross_hour ?? {};
  const crossHourOpens = data?.cross_hour_opens ?? {};
  const sessions = data?.sessions ?? [];
  const tickerSummary = data?.ticker_summary ?? [];
  const bestTrades = data?.best_trades ?? [];
  const worstTrades = data?.worst_trades ?? [];
  const cp = data?.calls_puts;
  const signalStats = data?.signal_stats;
  const ivMfeMae = data?.iv_mfe_mae;
  const marketContext = data?.market_context;
  const tickerTp: TickerTpStat[] = data?.ticker_tp_analysis ?? [];
  const capitalTimeline = data?.capital_timeline ?? { rows: [], date_keys: [] };
  const postExit: TickerPostExitStat[] = postExitData.length > 0 ? postExitData : (data?.post_exit_opportunity ?? []);
  const postExitDebug = Object.keys(postExitDebugData).length > 0 ? postExitDebugData : (data?.post_exit_debug ?? {});

  const handleRunPostExit = async () => {
    setPostExitLoading(true);
    setPostExitError(null);
    try {
      const result = await fetchPostExitOpportunity(queryStart, queryEnd);
      setPostExitData(result.post_exit_opportunity);
      setPostExitDebugData(result.post_exit_debug as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Unknown error';
      setPostExitError(msg);
    } finally {
      setPostExitLoading(false);
    }
  };

  // Auto-expand strategy sections when data first loads
  useEffect(() => {
    if (strategyKeys.length > 0) {
      setExpandedSections(prev => {
        const next = new Set(prev);
        strategyKeys.forEach(k => next.add(`sec-strategy-${k}`));
        return next;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyKeys.join(',')]);

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    // Expand first, then scroll after accordion animation is fully done (~300ms)
    setExpandedSections(prev => new Set([...prev, id]));
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      // Walk up the DOM to find the nearest scrollable ancestor
      let container: Element | null = el.parentElement;
      while (container && container !== document.documentElement) {
        const overflow = window.getComputedStyle(container).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') break;
        container = container.parentElement;
      }
      if (container && container !== document.documentElement) {
        const elTop = el.getBoundingClientRect().top;
        const containerTop = container.getBoundingClientRect().top;
        // Snap instantly — avoids competing with the accordion expand animation
        container.scrollTop = container.scrollTop + elTop - containerTop - 16;
      } else {
        el.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    }, 350);
  };

  const navSections = data && ov && ov.completed_trades > 0 ? [
    { id: 'sec-overview',      label: 'Overview' },
    { id: 'sec-sessions',      label: 'Sessions' },
    { id: 'sec-capital',       label: 'Capital' },
    { id: 'sec-cross-hour',    label: 'By Hour' },
    ...strategyKeys.map(k => ({ id: `sec-strategy-${k}`, label: strategies[k]?.name?.split('—')[0].trim() || k })),
    { id: 'sec-ticker-summary', label: 'Ticker Summary' },
    { id: 'sec-tp-opt',         label: 'Take-Profit' },
    { id: 'sec-best-worst',     label: 'Best & Worst' },
    { id: 'sec-calls-puts',     label: 'Calls vs Puts' },
    { id: 'sec-signals',        label: 'Signal Funnel' },
    { id: 'sec-skipped',        label: 'Skipped Signals' },
    { id: 'sec-iv-mfe',         label: 'IV & Greeks' },
    { id: 'sec-market',         label: 'Market Context' },
  ] : [];

  const hourLabels = [
    '09:00-10:00', '10:00-11:00', '11:00-12:00',
    '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00',
  ];

  // Short hour label for charts
  const shortHour = (h: string) => h.slice(0, 5);

  return (
    <Box sx={{ p: 3, maxWidth: 1600, mx: 'auto', display: 'flex', gap: 2, alignItems: 'flex-start' }}>

      {/* ── Sticky side nav ── */}
      {navSections.length > 0 && (
        <Box sx={{
          position: 'sticky',
          top: 16,
          width: 172,
          flexShrink: 0,
          background: CARD_BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 2,
          py: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.25,
        }}>
          <Typography sx={{ fontSize: 10, fontWeight: 700, color: MUTED, letterSpacing: '0.08em', textTransform: 'uppercase', px: 1.5, pb: 0.75 }}>
            Sections
          </Typography>
          {navSections.map((sec) => (
            <Box
              key={sec.id}
              onClick={() => scrollToSection(sec.id)}
              sx={{
                px: 1.5, py: 0.6,
                cursor: 'pointer',
                borderRadius: 1,
                fontSize: 12,
                fontWeight: activeSection === sec.id ? 600 : 400,
                color: activeSection === sec.id ? '#90caf9' : '#9aa0a6',
                background: activeSection === sec.id ? 'rgba(144,202,249,0.08)' : 'transparent',
                borderLeft: activeSection === sec.id ? '2px solid #90caf9' : '2px solid transparent',
                transition: 'all 0.15s',
                '&:hover': { color: '#d1d4dc', background: 'rgba(255,255,255,0.04)' },
                lineHeight: 1.4,
              }}
            >
              {sec.label}
            </Box>
          ))}
        </Box>
      )}

      {/* ── Main content ── */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Box>
          <Typography sx={{ fontSize: 20, fontWeight: 700, color: '#d1d4dc' }}>
            Strategy Analysis
          </Typography>
          <Typography sx={{ fontSize: 12, color: MUTED }}>
            Performance report from archived trade logs
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 'auto', flexWrap: 'wrap' }}>
          <TextField
            label="Start date"
            type="date"
            size="small"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ input: { color: '#d1d4dc', fontSize: 13 }, label: { color: MUTED, fontSize: 12 }, '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: BORDER } } }}
          />
          <TextField
            label="End date"
            type="date"
            size="small"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ input: { color: '#d1d4dc', fontSize: 13 }, label: { color: MUTED, fontSize: 12 }, '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: BORDER } } }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={handleRun}
            disabled={isFetching}
            startIcon={isFetching ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
            sx={{ textTransform: 'none', fontSize: 13 }}
          >
            Run
          </Button>
        </Box>
      </Box>

      {!data && isFetching && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
          <CircularProgress size={32} />
        </Box>
      )}

      {isError && (
        <Box sx={{ background: '#2b1d1d', border: '1px solid #ff6b6b', borderRadius: 2, p: 3, mb: 3 }}>
          <Typography sx={{ color: '#ff6b6b', fontWeight: 600, mb: 1 }}>Error Loading Report</Typography>
          <Typography sx={{ color: '#ffb3b3', fontSize: 13 }}>
            {error instanceof Error ? error.message : 'Failed to load strategy report. Please check the console for details.'}
          </Typography>
        </Box>
      )}

      {data && ov?.completed_trades === 0 && (
        <Box sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 2, p: 3, textAlign: 'center' }}>
          <Typography sx={{ color: MUTED }}>No completed trades found for the selected date range.</Typography>
        </Box>
      )}

      {data && ov && ov.completed_trades > 0 && (
        <>
          {/* Overview cards */}
          <Box id="sec-overview" sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 4, scrollMarginTop: '16px' }}>
            <StatCard label="Sessions" value={String(ov.sessions)} />
            <StatCard label="Completed Trades" value={String(ov.completed_trades)} />
            <StatCard label="Total P&L" value={fmt(ov.total_pnl)} color={pnlColor(ov.total_pnl)} />
            <StatCard label="Win Rate" value={fmtWr(ov.win_rate)} />
            <StatCard label="Winners" value={String(ov.winners)} color={GREEN} />
            <StatCard label="Losers" value={String(ov.losers)} color={ov.losers > 0 ? RED : MUTED} />
            {(ov as any).total_capital_deployed != null && (
              <StatCard label="Capital Deployed" value={fmtMoney((ov as any).total_capital_deployed)} />
            )}
            {(ov as any).avg_capital_per_trade != null && (ov as any).avg_capital_per_trade > 0 && (
              <StatCard label="Avg / Trade" value={fmtMoney((ov as any).avg_capital_per_trade)} />
            )}
            {(ov as any).return_on_capital != null && (
              <StatCard
                label="Return on Capital"
                value={`${(ov as any).return_on_capital > 0 ? '+' : ''}${(ov as any).return_on_capital.toFixed(1)}%`}
                color={pnlColor((ov as any).return_on_capital)}
              />
            )}
            {(ov as any).profit_factor != null && (
              <StatCard
                label="Profit Factor"
                value={(ov as any).profit_factor.toFixed(2)}
                color={(ov as any).profit_factor >= 1.5 ? GREEN : (ov as any).profit_factor >= 1 ? '#f5a623' : RED}
              />
            )}
            {(ov as any).avg_winner != null && (
              <StatCard label="Avg Winner" value={fmtMoney((ov as any).avg_winner)} color={GREEN} />
            )}
            {(ov as any).avg_loser != null && (
              <StatCard label="Avg Loser" value={`-${fmtMoney((ov as any).avg_loser)}`} color={RED} />
            )}
            {(ov as any).avg_hold_min != null && (
              <StatCard label="Avg Hold" value={fmtHold((ov as any).avg_hold_min)} />
            )}
            {(() => {
              const openCount = (ov as any).open_trades ?? 0;
              const openCapital = (ov as any).open_capital_deployed ?? 0;
              if (openCount === 0) return null;
              // Compute live unrealized P&L by cross-referencing IBKR positions (use report-scoped positions)
              const openPos = data?.open_positions_detail ?? [];
              const ibPos = ibPositionsQuery.data?.positions ?? [];
              const unrealizedPnl = openPos.reduce((sum, op) => {
                const ib = ibPos.find(p => p.symbol === op.symbol && p.right === op.right && p.strike === op.strike);
                return sum + (ib?.unrealized_pnl ?? 0);
              }, 0);
              const hasLivePnl = ibPos.length > 0;
              return (
                <>
                  <StatCard
                    label="Open Positions"
                    value={`${openCount} · ${fmtMoney(openCapital)}`}
                    color="#f5a623"
                  />
                  {hasLivePnl && (
                    <StatCard
                      label="Unrealized P&L"
                      value={fmtPnl(unrealizedPnl)}
                      color={unrealizedPnl >= 0 ? GREEN : RED}
                    />
                  )}
                </>
              );
            })()}
          </Box>

          {/* ── Open Positions ── */}
          {((ov as any).open_trades ?? 0) > 0 && (
            <Accordion id="sec-open-positions" expanded={expandedSections.has('sec-open-positions')} onChange={() => toggleSection('sec-open-positions')} sx={{ background: CARD_BG, border: `1px solid #f5a62355`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Open Positions</Typography>
                  <Typography sx={{ fontSize: 12, color: '#f5a623' }}>
                    {(ov as any).open_trades} open · {fmtMoney((ov as any).open_capital_deployed)} deployed
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TH>Contract</TH>
                      <TH>Strategy</TH>
                      <TH>Entry</TH>
                      <TH>Opened</TH>
                      <TH>Price Movement</TH>
                      <TH>Hold</TH>
                      <TH>Expires</TH>
                      <TH>Current</TH>
                      <TH>Max Gain</TH>
                      <TH>% to TP</TH>
                      <TH>Unreal. P&L</TH>
                      <TH>Last check</TH>
                      <TH>Why open?</TH>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(data?.open_positions_detail ?? []).slice().reverse().map((op) => {
                      const ib = (ibPositionsQuery.data?.positions ?? []).find(
                        p => p.symbol === op.symbol && p.right === op.right && p.strike === op.strike
                      );
                      const holdMin = op.timestamp ? Math.floor((Date.now() / 1000 - op.timestamp) / 60) : null;
                      const dte = (() => {
                        if (!op.expiration) return null;
                        const exp = new Date(op.expiration + 'T16:00:00-05:00');
                        const diffMs = exp.getTime() - Date.now();
                        const diffMin = Math.floor(diffMs / 60000);
                        if (diffMin <= 0) return 'expired';
                        if (diffMin < 60) return `${diffMin}m`;
                        const h = Math.floor(diffMin / 60);
                        const d = Math.floor(h / 24);
                        if (d >= 1) return `${d}d ${h % 24}h`;
                        return `${h}h`;
                      })();
                      const currentPremium = ib?.market_price ?? null;
                      const tp = op.target_price ?? null;
                      const toPct = currentPremium != null && tp ? (currentPremium / tp * 100) : null;
                      const upnl = ib?.unrealized_pnl ?? null;
                      const upnlPct = ib?.pnl_pct ?? null;

                      // Status chip config
                      const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
                        tp_not_reached:      { label: 'TP not hit',        color: '#90caf9', bg: 'rgba(144,202,249,0.12)' },
                        close_order_cancelled: { label: 'Close cancelled', color: '#f5a623', bg: 'rgba(245,166,35,0.12)' },
                        close_retry_pending:   { label: 'Retry pending',   color: '#f5a623', bg: 'rgba(245,166,35,0.12)' },
                        worker_stopped:        { label: 'Worker stopped',  color: MUTED,     bg: 'rgba(154,160,166,0.1)' },
                        no_data:               { label: 'No data',         color: MUTED,     bg: 'rgba(154,160,166,0.1)' },
                      };
                      const scfg = STATUS_CFG[op.status_reason] ?? STATUS_CFG.no_data;

                      // Tooltip content: key events + last check detail
                      const tooltipContent = (
                        <Box sx={{ p: 0.5, maxWidth: 340 }}>
                          {op.key_events.length > 0 && (
                            <>
                              <Box sx={{ fontSize: 10, fontWeight: 700, color: MUTED, mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Event log</Box>
                              {op.key_events.map((ev, i) => (
                                <Box key={i} sx={{ fontSize: 11, mb: 0.25, display: 'flex', gap: 1 }}>
                                  <Box component="span" sx={{ color: MUTED, flexShrink: 0 }}>{ev.time_et}</Box>
                                  <Box component="span" sx={{ color: '#7986cb', flexShrink: 0 }}>[{ev.type}]</Box>
                                  <Box component="span" sx={{ color: '#d1d4dc' }}>{ev.message}</Box>
                                </Box>
                              ))}
                            </>
                          )}
                          {op.check_count > 0 && (
                            <Box sx={{ mt: 0.75, fontSize: 11, color: MUTED }}>
                              {op.check_count} position checks
                              {op.last_check_ts && ` · last at ${new Date(op.last_check_ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })}`}
                            </Box>
                          )}
                          {op.close_attempts > 0 && (
                            <Box sx={{ mt: 0.5, fontSize: 11, color: '#f5a623' }}>
                              {op.close_attempts} close order{op.close_attempts > 1 ? 's' : ''} cancelled by IB
                            </Box>
                          )}
                        </Box>
                      );

                      // Last-check progress cell
                      const lastCheckCell = op.last_premium != null && op.last_target != null ? (
                        <Box sx={{ fontSize: 11 }}>
                          <Box sx={{ color: '#d1d4dc' }}>
                            ${op.last_premium.toFixed(2)} <Box component="span" sx={{ color: MUTED }}>→</Box> ${op.last_target.toFixed(2)}
                          </Box>
                          {op.pct_to_tp != null && (
                            <Box sx={{ mt: 0.25 }}>
                              <Box sx={{ height: 3, borderRadius: 1, background: '#1e2030', width: 80, overflow: 'hidden' }}>
                                <Box sx={{ height: '100%', width: `${Math.min(op.pct_to_tp, 100)}%`, background: op.pct_to_tp >= 80 ? GREEN : '#f5a623', borderRadius: 1 }} />
                              </Box>
                              <Box sx={{ fontSize: 10, color: MUTED }}>{op.pct_to_tp.toFixed(0)}% to TP</Box>
                            </Box>
                          )}
                        </Box>
                      ) : <Box sx={{ color: MUTED, fontSize: 11 }}>—</Box>;

                      return (
                        <TableRow key={op.position_id ?? op.symbol} hover sx={{ '&:hover td': { background: '#1e2230' } }}>
                          <TD sx={{ fontWeight: 600, color: '#d1d4dc' }}>
                            {op.symbol} {op.right ?? ''} {op.strike ?? ''}
                            <Box component="span" sx={{ fontSize: 10, color: MUTED, ml: 0.5 }}>
                              {op.expiration ?? ''}
                            </Box>
                          </TD>
                          <TD>{op.strategy_id ? op.strategy_id.substring(0, 10) : '—'}</TD>
                          <TD>{op.price != null ? fmtMoney(op.price) : '—'}</TD>
                          <TD sx={{ color: MUTED, fontSize: 11 }}>
                            {op.timestamp ? (() => {
                              const d = new Date(op.timestamp * 1000);
                              const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
                              const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
                              return <><Box component="span" sx={{ color: '#d1d4dc' }}>{date}</Box>{' '}{time}</>;
                            })() : '—'}
                          </TD>
                          <TD>
                            {(() => {
                              const bars = op.price_bars ?? [];
                              if (bars.length < 2) {
                                return <Box sx={{ color: MUTED, fontSize: 10 }}>—</Box>;
                              }

                              const prices = bars.map((b: any) => b.price);
                              const minPrice = Math.min(...prices);
                              const maxPrice = Math.max(...prices);
                              const range = maxPrice - minPrice;
                              const isFlatLine = range < 0.0001;

                              const width = 60;
                              const height = 20;

                              const points = bars.map((bar: any, i: number) => {
                                const x = (i / (bars.length - 1)) * width;
                                let y;
                                if (isFlatLine) {
                                  y = height / 2;
                                } else {
                                  y = height - ((bar.price - minPrice) / range) * (height - 4) - 2;
                                }
                                return `${x},${y}`;
                              }).join(' ');

                              const firstPrice = prices[0];
                              const lastPrice = prices[prices.length - 1];
                              const priceChange = lastPrice - firstPrice;
                              const chartColor = isFlatLine ? MUTED : (priceChange >= 0 ? GREEN : RED);
                              const changePct = firstPrice !== 0 ? (priceChange / firstPrice) * 100 : 0;

                              return (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <svg width={width} height={height}>
                                    <polyline
                                      points={points}
                                      fill="none"
                                      stroke={chartColor}
                                      strokeWidth="1.5"
                                      opacity={isFlatLine ? 0.4 : 0.8}
                                    />
                                  </svg>
                                  <Box sx={{ fontSize: 9, color: chartColor, fontWeight: 600 }}>
                                    {changePct >= 0 ? '+' : ''}{changePct.toFixed(1)}%
                                  </Box>
                                </Box>
                              );
                            })()}
                          </TD>
                          <TD>{holdMin != null ? fmtHold(holdMin) : '—'}</TD>
                          <TD sx={{ color: dte === 'expired' ? RED : dte != null && dte.endsWith('h') ? '#f5a623' : '#d1d4dc' }}>
                            {dte ?? '—'}
                          </TD>
                          <TD>
                            {currentPremium != null
                              ? (currentPremium < 0.01 ? currentPremium.toFixed(4) : currentPremium.toFixed(2))
                              : '—'}
                          </TD>
                          <TD>
                            {op.max_premium != null && op.max_pct_gain != null ? (
                              <Box>
                                <Box sx={{ color: op.max_pct_gain >= 0 ? GREEN : RED, fontWeight: 600 }}>
                                  {op.max_pct_gain >= 0 ? '+' : ''}{op.max_pct_gain.toFixed(1)}%
                                </Box>
                                <Box sx={{ fontSize: 10, color: MUTED }}>
                                  ${op.max_premium.toFixed(2)}
                                </Box>
                                {op.max_pct_to_tp != null && (
                                  <Box sx={{ fontSize: 9, color: op.max_pct_to_tp >= 100 ? GREEN : '#f5a623' }}>
                                    {op.max_pct_to_tp.toFixed(0)}% of TP
                                  </Box>
                                )}
                              </Box>
                            ) : <Box sx={{ color: MUTED }}>—</Box>}
                          </TD>
                          <TD sx={{ color: toPct != null && toPct >= 100 ? GREEN : '#d1d4dc' }}>
                            {toPct != null ? `${toPct.toFixed(0)}%` : '—'}
                          </TD>
                          <TD sx={{ color: upnl != null ? (upnl >= 0 ? GREEN : RED) : MUTED, fontWeight: 600 }}>
                            {upnl != null ? fmtPnl(upnl) : '—'}
                            {upnlPct != null && (
                              <Box component="span" sx={{ fontSize: 10, ml: 0.5, fontWeight: 400 }}>
                                ({upnlPct >= 0 ? '+' : ''}{upnlPct.toFixed(1)}%)
                              </Box>
                            )}
                          </TD>
                          <TD>{lastCheckCell}</TD>
                          <TD>
                            <MuiTooltip
                              title={tooltipContent}
                              placement="left"
                              componentsProps={{ tooltip: { sx: { background: '#12141e', border: '1px solid #2b2b43', borderRadius: 1.5, p: 1, maxWidth: 360 } } }}
                            >
                              <Chip
                                label={scfg.label}
                                size="small"
                                sx={{ fontSize: 10, height: 18, cursor: 'default', color: scfg.color, background: scfg.bg, '& .MuiChip-label': { px: 0.75 } }}
                              />
                            </MuiTooltip>
                          </TD>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Optimal Take-Profit Analysis ── */}
          {data?.open_tp_analysis && data.open_tp_analysis.total_positions > 0 && (
            <Accordion id="sec-tp-analysis" expanded={expandedSections.has('sec-tp-analysis')} onChange={() => toggleSection('sec-tp-analysis')} sx={{ background: CARD_BG, border: `1px solid #90caf955`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Optimal Take-Profit Analysis</Typography>
                  <Typography sx={{ fontSize: 12, color: '#90caf9' }}>
                    {data.open_tp_analysis.total_positions} positions analyzed
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                {(() => {
                  const tpa = data.open_tp_analysis;
                  return (
                    <Box>
                      {/* Summary Stats */}
                      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2, mb: 3 }}>
                        <Box sx={{ p: 1.5, background: '#12141e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                          <Box sx={{ fontSize: 10, color: MUTED, mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current TP</Box>
                          <Box sx={{ fontSize: 18, fontWeight: 700, color: '#f5a623' }}>{tpa.current_tp_pct.toFixed(1)}%</Box>
                        </Box>
                        <Box sx={{ p: 1.5, background: '#12141e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                          <Box sx={{ fontSize: 10, color: MUTED, mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg Max Gain</Box>
                          <Box sx={{ fontSize: 18, fontWeight: 700, color: tpa.avg_max_gain >= tpa.current_tp_pct ? GREEN : RED }}>
                            {tpa.avg_max_gain.toFixed(1)}%
                          </Box>
                        </Box>
                        <Box sx={{ p: 1.5, background: '#12141e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                          <Box sx={{ fontSize: 10, color: MUTED, mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recommended TP</Box>
                          <Box sx={{ fontSize: 18, fontWeight: 700, color: '#90caf9' }}>{tpa.recommended_tp.toFixed(1)}%</Box>
                        </Box>
                      </Box>

                      {/* Capture Rate Chart */}
                      <Typography sx={{ fontSize: 13, fontWeight: 600, color: '#d1d4dc', mb: 1.5 }}>
                        Capture Rate by TP Threshold
                      </Typography>
                      <ResponsiveContainer width="100%" height={250}>
                        <ComposedChart data={tpa.capture_rates} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#2b2b43" />
                          <XAxis
                            dataKey="tp_pct"
                            stroke={MUTED}
                            tick={{ fill: MUTED, fontSize: 11 }}
                            label={{ value: 'TP Threshold (%)', position: 'insideBottom', offset: -5, fill: MUTED, fontSize: 11 }}
                          />
                          <YAxis
                            stroke={MUTED}
                            tick={{ fill: MUTED, fontSize: 11 }}
                            label={{ value: 'Positions Captured (%)', angle: -90, position: 'insideLeft', fill: MUTED, fontSize: 11 }}
                          />
                          <Tooltip
                            contentStyle={{ background: '#12141e', border: '1px solid #2b2b43', borderRadius: 4 }}
                            labelStyle={{ color: '#d1d4dc', fontSize: 12 }}
                            itemStyle={{ color: '#d1d4dc', fontSize: 11 }}
                            formatter={(value: any, name: any) => {
                              if (name === 'rate') return [`${value.toFixed(1)}%`, 'Capture Rate'];
                              if (name === 'captured') return [value, 'Positions'];
                              return [value, name];
                            }}
                          />
                          <Bar dataKey="captured" fill="#90caf9" name="Positions" />
                          <Line type="monotone" dataKey="rate" stroke="#4caf50" strokeWidth={2} dot={{ fill: '#4caf50', r: 4 }} name="Capture Rate" />
                          <ReferenceLine y={75} stroke="#f5a623" strokeDasharray="3 3" label={{ value: '75% target', fill: '#f5a623', fontSize: 10 }} />
                          <ReferenceLine x={tpa.current_tp_pct} stroke="#f5a623" strokeDasharray="3 3" label={{ value: 'Current TP', fill: '#f5a623', fontSize: 10, position: 'top' }} />
                          <ReferenceLine x={tpa.recommended_tp} stroke="#90caf9" strokeDasharray="3 3" label={{ value: 'Recommended', fill: '#90caf9', fontSize: 10, position: 'top' }} />
                        </ComposedChart>
                      </ResponsiveContainer>

                      {/* Analysis Text */}
                      <Box sx={{ mt: 3, p: 2, background: '#12141e', borderRadius: 1, border: '1px solid #2b2b43' }}>
                        <Typography sx={{ fontSize: 12, color: '#d1d4dc', lineHeight: 1.6 }}>
                          {tpa.avg_max_gain < tpa.current_tp_pct ? (
                            <>
                              ⚠️ The current TP of <strong>{tpa.current_tp_pct.toFixed(1)}%</strong> is higher than the average maximum gain of{' '}
                              <strong style={{ color: RED }}>{tpa.avg_max_gain.toFixed(1)}%</strong> reached by open positions. This means most positions
                              never got close to the target price. Consider lowering to <strong style={{ color: '#90caf9' }}>{tpa.recommended_tp.toFixed(1)}%</strong>{' '}
                              to capture {tpa.capture_rates.find(cr => cr.tp_pct === tpa.recommended_tp)?.rate.toFixed(0)}% of positions.
                            </>
                          ) : (
                            <>
                              ✓ The current TP of <strong>{tpa.current_tp_pct.toFixed(1)}%</strong> is reasonable given the average maximum gain of{' '}
                              <strong style={{ color: GREEN }}>{tpa.avg_max_gain.toFixed(1)}%</strong>. However, optimizing to{' '}
                              <strong style={{ color: '#90caf9' }}>{tpa.recommended_tp.toFixed(1)}%</strong> could improve close rates.
                            </>
                          )}
                        </Typography>
                      </Box>
                    </Box>
                  );
                })()}
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Sessions ── */}
          <Accordion id="sec-sessions" expanded={expandedSections.has('sec-sessions')} onChange={() => toggleSection('sec-sessions')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', pr: 1 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Sessions Overview</Typography>
                <ViewToggle view={getView('sessions')} onChange={(v) => setView('sessions', v)} />
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {getView('sessions') === 'table' ? (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TH>Date</TH><TH>Trades</TH><TH>P&L</TH><TH>Capital</TH><TH>Win Rate</TH><TH>Wins</TH><TH>Losses</TH>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sessions.map((s) => (
                      <TableRow key={s.date_key} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                        <TD>{s.date_label}</TD>
                        <TD>{s.trades}</TD>
                        <TD sx={{ color: pnlColor(s.pnl), fontWeight: 600 }}>{fmt(s.pnl)}</TD>
                        <TD sx={{ color: '#f5a623' }}>{s.capital_deployed != null ? fmtMoney(s.capital_deployed) : '—'}</TD>
                        <TD>{fmtWr(s.win_rate)}</TD>
                        <TD sx={{ color: GREEN }}>{s.wins}</TD>
                        <TD sx={{ color: s.losses > 0 ? RED : MUTED }}>{s.losses}</TD>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Box>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={sessions.map((s) => ({ name: s.date_label, pnl: s.pnl ?? 0 }))}
                      margin={{ top: 8, right: 8, left: 8, bottom: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={(v) => `$${(v / 1).toFixed(0)}`} />
                      <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                        {sessions.map((s, i) => (
                          <Cell key={i} fill={(s.pnl ?? 0) >= 0 ? GREEN : RED} />
                        ))}
                        <LabelList dataKey="pnl" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Box>
              )}
            </AccordionDetails>
          </Accordion>

          {/* ── Capital & P&L Timeline ── */}
          {capitalTimeline.rows.length > 0 && (() => {
            const dateKeys = capitalTimeline.date_keys;
            const multiDay = dateKeys.length > 1;
            const PALETTE = ['#f5a623', '#90caf9', '#4caf50', '#ef9a9a', '#ce93d8', '#80cbc4'];
            const totalCapital = capitalTimeline.rows.reduce((s, r) => s + r.capital, 0);
            const totalPnl = capitalTimeline.rows.reduce((s, r) => s + r.pnl, 0);
            const fmtTick = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v <= -1000 ? `-$${(Math.abs(v) / 1000).toFixed(1)}k` : `$${v}`;
            const tooltipStyle = { background: '#1a1d27', border: '1px solid #2b2b43', borderRadius: 6, fontSize: 12 };
            const chartMargin = { top: 8, right: 16, left: 4, bottom: 4 };

            return (
              <Accordion
                id="sec-capital"
                expanded={expandedSections.has('sec-capital')}
                onChange={() => toggleSection('sec-capital')}
                sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Capital & P&L Timeline</Typography>
                    <Typography sx={{ fontSize: 12, color: '#f5a623' }}>
                      {fmtMoney(totalCapital)} deployed
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: pnlColor(totalPnl) }}>
                      · {fmt(totalPnl)} realized
                    </Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>

                  {/* ── Chart 1: Capital deployed (opens) ── */}
                  <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 0.75 }}>
                    Capital deployed · 30-min buckets · entry premium × qty × 100{multiDay ? ' · grouped by session' : ''}
                  </Typography>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={capitalTimeline.rows} margin={chartMargin} barGap={2} barCategoryGap="30%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="bucket" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={fmtTick} width={56} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        labelStyle={{ color: '#d1d4dc', fontWeight: 600 }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(value: any, name: any) => {
                          if (name === 'cumulative_capital') return [fmtMoney(value as number), 'Cumulative capital'];
                          const label = multiDay ? sessions.find(s => s.date_key === name)?.date_label ?? name : 'Capital';
                          return [fmtMoney(value as number), label];
                        }}
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      />
                      {multiDay ? (
                        <>
                          <Legend formatter={(value) => sessions.find(s => s.date_key === value)?.date_label ?? value} wrapperStyle={{ fontSize: 11, color: MUTED }} />
                          {dateKeys.map((dk, i) => (
                            <Bar key={dk} dataKey={dk} fill={PALETTE[i % PALETTE.length]} radius={[3, 3, 0, 0]} maxBarSize={28} />
                          ))}
                        </>
                      ) : (
                        <Bar dataKey="capital" fill="#f5a623" radius={[3, 3, 0, 0]} maxBarSize={44}>
                          <LabelList dataKey="capital" position="top" style={{ fontSize: 10, fill: '#f5a623', fontWeight: 600 }} formatter={(v: unknown) => fmtMoney(v as number)} />
                        </Bar>
                      )}
                      <Line
                        type="monotone"
                        dataKey="cumulative_capital"
                        stroke="#90caf9"
                        strokeWidth={2}
                        dot={{ r: 3, fill: '#90caf9', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>

                  {/* ── Chart 2: P&L realized (closes) + cumulative line ── */}
                  <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mt: 2.5, mb: 0.75 }}>
                    P&L realized at close · cumulative line
                  </Typography>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={capitalTimeline.rows} margin={chartMargin} barCategoryGap="30%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="bucket" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={fmtTick} width={56} />
                      <ReferenceLine y={0} stroke="#3a3a5a" />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        labelStyle={{ color: '#d1d4dc', fontWeight: 600 }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(value: any, name: any) => {
                          if (name === 'cumulative_pnl') return [fmt(value as number), 'Cumulative P&L'];
                          if (name === 'pnl') return [fmt(value as number), 'P&L this bucket'];
                          return [fmt(value as number), name];
                        }}
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      />
                      <Bar dataKey="pnl" maxBarSize={44} radius={[3, 3, 0, 0]}>
                        {capitalTimeline.rows.map((r, i) => (
                          <Cell key={i} fill={r.pnl >= 0 ? GREEN : RED} />
                        ))}
                      </Bar>
                      <Line
                        type="monotone"
                        dataKey="cumulative_pnl"
                        stroke="#90caf9"
                        strokeWidth={2}
                        dot={{ r: 3, fill: '#90caf9', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>

                  {/* Per-session capital summary (multi-day only) */}
                  {multiDay && (
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 2 }}>
                      {sessions.map((s, i) => (
                        <Box key={s.date_key} sx={{ background: `${PALETTE[i % PALETTE.length]}18`, border: `1px solid ${PALETTE[i % PALETTE.length]}44`, borderRadius: 1.5, px: 1.5, py: 0.75, fontSize: 12 }}>
                          <Box sx={{ color: PALETTE[i % PALETTE.length], fontWeight: 600 }}>{s.date_label}</Box>
                          <Box sx={{ color: '#d1d4dc' }}>
                            {fmtMoney(s.capital_deployed ?? 0)}
                            <Box component="span" sx={{ color: MUTED, ml: 0.75, fontSize: 11 }}>· {s.trades} trade{s.trades !== 1 ? 's' : ''}</Box>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  )}
                </AccordionDetails>
              </Accordion>
            );
          })()}

          {/* ── Cross-Strategy by Hour ── */}
          <Accordion id="sec-cross-hour" expanded={expandedSections.has('sec-cross-hour')} onChange={() => toggleSection('sec-cross-hour')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', pr: 1 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Cross-Strategy Summary by Hour</Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  {getView('cross-hour') === 'chart' && (
                    <Box sx={{ display: 'flex', gap: 0.5, background: '#12141e', borderRadius: '6px', p: '2px' }}>
                      <Button
                        size="small"
                        onClick={(e) => { e.stopPropagation(); setCrossHourChartType('heatmap'); }}
                        sx={{
                          minWidth: 'unset',
                          px: 1.5,
                          py: 0.5,
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'none',
                          borderRadius: '4px',
                          color: crossHourChartType === 'heatmap' ? '#fff' : MUTED,
                          background: crossHourChartType === 'heatmap' ? '#2962ff' : 'transparent',
                          '&:hover': {
                            background: crossHourChartType === 'heatmap' ? '#2962ff' : 'rgba(255,255,255,0.05)',
                          },
                        }}
                      >
                        Heatmap
                      </Button>
                      <Button
                        size="small"
                        onClick={(e) => { e.stopPropagation(); setCrossHourChartType('positions'); }}
                        sx={{
                          minWidth: 'unset',
                          px: 1.5,
                          py: 0.5,
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'none',
                          borderRadius: '4px',
                          color: crossHourChartType === 'positions' ? '#fff' : MUTED,
                          background: crossHourChartType === 'positions' ? '#2962ff' : 'transparent',
                          '&:hover': {
                            background: crossHourChartType === 'positions' ? '#2962ff' : 'rgba(255,255,255,0.05)',
                          },
                        }}
                      >
                        Positions
                      </Button>
                    </Box>
                  )}
                  <ViewToggle view={getView('cross-hour')} onChange={(v) => setView('cross-hour', v)} />
                </Box>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0, overflowX: 'auto' }}>
              {getView('cross-hour') === 'table' ? (
                <Table size="small" sx={{ minWidth: 700 }}>
                  <TableHead>
                    <TableRow>
                      <TH>Hour (ET)</TH>
                      {strategyKeys.map((sk) => (
                        <TH key={sk}>{strategies[sk]?.name ?? sk}</TH>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {hourLabels.map((hl) => {
                      const row = crossHour[hl];
                      if (!row) return null;
                      return (
                        <TableRow key={hl} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD sx={{ fontWeight: 600, color: '#d1d4dc', whiteSpace: 'nowrap' }}>{hl}</TD>
                          {strategyKeys.map((sk) => (
                            <AggCell key={sk} agg={row[sk]} />
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : crossHourChartType === 'heatmap' ? (
                // Heatmap grid
                <Box sx={{ overflowX: 'auto' }}>
                  {/* Compute max abs PnL for scaling */}
                  {(() => {
                    const allVals: number[] = [];
                    hourLabels.forEach((hl) => {
                      const row = crossHour[hl];
                      if (row) strategyKeys.forEach((sk) => { if (row[sk]?.pnl != null) allVals.push(Math.abs(row[sk].pnl!)); });
                    });
                    const maxVal = Math.max(...allVals, 1);

                    return (
                      <Box sx={{ display: 'grid', gridTemplateColumns: `120px repeat(${strategyKeys.length}, 1fr)`, gap: '2px', minWidth: 500 }}>
                        {/* Header row */}
                        <Box sx={{ fontSize: 10, color: MUTED, p: '6px 8px', fontWeight: 600 }}>Hour (ET)</Box>
                        {strategyKeys.map((sk) => (
                          <Box key={sk} sx={{ fontSize: 10, color: MUTED, p: '6px 8px', fontWeight: 600, textAlign: 'center' }}>
                            {strategies[sk]?.name ?? sk}
                          </Box>
                        ))}
                        {/* Data rows */}
                        {hourLabels.map((hl) => {
                          const row = crossHour[hl];
                          if (!row) return null;
                          return [
                            <Box key={`${hl}-label`} sx={{ fontSize: 11, color: '#d1d4dc', p: '8px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                              {hl}
                            </Box>,
                            ...strategyKeys.map((sk) => {
                              const agg = row[sk];
                              const pnl = agg?.pnl ?? null;
                              const hasTrades = agg && agg.trades > 0;
                              const alpha = pnl != null ? Math.min(Math.abs(pnl) / maxVal, 1) * 0.65 + 0.1 : 0;
                              const bg = !hasTrades
                                ? 'transparent'
                                : pnl == null || pnl === 0
                                ? 'rgba(255,255,255,0.03)'
                                : pnl > 0
                                ? `rgba(76,175,80,${alpha})`
                                : `rgba(239,83,80,${alpha})`;
                              return (
                                <Box
                                  key={`${hl}-${sk}`}
                                  sx={{
                                    background: bg,
                                    border: `1px solid ${BORDER}`,
                                    borderRadius: 1,
                                    p: '6px 8px',
                                    textAlign: 'center',
                                    fontSize: 11,
                                  }}
                                >
                                  {hasTrades ? (
                                    <>
                                      <Box sx={{ color: pnlColor(pnl), fontWeight: 600 }}>{fmt(pnl)}</Box>
                                      <Box sx={{ color: MUTED, fontSize: 10 }}>{agg!.trades}t</Box>
                                    </>
                                  ) : (
                                    <Box sx={{ color: '#333' }}>—</Box>
                                  )}
                                </Box>
                              );
                            }),
                          ];
                        })}
                      </Box>
                    );
                  })()}
                </Box>
              ) : (
                // Stacked bar chart: Opens vs Closes
                <Box sx={{ overflowX: 'auto' }}>
                  {(() => {
                    // Transform data for stacked bar chart showing opens and closes
                    const chartData = hourLabels.map((hl) => {
                      const opensRow = crossHourOpens[hl];
                      const closesRow = crossHour[hl];

                      const dataPoint: Record<string, any> = {
                        hour: shortHour(hl),
                        fullHour: hl,
                        Opens: opensRow?.total ?? 0,
                        Closes: closesRow?.total?.trades ?? 0,
                      };

                      return dataPoint;
                    }).filter((d) => d.Opens > 0 || d.Closes > 0);

                    return (
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart
                          data={chartData}
                          margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                          <XAxis
                            dataKey="hour"
                            tick={{ ...CHART_STYLE, fill: MUTED }}
                          />
                          <YAxis
                            tick={{ ...CHART_STYLE, fill: MUTED }}
                            label={{ value: 'Positions', angle: -90, position: 'insideLeft', style: { ...CHART_STYLE, fill: MUTED } }}
                          />
                          <Tooltip
                            contentStyle={{
                              background: CARD_BG,
                              border: `1px solid ${BORDER}`,
                              borderRadius: 8,
                              fontSize: 11,
                            }}
                            labelStyle={{ color: '#d1d4dc', fontWeight: 600, marginBottom: 4 }}
                            formatter={((value: any, name: string) => [
                              `${value} position${value !== 1 ? 's' : ''}`,
                              name
                            ]) as any}
                            labelFormatter={(label: any) => {
                              const item = chartData.find(d => d.hour === label);
                              return item?.fullHour ?? label;
                            }}
                          />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar
                            dataKey="Opens"
                            stackId="a"
                            fill="#4dd0e1"
                          />
                          <Bar
                            dataKey="Closes"
                            stackId="a"
                            fill="#e57373"
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    );
                  })()}
                </Box>
              )}
            </AccordionDetails>
          </Accordion>

          {/* ── Per-strategy sections ── */}
          {strategyKeys.map((sk) => {
            const st = strategies[sk];
            if (!st) return null;
            const hasInfo = !!STRATEGY_INFO[sk];
            const hourView = getView(`strategy-hour-${sk}`);
            return (
              <Accordion key={sk} id={`sec-strategy-${sk}`} expanded={expandedSections.has(`sec-strategy-${sk}`)} onChange={() => toggleSection(`sec-strategy-${sk}`)} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', width: '100%' }}>
                    <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>{st.name}</Typography>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      <Chip label={`${st.trades} trades`} size="small" sx={{ fontSize: 11, background: '#1e2030', color: MUTED }} />
                      <Chip label={fmt(st.pnl)} size="small" sx={{ fontSize: 11, background: st.pnl > 0 ? 'rgba(76,175,80,.15)' : 'rgba(239,83,80,.15)', color: pnlColor(st.pnl) }} />
                      <Chip label={`${fmtWr(st.win_rate)} WR`} size="small" sx={{ fontSize: 11, background: '#1e2030', color: MUTED }} />
                    </Box>
                    {hasInfo && (
                      <IconButton
                        size="small"
                        onClick={(e) => { e.stopPropagation(); setInfoKey(sk); }}
                        sx={{
                          ml: 'auto',
                          mr: 1,
                          color: MUTED,
                          '&:hover': { color: '#7986cb' },
                          flexShrink: 0,
                        }}
                      >
                        <InfoOutlinedIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    )}
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  {/* Performance by Hour with toggle */}
                  <SectionHeader
                    title="Performance by Hour"
                    sectionKey={`strategy-hour-${sk}`}
                    view={hourView}
                    onViewChange={setView}
                  />
                  {hourView === 'table' ? (
                    <Table size="small" sx={{ mb: 2 }}>
                      <TableHead>
                        <TableRow>
                          <TH>Hour (ET)</TH><TH>Trades</TH><TH>P&L</TH><TH>Win%</TH><TH>Avg Return</TH><TH>Avg Hold</TH><TH>Tickers</TH>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {st.by_hour.map((h) => (
                          <TableRow key={h.hour} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                            <TD sx={{ whiteSpace: 'nowrap' }}>{h.hour}</TD>
                            <TD>{h.trades}</TD>
                            <TD sx={{ color: pnlColor(h.pnl), fontWeight: 600 }}>{fmt(h.pnl)}</TD>
                            <TD>{fmtWr(h.win_rate)}</TD>
                            <TD sx={{ color: pnlColor(h.avg_return) }}>{fmtPct(h.avg_return)}</TD>
                            <TD>{fmtHold(h.avg_hold)}</TD>
                            <TD sx={{ color: MUTED, fontSize: 11 }}>{h.tickers.join(', ')}</TD>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Box sx={{ mb: 2 }}>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                          data={st.by_hour.map((h) => ({ name: shortHour(h.hour), pnl: h.pnl ?? 0, trades: h.trades }))}
                          margin={{ top: 8, right: 8, left: 8, bottom: 4 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                          <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                          <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={(v) => `$${v.toFixed(0)}`} />
                          <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                            {st.by_hour.map((h, i) => (
                              <Cell key={i} fill={(h.pnl ?? 0) >= 0 ? GREEN : RED} />
                            ))}
                            <LabelList dataKey="pnl" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </Box>
                  )}

                  {/* Trade detail (no toggle — individual records are best as table) */}
                  <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>
                    Trade Detail ({st.trades} trades)
                  </Typography>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TH>Result</TH><TH>Symbol</TH><TH>Type</TH><TH>Close Time</TH><TH>Date</TH><TH>P&L</TH><TH>Return</TH><TH>Hold</TH>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {st.trade_list.map((t, i) => (
                        <TableRow key={i} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD>
                            <Box sx={{
                              display: 'inline-block', px: 0.75, py: 0.25, borderRadius: 0.75, fontSize: 10, fontWeight: 700,
                              background: t.win ? 'rgba(76,175,80,.2)' : 'rgba(239,83,80,.2)',
                              color: t.win ? GREEN : RED,
                            }}>
                              {t.win ? 'WIN' : 'LOSS'}
                            </Box>
                          </TD>
                          <TD sx={{ fontWeight: 600 }}>{t.symbol}</TD>
                          <TD sx={{ color: t.right === 'C' ? GREEN : t.right === 'P' ? RED : MUTED }}>
                            {t.right === 'C' ? 'CALL' : t.right === 'P' ? 'PUT' : '—'}
                          </TD>
                          <TD sx={{ whiteSpace: 'nowrap' }}>{t.close_time}</TD>
                          <TD sx={{ whiteSpace: 'nowrap' }}>{t.date}</TD>
                          <TD sx={{ color: pnlColor(t.pnl), fontWeight: 600 }}>{fmt(t.pnl)}</TD>
                          <TD sx={{ color: pnlColor(t.pnl_pct) }}>{fmtPct(t.pnl_pct)}</TD>
                          <TD>{fmtHold(t.hold_min)}</TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
            );
          })}

          {/* ── Ticker Summary ── */}
          <Accordion id="sec-ticker-summary" expanded={expandedSections.has('sec-ticker-summary')} onChange={() => toggleSection('sec-ticker-summary')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', pr: 1 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Ticker Summary</Typography>
                <ViewToggle view={getView('ticker')} onChange={(v) => setView('ticker', v)} />
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {getView('ticker') === 'table' ? (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TH>Ticker</TH><TH>Trades</TH><TH>Total P&L</TH><TH>Win Rate</TH><TH>Avg Hold</TH><TH>Calls</TH><TH>Puts</TH>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tickerSummary.map((t) => (
                      <TableRow key={t.symbol} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                        <TD sx={{ fontWeight: 600 }}>{t.symbol}</TD>
                        <TD>{t.trades}</TD>
                        <TD sx={{ color: pnlColor(t.pnl), fontWeight: 600 }}>{fmt(t.pnl)}</TD>
                        <TD>{fmtWr(t.win_rate)}</TD>
                        <TD sx={{ color: MUTED }}>{t.avg_hold != null ? fmtHold(t.avg_hold) : '—'}</TD>
                        <TD sx={{ fontSize: 11, color: MUTED }}>
                          {t.calls ? `${t.calls.trades}t ${fmtWr(t.calls.win_rate)} WR ${fmt(t.calls.pnl)}` : '—'}
                        </TD>
                        <TD sx={{ fontSize: 11, color: MUTED }}>
                          {t.puts ? `${t.puts.trades}t ${fmtWr(t.puts.win_rate)} WR ${fmt(t.puts.pnl)}` : '—'}
                        </TD>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5 }}>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED }}>
                      P&L & Hold Time by Ticker
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 2, fontSize: 11 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Box sx={{ width: 12, height: 12, borderRadius: 0.5, background: GREEN }} />
                        <Typography sx={{ fontSize: 10, color: MUTED }}>P&L (Win)</Typography>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Box sx={{ width: 12, height: 12, borderRadius: 0.5, background: RED }} />
                        <Typography sx={{ fontSize: 10, color: MUTED }}>P&L (Loss)</Typography>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Box sx={{ width: 12, height: 12, borderRadius: 0.5, background: '#7986cb' }} />
                        <Typography sx={{ fontSize: 10, color: MUTED }}>Avg Hold</Typography>
                      </Box>
                    </Box>
                  </Box>
                  <ResponsiveContainer width="100%" height={Math.max(300, tickerSummary.length * 50 + 60)}>
                    <BarChart
                      layout="vertical"
                      data={tickerSummary.map((t) => ({
                        name: t.symbol,
                        pnl: t.pnl ?? 0,
                        hold: t.avg_hold ?? 0,
                        pnlPositive: (t.pnl ?? 0) >= 0
                      }))}
                      margin={{ top: 8, right: 80, left: 8, bottom: 4 }}
                      barGap={2}
                      barCategoryGap="20%"
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" horizontal={false} />
                      <XAxis
                        xAxisId="pnl"
                        type="number"
                        tick={{ ...CHART_STYLE, fill: MUTED, fontSize: 10 }}
                        tickFormatter={(v) => `$${v.toFixed(0)}`}
                        orientation="bottom"
                      />
                      <XAxis
                        xAxisId="hold"
                        type="number"
                        tick={{ ...CHART_STYLE, fill: MUTED, fontSize: 10 }}
                        tickFormatter={(v) => `${v.toFixed(0)}m`}
                        orientation="top"
                      />
                      <YAxis type="category" dataKey="name" tick={{ ...CHART_STYLE, fill: '#d1d4dc', fontWeight: 600 }} width={52} />
                      <Bar xAxisId="pnl" dataKey="pnl" radius={[0, 3, 3, 0]} maxBarSize={16}>
                        {tickerSummary.map((t, i) => (
                          <Cell key={i} fill={(t.pnl ?? 0) >= 0 ? GREEN : RED} />
                        ))}
                        <LabelList dataKey="pnl" position="right" style={{ fontSize: 9, fill: '#d1d4dc', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                      </Bar>
                      <Bar xAxisId="hold" dataKey="hold" radius={[0, 3, 3, 0]} fill="#7986cb" maxBarSize={16}>
                        <LabelList dataKey="hold" position="right" style={{ fontSize: 9, fill: '#d1d4dc', fontWeight: 600 }} formatter={(v: any) => fmtHold(v as number)} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
            </AccordionDetails>
          </Accordion>

          {/* ── Take-Profit Optimization ── */}
          {tickerTp.length > 0 && (
            <Accordion id="sec-tp-opt" expanded={expandedSections.has('sec-tp-opt')} onChange={() => toggleSection('sec-tp-opt')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Take-Profit Optimization</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                {/* ── Post-Exit Opportunity sub-table ── */}
                <Box sx={{ mt: 3 }}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 0.75 }}>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED }}>
                      Post-Exit Opportunity (underlying % after TP hit)
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: '#37474f' }}>
                      — winning trades only · IB 1-min bars from exit → 14:00 ET
                    </Typography>
                  </Box>
                  <Typography sx={{ fontSize: 12, color: MUTED, mb: 1.5 }}>
                    How much further the underlying moved in your direction after you exited at TP. P25 = 75% of wins had at least this much remaining.
                  </Typography>
                  {postExit.length === 0 ? (
                    <Box sx={{ background: ROW_BG, border: `1px solid ${BORDER}`, borderRadius: 1.5, px: 2, py: 1.5 }}>
                      {postExitLoading ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5 }}>
                          <CircularProgress size={16} />
                          <Typography sx={{ fontSize: 12, color: MUTED }}>
                            Running analysis… fetching 1-min bars from IB for each winning trade. This may take a few minutes.
                          </Typography>
                        </Box>
                      ) : (
                        <>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: postExitError ? 1 : 0 }}>
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={handleRunPostExit}
                              sx={{ textTransform: 'none', fontSize: 12, borderColor: BORDER, color: MUTED, '&:hover': { borderColor: '#7986cb', color: '#7986cb' } }}
                            >
                              Run Analysis
                            </Button>
                            <Typography sx={{ fontSize: 11, color: '#37474f' }}>
                              Requires IB connection · fetches 1-min bars per winning trade (~1–3 min)
                            </Typography>
                          </Box>
                          {postExitError && (
                            <Typography sx={{ fontSize: 11, color: RED, mt: 0.5 }}>
                              Error: {postExitError}
                            </Typography>
                          )}
                        </>
                      )}
                      {Object.keys(postExitDebug).length > 0 && (
                        <Box sx={{ fontFamily: 'monospace', fontSize: 11, color: '#546e7a', mt: 1 }}>
                          {Object.entries(postExitDebug).map(([k, v]) => (
                            <Box key={k}>
                              {k}: {Array.isArray(v) ? (v.length === 0 ? '[]' : v.map((s, i) => <Box key={i} sx={{ pl: 2, color: RED }}>{s}</Box>)) : String(v)}
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  ) : (
                    <>
                      <Table size="small" sx={{ overflowX: 'auto' }}>
                        <TableHead>
                          <TableRow>
                            <TH>Symbol</TH>
                            <TH>Trades</TH>
                            <TH>Current TP</TH>
                            <TH>P25 left (stock)</TH>
                            <TH>Avg Stock $</TH>
                            <TH>Avg Option $</TH>
                            <TH>Avg Delta</TH>
                            <TH>Leverage</TH>
                            <TH>Avg Hold</TH>
                            <TH>Avg → Peak</TH>
                            <TH>Suggested TP %</TH>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {postExit.map((row) => (
                            <TableRow key={row.symbol} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                              <TD sx={{ fontWeight: 600 }}>{row.symbol}</TD>
                              <TD sx={{ color: MUTED }}>{row.sample}</TD>
                              <TD sx={{ color: MUTED }}>
                                {row.current_tp_pct != null ? `+${row.current_tp_pct.toFixed(1)}%` : '—'}
                              </TD>
                              <TD sx={{ color: '#ffb74d', fontWeight: 600 }}>
                                +{row.p25_left_pct.toFixed(2)}%
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                {row.avg_stock_price != null ? `$${row.avg_stock_price.toFixed(2)}` : '—'}
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                {row.avg_option_entry != null ? `$${row.avg_option_entry.toFixed(2)}` : '—'}
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                {row.avg_delta != null ? (
                                  <>
                                    {row.avg_delta.toFixed(2)}
                                    {row.delta_estimated && <Box component="span" sx={{ color: '#ff9800', fontSize: 10, ml: 0.5 }}>(est.)</Box>}
                                  </>
                                ) : '—'}
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                {row.avg_leverage != null ? (
                                  <>
                                    {`${row.avg_leverage}×`}
                                    {row.delta_estimated && <Box component="span" sx={{ color: '#ff9800', fontSize: 10, ml: 0.5 }}>(est.)</Box>}
                                  </>
                                ) : '—'}
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                {row.avg_hold_min != null ? fmtHold(row.avg_hold_min) : '—'}
                              </TD>
                              <TD sx={{ color: MUTED }}>
                                +{row.avg_mins_to_peak}m
                              </TD>
                              <TD>
                                {row.suggested_tp_pct != null ? (
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Box sx={{
                                      display: 'inline-block',
                                      background: 'rgba(76,175,80,0.15)',
                                      border: '1px solid rgba(76,175,80,0.4)',
                                      borderRadius: 1, px: 1, py: 0.25,
                                      fontSize: 13, fontWeight: 700, color: GREEN,
                                    }}>
                                      +{row.suggested_tp_pct.toFixed(1)}%
                                    </Box>
                                    {row.delta_estimated && (
                                      <Box sx={{ color: '#ff9800', fontSize: 10 }}>(est.)</Box>
                                    )}
                                  </Box>
                                ) : (
                                  <Box sx={{ color: MUTED, fontSize: 11 }}>—</Box>
                                )}
                              </TD>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <Box sx={{ mt: 1.5, background: ROW_BG, border: `1px solid ${BORDER}`, borderRadius: 1.5, px: 2, py: 1.25 }}>
                        <Typography sx={{ fontSize: 11, color: MUTED, fontFamily: 'monospace' }}>
                          Suggested TP = Current TP% + P25_stock% × delta × (avg_stock / avg_option)
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: '#546e7a', mt: 0.5 }}>
                          Based on P25 = 75% of TP-winning trades had at least this much stock move remaining after exit.
                          Recalculate with tomorrow's actual option price if it differs from the average shown above.
                        </Typography>
                      </Box>
                      <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        {postExitLoading ? (
                          <>
                            <CircularProgress size={14} />
                            <Typography sx={{ fontSize: 12, color: MUTED }}>Re-running analysis…</Typography>
                          </>
                        ) : (
                          <Button
                            variant="outlined"
                            size="small"
                            onClick={handleRunPostExit}
                            sx={{ textTransform: 'none', fontSize: 12, borderColor: BORDER, color: MUTED, '&:hover': { borderColor: '#7986cb', color: '#7986cb' } }}
                          >
                            Re-run Analysis
                          </Button>
                        )}
                        {postExitError && (
                          <Typography sx={{ fontSize: 11, color: RED }}>Error: {postExitError}</Typography>
                        )}
                      </Box>
                    </>
                  )}
                </Box>
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Best & Worst Trades ── */}
          <Accordion id="sec-best-worst" expanded={expandedSections.has('sec-best-worst')} onChange={() => toggleSection('sec-best-worst')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
              <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Best & Worst Trades</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {[
                { label: 'Top 5 by % Return', trades: bestTrades },
                { label: 'Worst 5 by % Return', trades: worstTrades },
              ].map(({ label, trades: list }) => (
                <Box key={label} sx={{ mb: 3 }}>
                  <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>
                    {label}
                  </Typography>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TH>Result</TH><TH>Symbol</TH><TH>Type</TH><TH>Date</TH><TH>P&L</TH><TH>Return</TH><TH>Hold</TH><TH>Strategy</TH>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {list.map((t, i) => (
                        <TableRow key={i} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD>
                            <Box sx={{
                              display: 'inline-block', px: 0.75, py: 0.25, borderRadius: 0.75, fontSize: 10, fontWeight: 700,
                              background: t.win ? 'rgba(76,175,80,.2)' : 'rgba(239,83,80,.2)',
                              color: t.win ? GREEN : RED,
                            }}>
                              {t.win ? 'WIN' : 'LOSS'}
                            </Box>
                          </TD>
                          <TD sx={{ fontWeight: 600 }}>{t.symbol}</TD>
                          <TD sx={{ color: t.right === 'C' ? GREEN : t.right === 'P' ? RED : MUTED }}>
                            {t.right === 'C' ? 'CALL' : t.right === 'P' ? 'PUT' : '—'}
                          </TD>
                          <TD sx={{ whiteSpace: 'nowrap' }}>{t.date}</TD>
                          <TD sx={{ color: pnlColor(t.pnl), fontWeight: 600 }}>{fmt(t.pnl)}</TD>
                          <TD sx={{ color: pnlColor(t.pnl_pct) }}>{fmtPct(t.pnl_pct)}</TD>
                          <TD>{fmtHold(t.hold_min)}</TD>
                          <TD sx={{ fontSize: 11, color: MUTED }}>{t.strategy}</TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>

          {/* ── Calls vs Puts ── */}
          {cp && (
            <Accordion id="sec-calls-puts" expanded={expandedSections.has('sec-calls-puts')} onChange={() => toggleSection('sec-calls-puts')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Calls vs Puts Analysis</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                {/* Summary cards — always shown */}
                <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
                  {[
                    { label: 'CALLS', agg: cp.calls, color: GREEN, bg: 'rgba(76,175,80,.07)', border: 'rgba(76,175,80,.3)' },
                    { label: 'PUTS', agg: cp.puts, color: RED, bg: 'rgba(239,83,80,.07)', border: 'rgba(239,83,80,.3)' },
                  ].map(({ label, agg, color, bg, border }) => (
                    <Box key={label} sx={{ flex: 1, minWidth: 220, background: bg, border: `1px solid ${border}`, borderRadius: 2, p: 2.5 }}>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color, mb: 0.5 }}>
                        {label}
                      </Typography>
                      <Typography sx={{ fontSize: 26, fontWeight: 800, color: pnlColor(agg.pnl) }}>
                        {fmt(agg.pnl)}
                      </Typography>
                      <Typography sx={{ fontSize: 12, color: MUTED }}>
                        {agg.trades} trades · {fmtWr(agg.win_rate)} win rate{agg.avg_return != null ? ` · avg ${fmtPct(agg.avg_return)}` : ''}
                      </Typography>
                      <Typography sx={{ fontSize: 12, color: MUTED }}>
                        {agg.wins} wins / {agg.losses} losses{agg.avg_hold != null ? ` · avg hold ${fmtHold(agg.avg_hold)}` : ''}
                      </Typography>
                    </Box>
                  ))}
                </Box>

                {/* By hour with toggle */}
                <SectionHeader title="By Hour of Day" sectionKey="cp-hour" view={getView('cp-hour')} onViewChange={setView} />
                {getView('cp-hour') === 'table' ? (
                  <Table size="small" sx={{ mb: 3 }}>
                    <TableHead>
                      <TableRow><TH>Hour (ET)</TH><TH>Calls</TH><TH>Puts</TH></TableRow>
                    </TableHead>
                    <TableBody>
                      {cp.by_hour.map((r) => (
                        <TableRow key={r.hour} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{r.hour}</TD>
                          <CpAggCell agg={r.calls} right="C" />
                          <CpAggCell agg={r.puts} right="P" />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Box sx={{ mb: 3 }}>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart
                        data={cp.by_hour.map((r) => ({
                          name: shortHour(r.hour),
                          calls: r.calls?.pnl ?? 0,
                          puts: r.puts?.pnl ?? 0,
                        }))}
                        margin={{ top: 8, right: 8, left: 8, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                        <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                        <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={(v) => `$${v.toFixed(0)}`} />
                        <Bar dataKey="calls" name="Calls" fill={GREEN} radius={[3, 3, 0, 0]} opacity={0.85}>
                          <LabelList dataKey="calls" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                        </Bar>
                        <Bar dataKey="puts" name="Puts" fill={RED} radius={[3, 3, 0, 0]} opacity={0.85}>
                          <LabelList dataKey="puts" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Box>
                )}

                {/* By strategy */}
                <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>By Strategy</Typography>
                <Table size="small" sx={{ mb: 3 }}>
                  <TableHead>
                    <TableRow><TH>Strategy</TH><TH>Calls</TH><TH>Puts</TH></TableRow>
                  </TableHead>
                  <TableBody>
                    {cp.by_strategy.map((r) => (
                      <TableRow key={r.strategy} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                        <TD sx={{ fontWeight: 600 }}>{r.strategy}</TD>
                        <CpAggCell agg={r.calls} right="C" />
                        <CpAggCell agg={r.puts} right="P" />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* By ticker */}
                <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>By Ticker</Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow><TH>Ticker</TH><TH>Calls</TH><TH>Puts</TH></TableRow>
                  </TableHead>
                  <TableBody>
                    {cp.by_ticker.map((r) => (
                      <TableRow key={r.symbol} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                        <TD sx={{ fontWeight: 600 }}>{r.symbol}</TD>
                        <CpAggCell agg={r.calls} right="C" />
                        <CpAggCell agg={r.puts} right="P" />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Signal Conversion Funnel ── */}
          {signalStats && signalStats.total_evaluated > 0 && (
            <Accordion id="sec-signals" expanded={expandedSections.has('sec-signals')} onChange={() => toggleSection('sec-signals')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Signal Conversion Funnel</Typography>
                  <Chip label={`${signalStats.conversion_rate ?? '—'}% converted`} size="small" sx={{ fontSize: 11, background: '#1e2030', color: MUTED }} />
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                {/* Overall funnel cards */}
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
                  {[
                    { label: 'Signals Evaluated', value: signalStats.total_evaluated, color: '#d1d4dc' },
                    { label: 'Acted On (Traded)', value: signalStats.total_acted_on, color: GREEN },
                    { label: 'Skipped', value: signalStats.total_skipped, color: RED },
                    { label: 'Conversion Rate', value: `${signalStats.conversion_rate ?? '—'}%`, color: MUTED },
                  ].map(({ label, value, color }) => (
                    <Box key={label} sx={{ background: ROW_BG, border: `1px solid ${BORDER}`, borderRadius: 1.5, px: 2, py: 1.5, minWidth: 130 }}>
                      <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED }}>{label}</Typography>
                      <Typography sx={{ fontSize: 20, fontWeight: 700, color, mt: 0.5 }}>{value}</Typography>
                    </Box>
                  ))}
                </Box>

                {/* Skip reasons */}
                {Object.keys(signalStats.skip_reasons).length > 0 && (
                  <>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>
                      Top Skip Reasons (All Strategies)
                    </Typography>
                    <Table size="small" sx={{ mb: 2 }}>
                      <TableHead><TableRow><TH>Reason</TH><TH>Count</TH></TableRow></TableHead>
                      <TableBody>
                        {Object.entries(signalStats.skip_reasons).map(([reason, count]) => (
                          <TableRow key={reason} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                            <TD sx={{ fontFamily: 'monospace', fontSize: 12 }}>{reason}</TD>
                            <TD>{count as number}</TD>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}

                {/* Per-strategy breakdown with toggle */}
                <SectionHeader title="By Strategy" sectionKey="funnel-strategy" view={getView('funnel-strategy')} onViewChange={setView} />
                {getView('funnel-strategy') === 'table' ? (
                  <Table size="small">
                    <TableHead>
                      <TableRow><TH>Strategy</TH><TH>Evaluated</TH><TH>Traded</TH><TH>Skipped</TH><TH>Conversion</TH><TH>Top Skip Reason</TH></TableRow>
                    </TableHead>
                    <TableBody>
                      {strategyKeys.map((sk) => {
                        const ss = signalStats.by_strategy[sk];
                        if (!ss) return null;
                        const topReason = Object.keys(ss.skip_reasons)[0];
                        return (
                          <TableRow key={sk} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                            <TD sx={{ fontWeight: 600 }}>{strategies[sk]?.name ?? sk}</TD>
                            <TD>{ss.evaluated}</TD>
                            <TD sx={{ color: GREEN }}>{ss.acted_on}</TD>
                            <TD sx={{ color: ss.skipped > 0 ? RED : MUTED }}>{ss.skipped}</TD>
                            <TD>{ss.conversion_rate != null ? `${ss.conversion_rate}%` : '—'}</TD>
                            <TD sx={{ fontSize: 11, color: MUTED, fontFamily: 'monospace' }}>{topReason ?? '—'}</TD>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={strategyKeys
                        .filter((sk) => signalStats.by_strategy[sk])
                        .map((sk) => {
                          const ss = signalStats.by_strategy[sk];
                          return {
                            name: strategies[sk]?.name ?? sk,
                            evaluated: ss!.evaluated,
                            traded: ss!.acted_on,
                            skipped: ss!.skipped,
                          };
                        })}
                      margin={{ top: 8, right: 8, left: 8, bottom: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <Bar dataKey="evaluated" name="Evaluated" fill="#7986cb" radius={[3, 3, 0, 0]} opacity={0.7}>
                        <LabelList dataKey="evaluated" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} />
                      </Bar>
                      <Bar dataKey="traded" name="Traded" fill={GREEN} radius={[3, 3, 0, 0]} opacity={0.85}>
                        <LabelList dataKey="traded" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} />
                      </Bar>
                      <Bar dataKey="skipped" name="Skipped" fill={RED} radius={[3, 3, 0, 0]} opacity={0.7}>
                        <LabelList dataKey="skipped" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Skipped Signals Detail ── */}
          {signalStats && signalStats.total_skipped > 0 && (
            <Accordion id="sec-skipped" expanded={expandedSections.has('sec-skipped')} onChange={() => toggleSection('sec-skipped')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Skipped Signals</Typography>
                  <Typography sx={{ fontSize: 12, color: MUTED }}>{signalStats.total_skipped} skipped · {signalStats.entries.length} entries</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>

                {/* Per-ticker breakdown */}
                {signalStats.by_ticker.length > 0 && (
                  <>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>By Ticker</Typography>
                    <Table size="small" sx={{ mb: 3 }}>
                      <TableHead>
                        <TableRow><TH>Symbol</TH><TH>Skipped</TH><TH>Top Reason</TH><TH>All Reasons</TH></TableRow>
                      </TableHead>
                      <TableBody>
                        {signalStats.by_ticker.map((row) => (
                          <TableRow key={row.symbol} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                            <TD sx={{ fontWeight: 700, color: '#d1d4dc' }}>{row.symbol}</TD>
                            <TD sx={{ color: RED }}>{row.total}</TD>
                            <TD sx={{ fontFamily: 'monospace', fontSize: 11, color: MUTED }}>{row.top_reason}</TD>
                            <TD sx={{ fontSize: 11, color: MUTED }}>
                              {Object.entries(row.reasons).map(([r, c]) => `${r}: ${c}`).join(' · ')}
                            </TD>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}

                {/* Per-hour distribution */}
                {signalStats.by_hour.length > 0 && (
                  <>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>By Hour</Typography>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={signalStats.by_hour.map(r => ({ ...r, hour: shortHour(r.hour) }))} margin={{ top: 4, right: 16, left: 4, bottom: 4 }} barCategoryGap="35%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                        <XAxis dataKey="hour" tick={{ ...CHART_STYLE, fill: MUTED }} />
                        <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} allowDecimals={false} width={32} />
                        <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2b2b43', borderRadius: 6, fontSize: 12 }} labelStyle={{ color: '#d1d4dc', fontWeight: 600 }} // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(v: any) => [v, 'Skipped']} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                        <Bar dataKey="skipped" fill={RED} radius={[3, 3, 0, 0]} opacity={0.8} maxBarSize={40}>
                          <LabelList dataKey="skipped" position="top" style={{ fontSize: 10, fill: RED, fontWeight: 600 }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <Box sx={{ mb: 3 }} />
                  </>
                )}

                {/* Individual entries table */}
                {signalStats.entries.length > 0 && (
                  <>
                    <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, mb: 1 }}>All Entries (most recent first)</Typography>
                    <Box sx={{ overflowX: 'auto' }}>
                      <Table size="small" sx={{ minWidth: 860 }}>
                        <TableHead>
                          <TableRow>
                            <TH>Time (ET)</TH>
                            <TH>Symbol</TH>
                            <TH>Dir</TH>
                            <TH>Strategy</TH>
                            <TH>Reason</TH>
                            <TH>Stage</TH>
                            <TH>Stock px</TH>
                            <TH>Nearest strike</TH>
                            <TH>Range</TH>
                            <TH>Range diff</TH>
                            <TH>Quotes</TH>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {signalStats.entries.map((e, i) => {
                            const rangeColor = e.range_reason === 'above' ? '#f5a623' : e.range_reason === 'below' ? '#90caf9' : MUTED;
                            return (
                              <TableRow key={i} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                                <TD sx={{ color: MUTED, fontSize: 11, whiteSpace: 'nowrap' }}>{e.time_et ?? '—'}</TD>
                                <TD sx={{ fontWeight: 700, color: '#d1d4dc' }}>{e.symbol}</TD>
                                <TD sx={{ color: e.direction === 'CALL' || e.direction === 'C' ? GREEN : RED, fontWeight: 600, fontSize: 11 }}>
                                  {e.direction ?? '—'}
                                </TD>
                                <TD sx={{ fontSize: 11, color: MUTED }}>{strategies[e.strategy]?.name?.split('—')[0].trim() ?? e.strategy}</TD>
                                <TD sx={{ fontFamily: 'monospace', fontSize: 11, color: RED }}>{e.reason_code}</TD>
                                <TD sx={{ fontSize: 11, color: MUTED }}>{e.stage ?? '—'}</TD>
                                <TD>{e.latest_price != null ? `$${e.latest_price.toFixed(2)}` : '—'}</TD>
                                <TD>{e.nearest_strike != null ? `$${e.nearest_strike}` : '—'}</TD>
                                <TD sx={{ fontSize: 11, color: MUTED }}>
                                  {e.min_premium != null && e.max_premium != null
                                    ? `$${e.min_premium}–$${e.max_premium}`
                                    : '—'}
                                </TD>
                                <TD sx={{ color: rangeColor, fontSize: 11, fontWeight: 600 }}>
                                  {e.range_reason
                                    ? `${e.range_reason}${e.range_diff_pct != null ? ` (${(e.range_diff_pct * 100).toFixed(1)}%)` : ''}`
                                    : '—'}
                                </TD>
                                <TD sx={{ fontSize: 11, color: MUTED }}>{e.quote_count ?? '—'}</TD>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </Box>
                  </>
                )}
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── IV & MFE/MAE ── */}
          {ivMfeMae && Object.keys(ivMfeMae.by_strategy).length > 0 && (
            <Accordion id="sec-iv-mfe" expanded={expandedSections.has('sec-iv-mfe')} onChange={() => toggleSection('sec-iv-mfe')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', pr: 1 }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>IV & MFE / MAE Analysis</Typography>
                  <ViewToggle view={getView('iv-mfe')} onChange={(v) => setView('iv-mfe', v)} />
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Typography sx={{ fontSize: 12, color: MUTED, mb: 2 }}>
                  MFE (Max Favorable Excursion) = how far the underlying moved in your direction during the hold.
                  MAE (Max Adverse Excursion) = how far it moved against you. Both measured on the underlying stock.
                </Typography>
                {getView('iv-mfe') === 'table' ? (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TH>Strategy</TH>
                        <TH>Avg Delta</TH>
                        <TH>Avg IV Entry</TH>
                        <TH>Avg IV Exit</TH>
                        <TH>Avg IV Crush</TH>
                        <TH>Avg MFE %</TH>
                        <TH>Avg MAE %</TH>
                        <TH>Sample</TH>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(ivMfeMae.by_strategy).map(([sk, d]: [string, any]) => (
                        <TableRow key={sk} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD sx={{ fontWeight: 600 }}>{strategies[sk]?.name ?? sk}</TD>
                          <TD sx={{ color: '#d1d4dc', fontWeight: 600 }}>
                            {d.avg_delta_entry != null ? d.avg_delta_entry.toFixed(2) : '—'}
                          </TD>
                          <TD sx={{ color: MUTED }}>{d.avg_iv_entry != null ? `${(d.avg_iv_entry * 100).toFixed(1)}%` : '—'}</TD>
                          <TD sx={{ color: MUTED }}>{d.avg_iv_exit != null ? `${(d.avg_iv_exit * 100).toFixed(1)}%` : '—'}</TD>
                          <TD sx={{ color: d.avg_iv_crush != null ? (d.avg_iv_crush > 0 ? RED : GREEN) : MUTED }}>
                            {d.avg_iv_crush != null ? `${d.avg_iv_crush > 0 ? '-' : '+'}${Math.abs(d.avg_iv_crush * 100).toFixed(1)}%` : '—'}
                          </TD>
                          <TD sx={{ color: d.avg_mfe_pct != null ? GREEN : MUTED }}>
                            {d.avg_mfe_pct != null ? `+${d.avg_mfe_pct.toFixed(2)}%` : '—'}
                          </TD>
                          <TD sx={{ color: d.avg_mae_pct != null ? (d.avg_mae_pct < 0 ? RED : MUTED) : MUTED }}>
                            {d.avg_mae_pct != null ? `${d.avg_mae_pct.toFixed(2)}%` : '—'}
                          </TD>
                          <TD sx={{ color: MUTED, fontSize: 11 }}>{d.mfe_count ?? 0} trades</TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart
                      data={Object.entries(ivMfeMae.by_strategy).map(([sk, d]: [string, any]) => ({
                        name: strategies[sk]?.name ?? sk,
                        mfe: d.avg_mfe_pct != null ? parseFloat(d.avg_mfe_pct.toFixed(2)) : 0,
                        mae: d.avg_mae_pct != null ? parseFloat(d.avg_mae_pct.toFixed(2)) : 0,
                      }))}
                      margin={{ top: 8, right: 8, left: 8, bottom: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={(v) => `${v}%`} />
                      <Legend wrapperStyle={{ fontSize: 11, color: MUTED }} />
                      <Bar dataKey="mfe" name="Avg MFE %" fill={GREEN} radius={[3, 3, 0, 0]} opacity={0.85}>
                        <LabelList dataKey="mfe" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => `${v}%`} />
                      </Bar>
                      <Bar dataKey="mae" name="Avg MAE %" fill={RED} radius={[3, 3, 0, 0]} opacity={0.7}>
                        <LabelList dataKey="mae" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => `${v}%`} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </AccordionDetails>
            </Accordion>
          )}

          {/* ── Market Context ── */}
          {marketContext && Object.keys(marketContext.by_spy_direction).length > 0 && (
            <Accordion id="sec-market" expanded={expandedSections.has('sec-market')} onChange={() => toggleSection('sec-market')} sx={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: '10px !important', mb: 2, '&:before': { display: 'none' }, scrollMarginTop: '16px' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: MUTED }} />}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', pr: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Typography sx={{ fontSize: 15, fontWeight: 600, color: '#d1d4dc' }}>Market Context — SPY Direction</Typography>
                    <Chip label={`${marketContext.days_with_context} days with data`} size="small" sx={{ fontSize: 11, background: '#1e2030', color: MUTED }} />
                  </Box>
                  <ViewToggle view={getView('market-context')} onChange={(v) => setView('market-context', v)} />
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Typography sx={{ fontSize: 12, color: MUTED, mb: 2 }}>
                  Win rate and P&L grouped by the dominant SPY 1-minute direction during each trading session.
                </Typography>
                {getView('market-context') === 'table' ? (
                  <Table size="small">
                    <TableHead>
                      <TableRow><TH>SPY Direction</TH><TH>Trades</TH><TH>P&L</TH><TH>Win Rate</TH><TH>Avg Return</TH></TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(marketContext.by_spy_direction).map(([dir, agg]: [string, any]) => (
                        <TableRow key={dir} hover sx={{ '&:hover td': { background: ROW_BG } }}>
                          <TD sx={{ fontWeight: 600, color: dir === 'up' ? GREEN : dir === 'down' ? RED : MUTED }}>
                            {dir === 'up' ? '↑ Trending Up' : dir === 'down' ? '↓ Trending Down' : '→ Flat'}
                          </TD>
                          <TD>{agg.trades}</TD>
                          <TD sx={{ color: pnlColor(agg.pnl), fontWeight: 600 }}>{fmt(agg.pnl)}</TD>
                          <TD>{fmtWr(agg.win_rate)}</TD>
                          <TD sx={{ color: pnlColor(agg.avg_return) }}>{fmtPct(agg.avg_return)}</TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={Object.entries(marketContext.by_spy_direction).map(([dir, agg]: [string, any]) => ({
                        name: dir === 'up' ? '↑ Up' : dir === 'down' ? '↓ Down' : '→ Flat',
                        pnl: agg.pnl ?? 0,
                        dir,
                      }))}
                      margin={{ top: 8, right: 8, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                      <XAxis dataKey="name" tick={{ ...CHART_STYLE, fill: MUTED }} />
                      <YAxis tick={{ ...CHART_STYLE, fill: MUTED }} tickFormatter={(v) => `$${v.toFixed(0)}`} />
                      <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                        {Object.entries(marketContext.by_spy_direction).map(([dir], i) => (
                          <Cell key={i} fill={dir === 'up' ? GREEN : dir === 'down' ? RED : MUTED} />
                        ))}
                        <LabelList dataKey="pnl" position="center" style={{ fontSize: 10, fill: '#fff', fontWeight: 600 }} formatter={(v: any) => fmt(v as number)} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </AccordionDetails>
            </Accordion>
          )}
        </>
      )}

      {/* Strategy info modal */}
      <StrategyInfoModal strategyKey={infoKey} onClose={() => setInfoKey(null)} />
      </Box> {/* end main content */}
    </Box>
  );
}
