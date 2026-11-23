import type { AlertThreshold } from '@shared/types';
import { fmtPct } from '../../lib/format';

export type UtilState = 'ok' | 'notice' | 'warning' | 'exceeded';

export function utilState(percent: number): { state: UtilState; label: string; bar: string; text: string } {
  if (percent >= 100) return { state: 'exceeded', label: 'Limit reached', bar: 'bg-red-500', text: 'text-red-700 dark:text-red-300' };
  if (percent >= 80) return { state: 'warning', label: 'Over 80%', bar: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-300' };
  if (percent >= 50) return { state: 'notice', label: 'Over 50%', bar: 'bg-amber-400', text: 'text-amber-700 dark:text-amber-300' };
  return { state: 'ok', label: 'Within budget', bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' };
}

export const THRESHOLDS: AlertThreshold[] = [50, 80, 100];

export function thresholdTone(t: number): string {
  return t >= 100 ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    : t >= 80 ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
}

/** Progress bar with 50/80/100 markers. Percent can exceed 100 (bar is clamped, label shows real value). */
export default function UtilizationBar({ percent, testId = 'utilization-bar' }: { percent: number; testId?: string }) {
  const s = utilState(percent);
  const width = Math.max(0, Math.min(percent, 100));
  return (
    <div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(Math.round(percent), 100)}
        aria-valuetext={`${fmtPct(percent, 2)} of limit used - ${s.label}`} data-testid={testId} data-state={s.state}>
        <div className={`h-full ${s.bar} transition-all`} style={{ width: `${width}%` }} />
        {THRESHOLDS.slice(0, 2).map(t => (
          <div key={t} className="absolute inset-y-0 w-px bg-slate-900/50 dark:bg-white/60" style={{ left: `${t}%` }} aria-hidden="true" />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-slate-500 dark:text-slate-400" aria-hidden="true">
        <span className="absolute -translate-x-1/2" style={{ left: '50%' }}>50%</span>
        <span className="absolute -translate-x-1/2" style={{ left: '80%' }}>80%</span>
        <span className="absolute right-0">100%</span>
      </div>
    </div>
  );
}
