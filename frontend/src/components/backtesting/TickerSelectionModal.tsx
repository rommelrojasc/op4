/**
 * Ticker Selection Modal
 *
 * Shows a grid of company cards with logos for ticker selection
 */
import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  InputAdornment,
  Avatar,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { SYMBOLS, SYMBOL_NAMES } from '@/constants/symbols';

interface TickerSelectionModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (symbol: string) => void;
  selectedSymbol: string;
}

// Logo sources to try in order
const getLogoUrls = (symbol: string): string[] => {
  return [
    // Yahoo Finance (most reliable)
    `https://logo.clearbit.com/${getCompanyDomain(symbol)}`,
    // Alternative source
    `https://assets.financialmodelingprep.com/image-logo/${symbol}.png`,
    // Another fallback
    `https://eodhistoricaldata.com/img/logos/US/${symbol}.png`,
  ];
};

// Map symbols to their company domains for logo API
const getCompanyDomain = (symbol: string): string => {
  const domainMap: Record<string, string> = {
    AMZN: 'amazon.com',
    AAPL: 'apple.com',
    GOOG: 'google.com',
    META: 'meta.com',
    MSFT: 'microsoft.com',
    NFLX: 'netflix.com',
    TSLA: 'tesla.com',
    PLTR: 'palantir.com',
    ORCL: 'oracle.com',
    AMD: 'amd.com',
    MU: 'micron.com',
    NVDA: 'nvidia.com',
    QCOM: 'qualcomm.com',
    AVGO: 'broadcom.com',
    DASH: 'doordash.com',
    LYFT: 'lyft.com',
    UBER: 'uber.com',
    HD: 'homedepot.com',
    LOW: 'lowes.com',
    WMT: 'walmart.com',
    AXP: 'americanexpress.com',
    C: 'citigroup.com',
    MA: 'mastercard.com',
    PYPL: 'paypal.com',
    V: 'visa.com',
    BABA: 'alibaba.com',
    LI: 'lixiang.com',
    NIO: 'nio.com',
    XPEV: 'xiaopeng.com',
    COIN: 'coinbase.com',
    HOOD: 'robinhood.com',
    CVS: 'cvs.com',
    MRNA: 'modernatx.com',
    PFE: 'pfizer.com',
    BA: 'boeing.com',
  };
  return domainMap[symbol] || `${symbol.toLowerCase()}.com`;
};

// Generate color based on symbol for fallback avatar
const getSymbolColor = (symbol: string) => {
  const colors = [
    '#1976d2', '#d32f2f', '#388e3c', '#f57c00', '#7b1fa2',
    '#0288d1', '#c2185b', '#5d4037', '#455a64', '#00796b',
  ];
  const hash = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
};

// Component that tries multiple logo sources
export function CompanyLogo({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const [urlIndex, setUrlIndex] = useState(0);
  const [showFallback, setShowFallback] = useState(false);

  const urls = getLogoUrls(symbol);

  const handleError = () => {
    if (urlIndex < urls.length - 1) {
      setUrlIndex(prev => prev + 1);
    } else {
      setShowFallback(true);
    }
  };

  if (showFallback) {
    return (
      <Avatar
        sx={{
          width: size,
          height: size,
          backgroundColor: getSymbolColor(symbol),
          fontSize: size * 0.4,
          fontWeight: 600,
        }}
      >
        {symbol.charAt(0)}
      </Avatar>
    );
  }

  return (
    <Avatar
      src={urls[urlIndex]}
      alt={symbol}
      onError={handleError}
      sx={{
        width: size,
        height: size,
        backgroundColor: '#fff',
      }}
    >
      {symbol.charAt(0)}
    </Avatar>
  );
}

export function TickerSelectionModal({ open, onClose, onSelect, selectedSymbol }: TickerSelectionModalProps) {
  const [search, setSearch] = useState('');

  const filteredSymbols = SYMBOLS.filter(symbol => {
    const searchLower = search.toLowerCase();
    return (
      symbol.toLowerCase().includes(searchLower) ||
      SYMBOL_NAMES[symbol]?.toLowerCase().includes(searchLower)
    );
  });

  const handleSelect = (symbol: string) => {
    onSelect(symbol);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          backgroundColor: '#1e1e1e',
          border: '1px solid #2b2b43',
          minHeight: '600px',
        },
      }}
    >
      <DialogTitle sx={{ fontSize: 18, fontWeight: 600, pb: 2 }}>
        Select Ticker
      </DialogTitle>

      <Box sx={{ px: 3, pb: 2 }}>
        <TextField
          fullWidth
          placeholder="Search by symbol or company name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
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
      </Box>

      <DialogContent sx={{ pt: 0 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 1.5,
            pb: 2,
          }}
        >
          {filteredSymbols.map((symbol) => {
            const isSelected = symbol === selectedSymbol;

            return (
              <Box
                key={symbol}
                onClick={() => handleSelect(symbol)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  padding: 1.5,
                  borderRadius: '8px',
                  border: isSelected ? '2px solid #2962ff' : '1px solid #2b2b43',
                  backgroundColor: isSelected ? 'rgba(41, 98, 255, 0.1)' : '#131722',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': {
                    borderColor: isSelected ? '#2962ff' : '#4b4b63',
                    backgroundColor: isSelected ? 'rgba(41, 98, 255, 0.15)' : '#1a1a2e',
                  },
                }}
              >
                {/* Logo with multiple fallbacks */}
                <CompanyLogo symbol={symbol} />

                {/* Symbol and name */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#d1d4dc',
                      lineHeight: 1.2,
                    }}
                  >
                    {symbol}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: 11,
                      color: '#787b86',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {SYMBOL_NAMES[symbol]}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>

        {filteredSymbols.length === 0 && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              py: 8,
            }}
          >
            <Typography sx={{ color: '#787b86', fontSize: 14 }}>
              No tickers found matching "{search}"
            </Typography>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
