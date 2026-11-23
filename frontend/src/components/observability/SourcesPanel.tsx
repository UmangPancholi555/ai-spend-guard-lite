import type { InstrumentationSourceDto } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Async } from '../ui/State';

const STATUS: Record<InstrumentationSourceDto['status'], { tone: 'green' | 'amber' | 'slate'; text: string }> = {
  CONNECTED: { tone: 'green', text: 'A real instrumented component of this app emits these events. They are labelled ACTUAL.' },
  SIMULATED_ONLY: { tone: 'amber', text: 'This app has no real runtime for this. Every event shown comes from the DEMO / SIMULATED generator, not real activity.' },
  UNAVAILABLE: { tone: 'slate', text: 'No instrumentation source and no events exist. Nothing is shown for this, and nothing is presented as real.' },
};

export default function SourcesPanel() {
  const { data, error, loading } = useAsync(() => api.get<InstrumentationSourceDto[]>('/observability/sources'), []);
  return (
    <Card title="Instrumentation sources">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Where each kind of event comes from. <strong>CONNECTED</strong> means real instrumented code; <strong>SIMULATED_ONLY</strong> means only the demo generator produces it;
        <strong> UNAVAILABLE</strong> means there is no source at all. Simulated events are never counted or labelled as actual.
      </p>
      <Async loading={loading && !data} error={error} skeleton="cards">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="sources-panel">
          {(data ?? []).map(s => {
            const st = STATUS[s.status];
            return (
              <div key={s.id} data-testid="source-card" data-kind={s.kind} data-status={s.status}
                className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                  <span data-testid={`source-status-${s.kind}`}><Badge tone={st.tone}>{s.status}</Badge></span>
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{st.text}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-slate-600 dark:text-slate-400">Actual</dt><dd className="font-semibold" data-testid={`source-actual-${s.kind}`}>{fmtInt(s.actualEvents)}</dd></div>
                  <div><dt className="text-slate-600 dark:text-slate-400">Simulated</dt><dd className="font-semibold" data-testid={`source-simulated-${s.kind}`}>{fmtInt(s.simulatedEvents)}</dd></div>
                  <div><dt className="text-slate-600 dark:text-slate-400">Last event</dt><dd>{fmtDateTime(s.lastEventAt)}</dd></div>
                </dl>
                {s.notes && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{s.notes}</p>}
              </div>
            );
          })}
        </div>
      </Async>
    </Card>
  );
}
