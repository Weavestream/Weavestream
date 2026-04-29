import type { Request } from 'express';
import {
  ipOf,
  normalizeIp,
  requestMetaOf,
  userAgentOf,
} from './request-meta.js';

describe('request-meta', () => {
  it('ipOf returns req.ip without consulting raw X-Forwarded-For', () => {
    const req = {
      ip: '10.0.0.1',
      headers: {
        // A directly-supplied XFF must be ignored. Express only writes
        // `req.ip` after honoring `app.set('trust proxy', N)`, so
        // anything we read here is already trust-validated.
        'x-forwarded-for': '203.0.113.4, 10.0.0.5',
      },
    } as unknown as Request;
    expect(ipOf(req)).toBe('10.0.0.1');
  });

  it('ipOf falls back to 0.0.0.0 when req.ip is undefined', () => {
    const req = { headers: {} } as unknown as Request;
    expect(ipOf(req)).toBe('0.0.0.0');
  });

  it('userAgentOf returns the header value capped at 500 chars', () => {
    const big = 'A'.repeat(800);
    const req = { headers: { 'user-agent': big } } as unknown as Request;
    const ua = userAgentOf(req);
    expect(ua).toHaveLength(500);
    expect(ua).toBe(big.slice(0, 500));
  });

  it('userAgentOf returns "unknown" when the header is missing', () => {
    const req = { headers: {} } as unknown as Request;
    expect(userAgentOf(req)).toBe('unknown');
  });

  it('requestMetaOf composes ip + userAgent', () => {
    const req = {
      ip: '198.51.100.7',
      headers: { 'user-agent': 'jest/1' },
    } as unknown as Request;
    expect(requestMetaOf(req)).toEqual({
      ip: '198.51.100.7',
      userAgent: 'jest/1',
    });
  });

  it('ipOf collapses IPv4-mapped IPv6 down to plain IPv4', () => {
    const req = { ip: '::ffff:192.168.1.50', headers: {} } as unknown as Request;
    expect(ipOf(req)).toBe('192.168.1.50');
  });

  it('normalizeIp leaves real IPv6 addresses unchanged', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('normalizeIp leaves plain IPv4 unchanged', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
  });

  it('normalizeIp does not strip "::ffff:" when the suffix is not IPv4', () => {
    // Real IPv6 addresses can begin with `::ffff:` followed by a
    // hex group (e.g. some link-local forms). Only collapse when
    // what follows is unambiguously dotted-quad v4.
    expect(normalizeIp('::ffff:dead:beef')).toBe('::ffff:dead:beef');
  });

  it('normalizeIp falls back to 0.0.0.0 for missing input', () => {
    expect(normalizeIp(undefined)).toBe('0.0.0.0');
    expect(normalizeIp(null)).toBe('0.0.0.0');
    expect(normalizeIp('')).toBe('0.0.0.0');
  });
});
