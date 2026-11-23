import { randomBytes, createHash, randomUUID } from 'node:crypto';
export const newTraceId = () => randomBytes(16).toString('hex'); // 32 hex
export const newSpanId = () => randomBytes(8).toString('hex'); // 16 hex
export const newRequestId = (prefix = 'req') => `${prefix}_${randomUUID().replace(/-/g, '')}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
