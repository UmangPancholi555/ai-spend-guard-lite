import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PerformanceStats } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs, fmtPct } from '../../lib/format';
import { Card, StatCard } from '../ui/Card';
import { Async } from '../ui/State';
import { EmptyState, Table, Td } from '../ui/Table';
import { StatusBadge } from '../ui/Badge';
import { SourceBadge } from '../ui/Badge';
import { AXIS_TICK, ChartBox, COLORS, GRID_STROKE, tip } from './charts';
import { TraceLink } from './common';

function bucketLabel(iso: string, bucket: 'hour' | 'day') {
  const d = new Date(iso);
  return bucket === 'hour'
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PerformancePanel({ from, bucket, reloadKey }: { from: string; bucket: 'hour' | 'day'; reloadKey: number }) {
  const { data, error, loading } = useAsync(() => api.get<PerformanceStats>('/observability/performance', { from, bucket }), [from, bucket, reloadKey]);
  return (
    <Card title="Performance">
      <Async loading={loading && !data} error={error} skeleton="cards">
        {data && <PerformanceBody d={data} bucket={bucket} />}
      </Async>
    </Card>
  );
}

function PerformanceBody({ d, bucket }: { d: PerformanceStats; bucket: 'hour' | 'day' }) {
  const lat = [
    { key: 'request', label: 'Request latency', v: d.requestLatency },
    { key: 'tool', label: 'Tool call latency', v: d.toolLatency },
    { key: 'memory', label: 'Memory injection latency', v: d.memoryInjectionLatency },
  ];
  const counts = d.operationCounts.map(o => ({ category: o.category, ok: Math.max(0, o.count - o.failures), failures: o.failures, count: o.count }));
  const series = d.durationSeries.map(p => ({ ...p, label: bucketLabel(p.bucket, bucket) }));
  return (
    <div className="space-y-6" data-testid="performance-panel">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {lat.map(l => (
          <StatCard key={l.key} label={l.label} testId={`perf-${l.key}-avg`} value={l.v.count === 0 ? '-' : fmtMs(l.v.avgMs)}
            hint={l.v.count === 0 ? 'No data in range' : `p95 ${fmtMs(l.v.p95Ms)} - ${fmtInt(l.v.count)} calls`} />
        ))}
        <StatCard label="Failure rate" testId="perf-failure-rate" value={fmtPct(d.failureRate * 100, 1)} hint={`Avg execution ${fmtMs(d.averageExecutionMs)}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Operations by category</h3>
          {counts.length === 0 ? <EmptyState message="No operations in this range." /> : (
            <ChartBox label="Operation counts per category, successes and failures" height={240}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={counts} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} {...GRID_STROKE} />
                  <XAxis dataKey="category" tick={AXIS_TICK} stroke="currentColor" />
                  <YAxis allowDecimals={false} tick={AXIS_TICK} stroke="currentColor" width={36} />
                  <Tooltip cursor={{ fill: 'currentColor', fillOpacity: 0.08 }} content={tip(p => <div><div className="font-semibold">{p.category}</div><div>{fmtInt(p.count)} operations</div><div>{fmtInt(p.failures)} failed</div></div>)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string) => <span className="text-slate-700 dark:text-slate-300">{v}</span>} />
                  <Bar dataKey="ok" name="Succeeded" stackId="a" fill={COLORS.ok} isAnimationActive={false} />
                  <Bar dataKey="failures" name="Failed" stackId="a" fill={COLORS.bad} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Average duration over time ({bucket === 'hour' ? 'hourly' : 'daily'})</h3>
          {series.length === 0 ? <EmptyState message="No duration data in this range." /> : (
            <ChartBox label="Average operation duration over time" height={240}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} {...GRID_STROKE} />
                  <XAxis dataKey="label" tick={AXIS_TICK} stroke="currentColor" minTickGap={24} />
                  <YAxis tick={AXIS_TICK} stroke="currentColor" unit="ms" width={52} />
                  <Tooltip content={tip(p => <div><div className="font-semibold">{fmtDateTime(p.bucket)}</div><div>avg {fmtMs(p.avgMs)}</div><div>{fmtInt(p.count)} operations</div></div>)} />
                  <Line type="monotone" dataKey="avgMs" name="Avg ms" stroke={COLORS.brand} strokeWidth={2} dot={series.length < 40} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartBox>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Slow operations <span className="font-normal text-slate-600 dark:text-slate-400">(over {fmtMs(d.slowThresholdMs)}, configurable in Settings)</span></h3>
        <Table head={['Time', 'Operation', 'Category', 'Duration', 'Status', 'Source', 'Trace']}
          empty={d.slowOperations.length === 0 ? <EmptyState message="No slow operations in this range." /> : undefined}>
          {d.slowOperations.map(o => (
            <tr key={o.id} data-testid="slow-op-row">
              <Td>{fmtDateTime(o.ts)}</Td><Td>{o.operation}</Td><Td>{o.category}</Td>
              <Td><span className="font-semibold text-orange-700 dark:text-orange-300">{fmtMs(o.durationMs)}</span></Td>
              <Td><StatusBadge status={o.status} /></Td><Td><SourceBadge source={o.source} /></Td><Td><TraceLink traceId={o.traceId} /></Td>
            </tr>
          ))}
        </Table>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Per-operation statistics</h3>
        <Table head={['Operation', 'Category', 'Count', 'Failures', 'Avg', 'p95', 'Max']}
          empty={d.operations.length === 0 ? <EmptyState message="No operation statistics in this range." /> : undefined}>
          {d.operations.map(o => (
            <tr key={`${o.category}:${o.operation}`} data-testid="op-stat-row">
              <Td>{o.operation}</Td><Td>{o.category}</Td><Td>{fmtInt(o.count)}</Td>
              <Td>{o.failures > 0 ? <span className="font-semibold text-red-700 dark:text-red-300">{fmtInt(o.failures)}</span> : 0}</Td>
              <Td>{fmtMs(o.avgMs)}</Td><Td>{fmtMs(o.p95Ms)}</Td><Td>{fmtMs(o.maxMs)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
