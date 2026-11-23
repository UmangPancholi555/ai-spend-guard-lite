import { Link } from 'react-router-dom';
import type { UsageEventDetail } from '@shared/types';
import { Async } from '../ui/State';
import { Badge, StatusBadge } from '../ui/Badge';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime, fmtInt, fmtMs } from '../../lib/format';
import { Modal } from '../projects/Modal';
import CostBreakdownView from './CostBreakdownView';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (<><dt className="text-slate-600 dark:text-slate-400">{k}</dt><dd className="min-w-0 break-words text-right">{children}</dd></>);
}

/** Right-side panel with full detail of one usage event (GET /usage/:id). */
export default function RequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAsync(() => api.get<UsageEventDetail>(`/usage/${encodeURIComponent(id)}`), [id]);
  const u = q.data;
  return (
    <Modal title="Request details" variant="drawer" onClose={onClose} testId="usage-drawer">
      <div className="mb-3"><Badge tone="amber">DEMO / SIMULATED</Badge></div>
      <Async loading={q.loading} error={q.error}>
        {u && (
          <div className="space-y-5 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <Row k="Request ID"><span className="font-mono text-xs" data-testid="drawer-request-id">{u.requestId}</span></Row>
              <Row k="Status"><span data-testid="drawer-status"><StatusBadge status={u.status} /></span></Row>
              <Row k="Time">{fmtDateTime(u.createdAt)}</Row>
              <Row k="Project"><Link to={`/projects/${u.projectId}`} className="text-brand-600 underline dark:text-brand-100">{u.projectName ?? u.projectId}</Link></Row>
              <Row k="Provider / model">{u.provider} / {u.model}</Row>
              <Row k="Duration (simulated)">{fmtMs(u.durationMs)}</Row>
              <Row k="Trace">{u.traceId ? <Link to={`/traces/${u.traceId}`} className="text-brand-600 underline dark:text-brand-100" data-testid="drawer-trace-link">{u.traceId}</Link> : '-'}</Row>
            </dl>

            {u.status === 'FAILURE' && (
              <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="drawer-error">
                <strong>{u.errorCode ?? 'ERROR'}</strong>{u.errorMessage ? `: ${u.errorMessage}` : ''}
              </div>
            )}

            <section>
              <h3 className="mb-1 font-semibold">Tokens</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <Row k="Input">{fmtInt(u.inputTokens)}</Row>
                <Row k="Output">{fmtInt(u.outputTokens)}</Row>
                <Row k="Cached">{fmtInt(u.cachedTokens)}</Row>
              </dl>
            </section>

            <section>
              <h3 className="mb-1 font-semibold">Cost breakdown</h3>
              <CostBreakdownView cost={{ ...u, totalCostUsd: u.costUsd }} />
              <Link to={`/pricing?${new URLSearchParams({ provider: u.provider, model: u.model, in: String(u.inputTokens), out: String(u.outputTokens), cached: String(u.cachedTokens) }).toString()}`}
                className="mt-2 inline-block text-xs text-brand-600 underline dark:text-brand-100" data-testid="drawer-open-calculator">Open in calculator</Link>
            </section>

            <section>
              <h3 className="mb-1 font-semibold">Prompt (not stored)</h3>
              <p className="text-xs text-slate-600 dark:text-slate-400">Only a hash and length are kept; prompt content is never persisted.</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
                <Row k="SHA-256"><span className="break-all font-mono text-xs">{u.promptHash}</span></Row>
                <Row k="Length">{fmtInt(u.promptChars)} chars</Row>
              </dl>
            </section>

            {u.responseText && (
              <section>
                <h3 className="mb-1 font-semibold">Mock response</h3>
                <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-800">{u.responseText}</p>
              </section>
            )}

            <section>
              <h3 className="mb-1 font-semibold">Metadata (JSON)</h3>
              <pre className="max-h-80 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100" data-testid="drawer-metadata">{JSON.stringify(u.metadata, null, 2)}</pre>
            </section>
          </div>
        )}
      </Async>
    </Modal>
  );
}
