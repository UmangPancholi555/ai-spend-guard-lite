import type { AppDeps } from '../../contracts/services';
import { runRetentionSweep } from './retention';
import { getSettings } from './settings';

export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FIRST_RUN_DELAY_MS = 60_000;

export interface RetentionSchedulerOptions {
  /** Delay between the END of one run and the start of the next (default 6h). The next run is armed only after the previous finished. */
  intervalMs?: number;
  /** Delay before the first run (default 60s). */
  firstDelayMs?: number;
  /** Injectable clock used to compute the retention cutoff. */
  now?: () => Date;
}
export interface RetentionScheduler {
  stop(): void;
  /** Run one scheduled-style sweep immediately (no-op when one is already running). Resolves when finished; never rejects. */
  runNow(): Promise<void>;
}

/**
 * Periodic retention sweep. Each run is an ACTUAL BackgroundTask (RETENTION_SWEEP, result.trigger = 'scheduled'). The loop is a
 * self-rescheduling unref'd timer chain, so runs can never overlap and an unref'd timer never keeps the process alive.
 * A run is skipped (no task row) when retentionDays = 0 (keep forever). Failures are recorded as FAILED tasks by the sweep itself,
 * logged to console, and scheduling continues.
 */
export function startRetentionScheduler(deps: AppDeps, opts: RetentionSchedulerOptions = {}): RetentionScheduler {
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
  const firstDelayMs = Math.max(0, opts.firstDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS);
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOnce(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const { retentionDays } = await getSettings(deps.prisma);
      if (retentionDays === 0) return;
      await runRetentionSweep(deps.prisma, deps.instr, deps.config.logDir, opts.now?.() ?? new Date(), 'scheduled');
    } catch (e) {
      console.error('[retention] scheduled sweep failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(() => { void runOnce().finally(() => schedule(intervalMs)); }, delay);
    timer.unref();
  }

  schedule(firstDelayMs);
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    runNow: runOnce,
  };
}
