/** Exact money helpers for the pricing UI. All arithmetic is BigInt; money is never a float. */
export const PRICE_RE = /^\d+(\.\d{1,6})?$/;
export const TOKEN_RE = /^\d+$/;

/** "0.150000" -> micro-USD per MTok (1e-6 USD) as BigInt. Throws on invalid input. */
export function priceToMicro(p: string): bigint {
  if (!PRICE_RE.test(p)) throw new Error(`invalid price: ${p}`);
  const [w, f = ''] = p.split('.');
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'));
}

/**
 * cost(USD) = tokens * (price/MTok) / 1e6 = tokens * micro / 1e12  ->  exactly `tokens * micro` pico-USD.
 * (No rounding needed for prices with <= 6 fraction digits.)
 */
export const costPico = (tokens: number, microPrice: bigint): bigint => BigInt(tokens) * microPrice;

/** 12-dp decimal string -> pico-USD BigInt. */
export function usdToPico(usd: string): bigint {
  const neg = usd.startsWith('-');
  const [w, f = ''] = (neg ? usd.slice(1) : usd).split('.');
  const v = BigInt(w || '0') * 1_000_000_000_000n + BigInt(f.padEnd(12, '0').slice(0, 12));
  return neg ? -v : v;
}

/** pico-USD BigInt -> 12-dp decimal string. */
export function picoToUsd(p: bigint): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const w = a / 1_000_000_000_000n;
  const f = (a % 1_000_000_000_000n).toString().padStart(12, '0');
  return `${neg ? '-' : ''}${w}.${f}`;
}

/** Percentage (2 dp) that `value` is above `base`, using integer math. null when base is 0. */
export function pctAbove(value: bigint, base: bigint): number | null {
  if (base === 0n) return null;
  return Number(((value - base) * 10000n) / base) / 100;
}

export interface TokenCounts { input: number; output: number; cached: number }

export interface TokenFieldValues { input: string; output: string; cached: string }
/** Validates token text fields. Returns counts or per-field error messages. */
export function validateTokens(v: TokenFieldValues): { ok: true; value: TokenCounts } | { ok: false; errors: Partial<Record<keyof TokenFieldValues, string>> } {
  const errors: Partial<Record<keyof TokenFieldValues, string>> = {};
  const parse = (k: keyof TokenFieldValues, required: boolean): number => {
    const s = v[k].trim();
    if (s === '') { if (required) errors[k] = 'Required.'; return 0; }
    if (!TOKEN_RE.test(s)) { errors[k] = 'Must be a non-negative whole number.'; return 0; }
    const n = Number(s);
    if (!Number.isSafeInteger(n)) { errors[k] = 'Number is too large.'; return 0; }
    return n;
  };
  const value = { input: parse('input', true), output: parse('output', true), cached: parse('cached', false) };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** datetime-local value ("2024-06-01T10:30", interpreted in the browser's local zone) -> ISO, or undefined if blank/invalid. */
export function localToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
