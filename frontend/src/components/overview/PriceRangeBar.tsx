import React from 'react';

interface PriceRangeBarProps {
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  currentPremium: number;
  highWaterMark?: number;
  trailStopPrice?: number;
  width?: number;
  height?: number;
}

const PriceRangeBar: React.FC<PriceRangeBarProps> = ({
  entryPrice,
  targetPrice,
  stopLossPrice,
  currentPremium,
  highWaterMark,
  trailStopPrice,
  width = 200,
  height = 28,
}) => {
  const pad = 4;
  const barY = 6;
  const barH = 8;
  const barW = width - pad * 2;

  // Range: ensure current price, SL, TP, and HWM are all visible
  const rangeMin = Math.min(stopLossPrice, currentPremium * 0.95);
  const rangeMax = Math.max(targetPrice, currentPremium * 1.05, highWaterMark ?? 0);
  const range = rangeMax - rangeMin || 1;

  const toX = (price: number) => pad + ((price - rangeMin) / range) * barW;

  const slX = toX(stopLossPrice);
  const entryX = toX(entryPrice);
  const tpX = toX(targetPrice);
  const curX = toX(currentPremium);
  const hwmX = highWaterMark != null ? toX(highWaterMark) : null;
  const trailX = trailStopPrice != null ? toX(trailStopPrice) : null;

  const isProfit = currentPremium >= entryPrice;
  const atTarget = currentPremium >= targetPrice;
  const dotColor = atTarget ? '#39d98a' : isProfit ? '#39d98a' : '#ff6b6b';

  const fmtPrice = (p: number) => p < 0.1 ? p.toFixed(3) : p.toFixed(2);
  const labelY = barY + barH + 10;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Background bar */}
      <rect x={pad} y={barY} width={barW} height={barH} rx={2} fill="#1e2030" />

      {/* Red zone: SL to Entry */}
      <rect
        x={slX}
        y={barY}
        width={Math.max(0, entryX - slX)}
        height={barH}
        rx={2}
        fill="rgba(255,107,107,0.2)"
      />

      {/* Green/red fill from entry to current */}
      {isProfit ? (
        <rect
          x={entryX}
          y={barY}
          width={Math.max(0, Math.min(curX, tpX) - entryX)}
          height={barH}
          rx={2}
          fill="rgba(57,217,138,0.25)"
        />
      ) : (
        <rect
          x={curX}
          y={barY}
          width={Math.max(0, entryX - curX)}
          height={barH}
          rx={2}
          fill="rgba(255,107,107,0.3)"
        />
      )}

      {/* SL marker */}
      <line x1={slX} y1={barY - 1} x2={slX} y2={barY + barH + 1} stroke="#ff6b6b" strokeWidth={1} opacity={0.7} />

      {/* Entry marker */}
      <line x1={entryX} y1={barY - 1} x2={entryX} y2={barY + barH + 1} stroke="#ffffff" strokeWidth={1} opacity={0.5} />

      {/* TP marker */}
      <line x1={tpX} y1={barY - 1} x2={tpX} y2={barY + barH + 1} stroke="#39d98a" strokeWidth={1} opacity={0.7} />

      {/* Trail stop dashed line */}
      {trailX != null && (
        <line
          x1={trailX} y1={barY - 2} x2={trailX} y2={barY + barH + 2}
          stroke="#f5a623" strokeWidth={1} strokeDasharray="2,2" opacity={0.8}
        />
      )}

      {/* HWM triangle marker */}
      {hwmX != null && highWaterMark != null && highWaterMark > entryPrice && (
        <polygon
          points={`${hwmX - 3},${barY - 2} ${hwmX + 3},${barY - 2} ${hwmX},${barY - 5}`}
          fill="#f5a623"
          opacity={0.8}
        />
      )}

      {/* Current price dot with glow */}
      {atTarget && (
        <circle cx={curX} cy={barY + barH / 2} r={5} fill={dotColor} opacity={0.2} />
      )}
      <circle cx={curX} cy={barY + barH / 2} r={3} fill={dotColor} />

      {/* Labels */}
      <text x={slX} y={labelY} textAnchor="start" fontSize={7} fill="#ff6b6b" opacity={0.6}>
        {fmtPrice(stopLossPrice)}
      </text>
      <text x={entryX} y={labelY} textAnchor="middle" fontSize={7} fill="#9aa0a6" opacity={0.7}>
        {fmtPrice(entryPrice)}
      </text>
      <text x={curX} y={labelY} textAnchor="middle" fontSize={7} fill={dotColor} fontWeight={600}>
        {fmtPrice(currentPremium)}
      </text>
      <text x={tpX} y={labelY} textAnchor="end" fontSize={7} fill="#39d98a" opacity={0.6}>
        {fmtPrice(targetPrice)}
      </text>
    </svg>
  );
};

export default PriceRangeBar;
