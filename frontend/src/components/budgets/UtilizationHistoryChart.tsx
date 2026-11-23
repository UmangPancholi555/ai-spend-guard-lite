import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BudgetUtilizationDetail } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtPct, fmtUsd } from '../../lib/format';
import { ErrorBox, Loading } from '../ui/State';
import { AXIS_TICK, ChartBox, COLORS, GRID_STROKE, tip } from '../observability/charts';
import { utilState } from './UtilizationBar';

const STATE_COLOR = { ok: COLORS.ok, notice: COLORS.warn, warning: COLORS.hot, exceeded: COLORS.bad };

function periodLabel(iso: string, period: string) {
  const d = new Date(iso);
  if (period === 'MONTHLY') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function UtilizationHistoryChart({ budgetId, reloadKey }: { budgetId: string; reloadKey: number }) {
  const { data, error, loading } = useAsync(() => api.get<BudgetUtilizationDetail>(`/budgets/${budgetId}/utilization`, { periods: 6 }), [budgetId, reloadKey]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const rows = [
    ...data.history.map(h => ({ ...h, name: periodLabel(h.periodStart, data.budget.period), current: false })),
    { periodStart: data.periodStart, periodEnd: data.periodEnd, spendUsd: data.spendUsd, percent: data.percent, name: `${periodLabel(data.periodStart, data.budget.period)} (now)`, current: true },
  ];
  const max = Math.max(100, ...rows.map(r => r.percent));
  return (
    <div data-testid="utilization-history">
      <ChartBox label={`Utilization history for ${data.budget.name}`} height={220}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} {...GRID_STROKE} />
            <XAxis dataKey="name" tick={AXIS_TICK} stroke="currentColor" />
            <YAxis tick={AXIS_TICK} stroke="currentColor" domain={[0, Math.ceil(max * 1.05)]} ticks={max > 100 ? [0, 50, 80, 100, Math.ceil(max)] : [0, 50, 80, 100]} unit="%" width={48} />
            <Tooltip cursor={{ fill: 'currentColor', fillOpacity: 0.08 }} content={tip(p => (
              <div>
                <div className="font-semibold">{p.name}</div>
                <div>{fmtPct(p.percent, 2)} used</div>
                <div>{fmtUsd(p.spendUsd)} of {fmtUsd(data.limitUsd)}</div>
              </div>
            ))} />
            {[50, 80, 100].map(t => <ReferenceLine key={t} y={t} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="4 4" />)}
            <Bar dataKey="percent" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {rows.map((r, i) => <Cell key={i} fill={STATE_COLOR[utilState(r.percent).state]} fillOpacity={r.current ? 1 : 0.75} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Previous {data.history.length} {data.budget.period.toLowerCase()} periods plus the current one (UTC). Dashed lines mark the 50 / 80 / 100% alert thresholds.</p>
    </div>
  );
}
