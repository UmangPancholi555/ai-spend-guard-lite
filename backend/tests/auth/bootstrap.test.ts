import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { closeAuthApp, newAuthApp } from './helpers';
import { bootstrapAdmin } from '../../src/modules/auth';
import { REPO_ROOT } from '../../src/config';
import { verifyPassword } from '../../src/utils/password';

let ctx: TestCtx;
beforeAll(async () => { process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE = '1000'; ctx = await newAuthApp(); });
afterAll(async () => { delete process.env.AUTH_LOGIN_IP_LIMIT_PER_MINUTE; await closeAuthApp(ctx); });

describe('bootstrapAdmin (ADMIN_USERNAME / ADMIN_PASSWORD)', () => {
  it('does nothing when the variables are missing or empty', async () => {
    expect(await bootstrapAdmin(ctx.prisma, {})).toEqual({ status: 'skipped' });
    expect(await bootstrapAdmin(ctx.prisma, { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' })).toEqual({ status: 'skipped' });
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('refuses a policy-violating password without echoing it, creating nothing', async () => {
    const bad = 'SECRETSHORT';
    const err = await bootstrapAdmin(ctx.prisma, { ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: bad }).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ADMIN_PASSWORD rejected/);
    expect((err as Error).message).not.toContain(bad);
    await expect(bootstrapAdmin(ctx.prisma, { ADMIN_USERNAME: 'No Good!', ADMIN_PASSWORD: 'Valid-Passphrase-Here-1' })).rejects.toThrow(/ADMIN_USERNAME/);
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('creates the first admin (setup no longer required) and records an audit event', async () => {
    const env = { ADMIN_USERNAME: 'Boss', ADMIN_PASSWORD: 'Valid-Passphrase-Here-1' };
    expect(await bootstrapAdmin(ctx.prisma, env, ctx.deps.instr)).toEqual({ status: 'created', username: 'boss' });
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'boss' } });
    expect(u.role).toBe('ADMIN');
    expect(u.passwordHash).not.toContain(env.ADMIN_PASSWORD);
    expect(await verifyPassword(u.passwordHash, env.ADMIN_PASSWORD)).toBe(true);
    const st = await request(ctx.app).get('/api/auth/status').expect(200);
    expect(st.body.data.setupRequired).toBe(false);
    await request(ctx.app).post('/api/auth/login').send({ username: 'boss', password: env.ADMIN_PASSWORD }).expect(200);
    await request(ctx.app).post('/api/auth/setup').send({ username: 'other', password: 'Valid-Passphrase-Here-2' }).expect(409);
    expect(await ctx.prisma.activityEvent.count({ where: { type: 'auth.setup' } })).toBe(1);
  });

  it('is idempotent: a second run (or a changed env password) never touches the existing user', async () => {
    const before = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'boss' } });
    expect(await bootstrapAdmin(ctx.prisma, { ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'Valid-Passphrase-Here-1' })).toEqual({ status: 'exists' });
    expect(await bootstrapAdmin(ctx.prisma, { ADMIN_USERNAME: 'intruder', ADMIN_PASSWORD: 'Totally-Different-Phrase-9' })).toEqual({ status: 'exists' });
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'boss' } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  it('parallel bootstraps create exactly one user', async () => {
    const local = await newAuthApp();
    try {
      const env = { ADMIN_USERNAME: 'racer', ADMIN_PASSWORD: 'Valid-Passphrase-Here-3' };
      const rs = await Promise.all([1, 2, 3].map(() => bootstrapAdmin(local.prisma, env)));
      expect(rs.filter(r => r.status === 'created')).toHaveLength(1);
      expect(await local.prisma.user.count()).toBe(1);
    } finally { await closeAuthApp(local); }
  });
});

describe('npm run user:create (CLI)', () => {
  it('creates a user from env, never prints the password, and rejects weak ones', async () => {
    const cli = path.join(REPO_ROOT, 'backend', 'src', 'modules', 'auth', 'cli.ts');
    const env = { ...process.env, DATABASE_URL: ctx.databaseUrl };
    const run = (extra: Record<string, string>, args: string[] = []) => {
      try {
        const out = execFileSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
        return { code: 0, out };
      } catch (e) {
        const x = e as { status: number; stdout: string; stderr: string };
        return { code: x.status, out: `${x.stdout}${x.stderr}` };
      }
    };
    const pw = 'Cli-Created-Passphrase-8';
    const ok = run({ USERNAME: 'cli-user', PASSWORD: pw, ROLE: 'VIEWER' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('cli-user');
    expect(ok.out).not.toContain(pw);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'cli-user' } });
    expect(u.role).toBe('VIEWER');
    expect(await verifyPassword(u.passwordHash, pw)).toBe(true);
    const weak = run({ USERNAME: 'cli-weak', PASSWORD: 'tooshort' });
    expect(weak.code).toBe(1);
    expect(weak.out).not.toContain('tooshort');
    const dup = run({ USERNAME: 'cli-user', PASSWORD: pw });
    expect(dup.code).toBe(1);
    expect(dup.out).not.toContain(pw);
    const missing = run({ USERNAME: '', PASSWORD: '' });
    expect(missing.code).toBe(1);
  }, 60_000);
});
