/** Prominent label: every figure in this app is simulated mock data. */
export default function DemoBanner({ children }: { children?: React.ReactNode }) {
  return (
    <div role="note" data-testid="demo-banner" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-900">DEMO / SIMULATED</span>
      <span>{children ?? 'All costs and usage shown here come from a local mock provider. No real AI vendor is contacted and no real money is spent.'}</span>
    </div>
  );
}
