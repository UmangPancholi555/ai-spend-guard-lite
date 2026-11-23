/** Deterministic PRNG helpers. No Math.random anywhere in the providers module. */
import { sha256 } from '../../../utils/ids';

export type Rng = () => number;

/** mulberry32: small, fast, well-distributed 32-bit seeded PRNG returning floats in [0,1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** first 32 bits of a hex digest as an unsigned int */
export const seedFromHex = (hex: string): number => parseInt(hex.slice(0, 8), 16) >>> 0;
/** sha256(s) -> uint32 seed */
export const seedFromString = (s: string): number => seedFromHex(sha256(s));

export const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

/** weighted pick; weights need not sum to 1 */
export function pickWeighted<T>(rng: Rng, items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const i of items) {
    r -= i.weight;
    if (r < 0) return i.value;
  }
  return items[items.length - 1]!.value;
}

/** deterministic lorem-style text of exactly `chars` characters (no prompt content is ever echoed) */
const WORDS = (
  'alpha budget cache context cost dashboard deploy digest engine estimate forecast gateway handler index ' +
  'journal kernel latency metric model notify observe pipeline quota report request response sample schedule ' +
  'signal token trace update usage vector window workflow summary insight analysis result simulated demo mock ' +
  'deterministic provider throughput threshold baseline anomaly forecast review budgeted prompt output input ' +
  'queue retry timeout limit allocation spend savings optimize pattern segment cluster ratio balance'
).split(' ');

export function fillerText(rng: Rng, chars: number): string {
  if (chars <= 0) return '';
  let out = '';
  let sentenceLen = 0;
  let sentenceTarget = randInt(rng, 6, 14);
  let startOfSentence = true;
  while (out.length < chars) {
    let w = WORDS[Math.floor(rng() * WORDS.length)] as string;
    if (startOfSentence) w = w.charAt(0).toUpperCase() + w.slice(1);
    out += w;
    sentenceLen++;
    startOfSentence = false;
    if (sentenceLen >= sentenceTarget) {
      out += '. ';
      sentenceLen = 0;
      sentenceTarget = randInt(rng, 6, 14);
      startOfSentence = true;
    } else {
      out += ' ';
    }
  }
  return out.slice(0, chars);
}
