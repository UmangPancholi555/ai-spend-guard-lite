import type { Source } from '@shared/types';
type Tone = 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'purple';
const TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
};
export function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  const tone: Tone = /SUCCESS|OK|SUCCEEDED|COMPLETED|ACTIVE/.test(status) ? 'green' : /FAIL|ERROR/.test(status) ? 'red' : /RUNNING|STARTED|QUEUED/.test(status) ? 'blue' : 'slate';
  return <Badge tone={tone}>{status}</Badge>;
}
/** Distinguishes real instrumented events (ACTUAL) from DEMO / SIMULATED ones. Always show on events. */
export function SourceBadge({ source }: { source: Source }) {
  return source === 'SIMULATED'
    ? <Badge tone="amber">DEMO / SIMULATED</Badge>
    : <Badge tone="purple">ACTUAL (instrumented)</Badge>;
}
