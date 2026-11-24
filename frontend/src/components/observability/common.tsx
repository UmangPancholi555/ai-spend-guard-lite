import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LogLevel, Pagination } from '@shared/types';
import { api } from '../../lib/api';
import type { Query } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { Badge, StatusBadge } from '../ui/Badge';
import { DownloadLink, inputCls } from '../ui/Button';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ErrorBox, Loading } from '../ui/State';
import { EmptyState, PaginationBar, Table, Td } from '../ui/Table';

// ---------------------------------------------------------------- hooks

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** `from` / `to` filter values are YYYY-MM-DD from <input type=date>; the API wants ISO (to is inclusive). */
export function toApiParams(filters: Record<string, string>): Query {
  const out: Query = {};
  for (const [k, v] of Object.entries(filters)) {
    if (!v) continue;
    if (k === 'from') out.from = new Date(`${v}T00:00:00`).toISOString();
    else if (k === 'to') out.to = new Date(`${v}T23:59:59.999`).toISOString();
    else out[k] = v.trim();
  }
  return out;
}

/** Filter state + pagination. Changing a filter resets to page 1; requests are debounced. */
export function useFilters<T extends Record<string, string>>(initial: T, pageSize = 25) {
  const [filters, setFilters] = useState<T>(initial);
  const [page, setPage] = useState(1);
  const setFilter = useCallback((k: keyof T, v: string) => {
    setFilters(f => ({ ...f, [k]: v }));
    setPage(1);
  }, []);
  const replace = useCallback((patch: Partial<T>) => {
    setFilters(f => ({ ...f, ...patch }));
    setPage(1);
  }, []);
  const reset = useCallback(() => { setFilters(initial); setPage(1); }, [initial]);
  const combined = useMemo(() => ({ filters, page }), [filters, page]);
  const debounced = useDebounced(combined, 250);
  const params = useMemo(() => toApiParams(debounced.filters), [debounced.filters]);
  const query = useMemo<Query>(() => ({ ...params, page: debounced.page, pageSize }), [params, debounced.page, pageSize]);
  const dirty = useMemo(() => Object.keys(initial).some(k => filters[k] !== initial[k]), [filters, initial]);
  return { filters, setFilter, replace, reset, page, setPage, params, query, dirty };
}

export function useList<T>(path: string, query: Query, extraDeps: unknown[] = []) {
  return useAsync(() => api.list<T>(path, query), [path, JSON.stringify(query), ...extraDeps]);
}

// ---------------------------------------------------------------- filter controls

export function FilterBar({ children, onReset, dirty }: { children: ReactNode; onReset?: () => void; dirty?: boolean }) {
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-end gap-3" role="search" data-testid="filter-bar">
        {children}
        {onReset && <Button variant="ghost" type="button" onClick={onReset} disabled={!dirty} data-testid="filter-reset">Reset filters</Button>}
      </div>
    </Card>
  );
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-[8rem] flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 ${className}`}>
      {label}
      {children}
    </label>
  );
}

export function TextFilter({ label, value, onChange, placeholder, testId, type = 'text', className }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; testId?: string; type?: 'text' | 'date' | 'search'; className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <input className={inputCls} type={type} value={value} placeholder={placeholder} data-testid={testId} onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

export type Opt = string | { value: string; label: string };
export function SelectFilter({ label, value, onChange, options, allLabel = 'All', testId }: {
  label: string; value: string; onChange: (v: string) => void; options: Opt[]; allLabel?: string; testId?: string;
}) {
  return (
    <Field label={label}>
      <select className={inputCls} value={value} data-testid={testId} onChange={e => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map(o => {
          const v = typeof o === 'string' ? o : o.value;
          const l = typeof o === 'string' ? o : o.label;
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </Field>
  );
}

export function ExportLinks({ dataset, params, formats = ['jsonl', 'csv'] }: { dataset: string; params?: Query; formats?: ('jsonl' | 'csv')[] }) {
  return (
    <>
      {formats.map(format => (
        <DownloadLink key={format} href={api.url(`/export/${dataset}`, { ...params, format })}>
          <span data-testid={`export-${dataset}-${format}`}>Export {format.toUpperCase()}</span>
        </DownloadLink>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- display bits

export const SOURCE_OPTIONS: Opt[] = [
  { value: 'ACTUAL', label: 'ACTUAL (instrumented)' },
  { value: 'SIMULATED', label: 'DEMO / SIMULATED' },
];

export function LevelBadge({ level }: { level: LogLevel }) {
  const tone = level === 'ERROR' || level === 'CRITICAL' ? 'red' : level === 'WARN' ? 'amber' : level === 'DEBUG' ? 'slate' : 'blue';
  return <Badge tone={tone}>{level}</Badge>;
}

export { StatusBadge };

export function TraceLink({ traceId }: { traceId: string | null | undefined }) {
  if (!traceId) return <span className="text-slate-600 dark:text-slate-400">-</span>;
  return (
    <Link to={`/traces/${encodeURIComponent(traceId)}`} title={traceId} data-testid="trace-link"
      className="inline-block max-w-[9rem] truncate align-bottom font-mono text-xs text-brand-600 hover:underline dark:text-brand-100">
      {traceId}
    </Link>
  );
}

export function JsonBlock({ data, testId, label }: { data: unknown; testId?: string; label?: string }) {
  return (
    <pre data-testid={testId} aria-label={label} className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-100 p-2 font-mono text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function StackBlock({ stack, testId }: { stack: string | null | undefined; testId?: string }) {
  if (!stack) return null;
  return (
    <pre data-testid={testId} className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-red-50 p-2 font-mono text-xs text-red-900 dark:bg-red-950/60 dark:text-red-200">{stack}</pre>
  );
}

export function Meta({ data, max = 60 }: { data: Record<string, unknown> | null | undefined; max?: number }) {
  if (!data || Object.keys(data).length === 0) return <span className="text-slate-600 dark:text-slate-400">-</span>;
  const s = JSON.stringify(data);
  return <span className="font-mono text-xs" title={s}>{s.length > max ? `${s.slice(0, max)}...` : s}</span>;
}

export function KeyVal({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">{k}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function fmtDateTimeMs(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function TabBar<K extends string>({ tabs, active, onChange, testIdPrefix }: {
  tabs: { key: K; label: string }[]; active: K; onChange: (k: K) => void; testIdPrefix: string;
}) {
  return (
    <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map(t => (
        <button key={t.key} role="tab" type="button" aria-selected={active === t.key} data-testid={`${testIdPrefix}-${t.key}`}
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${active === t.key ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tables

/** Table row with an expand toggle and a detail row. `cells` are rendered in <Td>. */
export function ExpandableRow({ cells, detail, testId, tone }: { cells: ReactNode[]; detail: ReactNode; testId: string; tone?: 'error' }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr data-testid={testId} className={tone === 'error' ? 'bg-red-50/60 dark:bg-red-950/20' : undefined}>
        <Td>
          <button type="button" aria-expanded={open} aria-label={open ? 'Collapse details' : 'Expand details'} data-testid={`${testId}-toggle`}
            onClick={() => setOpen(o => !o)} className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            {open ? '▾' : '▸'}
          </button>
        </Td>
        {cells.map((c, i) => <Td key={i}>{c}</Td>)}
      </tr>
      {open && (
        <tr data-testid={`${testId}-detail`}>
          <td colSpan={cells.length + 1} className="bg-slate-50 px-4 py-3 dark:bg-slate-950/40">{detail}</td>
        </tr>
      )}
    </Fragment>
  );
}

interface ListState<T> { data: { data: T[]; pagination: Pagination } | undefined; error: Error | undefined; loading: boolean }

/** Table + loading/error/empty + pagination for list endpoints. `row` returns <tr> element(s). */
export function PagedTable<T>({ state, head, row, onPage, emptyMessage, emptyAction, testId }: {
  state: ListState<T>; head: string[]; row: (item: T) => ReactNode; onPage: (n: number) => void; emptyMessage: string; emptyAction?: ReactNode; testId?: string;
}) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (!state.data) return <Loading />;
  const { data, pagination } = state.data;
  return (
    <div data-testid={testId} aria-busy={state.loading} className={state.loading ? 'opacity-60 transition-opacity' : undefined}>
      <Table head={head} empty={data.length === 0 ? <EmptyState message={emptyMessage} action={emptyAction} /> : undefined}>
        {data.map(row)}
      </Table>
      <PaginationBar p={pagination} onPage={onPage} />
    </div>
  );
}
