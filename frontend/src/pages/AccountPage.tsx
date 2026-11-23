import PageHeader from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { useAuth } from '../components/auth/AuthProvider';
import ChangePasswordCard from '../components/auth/ChangePasswordCard';
import SessionsCard from '../components/auth/SessionsCard';
import UsersCard from '../components/auth/UsersCard';
import { fmtDateTime } from '../lib/format';

export default function AccountPage() {
  const { user, isAdmin, authEnabled } = useAuth();
  if (!authEnabled || !user) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Account" />
        <Card><p className="text-sm text-slate-600 dark:text-slate-300" data-testid="account-auth-disabled">Authentication is disabled for this server, so there are no accounts to manage.</p></Card>
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Account" subtitle="Your profile, password and sessions." />
      <Card title="Profile">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]" data-testid="account-profile">
          <dt className="text-slate-500 dark:text-slate-400">Username</dt>
          <dd className="font-medium" data-testid="account-username">{user.username}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Role</dt>
          <dd data-testid="account-role">
            <Badge tone={isAdmin ? 'purple' : 'amber'}>{user.role}</Badge>
            {!isAdmin && <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">Read-only: you can view data but not change it.</span>}
          </dd>
          <dt className="text-slate-500 dark:text-slate-400">Last sign-in</dt>
          <dd>{fmtDateTime(user.lastLoginAt)}</dd>
        </dl>
      </Card>
      <ChangePasswordCard />
      <SessionsCard />
      {isAdmin && <UsersCard currentUserId={user.id} />}
    </div>
  );
}
