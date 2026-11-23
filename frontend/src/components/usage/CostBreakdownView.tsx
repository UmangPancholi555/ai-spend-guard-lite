import type { CostBreakdown } from '@shared/types';
import { Badge } from '../ui/Badge';
import { fmtUsd } from '../../lib/format';

export const COST_CLASS_EXPLANATION: Record<'SIMULATED' | 'ESTIMATED', string> = {
  SIMULATED: 'SIMULATED: priced from a known model\'s configured (demo) pricing table. Not a real invoice.',
  ESTIMATED: 'ESTIMATED: the model name is not in the pricing table, so fallback pricing was used. Treat the figure as a rough estimate.',
};

type Parts = Pick<CostBreakdown, 'inputCostUsd' | 'outputCostUsd' | 'cachedCostUsd' | 'totalCostUsd' | 'costClass' | 'pricingVersion'> & Partial<Pick<CostBreakdown, 'pricing' | 'unknownModel'>>;

export default function CostBreakdownView({ cost, testId = 'cost-breakdown' }: { cost: Parts; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-600 dark:text-slate-400">Input cost</dt><dd className="text-right font-mono" data-testid="cost-input">{fmtUsd(cost.inputCostUsd, 12)}</dd>
        <dt className="text-slate-600 dark:text-slate-400">Output cost</dt><dd className="text-right font-mono" data-testid="cost-output">{fmtUsd(cost.outputCostUsd, 12)}</dd>
        <dt className="text-slate-600 dark:text-slate-400">Cached cost</dt><dd className="text-right font-mono" data-testid="cost-cached">{fmtUsd(cost.cachedCostUsd, 12)}</dd>
        <dt className="border-t border-slate-200 pt-1 font-semibold dark:border-slate-700">Total</dt>
        <dd className="border-t border-slate-200 pt-1 text-right font-mono font-semibold dark:border-slate-700" data-testid="cost-total">{fmtUsd(cost.totalCostUsd, 12)}</dd>
        <dt className="text-slate-600 dark:text-slate-400">Cost class</dt>
        <dd className="text-right"><Badge tone={cost.costClass === 'ESTIMATED' ? 'amber' : 'blue'}>{cost.costClass}</Badge></dd>
        <dt className="text-slate-600 dark:text-slate-400">Pricing version</dt>
        <dd className="text-right" data-testid="cost-pricing-version">{cost.pricingVersion === null ? 'fallback (none)' : `v${cost.pricingVersion}`}</dd>
      </dl>
      {cost.pricing && (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          Rates per 1M tokens: input {fmtUsd(cost.pricing.inputPerMTok)}, output {fmtUsd(cost.pricing.outputPerMTok)}, cached {fmtUsd(cost.pricing.cachedPerMTok)}.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300" data-testid="cost-class-explanation">{COST_CLASS_EXPLANATION[cost.costClass]}</p>
    </div>
  );
}
