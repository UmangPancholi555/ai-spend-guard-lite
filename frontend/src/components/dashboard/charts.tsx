import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardStats } from '@shared/types';
import { fmtInt, fmtUsd, usdToChartNumber } from '../../lib/format';

const AXIS = { fill: '#94a3b8', fontSize: 11 };
const GRID = 'rgba(148,163,184,0.25)';
export const COLORS = { cost: '#6366f1', success: '#10b981', failure: '#ef4444', input: '#0ea5e9', output: '#a855f7', cached: '#f59e0b' };

const axisMoney = (v: number) => (v === 0 ? '$0' : Math.abs(v) < 0.01 ? `$${v.toExponential(1)}` : `$${v.toFixed(2)}`);

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      <div className="mb-1 font-semibold">{title}</div>
      {rows.map(r => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />}
          <span className="text-slate-600 dark:text-slate-400">{r.label}:</span> <span className="font-medium">{r.value}</span>
        </div>
      ))}
      <div className="mt-1 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">DEMO / SIMULATED</div>
    </div>
  );
}

/** Daily simulated spend. Numbers only for plotting; tooltip prints the exact decimal string. */
export function DailySpendChart({ data }: { data: DashboardStats['dailySpend'] }) {
  const pts = data.map(d => ({ date: d.date, cost: usdToChartNumber(d.costUsd), exact: d.costUsd, requests: d.requests }));
  return (
    <div className="h-64 w-full" data-testid="chart-daily-spend" role="img" aria-label="Daily simulated spend chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tick={AXIS} tickFormatter={(d: string) => d.slice(5)} minTickGap={16} />
          <YAxis tick={AXIS} tickFormatter={axisMoney} width={60} />
          <Tooltip content={({ active, payload }) => {
            const p = active && payload?.[0]?.payload;
            return p ? <TooltipBox title={p.date} rows={[{ label: 'Spend', value: fmtUsd(p.exact), color: COLORS.cost }, { label: 'Requests', value: fmtInt(p.requests) }]} /> : null;
          }} />
          <Area type="monotone" dataKey="cost" stroke={COLORS.cost} fill={COLORS.cost} fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SuccessFailureChart({ data }: { data: DashboardStats['dailySpend'] }) {
  const pts = data.map(d => ({ date: d.date, success: Math.max(0, d.requests - d.failures), failure: d.failures }));
  return (
    <div className="h-64 w-full" data-testid="chart-success-failure" role="img" aria-label="Successful versus failed requests per day">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tick={AXIS} tickFormatter={(d: string) => d.slice(5)} minTickGap={16} />
          <YAxis tick={AXIS} allowDecimals={false} width={40} />
          <Tooltip content={({ active, payload }) => {
            const p = active && payload?.[0]?.payload;
            return p ? <TooltipBox title={p.date} rows={[{ label: 'Success', value: fmtInt(p.success), color: COLORS.success }, { label: 'Failure', value: fmtInt(p.failure), color: COLORS.failure }]} /> : null;
          }} />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string) => <span className="text-slate-700 dark:text-slate-300">{v}</span>} />
          <Bar dataKey="success" name="Success" stackId="a" fill={COLORS.success} isAnimationActive={false} />
          <Bar dataKey="failure" name="Failure" stackId="a" fill={COLORS.failure} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProviderCostChart({ data }: { data: DashboardStats['providerBreakdown'] }) {
  const pts = data.map(d => ({ provider: d.provider, cost: usdToChartNumber(d.costUsd), exact: d.costUsd, requests: d.requests }));
  return (
    <div className="h-56 w-full" data-testid="chart-provider-cost" role="img" aria-label="Simulated cost by provider">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="provider" tick={AXIS} />
          <YAxis tick={AXIS} tickFormatter={axisMoney} width={60} />
          <Tooltip content={({ active, payload }) => {
            const p = active && payload?.[0]?.payload;
            return p ? <TooltipBox title={p.provider} rows={[{ label: 'Spend', value: fmtUsd(p.exact), color: COLORS.cost }, { label: 'Requests', value: fmtInt(p.requests) }]} /> : null;
          }} />
          <Bar dataKey="cost" fill={COLORS.cost} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
