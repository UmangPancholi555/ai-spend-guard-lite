import { useState, type FormEvent } from 'react';
import type { CreateUserInput, ManagedUserDto, UpdateUserInput, UserRole } from '@shared/auth';
import { PASSWORD_MIN, USERNAME_RULE } from '@shared/auth';
import { Card } from '../ui/Card';
import { Button, inputCls } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Async } from '../ui/State';
import { Table, Td } from '../ui/Table';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime } from '../../lib/format';
import { FormError, FormField } from './AuthShell';
import { errMessage } from '../projects/util';
import { useToast } from '../ui/Toast';
import { useReadOnly } from './readOnly';

type RowMode = { kind: 'reset'; id: string } | { kind: 'delete'; id: string } | undefined;

export default function UsersCard({ currentUserId }: { currentUserId: string }) {
  const { data, error, loading, reload } = useAsync(() => api.get<ManagedUserDto[]>('/auth/users'), []);
  const toast = useToast();
  // AccountPage only renders this card for admins; the guard is defence in depth should that ever change
  const { readOnly, guard } = useReadOnly();
  const [message, setMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mode, setMode] = useState<RowMode>();
  const [resetPw, setResetPw] = useState('');
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('VIEWER');
  const [createError, setCreateError] = useState<string>();

  async function run(fn: () => Promise<unknown>, ok: string) {
    if (readOnly) return;
    setBusy(true); setActionError(undefined); setMessage(undefined);
    try { await fn(); setMessage(ok); toast.success(ok); setMode(undefined); setResetPw(''); reload(); }
    catch (e) { setActionError(errMessage(e)); toast.error('User update failed', errMessage(e)); } finally { setBusy(false); }
  }
  const patch = (u: ManagedUserDto, body: UpdateUserInput, ok: string) => run(() => api.patch<unknown>(`/auth/users/${encodeURIComponent(u.id)}`, body), ok);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setCreateError(undefined); setMessage(undefined);
    if (newPw.length < PASSWORD_MIN) { setCreateError(`Password must be at least ${PASSWORD_MIN} characters.`); return; }
    setBusy(true);
    try {
      const body: CreateUserInput = { username: newName.trim(), password: newPw, role: newRole };
      await api.post('/auth/users', body);
      setMessage(`User "${newName.trim().toLowerCase()}" created.`);
      toast.success(`User "${newName.trim().toLowerCase()}" created`);
      setNewName(''); setNewPw(''); setNewRole('VIEWER'); reload();
    } catch (err) { setCreateError(errMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Card title="User management" actions={<Badge tone="purple">Administrators only</Badge>}>
      <FormError id="account-users-error" testId="account-users-error" message={actionError} />
      <div role="status" aria-live="polite" data-testid="account-users-message" className={message ? 'mb-3 text-sm text-emerald-700 dark:text-emerald-300' : 'sr-only'}>{message ?? ''}</div>

      <Async loading={loading && !data} error={error} skeleton="table">
        <div data-testid="account-users">
          <Table head={['User', 'Role', 'Status', 'Last login', 'Sessions', 'Actions']}>
            {(data ?? []).map(u => {
              const self = u.id === currentUserId;
              const editing = mode?.id === u.id ? mode.kind : undefined;
              return (
                <tr key={u.id} data-testid={`account-user-row-${u.username}`} data-username={u.username}>
                  <Td><span className="font-medium">{u.username}</span> {self && <Badge tone="blue">you</Badge>}</Td>
                  <Td>
                    <select aria-label={`Role for ${u.username}`} data-testid={`account-user-role-${u.username}`} className={inputCls}
                      value={u.role} {...guard(busy)}
                      onChange={e => patch(u, { role: e.target.value as UserRole }, `Role of "${u.username}" set to ${e.target.value}.`)}>
                      <option value="ADMIN">ADMIN</option>
                      <option value="VIEWER">VIEWER</option>
                    </select>
                  </Td>
                  <Td>{u.locked ? <Badge tone="red">Locked until {fmtDateTime(u.lockedUntil)}</Badge> : <Badge tone="green">Active</Badge>}</Td>
                  <Td>{fmtDateTime(u.lastLoginAt)}</Td>
                  <Td>{u.activeSessions}</Td>
                  <Td className="!whitespace-normal">
                    {editing === 'reset' ? (
                      <form className="flex flex-wrap items-center gap-2" method="post" action="#"
                        onSubmit={e => { e.preventDefault(); void patch(u, { password: resetPw }, `Password for "${u.username}" reset; their sessions were signed out.`); }}>
                        <label className="sr-only" htmlFor={`reset-${u.id}`}>New password for {u.username}</label>
                        <input id={`reset-${u.id}`} type="password" autoComplete="new-password" placeholder="New password" required minLength={PASSWORD_MIN}
                          className={inputCls} value={resetPw} onChange={e => setResetPw(e.target.value)} data-testid="account-reset-password-input" />
                        <Button type="submit" {...guard(busy || resetPw.length < PASSWORD_MIN)} data-testid="account-reset-confirm">Set password</Button>
                        <Button type="button" variant="ghost" onClick={() => { setMode(undefined); setResetPw(''); }}>Cancel</Button>
                      </form>
                    ) : editing === 'delete' ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">Delete {u.username}?</span>
                        <Button variant="danger" {...guard(busy)} data-testid="account-delete-confirm"
                          onClick={() => run(() => api.del(`/auth/users/${encodeURIComponent(u.id)}`), `User "${u.username}" deleted.`)}>Confirm delete</Button>
                        <Button variant="ghost" onClick={() => setMode(undefined)}>Cancel</Button>
                      </span>
                    ) : (
                      <span className="flex flex-wrap gap-2">
                        <Button variant="secondary" {...guard(busy)} data-testid={`account-user-reset-${u.username}`} onClick={() => { setMode({ kind: 'reset', id: u.id }); setResetPw(''); }}>Reset password</Button>
                        {u.locked && <Button variant="secondary" {...guard(busy)} data-testid={`account-user-unlock-${u.username}`} onClick={() => patch(u, { unlock: true }, `"${u.username}" unlocked.`)}>Unlock</Button>}
                        <Button variant="danger" {...guard(busy || self, self ? 'You cannot delete your own account' : undefined)}
                          data-testid={`account-user-delete-${u.username}`} onClick={() => setMode({ kind: 'delete', id: u.id })}>Delete</Button>
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        </div>
      </Async>

      <form onSubmit={create} method="post" action="#" noValidate className="mt-5 max-w-xl border-t border-slate-200 pt-4 dark:border-slate-800" data-testid="account-create-user-form">
        <h3 className="mb-2 text-sm font-semibold">Add a user</h3>
        <FormError id="account-create-error" testId="account-create-error" message={createError} />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="account-new-username" label="Username" hint={USERNAME_RULE}>
            <input id="account-new-username" name="new-username" data-testid="account-new-username" className={`${inputCls} w-full`} type="text"
              autoComplete="off" autoCapitalize="none" spellCheck={false} required value={newName} onChange={e => setNewName(e.target.value)} aria-describedby="account-new-username-hint" />
          </FormField>
          <FormField id="account-new-user-password" label="Initial password" hint={`At least ${PASSWORD_MIN} characters.`}>
            <input id="account-new-user-password" name="new-user-password" data-testid="account-new-user-password" className={`${inputCls} w-full`} type="password"
              autoComplete="new-password" required value={newPw} onChange={e => setNewPw(e.target.value)} aria-describedby="account-new-user-password-hint" />
          </FormField>
        </div>
        <FormField id="account-new-user-role" label="Role" hint="VIEWER accounts are read-only.">
          <select id="account-new-user-role" data-testid="account-new-user-role" className={inputCls} value={newRole} onChange={e => setNewRole(e.target.value as UserRole)} aria-describedby="account-new-user-role-hint">
            <option value="VIEWER">VIEWER (read-only)</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </FormField>
        <Button type="submit" {...guard(busy || !newName || !newPw)} data-testid="account-create-user">Create user</Button>
      </form>
    </Card>
  );
}
