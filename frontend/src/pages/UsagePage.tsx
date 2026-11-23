import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ProjectWithUsage, UsageEventDto, UsageFilterOptions } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button, DownloadLink, inputCls } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { EmptyState, PaginationBar, Table, Td } from '../components/ui/Table';
import { LinkButton } from '../components/ui/Button';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs, fmtUsd } from '../lib/format';
import DemoBanner from '../components/dashboard/DemoBanner';
import RequestDrawer from '../components/usage/RequestDrawer';

const FILTER_KEYS = ['search', 'provider', 'model', 'projectId', 'status', 'from', 'to', 'sort', 'order'] as const;
type FilterKey = typeof FILTER_KEYS[number];
const labelCls = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

const dayStart = (d: string) => (d ? `${d}T00:00:00.000Z` : undefined);
const dayEnd = (d: string) => (d ? `${d}T23:59:59.999Z` : undefined);

export default function UsagePage() {
  const [sp, setSp] = useSearchParams();
  const get = (k: FilterKey) => sp.get(k) ?? '';
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const detail = sp.get('detail');

  function patch(changes: Partial<Record<FilterKey | 'page' | 'detail', string | null>>, resetPage = true) {
    setSp(prev => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) { if (v) n.set(k, v); else n.delete(k); }
      if (resetPage && !('page' in changes)) n.delete('page');
      return n;
    }, { replace: true });
  }

  // debounced search box mirrored into the URL
  const [searchInput, setSearchInput] = useState(get('search'));
  useEffect(() => {
    if (searchInput === get('search')) return;
    const t = setTimeout(() => patch({ search: searchInput || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const filters = useAsync(() => api.get<UsageFilterOptions>('/usage/filters'), []);
  const projects = useAsync(() => api.list<ProjectWithUsage>('/projects', { pageSize: 200, includeTest: true }), []);

  const provider = get('provider');
  const modelOptions = useMemo(() => {
    const ms = filters.data?.models ?? [];
    return [...new Set(ms.filter(m => !provider || m.provider === provider).map(m => m.model))].sort();
  }, [filters.data, provider]);

  const query = {
    search: get('search'), provider, model: get('model'), projectId: get('projectId'), status: get('status'),
    from: dayStart(get('from')), to: dayEnd(get('to')),
    sort: get('sort') || 'createdAt', order: get('order') || 'desc',
  };
  const list = useAsync(() => api.list<UsageEventDto>('/usage', { ...query, page, pageSize: 25 }), [sp.toString()]);
  const rows = list.data?.data ?? [];
  const exportHref = api.url('/usage/export.csv', query);
  const hasFilters = FILTER_KEYS.some(k => k !== 'sort' && k !== 'order' && get(k));

  const openRow = (id: string) => patch({ detail: id }, false);

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="Every simulated provider request with tokens, cost and status."
        actions={<DownloadLink href={exportHref}><span data-testid="usage-export">Export CSV</span></DownloadLink>}
      />
      <DemoBanner />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="usage-search" className={labelCls}>Search</label>
            <input id="usage-search" type="search" className={`${inputCls} w-full`} placeholder="Request ID, model, provider, project, error, trace" value={searchInput} onChange={e => setSearchInput(e.target.value)} data-testid="usage-search" />
          </div>
          <div>
            <label htmlFor="usage-provider" className={labelCls}>Provider</label>
            <select id="usage-provider" className={`${inputCls} w-full`} value={provider} onChange={e => patch({ provider: e.target.value || null, model: null })} data-testid="usage-provider">
              <option value="">All providers</option>
              {(filters.data?.providers ?? []).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="usage-model" className={labelCls}>Model</label>
            <select id="usage-model" className={`${inputCls} w-full`} value={get('model')} onChange={e => patch({ model: e.target.value || null })} data-testid="usage-model">
              <option value="">All models</option>
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="usage-project" className={labelCls}>Project</label>
            <select id="usage-project" className={`${inputCls} w-full`} value={get('projectId')} onChange={e => patch({ projectId: e.target.value || null })} data-testid="usage-project">
              <option value="">All projects</option>
              {(projects.data?.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.status === 'ARCHIVED' ? ' (archived)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="usage-status" className={labelCls}>Status</label>
            <select id="usage-status" className={`${inputCls} w-full`} value={get('status')} onChange={e => patch({ status: e.target.value || null })} data-testid="usage-status">
              <option value="">All</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </select>
          </div>
          <div>
            <label htmlFor="usage-from" className={labelCls}>From (UTC date)</label>
            <input id="usage-from" type="date" className={`${inputCls} w-full`} value={get('from')} max={get('to') || undefined} onChange={e => patch({ from: e.target.value || null })} data-testid="usage-from" />
          </div>
          <div>
            <label htmlFor="usage-to" className={labelCls}>To (UTC date, inclusive)</label>
            <input id="usage-to" type="date" className={`${inputCls} w-full`} value={get('to')} min={get('from') || undefined} onChange={e => patch({ to: e.target.value || null })} data-testid="usage-to" />
          </div>
          <div>
            <label htmlFor="usage-sort" className={labelCls}>Sort by</label>
            <select id="usage-sort" className={`${inputCls} w-full`} value={query.sort} onChange={e => patch({ sort: e.target.value === 'createdAt' ? null : e.target.value })} data-testid="usage-sort">
              <option value="createdAt">Time</option>
              <option value="costUsd">Cost</option>
              <option value="durationMs">Duration</option>
            </select>
          </div>
          <div>
            <label htmlFor="usage-order" className={labelCls}>Order</label>
            <select id="usage-order" className={`${inputCls} w-full`} value={query.order} onChange={e => patch({ order: e.target.value === 'desc' ? null : e.target.value })} data-testid="usage-order">
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button variant="secondary" disabled={!hasFilters && !searchInput} onClick={() => { setSearchInput(''); setSp(new URLSearchParams(), { replace: true }); }} data-testid="usage-clear">Clear filters</Button>
          </div>
        </div>
        {filters.error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">Could not load filter options: {filters.error.message}</p>}
      </Card>

      <Async loading={list.loading && !list.data} error={list.error} skeleton="table">
        <Table
          head={['Time', 'Project', 'Provider / model', 'Status', 'In', 'Out', 'Cached', 'Cost', 'Class', 'Duration']}
          empty={rows.length === 0 ? <EmptyState message={hasFilters ? 'No usage events match these filters.' : 'No usage recorded yet. Send a request from the Request Simulator or generate demo data on the Dashboard.'} action={!hasFilters && <LinkButton to="/simulator" testId="usage-empty-cta">Open Request Simulator</LinkButton>} /> : undefined}
        >
          {rows.map(u => (
            <tr key={u.id} tabIndex={0}
              className="cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none dark:hover:bg-slate-800/60 dark:focus:bg-slate-800/60"
              onClick={() => openRow(u.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(u.id); } }} data-testid="usage-row">
              <Td>{fmtDateTime(u.createdAt)}</Td>
              <Td>{u.projectName ?? u.projectId}</Td>
              <Td>{u.provider} / <span className="font-medium">{u.model}</span></Td>
              <Td><StatusBadge status={u.status} /></Td>
              <Td>{fmtInt(u.inputTokens)}</Td><Td>{fmtInt(u.outputTokens)}</Td><Td>{fmtInt(u.cachedTokens)}</Td>
              <Td>{fmtUsd(u.costUsd)}</Td>
              <Td><Badge tone={u.costClass === 'ESTIMATED' ? 'amber' : 'blue'}>{u.costClass}</Badge></Td>
              <Td>{fmtMs(u.durationMs)}</Td>
            </tr>
          ))}
        </Table>
        {list.data && list.data.pagination.total > 0 && <PaginationBar p={list.data.pagination} onPage={n => patch({ page: n > 1 ? String(n) : null }, false)} />}
      </Async>

      {detail && <RequestDrawer id={detail} onClose={() => patch({ detail: null }, false)} />}
    </div>
  );
}
