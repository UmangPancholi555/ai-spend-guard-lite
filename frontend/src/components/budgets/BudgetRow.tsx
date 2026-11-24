import { useState } from 'react';
import type { BudgetDto, BudgetUtilization } from '@shared/types';
import { api } from '../../lib/api';
import { fmtPct, fmtUsd } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Button, inputCls } from '../ui/Button';
import { ConfirmDialog } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useReadOnly } from '../auth/readOnly';
import UtilizationBar, { utilState } from './UtilizationBar';
import UtilizationHistoryChart from './UtilizationHistoryChart';
import { validateLimit, validateName } from './validation';

export default function BudgetRow({ budget, util, reloadKey, onChanged }: {
  budget: BudgetDto; util: BudgetUtilization | undefined; reloadKey: number; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(budget.name);
  const [limit, setLimit] = useState(budget.limitUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const { readOnly, guard } = useReadOnly();

  const nameErr = validateName(name);
  const limitErr = validateLimit(limit);

  async function run(fn: () => Promise<unknown>, after?: () => void, success?: string) {
    if (readOnly) return;
    setBusy(true); setError(undefined);
    try { await fn(); after?.(); if (success) toast.success(success); onChanged(); }
    catch (e) { setError((e as Error).message); toast.error('Budget update failed', (e as Error).message); }
    finally { setBusy(false); }
  }

  const s = util ? utilState(util.percent) : null;

  return (
    <li data-testid="budget-row" data-budget-id={budget.id} data-active={budget.active}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold" data-testid="budget-name">{budget.name}</h3>
            <Badge tone="blue">{budget.period}</Badge>
            <Badge tone={budget.projectId ? 'slate' : 'purple'}>{budget.projectId ? (budget.projectName ?? 'Project') : 'Global'}</Badge>
            {!budget.active && <Badge tone="amber">Inactive</Badge>}
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Limit <span className="font-medium" data-testid="budget-limit">{fmtUsd(budget.limitUsd)}</span>
            {util && <> - spent <span className="font-medium" data-testid="budget-spend">{fmtUsd(util.spendUsd)}</span></>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" type="button" onClick={() => setShowHistory(v => !v)} aria-expanded={showHistory} data-testid="budget-history-toggle">
            {showHistory ? 'Hide history' : 'History'}
          </Button>
          <Button variant="secondary" type="button" {...guard(busy)} data-testid="budget-toggle-active"
            onClick={() => run(() => api.patch(`/budgets/${budget.id}`, { active: !budget.active }), undefined, budget.active ? `"${budget.name}" deactivated` : `"${budget.name}" activated`)}>
            {budget.active ? 'Deactivate' : 'Activate'}
          </Button>
          <Button variant="secondary" type="button" {...guard()} onClick={() => { setEditing(e => !e); setError(undefined); }} aria-expanded={editing} data-testid="budget-edit">Edit</Button>
          <Button variant="ghost" type="button" {...guard()} onClick={() => setConfirmDelete(true)} data-testid="budget-delete" className="text-red-700 dark:text-red-400">Delete</Button>
        </div>
      </div>

      <div className="mt-3">
        {util ? (
          <>
            <UtilizationBar percent={util.percent} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span className={`font-semibold ${s?.text}`} data-testid="budget-percent">{fmtPct(util.percent, 2)} - {s?.label}</span>
              <span>Period (UTC): {new Date(util.periodStart).toLocaleDateString(undefined, { timeZone: 'UTC' })} to {new Date(new Date(util.periodEnd).getTime() - 1).toLocaleDateString(undefined, { timeZone: 'UTC' })}</span>
              <span>{util.highestThresholdReached ? `Highest threshold reached: ${util.highestThresholdReached}%` : 'No thresholds reached'}</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">No current-period utilization reported{budget.active ? '' : ' (budget inactive)'}.</p>
        )}
      </div>

      {editing && !readOnly && (
        <form className="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 dark:bg-slate-950/40 sm:grid-cols-3" noValidate data-testid="budget-edit-form"
          onSubmit={e => { e.preventDefault(); if (nameErr || limitErr) return; run(() => api.patch(`/budgets/${budget.id}`, { name: name.trim(), limitUsd: limit.trim() }), () => setEditing(false), 'Budget updated'); }}>
          <label className="flex flex-col gap-1 text-xs font-medium">Name
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)} data-autofocus autoFocus data-testid="budget-edit-name" aria-invalid={!!nameErr} />
            {nameErr && <span className="text-red-700 dark:text-red-400">{nameErr}</span>}
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">Limit (USD)
            <input className={inputCls} inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} data-testid="budget-edit-limit" aria-invalid={!!limitErr} />
            {limitErr && <span className="text-red-700 dark:text-red-400" data-testid="budget-edit-limit-error">{limitErr}</span>}
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit" disabled={busy || !!nameErr || !!limitErr} data-testid="budget-edit-save">Save</Button>
            <Button variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 sm:col-span-3">Scope and period are fixed once a budget exists; delete and recreate to change them.</p>
        </form>
      )}

      {confirmDelete && !readOnly && (
        <ConfirmDialog title="Delete budget?" confirmLabel="Confirm delete" busy={busy} error={error}
          message={<>Delete <strong>{budget.name}</strong> and its alert history? This cannot be undone.</>}
          confirmTestId="budget-delete-confirm" cancelTestId="budget-delete-cancel"
          onCancel={() => { setConfirmDelete(false); setError(undefined); }}
          onConfirm={() => run(() => api.del(`/budgets/${budget.id}`), () => setConfirmDelete(false), `Budget "${budget.name}" deleted`)} />
      )}
      {error && !confirmDelete && <div role="alert" data-testid="budget-row-error" className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div>}
      {showHistory && <div className="mt-4"><UtilizationHistoryChart budgetId={budget.id} reloadKey={reloadKey} /></div>}
    </li>
  );
}
