/**
 * Wave 2, cross-module: auth ON (cookie session + CSRF + roles) combined with the real runtime (memory -> context -> tools -> bus)
 * and the export/log pipeline. Everything goes through the real wired app with a cookie jar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTestDir, createTestApp } from '../helpers/testApp';
import { Ctx, expectedPico, picoToUsd } from './helpers';

process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; // many deliberate failed logins from one address below
const ADMIN = { username: 'qa-admin', password: 'Walnut-Prairie-Cobalt-Fern-61' };
const VIEWER = { username: 'qa-viewer', password: 'Lagoon-Meteor-Quilt-Basil-38' };
const DATASETS = ['activity', 'traces', 'logs', 'errors', 'memory', 'bus', 'tools', 'context', 'alerts', 'tasks'];

type Agent = ReturnType<typeof request.agent>;
interface Sess { agent: Agent; csrf: string; token: string }

let ctx: Ctx;
const sessionToken = (res: request.Response) => {
  const c = ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []).find(x => x.startsWith('sg_session='));
  return c ? c.split(';')[0]!.slice('sg_session='.length) : '';
};
async function login(c: Ctx, creds: { username: string; password: string }): Promise<Sess> {
  const agent = request.agent(c.app);
  const res = await agent.post('/api/auth/login').send(creds).expect(200);
  return { agent, csrf: res.body.data.csrfToken, token: sessionToken(res) };
}
const w = (s: Sess, method: 'post' | 'put' | 'patch' | 'delete', url: string) => (s.agent as any)[method](url).set('X-CSRF-Token', s.csrf);

let admin: Sess;
let viewer: Sess;

beforeAll(async () => {
  ctx = await createTestApp({ auth: true });
  const setup = await request(ctx.app).post('/api/auth/setup').send(ADMIN).expect(201);
  admin = { agent: request.agent(ctx.app), csrf: '', token: '' };
  admin = await login(ctx, ADMIN);
  void setup;
  await w(admin, 'post', '/api/auth/users').send({ ...VIEWER, role: 'VIEWER' }).expect(201);
  viewer = await login(ctx, VIEWER);
}, 60_000);
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

describe('auth ON: the full product flow with a cookie session', () => {
  it('login -> create project -> request -> dashboard -> usage -> exports (usage CSV, traces JSONL) all work and agree', async () => {
    const proj = (await w(admin, 'post', '/api/projects').send({ name: 'auth-flow', isTest: true }).expect(201)).body.data;
    const r = (await w(admin, 'post', '/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: 'auth flow prompt', injectMemory: false }).expect(201)).body.data;
    const exp = expectedPico('openai/gpt-4o', r.usage);
    expect(r.cost.totalCostUsd).toBe(picoToUsd(exp.total));
    const dash = (await admin.agent.get('/api/dashboard').expect(200)).body.data;
    expect(dash.totals.requests).toBeGreaterThanOrEqual(1);
    const usage = (await admin.agent.get(`/api/usage?projectId=${proj.id}`).expect(200)).body.data;
    expect(usage).toHaveLength(1);
    expect(usage[0].costUsd).toBe(r.cost.totalCostUsd);
    const csv = await admin.agent.get(`/api/usage/export.csv?projectId=${proj.id}`).expect(200);
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.text).toContain(r.requestId);
    const jsonl = await admin.agent.get(`/api/export/traces?format=jsonl&projectId=${proj.id}`).expect(200);
    expect(jsonl.text).toContain(r.traceId);
    expect(r.memory).toMatchObject({ injected: false });
    // the login and the project creation are in the audit trail (ACTUAL, metadata only)
    const types = new Set((await admin.agent.get('/api/activity?pageSize=200').expect(200)).body.data.map((a: any) => a.type));
    for (const t of ['auth.setup', 'auth.login.success', 'project.created']) expect(types.has(t), t).toBe(true);
  });

  it('every API route (reads, writes, exports, unknown paths) is 401 without a session; health/status/login/setup stay public', async () => {
    const anon = request(ctx.app);
    for (const u of ['/api/projects', '/api/usage', '/api/dashboard', '/api/budgets', '/api/activity', '/api/traces', '/api/logs', '/api/settings', '/api/tools',
      '/api/observability/sources', '/api/cost/pricing', '/api/usage/export.csv', '/api/export/logs?format=jsonl', '/api/nothing-here', '/api/auth/me']) {
      const res = await anon.get(u);
      expect(res.status, u).toBe(401);
      expect(res.body.error.code, u).toBe('UNAUTHENTICATED');
    }
    expect((await anon.post('/api/providers/requests').send({})).status).toBe(401);
    expect((await anon.get('/api/health')).status).toBe(200);
    expect((await anon.get('/api/auth/status')).body.data).toMatchObject({ authEnabled: true, setupRequired: false, authenticated: false });
    expect((await anon.post('/api/auth/setup').send({ username: 'intruder', password: 'Zebra-Quartz-Lantern-Moss-93' })).status).toBe(409);
  });

  it('writes need the CSRF token; a session cookie alone, a wrong token and another session\'s token are all 403', async () => {
    const body = { name: 'csrf-proj', isTest: true };
    expect((await admin.agent.post('/api/projects').send(body)).status).toBe(403);
    expect((await admin.agent.post('/api/projects').set('X-CSRF-Token', 'A'.repeat(43)).send(body)).status).toBe(403);
    expect((await admin.agent.post('/api/projects').set('X-CSRF-Token', viewer.csrf).send(body)).status).toBe(403);
    const created = await w(admin, 'post', '/api/projects').send(body);
    expect(created.status).toBe(201);
    // cross-site form posts are refused before auth matters
    const evil = await admin.agent.post('/api/projects').set('Origin', 'https://evil.example').set('X-CSRF-Token', admin.csrf).send({ name: 'evil', isTest: true });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('VIEWER: can read everything (incl. exports) but every write is 403; role is enforced per request', async () => {
    expect((await viewer.agent.get('/api/projects')).status).toBe(200);
    expect((await viewer.agent.get('/api/usage/export.csv')).status).toBe(200);
    expect((await viewer.agent.get('/api/export/logs?format=jsonl')).status).toBe(200);
    expect((await viewer.agent.get('/api/auth/users')).status).toBe(403);
    const attempts: Array<[string, string, object]> = [
      ['post', '/api/projects', { name: 'v-proj' }], ['post', '/api/providers/requests', { projectId: 'x', provider: 'openai', model: 'gpt-4o', prompt: 'p' }],
      ['put', '/api/settings', { retentionDays: 5 }], ['post', '/api/budgets', { projectId: null, name: 'b', period: 'DAILY', limitUsd: '1.00' }],
      ['post', '/api/tools/pricing.lookup/invoke', { input: { provider: 'openai', model: 'gpt-4o' } }], ['post', '/api/auth/users', { ...ADMIN, username: 'zzz-admin', role: 'ADMIN' }],
    ];
    for (const [m, u, b] of attempts) {
      const r = await w(viewer, m as any, u).send(b);
      expect(r.status, `${m} ${u}`).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
    expect((await w(viewer, 'post', '/api/cost/calculate').send({ provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1 })).status).toBe(200);
    // promoting the viewer takes effect on the very next request of the same session
    const id = (await admin.agent.get('/api/auth/users').expect(200)).body.data.find((u: any) => u.username === VIEWER.username).id;
    await w(admin, 'patch', `/api/auth/users/${id}`).send({ role: 'ADMIN' }).expect(200);
    expect((await w(viewer, 'post', '/api/projects').send({ name: 'promoted-proj', isTest: true })).status).toBe(201);
    await w(admin, 'patch', `/api/auth/users/${id}`).send({ role: 'VIEWER' }).expect(200);
    expect((await w(viewer, 'post', '/api/projects').send({ name: 'demoted-proj', isTest: true })).status).toBe(403);
  });

  it('lockout (per username+IP pair): 5 wrong passwords lock THAT address (429, even with the right password); other addresses are not locked out; admin unlock clears it', async () => {
    ctx.app.set('trust proxy', true); // distinct client addresses via X-Forwarded-For
    const creds = { username: 'qa-lock', password: 'Origami-Violet-Trellis-Moon-19' };
    const uid = (await w(admin, 'post', '/api/auth/users').send({ ...creds, role: 'VIEWER' }).expect(201)).body.data.id;
    const attempt = (password: string, ip: string) => request(ctx.app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ username: creds.username, password });
    for (let i = 0; i < 5; i += 1) expect((await attempt(`nope-${i}`, '203.0.113.10')).status).toBe(401);
    const locked = await attempt(creds.password, '203.0.113.10');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.headers['set-cookie']).toBeUndefined();
    // the real user is not locked out from elsewhere (an attacker cannot DoS the account)
    expect((await attempt(creds.password, '203.0.113.11')).status).toBe(200);
    // admin unlock clears the pair lock
    await w(admin, 'patch', `/api/auth/users/${uid}`).send({ unlock: true }).expect(200);
    expect((await attempt(creds.password, '203.0.113.10')).status).toBe(200);
  });

  it('lockout (global per username): 10 failures from different addresses start a persisted progressive lock visible to admins; unknown addresses are refused, a previously-used address still works', async () => {
    ctx.app.set('trust proxy', true);
    const creds = { username: 'qa-global', password: 'Cinder-Atlas-Willow-Pond-72' };
    const uid = (await w(admin, 'post', '/api/auth/users').send({ ...creds, role: 'VIEWER' }).expect(201)).body.data.id;
    const attempt = (password: string, ip: string) => request(ctx.app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ username: creds.username, password });
    expect((await attempt(creds.password, '198.51.100.50')).status).toBe(200); // makes .50 a known address
    for (let i = 0; i < 10; i += 1) expect((await attempt(`bad-${i}`, `203.0.113.${100 + i}`)).status).toBe(401);
    const listed = (await admin.agent.get('/api/auth/users').expect(200)).body.data.find((u: any) => u.username === creds.username);
    expect(listed).toMatchObject({ locked: true, failedAttempts: 10 });
    expect(Date.parse(listed.lockedUntil)).toBeGreaterThan(Date.now());
    const refused = await attempt(creds.password, '203.0.113.200'); // never seen before
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await attempt(creds.password, '198.51.100.50')).status).toBe(200); // known good address is exempt
    await w(admin, 'patch', `/api/auth/users/${uid}`).send({ unlock: true }).expect(200);
    expect((await attempt(creds.password, '203.0.113.201')).status).toBe(200);
  });

  it('password change revokes the other sessions of that user only; logout kills the session server-side', async () => {
    const creds = { username: 'qa-pw', password: 'Quartz-Mango-Sundial-Reef-84' };
    await w(admin, 'post', '/api/auth/users').send({ ...creds, role: 'ADMIN' }).expect(201);
    const a = await login(ctx, creds); const b = await login(ctx, creds);
    const next = 'Pistachio-Canyon-Beacon-Tide-47';
    await w(a, 'post', '/api/auth/password').send({ currentPassword: creds.password, newPassword: next }).expect(200);
    expect((await a.agent.get('/api/auth/me')).status).toBe(200);
    expect((await b.agent.get('/api/auth/me')).status).toBe(401);
    expect((await admin.agent.get('/api/auth/me')).status).toBe(200); // other users untouched
    await w(a, 'post', '/api/auth/logout').send({}).expect(200);
    // replaying the captured cookie after logout is useless
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', `sg_session=${a.token}`)).status).toBe(401);
  });

  it('security headers on API and SPA-less responses; auth responses are no-store; the session cookie is HttpOnly + SameSite=Strict', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send(ADMIN);
    expect(res.headers['cache-control']).toContain('no-store');
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('sg_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    for (const u of ['/api/health', '/api/projects', '/api/auth/status']) {
      const r = await request(ctx.app).get(u);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });
});

describe('auth ON + runtime: secrets and memory content are never persisted outside their own tables', () => {
  it('passwords, session tokens and CSRF tokens appear in no table dump, no JSONL log and no export', async () => {
    const proj = (await w(admin, 'post', '/api/projects').send({ name: 'secrets-proj', isTest: true }).expect(201)).body.data;
    await w(admin, 'post', '/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: 'x' }).expect(201);
    await request(ctx.app).post('/api/auth/login').send({ username: ADMIN.username, password: 'wrong-password-marker-123' }).expect(401);
    const secrets = [ADMIN.password, VIEWER.password, 'wrong-password-marker-123', admin.token, admin.csrf, viewer.token, viewer.csrf];
    const tables = await dumpTables(ctx, []);
    const logs = readLogs(ctx);
    let exports = '';
    for (const ds of DATASETS) for (const fmt of ['jsonl', 'csv']) exports += (await admin.agent.get(`/api/export/${ds}?format=${fmt}`).expect(200)).text;
    for (const s of secrets) {
      expect(tables, `db leaks ${s.slice(0, 8)}...`).not.toContain(s);
      expect(logs, `jsonl leaks ${s.slice(0, 8)}...`).not.toContain(s);
      expect(exports, `export leaks ${s.slice(0, 8)}...`).not.toContain(s);
    }
    // only hashes are stored: the users table holds an argon/scrypt-style hash, sessions only token hashes
    const users = await ctx.prisma.user.findMany();
    expect(users.every(u => u.passwordHash && u.passwordHash !== ADMIN.password && u.passwordHash.length > 40)).toBe(true);
    const sessions = await ctx.prisma.session.findMany();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every(s => s.tokenHash.length === 64 && s.csrfHash.length === 64 && s.tokenHash !== admin.token)).toBe(true);
  });

  it('memory -> injection raises billed input tokens; ACTUAL memory/context/tool events; the memory CONTENT exists only in ProjectMemoryItem', async () => {
    const MARK = `INTMEM_${Math.random().toString(36).slice(2)}`;
    const TITLE = `INTTITLE_${Math.random().toString(36).slice(2)}`;
    const PROMPT = `INTPROMPT_${Math.random().toString(36).slice(2)}`;
    const proj = (await w(admin, 'post', '/api/projects').send({ name: 'mem-proj', isTest: true }).expect(201)).body.data;
    const item = (await w(admin, 'post', `/api/projects/${proj.id}/memory`).send({ title: TITLE, category: 'facts', content: `${MARK} `.repeat(200) }).expect(201)).body.data;
    const send = async (extra: object) => (await w(admin, 'post', '/api/providers/requests').send({ projectId: proj.id, provider: 'openai', model: 'gpt-4o', prompt: PROMPT, ...extra }).expect(201)).body.data;
    const without = await send({ injectMemory: false });
    const withMem = await send({});
    const sum = (r: any) => r.usage.inputTokens + r.usage.cachedTokens;
    expect(withMem.memory).toMatchObject({ injected: true, items: 1, truncated: false });
    expect(sum(withMem) - sum(without)).toBeGreaterThanOrEqual(item.estimatedTokens - 2);
    // the billed cost is exactly what the stored tokens imply (BigInt oracle) - injection does not bypass cost accounting
    expect(withMem.cost.totalCostUsd).toBe(picoToUsd(expectedPico('openai/gpt-4o', withMem.usage).total));

    const trace = (await admin.agent.get(`/api/traces/${withMem.traceId}`).expect(200)).body.data;
    const memSteps = trace.timeline.filter((e: any) => e.step.startsWith('memory.injection'));
    expect(memSteps.map((e: any) => e.step)).toEqual(['memory.injection.started', 'memory.injection.completed']);
    // nothing simulated except the provider response (the mock provider is a simulation), nothing fabricated
    expect(trace.timeline.filter((e: any) => e.source === 'SIMULATED').map((e: any) => e.step)).toEqual(['response.generated']);
    expect(trace.timeline.filter((e: any) => e.step.startsWith('tool.call')).length).toBeGreaterThanOrEqual(4); // pricing.lookup + budget.status

    // content/title/prompt: only in the memory table (content/title) - nowhere else
    const dump = await dumpTables(ctx, ['ProjectMemoryItem']);
    for (const m of [MARK, TITLE, PROMPT]) expect(dump, `db leaks ${m}`).not.toContain(m);
    const logs = readLogs(ctx);
    for (const m of [MARK, TITLE, PROMPT]) expect(logs, `jsonl leaks ${m}`).not.toContain(m);
    for (const ds of DATASETS) for (const fmt of ['jsonl', 'csv']) {
      const t = (await admin.agent.get(`/api/export/${ds}?format=${fmt}`).expect(200)).text;
      for (const m of [MARK, TITLE, PROMPT]) expect(t, `export ${ds}.${fmt} leaks ${m}`).not.toContain(m);
    }
    expect(JSON.stringify(trace)).not.toContain(MARK);
    // ...but the memory API (an authenticated admin reading its own data) does return it
    expect(JSON.stringify((await admin.agent.get(`/api/projects/${proj.id}/memory`).expect(200)).body.data)).toContain(MARK);
    // anonymous callers cannot read memory
    expect((await request(ctx.app).get(`/api/projects/${proj.id}/memory`)).status).toBe(401);
    // deleting the project cascades its memory items
    await w(admin, 'delete', `/api/projects/${proj.id}`).expect(204);
    expect(await ctx.prisma.projectMemoryItem.count({ where: { projectId: proj.id } })).toBe(0);
  });

  it('tool invoke through the authenticated API creates an ACTUAL trace; sources registry is CONNECTED and the simulator is SIMULATED_ONLY', async () => {
    const res = await w(admin, 'post', '/api/tools/pricing.lookup/invoke').send({ input: { provider: 'anthropic', model: 'claude-haiku' } }).expect(200);
    expect(res.body.data.output).toMatchObject({ inputPerMTok: '0.800000', outputPerMTok: '4.000000', cachedPerMTok: '0.080000', unknownModel: false });
    const t = (await admin.agent.get(`/api/traces/${res.body.data.traceId}`).expect(200)).body.data;
    expect(t.trace).toMatchObject({ name: 'tool.invoke', source: 'ACTUAL', status: 'OK' });
    expect(t.timeline.map((e: any) => e.step).filter((s: string) => s.startsWith('tool.call'))).toEqual(['tool.call.initiated', 'tool.call.completed']);
    await w(admin, 'post', '/api/tools/usage.summary/invoke').send({ input: { projectId: '', days: 0 } }).expect(400);
    await w(admin, 'post', '/api/tools/nope/invoke').send({ input: {} }).expect(404);
    const src = (await admin.agent.get('/api/observability/sources').expect(200)).body.data as any[];
    for (const k of ['request', 'memory', 'bus', 'tool', 'context', 'error']) expect(src.find(s => s.kind === k).status, k).toBe('CONNECTED');
    expect(src.find(s => s.kind === 'simulator')).toMatchObject({ status: 'SIMULATED_ONLY', actualEvents: 0 });
  });
});

describe('auth ON: persistence across a restart', () => {
  it('sessions (incl. CSRF), roles and failure counters live in SQLite and survive restart; revoked sessions stay revoked', async () => {
    const creds = { username: 'qa-restart', password: 'Meadow-Orbit-Pewter-Kite-26' };
    await w(admin, 'post', '/api/auth/users').send({ ...creds, role: 'VIEWER' }).expect(201);
    const live = await login(ctx, creds); const dead = await login(ctx, creds);
    const sid = (await dead.agent.get('/api/auth/sessions').expect(200)).body.data.find((s: any) => s.current).id;
    await w(dead, 'delete', `/api/auth/sessions/${sid}`).expect(204);
    for (let i = 0; i < 4; i += 1) await request(ctx.app).post('/api/auth/login').send({ username: creds.username, password: `bad-${i}` }).expect(401);
    const counter = async (c: Ctx, s: Sess) => (await request(c.app).get('/api/auth/users').set('Cookie', `sg_session=${s.token}`)).body.data.find((u: any) => u.username === creds.username).failedAttempts;
    expect(await counter(ctx, admin)).toBe(4);

    const before = (await admin.agent.get('/api/auth/users').expect(200)).body.data.map((u: any) => `${u.username}:${u.role}:${u.failedAttempts}`).sort();
    ctx = await ctx.restart();

    // old cookies work against the new app instance (same DB) with the old CSRF token
    const cookie = (s: Sess) => `sg_session=${s.token}`;
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie(live));
    expect(me.status).toBe(200);
    expect(me.body.data.csrfToken).toBe(live.csrf);
    expect((await request(ctx.app).post('/api/projects').set('Cookie', cookie(admin)).set('X-CSRF-Token', admin.csrf).send({ name: 'after-restart', isTest: true })).status).toBe(201);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie(dead))).status).toBe(401);
    const after = (await request(ctx.app).get('/api/auth/users').set('Cookie', cookie(admin))).body.data.map((u: any) => `${u.username}:${u.role}:${u.failedAttempts}`).sort();
    expect(after).toEqual(before);
    // the persisted failed-attempt counter (global per-username ceiling) survived; (username, IP) pair locks live in memory by design
    expect(await counter(ctx, admin)).toBe(4);
    expect((await request(ctx.app).post('/api/auth/login').send(creds)).status).toBe(200); // right password still logs in
    // the restarted app still enforces CSRF
    expect((await request(ctx.app).post('/api/projects').set('Cookie', cookie(admin)).send({ name: 'no-csrf', isTest: true })).status).toBe(403);
  });
});

// ---------------------------------------------------------------- helpers
async function dumpTables(c: Ctx, exclude: string[]): Promise<string> {
  const tables = await c.prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  let out = '';
  for (const t of tables) {
    if (exclude.includes(t.name)) continue;
    const rows = await c.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "${t.name}"`);
    out += `\n## ${t.name}\n` + JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return out;
}
function readLogs(c: Ctx): string {
  const dir = c.deps.config.logDir;
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
}
