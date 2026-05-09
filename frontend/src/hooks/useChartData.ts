/**
 * Hook for fetching and managing chart data
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useChartStore } from '@/store/chartStore';
import { fetchHistoricalData } from '@/services/api/marketData';

export function useChartData() {
  const { symbol, interval, selectedContract, useRth, setBars, setLoading, setError } =
    useChartStore();
  const barsCount = interval === '15m' || interval === '1m' ? 1000 : 500;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [
      'historical-data',
      symbol,
      interval,
      selectedContract?.conId ?? null,
      useRth,
    ],
    queryFn: () =>
      fetchHistoricalData(
        symbol,
        interval,
        barsCount,
        selectedContract?.conId,
        selectedContract
          ? {
              secType: selectedContract.secType,
              exchange: selectedContract.exchange,
              currency: 'USD',
            }
          : undefined,
        useRth
      ),
    staleTime: 60000, // 1 minute
    retry: 2,
    enabled: !!symbol && !!interval,
  });

  // Update store when data changes
  useEffect(() => {
    if (data?.bars) {
      setBars(data.bars);
    }
  }, [data, setBars]);

  // Update loading state
  useEffect(() => {
    setLoading(isLoading);
  }, [isLoading, setLoading]);

  // Update error state
  useEffect(() => {
    if (error) {
      setError(error instanceof Error ? error.message : 'Failed to fetch data');
    } else {
      setError(null);
    }
  }, [error, setError]);

  return {
    data,
    isLoading,
    error,
    refetch,
  };
}
