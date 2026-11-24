import type { ExecutionLogDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { LinkButton } from '../components/ui/Button';
import { SourceBadge, StatusBadge } from '../components/ui/Badge';
import {
  ExpandableRow, ExportLinks, FilterBar, JsonBlock, KeyVal, LevelBadge, PagedTable, SOURCE_OPTIONS, SelectFilter, StackBlock, TextFilter, TraceLink, useFilters, useList,
} from '../components/observability/common';
import { fmtDateTime, fmtMs } from '../lib/format';

const INITIAL = { eventType: '', category: '', status: '', level: '', source: '', traceId: '', search: '', from: '', to: '' };
const CATEGORIES = ['REQUEST', 'MEMORY', 'BUS', 'TOOL', 'CONTEXT', 'ERROR', 'SYSTEM', 'BUDGET', 'PROVIDER'];

export default function LogsPage() {
  const f = useFilters(INITIAL);
  const state = useList<ExecutionLogDto>('/logs', f.query);
  return (
    <div>
      <PageHeader title="Execution Logs" subtitle="Persistent structured log of every instrumented operation. Also appended as JSONL files on disk. Attributes hold metadata only: hashes, sizes, counts and key names."
        actions={<ExportLinks dataset="logs" params={f.params} />} />
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        <TextFilter label="Event type" value={f.filters.eventType} onChange={v => f.setFilter('eventType', v)} placeholder="e.g. request.completed" testId="log-filter-event-type" />
        <SelectFilter label="Category" value={f.filters.category} onChange={v => f.setFilter('category', v)} options={CATEGORIES} testId="log-filter-category" />
        <SelectFilter label="Status" value={f.filters.status} onChange={v => f.setFilter('status', v)} options={['STARTED', 'SUCCESS', 'FAILURE', 'INFO']} testId="log-filter-status" />
        <SelectFilter label="Level" value={f.filters.level} onChange={v => f.setFilter('level', v)} options={['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']} testId="log-filter-level" />
        <SelectFilter label="Source" value={f.filters.source} onChange={v => f.setFilter('source', v)} options={SOURCE_OPTIONS} testId="log-filter-source" />
        <TextFilter label="Trace id" value={f.filters.traceId} onChange={v => f.setFilter('traceId', v)} placeholder="trace id" testId="log-filter-trace" />
        <TextFilter label="Operation name" type="search" value={f.filters.search} onChange={v => f.setFilter('search', v)} placeholder="search operation" testId="log-filter-search" className="min-w-[12rem]" />
        <TextFilter label="From" type="date" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="log-filter-from" />
        <TextFilter label="To" type="date" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="log-filter-to" />
      </FilterBar>
      <Card>
        <PagedTable state={state} testId="log-table" onPage={f.setPage} emptyMessage="No execution logs match these filters." emptyAction={!f.dirty && <LinkButton to="/simulator" testId="logs-empty-cta">Open Request Simulator</LinkButton>}
          head={['Details', 'Time', 'Level', 'Category', 'Event type', 'Operation', 'Status', 'Source', 'Duration', 'Trace']}
          row={l => (
            <ExpandableRow key={l.id} testId="log-row" tone={l.level === 'ERROR' ? 'error' : undefined}
              cells={[
                fmtDateTime(l.ts), <LevelBadge level={l.level} />, l.category, <span className="font-mono text-xs">{l.eventType}</span>, l.operation,
                <StatusBadge status={l.status} />, <SourceBadge source={l.source} />, fmtMs(l.durationMs), <TraceLink traceId={l.traceId} />,
              ]}
              detail={(
                <div className="space-y-3">
                  <div className="text-sm">{l.message}</div>
                  <dl className="grid gap-3 sm:grid-cols-4">
                    <KeyVal k="Log id"><span className="font-mono text-xs">{l.id}</span></KeyVal>
                    <KeyVal k="Span id"><span className="font-mono text-xs">{l.spanId ?? '-'}</span></KeyVal>
                    <KeyVal k="Request id"><span className="font-mono text-xs">{l.requestId ?? '-'}</span></KeyVal>
                    <KeyVal k="Project id"><span className="font-mono text-xs">{l.projectId ?? '-'}</span></KeyVal>
                  </dl>
                  {l.errorMessage && <div className="text-sm text-red-700 dark:text-red-300" role="alert">{l.errorCategory ? `${l.errorCategory}: ` : ''}{l.errorMessage}</div>}
                  <StackBlock stack={l.stack} />
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Attributes (metadata only)</div>
                    <JsonBlock data={l.attributes} testId="log-attributes" />
                  </div>
                </div>
              )} />
          )} />
      </Card>
    </div>
  );
}
