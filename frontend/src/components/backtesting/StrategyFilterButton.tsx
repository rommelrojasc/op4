/**
 * Strategy Filter Button — shared toggle for selecting which strategies to run in backtesting.
 * Renders a TuneIcon button that opens a popover with checkboxes for each strategy.
 */
import { useState, useCallback } from 'react';
import {
  Box,
  Button,
  IconButton,
  Popover,
  FormControlLabel,
  Checkbox,
  Typography,
  Tooltip,
  Divider,
} from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';

// Strategy number → display name
const STRATEGY_LABELS: Record<number, string> = {
  1: 'S1 — MA20 Crossover',
  2: 'S2 — Midline Bounce',
  3: 'S3 — Open Gap Fade',
  4: 'S4 — Magnet Effect',
  5: 'S5 — Lateral Open BB',
  6: 'CT15 — Gap Trendline',
  60: 'CT-Open — Squeeze',
  7: 'S7 — 0DTE Scalper',
  8: 'S8 — 0DTE Momentum',
  9: 'S9 — 0DTE Gap Fade',
  10: 'S10 — 0DTE Trend',
  11: 'S11 — ICT Price Action',
};

const ALL_STRATEGY_NUMS = [1, 2, 3, 4, 5, 6, 60, 7, 8, 9, 10, 11];

export type EnabledStrategies = Record<number, boolean>;

export const DEFAULT_ENABLED: EnabledStrategies = Object.fromEntries(
  ALL_STRATEGY_NUMS.map((n) => [n, true])
);

/** Build comma-separated string for the API query param. Empty = all. */
export function enabledStrategiesToParam(enabled: EnabledStrategies): string {
  const active = ALL_STRATEGY_NUMS.filter((n) => enabled[n] !== false);
  if (active.length === ALL_STRATEGY_NUMS.length) return ''; // all enabled
  return active.join(',');
}

interface StrategyFilterButtonProps {
  enabled: EnabledStrategies;
  onChange: (next: EnabledStrategies) => void;
}

export function StrategyFilterButton({ enabled, onChange }: StrategyFilterButtonProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const activeCount = ALL_STRATEGY_NUMS.filter((n) => enabled[n] !== false).length;
  const allOn = activeCount === ALL_STRATEGY_NUMS.length;

  const handleToggle = useCallback(
    (num: number) => {
      onChange({ ...enabled, [num]: !enabled[num] });
    },
    [enabled, onChange]
  );

  const handleAll = () => onChange(Object.fromEntries(ALL_STRATEGY_NUMS.map((n) => [n, true])));
  const handleNone = () => onChange(Object.fromEntries(ALL_STRATEGY_NUMS.map((n) => [n, false])));

  return (
    <>
      <Tooltip title="Select strategies to run">
        <IconButton
          size="small"
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{
            color: allOn ? '#787b86' : '#2962ff',
            '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
          }}
        >
          <TuneIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {!allOn && (
        <Typography sx={{ fontSize: 11, color: '#2962ff', whiteSpace: 'nowrap' }}>
          {activeCount}/{ALL_STRATEGY_NUMS.length}
        </Typography>
      )}
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { bgcolor: '#1e1e1e', border: '1px solid #2b2b43', p: 1.5, minWidth: 220 } } }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: '#d1d4dc' }}>
            Strategies
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Button size="small" onClick={handleAll} sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, px: 1 }}>
              All
            </Button>
            <Button size="small" onClick={handleNone} sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, px: 1 }}>
              None
            </Button>
          </Box>
        </Box>
        <Divider sx={{ borderColor: '#2b2b43', mb: 0.5 }} />
        {ALL_STRATEGY_NUMS.map((num) => (
          <FormControlLabel
            key={num}
            control={
              <Checkbox
                size="small"
                checked={enabled[num] !== false}
                onChange={() => handleToggle(num)}
                sx={{ p: 0.5 }}
              />
            }
            label={STRATEGY_LABELS[num]}
            sx={{
              display: 'flex',
              mx: 0,
              '& .MuiFormControlLabel-label': {
                fontSize: 12,
                color: enabled[num] !== false ? '#d1d4dc' : '#787b86',
              },
            }}
          />
        ))}
      </Popover>
    </>
  );
}
