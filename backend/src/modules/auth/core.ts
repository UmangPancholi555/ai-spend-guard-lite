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
import { clientKey } from '../../middleware/security';
import type { AuthSessionRef, AuthUser } from './types';
import type { UserRole } from '../../../../shared/auth';

/** Cookie names: `__Host-` prefixed (Path=/, Secure, no Domain) when COOKIE_SECURE=true, plain otherwise. Both are always readable. */
export const SESSION_COOKIE = 'sg_session';
export const HOST_SESSION_COOKIE = '__Host-sg_session';
export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const TOUCH_INTERVAL_MS = 60_000;
export const LOCK_THRESHOLD = 5;
export const LOCK_MS = 15 * 60_000;
/** failures (any IP) per username before the progressive GLOBAL delay starts */
export const GLOBAL_THRESHOLD = 10;
export const GLOBAL_BASE_DELAY_MS = 15_000;
/** idle time after which failure counters (pair, global, real and unknown users alike) decay to zero */
export const DECAY_MS = LOCK_MS;

/** Progressive delay once the global ceiling is crossed: 15s, 30s, 60s ... capped at 15 min. 0 below the ceiling. */
export function globalDelayMs(failures: number): number {
  if (failures < GLOBAL_THRESHOLD) return 0;
  return Math.min(LOCK_MS, GLOBAL_BASE_DELAY_MS * 2 ** Math.min(failures - GLOBAL_THRESHOLD, 20));
}
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

/**
 * In-memory consecutive-failure tracker with a lock window and idle decay. Used with the same parameters for real and
 * unknown usernames so "locked"/"not locked" behaves identically for both (no existence signal).
 *  - `threshold` consecutive failures lock the key for `lockMs`
 *  - an unlocked entry idle for `decayMs` resets; an expired lock resets
 *  - `progressive`: every failure beyond the threshold re-locks for globalDelayMs(count) instead of a fixed window
 */
export class AttemptTracker {
  private m = new Map<string, { count: number; lockedUntil: number; lastAt: number }>();
  constructor(
    private threshold: number, private lockMs: number, private decayMs: number = DECAY_MS,
    private progressive = false, private maxKeys = 10_000,
  ) {}
  private live(key: string, now: number) {
    const e = this.m.get(key);
    if (!e) return undefined;
    const locked = e.lockedUntil > now;
    if (!locked && (now - e.lastAt > this.decayMs || (!this.progressive && e.lockedUntil > 0))) { this.m.delete(key); return undefined; }
    return e;
  }
  /** ms of lock remaining (0 = not locked) */
  lockedFor(key: string, now: number): number {
    const e = this.live(key, now);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }
  /** records a failure; returns true when this failure (re)locked the key */
  fail(key: string, now: number): boolean {
    let e = this.live(key, now);
    if (!e) {
      if (this.m.size >= this.maxKeys) { const first = this.m.keys().next().value; if (first !== undefined) this.m.delete(first); }
      e = { count: 0, lockedUntil: 0, lastAt: now };
    }
    e.count += 1; e.lastAt = now;
    let locked = false;
    if (this.progressive) {
      const d = globalDelayMs(e.count);
      if (d > 0) { e.lockedUntil = now + d; locked = true; }
    } else if (e.count >= this.threshold) { e.lockedUntil = now + this.lockMs; locked = true; }
    this.m.delete(key); this.m.set(key, e);
    return locked;
  }
  reset(key: string) { this.m.delete(key); }
  resetWhere(pred: (key: string) => boolean) { for (const k of [...this.m.keys()]) if (pred(k)) this.m.delete(k); }
}

export interface ResolvedSession { user: AuthUser; session: AuthSessionRef; csrfToken: string }

export class AuthCore {
  readonly limiter: LoginIpLimiter;
  /** (username, ip) consecutive failures -> 15 min lock for THAT pair only; identical for real and unknown usernames */
  readonly pairLocks = new AttemptTracker(LOCK_THRESHOLD, LOCK_MS);
  /** wrong "current password" attempts on POST /auth/password, same (username, ip) keying */
  readonly passwordLocks = new AttemptTracker(LOCK_THRESHOLD, LOCK_MS);
  /** global per-username ceiling for usernames that do NOT exist (real users use User.failedAttempts/lockedUntil with the same maths) */
  readonly unknownGlobal = new AttemptTracker(GLOBAL_THRESHOLD, LOCK_MS, DECAY_MS, true);
  private mutex = new KeyedMutex();
  readonly ttlMs: number;

  constructor(readonly deps: AppDeps) {
    const limit = Number(process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE);
    this.limiter = new LoginIpLimiter(Number.isInteger(limit) && limit > 0 ? limit : 10);
    const h = deps.config.auth.sessionTtlHours;
    this.ttlMs = (Number.isFinite(h) && h > 0 ? h : 12) * 3_600_000;
  }

  /** normalized client key (IPv4 as-is, IPv4-mapped unwrapped, IPv6 collapsed to /64): used for throttles, locks, session.ip and audit */
  static ipOf(req: Request): string { return clientKey(req.ip); }
  static pairKey(username: string, ip: string | undefined) { return `${username.slice(0, 128)}\u0000${ip ?? 'unknown'}`; }
  /** forget every (username, ip) lock of a user (admin unlock / password reset) */
  clearUserLocks(username: string) {
    const prefix = `${username.slice(0, 128)}\u0000`;
    this.pairLocks.resetWhere(k => k.startsWith(prefix));
    this.passwordLocks.resetWhere(k => k.startsWith(prefix));
  }

  /**
   * Has this user logged in successfully from this IP before? (a live session, or an auth.login.success audit event while it is retained).
   * Such IPs are exempt from the GLOBAL progressive lock so a botnet cannot lock the real user out of their usual location.
   */
  async isKnownIp(userId: string, ip: string | undefined): Promise<boolean> {
    if (!ip) return false;
    const { prisma } = this.deps;
    if ((await prisma.session.count({ where: { userId, ip } })) > 0) return true;
    const ev = await prisma.activityEvent.findFirst({
      where: { type: 'auth.login.success', AND: [{ metadata: { contains: `"userId":${JSON.stringify(userId)}` } }, { metadata: { contains: `"ip":${JSON.stringify(ip)}` } }] },
      select: { id: true },
    });
    return !!ev;
  }

  /** session token from the cookie (active name first, the other accepted too) */
  readToken(req: Request): string | undefined {
    const secure = this.deps.config.auth.cookieSecure;
    return readCookie(req, secure ? HOST_SESSION_COOKIE : SESSION_COOKIE) ?? readCookie(req, secure ? SESSION_COOKIE : HOST_SESSION_COOKIE);
  }

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.mutex.run(key, fn); }

  // ------------------------------------------------------------------ cookies
  private cookieOpts() {
    return { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: this.deps.config.auth.cookieSecure };
  }
  get cookieName() { return this.deps.config.auth.cookieSecure ? HOST_SESSION_COOKIE : SESSION_COOKIE; }
  setCookie(res: Response, token: string) { res.cookie(this.cookieName, token, { ...this.cookieOpts(), maxAge: this.ttlMs }); }
  clearCookie(res: Response) {
    // clear both names: a deployment may have switched COOKIE_SECURE; a __Host- clear needs Secure+Path=/ which cookieOpts() provides when secure
    res.clearCookie(this.cookieName, this.cookieOpts());
    res.clearCookie(this.cookieName === SESSION_COOKIE ? HOST_SESSION_COOKIE : SESSION_COOKIE, { ...this.cookieOpts(), secure: true });
  }

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
        userAgent: ua ? ua.slice(0, 255) : null, ip: AuthCore.ipOf(req).slice(0, 64),
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
        metadata: { ...metadata, ip: AuthCore.ipOf(req), userAgentLength: (req.get('user-agent') ?? '').length },
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
