import type { ReactNode } from 'react';

/** Page title + actions. On md+ screens it sticks under the app header so actions stay reachable while scrolling. */
export default function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div
      data-testid="page-header"
      className="mb-5 flex flex-wrap items-end justify-between gap-3 md:sticky md:top-[var(--app-header-h,3.5rem)] md:z-[5] md:-mx-6 md:bg-slate-50/90 md:px-6 md:pb-3 md:pt-2 md:backdrop-blur dark:md:bg-slate-950/90"
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
