import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TraceDetail, TraceDto } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs } from '../../lib/format';
import { SourceBadge, StatusBadge } from '../ui/Badge';
import { EmptyState } from '../ui/Table';
import { ErrorBox, Loading } from '../ui/State';
import ProjectSelect from '../activity/ProjectSelect';
import { Field, SelectFilter, useFilters, useList } from '../observability/common';
import { inputCls } from '../ui/Button';
import ExecutionTimeline from './ExecutionTimeline';

const INITIAL = { status: '', projectId: '' };
const PAGE_SIZE = 10;

/**
 * Trace explorer for the Observability dashboard (spec: execution timeline + trace explorer).
 * Pick a recent trace (filter by project / status) and its ExecutionTimeline renders next to the list.
 * Reuses GET /traces (list) and GET /traces/:id (detail with the merged timeline); nothing new on the backend.
 */
export default function TraceExplorer({ from, reloadKey = 0 }: { from?: string; reloadKey?: number }) {
  const f = useFilters(INITIAL, PAGE_SIZE);
  const list = useList<TraceDto>('/traces', { ...f.query, ...(from ? { from } : {}) }, [reloadKey]);
  const [selected, setSelected] = useState('');
  const rows = list.data?.data ?? [];

  // keep a valid selection: default to the newest trace of the current list, drop it when the filters exclude it
  useEffect(() => {
    if (!list.data) return;
    if (rows.length === 0) { if (selected) setSelected(''); return; }
    if (!rows.some(t => t.traceId === selected)) setSelected(rows[0].traceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  const detail = useAsync<TraceDetail | undefined>(
    async () => (selected ? api.get<TraceDetail>(`/traces/${encodeURIComponent(selected)}`) : undefined), [selected, reloadKey]);
  const pagination = list.data?.pagination;

  return (
    <div data-testid="trace-explorer" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3" role="search">
        <SelectFilter label="Status" value={f.filters.status} onChange={v => f.setFilter('status', v)} options={['RUNNING', 'OK', 'ERROR']} testId="explorer-filter-status" />
        <ProjectSelect value={f.filters.projectId} onChange={v => f.setFilter('projectId', v)} testId="explorer-filter-project" />
        {f.dirty && (
          <Field label="Filters">
            <button type="button" className={`${inputCls} text-left`} onClick={f.reset} data-testid="explorer-filter-reset">Reset filters</button>
          </Field>
        )}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0" aria-busy={list.loading}>
          {list.error ? <ErrorBox error={list.error} />
            : !list.data ? <Loading variant="lines" />
              : rows.length === 0 ? <EmptyState message="No traces match these filters." />
                : (
                  <>
                    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800" data-testid="explorer-trace-list">
                      {rows.map(t => (
                        <li key={t.traceId}>
                          <button type="button" aria-pressed={t.traceId === selected} onClick={() => setSelected(t.traceId)}
                            data-testid="explorer-trace" data-trace-id={t.traceId} data-status={t.status}
                            className={`flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 ${t.traceId === selected ? 'bg-brand-50 dark:bg-slate-800' : ''}`}>
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{t.name}</span><StatusBadge status={t.status} /><SourceBadge source={t.source} />
                            </span>
                            <span className="break-words text-xs text-slate-600 dark:text-slate-400">
                              {fmtDateTime(t.startedAt)} - {t.durationMs === null ? (t.status === 'RUNNING' ? 'running' : '-') : fmtMs(t.durationMs)} - {fmtInt(t.spanCount)} spans
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {pagination && pagination.totalPages > 1 && (
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400" data-testid="explorer-pagination">
                        <button type="button" className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50 dark:border-slate-700" disabled={f.page <= 1} onClick={() => f.setPage(f.page - 1)}>Previous</button>
                        <span>Page {pagination.page} of {pagination.totalPages} ({fmtInt(pagination.total)} traces)</span>
                        <button type="button" className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50 dark:border-slate-700" disabled={f.page >= pagination.totalPages} onClick={() => f.setPage(f.page + 1)}>Next</button>
                      </div>
                    )}
                  </>
                )}
        </div>

        <div className="min-w-0" data-testid="explorer-detail">
          {!selected ? <p className="p-4 text-sm text-slate-600 dark:text-slate-400">Select a trace to see its execution timeline.</p>
            : detail.error ? <ErrorBox error={detail.error} />
              : !detail.data ? <Loading variant="lines" />
                : (
                  <div data-testid="explorer-selected" data-trace-id={detail.data.trace.traceId}>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold" data-testid="explorer-selected-name">{detail.data.trace.name}</h3>
                      <StatusBadge status={detail.data.trace.status} /><SourceBadge source={detail.data.trace.source} />
                      <Link to={`/traces/${encodeURIComponent(detail.data.trace.traceId)}`} className="ml-auto text-xs text-brand-600 hover:underline dark:text-brand-100" data-testid="explorer-open-trace">Open full trace</Link>
                    </div>
                    {detail.data.trace.errorMessage && (
                      <p className="mb-3 break-words rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert" data-testid="explorer-trace-error">{detail.data.trace.errorMessage}</p>
                    )}
                    <ExecutionTimeline entries={detail.data.timeline} />
                  </div>
                )}
        </div>
      </div>
    </div>
  );
}
