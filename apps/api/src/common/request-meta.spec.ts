import type { Request } from 'express';
import { ipOf, requestMetaOf, userAgentOf } from './request-meta.js';

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
});
