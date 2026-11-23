import type { ReactNode } from 'react';

/** Shared Recharts styling that works in light + dark (colors via currentColor / CSS classes). */
export const AXIS_TICK = { fill: 'currentColor', fontSize: 11 } as const;
export const GRID_STROKE = { stroke: 'currentColor', strokeOpacity: 0.15 } as const;

export const COLORS = {
  ok: '#10b981',
  warn: '#f59e0b',
  hot: '#f97316',
  bad: '#ef4444',
  brand: '#6366f1',
  muted: '#94a3b8',
};

interface TipProps { active?: boolean; payload?: { payload?: any; name?: string; value?: any; color?: string }[]; label?: string }

/** Build a Recharts <Tooltip content> that renders our own themed box. */
export function tip(render: (point: any, label?: string) => ReactNode) {
  return function ChartTip({ active, payload, label }: TipProps) {
    if (!active || !payload || payload.length === 0) return null;
    return (
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
        {render(payload[0].payload ?? {}, label)}
      </div>
    );
  };
}

export function ChartBox({ children, height = 220, label }: { children: ReactNode; height?: number; label: string }) {
  return (
    <div className="text-slate-500 dark:text-slate-400" style={{ height }} role="img" aria-label={label}>
      {children}
    </div>
  );
}
