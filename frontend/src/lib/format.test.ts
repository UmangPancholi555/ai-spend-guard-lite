import { describe, expect, it } from 'vitest';
import { fmtUsd } from './format';

describe('fmtUsd rounding (half-up on the decimal string)', () => {
  it('rounds up when the first dropped digit is 5 or more', () => {
    expect(fmtUsd('12.3456785')).toBe('$12.345679');
    expect(fmtUsd('0.12345650000')).toBe('$0.123457');
  });

  it('keeps the digits when the first dropped digit is below 5', () => {
    expect(fmtUsd('12.3456784999')).toBe('$12.345678');
  });

  it('renders a sub-micro-dollar cost that rounds up instead of $0.00', () => {
    expect(fmtUsd('0.000000500000')).toBe('$0.000001');
    expect(fmtUsd('0.000000499999')).toBe('$0.00');
  });

  it('carries through the fraction and trims/pads as before', () => {
    expect(fmtUsd('1.9999995')).toBe('$2.00');
    expect(fmtUsd('0.995', 2)).toBe('$1.00');
  });

  it('carries into the integer part, keeping thousands separators', () => {
    expect(fmtUsd('999999.999999500000')).toBe('$1,000,000.00');
  });

  it('rounds at a custom maxFrac', () => {
    expect(fmtUsd('0.0000000000015', 12)).toBe('$0.000000000002');
  });

  it('rounds the magnitude of a negative value (half away from zero)', () => {
    expect(fmtUsd('-0.9999995')).toBe('$-1.00');
  });
});

describe('fmtUsd unchanged format', () => {
  it('returns "-" for null and undefined', () => {
    expect(fmtUsd(null)).toBe('-');
    expect(fmtUsd(undefined)).toBe('-');
  });

  it('pads to at least 2 decimals and trims trailing zeros', () => {
    expect(fmtUsd('5')).toBe('$5.00');
    expect(fmtUsd('1.500000000000')).toBe('$1.50');
    expect(fmtUsd('1234567.5')).toBe('$1,234,567.50');
  });

  it('shows all 12 dp of an exact API value at maxFrac 12', () => {
    expect(fmtUsd('0.000000000123', 12)).toBe('$0.000000000123');
    expect(fmtUsd('3.000000000000', 12)).toBe('$3.00');
  });

  it('keeps the existing sign placement', () => {
    expect(fmtUsd('-1.5')).toBe('$-1.50');
  });
});
