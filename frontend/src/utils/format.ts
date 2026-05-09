/** Format a dollar amount: $1,234.56 (no sign, null-safe) */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a P&L value: +$1,234.56 or -$1,234.56 (with sign, null-safe) */
export function fmtPnl(v: number | null | undefined): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '-';
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a plain number with thousands + 2 decimals: 1,234.56 (no $ prefix) */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
