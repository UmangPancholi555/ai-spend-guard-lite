import { Link } from 'react-router-dom';
import type { MockProviderResponse } from '@shared/types';
import { Badge, StatusBadge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { fmtDateTime, fmtInt, fmtMs, fmtUsd } from '../../lib/format';
import CostBreakdownView from '../usage/CostBreakdownView';
import RuntimeSummary from '../memory/RuntimeSummary';

/** Renders a MockProviderResponse. Always labeled DEMO / SIMULATED. */
export default function ResponsePanel({ r }: { r: MockProviderResponse }) {
  return (
    <Card title="Mock provider response" className="mt-4" actions={<Badge tone="amber">{r.label}</Badge>}>
      <div data-testid="simulator-result" className="space-y-4 text-sm">
        <div role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="simulator-result-banner">
          DEMO / SIMULATED response generated locally. No external AI request was made and no real cost was incurred.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="simulator-result-status"><StatusBadge status={r.status} /></span>
          <span>{r.provider} / {r.model}</span>
          <span className="text-slate-600 dark:text-slate-400">finish: {r.finishReason} - {fmtMs(r.durationMs)} (simulated)</span>
        </div>
        {r.error && <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="simulator-result-error"><strong>{r.error.code}</strong>: {r.error.message}</div>}
        <section>
          <h3 className="mb-1 font-semibold">Content</h3>
          {r.content ? <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-2 dark:bg-slate-800" data-testid="simulator-result-content">{r.content}</p> : <p className="text-slate-600 dark:text-slate-400">No content (request failed).</p>}
        </section>
        <div className="grid gap-4 md:grid-cols-2">
          <section>
            <h3 className="mb-1 font-semibold">Usage</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-slate-600 dark:text-slate-400">Input tokens</dt><dd className="text-right" data-testid="simulator-result-input">{fmtInt(r.usage.inputTokens)}</dd>
              <dt className="text-slate-600 dark:text-slate-400">Output tokens</dt><dd className="text-right" data-testid="simulator-result-output">{fmtInt(r.usage.outputTokens)}</dd>
              <dt className="text-slate-600 dark:text-slate-400">Cached tokens</dt><dd className="text-right" data-testid="simulator-result-cached">{fmtInt(r.usage.cachedTokens)}</dd>
            </dl>
          </section>
          <section>
            <h3 className="mb-1 font-semibold">Cost</h3>
            <CostBreakdownView cost={r.cost} testId="simulator-result-cost" />
          </section>
        </div>
        <RuntimeSummary r={r} />
        <section className="flex flex-wrap gap-x-6 gap-y-1">
          <Link to={`/usage?detail=${encodeURIComponent(r.usageEventId)}`} className="text-brand-600 underline dark:text-brand-100" data-testid="simulator-usage-link">View request details</Link>
          <Link to={`/traces/${r.traceId}`} className="text-brand-600 underline dark:text-brand-100" data-testid="simulator-trace-link">View trace</Link>
          <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{r.requestId}</span>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">New budget alerts</h3>
          {r.budgetAlerts.length === 0 ? <p className="text-slate-600 dark:text-slate-400" data-testid="simulator-no-alerts">None raised by this request.</p> : (
            <ul className="space-y-1" data-testid="simulator-alerts">
              {r.budgetAlerts.map(a => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={a.threshold >= 100 ? 'red' : a.threshold >= 80 ? 'amber' : 'blue'}>{a.threshold}%</Badge>
                  <span className="font-medium">{a.budgetName}</span>
                  <span className="text-xs text-slate-600 dark:text-slate-400">{fmtUsd(a.spendUsd)} of {fmtUsd(a.limitUsd)} ({a.percent.toFixed(1)}%) - {fmtDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/budgets" className="mt-1 inline-block text-xs text-brand-600 underline dark:text-brand-100">Open Budgets & Alerts</Link>
        </section>
      </div>
    </Card>
  );
}
