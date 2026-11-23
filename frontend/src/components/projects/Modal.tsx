import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../ui/Button';

/** Accessible in-page dialog (centered) or right-side drawer. Closes on Escape and backdrop click. */
export function Modal({ title, onClose, children, variant = 'center', testId, footer }: {
  title: string; onClose: () => void; children: ReactNode; variant?: 'center' | 'drawer'; testId?: string; footer?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const outer = variant === 'drawer' ? 'justify-end' : 'items-center justify-center p-4';
  const panel = variant === 'drawer'
    ? 'h-full w-full max-w-xl overflow-y-auto'
    : 'max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg';
  return (
    <div className={`fixed inset-0 z-40 flex bg-black/50 ${outer}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`${panel} border border-slate-200 bg-white p-5 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-900`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" aria-label="Close dialog" className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={onClose} data-testid="modal-close">✕</button>
        </div>
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** In-page confirmation (never window.confirm). */
export function ConfirmDialog({ title, message, confirmLabel, busy, error, onConfirm, onCancel, confirmTestId = 'confirm-yes', cancelTestId = 'confirm-no' }: {
  title: string; message: ReactNode; confirmLabel: string; busy?: boolean; error?: string;
  onConfirm: () => void; onCancel: () => void; confirmTestId?: string; cancelTestId?: string;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      testId="confirm-dialog"
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid={cancelTestId}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy} data-testid={confirmTestId}>{busy ? 'Working...' : confirmLabel}</Button>
      </>}
    >
      <p className="text-sm text-slate-700 dark:text-slate-300">{message}</p>
      {error && <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="confirm-error">{error}</p>}
    </Modal>
  );
}
