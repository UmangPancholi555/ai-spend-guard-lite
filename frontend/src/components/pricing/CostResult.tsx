import { useState } from 'react';
import type { CostBreakdown, PricingDto } from '@shared/types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { fmtDateTime, fmtInt, fmtUsd } from '../../lib/format';
import { COST_CLASS_EXPLANATION } from '../usage/CostBreakdownView';
import { CONVENTION_NOTE } from './Notice';
import type { TokenCounts } from './math';

/** Result card for POST /cost/calculate. `version` (if found in the catalog) supplies effectiveFrom. */
export default function CostResult({ cost, tokens, label, version }: { cost: CostBreakdown; tokens: TokenCounts; label: string; version?: PricingDto }) {
  const [raw, setRaw] = useState(false);
  const money = (s: string) => (raw ? s : fmtUsd(s, 12));
  const lines = [
    { k: 'input', name: 'Input (non-cached)', tokens: tokens.input, rate: cost.pricing.inputPerMTok, cost: cost.inputCostUsd },
    { k: 'output', name: 'Output', tokens: tokens.output, rate: cost.pricing.outputPerMTok, cost: cost.outputCostUsd },
    { k: 'cached', name: 'Cached', tokens: tokens.cached, rate: cost.pricing.cachedPerMTok, cost: cost.cachedCostUsd },
  ];
  return (
    <Card title={`Result for ${label}`} className="mt-4"
      actions={<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} data-testid="pricing-raw-toggle" /> Show raw strings</label>}>
      <div data-testid="pricing-result" className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-semibold" data-testid="pricing-total">{money(cost.totalCostUsd)}</span>
          <span data-testid="pricing-cost-class"><Badge tone={cost.costClass === 'ESTIMATED' ? 'amber' : 'blue'}>{cost.costClass}</Badge></span>
          <Badge tone="amber">DEMO / SIMULATED</Badge>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-300" data-testid="pricing-class-explanation">
          {COST_CLASS_EXPLANATION[cost.costClass]}{cost.unknownModel ? ' (This model is unknown to the catalog.)' : ''}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:max-w-md">
          <dt className="text-slate-500 dark:text-slate-400">Input cost</dt><dd className="text-right font-mono" data-testid="pricing-input-cost">{money(cost.inputCostUsd)}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Output cost</dt><dd className="text-right font-mono" data-testid="pricing-output-cost">{money(cost.outputCostUsd)}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Cached cost</dt><dd className="text-right font-mono" data-testid="pricing-cached-cost">{money(cost.cachedCostUsd)}</dd>
          <dt className="border-t border-slate-200 pt-1 font-semibold dark:border-slate-700">Total</dt>
          <dd className="border-t border-slate-200 pt-1 text-right font-mono font-semibold dark:border-slate-700" data-testid="pricing-total-cost">{money(cost.totalCostUsd)}</dd>
        </dl>
        <div>
          <h3 className="mb-1 font-semibold">Pricing used</h3>
          <p data-testid="pricing-version-used">
            {cost.pricingVersion === null ? 'No catalog version (fallback)' : `Version v${cost.pricingVersion}`}
            {version ? <> - effective from {fmtDateTime(version.effectiveFrom)}{version.note ? ` - ${version.note}` : ''}</> : null}
            {version && (version.providerKey === '*') ? ' (fallback row)' : ''}
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold">How it was computed</h3>
          <ul className="space-y-1 font-mono text-xs" data-testid="pricing-formulas">
            {lines.map(l => (
              <li key={l.k} data-testid={`pricing-formula-${l.k}`}>
                <span className="font-sans text-slate-500 dark:text-slate-400">{l.name}: </span>
                {fmtInt(l.tokens)} × {fmtUsd(l.rate)}/MTok ÷ 1,000,000 = {money(l.cost)}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400" data-testid="pricing-convention">{CONVENTION_NOTE}</p>
      </div>
    </Card>
  );
}
