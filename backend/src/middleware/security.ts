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

/** Fixed-window in-memory limiter keyed by remote IP. Single-process only (documented). */
export function rateLimiter(perMinute: number): RequestHandler {
  if (perMinute <= 0) return (_req, _res, next) => next();
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, 60_000);
  sweep.unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
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
