/**
 * Main dashboard layout - full viewport
 */
import { Box, CircularProgress, Alert } from '@mui/material';
import { ChartToolbar } from '@/components/chart/ChartToolbar';
import { LightweightChart } from '@/components/chart/LightweightChart';
import { useChartData } from '@/hooks/useChartData';
import { useChartStore } from '@/store/chartStore';
import { StrategyPanel } from '@/components/strategy/StrategyPanel';
import { OptionsPanel } from '@/components/options/OptionsPanel';

export function DashboardLayout({ onBack }: { onBack?: () => void }) {
  useChartData(); // Fetch data
  const {
    loading,
    error,
    strategyPanelOpen,
    selectedSignalId,
    isAnalyzing,
    strategyPanelWidth,
    optionsPanelOpen,
    optionsPanelWidth,
  } = useChartStore();
  const showStrategyPanel =
    strategyPanelOpen || Boolean(selectedSignalId) || isAnalyzing;
  const showOptionsPanel = optionsPanelOpen;

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#131722',
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: showStrategyPanel
          ? showOptionsPanel
            ? `1fr ${strategyPanelWidth}px ${optionsPanelWidth}px`
            : `1fr ${strategyPanelWidth}px 0px`
          : showOptionsPanel
            ? `1fr 0px ${optionsPanelWidth}px`
            : '1fr 0px 0px',
        transition: 'grid-template-columns 250ms ease',
      }}
    >
      <Box
        sx={{
          height: '100%',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 1001,
          }}
        >
          <ChartToolbar onBack={onBack} />
        </Box>

        {loading && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1000,
            }}
          >
            <CircularProgress />
          </Box>
        )}

        {error && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1000,
              minWidth: '300px',
            }}
          >
            <Alert severity="error">{error}</Alert>
          </Box>
        )}

        {!loading && !error && <LightweightChart />}
      </Box>
      <Box
        sx={{
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <StrategyPanel open={showStrategyPanel} />
      </Box>
      <Box
        sx={{
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <OptionsPanel open={showOptionsPanel} />
      </Box>
    </Box>
  );
}
