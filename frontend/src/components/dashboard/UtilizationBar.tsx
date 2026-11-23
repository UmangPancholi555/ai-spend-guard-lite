import { Link } from 'react-router-dom';
import type { BudgetUtilization } from '@shared/types';
import { fmtUsd } from '../../lib/format';

export function thresholdColor(percent: number) {
  if (percent >= 100) return 'bg-red-600';
  if (percent >= 80) return 'bg-orange-500';
  if (percent >= 50) return 'bg-amber-400';
  return 'bg-emerald-500';
}

/** Progress bar with 50/80/100% markers; color changes by threshold. */
export function UtilizationBar({ u, showProject = true }: { u: BudgetUtilization; showProject?: boolean }) {
  const pct = Math.max(0, u.percent);
  const width = Math.min(100, pct);
  return (
    <li className="py-2" data-testid="budget-utilization-item">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">
          {u.budget.name}
          <span className="ml-2 text-xs font-normal text-slate-600 dark:text-slate-400">
            {u.budget.period}{showProject ? ` - ${u.budget.projectName ?? 'All projects'}` : ''}
          </span>
        </span>
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {fmtUsd(u.spendUsd)} of {fmtUsd(u.limitUsd)} - <strong data-testid="budget-percent">{pct.toFixed(1)}%</strong>
          {u.highestThresholdReached ? ` (passed ${u.highestThresholdReached}%)` : ''}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-slate-200 dark:bg-slate-700"
        role="progressbar" aria-label={`${u.budget.name} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)}>
        <div className={`h-full rounded-full ${thresholdColor(pct)}`} style={{ width: `${width}%` }} />
        {[50, 80].map(m => (
          <div key={m} className="absolute inset-y-0 w-px bg-slate-500/70 dark:bg-slate-300/70" style={{ left: `${m}%` }} title={`${m}% threshold`} />
        ))}
        <div className="absolute inset-y-0 right-0 w-px bg-slate-500/70 dark:bg-slate-300/70" title="100% threshold" />
      </div>
      <div className="relative mt-0.5 h-3 text-[10px] text-slate-600 dark:text-slate-400" aria-hidden="true">
        <span className="absolute -translate-x-1/2" style={{ left: '50%' }}>50%</span>
        <span className="absolute -translate-x-1/2" style={{ left: '80%' }}>80%</span>
        <span className="absolute right-0">100%</span>
      </div>
    </li>
  );
}

export function BudgetUtilizationList({ items, showProject = true }: { items: BudgetUtilization[]; showProject?: boolean }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="budget-empty">
        No active budgets. <Link to="/budgets" className="text-brand-600 underline dark:text-brand-100">Create a budget</Link> to track spend against limits.
      </p>
    );
  }
  return <ul className="divide-y divide-slate-100 dark:divide-slate-800">{items.map(u => <UtilizationBar key={u.budget.id} u={u} showProject={showProject} />)}</ul>;
}
