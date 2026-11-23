import { useMemo, useState, type FormEvent } from 'react';
import type { CostBreakdown, ProviderDto } from '@shared/types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Td } from '../ui/Table';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import { errMessage } from '../projects/util';
import TokenInputs, { type CalcFields } from './TokenInputs';
import { localToIso, pctAbove, usdToPico, validateTokens } from './math';

interface Row { provider: string; model: string; displayName: string; cost?: CostBreakdown; error?: string }
type SortKey = 'cost' | 'model' | 'provider';

export default function CompareTab({ providers, fields, onFields }: { providers: ProviderDto[]; fields: CalcFields; onFields: (f: CalcFields) => void }) {
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rows, setRows] = useState<Row[]>();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cost', dir: 1 });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setShowErrors(true); setError(undefined);
    const t = validateTokens(fields);
    if (!t.ok) return;
    const at = localToIso(fields.at);
    if (fields.at && !at) { setError('"Price as of" is not a valid date/time.'); return; }
    const targets = providers.flatMap(p => p.models.filter(m => m.active).map(m => ({ provider: p.key as string, model: m.name, displayName: m.displayName })));
    if (targets.length === 0) { setError('No models are available to compare.'); return; }
    setBusy(true);
    try {
      const results = await Promise.all(targets.map(async (tg): Promise<Row> => {
        try {
          const cost = await api.post<CostBreakdown>('/cost/calculate', {
            provider: tg.provider, model: tg.model, inputTokens: t.value.input, outputTokens: t.value.output, cachedTokens: t.value.cached, ...(at ? { at } : {}),
          });
          return { ...tg, cost };
        } catch (err) { return { ...tg, error: errMessage(err) }; }
      }));
      setRows(results);
    } catch (err) { setError(errMessage(err)); }
    finally { setBusy(false); }
  }

  const view = useMemo(() => {
    if (!rows) return undefined;
    const priced = rows.filter(r => r.cost).map(r => usdToPico(r.cost!.totalCostUsd));
    const min = priced.length ? priced.reduce((a, b) => (b < a ? b : a)) : undefined;
    const withPct = rows.map(r => {
      const pico = r.cost ? usdToPico(r.cost.totalCostUsd) : undefined;
      return { ...r, pico, cheapest: pico !== undefined && pico === min, pct: pico !== undefined && min !== undefined ? pctAbove(pico, min) : null };
    });
    return [...withPct].sort((a, b) => {
      if (sort.key === 'cost') {
        if (a.pico === undefined) return 1; if (b.pico === undefined) return -1;
        return (a.pico < b.pico ? -1 : a.pico > b.pico ? 1 : a.model.localeCompare(b.model)) * sort.dir;
      }
      return (a[sort.key].localeCompare(b[sort.key]) || a.model.localeCompare(b.model)) * sort.dir;
    });
  }, [rows, sort]);

  const th = (key: SortKey, label: string) => (
    <button type="button" className="font-semibold uppercase tracking-wide" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      aria-label={`Sort by ${label}`} data-testid={`pricing-sort-${key}`}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  );

  return (
    <div>
      <Card title="Compare the same workload across all models">
        <form onSubmit={submit} noValidate className="space-y-4" data-testid="pricing-compare-form">
          <TokenInputs v={fields} onChange={onFields} showErrors={showErrors} idPrefix="cmp" />
          {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="pricing-compare-error">{error}</p>}
          <div className="flex justify-end"><Button type="submit" disabled={busy} data-testid="pricing-compare-submit">{busy ? 'Comparing...' : 'Compare models'}</Button></div>
        </form>
      </Card>
      {view && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800" data-testid="pricing-compare-result">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2">{th('provider', 'Provider')}</th>
                <th scope="col" className="px-3 py-2">{th('model', 'Model')}</th>
                <th scope="col" className="px-3 py-2">{th('cost', 'Total cost')}</th>
                <th scope="col" className="px-3 py-2 uppercase tracking-wide font-semibold">vs cheapest</th>
                <th scope="col" className="px-3 py-2 uppercase tracking-wide font-semibold">Class</th>
                <th scope="col" className="px-3 py-2 uppercase tracking-wide font-semibold">Pricing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900/50">
              {view.map(r => (
                <tr key={`${r.provider}/${r.model}`} data-testid="pricing-compare-row" data-cheapest={r.cheapest ? 'true' : 'false'}
                  className={r.cheapest ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}>
                  <Td>{r.provider}</Td>
                  <Td><span className="font-medium">{r.model}</span></Td>
                  {r.cost ? (
                    <>
                      <Td className="font-mono" ><span data-testid="pricing-compare-total">{fmtUsd(r.cost.totalCostUsd, 12)}</span> {r.cheapest && <Badge tone="green">cheapest</Badge>}</Td>
                      <Td><span data-testid="pricing-compare-pct">{r.cheapest ? 'baseline' : r.pct === null ? '-' : `+${r.pct.toFixed(2)}%`}</span></Td>
                      <Td><Badge tone={r.cost.costClass === 'ESTIMATED' ? 'amber' : 'blue'}>{r.cost.costClass}</Badge></Td>
                      <Td>{r.cost.pricingVersion === null ? 'fallback' : `v${r.cost.pricingVersion}`}</Td>
                    </>
                  ) : (
                    <td colSpan={4} className="px-3 py-2 text-red-600 dark:text-red-400"><span role="alert">{r.error}</span></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            DEMO / SIMULATED illustrative prices. Percentages use exact integer arithmetic on the returned cost strings.
          </p>
        </div>
      )}
    </div>
  );
}
