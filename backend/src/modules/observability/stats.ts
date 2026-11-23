/** Small numeric helpers. All return 0 (never NaN) for empty input. */
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function avg(nums: number[]): number {
  if (!nums.length) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return round2(s / nums.length);
}

/** nearest-rank percentile: the smallest value with at least p% of the samples <= it. e.g. 1..100 -> p95 = 95 */
export function percentile(nums: number[], p: number): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export const max = (nums: number[]) => (nums.length ? Math.max(...nums) : 0);
export const rate = (part: number, total: number) => (total > 0 ? round4(part / total) : 0);
