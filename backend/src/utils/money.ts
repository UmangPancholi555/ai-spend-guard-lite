/**
 * Decimal-safe money helpers. Money = BigInt pico-USD (1 USD = 1e12 pico). No floats anywhere.
 * Prices are decimal strings: USD per 1,000,000 tokens with up to 6 fraction digits.
 *   priceMicro = price * 1e6 (integer)
 *   costUsd    = tokens * price / 1e6 = tokens * priceMicro / 1e12  =>  costPico = tokens * priceMicro (exact!)
 */
export const PICO_PER_USD = 1_000_000_000_000n;
const PRICE_RE = /^\d+(\.\d{1,6})?$/;
const USD_RE = /^\d+(\.\d{1,12})?$/;

/** "2.50" -> 2_500_000n (micro-USD per MTok). Throws on invalid input. */
export function parsePriceToMicro(price: string): bigint {
  if (!PRICE_RE.test(price)) throw new Error(`Invalid price "${price}": expected decimal with <= 6 fraction digits`);
  const [whole, frac = ''] = price.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** exact cost for token count at price (micro-USD per MTok) in pico-USD */
export function tokenCostPico(tokens: number, priceMicroPerMTok: bigint): bigint {
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error(`Invalid token count ${tokens}`);
  return BigInt(tokens) * priceMicroPerMTok;
}

/** pico-USD -> "0.000123450000" (always 12 fraction digits) */
export function picoToUsd(pico: bigint): string {
  const neg = pico < 0n;
  const abs = neg ? -pico : pico;
  const whole = abs / PICO_PER_USD;
  const frac = (abs % PICO_PER_USD).toString().padStart(12, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** "12.5" | "0.000001" -> pico. Throws on invalid input (max 12 fraction digits). */
export function usdToPico(usd: string): bigint {
  if (!USD_RE.test(usd)) throw new Error(`Invalid USD amount "${usd}": expected non-negative decimal with <= 12 fraction digits`);
  const [whole, frac = ''] = usd.split('.');
  return BigInt(whole) * PICO_PER_USD + BigInt(frac.padEnd(12, '0'));
}

/** percent with 2 decimals computed with integer math: spend/limit*100 */
export function percentOf(spend: bigint, limit: bigint): number {
  if (limit <= 0n) return 0;
  return Number((spend * 10000n) / limit) / 100;
}
