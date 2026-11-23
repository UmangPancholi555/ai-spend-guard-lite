import type { MockProviderResponse } from '@shared/types';
import { Badge, SourceBadge } from '../ui/Badge';
import { fmtInt, fmtMs } from '../../lib/format';

/** Real (ACTUAL) runtime summary of a mock request: memory injection, request context, tool calls, budget preflight. Metadata only. */
export default function RuntimeSummary({ r }: { r: MockProviderResponse }) {
  if (!r.memory && !r.context && !r.tools && !r.budgetPreflight) return null;
  return (
    <section data-testid="runtime-summary" className="space-y-3">
      <div className="flex items-center gap-2"><h3 className="font-semibold">Runtime (real in-app components)</h3><SourceBadge source="ACTUAL" /></div>
      <div className="grid gap-3 md:grid-cols-2">
        {r.memory && (
          <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700" data-testid="memory-result">
            <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Memory injection</div>
            {r.memory.injected ? (
              <p className="text-sm"><span data-testid="memory-result-items">{fmtInt(r.memory.items)}</span> item(s), about <span data-testid="memory-result-tokens">{fmtInt(r.memory.estimatedTokens)}</span> tokens injected
                {r.memory.truncated && <> <Badge tone="amber">truncated</Badge> <span data-testid="memory-result-dropped">{r.memory.droppedItems}</span> item(s) dropped to fit the model window</>}</p>
            ) : <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="memory-result-none">No memory injected (no enabled items, or injection off).</p>}
          </div>
        )}
        {r.context && (
          <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700" data-testid="context-result">
            <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Request context</div>
            <p className="text-sm">v<span data-testid="context-result-version">{r.context.version}</span> - {fmtInt(r.context.sizeBytes)} bytes - about {fmtInt(r.context.estimatedTokens)} tokens - window {fmtInt(r.context.windowTokens)}{r.context.truncated && <> <Badge tone="amber">truncated</Badge></>}</p>
            <p className="font-mono text-xs text-slate-500 dark:text-slate-400">{r.context.contextId}</p>
          </div>
        )}
        {r.tools && r.tools.length > 0 && (
          <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700" data-testid="tools-result">
            <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Tool calls</div>
            <ul className="space-y-0.5 text-sm">
              {r.tools.map(t => (
                <li key={t.toolCallId || t.name} className="flex flex-wrap items-center gap-2" data-testid="tool-result-item">
                  <span className="font-mono">{t.name}</span>
                  <Badge tone={t.status === 'SUCCESS' ? 'green' : 'red'}>{t.status}</Badge>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{t.attempts} attempt(s) - {fmtMs(t.durationMs)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {r.budgetPreflight && (
          <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700" data-testid="budget-preflight-result">
            <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Budget preflight (tool: budget.status)</div>
            {r.budgetPreflight.status === 'OK'
              ? <p className="text-sm">{r.budgetPreflight.budgets} active budget(s), highest utilization {r.budgetPreflight.highestPercent.toFixed(1)}% {r.budgetPreflight.overLimit && <Badge tone="red">over limit</Badge>}</p>
              : <p className="text-sm text-slate-500 dark:text-slate-400">Unavailable (tool failed; the request was not blocked).</p>}
          </div>
        )}
      </div>
    </section>
  );
}
