import { useState } from 'react';
import type { BudgetAlertDto, BudgetDto, BudgetUtilization, ProjectWithUsage } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Async } from '../components/ui/State';
import { EmptyState } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import AlertHistory, { ThresholdChips } from '../components/budgets/AlertHistory';
import BudgetForm from '../components/budgets/BudgetForm';
import BudgetRow from '../components/budgets/BudgetRow';
import { SelectFilter } from '../components/observability/common';
import { useReadOnly } from '../components/auth/readOnly';

export default function BudgetsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [projectId, setProjectId] = useState('');
  const bump = () => setReloadKey(k => k + 1);
  const toast = useToast();
  const { readOnly, guard } = useReadOnly();

  const projects = useAsync(async () => (await api.list<ProjectWithUsage>('/projects', { includeTest: true, pageSize: 200 })).data, []);
  const budgets = useAsync(() => api.get<BudgetDto[]>('/budgets', { projectId }), [projectId, reloadKey]);
  const utils = useAsync(() => api.get<BudgetUtilization[]>('/budgets/utilization', { projectId }), [projectId, reloadKey]);
  // all budgets (unfiltered) feed the alert-history budget filter
  const allBudgets = useAsync(() => api.get<BudgetDto[]>('/budgets'), [reloadKey]);

  const [evaluating, setEvaluating] = useState(false);
  const [evalResult, setEvalResult] = useState<BudgetAlertDto[]>();
  const [evalError, setEvalError] = useState<string>();

  async function evaluate() {
    if (readOnly) return;
    setEvaluating(true); setEvalError(undefined);
    try {
      const created = await api.post<BudgetAlertDto[]>('/budgets/evaluate');
      setEvalResult(created);
      if (created.length > 0) toast.success(`${created.length} new alert${created.length === 1 ? '' : 's'} created`);
      else toast.info('Evaluation finished', 'No new alerts: every budget is up to date.');
      bump();
    } catch (e) { setEvalError((e as Error).message); setEvalResult(undefined); toast.error('Evaluation failed', (e as Error).message); } finally { setEvaluating(false); }
  }

  const utilById = new Map((utils.data ?? []).map(u => [u.budget.id, u]));
  const projectList = projects.data ?? [];

  return (
    <div>
      <PageHeader title="Budgets & Alerts" subtitle="Spend limits per project or globally, with alerts at 50%, 80% and 100% of each period's limit. Spend is from simulated mock requests."
        actions={<Button onClick={evaluate} {...guard(evaluating)} data-testid="budgets-evaluate">{evaluating ? 'Evaluating...' : 'Evaluate now'}</Button>} />

      {evalError && <div role="alert" data-testid="evaluate-error" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{evalError}</div>}
      {evalResult && (
        <div role="status" data-testid="evaluate-result" className="mb-4 rounded-md border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <strong data-testid="evaluate-count">{evalResult.length}</strong> new alert{evalResult.length === 1 ? '' : 's'} created.
          {evalResult.length === 0 && <span className="text-slate-600 dark:text-slate-400"> Every budget is already up to date for its current period.</span>}
          {evalResult.length > 0 && (
            <ul className="mt-2 space-y-1">
              {evalResult.map(a => (
                <li key={a.id} className="flex flex-wrap items-center gap-2" data-testid="evaluate-alert">
                  <ThresholdChips active={a.threshold} /> <span>{a.budgetName}</span>
                  <span className="text-slate-600 dark:text-slate-400">({a.projectName ?? 'Global'}, {a.period})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <BudgetForm projects={projectList} onCreated={bump} />

      <div className="mb-3 mt-6 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold">Budgets</h2>
        <SelectFilter label="Project" value={projectId} onChange={setProjectId} allLabel="All projects" testId="budgets-filter-project"
          options={projectList.map(p => ({ value: p.id, label: p.name }))} />
      </div>
      <Async loading={budgets.loading && !budgets.data} error={budgets.error ?? utils.error} skeleton="table" reload={() => { budgets.reload(); utils.reload(); }}>
        {budgets.data && budgets.data.length === 0
          ? <Card><EmptyState message="No budgets yet. Create one above to start tracking utilization and alerts."
              action={<Button variant="secondary" {...guard()} data-testid="budget-empty-cta" onClick={() => document.querySelector<HTMLInputElement>('[data-testid="budget-create-name"]')?.focus()}>Create your first budget</Button>} /></Card>
          : (
            <ul className="space-y-3" data-testid="budget-list">
              {(budgets.data ?? []).map(b => <BudgetRow key={b.id} budget={b} util={utilById.get(b.id)} reloadKey={reloadKey} onChanged={bump} />)}
            </ul>
          )}
      </Async>

      <div className="mt-6">
        <AlertHistory budgets={allBudgets.data ?? []} projects={projectList} reloadKey={reloadKey} />
      </div>
    </div>
  );
}
