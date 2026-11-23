import type { ReactNode } from 'react';
export function Loading() { return <div className="p-6 text-sm text-slate-500" role="status">Loading...</div>; }
export function ErrorBox({ error }: { error: Error }) {
  return <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" role="alert">{error.message}</div>;
}
export function Async({ loading, error, children }: { loading: boolean; error?: Error; children: ReactNode }) {
  if (error) return <ErrorBox error={error} />;
  if (loading) return <Loading />;
  return <>{children}</>;
}
