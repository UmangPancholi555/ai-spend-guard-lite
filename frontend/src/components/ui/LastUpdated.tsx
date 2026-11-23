import { useEffect, useRef, useState } from 'react';

/** Timestamp of the most recent successful load: changes whenever `data` is replaced. */
export function useRefreshedAt(data: unknown): Date | undefined {
  const [at, setAt] = useState<Date>();
  const prev = useRef<unknown>(undefined);
  useEffect(() => {
    if (data !== undefined && data !== prev.current) { prev.current = data; setAt(new Date()); }
  }, [data]);
  return at;
}

/** "Updated 10:45:03" - pair with a Refresh button so users know how fresh the numbers are. */
export function LastUpdated({ at, testId = 'last-updated' }: { at?: Date; testId?: string }) {
  if (!at) return null;
  return <span className="text-xs text-slate-600 dark:text-slate-400" data-testid={testId}>Updated {at.toLocaleTimeString()}</span>;
}
