import { describe, it, expect } from 'vitest';
import { sanitizeAttributes, redact } from '../../src/modules/instrumentation';
import { createHash } from 'node:crypto';

describe('sanitizeAttributes', () => {
  it('redacts content-like keys into {redacted,type,length,sha256_8}', () => {
    const out = sanitizeAttributes({
      prompt: 'Tell me the secret plan', content: 'hello world', text: 't', body: { a: 1 }, message: 'm', memory: ['x', 'y'],
      secret: 's3cr3t', password: 'hunter2', authorization: 'Bearer abcdef0123456789', apiKey: 'k', api_key: 'k2', 'api-key': 'k3', token: 'tok', accessToken: 'a',
    });
    for (const v of Object.values(out)) expect((v as { redacted: boolean }).redacted).toBe(true);
    expect(out.prompt).toEqual({ redacted: true, type: 'string', length: 23, sha256_8: createHash('sha256').update('Tell me the secret plan').digest('hex').slice(0, 8) });
    expect((out.memory as { type: string; length: number })).toMatchObject({ type: 'array', length: 2 });
    expect((out.body as { type: string }).type).toBe('object');
    expect(JSON.stringify(out)).not.toMatch(/hunter2|secret plan|hello world|s3cr3t/);
  });

  it('keeps counts, sizes, hashes and ids even under content-ish keys', () => {
    const input = { estimatedTokens: 12, inputTokens: 5, outputTokens: 6, cachedTokens: 1, promptChars: 99, promptHash: 'a'.repeat(64), messageCount: 3,
      memoryCount: 2, contentLength: 10, bodyBytes: 7, messageId: 'm_1', toolName: 'search', memoryItems: 4, hasPrompt: true };
    expect(sanitizeAttributes(input)).toEqual(input);
  });

  it('still redacts numeric/boolean secrets', () => {
    const out = sanitizeAttributes({ password: 123456, secret: true, token: 42 });
    expect(Object.values(out).every(v => (v as { redacted?: boolean }).redacted)).toBe(true);
  });

  it('deep-sanitizes nested objects and arrays', () => {
    const out = sanitizeAttributes({ a: { b: { prompt: 'deep secret', ok: 1 } }, list: [{ content: 'c1' }, { n: 2 }] }) as any;
    expect(out.a.b.prompt.redacted).toBe(true);
    expect(out.a.b.ok).toBe(1);
    expect(out.list[0].content.redacted).toBe(true);
    expect(out.list[1].n).toBe(2);
    expect(JSON.stringify(out)).not.toContain('deep secret');
  });

  it('redacts credential-looking values under innocent keys and truncates long strings', () => {
    const out = sanitizeAttributes({ header: 'Bearer abcdefghijklmnop', k: 'sk-abcdefghijklmnopqrstuv', long: 'x'.repeat(1000), label: 'fine' }) as any;
    expect(out.header.redacted).toBe(true);
    expect(out.k.redacted).toBe(true);
    expect(out.long.length).toBeLessThanOrEqual(257);
    expect(out.label).toBe('fine');
  });

  it('caps depth, item count, circular refs, handles bigint/dates/errors/functions and never throws', () => {
    const circ: any = { a: 1 }; circ.self = circ;
    let deep: any = { v: 1 }; for (let i = 0; i < 20; i++) deep = { n: deep };
    const out = sanitizeAttributes({
      circ, deep, big: 10n, when: new Date('2026-01-01T00:00:00Z'), err: new Error('has message'), fn: () => 1,
      arr: Array.from({ length: 200 }, (_, i) => i), obj: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])), nan: NaN,
    }) as any;
    expect(out.circ.self).toBe('[circular]');
    expect(JSON.stringify(out.deep)).toContain('[depth-limit]');
    expect(out.big).toBe('10');
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');
    expect(out.err).toEqual({ error: true, name: 'Error' });
    expect(out.fn).toBeUndefined();
    expect(out.arr).toHaveLength(51);
    expect(Object.keys(out.obj).length).toBe(51);
    expect(sanitizeAttributes(undefined)).toEqual({});
    expect(sanitizeAttributes(null)).toEqual({});
    expect(sanitizeAttributes('str' as any)).toEqual({ value: 'str' });
  });

  it('caps total serialized size', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = 'y'.repeat(250).replace(/y/g, 'z') + i;
    const arrays: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) arrays[`a${i}`] = Array.from({ length: 50 }, () => 'q'.repeat(200));
    const out = sanitizeAttributes(arrays) as any;
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(1000);
    expect(JSON.stringify(sanitizeAttributes(big)).length).toBeLessThan(16 * 1024 + 1);
  });

  it('is idempotent', () => {
    const once = sanitizeAttributes({ prompt: 'abc', n: 1 });
    expect(sanitizeAttributes(once)).toEqual(once);
    expect(redact('abc').length).toBe(3);
  });
});

describe('sanitizer: credential keys and values (hardening)', () => {
  it('redacts cookie/set-cookie/session/csrf/credential/passwd/private keys', () => {
    const out = sanitizeAttributes({
      cookie: 'a=b', 'set-cookie': 'sid=1', sessionId: 'abc123', session: { id: 1 }, csrfToken: 't', credentials: 'u:p', passwd: 'x',
      privateKey: 'k', isPrivate: true, sessionCount: 3, tokenCount: 4, passwordHash: 'abc123',
    }) as any;
    for (const k of ['cookie', 'set-cookie', 'sessionId', 'session', 'csrfToken', 'credentials', 'passwd', 'privateKey', 'isPrivate']) {
      expect(out[k]?.redacted, k).toBe(true);
    }
    expect(out.sessionCount).toBe(3);
    expect(out.tokenCount).toBe(4);
    expect(out.passwordHash).toBe('abc123'); // hash-suffixed key + non-secret-looking value is metadata
  });

  it('redacts credential-looking VALUES under any key: scrypt/bcrypt/argon2 hashes, JWTs, Bearer, PEM, salt:hash hex', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = sanitizeAttributes({
      a: 'scrypt$16384$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNo', passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', b: '$2b$12$abcdefghijklmnopqrstuv', c: '$argon2id$v=19$m=65536',
      d: `note ${jwt} inside`, e: 'Authorization: Bearer abcdefgh12345678', f: '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
      g: 'a'.repeat(32) + ':' + 'b'.repeat(128), safe: 'plain text value', hash: 'a'.repeat(64),
    }) as any;
    for (const k of ['a', 'passwordHash', 'b', 'c', 'd', 'e', 'f', 'g']) expect(out[k]?.redacted, k).toBe(true);
    expect(out.safe).toBe('plain text value');
    expect(out.hash).toBe('a'.repeat(64)); // sha256-style hash is metadata
  });

  it('scrubs credentials and control chars embedded in free-text messages (DB + JSONL)', async () => {
    const { createTestApp, cleanupTestDir } = await import('../helpers/testApp');
    const { readJsonl } = await import('./util');
    const ctx = await createTestApp();
    try {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      await ctx.deps.instr.recordError({ source: 'ACTUAL', category: 'PROVIDER', operation: 'scrub', error: new Error(`401 for Bearer sk-live-abcdefghijklmnop and ${jwt}`) });
      const row = await ctx.prisma.executionLog.findFirstOrThrow({ where: { operation: 'scrub' } });
      for (const text of [row.errorMessage, row.message, JSON.stringify(readJsonl(ctx.deps.config.logDir))]) {
        expect(text).not.toContain('eyJhbGci');
        expect(text).not.toContain('abcdefghijklmnop');
      }
      expect(row.errorMessage).toContain('[REDACTED]');
    } finally { await ctx.close(); cleanupTestDir(ctx.dir); }
  });
});

describe('privacy end-to-end: no raw content in DB or JSONL', () => {
  it('stores only redacted markers for every record* path', async () => {
    const { createTestApp, cleanupTestDir } = await import('../helpers/testApp');
    const { readJsonl } = await import('./util');
    const ctx = await createTestApp();
    try {
      const SECRET = 'TOP-SECRET-PROMPT-CONTENT-12345';
      const i = ctx.deps.instr;
      const trace = await i.startTrace({ name: 'priv', source: 'ACTUAL', attributes: { prompt: SECRET, promptChars: 31 } });
      const sp = await trace.startSpan('s', 'PROVIDER', { content: SECRET });
      await sp.end(undefined, { body: SECRET });
      await trace.end();
      await i.recordBus({ source: 'ACTUAL', operationName: 'b', operationType: 'PUBLISH', eventName: 'e', inputMeta: { message: SECRET, nested: { text: SECRET } }, success: true });
      await i.recordTool({ source: 'SIMULATED', toolName: 't', toolCallId: 'c', startedAt: new Date(), endedAt: new Date(), success: true, inputMeta: { prompt: SECRET }, outputMeta: { content: SECRET } });
      await i.recordActivity({ type: 'x.y', message: 'ok', source: 'ACTUAL', metadata: { memory: SECRET } });
      await i.recordError({ source: 'ACTUAL', category: 'INTERNAL', operation: 'op', error: new Error('e'), attributes: { password: SECRET } });
      await i.log({ level: 'INFO', eventType: 'e', category: 'SYSTEM', operation: 'o', status: 'INFO', source: 'ACTUAL', message: 'm', attributes: { authorization: SECRET } });
      const t = await i.startTask({ name: 'task', kind: 'OTHER', source: 'ACTUAL' });
      await t.succeed({ text: SECRET, count: 1 });

      const dump = JSON.stringify({
        spans: await ctx.prisma.span.findMany(), bus: await ctx.prisma.busEvent.findMany(), tools: await ctx.prisma.toolCallEvent.findMany(),
        act: await ctx.prisma.activityEvent.findMany(), logs: await ctx.prisma.executionLog.findMany(), tasks: await ctx.prisma.backgroundTask.findMany(),
      });
      expect(dump).not.toContain(SECRET);
      expect(dump).toContain('sha256_8');
      expect(JSON.stringify(readJsonl(ctx.deps.config.logDir))).not.toContain(SECRET);
      expect(JSON.stringify(readJsonl(ctx.deps.config.logDir))).toContain('"redacted":true');
      const root = await ctx.prisma.span.findUniqueOrThrow({ where: { spanId: trace.rootSpan.spanId } });
      expect(JSON.parse(root.attributes).promptChars).toBe(31);
    } finally { await ctx.close(); cleanupTestDir(ctx.dir); }
  });
});
