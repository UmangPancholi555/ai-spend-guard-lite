import { describe, it, expect } from 'vitest';
import { avg, max, percentile, rate } from '../../src/modules/observability/stats';

describe('stats helpers', () => {
  it('avg rounds to 2dp and returns 0 for empty', () => {
    expect(avg([])).toBe(0);
    expect(avg([1, 2, 4])).toBe(2.33);
    expect(avg([10])).toBe(10);
  });
  it('percentile uses nearest-rank on sorted copy', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile([5, 1, 3], 95)).toBe(5); // unsorted input, ceil(.95*3)=3
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([], 95)).toBe(0);
    const input = [3, 1, 2]; percentile(input, 95);
    expect(input).toEqual([3, 1, 2]); // not mutated
  });
  it('max and rate are NaN-free', () => {
    expect(max([])).toBe(0);
    expect(max([1, 9, 3])).toBe(9);
    expect(rate(1, 0)).toBe(0);
    expect(rate(1, 3)).toBe(0.3333);
  });
});
