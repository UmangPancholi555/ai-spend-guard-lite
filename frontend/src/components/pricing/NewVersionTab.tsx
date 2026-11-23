import { useMemo, useState, type FormEvent } from 'react';
import type { CostBreakdown, PricingDto } from '@shared/types';
import { Badge } from '../ui/Badge';
import { Button, inputCls } from '../ui/Button';
import { Card } from '../ui/Card';
import { api } from '../../lib/api';
import { fmtDateTime, fmtUsd } from '../../lib/format';
import { errMessage } from '../projects/util';
import { useToast } from '../ui/Toast';
import { PRICE_RE, costPico, localToIso, pctAbove, picoToUsd, priceToMicro, usdToPico, validateTokens } from './math';

const labelCls = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';
const errTxt = 'mt-1 text-xs text-red-700 dark:text-red-400';
const PROVIDER_RE = /^(\*|[a-z0-9][a-z0-9._-]*)$/;
const MODEL_RE = /^(\*|[A-Za-z0-9][A-Za-z0-9._:/@+-]*)$/;

interface Preview { before: CostBreakdown; afterTotal: string; afterParts: { input: string; output: string; cached: string }; tokens: { input: number; output: number; cached: number } }

export default function NewVersionTab({ rows, onCreated }: { rows: PricingDto[]; onCreated: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [inP, setInP] = useState('');
  const [outP, setOutP] = useState('');
  const [cachedP, setCachedP] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [sample, setSample] = useState({ input: '10000', output: '2000', cached: '1000' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [created, setCreated] = useState<PricingDto>();

  const providers = useMemo(() => [...new Set(rows.map(r => r.providerKey))].sort(), [rows]);
  const modelsFor = useMemo(() => [...new Set(rows.filter(r => r.providerKey === provider).map(r => r.modelName))].sort(), [rows, provider]);
  const current = rows.find(r => r.providerKey === provider && r.modelName === model && r.isCurrent);

  const errs: Record<string, string | undefined> = {
    provider: !provider.trim() ? 'Required.' : !PROVIDER_RE.test(provider.trim()) ? 'Lowercase slug (a-z, 0-9, . _ -) or *.' : undefined,
    model: !model.trim() ? 'Required.' : !MODEL_RE.test(model.trim()) ? 'Letters, digits and . _ : / @ + - only (or *).'
      : ((provider.trim() === '*') !== (model.trim() === '*')) ? 'Use * for both provider and model (fallback row), or for neither.' : undefined,
    inP: !PRICE_RE.test(inP.trim()) ? 'Non-negative decimal with at most 6 fraction digits.' : undefined,
    outP: !PRICE_RE.test(outP.trim()) ? 'Non-negative decimal with at most 6 fraction digits.' : undefined,
    cachedP: !PRICE_RE.test(cachedP.trim()) ? 'Non-negative decimal with at most 6 fraction digits.' : undefined,
    effectiveFrom: effectiveFrom && !localToIso(effectiveFrom) ? 'Invalid date/time.' : undefined,
    note: note.length > 500 ? 'At most 500 characters.' : undefined,
  };
  const formValid = Object.values(errs).every(v => !v);
  const show = (k: string) => (touched ? errs[k] : undefined);

  const fieldErr = (k: string) => show(k) && <p id={`nv-${k}-err`} role="alert" className={errTxt} data-testid={`pricing-new-${k}-error`}>{show(k)}</p>;

  async function runPreview() {
    setTouched(true); setPreviewError(undefined); setPreview(undefined);
    const t = validateTokens(sample);
    if (!formValid || !t.ok) { if (!t.ok) setPreviewError('Sample token counts must be non-negative whole numbers.'); return; }
    setPreviewBusy(true);
    try {
      const before = await api.post<CostBreakdown>('/cost/calculate', {
        provider: provider.trim(), model: model.trim(), inputTokens: t.value.input, outputTokens: t.value.output, cachedTokens: t.value.cached,
      });
      const ip = costPico(t.value.input, priceToMicro(inP.trim()));
      const op = costPico(t.value.output, priceToMicro(outP.trim()));
      const cp = costPico(t.value.cached, priceToMicro(cachedP.trim()));
      setPreview({ before, tokens: t.value, afterTotal: picoToUsd(ip + op + cp), afterParts: { input: picoToUsd(ip), output: picoToUsd(op), cached: picoToUsd(cp) } });
    } catch (e) { setPreviewError(errMessage(e)); }
    finally { setPreviewBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true); setError(undefined); setCreated(undefined);
    if (!formValid) return;
    setBusy(true);
    try {
      const iso = localToIso(effectiveFrom);
      const r = await api.post<PricingDto>('/cost/pricing', {
        provider: provider.trim(), model: model.trim(), inputPerMTok: inP.trim(), outputPerMTok: outP.trim(), cachedPerMTok: cachedP.trim(),
        ...(iso ? { effectiveFrom: iso } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      });
      setCreated(r); setPreview(undefined); onCreated();
      toast.success('Pricing version created', `${r.providerKey} / ${r.modelName} is now v${r.version}.`);
    } catch (err) { setError(errMessage(err)); toast.error('Could not create pricing version', errMessage(err)); }
    finally { setBusy(false); }
  }

  const beforePico = preview ? usdToPico(preview.before.totalCostUsd) : 0n;
  const afterPico = preview ? usdToPico(preview.afterTotal) : 0n;
  const delta = afterPico - beforePico;
  const pct = preview ? pctAbove(afterPico, beforePico) : null;

  const priceField = (k: 'inP' | 'outP' | 'cachedP', label: string, v: string, set: (s: string) => void, cur?: string, tid?: string) => (
    <div>
      <label htmlFor={`nv-${k}`} className={labelCls}>{label}</label>
      <input id={`nv-${k}`} inputMode="decimal" className={`${inputCls} w-full`} value={v} onChange={e => set(e.target.value)} placeholder={cur ? `current ${cur}` : '0.000000'}
        aria-invalid={!!show(k)} aria-describedby={show(k) ? `nv-${k}-err` : undefined} data-testid={tid} />
      {fieldErr(k)}
    </div>
  );

  return (
    <div>
      <Card title="Create a new pricing version (admin action)">
        <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="pricing-new-warning">
          <strong>Existing usage events keep their stored cost and pricing version.</strong> A new version only affects requests priced after its effective date; past usage is never re-priced. Versions are immutable once created. All prices here are DEMO / SIMULATED.
        </div>
        <form onSubmit={submit} noValidate className="space-y-4" data-testid="pricing-new-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="nv-provider" className={labelCls}>Provider (lowercase slug, or * for fallback)</label>
              <input id="nv-provider" list="nv-providers" className={`${inputCls} w-full`} value={provider} onChange={e => setProvider(e.target.value)} autoComplete="off"
                aria-invalid={!!show('provider')} aria-describedby={show('provider') ? 'nv-provider-err' : undefined} data-testid="pricing-new-provider" />
              <datalist id="nv-providers">{providers.map(p => <option key={p} value={p} />)}</datalist>
              {fieldErr('provider')}
            </div>
            <div>
              <label htmlFor="nv-model" className={labelCls}>Model (existing or new/unknown name, or *)</label>
              <input id="nv-model" list="nv-models" className={`${inputCls} w-full`} value={model} onChange={e => setModel(e.target.value)} autoComplete="off"
                aria-invalid={!!show('model')} aria-describedby={show('model') ? 'nv-model-err' : undefined} data-testid="pricing-new-model" />
              <datalist id="nv-models">{modelsFor.map(m => <option key={m} value={m} />)}</datalist>
              {fieldErr('model')}
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="pricing-new-target-hint">
            {current ? <>Current: v{current.version}, input {fmtUsd(current.inputPerMTok)} / output {fmtUsd(current.outputPerMTok)} / cached {fmtUsd(current.cachedPerMTok)} per MTok. The new version will be v{Math.max(...rows.filter(r => r.providerKey === provider && r.modelName === model).map(r => r.version)) + 1}.</>
              : provider && model ? 'No existing version for this provider/model: this creates v1 (a new model entry).' : 'Pick an existing model to base the new version on, or enter a new model name.'}
            {current && <> <button type="button" className="text-brand-600 underline dark:text-brand-100" onClick={() => { setInP(current.inputPerMTok); setOutP(current.outputPerMTok); setCachedP(current.cachedPerMTok); }} data-testid="pricing-new-copy">Copy current prices</button></>}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {priceField('inP', 'Input $ / 1M tokens', inP, setInP, current?.inputPerMTok, 'pricing-new-input')}
            {priceField('outP', 'Output $ / 1M tokens', outP, setOutP, current?.outputPerMTok, 'pricing-new-output')}
            {priceField('cachedP', 'Cached $ / 1M tokens', cachedP, setCachedP, current?.cachedPerMTok, 'pricing-new-cached')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="nv-from" className={labelCls}>Effective from (optional, your local time; blank = now)</label>
              <input id="nv-from" type="datetime-local" className={`${inputCls} w-full`} value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} data-testid="pricing-new-effective" />
              {fieldErr('effectiveFrom')}
              <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">Must not be earlier than the latest existing version's date.</p>
            </div>
            <div>
              <label htmlFor="nv-note" className={labelCls}>Note (optional, max 500)</label>
              <input id="nv-note" className={`${inputCls} w-full`} value={note} onChange={e => setNote(e.target.value)} data-testid="pricing-new-note" />
              {fieldErr('note')}
            </div>
          </div>

          <fieldset className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <legend className="px-1 text-sm font-semibold">Impact preview</legend>
            <p className="mb-3 text-xs text-slate-600 dark:text-slate-400">Cost of a sample workload now (via the calculator API) versus with the prices entered above (exact integer arithmetic in your browser).</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(['input', 'output', 'cached'] as const).map(k => (
                <div key={k}>
                  <label htmlFor={`nv-s-${k}`} className={labelCls}>Sample {k} tokens</label>
                  <input id={`nv-s-${k}`} inputMode="numeric" className={`${inputCls} w-full`} value={sample[k]} onChange={e => setSample({ ...sample, [k]: e.target.value })} data-testid={`pricing-new-sample-${k}`} />
                </div>
              ))}
            </div>
            <div className="mt-3"><Button type="button" variant="secondary" onClick={runPreview} disabled={previewBusy} data-testid="pricing-new-preview">{previewBusy ? 'Calculating...' : 'Preview impact'}</Button></div>
            {previewError && <p role="alert" className={errTxt} data-testid="pricing-new-preview-error">{previewError}</p>}
            {preview && (
              <div className="mt-3 text-sm" data-testid="pricing-new-preview-result">
                <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1">
                  <dt className="text-slate-600 dark:text-slate-400">Before (current pricing)</dt>
                  <dd className="text-right font-mono" data-testid="pricing-new-before">{fmtUsd(preview.before.totalCostUsd, 12)}</dd>
                  <dt className="text-slate-600 dark:text-slate-400">After (new prices)</dt>
                  <dd className="text-right font-mono" data-testid="pricing-new-after">{fmtUsd(preview.afterTotal, 12)}</dd>
                  <dt className="border-t border-slate-200 pt-1 font-semibold dark:border-slate-700">Change</dt>
                  <dd className="border-t border-slate-200 pt-1 text-right font-mono font-semibold dark:border-slate-700" data-testid="pricing-new-delta">
                    {delta === 0n ? 'no change' : `${delta > 0n ? '+' : '-'}${fmtUsd(picoToUsd(delta < 0n ? -delta : delta), 12)}`}{pct !== null && delta !== 0n ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)` : ''}
                  </dd>
                </dl>
                {preview.before.costClass === 'ESTIMATED' && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">"Before" used the fallback row (this model has no catalog entry yet), so it is an ESTIMATED figure. <Badge tone="amber">ESTIMATED</Badge></p>}
                {effectiveFrom && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Note: the new version only applies from its effective date; until then "before" pricing stays in force.</p>}
              </div>
            )}
          </fieldset>

          {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="pricing-new-error">{error}</p>}
          <div className="flex justify-end"><Button type="submit" disabled={busy} data-testid="pricing-new-submit">{busy ? 'Creating...' : 'Create new version'}</Button></div>
        </form>
      </Card>
      {created && (
        <div role="status" className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="pricing-new-success">
          Created <strong>{created.providerKey} / {created.modelName} v{created.version}</strong> effective {fmtDateTime(created.effectiveFrom)}
          {created.isCurrent ? ' (now current).' : ' (scheduled; not yet current).'} The catalog has been refreshed.
        </div>
      )}
    </div>
  );
}
