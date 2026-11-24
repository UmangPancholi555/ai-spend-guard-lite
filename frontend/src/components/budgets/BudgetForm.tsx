import { useState } from 'react';
import type { BudgetCreateInput, BudgetDto, BudgetPeriod, ProjectWithUsage } from '@shared/types';
import { api } from '../../lib/api';
import { Button, inputCls } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../observability/common';
import { useToast } from '../ui/Toast';
import { validateLimit, validateName } from './validation';
import { useReadOnly } from '../auth/readOnly';

export const PERIODS: BudgetPeriod[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

export default function BudgetForm({ projects, onCreated }: { projects: ProjectWithUsage[]; onCreated: (b: BudgetDto) => void }) {
  const [scope, setScope] = useState(''); // '' = global
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('MONTHLY');
  const [limit, setLimit] = useState('');
  const [touched, setTouched] = useState({ name: false, limit: false });
  const toast = useToast();
  const { readOnly, guard } = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string>();
  const [created, setCreated] = useState<string>();

  const nameErr = validateName(name);
  const limitErr = validateLimit(limit);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setTouched({ name: true, limit: true }); setApiError(undefined); setCreated(undefined);
    if (nameErr || limitErr) return;
    setBusy(true);
    try {
      const body: BudgetCreateInput = { projectId: scope || null, name: name.trim(), period, limitUsd: limit.trim() };
      const b = await api.post<BudgetDto>('/budgets', body);
      setCreated(`Created "${b.name}".`);
      setName(''); setLimit(''); setTouched({ name: false, limit: false });
      toast.success('Budget created', `"${b.name}" (${b.period.toLowerCase()}) is now tracking spend.`);
      onCreated(b);
    } catch (err) {
      setApiError((err as Error).message);
      toast.error('Could not create budget', (err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Card title="Create budget">
      <form onSubmit={submit} noValidate data-testid="budget-create-form" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Scope">
          <select className={inputCls} value={scope} disabled={readOnly} onChange={e => setScope(e.target.value)} data-testid="budget-create-project">
            <option value="">Global (all projects)</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.status === 'ARCHIVED' ? ' (archived)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Name">
          <input className={inputCls} value={name} maxLength={80} disabled={readOnly} onChange={e => setName(e.target.value)} onBlur={() => setTouched(t => ({ ...t, name: true }))} placeholder="e.g. Monthly cap"
            aria-invalid={touched.name && !!nameErr} aria-describedby="budget-name-err" data-testid="budget-create-name" />
          {touched.name && nameErr && <span id="budget-name-err" className="text-xs text-red-700 dark:text-red-400" data-testid="budget-create-name-error">{nameErr}</span>}
        </Field>
        <Field label="Period">
          <select className={inputCls} value={period} disabled={readOnly} onChange={e => setPeriod(e.target.value as BudgetPeriod)} data-testid="budget-create-period">
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Limit (USD)">
          <input className={inputCls} inputMode="decimal" value={limit} disabled={readOnly} onChange={e => setLimit(e.target.value)} onBlur={() => setTouched(t => ({ ...t, limit: true }))} placeholder="e.g. 25.00"
            aria-invalid={touched.limit && !!limitErr} aria-describedby="budget-limit-err" data-testid="budget-create-limit" />
          {touched.limit && limitErr && <span id="budget-limit-err" className="text-xs text-red-700 dark:text-red-400" data-testid="budget-create-limit-error">{limitErr}</span>}
        </Field>
        <div className="flex items-end">
          <Button type="submit" {...guard(busy)} data-testid="budget-create-submit" className="w-full">{busy ? 'Creating...' : 'Create budget'}</Button>
        </div>
      </form>
      {apiError && <div role="alert" data-testid="budget-create-error" className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{apiError}</div>}
      {created && <div role="status" data-testid="budget-create-success" className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{created}</div>}
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">One budget per scope and period. Alerts fire once per period at 50%, 80% and 100% of the limit (UTC periods).</p>
    </Card>
  );
}
