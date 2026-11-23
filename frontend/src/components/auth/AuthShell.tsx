import type { ReactNode } from 'react';

/** Standalone centered layout for the public auth pages (login / first-run setup). */
export default function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-brand-600 text-base font-bold text-white" aria-hidden="true">S</div>
          <div className="leading-tight">
            <div className="text-base font-semibold">Spend Guard Lite</div>
            <div className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">Demo / Simulated</div>
          </div>
        </div>
        <main className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mb-4 mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

/** Labeled input with optional hint/error wiring (aria-describedby). */
export function FormField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

/** Live-region error text; always rendered so screen readers announce changes. */
export function FormError({ id, testId, message }: { id: string; testId: string; message?: string }) {
  return (
    <div id={id} role="alert" aria-live="assertive" data-testid={testId}
      className={message ? 'mb-3 rounded-md border border-red-300 bg-red-50 p-2.5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200' : 'sr-only'}>
      {message ?? ''}
    </div>
  );
}
