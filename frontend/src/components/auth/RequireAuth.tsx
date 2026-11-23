import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { Loading } from '../ui/State';
import { Button } from '../ui/Button';

/** Only same-origin absolute paths, never protocol-relative (`//evil`) or the auth pages themselves (open-redirect / loop guard). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  if (/^\/(login|setup)(\/|\?|$)/.test(raw)) return '/';
  return raw;
}

/** Route guard: everything below needs a session when the server has auth enabled. */
export default function RequireAuth() {
  const a = useAuth();
  const loc = useLocation();
  if (a.loading) return <Loading />;
  if (a.error) {
    return (
      <div className="mx-auto max-w-md p-8 text-center" role="alert" data-testid="auth-error">
        <p className="mb-3 text-sm text-red-700 dark:text-red-300">Cannot reach the server: {a.error}</p>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }
  if (a.authEnabled && !a.user) {
    if (a.setupRequired) return <Navigate to="/setup" replace />;
    const next = `${loc.pathname}${loc.search}`;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}
