/**
 * Signal Details Popup
 *
 * Compact horizontal floating window showing details of a clicked signal marker.
 * Positions itself above or below the marker based on available screen space.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Typography, IconButton, Chip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';

interface SignalDetailsPopupProps {
  signal: {
    id: string;
    symbol: string;
    strategyId: string;
    direction: 'CALL' | 'PUT';
    entryTime: number;
    anchorTime?: number | null;
    chopFiltered?: boolean;
    chopReason?: string | null;
    adx?: number | null;
    diGap?: number | null;
  } | null;
  clickPosition: { x: number; y: number } | null;
  onClose: () => void;
}

// Strategy name mapping
const getStrategyName = (strategyId: string): string => {
  const nameMap: Record<string, string> = {
    'strategy-1': 'Gap Fill & MA Bounce',
    'strategy-2': 'Oversold RSI Recovery',
    'strategy-3': 'Opening Range Breakout',
    'strategy-5': 'Pre-Market Momentum',
    'strategy-7': 'VWAP Bounce',
    'strategy-8': 'Extended Hours Gap',
    'strategy-9': 'Power Hour Momentum',
    'strategy2_midline_bounce_1d_1h_15m': 'Midline Bounce (Multi-TF)',
    'strategy3_gap_fill_am': 'Morning Gap Fill',
    'strategy5_premarket_momentum': 'Pre-Market Momentum',
    'strategy7_0dte_scalper': '0DTE Scalper',
    'strategy7_vwap_bounce': 'VWAP Support/Resistance',
    'strategy8_0dte_momentum': '0DTE Momentum Rider',
    'strategy8_extended_hours_gap': 'Extended Hours Gap',
    'strategy9_0dte_gap_fade': '0DTE Gap Fade',
    'strategy9_power_hour': 'Power Hour Setup',
    'strategy10_0dte_trend': '0DTE Trend Following',
    'strategy11_ict_price_action': 'ICT Price Action (Liq Sweep + MSS + FVG)',
  };
  return nameMap[strategyId] || strategyId;
};

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

const POPUP_GAP = 12; // gap between marker and popup

export function SignalDetailsPopup({ signal, clickPosition, onClose }: SignalDetailsPopupProps) {
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hasPositioned, setHasPositioned] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const popupRef = useRef<HTMLDivElement>(null);

  // Position the popup when signal/clickPosition changes
  useEffect(() => {
    if (!signal || !clickPosition) {
      setHasPositioned(false);
      return;
    }

    // Wait a frame so the popup is rendered and we can measure it
    requestAnimationFrame(() => {
      if (!popupRef.current) return;

      const popupRect = popupRef.current.getBoundingClientRect();
      const popupHeight = popupRect.height;
      const popupWidth = popupRect.width;

      const spaceAbove = clickPosition.y;
      const spaceBelow = window.innerHeight - clickPosition.y;

      // Center horizontally on the click point, clamped to screen edges
      let x = clickPosition.x - popupWidth / 2;
      x = Math.max(8, Math.min(x, window.innerWidth - popupWidth - 8));

      let y: number;
      if (spaceBelow >= popupHeight + POPUP_GAP + 40) {
        // Place below
        y = clickPosition.y + POPUP_GAP;
      } else if (spaceAbove >= popupHeight + POPUP_GAP + 40) {
        // Place above
        y = clickPosition.y - popupHeight - POPUP_GAP;
      } else {
        // Not enough space either way — place wherever has more room
        y = spaceBelow > spaceAbove
          ? clickPosition.y + POPUP_GAP
          : clickPosition.y - popupHeight - POPUP_GAP;
      }

      // Clamp to viewport
      y = Math.max(8, Math.min(y, window.innerHeight - popupHeight - 8));

      setPosition({ x, y });
      setHasPositioned(true);
    });
  }, [signal?.id, clickPosition]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  }, [position]);

  if (!signal) return null;

  const isCall = signal.direction === 'CALL';
  const accentColor = isCall ? '#39d98a' : '#ff6b6b';

  return (
    <Box
      ref={popupRef}
      sx={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: 'auto',
        backgroundColor: '#1e1e1e',
        border: '1px solid #2b2b43',
        borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
        zIndex: 1000,
        overflow: 'hidden',
        cursor: isDragging ? 'grabbing' : 'default',
        userSelect: 'none',
        opacity: hasPositioned ? 1 : 0,
        transition: 'opacity 0.1s',
      }}
    >
      {/* Header - drag handle */}
      <Box
        onMouseDown={handleMouseDown}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 0.75,
          backgroundColor: isCall ? 'rgba(57, 217, 138, 0.08)' : 'rgba(255, 107, 107, 0.08)',
          borderBottom: `2px solid ${accentColor}`,
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <DragIndicatorIcon sx={{ color: '#787b86', fontSize: 16 }} />
          <Chip
            size="small"
            label={signal.direction}
            icon={isCall ? <TrendingUpIcon /> : <TrendingDownIcon />}
            sx={{
              height: 24,
              backgroundColor: isCall ? 'rgba(57, 217, 138, 0.2)' : 'rgba(255, 107, 107, 0.2)',
              color: accentColor,
              fontWeight: 700,
              fontSize: 12,
              '& .MuiChip-icon': { color: accentColor, fontSize: 16 },
              '& .MuiChip-label': { px: 0.75 },
            }}
          />
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: '#d1d4dc' }}>
            {signal.symbol}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          sx={{
            color: '#787b86',
            p: 0.5,
            ml: 1.5,
            '&:hover': { color: '#d1d4dc', backgroundColor: 'rgba(255, 255, 255, 0.05)' },
          }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Content */}
      <Box sx={{ px: 2, py: 1.25 }}>
        {/* Strategy name */}
        <Typography sx={{ fontSize: 12, color: '#787b86', mb: 1 }}>
          {getStrategyName(signal.strategyId)}
        </Typography>

        {/* Times - horizontal */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <Box>
            <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Entry
            </Typography>
            <Typography sx={{ fontSize: 14, color: '#d1d4dc', fontWeight: 500, whiteSpace: 'nowrap' }}>
              {formatTime(signal.entryTime)}
            </Typography>
          </Box>

          {signal.anchorTime && (
            <Box>
              <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                Anchor
              </Typography>
              <Typography sx={{ fontSize: 14, color: '#d1d4dc', fontWeight: 500, whiteSpace: 'nowrap' }}>
                {formatTime(signal.anchorTime)}
              </Typography>
            </Box>
          )}

          {signal.adx != null && (
            <Box>
              <Typography sx={{ fontSize: 10, color: '#787b86', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                ADX / DI Gap
              </Typography>
              <Typography sx={{ fontSize: 14, color: '#d1d4dc', fontWeight: 500, whiteSpace: 'nowrap' }}>
                {signal.adx} / {signal.diGap}
              </Typography>
            </Box>
          )}
        </Box>

        {signal.chopFiltered && (
          <Chip
            size="small"
            label={signal.chopReason === 'di_gap' ? 'Chop: DI gap too narrow' : 'Chop: ADX too low'}
            sx={{
              mt: 1,
              height: 22,
              backgroundColor: 'rgba(255, 152, 0, 0.15)',
              color: '#ffb74d',
              fontWeight: 600,
              fontSize: 11,
            }}
          />
        )}
      </Box>
    </Box>
  );
}
