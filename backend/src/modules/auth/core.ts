/**
 * Shared auth state/helpers (one AuthCore per AppDeps): sessions, CSRF derivation, lockout/throttle bookkeeping, audit.
 * Security properties:
 *  - the cookie holds a random 32-byte token; only sha256(token) is stored.
 *  - the CSRF token is HMAC-SHA256(sessionToken, constant) so /auth/me can hand it out again without storing it; only its sha256
 *    is stored, so a DB leak yields neither the cookie token nor the CSRF token.
 *  - NOTHING in here ever passes a password, token or hash to instrumentation.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AppDeps } from '../../contracts/services';
import { sha256 } from '../../utils/ids';
import type { AuthSessionRef, AuthUser } from './types';
import type { UserRole } from '../../../../shared/auth';

export const SESSION_COOKIE = 'sg_session';
export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const TOUCH_INTERVAL_MS = 60_000;
export const LOCK_THRESHOLD = 5;
export const LOCK_MS = 15 * 60_000;
export const MAX_SESSIONS_PER_USER = 20;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try { return decodeURIComponent(v); } catch { return undefined; }
    }
  }
  return undefined;
}

export const deriveCsrf = (sessionToken: string) => createHmac('sha256', sessionToken).update('spendguard:csrf:v1').digest('base64url');

export function csrfMatches(csrfHash: string, header: unknown): boolean {
  if (typeof header !== 'string' || header.length === 0 || header.length > 256) return false;
  const a = Buffer.from(sha256(header), 'hex');
  const b = Buffer.from(csrfHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Serialises async work per key (single process). */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try { return await next; } finally { if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

/** In-memory fixed-window limiter: counts attempts that did not (yet) succeed; success refunds. */
export class LoginIpLimiter {
  private hits = new Map<string, { unsuccessful: number; total: number; resetAt: number }>();
  constructor(private limitPerMinute: number, private now: () => number = Date.now) {}
  get totalCap() { return this.limitPerMinute * 6; }
  begin(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    let h = this.hits.get(ip);
    if (!h || h.resetAt <= now) { h = { unsuccessful: 0, total: 0, resetAt: now + 60_000 }; this.hits.set(ip, h); }
    if (h.unsuccessful >= this.limitPerMinute || h.total >= this.totalCap) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((h.resetAt - now) / 1000)) };
    }
    h.unsuccessful += 1; h.total += 1;
    return { ok: true };
  }
  refund(ip: string) { const h = this.hits.get(ip); if (h && h.unsuccessful > 0) h.unsuccessful -= 1; }
}

/** Failure tracking for usernames that do not exist, so "locked" responses are indistinguishable from real accounts. */
class UnknownUserTracker {
  private m = new Map<string, { count: number; lockedUntil: number; lastAt: number }>();
  private key(u: string) { return u.slice(0, 64); }
  lockedFor(u: string, now: number): number {
    const e = this.m.get(this.key(u));
    if (!e) return 0;
    if (e.lockedUntil > now) return e.lockedUntil - now;
    if (e.lockedUntil && e.lockedUntil <= now) this.m.delete(this.key(u));
    return 0;
  }
  fail(u: string, now: number) {
    if (this.m.size > 10_000) { const first = this.m.keys().next().value; if (first !== undefined) this.m.delete(first); }
    const k = this.key(u);
    const e = this.m.get(k) ?? { count: 0, lockedUntil: 0, lastAt: now };
    if (now - e.lastAt > LOCK_MS) e.count = 0;
    e.count += 1; e.lastAt = now;
    if (e.count >= LOCK_THRESHOLD) e.lockedUntil = now + LOCK_MS;
    this.m.set(k, e);
  }
}

export interface ResolvedSession { user: AuthUser; session: AuthSessionRef; csrfToken: string }

export class AuthCore {
  readonly limiter: LoginIpLimiter;
  readonly unknownUsers = new UnknownUserTracker();
  private mutex = new KeyedMutex();
  readonly ttlMs: number;

  constructor(readonly deps: AppDeps) {
    const limit = Number(process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE);
    this.limiter = new LoginIpLimiter(Number.isInteger(limit) && limit > 0 ? limit : 10);
    const h = deps.config.auth.sessionTtlHours;
    this.ttlMs = (Number.isFinite(h) && h > 0 ? h : 12) * 3_600_000;
  }

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.mutex.run(key, fn); }

  // ------------------------------------------------------------------ cookies
  private cookieOpts() {
    return { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: this.deps.config.auth.cookieSecure };
  }
  setCookie(res: Response, token: string) { res.cookie(SESSION_COOKIE, token, { ...this.cookieOpts(), maxAge: this.ttlMs }); }
  clearCookie(res: Response) { res.clearCookie(SESSION_COOKIE, this.cookieOpts()); }

  // ------------------------------------------------------------------ sessions
  async createSession(userId: string, req: Request): Promise<{ token: string; csrfToken: string; sessionId: string; expiresAt: Date }> {
    const { prisma } = this.deps;
    const now = new Date();
    // lazy purge of dead sessions (absolute or idle expiry)
    await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lt: new Date(now.getTime() - IDLE_TIMEOUT_MS) } }] } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = deriveCsrf(token);
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const ua = req.get('user-agent');
    const row = await prisma.session.create({
      data: {
        userId, tokenHash: sha256(token), csrfHash: sha256(csrfToken), expiresAt, lastSeenAt: now,
        userAgent: ua ? ua.slice(0, 255) : null, ip: req.ip ? req.ip.slice(0, 64) : null,
      },
      select: { id: true },
    });
    const stale = await prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip: MAX_SESSIONS_PER_USER, select: { id: true } });
    if (stale.length) await prisma.session.deleteMany({ where: { id: { in: stale.map(s => s.id) } } });
    return { token, csrfToken, sessionId: row.id, expiresAt };
  }

  async resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || !TOKEN_RE.test(token)) return null;
    const { prisma } = this.deps;
    const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt.getTime() <= now || now - s.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
      await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => undefined);
      return null;
    }
    if (now - s.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await prisma.session.updateMany({ where: { id: s.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
    return {
      user: { id: s.user.id, username: s.user.username, role: (s.user.role === 'VIEWER' ? 'VIEWER' : 'ADMIN') as UserRole },
      session: { id: s.id, csrfHash: s.csrfHash },
      csrfToken: deriveCsrf(token),
    };
  }

  // ------------------------------------------------------------------ audit (metadata only)
  async audit(req: Request, res: Response | undefined, type: string, message: string, metadata: Record<string, unknown> = {}, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
    try {
      await this.deps.instr.recordActivity({
        type, level, message, source: 'ACTUAL',
        requestId: (res?.locals as { requestId?: string } | undefined)?.requestId,
        metadata: { ...metadata, ip: req.ip ?? null, userAgentLength: (req.get('user-agent') ?? '').length },
      });
    } catch { /* auditing must never break auth */ }
  }
}

const cores = new WeakMap<AppDeps, AuthCore>();
export function getAuthCore(deps: AppDeps): AuthCore {
  let c = cores.get(deps);
  if (!c) { c = new AuthCore(deps); cores.set(deps, c); }
  return c;
}
