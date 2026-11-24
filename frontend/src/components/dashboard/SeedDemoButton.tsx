import { useState } from 'react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { errMessage } from '../projects/util';
import { useToast } from '../ui/Toast';
import { useReadOnly } from '../auth/readOnly';

/** Generates backdated DEMO / SIMULATED usage through the real backend, then calls onDone. */
export default function SeedDemoButton({ onDone, label = 'Generate demo data' }: { onDone: () => void; label?: string }) {
  const toast = useToast();
  const { readOnly, guard } = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run() {
    if (readOnly) return;
    setBusy(true); setError(undefined);
    try {
      await api.post('/simulations/seed', { requests: 200, spreadDays: 14, includeFailures: true });
      toast.success('Demo data generated', '200 simulated requests over 14 days.');
      onDone();
    } catch (e) { setError(errMessage(e)); toast.error('Could not generate demo data', errMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <div>
      <Button onClick={run} {...guard(busy)} data-testid="dashboard-seed">{busy ? 'Generating...' : label}</Button>
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400" data-testid="dashboard-seed-error">{error}</p>}
    </div>
  );
}
