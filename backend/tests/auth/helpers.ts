import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';

export const ADMIN = { username: 'admin', password: 'Tr1cky-Horse-Stapler' };
export const VIEWER = { username: 'viewer', password: 'Quiet-Walrus-Lantern9' };

export type Agent = ReturnType<typeof request.agent>;

export async function newAuthApp(opts: { auth?: boolean } = {}): Promise<TestCtx> {
  return createTestApp({ auth: opts.auth ?? true });
}
export async function closeAuthApp(ctx: TestCtx) { await ctx.close(); cleanupTestDir(ctx.dir); }

export interface Session { agent: Agent; csrf: string; userId: string }

/** First-run setup: creates ADMIN and returns a logged-in agent. */
export async function setupAdmin(ctx: TestCtx, creds = ADMIN): Promise<Session> {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/auth/setup').send(creds).expect(201);
  return { agent, csrf: res.body.data.csrfToken, userId: res.body.data.user.id };
}

export async function login(ctx: TestCtx, creds: { username: string; password: string }): Promise<Session> {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/auth/login').send(creds).expect(200);
  return { agent, csrf: res.body.data.csrfToken, userId: res.body.data.user.id };
}

/** Admin creates a user, then that user logs in on a fresh agent. */
export async function createAndLogin(ctx: TestCtx, admin: Session, creds: { username: string; password: string }, role: 'ADMIN' | 'VIEWER'): Promise<Session> {
  await admin.agent.post('/api/auth/users').set('X-CSRF-Token', admin.csrf).send({ ...creds, role }).expect(201);
  return login(ctx, creds);
}

export const cookieHeader = (res: request.Response): string[] => {
  const c = res.headers['set-cookie'];
  return Array.isArray(c) ? c : c ? [c] : [];
};
export const sessionCookie = (res: request.Response): string | undefined => cookieHeader(res).find(c => /^(__Host-)?sg_session=/.test(c));
export const cookieValue = (setCookie: string) => setCookie.split(';')[0]!.split('=').slice(1).join('=');

/** Concatenates every JSONL log file of the test app (for leak assertions). */
export function readAllLogs(ctx: TestCtx): string {
  const dir = ctx.deps.config.logDir;
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
