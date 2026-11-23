import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { TestCtx } from '../helpers/testApp';
import { picoToUsd, usdToPico } from '../../src/utils/money';

export type Ctx = TestCtx;
export const api = (ctx: Ctx) => request(ctx.app);

export const HEX32 = /^[0-9a-f]{32}$/;
export const HEX16 = /^[0-9a-f]{16}$/;
export const REQ_ID = /^req_[0-9a-f]{32}$/;
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const USD12 = /^\d+\.\d{12}$/;

/** Catalog prices as micro-USD per MTok (hand-copied from backend/src/database/catalog.ts, NOT imported, so the
 *  integration test is an independent oracle). cost(pico) = tokens * priceMicro exactly. */
export const PRICE_MICRO: Record<string, { in: bigint; out: bigint; cached: bigint }> = {
  'openai/gpt-4o': { in: 2_500_000n, out: 10_000_000n, cached: 1_250_000n },
  'openai/gpt-4o-mini@v1': { in: 150_000n, out: 600_000n, cached: 75_000n },
  'openai/gpt-4o-mini': { in: 120_000n, out: 500_000n, cached: 60_000n }, // v2 (effective 2025-01-01)
  'openai/gpt-4.1': { in: 2_000_000n, out: 8_000_000n, cached: 500_000n },
  'openai/o3-mini': { in: 1_100_000n, out: 4_400_000n, cached: 550_000n },
  'anthropic/claude-sonnet': { in: 3_000_000n, out: 15_000_000n, cached: 300_000n },
  'anthropic/claude-opus': { in: 15_000_000n, out: 75_000_000n, cached: 1_500_000n },
  'anthropic/claude-haiku': { in: 800_000n, out: 4_000_000n, cached: 80_000n },
  '*/*': { in: 5_000_000n, out: 15_000_000n, cached: 2_500_000n }, // fallback => ESTIMATED
};

export function expectedPico(key: string, u: { inputTokens: number; outputTokens: number; cachedTokens: number }) {
  const p = PRICE_MICRO[key];
  const input = BigInt(u.inputTokens) * p.in;
  const output = BigInt(u.outputTokens) * p.out;
  const cached = BigInt(u.cachedTokens) * p.cached;
  return { input, output, cached, total: input + output + cached };
}

export async function mkProject(ctx: Ctx, name: string, isTest = true) {
  const r = await api(ctx).post('/api/projects').send({ name, isTest });
  if (r.status !== 201) throw new Error(`project create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; name: string };
}

export interface ReqBody { projectId: string; provider: string; model: string; prompt: string; [k: string]: unknown }
export async function pay(ctx: Ctx, body: Partial<ReqBody> & { projectId: string }, expectStatus = 201) {
  const r = await api(ctx).post('/api/providers/requests').send({ provider: 'openai', model: 'gpt-4o-mini', prompt: 'hello world', ...body });
  if (r.status !== expectStatus) throw new Error(`request failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as import('../../../shared/types').MockProviderResponse;
}

export function logFiles(ctx: Ctx): string[] {
  const dir = path.join(ctx.dir, 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : [];
}
export function readJsonl(ctx: Ctx): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const f of logFiles(ctx)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

export async function listAll<T = any>(ctx: Ctx, url: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const r = await api(ctx).get(`${url}${sep}page=${page}&pageSize=200`);
    if (r.status !== 200) throw new Error(`GET ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    rows.push(...r.body.data);
    if (page >= r.body.pagination.totalPages) break;
  }
  return rows;
}

/** minimal RFC-4180 CSV parser (handles quotes, escaped quotes, embedded newlines/commas) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* ignore */ } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export { picoToUsd, usdToPico };

/** Dump every table of the SQLite DB as one big string (BigInt-safe) for content scanning. */
export async function dumpAllTables(ctx: Ctx): Promise<string> {
  const tables = await ctx.prisma.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  let out = '';
  for (const t of tables) {
    const rows = await ctx.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "${t.name}"`);
    out += `\n## ${t.name} (${rows.length})\n` + JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return out;
}
