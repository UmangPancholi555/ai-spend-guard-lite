/**
 * Audit-trail visibility: auth events (who logged in / failed / was locked / managed users, from which IP) are for ADMIN eyes only.
 * Read endpoints (activity, logs, exports, dashboard) call these helpers to exclude them for any non-ADMIN session.
 * When auth is disabled req.user is never set, so nothing is hidden (legacy behaviour).
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';

/** true when the caller is an authenticated non-admin (VIEWER) */
export function authEventsHidden(req: Request): boolean {
  return !!req.user && req.user.role !== 'ADMIN';
}

const NOT_AUTH_ACTIVITY: Prisma.ActivityEventWhereInput = { NOT: { type: { startsWith: 'auth.' } } };
/** ExecutionLog rows: the mirrored audit events AND the request logs of the /api/auth/* endpoints (they reveal failed logins by route/status). */
const NOT_AUTH_LOG: Prisma.ExecutionLogWhereInput = {
  NOT: { OR: [{ eventType: { startsWith: 'activity.auth.' } }, { operation: { contains: '/api/auth/' } }] },
};

export function scopeActivityWhere(req: Request, where: Prisma.ActivityEventWhereInput = {}): Prisma.ActivityEventWhereInput {
  return authEventsHidden(req) ? { AND: [where, NOT_AUTH_ACTIVITY] } : where;
}
export function scopeLogWhere(req: Request, where: Prisma.ExecutionLogWhereInput = {}): Prisma.ExecutionLogWhereInput {
  return authEventsHidden(req) ? { AND: [where, NOT_AUTH_LOG] } : where;
}

/** true when a single ExecutionLog row must be hidden from the caller (GET /logs/:id) */
export function isHiddenLogRow(req: Request, row: { eventType: string; operation: string }): boolean {
  return authEventsHidden(req) && (row.eventType.startsWith('activity.auth.') || row.operation.toLowerCase().includes('/api/auth/'));
}

interface ScopableDataset { name: string; where(q: never): Record<string, unknown> }
/** Returns the dataset unchanged for admins / auth-off; for others the `activity`, `logs` and `errors` datasets get the auth-event exclusion. */
export function scopeDataset<D extends ScopableDataset>(ds: D, req: Request): D {
  if (!authEventsHidden(req)) return ds;
  const extra = ds.name === 'activity' ? NOT_AUTH_ACTIVITY : ds.name === 'logs' || ds.name === 'errors' ? NOT_AUTH_LOG : undefined;
  if (!extra) return ds;
  return { ...ds, where: (q: never) => ({ AND: [ds.where(q), extra] }) };
}
