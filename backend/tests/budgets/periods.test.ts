import { describe, it, expect } from 'vitest';
import { periodBounds, previousPeriodStart } from '../../src/modules/budgets';

const iso = (b: { start: Date; end: Date }) => [b.start.toISOString(), b.end.toISOString()];

describe('periodBounds (UTC)', () => {
  it('DAILY = UTC day', () => {
    expect(iso(periodBounds('DAILY', new Date('2024-03-15T13:45:10.123Z')))).toEqual(['2024-03-15T00:00:00.000Z', '2024-03-16T00:00:00.000Z']);
    expect(iso(periodBounds('DAILY', new Date('2024-03-15T23:59:59.999Z')))).toEqual(['2024-03-15T00:00:00.000Z', '2024-03-16T00:00:00.000Z']);
  });
  it('DAILY: end instant belongs to the next period (half-open)', () => {
    expect(iso(periodBounds('DAILY', new Date('2024-03-16T00:00:00.000Z')))[0]).toBe('2024-03-16T00:00:00.000Z');
  });
  it('DAILY across leap day and year end', () => {
    expect(iso(periodBounds('DAILY', new Date('2024-02-28T12:00:00Z')))[1]).toBe('2024-02-29T00:00:00.000Z');
    expect(iso(periodBounds('DAILY', new Date('2024-02-29T12:00:00Z')))).toEqual(['2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z']);
    expect(iso(periodBounds('DAILY', new Date('2023-02-28T12:00:00Z')))[1]).toBe('2023-03-01T00:00:00.000Z');
    expect(iso(periodBounds('DAILY', new Date('2024-12-31T23:59:59.999Z')))).toEqual(['2024-12-31T00:00:00.000Z', '2025-01-01T00:00:00.000Z']);
  });
  it('WEEKLY = Monday 00:00 UTC .. next Monday', () => {
    // 2024-03-11 is a Monday
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-11T00:00:00.000Z')))).toEqual(['2024-03-11T00:00:00.000Z', '2024-03-18T00:00:00.000Z']);
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-13T08:00:00Z')))).toEqual(['2024-03-11T00:00:00.000Z', '2024-03-18T00:00:00.000Z']);
  });
  it('WEEKLY: Sunday belongs to the week that started the previous Monday', () => {
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-17T23:59:59.999Z')))).toEqual(['2024-03-11T00:00:00.000Z', '2024-03-18T00:00:00.000Z']);
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-17T00:00:00.000Z')))[0]).toBe('2024-03-11T00:00:00.000Z');
  });
  it('WEEKLY: next Monday starts a new week', () => {
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-18T00:00:00.000Z')))).toEqual(['2024-03-18T00:00:00.000Z', '2024-03-25T00:00:00.000Z']);
  });
  it('WEEKLY across a year boundary and month boundary', () => {
    expect(iso(periodBounds('WEEKLY', new Date('2025-01-01T10:00:00Z')))).toEqual(['2024-12-30T00:00:00.000Z', '2025-01-06T00:00:00.000Z']);
    expect(iso(periodBounds('WEEKLY', new Date('2024-03-03T10:00:00Z')))).toEqual(['2024-02-26T00:00:00.000Z', '2024-03-04T00:00:00.000Z']); // spans leap day
  });
  it('MONTHLY = UTC calendar month incl. leap February', () => {
    expect(iso(periodBounds('MONTHLY', new Date('2024-02-29T23:59:59.999Z')))).toEqual(['2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z']);
    expect(iso(periodBounds('MONTHLY', new Date('2023-02-15T00:00:00Z')))).toEqual(['2023-02-01T00:00:00.000Z', '2023-03-01T00:00:00.000Z']);
    expect(iso(periodBounds('MONTHLY', new Date('2024-03-01T00:00:00.000Z')))[0]).toBe('2024-03-01T00:00:00.000Z');
  });
  it('MONTHLY across the year boundary', () => {
    expect(iso(periodBounds('MONTHLY', new Date('2024-12-31T23:59:59.999Z')))).toEqual(['2024-12-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z']);
    expect(iso(periodBounds('MONTHLY', new Date('2025-01-01T00:00:00.000Z')))).toEqual(['2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z']);
  });
  it('rejects invalid dates', () => {
    expect(() => periodBounds('DAILY', new Date('nope'))).toThrow();
  });
});

describe('previousPeriodStart', () => {
  it('DAILY', () => {
    expect(previousPeriodStart('DAILY', new Date('2024-03-01T00:00:00Z')).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(previousPeriodStart('DAILY', new Date('2025-01-01T00:00:00Z')).toISOString()).toBe('2024-12-31T00:00:00.000Z');
  });
  it('WEEKLY', () => {
    expect(previousPeriodStart('WEEKLY', new Date('2025-01-06T00:00:00Z')).toISOString()).toBe('2024-12-30T00:00:00.000Z');
    expect(previousPeriodStart('WEEKLY', new Date('2024-03-04T00:00:00Z')).toISOString()).toBe('2024-02-26T00:00:00.000Z');
  });
  it('MONTHLY (month lengths, year wrap)', () => {
    expect(previousPeriodStart('MONTHLY', new Date('2025-01-01T00:00:00Z')).toISOString()).toBe('2024-12-01T00:00:00.000Z');
    expect(previousPeriodStart('MONTHLY', new Date('2024-03-01T00:00:00Z')).toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(previousPeriodStart('MONTHLY', new Date('2024-05-01T00:00:00Z')).toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });
  it('previous of a period start is the start of the period just before it', () => {
    for (const p of ['DAILY', 'WEEKLY', 'MONTHLY'] as const) {
      const cur = periodBounds(p, new Date('2024-03-13T08:00:00Z'));
      const prev = periodBounds(p, previousPeriodStart(p, cur.start));
      expect(prev.end.getTime()).toBe(cur.start.getTime());
    }
  });
});
