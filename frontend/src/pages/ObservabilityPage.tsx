import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ObservabilityOverview } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Button, inputCls } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { Async } from '../components/ui/State';
import { LastUpdated, useRefreshedAt } from '../components/ui/LastUpdated';
import { SourceBadge, StatusBadge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/Table';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs, fmtPct } from '../lib/format';
import PerformancePanel from '../components/observability/PerformancePanel';
import SourcesPanel from '../components/observability/SourcesPanel';
import EventExplorer from '../components/observability/EventExplorer';
import { Field, TraceLink } from '../components/observability/common';

const RANGES = [
  { value: '1', label: 'Last 24 hours', bucket: 'hour' as const },
  { value: '7', label: 'Last 7 days', bucket: 'day' as const },
  { value: '30', label: 'Last 30 days', bucket: 'day' as const },
];

export default function ObservabilityPage() {
  const [days, setDays] = useState('7');
  const [tick, setTick] = useState(0);
  const range = RANGES.find(r => r.value === days) ?? RANGES[1];
  // `from` is recomputed on range change or manual refresh, so requests are stable between renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const from = useMemo(() => new Date(Date.now() - Number(days) * 86_400_000).toISOString(), [days, tick]);
  const overview = useAsync(() => api.get<ObservabilityOverview>('/observability/overview', { from }), [from]);
  const refreshedAt = useRefreshedAt(overview.data);

  return (
    <div className="space-y-6">
      <PageHeader title="Observability" subtitle="Execution health across requests, memory, bus, tool calls and context. Real (ACTUAL) and DEMO / SIMULATED data are always counted and labelled separately."
        actions={(
          <>
            <Field label="Range">
              <select className={inputCls} value={days} onChange={e => setDays(e.target.value)} data-testid="obs-range">
                {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
            <LastUpdated at={refreshedAt} />
            <Button variant="secondary" onClick={() => setTick(t => t + 1)} data-testid="obs-refresh">Refresh</Button>
          </>
        )} />

      <Async loading={overview.loading && !overview.data} error={overview.error} skeleton="cards">
        {overview.data && (() => {
          const o = overview.data;
          const t = o.totals;
          const split = o.bySource.actual + o.bySource.simulated;
          const actualPct = split === 0 ? 0 : (o.bySource.actual / split) * 100;
          return (
            <>
              <section aria-label="Overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" data-testid="obs-overview">
                <StatCard label="Total operations" value={fmtInt(t.operations)} testId="obs-total-operations" />
                <StatCard label="Successful" value={fmtInt(t.successful)} testId="obs-successful-operations" />
                <StatCard label="Failed" value={fmtInt(t.failed)} testId="obs-failed-operations" />
                <StatCard label="Failure rate" value={fmtPct(t.failureRate * 100, 1)} testId="obs-failure-rate" />
                <StatCard label="Avg execution time" value={fmtMs(t.averageDurationMs)} testId="obs-avg-duration" />
                <StatCard label="Memory injections" value={fmtInt(t.memoryInjections)} testId="obs-memory-injections" />
                <StatCard label="Bus operations" value={fmtInt(t.busOperations)} testId="obs-bus-operations" />
                <StatCard label="Tool calls" value={fmtInt(t.toolCalls)} testId="obs-tool-calls" />
                <StatCard label="Context updates" value={fmtInt(t.contextUpdates)} testId="obs-context-updates" />
                <Card>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Actual vs simulated</div>
                  <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-amber-300 dark:bg-amber-500/70" role="img" aria-label={`${fmtInt(o.bySource.actual)} actual, ${fmtInt(o.bySource.simulated)} simulated`} data-testid="obs-source-bar">
                    <div className="h-full bg-purple-500" style={{ width: `${actualPct}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-xs">
                    <span><span className="font-semibold" data-testid="obs-actual-count">{fmtInt(o.bySource.actual)}</span> actual</span>
                    <span><span className="font-semibold" data-testid="obs-simulated-count">{fmtInt(o.bySource.simulated)}</span> simulated</span>
                  </div>
                </Card>
              </section>
              <p className="-mt-3 text-xs text-slate-600 dark:text-slate-400">
                Counts cover {fmtDateTime(o.range.from)} to {fmtDateTime(o.range.to)}. Simulated counts come from the demo generator; they are not real memory, tool or context activity.
              </p>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="Recent errors" actions={<Link to="/errors" className="text-xs text-brand-600 hover:underline dark:text-brand-100">All errors</Link>}>
                  {o.recentErrors.length === 0 ? <EmptyState message="No recent errors." /> : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="obs-recent-errors">
                      {o.recentErrors.map(e => (
                        <li key={e.id} className="flex flex-col gap-1 py-2 text-sm" data-testid="obs-error-item">
                          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.operation}</span>{e.errorCategory && <span className="text-xs text-slate-600 dark:text-slate-400">{e.errorCategory}</span>}<SourceBadge source={e.source} /><span className="ml-auto text-xs text-slate-600 dark:text-slate-400">{fmtDateTime(e.ts)}</span></div>
                          <div className="truncate text-red-700 dark:text-red-300" title={e.errorMessage ?? e.message}>{e.errorMessage ?? e.message}</div>
                          <TraceLink traceId={e.traceId} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="Recent traces" actions={<Link to="/traces" className="text-xs text-brand-600 hover:underline dark:text-brand-100">All traces</Link>}>
                  {o.recentTraces.length === 0 ? <EmptyState message="No traces yet." /> : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="obs-recent-traces">
                      {o.recentTraces.map(tr => (
                        <li key={tr.traceId} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="obs-trace-item">
                          <Link to={`/traces/${encodeURIComponent(tr.traceId)}`} className="font-medium text-brand-600 hover:underline dark:text-brand-100">{tr.name}</Link>
                          <StatusBadge status={tr.status} /><SourceBadge source={tr.source} />
                          <span className="ml-auto text-xs text-slate-600 dark:text-slate-400">{fmtMs(tr.durationMs)} - {tr.spanCount} spans - {fmtDateTime(tr.startedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          );
        })()}
      </Async>

      <SourcesPanel />
      <PerformancePanel from={from} bucket={range.bucket} reloadKey={tick} />

      <Card title="Event explorer">
        <EventExplorer />
      </Card>
    </div>
  );
}
