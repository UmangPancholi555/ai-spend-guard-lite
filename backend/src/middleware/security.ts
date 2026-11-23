import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Baseline security headers (helmet-equivalent subset; no extra dependency). */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    next();
  };
}

/** Normalizes a client IP into a rate-limit key: IPv4 as-is, IPv6 collapsed to its /64 prefix (attackers rotate within a /64). */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!v4.includes(':')) return v4;
  // expand "::" and keep first 4 groups
  const [head, tail = ''] = v4.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v4.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Fixed-window in-memory limiter keyed by remote IP. Single-process only (documented). */
export function rateLimiter(perMinute: number): RequestHandler {
  if (perMinute <= 0) return (_req, _res, next) => next();
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, 60_000);
  sweep.unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = clientKey(req.ip);
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + 60_000 }; hits.set(key, h); }
    h.count += 1;
    res.setHeader('RateLimit-Limit', String(perMinute));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, perMinute - h.count)));
    if (h.count > perMinute) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });
    }
    next();
  };
}

/** DNS-rebinding guard: only serve requests whose Host header names this machine (or an explicitly allowed host). */
export function hostGuard(extraAllowed: string[]): RequestHandler {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...extraAllowed.map(h => h.toLowerCase())]);
  return (req, res, next) => {
    const raw = (req.headers.host ?? '').toLowerCase();
    const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
    if (!allowed.has(name)) {
      return res.status(421).json({ error: { code: 'MISDIRECTED_REQUEST', message: 'Host not allowed (set ALLOWED_HOSTS to permit it)' } });
    }
    next();
  };
}
