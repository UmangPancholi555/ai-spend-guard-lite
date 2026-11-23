import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ErrorGroup } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { Card } from '../ui/Card';
import { Async } from '../ui/State';
import { EmptyState } from '../ui/Table';
import { AXIS_TICK, ChartBox, COLORS, GRID_STROKE, tip } from './charts';

/** Error groups by category. Clicking a bar (or a chip) filters the error log to that category. */
export default function ErrorGroupsChart({ selected, onSelect, reloadKey }: { selected: string; onSelect: (c: string) => void; reloadKey: number }) {
  const { data, error, loading } = useAsync(() => api.get<ErrorGroup[]>('/observability/errors/groups'), [reloadKey]);
  return (
    <Card title="Error groups by category">
      <Async loading={loading && !data} error={error}>
        {data && data.length === 0 && <EmptyState message="No errors recorded. Nothing to group." />}
        {data && data.length > 0 && (
          <div data-testid="error-groups">
            <ChartBox label="Error counts by category" height={Math.max(160, data.length * 34 + 40)}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid horizontal={false} {...GRID_STROKE} />
                  <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} stroke="currentColor" />
                  <YAxis type="category" dataKey="category" tick={AXIS_TICK} stroke="currentColor" width={92} />
                  <Tooltip cursor={{ fill: 'currentColor', fillOpacity: 0.08 }} content={tip(p => <div><div className="font-semibold">{p.category}</div><div>{fmtInt(p.count)} errors</div><div>last seen {fmtDateTime(p.lastSeen)}</div></div>)} />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]} isAnimationActive={false} onClick={(d: any) => onSelect(selected === d.category ? '' : d.category)} cursor="pointer">
                    {data.map(g => <Cell key={g.category} fill={selected && selected !== g.category ? COLORS.muted : COLORS.bad} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Filter by error category">
              {data.map(g => (
                <li key={g.category}>
                  <button type="button" aria-pressed={selected === g.category} data-testid="error-group-chip" data-category={g.category}
                    onClick={() => onSelect(selected === g.category ? '' : g.category)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${selected === g.category ? 'border-red-500 bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
                    {g.category} <span className="font-semibold">{fmtInt(g.count)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Async>
    </Card>
  );
}
