import { useEffect, useState } from 'react';
import type { AppSettings, BackgroundTaskDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Button, inputCls } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Async } from '../components/ui/State';
import { Badge, SourceBadge, StatusBadge } from '../components/ui/Badge';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { fmtDateTime, fmtMs } from '../lib/format';
import { Field, JsonBlock, KeyVal, StackBlock } from '../components/observability/common';
import { useToast } from '../components/ui/Toast';
import { useReadOnly } from '../components/auth/readOnly';

function intError(v: string, min: number, max: number, label: string): string | null {
  if (!/^\d+$/.test(v.trim())) return `${label} must be a whole number.`;
  const n = Number(v);
  if (n < min || n > max) return `${label} must be between ${min} and ${max}.`;
  return null;
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.get<AppSettings>('/settings'), []);
  const toast = useToast();
  const { readOnly, guard } = useReadOnly();
  const [retention, setRetention] = useState('');
  const [slow, setSlow] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [sweepError, setSweepError] = useState<string>();
  const [sweep, setSweep] = useState<BackgroundTaskDto>();

  useEffect(() => {
    if (data) { setRetention(String(data.retentionDays)); setSlow(String(data.slowOperationMs)); }
  }, [data]);

  const retErr = retention === '' ? null : intError(retention, 0, 3650, 'Retention days');
  const slowErr = slow === '' ? null : intError(slow, 1, 600000, 'Slow operation threshold');
  const invalid = retention === '' || slow === '' || !!retErr || !!slowErr;
  const dirty = !!data && (retention !== String(data.retentionDays) || slow !== String(data.slowOperationMs));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || invalid) return;
    setSaving(true); setSaveError(undefined); setSaved(false);
    try {
      await api.put<AppSettings>('/settings', { retentionDays: Number(retention), slowOperationMs: Number(slow) });
      setSaved(true);
      toast.success('Settings saved');
      reload();
    } catch (err) { setSaveError((err as Error).message); toast.error('Could not save settings', (err as Error).message); } finally { setSaving(false); }
  }

  async function runSweep() {
    if (readOnly) return;
    setSweeping(true); setSweepError(undefined);
    try { const t = await api.post<BackgroundTaskDto>('/logging/retention/run'); setSweep(t); toast.success('Retention sweep finished', `Status: ${t.status}`); }
    catch (err) { setSweepError((err as Error).message); setSweep(undefined); toast.error('Retention sweep failed', (err as Error).message); }
    finally { setSweeping(false); }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" subtitle="Log retention, slow-operation threshold and privacy behavior." />
      <Async loading={loading && !data} error={error} skeleton="lines">
        <Card title="Logging and retention">
          <form onSubmit={save} noValidate className="space-y-4" data-testid="settings-form">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Retention (days, 0 = keep forever)">
                <input className={inputCls} inputMode="numeric" value={retention} disabled={readOnly} onChange={e => { setRetention(e.target.value); setSaved(false); }}
                  aria-invalid={!!retErr} data-testid="settings-retention-input" />
                {retErr && <span className="text-xs text-red-700 dark:text-red-400" data-testid="settings-retention-error">{retErr}</span>}
              </Field>
              <Field label="Slow operation threshold (ms)">
                <input className={inputCls} inputMode="numeric" value={slow} disabled={readOnly} onChange={e => { setSlow(e.target.value); setSaved(false); }}
                  aria-invalid={!!slowErr} data-testid="settings-slow-input" />
                {slowErr && <span className="text-xs text-red-700 dark:text-red-400" data-testid="settings-slow-error">{slowErr}</span>}
              </Field>
            </div>
            <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={false} disabled readOnly aria-describedby="plaintext-help" data-testid="settings-capture-plaintext" />
                  Capture content in plaintext
                </label>
                <span data-testid="settings-capture-plaintext-state"><Badge tone="green">OFF - fixed, cannot be changed</Badge></span>
              </div>
              <p id="plaintext-help" className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                Prompts, responses, memory, context and tool inputs/outputs are never written to logs, traces or the database in plaintext. Only hashes, sizes, counts, token estimates and key names are recorded. This is not configurable.
              </p>
            </div>
            {saveError && <div role="alert" data-testid="settings-error" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{saveError}</div>}
            <div className="flex items-center gap-3">
              <Button type="submit" {...guard(saving || invalid || !dirty)} data-testid="settings-save">{saving ? 'Saving...' : 'Save settings'}</Button>
              {saved && !dirty && <span role="status" className="text-sm text-emerald-700 dark:text-emerald-300" data-testid="settings-saved">Settings saved.</span>}
            </div>
          </form>
        </Card>

        <Card title="Retention sweep">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Deletes execution logs, memory/bus/tool/context events and finished traces older than the saved retention
            ({data ? (data.retentionDays === 0 ? 'keep forever, so nothing is deleted' : `${data.retentionDays} days`) : '...'}). Budgets, usage and projects are never touched. Save changes above before running.
          </p>
          <div className="mt-3"><Button variant="secondary" onClick={runSweep} {...guard(sweeping)} data-testid="settings-retention-run">{sweeping ? 'Running sweep...' : 'Run retention sweep now'}</Button></div>
          {sweepError && <div role="alert" data-testid="retention-error" className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{sweepError}</div>}
          {sweep && (
            <div className="mt-4 space-y-3" data-testid="retention-result" role="status">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{sweep.name}</span><StatusBadge status={sweep.status} /><SourceBadge source={sweep.source} /></div>
              <dl className="grid gap-3 sm:grid-cols-3">
                <KeyVal k="Started">{fmtDateTime(sweep.startedAt)}</KeyVal>
                <KeyVal k="Duration">{fmtMs(sweep.durationMs)}</KeyVal>
                <KeyVal k="Task id"><span className="font-mono text-xs">{sweep.id}</span></KeyVal>
              </dl>
              {sweep.errorMessage && <div className="text-sm text-red-700 dark:text-red-300">{sweep.errorMessage}</div>}
              <StackBlock stack={sweep.stack} />
              <JsonBlock data={sweep.result} testId="retention-result-json" label="Sweep result" />
            </div>
          )}
        </Card>
      </Async>

      <Card title="Privacy and simulation">
        <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700 dark:text-slate-300" data-testid="settings-explainer">
          <li><strong>No real AI vendor is ever called.</strong> All provider requests are produced by a local deterministic mock, so spend, tokens and costs are DEMO / SIMULATED figures.</li>
          <li><strong>Sensitive content is never stored in plaintext.</strong> Only hashes, lengths, counts, token estimates and metadata key names are persisted.</li>
          <li><strong>ACTUAL vs DEMO / SIMULATED.</strong> ACTUAL events come from real instrumented code in this app (request pipeline, budget evaluation, error handling). Memory, tool and context events exist only because the simulator emits them, so they are always labelled DEMO / SIMULATED.</li>
          <li><strong>Exports</strong> (JSONL and CSV) are generated from the database and contain the same metadata-only fields shown in the UI.</li>
        </ul>
      </Card>
    </div>
  );
}
