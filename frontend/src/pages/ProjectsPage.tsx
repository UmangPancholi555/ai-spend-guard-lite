import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectWithUsage } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, inputCls } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { EmptyState, PaginationBar, Table, Td } from '../components/ui/Table';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtInt, fmtUsd } from '../lib/format';
import { Modal, ConfirmDialog } from '../components/projects/Modal';
import ProjectForm from '../components/projects/ProjectForm';
import { errMessage, slugify } from '../components/projects/util';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; project: ProjectWithUsage }
  | { kind: 'delete'; project: ProjectWithUsage }
  | null;

export default function ProjectsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'ARCHIVED'>('');
  const [includeTest, setIncludeTest] = useState(true);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [actionError, setActionError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const list = useAsync(
    () => api.list<ProjectWithUsage>('/projects', { status: status || undefined, includeTest, search, page, pageSize: 25 }),
    [status, includeTest, search, page],
  );

  async function toggleArchive(p: ProjectWithUsage) {
    setActionError(undefined); setBusyId(p.id);
    try { await api.post(`/projects/${p.id}/${p.status === 'ACTIVE' ? 'archive' : 'unarchive'}`); list.reload(); }
    catch (e) { setActionError(`${p.name}: ${errMessage(e)}`); }
    finally { setBusyId(undefined); }
  }

  async function confirmDelete(p: ProjectWithUsage) {
    setDeleteBusy(true); setDeleteError(undefined);
    try { await api.del(`/projects/${p.id}`); setDialog(null); list.reload(); }
    catch (e) { setDeleteError(errMessage(e)); }
    finally { setDeleteBusy(false); }
  }

  const rows = list.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Simulated usage and cost per project (DEMO / SIMULATED data)."
        actions={<Button onClick={() => setDialog({ kind: 'create' })} data-testid="project-create-open">New project</Button>}
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="project-search" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Search</label>
            <input id="project-search" type="search" className={`${inputCls} w-full`} placeholder="Project name" value={searchInput} onChange={e => setSearchInput(e.target.value)} data-testid="project-search" />
          </div>
          <div>
            <label htmlFor="project-status" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Status</label>
            <select id="project-status" className={inputCls} value={status} onChange={e => { setStatus(e.target.value as typeof status); setPage(1); }} data-testid="project-status-filter">
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm">
            <input type="checkbox" checked={includeTest} onChange={e => { setIncludeTest(e.target.checked); setPage(1); }} data-testid="project-include-test" />
            Include test projects
          </label>
        </div>
      </Card>

      {actionError && <p role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="project-action-error">{actionError}</p>}

      <Async loading={list.loading && !list.data} error={list.error}>
        <Table
          head={['Project', 'Status', 'Requests', 'Failures', 'Tokens (in / out / cached)', 'Cost (simulated)', 'Last activity', 'Actions']}
          empty={rows.length === 0 ? <EmptyState message="No projects match. Create one, or seed demo data from the Request Simulator." /> : undefined}
        >
          {rows.map(p => {
            const slug = slugify(p.name);
            const busy = busyId === p.id;
            return (
              <tr key={p.id} data-testid={`project-row-${slug}`} className="align-top">
                <Td className="whitespace-normal">
                  <Link to={`/projects/${p.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-100" data-testid={`project-link-${slug}`}>{p.name}</Link>
                  {p.isTest && <span className="ml-2"><Badge tone="blue">test</Badge></span>}
                  {p.description && <div className="max-w-xs truncate text-xs text-slate-500 dark:text-slate-400" title={p.description}>{p.description}</div>}
                </Td>
                <Td><Badge tone={p.status === 'ACTIVE' ? 'green' : 'slate'}>{p.status}</Badge></Td>
                <Td>{fmtInt(p.usage.requests)}</Td>
                <Td>{p.usage.failures > 0 ? <span className="text-red-600 dark:text-red-400">{fmtInt(p.usage.failures)}</span> : 0}</Td>
                <Td>{fmtInt(p.usage.inputTokens)} / {fmtInt(p.usage.outputTokens)} / {fmtInt(p.usage.cachedTokens)}</Td>
                <Td><span title="DEMO / SIMULATED cost">{fmtUsd(p.usage.costUsd)}</span></Td>
                <Td>{fmtDateTime(p.usage.lastActivityAt)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={() => setDialog({ kind: 'edit', project: p })} data-testid={`project-edit-${slug}`}>Edit</Button>
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => toggleArchive(p)} data-testid={`project-${p.status === 'ACTIVE' ? 'archive' : 'unarchive'}-${slug}`}>
                      {p.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                    </Button>
                    <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={!p.isTest || busy} title={p.isTest ? 'Delete this test project and its usage data' : 'Only test projects can be deleted'}
                      onClick={() => { setDeleteError(undefined); setDialog({ kind: 'delete', project: p }); }} data-testid={`project-delete-${slug}`}>Delete</Button>
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
        {list.data && list.data.pagination.total > 0 && <PaginationBar p={list.data.pagination} onPage={setPage} />}
      </Async>

      {dialog?.kind === 'create' && (
        <Modal title="New project" onClose={() => setDialog(null)} testId="project-create-dialog">
          <ProjectForm mode="create" onCancel={() => setDialog(null)} onSubmit={async v => {
            await api.post('/projects', { name: v.name, ...(v.description ? { description: v.description } : {}), isTest: v.isTest });
            setDialog(null); setPage(1); list.reload();
          }} />
        </Modal>
      )}
      {dialog?.kind === 'edit' && (
        <Modal title={`Edit ${dialog.project.name}`} onClose={() => setDialog(null)} testId="project-edit-dialog">
          <ProjectForm mode="edit" initial={dialog.project} onCancel={() => setDialog(null)} onSubmit={async v => {
            await api.patch(`/projects/${dialog.project.id}`, { name: v.name, description: v.description || null, isTest: v.isTest });
            setDialog(null); list.reload();
          }} />
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete test project?"
          message={<>This permanently deletes <strong>{dialog.project.name}</strong> together with its usage events, budgets and alerts. This cannot be undone.</>}
          confirmLabel="Delete project"
          busy={deleteBusy}
          error={deleteError}
          confirmTestId="project-delete-confirm"
          cancelTestId="project-delete-cancel"
          onCancel={() => setDialog(null)}
          onConfirm={() => confirmDelete(dialog.project)}
        />
      )}
    </div>
  );
}
