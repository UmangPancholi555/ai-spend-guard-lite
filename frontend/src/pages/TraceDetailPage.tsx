import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TraceDetail } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { SourceBadge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { api, ApiRequestError } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtMs } from '../lib/format';
import SpanWaterfall from '../components/traces/SpanWaterfall';
import ExecutionTimeline from '../components/traces/ExecutionTimeline';
import EventExplorer from '../components/observability/EventExplorer';
import { KeyVal, StackBlock } from '../components/observability/common';

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.get<TraceDetail>(`/traces/${encodeURIComponent(traceId)}`), [traceId]);
  const [showStack, setShowStack] = useState(false);

  const notFound = error instanceof ApiRequestError && error.status === 404;
  const back = <Link to="/traces" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">All traces</Link>;

  if (notFound) {
    return (
      <div><PageHeader title="Trace not found" subtitle={traceId} actions={back} />
        <Card><p className="text-sm" data-testid="trace-not-found">No trace with this id exists. It may have been removed by the retention sweep.</p></Card></div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Trace" subtitle={traceId} actions={<>{back}<Button variant="secondary" onClick={reload}>Refresh</Button></>} />
      <Async loading={loading && !data} error={error}>
        {data && (() => {
          const { trace, spans, timeline } = data;
          return (
            <>
              <Card>
                <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="trace-header">
                  <h2 className="text-lg font-semibold" data-testid="trace-name">{trace.name}</h2>
                  <span data-testid="trace-status"><StatusBadge status={trace.status} /></span>
                  <SourceBadge source={trace.source} />
                </div>
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyVal k="Duration"><span data-testid="trace-duration">{trace.durationMs === null ? (trace.status === 'RUNNING' ? 'running' : '-') : fmtMs(trace.durationMs)}</span></KeyVal>
                  <KeyVal k="Request id"><span className="font-mono text-xs" data-testid="trace-request-id">{trace.requestId ?? '-'}</span></KeyVal>
                  <KeyVal k="Project">{trace.projectId ? <span className="font-mono text-xs">{trace.projectId}</span> : '-'}</KeyVal>
                  <KeyVal k="Spans">{trace.spanCount}</KeyVal>
                  <KeyVal k="Started">{fmtDateTime(trace.startedAt)}</KeyVal>
                  <KeyVal k="Ended">{fmtDateTime(trace.endedAt)}</KeyVal>
                  <KeyVal k="Trace id"><span className="font-mono text-xs break-all">{trace.traceId}</span></KeyVal>
                </dl>
                {(trace.errorMessage || trace.status === 'ERROR') && (
                  <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40" data-testid="trace-error">
                    <div className="text-sm font-medium text-red-800 dark:text-red-200" role="alert">{trace.errorMessage ?? 'Trace ended with an error.'}</div>
                    {trace.stack && (
                      <div className="mt-2">
                        <button type="button" className="text-xs font-medium text-red-700 underline dark:text-red-300" aria-expanded={showStack} onClick={() => setShowStack(s => !s)} data-testid="trace-stack-toggle">
                          {showStack ? 'Hide stack trace' : 'Show stack trace'}
                        </button>
                        {showStack && <div className="mt-2"><StackBlock stack={trace.stack} testId="trace-stack" /></div>}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              <Card title="Spans (waterfall)">
                <SpanWaterfall trace={trace} spans={spans} />
              </Card>

              <Card title="Execution timeline">
                <ExecutionTimeline entries={timeline} />
              </Card>

              <Card title="Correlated events">
                <EventExplorer traceId={trace.traceId} compact />
              </Card>
            </>
          );
        })()}
      </Async>
    </div>
  );
}
