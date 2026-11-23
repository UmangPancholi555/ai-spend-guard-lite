import { useState } from 'react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { errMessage } from '../projects/util';

/** Generates backdated DEMO / SIMULATED usage through the real backend, then calls onDone. */
export default function SeedDemoButton({ onDone, label = 'Generate demo data' }: { onDone: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run() {
    setBusy(true); setError(undefined);
    try {
      await api.post('/simulations/seed', { requests: 200, spreadDays: 14, includeFailures: true });
      onDone();
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <div>
      <Button onClick={run} disabled={busy} data-testid="dashboard-seed">{busy ? 'Generating...' : label}</Button>
      {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400" data-testid="dashboard-seed-error">{error}</p>}
    </div>
  );
}
