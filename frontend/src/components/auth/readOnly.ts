import { useAuth } from './AuthProvider';

/** Tooltip shown on every mutating control while a read-only (VIEWER) account is signed in. */
export const READ_ONLY_TITLE = 'Read-only account';

export interface WriteGuardProps {
  disabled: boolean;
  'aria-disabled'?: true;
  title?: string;
}

/**
 * Props for a control that changes server state. For a read-only account the control stays visible but is
 * disabled, marked aria-disabled and explains why in its title. Otherwise it is disabled only when `otherwise`
 * is true and keeps its own `title` (if any).
 */
export function writeGuardProps(readOnly: boolean, otherwise = false, title?: string): WriteGuardProps {
  if (readOnly) return { disabled: true, 'aria-disabled': true, title: READ_ONLY_TITLE };
  return title === undefined ? { disabled: otherwise } : { disabled: otherwise, title };
}

/**
 * Read-only state of the signed-in user. The server still enforces roles (403 for VIEWER writes); this only keeps
 * the UI from offering actions that are bound to fail. Handlers must also check `readOnly` so keyboard and form
 * submit paths are blocked, not just the click on a disabled button.
 */
export function useReadOnly(): { readOnly: boolean; guard: (otherwise?: boolean, title?: string) => WriteGuardProps } {
  const { canWrite } = useAuth();
  const readOnly = !canWrite;
  return { readOnly, guard: (otherwise?: boolean, title?: string) => writeGuardProps(readOnly, otherwise, title) };
}
