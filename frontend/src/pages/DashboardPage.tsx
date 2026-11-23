import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardStats } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Card, StatCard } from '../components/ui/Card';
import { Badge, SourceBadge } from '../components/ui/Badge';
import { Button, inputCls } from '../components/ui/Button';
import { Async } from '../components/ui/State';
import { Table, Td } from '../components/ui/Table';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs, fmtPct, fmtUsd } from '../lib/format';
import DemoBanner from '../components/dashboard/DemoBanner';
import SeedDemoButton from '../components/dashboard/SeedDemoButton';
import { BudgetUtilizationList } from '../components/dashboard/UtilizationBar';
import { DailySpendChart, ProviderCostChart, SuccessFailureChart } from '../components/dashboard/charts';

const RANGES = [7, 14, 30, 90];

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const q = useAsync(() => api.get<DashboardStats>('/dashboard', { days }), [days]);
  const d = q.data;
  const empty = !!d && d.totals.requests === 0;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Simulated AI spend and request health across all projects."
        actions={<>
          <label htmlFor="dashboard-range" className="text-sm text-slate-600 dark:text-slate-300">Range</label>
          <select id="dashboard-range" className={inputCls} value={days} onChange={e => setDays(Number(e.target.value))} data-testid="dashboard-range">
            {RANGES.map(r => <option key={r} value={r}>Last {r} days</option>)}
          </select>
          <Button variant="secondary" onClick={q.reload} disabled={q.loading} data-testid="dashboard-refresh">Refresh</Button>
        </>}
      />
      <DemoBanner />
      <Async loading={q.loading && !d} error={q.error}>
        {d && empty && (
          <Card className="mb-4" >
            <div className="py-6 text-center" data-testid="dashboard-empty">
              <h2 className="text-base font-semibold">No usage recorded in the last {days} days</h2>
              <p className="mx-auto mt-1 mb-4 max-w-md text-sm text-slate-500 dark:text-slate-400">
                Generate 200 simulated requests spread over 14 days (including some failures), or send a single request from the{' '}
                <Link to="/simulator" className="text-brand-600 underline dark:text-brand-100">Request Simulator</Link>.
              </p>
              <div className="flex justify-center"><SeedDemoButton onDone={q.reload} /></div>
            </div>
          </Card>
        )}
        {d && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <StatCard label="Total simulated spend" value={fmtUsd(d.totals.spendUsd)} hint="DEMO / SIMULATED" testId="dashboard-total-spend" />
              <StatCard label="Total requests" value={fmtInt(d.totals.requests)} testId="dashboard-total-requests" />
              <StatCard label="Input tokens" value={fmtInt(d.totals.inputTokens)} testId="dashboard-input-tokens" />
              <StatCard label="Output tokens" value={fmtInt(d.totals.outputTokens)} testId="dashboard-output-tokens" />
              <StatCard label="Cached tokens" value={fmtInt(d.totals.cachedTokens)} testId="dashboard-cached-tokens" />
              <StatCard label="Success rate" value={d.totals.requests ? fmtPct(d.totals.successRate * 100) : '-'}
                hint={`${fmtInt(d.totals.successes)} ok / ${fmtInt(d.totals.failures)} failed`} testId="dashboard-success-rate" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Daily simulated spend"><DailySpendChart data={d.dailySpend} /></Card>
              <Card title="Successes vs failures per day"><SuccessFailureChart data={d.dailySpend} /></Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Provider breakdown">
                {d.providerBreakdown.length === 0 ? <p className="text-sm text-slate-500">No provider usage in range.</p> : (
                  <>
                    <ProviderCostChart data={d.providerBreakdown} />
                    <div className="mt-3">
                      <Table head={['Provider', 'Requests', 'Cost', 'In', 'Out', 'Cached']}>
                        {d.providerBreakdown.map(p => (
                          <tr key={p.provider} data-testid="provider-row">
                            <Td className="font-medium">{p.provider}</Td><Td>{fmtInt(p.requests)}</Td><Td>{fmtUsd(p.costUsd)}</Td>
                            <Td>{fmtInt(p.inputTokens)}</Td><Td>{fmtInt(p.outputTokens)}</Td><Td>{fmtInt(p.cachedTokens)}</Td>
                          </tr>
                        ))}
                      </Table>
                    </div>
                  </>
                )}
              </Card>
              <Card title="Model breakdown">
                {d.modelBreakdown.length === 0 ? <p className="text-sm text-slate-500">No model usage in range.</p> : (
                  <Table head={['Provider', 'Model', 'Requests', 'Cost', 'In', 'Out', 'Cached']}>
                    {d.modelBreakdown.map(m => (
                      <tr key={`${m.provider}/${m.model}`} data-testid="model-row">
                        <Td>{m.provider}</Td><Td className="font-medium">{m.model}</Td><Td>{fmtInt(m.requests)}</Td><Td>{fmtUsd(m.costUsd)}</Td>
                        <Td>{fmtInt(m.inputTokens)}</Td><Td>{fmtInt(m.outputTokens)}</Td><Td>{fmtInt(m.cachedTokens)}</Td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            </div>

            <Card title="Budget utilization (current period)" actions={<Link to="/budgets" className="text-sm text-brand-600 hover:underline dark:text-brand-100" data-testid="dashboard-budgets-link">Manage budgets</Link>}>
              <BudgetUtilizationList items={d.budgetUtilization} />
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Recent activity" actions={<Link to="/activity" className="text-sm text-brand-600 hover:underline dark:text-brand-100">All activity</Link>}>
                {d.recentActivity.length === 0 ? <p className="text-sm text-slate-500">No recent activity.</p> : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="recent-activity">
                    {d.recentActivity.map(a => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={a.level === 'ERROR' ? 'red' : a.level === 'WARN' ? 'amber' : 'slate'}>{a.level}</Badge>
                            <span className="break-words">{a.message}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span>{fmtDateTime(a.createdAt)}</span>
                            {a.projectName && <span>{a.projectName}</span>}
                            <SourceBadge source={a.source} />
                            {a.traceId && <Link to={`/traces/${a.traceId}`} className="text-brand-600 underline dark:text-brand-100">trace</Link>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <div className="space-y-4">
                <Card title="Recent errors (failed requests)" actions={<Link to="/errors" className="text-sm text-brand-600 hover:underline dark:text-brand-100">Error log</Link>}>
                  {d.recentErrors.length === 0 ? <p className="text-sm text-slate-500" data-testid="recent-errors-empty">No failed requests in range.</p> : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="recent-errors">
                      {d.recentErrors.map(e => (
                        <li key={e.id} className="py-2 text-sm" data-testid="recent-error-item">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="red">{e.errorCode ?? 'FAILURE'}</Badge>
                            <span className="font-medium">{e.provider}/{e.model}</span>
                            <span className="text-xs text-slate-500 dark:text-slate-400">{e.projectName} - {fmtMs(e.durationMs)}</span>
                          </div>
                          {e.errorMessage && <div className="mt-0.5 break-words text-xs text-slate-600 dark:text-slate-300">{e.errorMessage}</div>}
                          <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
                            <span>{fmtDateTime(e.createdAt)}</span>
                            <Link to={`/usage?detail=${encodeURIComponent(e.id)}`} className="text-brand-600 underline dark:text-brand-100">request details</Link>
                            {e.traceId && <Link to={`/traces/${e.traceId}`} className="text-brand-600 underline dark:text-brand-100">trace</Link>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="Recent budget alerts">
                  {d.recentAlerts.length === 0 ? <p className="text-sm text-slate-500" data-testid="recent-alerts-empty">No budget alerts raised.</p> : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="recent-alerts">
                      {d.recentAlerts.map(a => (
                        <li key={a.id} className="py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={a.threshold >= 100 ? 'red' : a.threshold >= 80 ? 'amber' : 'blue'}>{a.threshold}%</Badge>
                            <span className="font-medium">{a.budgetName}</span>
                            <span className="text-xs text-slate-500 dark:text-slate-400">{a.projectName ?? 'All projects'} - {a.period}</span>
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {fmtUsd(a.spendUsd)} of {fmtUsd(a.limitUsd)} ({a.percent.toFixed(1)}%) - {fmtDateTime(a.createdAt)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}
      </Async>
    </div>
  );
}
