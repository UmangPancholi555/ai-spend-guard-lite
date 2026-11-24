import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, cleanupTestDir } from '../helpers/testApp';
import { buildApp, createDeps } from '../../src/app';

describe('frontend static serving and SPA fallback', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let app: ReturnType<typeof buildApp>;
  let dist: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    dist = path.join(ctx.dir, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    app = buildApp(createDeps(ctx.prisma, { ...ctx.deps.config, frontendDist: dist }));
  });
  afterAll(async () => { await ctx?.close(); if (ctx) cleanupTestDir(ctx.dir); });

  it('serves an existing asset', async () => {
    const res = await request(app).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log(1)');
  });

  it('answers 404 NOT_FOUND JSON for a missing asset instead of index.html', async () => {
    for (const url of ['/assets/index-missing.js', '/assets/nested/missing.css']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/application\/json/);
      expect(res.body.error.code, url).toBe('NOT_FOUND');
    }
  });

  it('still serves index.html for client routes, including ones that only start like "assets"', async () => {
    for (const url of ['/no-such-client-route', '/projects/abc/settings', '/assets-report']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text, url).toContain('<div id="root">');
    }
  });

  it('keeps 503 FRONTEND_UNAVAILABLE for client routes while index.html is missing', async () => {
    fs.rmSync(path.join(dist, 'index.html'));
    try {
      const res = await request(app).get('/no-such-client-route');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FRONTEND_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    }
  });
});
