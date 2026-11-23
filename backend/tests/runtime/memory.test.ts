import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanupTestDir, type TestCtx } from '../helpers/testApp';
import { allJsonl, dumpTables, makeProject } from './helpers';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); cleanupTestDir(ctx.dir); });

const SENT_TITLE = 'MEM-TITLE-SENTINEL-4711';
const SENT_BODY = 'MEM-CONTENT-SENTINEL-9182';
const api = () => request(ctx.app);

describe('project memory store (real, REST)', () => {
  it('create / list / patch / delete with computed sizeBytes + estimatedTokens', async () => {
    const p = await makeProject(ctx.prisma);
    const content = `${SENT_BODY} Always answer in French. Prefer short answers.`;
    const created = await api().post(`/api/projects/${p.id}/memory`).send({ title: SENT_TITLE, category: 'instructions', content });
    expect(created.status).toBe(201);
    const item = created.body.data;
    expect(item).toMatchObject({ projectId: p.id, title: SENT_TITLE, category: 'instructions', content, enabled: true });
    expect(item.sizeBytes).toBe(Buffer.byteLength(content));
    expect(item.estimatedTokens).toBe(Math.ceil(content.length / 4));

    const list = await api().get(`/api/projects/${p.id}/memory`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((i: any) => i.id)).toEqual([item.id]);

    const multi = 'héllo wörld ✓ '.repeat(10);
    const patched = await api().patch(`/api/projects/${p.id}/memory/${item.id}`).send({ content: multi, enabled: false, category: 'facts' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ content: multi, enabled: false, category: 'facts' });
    expect(patched.body.data.sizeBytes).toBe(Buffer.byteLength(multi, 'utf8'));
    expect(patched.body.data.sizeBytes).toBeGreaterThan(multi.length); // multibyte
    expect(patched.body.data.estimatedTokens).toBe(Math.ceil(multi.length / 4));
    // title-only patch keeps size
    const t = await api().patch(`/api/projects/${p.id}/memory/${item.id}`).send({ title: 'renamed' });
    expect(t.body.data.sizeBytes).toBe(Buffer.byteLength(multi, 'utf8'));

    expect((await api().delete(`/api/projects/${p.id}/memory/${item.id}`)).status).toBe(204);
    expect((await api().get(`/api/projects/${p.id}/memory`)).body.data).toEqual([]);
  });

  it('validation: title<=120, category enum, content 1..8000, patch needs a field; boundaries accepted', async () => {
    const p = await makeProject(ctx.prisma);
    const ok = { title: 't', category: 'facts', content: 'c' };
    const bad: Record<string, unknown>[] = [
      {}, { ...ok, title: '' }, { ...ok, title: 'x'.repeat(121) }, { ...ok, category: 'secrets' }, { ...ok, content: '' },
      { ...ok, content: 'x'.repeat(8001) }, { ...ok, enabled: 'yes' },
    ];
    for (const b of bad) {
      const r = await api().post(`/api/projects/${p.id}/memory`).send(b);
      expect(r.status, JSON.stringify(b).slice(0, 60)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await api().post(`/api/projects/${p.id}/memory`).send({ title: 'x'.repeat(120), category: 'other', content: 'x'.repeat(8000) })).status).toBe(201);
    const id = (await api().get(`/api/projects/${p.id}/memory`)).body.data[0].id;
    expect((await api().patch(`/api/projects/${p.id}/memory/${id}`).send({})).status).toBe(400);
    expect((await api().patch(`/api/projects/${p.id}/memory/${id}`).send({ category: 'nope' })).status).toBe(400);
  });

  it('404 for unknown project / item (also on the wrong project) ; archived projects still allow memory writes', async () => {
    const p = await makeProject(ctx.prisma);
    const other = await makeProject(ctx.prisma);
    expect((await api().get('/api/projects/missing/memory')).status).toBe(404);
    expect((await api().post('/api/projects/missing/memory').send({ title: 't', category: 'facts', content: 'c' })).status).toBe(404);
    const created = (await api().post(`/api/projects/${p.id}/memory`).send({ title: 't', category: 'facts', content: 'c' })).body.data;
    expect((await api().patch(`/api/projects/${other.id}/memory/${created.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await api().delete(`/api/projects/${p.id}/memory/nope`)).status).toBe(404);
    const archived = await makeProject(ctx.prisma, undefined, 'ARCHIVED');
    const w = await api().post(`/api/projects/${archived.id}/memory`).send({ title: 't', category: 'facts', content: 'c' });
    expect(w.status).toBe(201);
    expect((await api().get(`/api/projects/${archived.id}/memory`)).body.data).toHaveLength(1);
  });

  it('enforces the 200 items per project limit (409), per project', async () => {
    const p = await makeProject(ctx.prisma);
    await ctx.prisma.projectMemoryItem.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ projectId: p.id, title: `t${i}`, category: 'facts', content: 'c', sizeBytes: 1, estimatedTokens: 1 })),
    });
    const r = await api().post(`/api/projects/${p.id}/memory`).send({ title: 'one too many', category: 'facts', content: 'c' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONFLICT');
    const q = await makeProject(ctx.prisma);
    expect((await api().post(`/api/projects/${q.id}/memory`).send({ title: 'ok', category: 'facts', content: 'c' })).status).toBe(201);
    // deleting one frees a slot
    const first = (await ctx.prisma.projectMemoryItem.findFirst({ where: { projectId: p.id } }))!;
    expect((await api().delete(`/api/projects/${p.id}/memory/${first.id}`)).status).toBe(204);
    expect((await api().post(`/api/projects/${p.id}/memory`).send({ title: 'fits now', category: 'facts', content: 'c' })).status).toBe(201);
  });

  it('records ACTUAL project.memory.* activity with metadata only; content/title appear in no log table, span, event or JSONL', async () => {
    const p = await makeProject(ctx.prisma);
    const c = (await api().post(`/api/projects/${p.id}/memory`).send({ title: SENT_TITLE, category: 'preferences', content: SENT_BODY })).body.data;
    await api().patch(`/api/projects/${p.id}/memory/${c.id}`).send({ content: `${SENT_BODY} v2`, enabled: false });
    await api().delete(`/api/projects/${p.id}/memory/${c.id}`);
    const acts = await ctx.prisma.activityEvent.findMany({ where: { projectId: p.id, type: { startsWith: 'project.memory.' } }, orderBy: { createdAt: 'asc' } });
    expect(acts.map(a => a.type)).toEqual(['project.memory.created', 'project.memory.updated', 'project.memory.deleted']);
    for (const a of acts) {
      expect(a.source).toBe('ACTUAL');
      const meta = JSON.parse(a.metadata);
      expect(meta).toMatchObject({ itemId: c.id });
      expect(typeof meta.sizeBytes).toBe('number');
      expect(typeof meta.estimatedTokens).toBe('number');
      expect(meta.contentHash).toMatch(/^[0-9a-f]{8}$/);
    }
    // a request injects the memory too (covered elsewhere); here: privacy over EVERYTHING written so far, except the memory table
    const dump = await dumpTables(ctx.prisma, ['ProjectMemoryItem']);
    expect(dump).not.toContain('MEM-TITLE-SENTINEL');
    expect(dump).not.toContain('MEM-CONTENT-SENTINEL');
    expect(allJsonl(ctx)).not.toContain('MEM-');
  });
});
