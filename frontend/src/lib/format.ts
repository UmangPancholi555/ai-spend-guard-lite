/** Add 1 to a string of decimal digits, carrying left ("0999" -> "1000", "99" -> "100"). */
function incrementDigits(digits: string): string {
  const d = digits.split('');
  let i = d.length - 1;
  while (i >= 0 && d[i] === '9') d[i--] = '0';
  if (i < 0) d.unshift('1');
  else d[i] = '0123456789'[Number(d[i]) + 1];
  return d.join('');
}

/**
 * Money arrives as 12-dp decimal strings. Format without converting to float arithmetic.
 * Rounds half-up at maxFrac on the digit string (negatives: on the magnitude, i.e. half away
 * from zero), carrying into the integer part. Shows 2..maxFrac decimals, trailing zeros trimmed.
 */
export function fmtUsd(usd: string | undefined | null, maxFrac = 6): string {
  if (usd === undefined || usd === null) return '-';
  const neg = usd.startsWith('-');
  const [w, f = ''] = (neg ? usd.slice(1) : usd).split('.');
  let digits = w + f.slice(0, maxFrac).padEnd(maxFrac, '0');
  if ((f[maxFrac] ?? '0') >= '5') digits = incrementDigits(digits);
  const whole = digits.slice(0, digits.length - maxFrac);
  let frac = digits.slice(digits.length - maxFrac).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `$${Number((neg ? '-' : '') + whole).toLocaleString('en-US')}.${frac}`;
}
export const fmtInt = (n: number | undefined | null) => (n === undefined || n === null ? '-' : n.toLocaleString('en-US'));
export const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;
export const fmtMs = (n: number | null | undefined) => (n === null || n === undefined ? '-' : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : '-');
/** USD string -> number for charts ONLY (display); never for accounting. */
export const usdToChartNumber = (usd: string) => Number(usd);
