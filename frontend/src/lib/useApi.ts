import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void }

/** Errors produced by useAsync remember how to re-run their loader so <ErrorBox> can offer "Retry" anywhere it renders them. */
const retryRegistry = new WeakMap<object, () => void>();
export const retryFor = (e: unknown): (() => void) | undefined => (e && typeof e === 'object' ? retryRegistry.get(e) : undefined);

/** Run an async loader whenever `deps` change. Ignores stale responses. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(undefined);
    loader().then(
      d => { if (my === seq.current) { setData(d); setError(undefined); setLoading(false); } },
      e => {
        if (my === seq.current) {
          if (e && typeof e === 'object') retryRegistry.set(e, reload);
          setError(e as Error); setLoading(false);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload };
}
