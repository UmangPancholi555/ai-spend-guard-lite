import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { describeError } from '../../lib/errors';
import { retryFor } from '../../lib/useApi';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

export type SkeletonVariant = 'block' | 'table' | 'cards' | 'lines';

/** Skeleton placeholder. Keeps role=status and a screen-reader "Loading..." label. */
export function Loading({ variant = 'block', label = 'Loading...' }: { variant?: SkeletonVariant; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="p-2" data-testid="loading" data-variant={variant}>
      <span className="sr-only">{label}</span>
      {variant === 'cards' && (
        <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      )}
      {variant === 'table' && (
        <div aria-hidden="true" className="space-y-2">
          <Skeleton className="h-8 w-full" />
          {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-6 w-full opacity-70" />)}
        </div>
      )}
      {variant === 'lines' && (
        <div aria-hidden="true" className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>
      )}
      {variant === 'block' && <Skeleton className="h-32 w-full rounded-lg" />}
    </div>
  );
}

/** Friendly error box: code-specific wording, request id, and Retry when a retry is possible. */
export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const d = describeError(error);
  const retry = onRetry ?? retryFor(error);
  const [wait, setWait] = useState(d.retryAfterSec ?? 0);
  useEffect(() => {
    setWait(d.retryAfterSec ?? 0);
    if (!d.retryAfterSec) return;
    const t = setInterval(() => setWait(w => (w <= 1 ? (clearInterval(t), 0) : w - 1)), 1000);
    return () => clearInterval(t);
  }, [d.retryAfterSec, error]);
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" role="alert" data-testid="error-box">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {d.title && <strong className="mr-1">{d.title}.</strong>}
          <span className="break-words">{d.message}</span>
          {d.requestId && <div className="mt-1 font-mono text-xs opacity-80">Request id: {d.requestId}</div>}
        </div>
        {retry && d.retryable !== false && (
          <button type="button" onClick={retry} disabled={wait > 0} data-testid="error-retry"
            className="shrink-0 rounded-md border border-red-400 bg-white px-3 py-1 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-60 dark:border-red-800 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900">
            {wait > 0 ? `Retry in ${wait}s` : 'Retry'}
          </button>
        )}
      </div>
    </div>
  );
}

export function Async({ loading, error, children, skeleton = 'block', reload }: {
  loading: boolean; error?: Error; children: ReactNode; skeleton?: SkeletonVariant; reload?: () => void;
}) {
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading) return <Loading variant={skeleton} />;
  return <>{children}</>;
}
