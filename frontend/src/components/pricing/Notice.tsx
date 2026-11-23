export function PricingNotice() {
  return (
    <div role="note" data-testid="pricing-notice" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-900">DEMO / SIMULATED</span>
      <span>Illustrative prices, not real vendor prices. Nothing here is a quote or an invoice.</span>
    </div>
  );
}

export const CONVENTION_NOTE =
  'Convention: inputTokens are the non-cached input tokens. Cached tokens are billed separately at the cached rate and are not included in inputTokens. Cost = tokens × $/MTok ÷ 1,000,000 for each class.';
