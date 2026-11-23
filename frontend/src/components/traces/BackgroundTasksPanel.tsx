import type { BackgroundTaskDto } from '@shared/types';
import { Badge, SourceBadge, StatusBadge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { fmtDateTime, fmtMs } from '../../lib/format';
import { ExpandableRow, ExportLinks, FilterBar, JsonBlock, KeyVal, PagedTable, SelectFilter, StackBlock, TraceLink, useFilters, useList } from '../observability/common';

const INITIAL = { status: '', kind: '' };
const STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'];
const KINDS = ['RETENTION_SWEEP', 'DEMO_SEED', 'BUDGET_EVALUATION', 'EXPORT', 'OTHER'];

export default function BackgroundTasksPanel() {
  const f = useFilters(INITIAL, 10);
  const state = useList<BackgroundTaskDto>('/background-tasks', f.query);
  return (
    <Card title="Background tasks" actions={<ExportLinks dataset="tasks" params={f.params} />}>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">Tracked jobs: retention sweeps, demo data seeding and budget evaluations. Seeding is SIMULATED; the others are real work done by this app.</p>
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        <SelectFilter label="Status" value={f.filters.status} onChange={v => f.setFilter('status', v)} options={STATUSES} testId="task-filter-status" />
        <SelectFilter label="Kind" value={f.filters.kind} onChange={v => f.setFilter('kind', v)} options={KINDS} testId="task-filter-kind" />
      </FilterBar>
      <PagedTable state={state} testId="task-table" onPage={f.setPage} emptyMessage="No background tasks recorded yet."
        head={['Details', 'Name', 'Kind', 'Status', 'Source', 'Started', 'Duration']}
        row={t => (
          <ExpandableRow key={t.id} testId="task-row" tone={t.status === 'FAILED' ? 'error' : undefined}
            cells={[
              t.name, <Badge>{t.kind}</Badge>, <StatusBadge status={t.status} />, <SourceBadge source={t.source} />, fmtDateTime(t.startedAt ?? t.createdAt), fmtMs(t.durationMs),
            ]}
            detail={(
              <div className="space-y-3">
                <dl className="grid gap-3 sm:grid-cols-3">
                  <KeyVal k="Task id"><span className="font-mono text-xs">{t.id}</span></KeyVal>
                  <KeyVal k="Ended">{fmtDateTime(t.endedAt)}</KeyVal>
                  <KeyVal k="Trace"><TraceLink traceId={t.traceId} /></KeyVal>
                </dl>
                {t.errorMessage && <div className="text-sm text-red-700 dark:text-red-300" role="alert">{t.errorMessage}</div>}
                <StackBlock stack={t.stack} />
                <JsonBlock data={t.result} label="Task result" />
              </div>
            )} />
        )} />
    </Card>
  );
}
