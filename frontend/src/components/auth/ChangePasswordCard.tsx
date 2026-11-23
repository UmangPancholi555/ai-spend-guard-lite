import { useState, type FormEvent } from 'react';
import { PASSWORD_MIN } from '@shared/auth';
import type { ChangePasswordInput } from '@shared/auth';
import { Card } from '../ui/Card';
import { Button, inputCls } from '../ui/Button';
import { api } from '../../lib/api';
import { FormError, FormField } from './AuthShell';

export default function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined); setDone(undefined);
    if (next.length < PASSWORD_MIN) { setError(`New password must be at least ${PASSWORD_MIN} characters.`); return; }
    if (next !== confirm) { setError('New passwords do not match.'); return; }
    setBusy(true);
    try {
      const input: ChangePasswordInput = { currentPassword: current, newPassword: next };
      const r = await api.post<{ otherSessionsRevoked: number }>('/auth/password', input);
      setDone(`Password changed. ${r.otherSessionsRevoked} other session${r.otherSessionsRevoked === 1 ? ' was' : 's were'} signed out.`);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card title="Change password">
      <form onSubmit={submit} method="post" action="#" noValidate className="max-w-md" data-testid="account-password-form">
        <FormError id="account-password-error" testId="account-password-error" message={error} />
        <div role="status" aria-live="polite" data-testid="account-password-success"
          className={done ? 'mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-2.5 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'sr-only'}>
          {done ?? ''}
        </div>
        <FormField id="account-current-password" label="Current password">
          <input id="account-current-password" name="current-password" data-testid="account-current-password" type="password"
            className={`${inputCls} w-full`} autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
        </FormField>
        <FormField id="account-new-password" label="New password" hint={`At least ${PASSWORD_MIN} characters; must not contain your username. Other sessions are signed out.`}>
          <input id="account-new-password" name="new-password" data-testid="account-new-password" type="password"
            className={`${inputCls} w-full`} autoComplete="new-password" required minLength={PASSWORD_MIN} value={next} onChange={e => setNext(e.target.value)}
            aria-describedby="account-new-password-hint" />
        </FormField>
        <FormField id="account-confirm-password" label="Confirm new password">
          <input id="account-confirm-password" name="confirm-password" data-testid="account-confirm-password" type="password"
            className={`${inputCls} w-full`} autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={busy || !current || !next || !confirm} data-testid="account-password-submit">
          {busy ? 'Saving...' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}
