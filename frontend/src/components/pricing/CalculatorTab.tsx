import { useState, type FormEvent } from 'react';
import type { CostBreakdown, PricingDto, ProviderDto } from '@shared/types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { api } from '../../lib/api';
import { errMessage } from '../projects/util';
import ModelPicker, { effectiveModel, type ModelSel } from './ModelPicker';
import TokenInputs, { type CalcFields } from './TokenInputs';
import CostResult from './CostResult';
import { CONVENTION_NOTE } from './Notice';
import { localToIso, validateTokens, type TokenCounts } from './math';

export default function CalculatorTab({ providers, sel, onSel, fields, onFields, catalog }: {
  providers: ProviderDto[]; sel: ModelSel; onSel: (s: ModelSel) => void;
  fields: CalcFields; onFields: (f: CalcFields) => void; catalog?: PricingDto[];
}) {
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [out, setOut] = useState<{ cost: CostBreakdown; tokens: TokenCounts; label: string }>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setShowErrors(true); setError(undefined);
    const t = validateTokens(fields);
    const model = effectiveModel(sel);
    if (!t.ok || !model || !sel.provider) return;
    const at = localToIso(fields.at);
    if (fields.at && !at) { setError('"Price as of" is not a valid date/time.'); return; }
    setBusy(true);
    try {
      const cost = await api.post<CostBreakdown>('/cost/calculate', {
        provider: sel.provider, model, inputTokens: t.value.input, outputTokens: t.value.output, cachedTokens: t.value.cached, ...(at ? { at } : {}),
      });
      setOut({ cost, tokens: t.value, label: `${sel.provider} / ${model}` });
    } catch (err) { setError(errMessage(err)); setOut(undefined); }
    finally { setBusy(false); }
  }

  const version = out && catalog?.find(p => p.id === out.cost.pricingConfigId);

  return (
    <div>
      <Card title="Cost calculator">
        <form onSubmit={submit} noValidate className="space-y-4" data-testid="pricing-calc-form">
          <ModelPicker providers={providers} value={sel} onChange={onSel} showErrors={showErrors} />
          <TokenInputs v={fields} onChange={onFields} showErrors={showErrors} />
          <p className="text-xs text-slate-500 dark:text-slate-400">{CONVENTION_NOTE}</p>
          {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="pricing-calc-error">{error}</p>}
          <div className="flex justify-end"><Button type="submit" disabled={busy} data-testid="pricing-calc-submit">{busy ? 'Calculating...' : 'Calculate cost'}</Button></div>
        </form>
      </Card>
      {out && <CostResult cost={out.cost} tokens={out.tokens} label={out.label} version={version} />}
    </div>
  );
}
