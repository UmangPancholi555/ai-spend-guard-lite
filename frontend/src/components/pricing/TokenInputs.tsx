import { inputCls } from '../ui/Button';
import { validateTokens, type TokenFieldValues } from './math';

const labelCls = 'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400';

export interface CalcFields extends TokenFieldValues { at: string }

/** Token counts + optional "price as of" field. `showErrors` reveals validation messages. */
export default function TokenInputs({ v, onChange, showErrors, idPrefix = 'pricing' }: {
  v: CalcFields; onChange: (n: CalcFields) => void; showErrors: boolean; idPrefix?: string;
}) {
  const res = validateTokens(v);
  const err = (k: keyof TokenFieldValues) => (showErrors && !res.ok ? res.errors[k] : undefined);
  const field = (k: keyof TokenFieldValues, label: string, hint?: string) => (
    <div>
      <label htmlFor={`${idPrefix}-${k}`} className={labelCls}>{label}</label>
      <input id={`${idPrefix}-${k}`} inputMode="numeric" className={`${inputCls} w-full`} value={v[k]}
        onChange={e => onChange({ ...v, [k]: e.target.value })} aria-invalid={!!err(k)} aria-describedby={err(k) ? `${idPrefix}-${k}-err` : undefined}
        data-testid={`pricing-${k}-tokens`} />
      {hint && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{hint}</p>}
      {err(k) && <p id={`${idPrefix}-${k}-err`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid={`pricing-${k}-error`}>{err(k)}</p>}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {field('input', 'Input tokens (non-cached)')}
        {field('output', 'Output tokens')}
        {field('cached', 'Cached tokens', 'Billed separately; not part of input tokens.')}
      </div>
      <div className="max-w-xs">
        <label htmlFor={`${idPrefix}-at`} className={labelCls}>Price as of (optional, your local time)</label>
        <input id={`${idPrefix}-at`} type="datetime-local" className={`${inputCls} w-full`} value={v.at} onChange={e => onChange({ ...v, at: e.target.value })} data-testid="pricing-at" />
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Selects the pricing version effective at that time. Blank = now.</p>
      </div>
    </div>
  );
}
