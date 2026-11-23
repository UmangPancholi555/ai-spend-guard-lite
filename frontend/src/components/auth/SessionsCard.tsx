import { useState } from 'react';
import type { UserSessionDto } from '@shared/auth';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Async } from '../ui/State';
import { EmptyState, Table, Td } from '../ui/Table';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { fmtDateTime } from '../../lib/format';
import { FormError } from './AuthShell';

/** Short, human-readable browser/OS summary; falls back to the raw (already length-bounded) string. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser || os ? [browser, os].filter(Boolean).join(' on ') : ua.slice(0, 60);
}

export default function SessionsCard() {
  const { data, error, loading, reload } = useAsync(() => api.get<UserSessionDto[]>('/auth/sessions'), []);
  const [actionError, setActionError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  async function revoke(id: string) {
    setBusyId(id); setActionError(undefined);
    try { await api.del(`/auth/sessions/${encodeURIComponent(id)}`); reload(); }
    catch (e) { setActionError((e as Error).message); } finally { setBusyId(undefined); }
  }

  return (
    <Card title="Your active sessions" actions={<Button variant="ghost" onClick={reload} data-testid="account-sessions-refresh">Refresh</Button>}>
      <FormError id="account-sessions-error" testId="account-sessions-error" message={actionError} />
      <Async loading={loading && !data} error={error}>
        <div data-testid="account-sessions">
          <Table head={['Device', 'IP', 'Last active', 'Expires', '']} empty={data && data.length === 0 ? <EmptyState message="No active sessions." /> : undefined}>
            {(data ?? []).map(s => (
              <tr key={s.id} data-testid="account-session-row" data-current={s.current ? 'true' : 'false'}>
                <Td><span title={s.userAgent ?? undefined}>{describeAgent(s.userAgent)}</span> {s.current && <Badge tone="green">This session</Badge>}</Td>
                <Td>{s.ip ?? '-'}</Td>
                <Td>{fmtDateTime(s.lastSeenAt)}</Td>
                <Td><span title={`Signed in ${fmtDateTime(s.createdAt)}`}>{fmtDateTime(s.expiresAt)}</span></Td>
                <Td>
                  <Button variant="secondary" disabled={busyId === s.id} onClick={() => revoke(s.id)} data-testid="account-session-revoke"
                    aria-label={s.current ? 'Sign out this session' : 'Revoke this session'}>
                    {s.current ? 'Sign out' : 'Revoke'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      </Async>
    </Card>
  );
}
