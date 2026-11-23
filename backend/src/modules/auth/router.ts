import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../contracts/services';
import { AppError } from '../../utils/errors';
import { parse } from '../../utils/http';
import { sha256 } from '../../utils/ids';
import { dummyVerify, hashPassword, isValidUsername, normalizeUsername, validatePassword, verifyPassword } from '../../utils/password';
import type { AuthSessionInfoDto, AuthStatusDto, ManagedUserDto, UserSessionDto } from '../../../../shared/auth';
import { LOCK_MS, LOCK_THRESHOLD, SESSION_COOKIE, getAuthCore, readCookie } from './core';
import { sessionGate } from './middleware';
import { UserInputError, createFirstAdmin, createUser, toUserDto } from './users';

/** async wrapper that never lets a raw (prisma/other) error reach the error handler: those can echo query args (hashes). */
const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(e => {
    if (e instanceof AppError) return next(e);
    next(new Error(`auth handler failed (${e instanceof Error ? e.name : typeof e})`));
  });
};

const loginSchema = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const credsSchema = z.object({ username: z.string().min(1).max(128), password: z.string().max(1024) });
const roleSchema = z.enum(['ADMIN', 'VIEWER']);
const createUserSchema = credsSchema.extend({ role: roleSchema });
const patchUserSchema = z.object({ role: roleSchema.optional(), password: z.string().max(1024).optional(), unlock: z.boolean().optional() })
  .refine(v => v.role !== undefined || v.password !== undefined || v.unlock === true, 'Nothing to update');
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().max(1024) });

const validation = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ path, message }]);

function checkNewCredentials(rawUsername: string, password: string): string {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) throw validation('username', 'Username must be 3-32 characters: lowercase letters, digits, dot, underscore, hyphen.');
  const problems = validatePassword(password, username);
  if (problems.length) throw validation('password', problems.join(' '));
  return username;
}

const csrfOf = (res: Response) => (res.locals as { csrfToken: string }).csrfToken;
const need = (req: Request) => { if (!req.user || !req.authSession) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required'); return { user: req.user, session: req.authSession }; };
const requireAdmin = (req: Request) => { const { user } = need(req); if (user.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrator role required'); return user; };

export function createAuthRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;
  const core = getAuthCore(deps);
  const enabled = deps.config.auth.enabled;
  const noStore: RequestHandler = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  // ---------------------------------------------------------------- status (public)
  router.get('/auth/status', noStore, h(async (req, res) => {
    if (!enabled) {
      const body: AuthStatusDto = { authEnabled: false, setupRequired: false, authenticated: false };
      return res.json({ data: body });
    }
    const setupRequired = (await prisma.user.count()) === 0;
    const found = await core.resolveSession(readCookie(req, SESSION_COOKIE));
    let user;
    if (found) { const u = await prisma.user.findUnique({ where: { id: found.user.id } }); if (u) user = toUserDto(u); }
    const body: AuthStatusDto = { authEnabled: true, setupRequired, authenticated: !!user, ...(user ? { user } : {}) };
    res.json({ data: body });
  }));

  if (!enabled) {
    router.use('/auth', (_req, _res, next) => next(new AppError(404, 'AUTH_DISABLED', 'Authentication is disabled')));
    return router;
  }

  router.use('/auth', noStore);

  // ---------------------------------------------------------------- first-run setup (public, only while zero users)
  router.post('/auth/setup', h(async (req, res) => {
    const body = parse(credsSchema, req.body);
    const username = checkNewCredentials(body.username, body.password);
    if ((await prisma.user.count()) > 0) throw new AppError(409, 'SETUP_COMPLETE', 'Setup has already been completed');
    const passwordHash = await hashPassword(body.password);
    const user = await createFirstAdmin(prisma, username, passwordHash);
    if (!user) throw new AppError(409, 'SETUP_COMPLETE', 'Setup has already been completed');
    const s = await core.createSession(user.id, req);
    core.setCookie(res, s.token);
    await core.audit(req, res, 'auth.setup', `Initial admin "${username}" created`, { username, userId: user.id, via: 'setup' });
    const out: AuthSessionInfoDto = { user, csrfToken: s.csrfToken };
    res.status(201).json({ data: out });
  }));

  // ---------------------------------------------------------------- login (public)
  router.post('/auth/login', h(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const username = normalizeUsername(body.username);
    const ip = req.ip ?? 'unknown';
    const gate = core.limiter.begin(ip);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      await core.audit(req, res, 'auth.login.locked', 'Login throttled for this address', { scope: 'ip' }, 'WARN');
      throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Try again later.');
    }

    type Outcome =
      | { kind: 'ok'; userId: string; sessionToken: string; csrfToken: string }
      | { kind: 'locked'; retryAfterSec: number; userId?: string }
      | { kind: 'bad'; userId?: string; nowLocked: boolean };

    const outcome: Outcome = await core.withLock(`login:${username}`, async (): Promise<Outcome> => {
      const now = Date.now();
      let user = await prisma.user.findUnique({ where: { username } });
      if (user) {
        if (user.lockedUntil && user.lockedUntil.getTime() > now) {
          return { kind: 'locked', retryAfterSec: Math.ceil((user.lockedUntil.getTime() - now) / 1000), userId: user.id };
        }
        if (user.lockedUntil || user.failedAttempts >= LOCK_THRESHOLD) {
          user = await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
        }
      } else {
        const remaining = core.unknownUsers.lockedFor(username, now);
        if (remaining > 0) return { kind: 'locked', retryAfterSec: Math.ceil(remaining / 1000) };
      }

      const ok = user ? await verifyPassword(user.passwordHash, body.password) : await dummyVerify(body.password);
      if (!user || !ok) {
        if (!user) { core.unknownUsers.fail(username, now); return { kind: 'bad', nowLocked: false }; }
        const updated = await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } });
        const nowLocked = updated.failedAttempts >= LOCK_THRESHOLD;
        if (nowLocked) await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(now + LOCK_MS) } });
        return { kind: 'bad', userId: user.id, nowLocked };
      }

      // success: reset counters, rotate session (never reuse the presented cookie)
      await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } });
      const old = readCookie(req, SESSION_COOKIE);
      if (old) await prisma.session.deleteMany({ where: { tokenHash: sha256(old) } });
      const s = await core.createSession(user.id, req);
      return { kind: 'ok', userId: user.id, sessionToken: s.token, csrfToken: s.csrfToken };
    });

    if (outcome.kind === 'locked') {
      res.setHeader('Retry-After', String(Math.max(1, outcome.retryAfterSec)));
      await core.audit(req, res, 'auth.login.locked', 'Login rejected: account temporarily locked', { userId: outcome.userId ?? null, scope: 'account' }, 'WARN');
      throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }
    if (outcome.kind === 'bad') {
      // Only log the typed username when it is a real account; otherwise a hash (users sometimes paste passwords into the username box).
      const who = outcome.userId ? { username, userId: outcome.userId } : { usernameHash: sha256(username).slice(0, 10), usernameLength: username.length };
      await core.audit(req, res, 'auth.login.failure', 'Login failed', who, 'WARN');
      if (outcome.nowLocked) await core.audit(req, res, 'auth.login.locked', `Account "${username}" locked after ${LOCK_THRESHOLD} failed attempts`, { username, userId: outcome.userId, scope: 'account', lockMinutes: LOCK_MS / 60_000 }, 'WARN');
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    }
    core.limiter.refund(ip);
    core.setCookie(res, outcome.sessionToken);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: outcome.userId } });
    await core.audit(req, res, 'auth.login.success', `User "${row.username}" logged in`, { username: row.username, userId: row.id, role: row.role });
    const out: AuthSessionInfoDto = { user: toUserDto(row), csrfToken: outcome.csrfToken };
    res.json({ data: out });
  }));

  // ---------------------------------------------------------------- everything below needs a valid session (+CSRF on writes)
  router.use('/auth', sessionGate(deps));

  router.get('/auth/me', h(async (req, res) => {
    const { user } = need(req);
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    const out: AuthSessionInfoDto = { user: toUserDto(row), csrfToken: csrfOf(res) };
    res.json({ data: out });
  }));

  router.post('/auth/logout', h(async (req, res) => {
    const { user, session } = need(req);
    await prisma.session.deleteMany({ where: { id: session.id } });
    core.clearCookie(res);
    await core.audit(req, res, 'auth.logout', `User "${user.username}" logged out`, { username: user.username, userId: user.id });
    res.json({ data: { loggedOut: true } });
  }));

  router.post('/auth/password', h(async (req, res) => {
    const { user, session } = need(req);
    const body = parse(changePasswordSchema, req.body);
    const problems = validatePassword(body.newPassword, user.username);
    if (problems.length) throw validation('newPassword', problems.join(' '));
    if (body.newPassword === body.currentPassword) throw validation('newPassword', 'New password must differ from the current password.');
    const revoked = await core.withLock(`login:${user.username}`, async () => {
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      const now = Date.now();
      if (row.lockedUntil && row.lockedUntil.getTime() > now) {
        res.setHeader('Retry-After', String(Math.ceil((row.lockedUntil.getTime() - now) / 1000)));
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
      }
      if (!(await verifyPassword(row.passwordHash, body.currentPassword))) {
        const upd = await prisma.user.update({ where: { id: row.id }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } });
        if (upd.failedAttempts >= LOCK_THRESHOLD) await prisma.user.update({ where: { id: row.id }, data: { lockedUntil: new Date(now + LOCK_MS) } });
        await core.audit(req, res, 'auth.login.failure', 'Password change rejected: wrong current password', { username: row.username, userId: row.id, via: 'password-change' }, 'WARN');
        throw new AppError(403, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
      const passwordHash = await hashPassword(body.newPassword);
      await prisma.user.update({ where: { id: row.id }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
      const del = await prisma.session.deleteMany({ where: { userId: row.id, id: { not: session.id } } });
      return del.count;
    });
    await core.audit(req, res, 'auth.password.changed', `Password changed for "${user.username}"`, { username: user.username, userId: user.id, otherSessionsRevoked: revoked });
    res.json({ data: { changed: true, otherSessionsRevoked: revoked } });
  }));

  // ---------------------------------------------------------------- own sessions
  router.get('/auth/sessions', h(async (req, res) => {
    const { user, session } = need(req);
    const rows = await prisma.session.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    const data: UserSessionDto[] = rows.map(s => ({
      id: s.id, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), expiresAt: s.expiresAt.toISOString(),
      ip: s.ip, userAgent: s.userAgent, current: s.id === session.id,
    }));
    res.json({ data });
  }));

  router.delete('/auth/sessions/:id', h(async (req, res) => {
    const { user, session } = need(req);
    const del = await prisma.session.deleteMany({ where: { id: String(req.params.id), userId: user.id } });
    if (del.count === 0) throw new AppError(404, 'NOT_FOUND', 'Session not found');
    if (req.params.id === session.id) core.clearCookie(res);
    await core.audit(req, res, 'auth.logout', `Session revoked by "${user.username}"`, { username: user.username, userId: user.id, revoked: 'session', current: req.params.id === session.id });
    res.status(204).end();
  }));

  // ---------------------------------------------------------------- user management (ADMIN)
  router.get('/auth/users', h(async (req, res) => {
    requireAdmin(req);
    const now = new Date();
    const [users, counts] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.session.groupBy({ by: ['userId'], where: { expiresAt: { gt: now } }, _count: { _all: true } }),
    ]);
    const byUser = new Map(counts.map(c => [c.userId, c._count._all]));
    const data: ManagedUserDto[] = users.map(u => ({
      ...toUserDto(u), failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
      locked: !!u.lockedUntil && u.lockedUntil > now, activeSessions: byUser.get(u.id) ?? 0,
    }));
    res.json({ data });
  }));

  router.post('/auth/users', h(async (req, res) => {
    const admin = requireAdmin(req);
    const body = parse(createUserSchema, req.body);
    checkNewCredentials(body.username, body.password);
    const created = await core.withLock('users', async () => {
      try { return await createUser(prisma, body.username, body.password, body.role); }
      catch (e) {
        if (e instanceof UserInputError) throw new AppError(400, 'VALIDATION_ERROR', e.message);
        if (e instanceof Error && e.message === 'exists') throw new AppError(409, 'CONFLICT', 'Username is already taken');
        throw e;
      }
    });
    await core.audit(req, res, 'auth.user.created', `User "${created.username}" created`, { actorId: admin.id, actor: admin.username, targetUserId: created.id, targetUsername: created.username, role: created.role });
    res.status(201).json({ data: created });
  }));

  router.patch('/auth/users/:id', h(async (req, res) => {
    const admin = requireAdmin(req);
    const { session } = need(req);
    const body = parse(patchUserSchema, req.body);
    const id = String(req.params.id);
    const { target, changes, revoked } = await core.withLock('users', async () => {
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');
      const data: { role?: string; passwordHash?: string; failedAttempts?: number; lockedUntil?: null } = {};
      const changes: string[] = [];
      if (body.role !== undefined && body.role !== target.role) {
        if (target.role === 'ADMIN' && body.role !== 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) {
          throw new AppError(409, 'LAST_ADMIN', 'Cannot demote the last administrator');
        }
        data.role = body.role; changes.push('role');
      }
      if (body.password !== undefined) {
        const problems = validatePassword(body.password, target.username);
        if (problems.length) throw validation('password', problems.join(' '));
        data.passwordHash = await hashPassword(body.password); data.failedAttempts = 0; data.lockedUntil = null; changes.push('password');
      }
      if (body.unlock) { data.failedAttempts = 0; data.lockedUntil = null; changes.push('unlock'); }
      if (Object.keys(data).length) await prisma.user.update({ where: { id }, data });
      let revoked = 0;
      if (changes.includes('password')) {
        revoked = (await prisma.session.deleteMany({ where: { userId: id, ...(id === admin.id ? { id: { not: session.id } } : {}) } })).count;
      }
      return { target, changes, revoked };
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    await core.audit(req, res, 'auth.user.updated', `User "${target.username}" updated`, { actorId: admin.id, actor: admin.username, targetUserId: id, targetUsername: target.username, changes, sessionsRevoked: revoked });
    res.json({ data: toUserDto(row) });
  }));

  router.delete('/auth/users/:id', h(async (req, res) => {
    const admin = requireAdmin(req);
    const id = String(req.params.id);
    if (id === admin.id) throw new AppError(409, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
    const target = await core.withLock('users', async () => {
      const t = await prisma.user.findUnique({ where: { id } });
      if (!t) throw new AppError(404, 'NOT_FOUND', 'User not found');
      if (t.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw new AppError(409, 'LAST_ADMIN', 'Cannot delete the last administrator');
      await prisma.user.delete({ where: { id } }); // sessions cascade
      return t;
    });
    await core.audit(req, res, 'auth.user.deleted', `User "${target.username}" deleted`, { actorId: admin.id, actor: admin.username, targetUserId: id, targetUsername: target.username });
    res.status(204).end();
  }));

  return router;
}
