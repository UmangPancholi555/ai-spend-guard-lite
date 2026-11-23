import { performance } from 'node:perf_hooks';

/**
 * Monotonic event clock anchored at `anchor` (the trace start). Events stamped with it always fall inside
 * [trace start, trace end] - also for backdated traces. Call once right after the trace starts.
 */
export function makeClock(anchor: Date): () => Date {
  const perf0 = performance.now();
  return () => new Date(anchor.getTime() + Math.floor(performance.now() - perf0));
}
