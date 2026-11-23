import { describe, it, expect } from 'vitest';
import { clientKey } from '../../src/middleware/security';

describe('clientKey (rate-limit bucket key)', () => {
  it('keeps IPv4, unwraps IPv4-mapped IPv6', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });
  it('collapses IPv6 addresses of one /64 into one key', () => {
    const a = clientKey('2001:db8:abcd:12::1');
    const b = clientKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(clientKey('2001:db8:abcd:13::1')).not.toBe(a);
  });
  it('handles missing and loopback addresses', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('::1')).toBe(clientKey('0:0:0:0:0:0:0:1'));
  });
});
