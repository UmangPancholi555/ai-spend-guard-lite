import type { ActivityEventDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { LinkButton } from '../components/ui/Button';
import { SourceBadge } from '../components/ui/Badge';
import ProjectSelect from '../components/activity/ProjectSelect';
import {
  ExpandableRow, ExportLinks, FilterBar, JsonBlock, KeyVal, LevelBadge, PagedTable, SOURCE_OPTIONS, SelectFilter, TextFilter, TraceLink, useFilters, useList,
} from '../components/observability/common';
import { fmtDateTime } from '../lib/format';

const INITIAL = { type: '', level: '', source: '', projectId: '', search: '', from: '', to: '' };

export default function ActivityPage() {
  const f = useFilters(INITIAL);
  const state = useList<ActivityEventDto>('/activity', f.query);
  return (
    <div>
      <PageHeader title="Activity" subtitle="Persistent feed of everything the app recorded: project changes, usage, budget alerts and requests. Each event is labelled ACTUAL (emitted by a real component of this app) or DEMO / SIMULATED."
        actions={<ExportLinks dataset="activity" params={f.params} />} />
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        <TextFilter label="Type" value={f.filters.type} onChange={v => f.setFilter('type', v)} placeholder="e.g. usage.recorded" testId="activity-filter-type" />
        <SelectFilter label="Level" value={f.filters.level} onChange={v => f.setFilter('level', v)} options={['INFO', 'WARN', 'ERROR', 'CRITICAL']} testId="activity-filter-level" />
        <SelectFilter label="Source" value={f.filters.source} onChange={v => f.setFilter('source', v)} options={SOURCE_OPTIONS} testId="activity-filter-source" />
        <ProjectSelect value={f.filters.projectId} onChange={v => f.setFilter('projectId', v)} testId="activity-filter-project" />
        <TextFilter label="Search" type="search" value={f.filters.search} onChange={v => f.setFilter('search', v)} placeholder="message, type, request id" testId="activity-filter-search" className="min-w-[12rem]" />
        <TextFilter label="From" type="date" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="activity-filter-from" />
        <TextFilter label="To" type="date" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="activity-filter-to" />
      </FilterBar>
      <Card>
        <PagedTable state={state} testId="activity-table" onPage={f.setPage} emptyMessage="No activity events match these filters." emptyAction={!f.dirty && <LinkButton to="/projects" testId="activity-empty-cta">Go to Projects</LinkButton>}
          head={['Details', 'Time', 'Level', 'Type', 'Message', 'Source', 'Project', 'Trace']}
          row={e => (
            <ExpandableRow key={e.id} testId="activity-row" tone={e.level === 'ERROR' ? 'error' : undefined}
              cells={[
                fmtDateTime(e.createdAt),
                <LevelBadge level={e.level} />,
                <span className="font-mono text-xs" data-testid="activity-type">{e.type}</span>,
                <span className="block max-w-md truncate" title={e.message}>{e.message}</span>,
                <SourceBadge source={e.source} />,
                e.projectName ?? (e.projectId ? e.projectId : '-'),
                <TraceLink traceId={e.traceId} />,
              ]}
              detail={(
                <div className="space-y-3">
                  <dl className="grid gap-3 sm:grid-cols-3">
                    <KeyVal k="Event id"><span className="font-mono text-xs">{e.id}</span></KeyVal>
                    <KeyVal k="Request id"><span className="font-mono text-xs">{e.requestId ?? '-'}</span></KeyVal>
                    <KeyVal k="Message">{e.message}</KeyVal>
                  </dl>
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Metadata (no content, metadata only)</div>
                    <JsonBlock data={e.metadata} testId="activity-metadata" />
                  </div>
                </div>
              )} />
          )} />
      </Card>
    </div>
  );
}
