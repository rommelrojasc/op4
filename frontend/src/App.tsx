/**
 * Main App component
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  Box,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Radio,
  RadioGroup,
  FormControlLabel,
  FormControl,
  Divider,
  Tooltip,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import { useQuery } from '@tanstack/react-query';
import { checkHealth } from '@/services/api/marketData';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { OverviewPage } from '@/components/overview/OverviewPage';
import { TradingDashboard } from '@/components/overview/TradingDashboard';
import { StrategiesView } from '@/components/overview/StrategiesView';
import { BacktestingView } from '@/components/backtesting/BacktestingView';
import { ZeroDteTool } from '@/components/zerodte/ZeroDteTool';
import { useChartStore } from '@/store/chartStore';

// Create React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// ─── Theme presets ────────────────────────────────────────────────────────────

type ThemePreset = 'default' | 'carbon-g100' | 'carbon-g90';

interface ThemeTokens {
  bgDefault: string;
  bgPaper: string;
  bgNav: string;
  border: string;
  primary: string;
  textPrimary: string;
  textSecondary: string;
}

const THEME_TOKENS: Record<ThemePreset, ThemeTokens> = {
  'default': {
    bgDefault: '#131722',
    bgPaper: '#1e1e1e',
    bgNav: '#0c111a',
    border: '#2b2b43',
    primary: '#2962ff',
    textPrimary: '#d1d4dc',
    textSecondary: '#787b86',
  },
  'carbon-g100': {
    bgDefault: '#161616',
    bgPaper: '#262626',
    bgNav: '#161616',
    border: '#393939',
    primary: '#0f62fe',
    textPrimary: '#f4f4f4',
    textSecondary: '#8d8d8d',
  },
  'carbon-g90': {
    bgDefault: '#262626',
    bgPaper: '#353535',
    bgNav: '#1c1c1c',
    border: '#525252',
    primary: '#0f62fe',
    textPrimary: '#f4f4f4',
    textSecondary: '#8d8d8d',
  },
};

const PRESET_LABELS: Record<ThemePreset, string> = {
  'default': 'Default',
  'carbon-g100': 'Carbon g100',
  'carbon-g90': 'Carbon g90',
};

function buildTheme(preset: ThemePreset) {
  const t = THEME_TOKENS[preset];
  return createTheme({
    typography: {
      fontFamily: '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    palette: {
      mode: 'dark',
      primary: { main: t.primary },
      background: { default: t.bgDefault, paper: t.bgPaper },
      text: { primary: t.textPrimary, secondary: t.textSecondary },
      divider: t.border,
    },
  });
}

function loadPreset(): ThemePreset {
  const stored = localStorage.getItem('themePreset');
  if (stored === 'carbon-g100' || stored === 'carbon-g90') return stored;
  return 'default';
}

// ─── IB Gateway dot (must be inside QueryClientProvider) ──────────────────────

function IbGatewayDot() {
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: checkHealth, refetchInterval: 30000, staleTime: 10000 });
  return (
    <Tooltip
      title={
        healthQuery.isLoading
          ? 'IB Gateway: checking…'
          : healthQuery.isError
            ? 'IB Gateway: unavailable'
            : `IB Gateway: ${healthQuery.data?.ib_connected ? 'connected' : 'disconnected'}${healthQuery.data?.message ? ` — ${healthQuery.data.message}` : ''}`
      }
    >
      <FiberManualRecordIcon
        fontSize="small"
        sx={{
          cursor: 'default',
          color: healthQuery.isLoading
            ? '#7c8190'
            : healthQuery.isError
              ? '#ef5350'
              : healthQuery.data?.ib_connected
                ? '#39d98a'
                : '#f5a623',
        }}
      />
    </Tooltip>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [view, setView] = useState<'overview' | 'dashboard'>('overview');
  const [activeTab, setActiveTab] = useState<'trading' | 'research' | 'strategies' | 'backtesting' | 'zerodte'>('trading');
  const [preset, setPreset] = useState<ThemePreset>(loadPreset);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<ThemePreset>(preset);
  const { setSymbol, setSelectedContract } = useChartStore();

  const theme = buildTheme(preset);
  const t = THEME_TOKENS[preset];

  function openSettings() {
    setPendingPreset(preset);
    setSettingsOpen(true);
  }

  function applySettings() {
    setPreset(pendingPreset);
    localStorage.setItem('themePreset', pendingPreset);
    setSettingsOpen(false);
  }

  function tabSx(tab: string) {
    const active = activeTab === tab;
    return {
      color: active ? t.textPrimary : t.textSecondary,
      textTransform: 'none' as const,
      fontWeight: active ? 600 : 400,
      fontSize: 13,
      paddingX: 2,
      paddingY: 1.25,
      borderRadius: 0,
      borderBottom: active ? `2px solid ${t.primary}` : '2px solid transparent',
      '&:hover': { color: t.textPrimary, backgroundColor: 'transparent' },
      minWidth: 0,
    };
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
          {view === 'overview' && (
            <>
              {/* Tab bar */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 14px',
                  borderBottom: `1px solid ${t.border}`,
                  backgroundColor: t.bgNav,
                  flexShrink: 0,
                  gap: 0,
                }}
              >
                <Button onClick={() => setActiveTab('trading')} disableRipple sx={tabSx('trading')}>
                  Trading
                </Button>
                <Button onClick={() => setActiveTab('research')} disableRipple sx={tabSx('research')}>
                  Research
                </Button>
                <Button onClick={() => setActiveTab('strategies')} disableRipple sx={tabSx('strategies')}>
                  Strategies
                </Button>
                <Button onClick={() => setActiveTab('backtesting')} disableRipple sx={tabSx('backtesting')}>
                  Backtesting
                </Button>
                <Button onClick={() => setActiveTab('zerodte')} disableRipple sx={tabSx('zerodte')}>
                  0DTE
                </Button>

                {/* Spacer */}
                <Box sx={{ flex: 1 }} />

                {/* IB Gateway dot + Settings gear */}
                <IbGatewayDot />
                <IconButton
                  onClick={openSettings}
                  size="small"
                  sx={{ color: t.textSecondary, '&:hover': { color: t.textPrimary } }}
                >
                  <SettingsIcon fontSize="small" />
                </IconButton>
              </Box>

              {/* Tab content */}
              <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {activeTab === 'trading' && <TradingDashboard />}
                {activeTab === 'strategies' && (
                  <Box sx={{ flex: 1, overflowY: 'auto' }}>
                    <StrategiesView />
                  </Box>
                )}
                {activeTab === 'backtesting' && <BacktestingView />}
                {activeTab === 'zerodte' && (
                  <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ZeroDteTool />
                  </Box>
                )}
                {activeTab === 'research' && (
                  <OverviewPage
                    onSelectSymbol={(symbol) => {
                      setSymbol(symbol);
                      setView('dashboard');
                    }}
                    onSelectContract={(contract) => {
                      setSymbol(contract.symbol);
                      setSelectedContract(contract);
                      setView('dashboard');
                    }}
                  />
                )}
              </Box>
            </>
          )}
          {view === 'dashboard' && (
            <DashboardLayout onBack={() => setView('overview')} />
          )}
        </Box>

        {/* ── Settings modal ── */}
        <Dialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          PaperProps={{ sx: { minWidth: 360, backgroundColor: t.bgPaper, border: `1px solid ${t.border}` } }}
        >
          <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>Settings</DialogTitle>
          <Divider sx={{ borderColor: t.border }} />

          <DialogContent sx={{ pt: 2 }}>
            <Typography variant="caption" sx={{ color: t.textSecondary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
              Appearance
            </Typography>

            <FormControl sx={{ mt: 1.5, width: '100%' }}>
              <RadioGroup
                value={pendingPreset}
                onChange={(e) => setPendingPreset(e.target.value as ThemePreset)}
              >
                {(Object.keys(PRESET_LABELS) as ThemePreset[]).map((key) => (
                  <FormControlLabel
                    key={key}
                    value={key}
                    control={<Radio size="small" sx={{ color: t.textSecondary, '&.Mui-checked': { color: t.primary } }} />}
                    label={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Typography sx={{ fontSize: 13 }}>{PRESET_LABELS[key]}</Typography>
                        <ThemeSwatch tokens={THEME_TOKENS[key]} />
                      </Box>
                    }
                    sx={{ mb: 0.5 }}
                  />
                ))}
              </RadioGroup>
            </FormControl>
          </DialogContent>

          <Divider sx={{ borderColor: t.border }} />
          <DialogActions sx={{ px: 2, py: 1.5 }}>
            <Button onClick={() => setSettingsOpen(false)} size="small" sx={{ color: t.textSecondary, textTransform: 'none', fontSize: 13 }}>
              Cancel
            </Button>
            <Button
              onClick={applySettings}
              size="small"
              variant="contained"
              sx={{ textTransform: 'none', fontSize: 13, backgroundColor: t.primary }}
            >
              Apply
            </Button>
          </DialogActions>
        </Dialog>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// Small color swatch showing the 3 main colors of a preset
function ThemeSwatch({ tokens }: { tokens: ThemeTokens }) {
  return (
    <Box sx={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
      {[tokens.bgDefault, tokens.bgPaper, tokens.primary].map((color, i) => (
        <Box
          key={i}
          sx={{
            width: 12,
            height: 12,
            borderRadius: '2px',
            backgroundColor: color,
            border: '1px solid rgba(255,255,255,0.15)',
          }}
        />
      ))}
    </Box>
  );
}

export default App;
