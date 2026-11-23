/** JSON.stringify that supports BigInt (-> string). Use for any DB JSON columns / JSONL. */
export function safeStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
}
export function parseJson<T = Record<string, unknown>>(s: string | null | undefined, fallback: T = {} as T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
