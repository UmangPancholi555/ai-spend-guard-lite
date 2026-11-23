import type { ReactNode } from 'react';
export function Card({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function StatCard({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: string; testId?: string }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold" data-testid={testId}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </Card>
  );
}
