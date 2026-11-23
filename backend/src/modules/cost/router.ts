import { Router } from 'express';
import { z } from 'zod';
import type { PricingConfig } from '@prisma/client';
import type { PricingDto } from '../../../../shared/types';
import type { AppDeps } from '../../contracts/services';
import { ah, parse } from '../../utils/http';
import { badRequest } from '../../utils/errors';
import { parsePriceToMicro } from '../../utils/money';
import { selectPricingVersion, FALLBACK_KEY } from './pricing';
import { microToPriceString, toBreakdown } from './service';

const tokens = z.number({ invalid_type_error: 'must be a number' }).int().nonnegative().safe();
const isoDate = z.string().refine(s => !Number.isNaN(Date.parse(s)), 'must be a valid ISO date');

const calculateSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  inputTokens: tokens,
  outputTokens: tokens,
  cachedTokens: tokens.optional(),
  at: isoDate.optional(),
});

const price = z.string().refine(s => { try { parsePriceToMicro(s); return true; } catch { return false; } },
  'must be a non-negative decimal string with at most 6 fraction digits');

const createSchema = z.object({
  provider: z.string().trim().min(1).max(64).regex(/^(\*|[a-z0-9][a-z0-9._-]*)$/, 'provider must be a lowercase slug (or "*")'),
  model: z.string().trim().min(1).max(128).regex(/^(\*|[A-Za-z0-9][A-Za-z0-9._:/@+-]*)$/, 'model has invalid characters'),
  inputPerMTok: price, outputPerMTok: price, cachedPerMTok: price,
  effectiveFrom: isoDate.optional(),
  note: z.string().trim().max(500).optional(),
}).refine(v => (v.provider === FALLBACK_KEY) === (v.model === FALLBACK_KEY), {
  message: 'the "*" wildcard is only valid for both provider and model (fallback pricing)', path: ['model'],
});

const listQuery = z.object({
  provider: z.string().trim().optional().transform(v => v || undefined),
  model: z.string().trim().optional().transform(v => v || undefined),
  history: z.enum(['true', 'false']).optional().transform(v => v !== 'false'),
});

function toDto(r: PricingConfig, isCurrent: boolean): PricingDto {
  return {
    id: r.id, providerKey: r.providerKey, modelName: r.modelName, version: r.version,
    inputPerMTok: microToPriceString(parsePriceToMicro(r.inputPerMTok)),
    outputPerMTok: microToPriceString(parsePriceToMicro(r.outputPerMTok)),
    cachedPerMTok: microToPriceString(parsePriceToMicro(r.cachedPerMTok)),
    currency: 'USD', effectiveFrom: r.effectiveFrom.toISOString(), note: r.note,
    createdAt: r.createdAt.toISOString(), isCurrent,
  };
}

/** serialise pricing writes inside this process (SQLite single writer; also avoids version races) */
let writeChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export function createCostRouter(deps: AppDeps): Router {
  const r = Router();
  const { prisma, cost } = deps;

  r.post('/cost/calculate', ah(async (req, res) => {
    const body = parse(calculateSchema, req.body);
    const result = await cost.calculate(body);
    res.json({ data: toBreakdown(result) });
  }));

  r.get('/cost/pricing', ah(async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await prisma.pricingConfig.findMany({
      where: { ...(q.provider ? { providerKey: q.provider.toLowerCase() } : {}), ...(q.model ? { modelName: q.model } : {}) },
      orderBy: [{ providerKey: 'asc' }, { modelName: 'asc' }, { version: 'desc' }],
    });
    const now = new Date();
    const groups = new Map<string, PricingConfig[]>();
    for (const row of rows) {
      const k = `${row.providerKey}\u0000${row.modelName}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
    }
    const out: PricingDto[] = [];
    for (const g of groups.values()) {
      const current = selectPricingVersion(g, now);
      for (const row of g) {
        const isCurrent = current?.id === row.id;
        if (q.history || isCurrent) out.push(toDto(row, isCurrent));
      }
    }
    res.json({ data: out });
  }));

  r.post('/cost/pricing', ah(async (req, res) => {
    const b = parse(createSchema, req.body);
    const effectiveFrom = b.effectiveFrom ? new Date(b.effectiveFrom) : new Date();
    const row = await serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const existing = await prisma.pricingConfig.findMany({ where: { providerKey: b.provider, modelName: b.model } });
        const maxVersion = existing.reduce((m, x) => Math.max(m, x.version), 0);
        const latestFrom = existing.reduce((m, x) => Math.max(m, x.effectiveFrom.getTime()), 0);
        if (effectiveFrom.getTime() < latestFrom) {
          throw badRequest('effectiveFrom must not be earlier than the latest existing version\'s effectiveFrom (history is immutable)',
            { latestEffectiveFrom: new Date(latestFrom).toISOString() });
        }
        try {
          return await prisma.pricingConfig.create({
            data: {
              providerKey: b.provider, modelName: b.model, version: maxVersion + 1,
              inputPerMTok: microToPriceString(parsePriceToMicro(b.inputPerMTok)),
              outputPerMTok: microToPriceString(parsePriceToMicro(b.outputPerMTok)),
              cachedPerMTok: microToPriceString(parsePriceToMicro(b.cachedPerMTok)),
              effectiveFrom, note: b.note ?? null,
            },
          });
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002' && attempt < 5) continue;
          throw e;
        }
      }
    });
    const all = await prisma.pricingConfig.findMany({ where: { providerKey: row.providerKey, modelName: row.modelName } });
    const current = selectPricingVersion(all, new Date());
    res.status(201).json({ data: toDto(row, current?.id === row.id) });
  }));

  return r;
}
