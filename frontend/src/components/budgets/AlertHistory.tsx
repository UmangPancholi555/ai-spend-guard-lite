import { useMemo } from 'react';
import type { BudgetAlertDto, BudgetDto, ProjectWithUsage } from '@shared/types';
import { fmtDateTime, fmtPct, fmtUsd } from '../../lib/format';
import { Card } from '../ui/Card';
import { Td } from '../ui/Table';
import { ExportLinks, FilterBar, PagedTable, SelectFilter, TextFilter, useFilters, useList } from '../observability/common';
import { THRESHOLDS, thresholdTone } from './UtilizationBar';

const INITIAL = { budgetId: '', projectId: '', threshold: '', from: '', to: '' };

export function ThresholdChips({ active }: { active: number }) {
  return (
    <span className="inline-flex gap-1" data-testid="threshold-chips">
      {THRESHOLDS.map(t => (
        <span key={t} data-testid="threshold-chip" data-threshold={t} data-active={t === active}
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${t === active ? thresholdTone(t) : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'}`}>
          {t}%
        </span>
      ))}
    </span>
  );
}

export default function AlertHistory({ budgets, projects, reloadKey }: { budgets: BudgetDto[]; projects: ProjectWithUsage[]; reloadKey: number }) {
  const initial = useMemo(() => INITIAL, []);
  const f = useFilters(initial, 10);
  const state = useList<BudgetAlertDto>('/budget-alerts', f.query, [reloadKey]);
  return (
    <Card title="Alert history" actions={<div className="flex gap-2"><ExportLinks dataset="alerts" params={f.params} /></div>}>
      <FilterBar onReset={f.reset} dirty={f.dirty}>
        <SelectFilter label="Budget" value={f.filters.budgetId} onChange={v => f.setFilter('budgetId', v)} testId="alert-filter-budget"
          options={budgets.map(b => ({ value: b.id, label: `${b.name} (${b.period})` }))} />
        <SelectFilter label="Project" value={f.filters.projectId} onChange={v => f.setFilter('projectId', v)} testId="alert-filter-project"
          options={projects.map(p => ({ value: p.id, label: p.name }))} />
        <SelectFilter label="Threshold" value={f.filters.threshold} onChange={v => f.setFilter('threshold', v)} testId="alert-filter-threshold"
          options={THRESHOLDS.map(t => ({ value: String(t), label: `${t}%` }))} />
        <TextFilter type="date" label="From" value={f.filters.from} onChange={v => f.setFilter('from', v)} testId="alert-filter-from" />
        <TextFilter type="date" label="To" value={f.filters.to} onChange={v => f.setFilter('to', v)} testId="alert-filter-to" />
      </FilterBar>
      <PagedTable state={state} testId="alert-table" onPage={f.setPage} emptyMessage="No budget alerts match these filters. Alerts appear when spend crosses 50%, 80% or 100% of a budget."
        head={['Raised', 'Budget', 'Project', 'Period', 'Threshold', 'Spend vs limit', 'Used']}
        row={a => (
          <tr key={a.id} data-testid="alert-row" data-threshold={a.threshold}>
            <Td>{fmtDateTime(a.createdAt)}</Td>
            <Td>{a.budgetName}</Td>
            <Td>{a.projectId ? (a.projectName ?? a.projectId) : 'Global'}</Td>
            <Td>{a.period}</Td>
            <Td><ThresholdChips active={a.threshold} /></Td>
            <Td><span data-testid="alert-spend">{fmtUsd(a.spendUsd)}</span> / {fmtUsd(a.limitUsd)}</Td>
            <Td>{fmtPct(a.percent, 2)}</Td>
          </tr>
        )} />
    </Card>
  );
}
