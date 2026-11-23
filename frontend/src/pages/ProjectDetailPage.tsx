import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ActivityEventDto, BudgetDto, BudgetUtilization, ProjectWithUsage, UsageEventDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card, StatCard } from '../components/ui/Card';
import { Badge, SourceBadge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { EmptyState, PaginationBar, Table, Td } from '../components/ui/Table';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs, fmtPct, fmtUsd } from '../lib/format';
import DemoBanner from '../components/dashboard/DemoBanner';
import { UtilizationBar } from '../components/dashboard/UtilizationBar';
import { ConfirmDialog, Modal } from '../components/projects/Modal';
import ProjectForm from '../components/projects/ProjectForm';
import { errMessage } from '../components/projects/util';
import { useToast } from '../components/ui/Toast';
import MemoryPanel from '../components/memory/MemoryPanel';

export default function ProjectDetailPage() {
  const toast = useToast();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actPage, setActPage] = useState(1);

  const proj = useAsync(() => api.get<ProjectWithUsage>(`/projects/${encodeURIComponent(id)}`), [id]);
  const activity = useAsync(() => api.list<ActivityEventDto>(`/projects/${encodeURIComponent(id)}/activity`, { page: actPage, pageSize: 10 }), [id, actPage]);
  const usage = useAsync(() => api.list<UsageEventDto>('/usage', { projectId: id, pageSize: 10 }), [id]);
  const budgets = useAsync(() => api.get<BudgetDto[]>('/budgets', { projectId: id }), [id]);
  const util = useAsync(() => api.get<BudgetUtilization[]>('/budgets/utilization', { projectId: id }), [id]);

  const p = proj.data;

  function reloadAll() { proj.reload(); activity.reload(); usage.reload(); budgets.reload(); util.reload(); }

  async function toggleArchive() {
    if (!p) return;
    setBusy(true); setActionError(undefined);
    try { await api.post(`/projects/${p.id}/${p.status === 'ACTIVE' ? 'archive' : 'unarchive'}`); toast.success(p.status === 'ACTIVE' ? `Archived "${p.name}"` : `Restored "${p.name}"`); reloadAll(); }
    catch (e) { setActionError(errMessage(e)); toast.error('Could not update project', errMessage(e)); }
    finally { setBusy(false); }
  }

  async function doDelete() {
    if (!p) return;
    setBusy(true); setActionError(undefined);
    try { await api.del(`/projects/${p.id}`); toast.success(`Deleted "${p.name}"`); nav('/projects'); }
    catch (e) { setActionError(errMessage(e)); setBusy(false); }
  }

  const utilById = new Map((util.data ?? []).map(u => [u.budget.id, u]));
  const budgetOnly = (budgets.data ?? []).filter(b => !utilById.has(b.id));

  return (
    <div>
      <div className="mb-2 text-sm"><Link to="/projects" className="text-brand-600 hover:underline dark:text-brand-100" data-testid="back-to-projects">&larr; All projects</Link></div>
      <Async loading={proj.loading && !p} error={proj.error}>
        {p && (
          <>
            <PageHeader
              title={p.name}
              subtitle={p.description ?? 'No description'}
              actions={<>
                <Badge tone={p.status === 'ACTIVE' ? 'green' : 'slate'}>{p.status}</Badge>
                {p.isTest && <Badge tone="blue">test</Badge>}
                <Button variant="secondary" onClick={() => setEditing(true)} data-testid="project-detail-edit">Edit</Button>
                <Button variant="secondary" onClick={toggleArchive} disabled={busy} data-testid="project-detail-archive">{p.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}</Button>
                <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={!p.isTest || busy} title={p.isTest ? 'Delete this test project' : 'Only test projects can be deleted'} data-testid="project-detail-delete">Delete</Button>
              </>}
            />
            <DemoBanner />
            {actionError && <p role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="project-detail-error">{actionError}</p>}
            {p.status === 'ARCHIVED' && <p className="mb-3 rounded-md border border-slate-300 bg-slate-50 p-2 text-sm dark:border-slate-700 dark:bg-slate-900">This project is archived and rejects new provider requests. Unarchive it to send more simulated traffic.</p>}

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
              <StatCard label="Simulated cost" value={fmtUsd(p.usage.costUsd)} hint="DEMO / SIMULATED" testId="project-total-cost" />
              <StatCard label="Requests" value={fmtInt(p.usage.requests)} testId="project-total-requests" />
              <StatCard label="Success rate" value={p.usage.requests ? fmtPct((p.usage.successes / p.usage.requests) * 100) : '-'} hint={`${fmtInt(p.usage.failures)} failed`} testId="project-success-rate" />
              <StatCard label="Input tokens" value={fmtInt(p.usage.inputTokens)} testId="project-input-tokens" />
              <StatCard label="Output tokens" value={fmtInt(p.usage.outputTokens)} testId="project-output-tokens" />
              <StatCard label="Cached tokens" value={fmtInt(p.usage.cachedTokens)} testId="project-cached-tokens" />
            </div>
            <p className="mb-4 text-xs text-slate-600 dark:text-slate-400">
              Created {fmtDateTime(p.createdAt)} - updated {fmtDateTime(p.updatedAt)}{p.archivedAt ? ` - archived ${fmtDateTime(p.archivedAt)}` : ''} - last activity {fmtDateTime(p.usage.lastActivityAt)}
            </p>

            <div className="space-y-4">
              <Card title="Budgets" actions={<Link to="/budgets" className="text-sm text-brand-600 hover:underline dark:text-brand-100" data-testid="project-budgets-link">Manage on Budgets page</Link>}>
                <Async loading={(budgets.loading && !budgets.data) || (util.loading && !util.data)} error={budgets.error}>
                  {(budgets.data ?? []).length === 0 && (util.data ?? []).length === 0 ? (
                    <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="project-budgets-empty">No budgets for this project.</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="project-budgets">
                        {(util.data ?? []).map(u => <UtilizationBar key={u.budget.id} u={u} showProject={false} />)}
                      </ul>
                      {budgetOnly.length > 0 && (
                        <ul className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                          {budgetOnly.map(b => <li key={b.id}>{b.name} - {b.period} - limit {fmtUsd(b.limitUsd)} {!b.active && <Badge>inactive</Badge>}</li>)}
                        </ul>
                      )}
                    </>
                  )}
                </Async>
              </Card>

              <MemoryPanel projectId={p.id} />

              <Card title="Recent usage" actions={<Link to={`/usage?projectId=${encodeURIComponent(p.id)}`} className="text-sm text-brand-600 hover:underline dark:text-brand-100" data-testid="project-usage-link">All usage for this project</Link>}>
                <Async loading={usage.loading && !usage.data} error={usage.error} skeleton="table">
                  <Table head={['Time', 'Provider / model', 'Status', 'Tokens in / out', 'Cost', 'Duration', '']}
                    empty={(usage.data?.data.length ?? 0) === 0 ? <EmptyState message="No usage for this project yet." /> : undefined}>
                    {(usage.data?.data ?? []).map(u => (
                      <tr key={u.id} data-testid="project-usage-row">
                        <Td>{fmtDateTime(u.createdAt)}</Td>
                        <Td>{u.provider} / {u.model}</Td>
                        <Td><StatusBadge status={u.status} /></Td>
                        <Td>{fmtInt(u.inputTokens)} / {fmtInt(u.outputTokens)}</Td>
                        <Td>{fmtUsd(u.costUsd)}</Td>
                        <Td>{fmtMs(u.durationMs)}</Td>
                        <Td><Link to={`/usage?detail=${encodeURIComponent(u.id)}`} className="text-brand-600 underline dark:text-brand-100">details</Link></Td>
                      </tr>
                    ))}
                  </Table>
                </Async>
              </Card>

              <Card title="Activity history">
                <Async loading={activity.loading && !activity.data} error={activity.error} skeleton="table">
                  {(activity.data?.data.length ?? 0) === 0 ? <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="project-activity-empty">No activity recorded for this project.</p> : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="project-activity">
                      {activity.data!.data.map(a => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="project-activity-item">
                          <Badge tone={a.level === 'ERROR' ? 'red' : a.level === 'WARN' ? 'amber' : 'slate'}>{a.level}</Badge>
                          <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{a.type}</span>
                          <span className="min-w-0 break-words">{a.message}</span>
                          <span className="text-xs text-slate-600 dark:text-slate-400">{fmtDateTime(a.createdAt)}</span>
                          <SourceBadge source={a.source} />
                          {a.traceId && <Link to={`/traces/${a.traceId}`} className="text-xs text-brand-600 underline dark:text-brand-100">trace</Link>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {activity.data && activity.data.pagination.total > 0 && <PaginationBar p={activity.data.pagination} onPage={setActPage} />}
                </Async>
              </Card>
            </div>

            {editing && (
              <Modal title={`Edit ${p.name}`} onClose={() => setEditing(false)} testId="project-edit-dialog">
                <ProjectForm mode="edit" initial={p} onCancel={() => setEditing(false)} onSubmit={async v => {
                  await api.patch(`/projects/${p.id}`, { name: v.name, description: v.description || null, isTest: v.isTest });
                  setEditing(false); toast.success(`Saved "${v.name}"`); reloadAll();
                }} />
              </Modal>
            )}
            {confirmDelete && (
              <ConfirmDialog
                title="Delete test project?"
                message={<>This permanently deletes <strong>{p.name}</strong> with its usage events, budgets and alerts.</>}
                confirmLabel="Delete project" busy={busy} error={actionError}
                confirmTestId="project-delete-confirm" cancelTestId="project-delete-cancel"
                onCancel={() => setConfirmDelete(false)} onConfirm={doDelete}
              />
            )}
          </>
        )}
      </Async>
    </div>
  );
}
