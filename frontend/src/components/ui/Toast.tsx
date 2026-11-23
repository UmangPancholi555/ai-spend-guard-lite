import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; title: string; message?: string; ttl: number }
interface ToastApi {
  success(title: string, message?: string): void;
  error(title: string, message?: string): void;
  info(title: string, message?: string): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** No-op fallback so components render fine in isolation (tests, storybook). */
const NOOP: ToastApi = { success() {}, error() {}, info() {}, dismiss() {} };
export function useToast(): ToastApi { return useContext(ToastContext) ?? NOOP; }

const MAX_VISIBLE = 4;
const TTL: Record<ToastKind, number> = { success: 4000, info: 5000, error: 8000 };

const TONE: Record<ToastKind, { box: string; icon: string; label: string }> = {
  success: { box: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100', icon: '✓', label: 'Success' },
  error: { box: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100', icon: '!', label: 'Error' },
  info: { box: 'border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100', icon: 'i', label: 'Notice' },
};

function ToastCard({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(t.id), t.ttl);
    return () => clearTimeout(timer);
  }, [paused, t.id, t.ttl, onDismiss]);
  const tone = TONE[t.kind];
  return (
    <div data-testid="toast" data-kind={t.kind}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      className={`pointer-events-auto flex items-start gap-3 rounded-lg border p-3 text-sm shadow-lg ${tone.box}`}>
      <span aria-hidden="true" className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-black/10 dark:bg-white/10 text-xs font-bold">{tone.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold"><span className="sr-only">{tone.label}: </span>{t.title}</div>
        {t.message && <div className="mt-0.5 break-words opacity-90">{t.message}</div>}
      </div>
      <button type="button" aria-label="Dismiss notification" data-testid="toast-dismiss" onClick={() => onDismiss(t.id)}
        className="-m-1 rounded p-1 opacity-70 hover:opacity-100">✕</button>
    </div>
  );
}

/**
 * Toasts are announced through aria-live regions (polite for success/info, assertive for errors).
 * The regions intentionally carry no role=status/alert so they never collide with inline page alerts.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems(list => list.filter(t => t.id !== id)), []);
  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = ++seq.current;
    setItems(list => [...list, { id, kind, title, message, ttl: TTL[kind] }].slice(-MAX_VISIBLE));
  }, []);
  const api = useMemo<ToastApi>(() => ({
    success: (t, m) => push('success', t, m),
    error: (t, m) => push('error', t, m),
    info: (t, m) => push('info', t, m),
    dismiss,
  }), [push, dismiss]);
  const polite = items.filter(t => t.kind !== 'error');
  const assertive = items.filter(t => t.kind === 'error');
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-0 left-0 right-0 z-50 flex flex-col items-start gap-2 p-4 sm:right-auto sm:w-96" data-testid="toast-region">
        <div aria-live="polite" aria-relevant="additions" className="flex w-full flex-col gap-2">
          {polite.map(t => <ToastCard key={t.id} t={t} onDismiss={dismiss} />)}
        </div>
        <div aria-live="assertive" aria-relevant="additions" className="flex w-full flex-col gap-2">
          {assertive.map(t => <ToastCard key={t.id} t={t} onDismiss={dismiss} />)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
