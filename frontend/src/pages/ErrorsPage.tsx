import { useState } from 'react';
import type { ExecutionLogDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge, SourceBadge } from '../components/ui/Badge';
import ErrorGroupsChart from '../components/observability/ErrorGroupsChart';
import {
  ExpandableRow, ExportLinks, FilterBar, JsonBlock, KeyVal, PagedTable, SOURCE_OPTIONS, SelectFilter, StackBlock, TextFilter, TraceLink, useFilters, useList,
} from '../components/observability/common';
import { fmtDateTime, fmtMs } from '../lib/format';

const INITIAL = { category: '', search: '', traceId: '', source: '', from: '', to: '' };
const CATEGORIES = ['VALIDATION', 'PROVIDER', 'TIMEOUT', 'TOOL', 'BUS', 'MEMORY', 'CONTEXT', 'DATABASE', 'INTERNAL', 'UNKNOWN'];

export default function ErrorsPage() {
  const f = useFilters(INITIAL);
  const [tick, setTick] = useState(0);
  const state = useList<ExecutionLogDto>('/observability/errors', f.query, [tick]);
  return (
    <div className="space-y-4">
      <PageHeader title="Error Log" subtitle="Centralized log of failed operations across the app, with category, trace link and stack trace. Messages are metadata only; sensitive content is never stored."
        actions={<><Button variant="secondary" onClick={() => setTick(t => t + 1)}>Refresh</Button><ExportLinks dataset="errors" params={f.params} /></>} />
      <ErrorGroupsChart selected={f.filters.category} onSelect={c => f.setFilter('category', c)} reloadKey={tick} />
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        <SelectFilter label="Category" value={f.filters.category} onChange={v => f.setFilter('category', v)} options={CATEGORIES} testId="error-filter-category" />
        <SelectFilter label="Source" value={f.filters.source} onChange={v => f.setFilter('source', v)} options={SOURCE_OPTIONS} testId="error-filter-source" />
        <TextFilter label="Trace id" value={f.filters.traceId} onChange={v => f.setFilter('traceId', v)} placeholder="trace id" testId="error-filter-trace" />
        <TextFilter label="Search" type="search" value={f.filters.search} onChange={v => f.setFilter('search', v)} placeholder="operation, message" testId="error-filter-search" className="min-w-[12rem]" />
        <TextFilter label="From" type="date" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="error-filter-from" />
        <TextFilter label="To" type="date" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="error-filter-to" />
      </FilterBar>
      <Card>
        <PagedTable state={state} testId="error-table" onPage={f.setPage} emptyMessage="No errors match these filters."
          head={['Details', 'Time', 'Category', 'Operation', 'Message', 'Source', 'Duration', 'Trace']}
          row={e => (
            <ExpandableRow key={e.id} testId="error-row" tone="error"
              cells={[
                fmtDateTime(e.ts),
                <Badge tone="red">{e.errorCategory ?? 'UNKNOWN'}</Badge>,
                e.operation,
                <span className="block max-w-md truncate text-red-800 dark:text-red-200" title={e.errorMessage ?? e.message}>{e.errorMessage ?? e.message}</span>,
                <SourceBadge source={e.source} />,
                fmtMs(e.durationMs),
                <TraceLink traceId={e.traceId} />,
              ]}
              detail={(
                <div className="space-y-3">
                  <div className="text-sm text-red-800 dark:text-red-200" role="alert" data-testid="error-message">{e.errorMessage ?? e.message}</div>
                  <dl className="grid gap-3 sm:grid-cols-4">
                    <KeyVal k="Event type">{e.eventType}</KeyVal>
                    <KeyVal k="Category">{e.category}</KeyVal>
                    <KeyVal k="Request id"><span className="font-mono text-xs">{e.requestId ?? '-'}</span></KeyVal>
                    <KeyVal k="Trace"><TraceLink traceId={e.traceId} /></KeyVal>
                  </dl>
                  {e.stack ? <StackBlock stack={e.stack} testId="error-stack" /> : <p className="text-xs text-slate-500 dark:text-slate-400">No stack trace was captured for this error.</p>}
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Attributes</div>
                    <JsonBlock data={e.attributes} testId="error-attributes" />
                  </div>
                </div>
              )} />
          )} />
      </Card>
    </div>
  );
}
