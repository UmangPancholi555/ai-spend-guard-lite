import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { closeAuthApp, cookieValue, newAuthApp, sessionCookie, type Session } from './helpers';
import { safeStringify } from '../../src/utils/serialize';

let ctx: TestCtx;
const ADMIN_PW = 'UNIQUE-pw-marker-Aardvark-7741';
const NEW_PW = 'UNIQUE-pw-marker-Badger-9902';
const USER_PW = 'UNIQUE-pw-marker-Civet-3318';
const WRONG_PW = 'UNIQUE-pw-marker-WRONG-5550';
const PASTED_AS_USERNAME = 'UNIQUE-pasted-secret-Dingo-6621';
const transcript: string[] = []; // every response body + header we ever saw
const secrets: string[] = [ADMIN_PW, NEW_PW, USER_PW, WRONG_PW, PASTED_AS_USERNAME];
let admin: Session;
let adminToken = '';

const track = (r: request.Response) => { transcript.push(JSON.stringify(r.body), JSON.stringify(r.headers)); return r; };

beforeAll(async () => {
  process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000';
  ctx = await newAuthApp();
  const agent = request.agent(ctx.app);
  const setup = track(await agent.post('/api/auth/setup').send({ username: 'root', password: ADMIN_PW }).expect(201));
  adminToken = cookieValue(sessionCookie(setup)!);
  admin = { agent, csrf: setup.body.data.csrfToken, userId: setup.body.data.user.id };
  secrets.push(adminToken, admin.csrf);

  const h = { 'X-CSRF-Token': admin.csrf };
  track(await request(ctx.app).post('/api/auth/login').send({ username: 'root', password: WRONG_PW }).expect(401));
  track(await request(ctx.app).post('/api/auth/login').send({ username: PASTED_AS_USERNAME, password: WRONG_PW }).expect(401));
  const created = track(await admin.agent.post('/api/auth/users').set(h).send({ username: 'worker', password: USER_PW, role: 'VIEWER' }).expect(201));
  const l = track(await request(ctx.app).post('/api/auth/login').send({ username: 'worker', password: USER_PW }).expect(200));
  secrets.push(cookieValue(sessionCookie(l)!), l.body.data.csrfToken);
  track(await admin.agent.patch(`/api/auth/users/${created.body.data.id}`).set(h).send({ role: 'ADMIN' }).expect(200));
  track(await admin.agent.post('/api/auth/password').set(h).send({ currentPassword: ADMIN_PW, newPassword: NEW_PW }).expect(200));
  track(await admin.agent.get('/api/auth/me').expect(200));
  track(await admin.agent.get('/api/auth/sessions').expect(200));
  track(await admin.agent.get('/api/auth/users').expect(200));
  track(await admin.agent.delete(`/api/auth/users/${created.body.data.id}`).set(h).expect(204));
  track(await admin.agent.post('/api/auth/logout').set(h).expect(200));
  for (const u of await ctx.prisma.user.findMany()) secrets.push(u.passwordHash, u.passwordHash.split('$')[5]!);
});
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

function allLogFiles(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}
async function dumpObservability(): Promise<string> {
  const p = ctx.prisma;
  const rows = await Promise.all([p.activityEvent.findMany(), p.executionLog.findMany(), p.trace.findMany(), p.span.findMany(), p.backgroundTask.findMany()]);
  return safeStringify(rows);
}

describe('audit trail', () => {
  it('records ACTUAL activity events for every auth action', async () => {
    const events = await ctx.prisma.activityEvent.findMany({ where: { type: { startsWith: 'auth.' } } });
    const types = new Set(events.map(e => e.type));
    for (const t of ['auth.setup', 'auth.login.success', 'auth.login.failure', 'auth.logout', 'auth.password.changed', 'auth.user.created', 'auth.user.updated', 'auth.user.deleted']) {
      expect(types, `missing ${t}`).toContain(t);
    }
    expect(events.every(e => e.source === 'ACTUAL')).toBe(true);
    const failure = events.find(e => e.type === 'auth.login.failure')!;
    const meta = JSON.parse(failure.metadata);
    expect(meta).toHaveProperty('ip');
    expect(typeof meta.userAgentLength).toBe('number');
  });

  it('mirrors them into ExecutionLog and the JSONL files', async () => {
    const logs = await ctx.prisma.executionLog.findMany({ where: { eventType: { startsWith: 'activity.auth.' } } });
    expect(logs.length).toBeGreaterThanOrEqual(8);
    expect(allLogFiles(ctx.deps.config.logDir)).toContain('auth.login.success');
  });

  it('tracks the target of admin actions without secrets', async () => {
    const ev = await ctx.prisma.activityEvent.findFirstOrThrow({ where: { type: 'auth.user.updated' } });
    const meta = JSON.parse(ev.metadata);
    expect(meta).toMatchObject({ actor: 'root', targetUsername: 'worker' });
    expect(meta.changes).toEqual(['role']);
  });

  it('does not store a typed unknown username (users paste passwords there) - only its length, never text or a hash', async () => {
    const fails = await ctx.prisma.activityEvent.findMany({ where: { type: 'auth.login.failure' } });
    const unknown = fails.map(f => JSON.parse(f.metadata)).find(m => m.usernameLength === PASTED_AS_USERNAME.length);
    expect(unknown).toBeTruthy();
    expect(unknown.username).toBeUndefined();
    expect(unknown.usernameHash).toBeUndefined();
    expect(unknown.looksLikeEmail).toBe(false);
    // neither the text nor any sha256 prefix (>= 8 hex chars) of it appears anywhere in the persisted audit trail
    const lower = PASTED_AS_USERNAME.toLowerCase();
    const digest = createHash('sha256').update(lower).digest('hex');
    const dump = (await dumpObservability()) + allLogFiles(ctx.deps.config.logDir);
    expect(dump.toLowerCase()).not.toContain(lower);
    for (const n of [8, 10, 16, 32, 64]) expect(dump).not.toContain(digest.slice(0, n));
    const raw = createHash('sha256').update(PASTED_AS_USERNAME).digest('hex');
    for (const n of [8, 10, 16]) expect(dump).not.toContain(raw.slice(0, n));
  });
});

describe('secrets never leak', () => {
  it('no password, token, CSRF token or hash appears in ActivityEvent / ExecutionLog / Trace / Span rows', async () => {
    const dump = await dumpObservability();
    for (const s of secrets) expect(dump, `leaked ${s.slice(0, 12)}...`).not.toContain(s);
    expect(dump).not.toMatch(/scrypt\$\d/);
  });

  it('no secret appears in the JSONL log files', () => {
    const logs = allLogFiles(ctx.deps.config.logDir);
    expect(logs.length).toBeGreaterThan(0);
    for (const s of secrets) expect(logs, `leaked ${s.slice(0, 12)}...`).not.toContain(s);
    expect(logs).not.toMatch(/scrypt\$\d/);
  });

  it('no response ever echoes a password or hash (tokens appear only where intended)', () => {
    const body = transcript.join('\n');
    for (const s of [ADMIN_PW, NEW_PW, USER_PW, WRONG_PW]) expect(body).not.toContain(s);
    expect(body).not.toMatch(/scrypt\$\d/);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('tokenHash');
  });

  it('the session cookie token itself is only ever sent as Set-Cookie, never in a JSON body', () => {
    const bodies = transcript.filter((_, i) => i % 2 === 0).join('\n');
    expect(bodies).not.toContain(adminToken);
  });

  it('a failing DB call inside an auth handler yields a clean 500 and the error log carries no query args/hash', async () => {
    const spy = vi.spyOn(ctx.prisma.session, 'create').mockRejectedValueOnce(
      new Error(`Invalid prisma.session.create() invocation: data: { tokenHash: "deadbeef", csrfHash: "${secrets[secrets.length - 1]}", passwordHash: "scrypt$32768$8$1$AAA$BBB" }`),
    );
    try {
      const r = await request(ctx.app).post('/api/auth/login').send({ username: 'root', password: NEW_PW });
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(r.body)).not.toMatch(/prisma|scrypt|deadbeef/);
    } finally { spy.mockRestore(); }
    const dump = await dumpObservability();
    expect(dump).not.toContain('deadbeef');
    expect(dump).not.toMatch(/scrypt\$\d/);
    expect(allLogFiles(ctx.deps.config.logDir)).not.toContain('deadbeef');
  });

  it('request logs for auth routes record only method/route/status (no body, no query)', async () => {
    const logs = await ctx.prisma.executionLog.findMany({ where: { category: 'REQUEST', operation: { contains: '/auth/' } } });
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      const attrs = JSON.parse(l.attributes ?? '{}');
      expect(Object.keys(attrs).sort()).toEqual(['method', 'path', 'route', 'statusCode']);
    }
  });
});
