import { Fragment, useMemo, useState } from 'react';
import type { PricingDto } from '@shared/types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { inputCls } from '../ui/Button';
import { EmptyState } from '../ui/Table';
import { fmtDateTime, fmtUsd } from '../../lib/format';

const labelCls = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';
const isFallback = (p: PricingDto) => p.providerKey === '*' && p.modelName === '*';

interface Group { key: string; provider: string; model: string; versions: PricingDto[]; shown: PricingDto }

/** Catalog of pricing versions. Data = GET /cost/pricing?history=true (rows carry isCurrent; the current row per model is the "current price"). */
export default function CatalogTab({ rows }: { rows: PricingDto[] }) {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, PricingDto[]>();
    for (const r of rows) (m.get(`${r.providerKey}/${r.modelName}`) ?? m.set(`${r.providerKey}/${r.modelName}`, []).get(`${r.providerKey}/${r.modelName}`)!).push(r);
    return [...m.entries()].map(([key, vs]) => {
      const versions = [...vs].sort((a, b) => b.version - a.version);
      return { key, provider: versions[0].providerKey, model: versions[0].modelName, versions, shown: versions.find(v => v.isCurrent) ?? versions[0] };
    }).sort((a, b) => (isFallback(a.shown) ? 1 : isFallback(b.shown) ? -1 : a.key.localeCompare(b.key)));
  }, [rows]);

  const providers = [...new Set(rows.filter(r => r.providerKey !== '*').map(r => r.providerKey))].sort();
  const q = model.trim().toLowerCase();
  const filtered = groups.filter(g => (!provider || g.provider === provider || isFallback(g.shown) && provider === '*') && (!q || g.model.toLowerCase().includes(q)));

  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <Card title="Pricing catalog (DEMO / SIMULATED illustrative prices, USD per 1M tokens)">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="catalog-provider" className={labelCls}>Provider</label>
          <select id="catalog-provider" className={inputCls} value={provider} onChange={e => setProvider(e.target.value)} data-testid="pricing-catalog-provider">
            <option value="">All providers</option>
            {providers.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="*">* (fallback)</option>
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="catalog-model" className={labelCls}>Model contains</label>
          <input id="catalog-model" type="search" className={`${inputCls} w-full`} value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. gpt" data-testid="pricing-catalog-model" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800" data-testid="pricing-catalog-table">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              {['Provider', 'Model', 'Version', 'Input', 'Output', 'Cached', 'Effective from', 'History'].map(h => <th key={h} scope="col" className="whitespace-nowrap px-3 py-2">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900/50">
            {filtered.map(g => {
              const fb = isFallback(g.shown);
              const expanded = open.has(g.key);
              return (
                <Fragment key={g.key}>
                  <tr data-testid="pricing-catalog-row" data-model={g.model} data-provider={g.provider}>
                    <td className="whitespace-nowrap px-3 py-2">{fb ? <Badge tone="purple">fallback</Badge> : g.provider}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium">{g.model}</td>
                    <td className="whitespace-nowrap px-3 py-2">v{g.shown.version} {g.shown.isCurrent ? <Badge tone="green">current</Badge> : <Badge tone="amber">scheduled</Badge>}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtUsd(g.shown.inputPerMTok)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtUsd(g.shown.outputPerMTok)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtUsd(g.shown.cachedPerMTok)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDateTime(g.shown.effectiveFrom)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <button type="button" className="text-brand-600 underline dark:text-brand-100" aria-expanded={expanded} onClick={() => toggle(g.key)} data-testid="pricing-history-toggle">
                        {expanded ? 'Hide' : 'Show'} {g.versions.length} version{g.versions.length === 1 ? '' : 's'}
                      </button>
                    </td>
                  </tr>
                  {fb && (
                    <tr><td colSpan={8} className="bg-purple-50 px-3 py-2 text-xs text-purple-900 dark:bg-purple-950/30 dark:text-purple-200" data-testid="pricing-fallback-note">
                      Fallback row (<code>*</code> / <code>*</code>): used for any model that has no catalog entry. Costs priced with it are labeled ESTIMATED.
                    </td></tr>
                  )}
                  {expanded && (
                    <tr><td colSpan={8} className="bg-slate-50 px-3 py-2 dark:bg-slate-900" data-testid="pricing-history">
                      <table className="min-w-full text-xs">
                        <thead className="text-left text-slate-600 dark:text-slate-400"><tr><th className="py-1 pr-3">Version</th><th className="pr-3">Input</th><th className="pr-3">Output</th><th className="pr-3">Cached</th><th className="pr-3">Effective from</th><th className="pr-3">Status</th><th>Note</th></tr></thead>
                        <tbody>
                          {g.versions.map(v => (
                            <tr key={v.id} data-testid="pricing-history-row" className="border-t border-slate-200 dark:border-slate-700">
                              <td className="py-1 pr-3">v{v.version}</td>
                              <td className="pr-3 font-mono">{fmtUsd(v.inputPerMTok)}</td>
                              <td className="pr-3 font-mono">{fmtUsd(v.outputPerMTok)}</td>
                              <td className="pr-3 font-mono">{fmtUsd(v.cachedPerMTok)}</td>
                              <td className="pr-3">{fmtDateTime(v.effectiveFrom)}</td>
                              <td className="pr-3">{v.isCurrent ? <Badge tone="green">current</Badge> : <Badge>superseded</Badge>}</td>
                              <td className="min-w-[8rem] whitespace-normal">{v.note ?? '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState message="No pricing rows match these filters." />}
      </div>
      <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">Versions are immutable. A usage event keeps the pricing version it was priced with.</p>
    </Card>
  );
}
