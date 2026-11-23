import { Link } from 'react-router-dom';
import type { TraceDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { SourceBadge, StatusBadge } from '../components/ui/Badge';
import { Td } from '../components/ui/Table';
import ProjectSelect from '../components/activity/ProjectSelect';
import BackgroundTasksPanel from '../components/traces/BackgroundTasksPanel';
import { ExportLinks, FilterBar, PagedTable, SOURCE_OPTIONS, SelectFilter, TextFilter, useFilters, useList } from '../components/observability/common';
import { fmtDateTime, fmtInt, fmtMs } from '../lib/format';

const INITIAL = { status: '', source: '', projectId: '', search: '', from: '', to: '' };

export default function TracesPage() {
  const f = useFilters(INITIAL);
  const state = useList<TraceDto>('/traces', f.query);
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Traces" subtitle="Each request or simulated agent run is a trace made of spans. Open a trace for its span waterfall and execution timeline."
          actions={<ExportLinks dataset="traces" params={f.params} formats={['jsonl', 'csv']} />} />
        <FilterBar onReset={f.reset} dirty={f.dirty}>
          <SelectFilter label="Status" value={f.filters.status} onChange={v => f.setFilter('status', v)} options={['RUNNING', 'OK', 'ERROR']} testId="trace-filter-status" />
          <SelectFilter label="Source" value={f.filters.source} onChange={v => f.setFilter('source', v)} options={SOURCE_OPTIONS} testId="trace-filter-source" />
          <ProjectSelect value={f.filters.projectId} onChange={v => f.setFilter('projectId', v)} testId="trace-filter-project" />
          <TextFilter label="Search" type="search" value={f.filters.search} onChange={v => f.setFilter('search', v)} placeholder="name, trace id, request id" testId="trace-filter-search" className="min-w-[12rem]" />
          <TextFilter label="From" type="date" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="trace-filter-from" />
          <TextFilter label="To" type="date" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="trace-filter-to" />
        </FilterBar>
        <Card>
          <PagedTable state={state} testId="trace-table" onPage={f.setPage} emptyMessage="No traces match these filters. Send a mock request or run the simulator to create some."
            head={['Trace', 'Name', 'Status', 'Source', 'Started', 'Duration', 'Spans', 'Errors']}
            row={t => (
              <tr key={t.traceId} data-testid="trace-row" data-status={t.status} className={t.status === 'ERROR' ? 'bg-red-50/60 dark:bg-red-950/20' : undefined}>
                <Td><Link to={`/traces/${encodeURIComponent(t.traceId)}`} data-testid="trace-open" title={t.traceId}
                  className="inline-block max-w-[9rem] truncate align-bottom font-mono text-xs text-brand-600 hover:underline dark:text-brand-100">{t.traceId}</Link></Td>
                <Td>{t.name}</Td>
                <Td><StatusBadge status={t.status} /></Td>
                <Td><SourceBadge source={t.source} /></Td>
                <Td>{fmtDateTime(t.startedAt)}</Td>
                <Td>{t.durationMs === null ? (t.status === 'RUNNING' ? 'running' : '-') : fmtMs(t.durationMs)}</Td>
                <Td>{fmtInt(t.spanCount)}</Td>
                <Td>{t.status === 'ERROR' || t.errorMessage
                  ? <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300" data-testid="trace-error-indicator" title={t.errorMessage ?? 'Trace ended with an error'}>
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" /><span className="block max-w-[14rem] truncate">{t.errorMessage ?? 'Error'}</span>
                  </span>
                  : <span className="text-slate-400">-</span>}</Td>
              </tr>
            )} />
        </Card>
      </div>
      <BackgroundTasksPanel />
    </div>
  );
}
