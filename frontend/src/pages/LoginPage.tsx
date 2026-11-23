import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { FormError, FormField } from '../components/auth/AuthShell';
import { useAuth } from '../components/auth/AuthProvider';
import { safeNext } from '../components/auth/RequireAuth';
import { Button, inputCls } from '../components/ui/Button';
import { Loading } from '../components/ui/State';

export default function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <Loading />;
  if (!auth.authEnabled || auth.user) return <Navigate to={next} replace />;
  if (auth.setupRequired) return <Navigate to="/setup" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await auth.login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setPassword('');
      setError((err as Error).message || 'Sign-in failed');
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Sign in" subtitle="Log in to view and manage AI spend.">
      <form onSubmit={submit} method="post" action="#" noValidate>
        <FormError id="login-error" testId="login-error" message={error} />
        <FormField id="login-username" label="Username">
          <input id="login-username" name="username" data-testid="login-username" className={`${inputCls} w-full`} type="text"
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus
            value={username} onChange={e => setUsername(e.target.value)} aria-invalid={!!error} aria-describedby="login-error" />
        </FormField>
        <FormField id="login-password" label="Password">
          <input id="login-password" name="password" data-testid="login-password" className={`${inputCls} w-full`} type="password"
            autoComplete="current-password" required
            value={password} onChange={e => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby="login-error" />
        </FormField>
        <Button type="submit" className="mt-1 w-full" disabled={busy || !username || !password} data-testid="login-submit">
          {busy ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
