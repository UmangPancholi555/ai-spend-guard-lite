/** Money arrives as 12-dp decimal strings. Format without converting to float arithmetic. */
export function fmtUsd(usd: string | undefined | null, maxFrac = 6): string {
  if (usd === undefined || usd === null) return '-';
  const [w, f = ''] = usd.split('.');
  let frac = f.slice(0, maxFrac).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `$${Number(w).toLocaleString('en-US')}.${frac}`;
}
export const fmtInt = (n: number | undefined | null) => (n === undefined || n === null ? '-' : n.toLocaleString('en-US'));
export const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;
export const fmtMs = (n: number | null | undefined) => (n === null || n === undefined ? '-' : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : '-');
/** USD string -> number for charts ONLY (display); never for accounting. */
export const usdToChartNumber = (usd: string) => Number(usd);
