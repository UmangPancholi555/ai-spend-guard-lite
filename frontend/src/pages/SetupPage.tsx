import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { PASSWORD_MIN, USERNAME_RULE } from '@shared/auth';
import AuthShell, { FormError, FormField } from '../components/auth/AuthShell';
import { useAuth } from '../components/auth/AuthProvider';
import { Button, inputCls } from '../components/ui/Button';
import { Loading } from '../components/ui/State';
import { errMessage } from '../components/projects/util';

export default function SetupPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <Loading />;
  if (!auth.authEnabled) return <Navigate to="/" replace />;
  if (auth.user) return <Navigate to="/" replace />;
  if (!auth.setupRequired) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(undefined);
    if (password.length < PASSWORD_MIN) { setError(`Password must be at least ${PASSWORD_MIN} characters.`); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await auth.setup(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMessage(err) || 'Setup failed');
      // the first admin may have been created in the meantime (409): re-read status so the guard sends us to /login
      void auth.refresh();
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Create the first administrator" subtitle="No users exist yet. This account will be the administrator.">
      <form onSubmit={submit} method="post" action="#" noValidate>
        <FormError id="setup-error" testId="setup-error" message={error} />
        <FormField id="setup-username" label="Username" hint={USERNAME_RULE}>
          <input id="setup-username" name="username" data-testid="setup-username" className={`${inputCls} w-full`} type="text"
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus
            value={username} onChange={e => setUsername(e.target.value)} aria-describedby="setup-username-hint setup-error" />
        </FormField>
        <FormField id="setup-password" label="Password" hint={`At least ${PASSWORD_MIN} characters; must not contain the username or be a common password.`}>
          <input id="setup-password" name="new-password" data-testid="setup-password" className={`${inputCls} w-full`} type="password"
            autoComplete="new-password" required minLength={PASSWORD_MIN}
            value={password} onChange={e => setPassword(e.target.value)} aria-describedby="setup-password-hint setup-error" />
        </FormField>
        <FormField id="setup-confirm" label="Confirm password">
          <input id="setup-confirm" name="confirm-password" data-testid="setup-confirm" className={`${inputCls} w-full`} type="password"
            autoComplete="new-password" required
            value={confirm} onChange={e => setConfirm(e.target.value)} aria-describedby="setup-error" />
        </FormField>
        <Button type="submit" className="mt-1 w-full" disabled={busy || !username || !password || !confirm} data-testid="setup-submit">
          {busy ? 'Creating...' : 'Create administrator'}
        </Button>
      </form>
    </AuthShell>
  );
}
