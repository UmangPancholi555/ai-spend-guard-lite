import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PricingDto, ProviderDto } from '@shared/types';
import PageHeader from '../components/ui/PageHeader';
import { Async } from '../components/ui/State';
import { api } from '../lib/api';
import { useAsync } from '../lib/useApi';
import { PricingNotice } from '../components/pricing/Notice';
import { CUSTOM, type ModelSel } from '../components/pricing/ModelPicker';
import type { CalcFields } from '../components/pricing/TokenInputs';
import CalculatorTab from '../components/pricing/CalculatorTab';
import CompareTab from '../components/pricing/CompareTab';
import CatalogTab from '../components/pricing/CatalogTab';
import NewVersionTab from '../components/pricing/NewVersionTab';

const TABS = [
  { id: 'calculator', label: 'Calculator' },
  { id: 'compare', label: 'Compare models' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'new', label: 'New version' },
] as const;
type TabId = typeof TABS[number]['id'];

export default function PricingPage() {
  const [sp, setSp] = useSearchParams();
  const tabParam = sp.get('tab');
  const tab: TabId = TABS.some(t => t.id === tabParam) ? (tabParam as TabId) : 'calculator';
  const setTab = (t: TabId) => setSp(p => { const n = new URLSearchParams(p); if (t === 'calculator') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });

  const providers = useAsync(() => api.get<ProviderDto[]>('/providers'), []);
  const catalog = useAsync(() => api.get<PricingDto[]>('/cost/pricing', { history: true }), []);

  // Calculator state is shared with the Compare tab (same token counts). Query string prefill: ?provider=&model=&in=&out=&cached=
  const [sel, setSel] = useState<ModelSel>({ provider: '', model: '', customModel: '' });
  const [fields, setFields] = useState<CalcFields>({ input: sp.get('in') ?? '1000', output: sp.get('out') ?? '500', cached: sp.get('cached') ?? '0', at: '' });
  useEffect(() => {
    const list = providers.data;
    if (!list || list.length === 0 || sel.provider) return;
    const qp = sp.get('provider'), qm = sp.get('model');
    const p = list.find(x => x.key === qp) ?? list[0];
    if (qp && qm && p.key === qp) {
      const known = p.models.some(m => m.name === qm);
      setSel({ provider: p.key, model: known ? qm : CUSTOM, customModel: known ? '' : qm });
    } else {
      setSel({ provider: p.key, model: p.models.find(m => m.active)?.name ?? CUSTOM, customModel: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data]);

  return (
    <div>
      <PageHeader title="Pricing & Cost Calculator" subtitle="Calculate, compare and manage the illustrative per-model price catalog." />
      <PricingNotice />
      <div role="tablist" aria-label="Pricing sections" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" id={`pricing-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`pricing-panel-${t.id}`}
            onClick={() => setTab(t.id)} data-testid={`pricing-tab-${t.id}`}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`pricing-panel-${tab}`} aria-labelledby={`pricing-tab-${tab}`}>
        <Async loading={(providers.loading && !providers.data) || (catalog.loading && !catalog.data)} error={providers.error ?? catalog.error}>
          {providers.data && catalog.data && (
            <>
              {tab === 'calculator' && <CalculatorTab providers={providers.data} sel={sel} onSel={setSel} fields={fields} onFields={setFields} catalog={catalog.data} />}
              {tab === 'compare' && <CompareTab providers={providers.data} fields={fields} onFields={setFields} />}
              {tab === 'catalog' && <CatalogTab rows={catalog.data} />}
              {tab === 'new' && <NewVersionTab rows={catalog.data} onCreated={catalog.reload} />}
            </>
          )}
        </Async>
      </div>
    </div>
  );
}
