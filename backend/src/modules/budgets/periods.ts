import type { BudgetPeriod } from '../../../../shared/types';

const DAY_MS = 86_400_000;

function assertDate(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('Invalid date');
}

/**
 * UTC period containing `at`, half-open [start, end).
 *  DAILY   = UTC day
 *  WEEKLY  = ISO week, Monday 00:00 UTC .. next Monday 00:00 UTC
 *  MONTHLY = UTC calendar month
 */
export function periodBounds(period: BudgetPeriod, at: Date): { start: Date; end: Date } {
  assertDate(at);
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  switch (period) {
    case 'DAILY': {
      const start = Date.UTC(y, m, d);
      return { start: new Date(start), end: new Date(start + DAY_MS) };
    }
    case 'WEEKLY': {
      const daysSinceMonday = (at.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
      const start = Date.UTC(y, m, d) - daysSinceMonday * DAY_MS;
      return { start: new Date(start), end: new Date(start + 7 * DAY_MS) };
    }
    case 'MONTHLY':
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    default:
      throw new Error(`Unknown budget period ${String(period)}`);
  }
}

/** Start of the period immediately before the period that starts at `periodStart`. */
export function previousPeriodStart(period: BudgetPeriod, periodStart: Date): Date {
  assertDate(periodStart);
  switch (period) {
    case 'DAILY': return new Date(periodStart.getTime() - DAY_MS);
    case 'WEEKLY': return new Date(periodStart.getTime() - 7 * DAY_MS);
    case 'MONTHLY': return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() - 1, 1));
    default: throw new Error(`Unknown budget period ${String(period)}`);
  }
}
