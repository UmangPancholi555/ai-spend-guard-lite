import { useState, type FormEvent } from 'react';
import { MEMORY_CATEGORIES, MEMORY_LIMITS, type MemoryCategory, type MemoryItemDto } from '@shared/runtime';
import { Card } from '../ui/Card';
import { Badge, SourceBadge } from '../ui/Badge';
import { Button, inputCls } from '../ui/Button';
import { Async } from '../ui/State';
import { ConfirmDialog } from '../projects/Modal';
import { errMessage } from '../projects/util';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtInt } from '../../lib/format';

const labelCls = 'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400';

interface Draft { title: string; category: MemoryCategory; content: string }
const EMPTY: Draft = { title: '', category: 'instructions', content: '' };

function ItemForm({ initial, submitLabel, busy, error, onSubmit, onCancel, testPrefix }: {
  initial: Draft; submitLabel: string; busy: boolean; error?: string; testPrefix: string;
  onSubmit: (d: Draft) => void; onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(d); };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate data-testid={`${testPrefix}-form`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`${testPrefix}-title`}>Title (max {MEMORY_LIMITS.maxTitleChars})</label>
          <input id={`${testPrefix}-title`} className={`${inputCls} w-full`} maxLength={MEMORY_LIMITS.maxTitleChars} value={d.title} onChange={e => setD({ ...d, title: e.target.value })} data-testid={`${testPrefix}-title`} />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${testPrefix}-category`}>Category</label>
          <select id={`${testPrefix}-category`} className={`${inputCls} w-full`} value={d.category} onChange={e => setD({ ...d, category: e.target.value as MemoryCategory })} data-testid={`${testPrefix}-category`}>
            {MEMORY_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor={`${testPrefix}-content`}>Content ({fmtInt(d.content.length)} / {fmtInt(MEMORY_LIMITS.maxContentChars)} chars, about {fmtInt(Math.max(d.content.length ? 1 : 0, Math.ceil(d.content.length / 4)))} tokens)</label>
        <textarea id={`${testPrefix}-content`} rows={4} className={`${inputCls} w-full`} maxLength={MEMORY_LIMITS.maxContentChars} value={d.content} onChange={e => setD({ ...d, content: e.target.value })} data-testid={`${testPrefix}-content`} />
      </div>
      {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid={`${testPrefix}-error`}>{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel} disabled={busy} data-testid={`${testPrefix}-cancel`}>Cancel</Button>}
        <Button type="submit" disabled={busy} data-testid={`${testPrefix}-submit`}>{busy ? 'Saving...' : submitLabel}</Button>
      </div>
    </form>
  );
}

/** Project memory (real MemoryStore). Enabled items are injected into every provider request of the project. */
export default function MemoryPanel({ projectId }: { projectId: string }) {
  const base = `/projects/${encodeURIComponent(projectId)}/memory`;
  const list = useAsync(() => api.get<MemoryItemDto[]>(base), [projectId]);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string>();
  const [delId, setDelId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const items = list.data ?? [];
  const enabled = items.filter(i => i.enabled);
  const enabledTokens = enabled.reduce((s, i) => s + i.estimatedTokens, 0);

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setErr(undefined);
    try { await fn(); list.reload(); done?.(); } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  }
  const create = (d: Draft) => run(() => api.post(base, { ...d, enabled: true }), () => setAdding(false));
  const update = (id: string, d: Draft) => run(() => api.patch(`${base}/${id}`, d), () => setEditId(undefined));
  const toggle = (i: MemoryItemDto) => run(() => api.patch(`${base}/${i.id}`, { enabled: !i.enabled }));
  const remove = async () => { if (delId) await run(() => api.del(`${base}/${delId}`), () => setDelId(undefined)); };

  return (
    <Card title="Project memory" actions={
      <div className="flex items-center gap-2">
        <SourceBadge source="ACTUAL" />
        <Button variant="secondary" onClick={() => { setAdding(a => !a); setErr(undefined); }} data-testid="memory-add-toggle">{adding ? 'Close' : 'Add memory item'}</Button>
      </div>
    }>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400" data-testid="memory-privacy-note">
        Enabled items are injected into this project's provider requests (real memory injection, counted in input tokens). The content is stored in the app database only and
        is <strong>never written to logs, traces, events or activity</strong>: only counts, sizes, token estimates and hash prefixes are recorded.
        Up to {MEMORY_LIMITS.maxItemsPerProject} items, {fmtInt(MEMORY_LIMITS.maxContentChars)} characters each.
      </p>
      {adding && (
        <div className="mb-4 rounded-md border border-slate-200 p-3 dark:border-slate-700" data-testid="memory-add-panel">
          <ItemForm testPrefix="memory-add" initial={EMPTY} submitLabel="Add item" busy={busy} error={err} onSubmit={create} onCancel={() => setAdding(false)} />
        </div>
      )}
      <Async loading={list.loading && !list.data} error={list.error}>
        {items.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="memory-empty">No memory items yet. Requests for this project run without injected memory.</p>
        ) : (
          <>
            <p className="mb-2 text-sm" data-testid="memory-summary">
              <span data-testid="memory-enabled-count">{enabled.length}</span> of {items.length} items enabled - about <span data-testid="memory-enabled-tokens">{fmtInt(enabledTokens)}</span> tokens injected per request
            </p>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="memory-list">
              {items.map(i => (
                <li key={i.id} className="py-3" data-testid="memory-item" data-enabled={i.enabled}>
                  {editId === i.id ? (
                    <ItemForm testPrefix="memory-edit" initial={{ title: i.title, category: i.category, content: i.content }} submitLabel="Save" busy={busy} error={err} onSubmit={d => update(i.id, d)} onCancel={() => setEditId(undefined)} />
                  ) : (
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium" data-testid="memory-item-title">{i.title}</span>
                        <Badge tone="blue">{i.category}</Badge>
                        {!i.enabled && <Badge>disabled</Badge>}
                        <span className="text-xs text-slate-500 dark:text-slate-400" data-testid="memory-item-size">{fmtInt(i.sizeBytes)} bytes - about {fmtInt(i.estimatedTokens)} tokens</span>
                      </div>
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300" data-testid="memory-item-content">{i.content}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <label className="flex items-center gap-1.5 text-sm">
                          <input type="checkbox" checked={i.enabled} disabled={busy} onChange={() => toggle(i)} data-testid="memory-item-toggle" /> Enabled
                        </label>
                        <Button variant="secondary" onClick={() => { setEditId(i.id); setErr(undefined); }} disabled={busy} data-testid="memory-item-edit">Edit</Button>
                        <Button variant="danger" onClick={() => setDelId(i.id)} disabled={busy} data-testid="memory-item-delete">Delete</Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Async>
      {!adding && !editId && err && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300" data-testid="memory-error">{err}</p>}
      {delId && (
        <ConfirmDialog title="Delete memory item?" message="This permanently removes the item. Requests will no longer include it."
          confirmLabel="Delete item" busy={busy} error={err} confirmTestId="memory-delete-confirm" cancelTestId="memory-delete-cancel"
          onCancel={() => setDelId(undefined)} onConfirm={remove} />
      )}
    </Card>
  );
}
