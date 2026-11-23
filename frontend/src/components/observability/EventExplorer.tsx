import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BusEventDto, ContextEventDto, MemoryEventDto, Source, ToolCallEventDto } from '@shared/types';
import { SourceBadge, StatusBadge } from '../ui/Badge';
import { fmtDateTime, fmtInt, fmtMs } from '../../lib/format';
import {
  ExpandableRow, ExportLinks, FilterBar, JsonBlock, KeyVal, Meta, PagedTable, SOURCE_OPTIONS, SelectFilter, StackBlock, TabBar, TextFilter, TraceLink, fmtBytes, useFilters, useList,
} from './common';

type Kind = 'memory' | 'bus' | 'tool' | 'context';
const TABS: { key: Kind; label: string }[] = [
  { key: 'memory', label: 'Memory' }, { key: 'bus', label: 'Bus' }, { key: 'tool', label: 'Tool calls' }, { key: 'context', label: 'Context' },
];

interface Common { id: string; source: Source; status: string; traceId: string | null; errorMessage: string | null }

interface Spec<T extends Common> {
  path: string; dataset: string; head: string[]; statuses: string[]; hint: string;
  cells: (e: T, showTrace: boolean) => ReactNode[]; detail: (e: T) => ReactNode;
}

const ERR = (e: Common & { stack?: string | null }) => (
  e.errorMessage ? <div className="space-y-2"><div className="text-sm text-red-700 dark:text-red-300" role="alert">{e.errorMessage}</div><StackBlock stack={e.stack} /></div> : null
);

const memory: Spec<MemoryEventDto> = {
  path: '/observability/memory-events', dataset: 'memory', statuses: ['STARTED', 'SUCCESS', 'FAILURE'],
  hint: 'Memory injection events. Only sizes, counts and token estimates are stored, never memory content.',
  head: ['Details', 'Time', 'Memory source', 'Category', 'Items', 'Est. tokens', 'Payload', 'Duration', 'Phase', 'Status', 'Source', 'Trace'],
  cells: e => [fmtDateTime(e.createdAt), e.memorySource, e.category, fmtInt(e.itemCount), fmtInt(e.estimatedTokens), fmtBytes(e.payloadBytes), fmtMs(e.durationMs), e.phase, <StatusBadge status={e.status} />, <SourceBadge source={e.source} />, <TraceLink traceId={e.traceId} />],
  detail: e => (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <KeyVal k="Event id"><span className="font-mono text-xs">{e.id}</span></KeyVal>
        <KeyVal k="Operation id"><span className="font-mono text-xs">{e.operationId}</span></KeyVal>
        <KeyVal k="Span id"><span className="font-mono text-xs">{e.spanId ?? '-'}</span></KeyVal>
      </dl>
      {ERR(e as never)}
    </div>
  ),
};

const bus: Spec<BusEventDto> = {
  path: '/observability/bus-events', dataset: 'bus', statuses: ['SUCCESS', 'FAILURE'],
  hint: 'Message-bus operations. Input is shown as metadata (key names, sizes), never payload content.',
  head: ['Details', 'Time', 'Operation', 'Type', 'Event', 'Input meta', 'Output status', 'Duration', 'Status', 'Source', 'Trace'],
  cells: e => [fmtDateTime(e.createdAt), e.operationName, e.operationType, e.eventName, <Meta data={e.inputMeta} />, e.outputStatus ?? '-', fmtMs(e.durationMs), <StatusBadge status={e.status} />, <SourceBadge source={e.source} />, <TraceLink traceId={e.traceId} />],
  detail: e => (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <KeyVal k="Event id"><span className="font-mono text-xs">{e.id}</span></KeyVal>
        <KeyVal k="Operation id"><span className="font-mono text-xs">{e.operationId}</span></KeyVal>
        <KeyVal k="Span id"><span className="font-mono text-xs">{e.spanId ?? '-'}</span></KeyVal>
      </dl>
      <JsonBlock data={e.inputMeta} label="Input metadata" />
      {ERR(e)}
    </div>
  ),
};

const tool: Spec<ToolCallEventDto> = {
  path: '/observability/tool-events', dataset: 'tools', statuses: ['SUCCESS', 'FAILURE'],
  hint: 'Tool calls with retry counts. Input/output are metadata only.',
  head: ['Details', 'Time', 'Tool', 'Call id', 'Input meta', 'Duration', 'Retries', 'Status', 'Source', 'Trace'],
  cells: e => [fmtDateTime(e.createdAt), e.toolName, <span className="font-mono text-xs">{e.toolCallId}</span>, <Meta data={e.inputMeta} />, fmtMs(e.durationMs), `${e.retryCount} / ${e.maxRetries}`, <StatusBadge status={e.status} />, <SourceBadge source={e.source} />, <TraceLink traceId={e.traceId} />],
  detail: e => (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <KeyVal k="Started">{fmtDateTime(e.startedAt)}</KeyVal>
        <KeyVal k="Ended">{fmtDateTime(e.endedAt)}</KeyVal>
        <KeyVal k="Request id"><span className="font-mono text-xs">{e.requestId ?? '-'}</span></KeyVal>
      </dl>
      <div className="grid gap-3 md:grid-cols-2">
        <div><div className="mb-1 text-xs font-medium uppercase text-slate-600 dark:text-slate-400">Input metadata</div><JsonBlock data={e.inputMeta} /></div>
        <div><div className="mb-1 text-xs font-medium uppercase text-slate-600 dark:text-slate-400">Output metadata</div><JsonBlock data={e.outputMeta} /></div>
      </div>
      {ERR(e)}
    </div>
  ),
};

const context: Spec<ContextEventDto> = {
  path: '/observability/context-events', dataset: 'context', statuses: ['SUCCESS', 'FAILURE'],
  hint: 'Context lifecycle events (created / updated / added / modified). Sizes and token estimates only.',
  head: ['Details', 'Time', 'Operation', 'Context source', 'Size', 'Est. tokens', 'Version', 'Duration', 'Status', 'Source', 'Trace'],
  cells: e => [fmtDateTime(e.createdAt), e.operation, e.contextSource, fmtBytes(e.sizeBytes), fmtInt(e.estimatedTokens), `v${e.version}`, fmtMs(e.durationMs), <StatusBadge status={e.status} />, <SourceBadge source={e.source} />, <TraceLink traceId={e.traceId} />],
  detail: e => (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <KeyVal k="Event id"><span className="font-mono text-xs">{e.id}</span></KeyVal>
        <KeyVal k="Context id"><span className="font-mono text-xs">{e.contextId}</span></KeyVal>
        <KeyVal k="Span id"><span className="font-mono text-xs">{e.spanId ?? '-'}</span></KeyVal>
      </dl>
      {ERR(e as never)}
    </div>
  ),
};

const SPECS = { memory, bus, tool, context } as unknown as Record<Kind, Spec<Common>>;

const INITIAL = { traceId: '', status: '', source: '', search: '', from: '', to: '' };

function EventTab({ kind, fixedTraceId, compact }: { kind: Kind; fixedTraceId?: string; compact?: boolean }) {
  const spec = SPECS[kind];
  const f = useFilters({ ...INITIAL, traceId: fixedTraceId ?? '' }, compact ? 10 : 25);
  const state = useList<Common>(spec.path, f.query);
  const showTrace = !fixedTraceId;
  // Hide the Trace column when scoped to a single trace (it is always the same trace).
  const head = showTrace ? spec.head : spec.head.slice(0, -1);
  return (
    <div data-testid={`event-panel-${kind}`}>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">{spec.hint}</p>
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        {showTrace && <TextFilter label="Trace id" value={f.filters.traceId} onChange={v => f.setFilter('traceId', v)} placeholder="trace id" testId="event-filter-trace" />}
        <SelectFilter label="Status" value={f.filters.status} onChange={v => f.setFilter('status', v)} options={spec.statuses} testId="event-filter-status" />
        <SelectFilter label="Source" value={f.filters.source} onChange={v => f.setFilter('source', v)} options={SOURCE_OPTIONS} testId="event-filter-source" />
        <TextFilter label="Search" type="search" value={f.filters.search} onChange={v => f.setFilter('search', v)} placeholder="name, id, category" testId="event-filter-search" className="min-w-[10rem]" />
        {!compact && <TextFilter label="From" type="date" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="event-filter-from" />}
        {!compact && <TextFilter label="To" type="date" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="event-filter-to" />}
        <div className="ml-auto flex gap-2 self-end"><ExportLinks dataset={spec.dataset} params={f.params} /></div>
      </FilterBar>
      <PagedTable state={state} testId="event-table" onPage={f.setPage} head={head}
        emptyMessage={fixedTraceId ? `No ${kind} events were recorded for this trace.` : `No ${kind} events match these filters. Run the simulator with agent activity to generate DEMO / SIMULATED events.`}
        row={e => (
          <ExpandableRow key={e.id} testId="event-row" tone={e.status === 'FAILURE' ? 'error' : undefined}
            cells={showTrace ? spec.cells(e, true) : spec.cells(e, false).slice(0, -1)} detail={spec.detail(e)} />
        )} />
    </div>
  );
}

/** Event explorer: Memory / Bus / Tool calls / Context tabs. Pass `traceId` to scope to one trace (compact mode). */
export default function EventExplorer({ traceId, compact }: { traceId?: string; compact?: boolean }) {
  const [tab, setTab] = useState<Kind>('memory');
  return (
    <div data-testid="event-explorer">
      <TabBar tabs={TABS} active={tab} onChange={setTab} testIdPrefix="event-tab" />
      <EventTab key={`${tab}:${traceId ?? ''}`} kind={tab} fixedTraceId={traceId} compact={compact} />
    </div>
  );
}
