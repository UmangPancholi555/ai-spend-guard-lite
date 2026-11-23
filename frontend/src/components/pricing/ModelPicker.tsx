import type { ProviderDto } from '@shared/types';
import { inputCls } from '../ui/Button';

export const CUSTOM = '__custom__';
const labelCls = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

export interface ModelSel { provider: string; model: string; customModel: string }
export const effectiveModel = (s: ModelSel) => (s.model === CUSTOM ? s.customModel.trim() : s.model);

export default function ModelPicker({ providers, value, onChange, showErrors }: {
  providers: ProviderDto[]; value: ModelSel; onChange: (v: ModelSel) => void; showErrors: boolean;
}) {
  const known = providers.find(p => p.key === value.provider);
  const models = (known?.models ?? []).filter(m => m.active);
  const missing = showErrors && !effectiveModel(value);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pricing-provider" className={labelCls}>Provider</label>
          <select id="pricing-provider" className={`${inputCls} w-full`} value={value.provider} data-testid="pricing-provider"
            onChange={e => {
              const p = providers.find(x => x.key === e.target.value);
              onChange({ ...value, provider: e.target.value, model: p?.models.find(m => m.active)?.name ?? CUSTOM });
            }}>
            {providers.map(p => <option key={p.key} value={p.key}>{p.displayName}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pricing-model" className={labelCls}>Model</label>
          <select id="pricing-model" className={`${inputCls} w-full`} value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} data-testid="pricing-model">
            {models.map(m => <option key={m.name} value={m.name}>{m.displayName} ({m.name})</option>)}
            <option value={CUSTOM}>Custom / unknown model...</option>
          </select>
        </div>
      </div>
      {value.model === CUSTOM && (
        <div>
          <label htmlFor="pricing-custom-model" className={labelCls}>Custom model name</label>
          <input id="pricing-custom-model" className={`${inputCls} w-full`} value={value.customModel} placeholder="e.g. my-experimental-model"
            onChange={e => onChange({ ...value, customModel: e.target.value })} aria-invalid={missing} data-testid="pricing-custom-model" />
          <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">Unknown models are priced with the fallback row and labeled ESTIMATED.</p>
          {missing && <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400" data-testid="pricing-model-error">Enter a model name.</p>}
        </div>
      )}
    </div>
  );
}
