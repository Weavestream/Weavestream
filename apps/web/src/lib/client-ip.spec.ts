import {
  INBOUND_XFF_HEADER,
  MAX_INBOUND_XFF_LEN,
  boundInboundXff,
  resolveClientIpFromXff,
} from './client-ip';

// Pure-lib coverage only. The proxy.ts / api-proxy.ts wiring that sets
// and scopes `x-ws-inbound-xff` pulls in Next.js server modules and is
// out of scope for this node/ts-jest setup (see jest.config.cjs); it is
// exercised via typecheck, `next build`, and manual verification.

describe('boundInboundXff', () => {
  it('returns an empty string for missing/empty input', () => {
    expect(boundInboundXff(null)).toBe('');
    expect(boundInboundXff(undefined)).toBe('');
    expect(boundInboundXff('')).toBe('');
  });

  it('passes a short chain through unchanged', () => {
    expect(boundInboundXff('1.2.3.4')).toBe('1.2.3.4');
    expect(boundInboundXff('1.2.3.4, 10.0.0.1')).toBe('1.2.3.4, 10.0.0.1');
  });

  it('length-bounds a hostile oversized chain to the cap', () => {
    const huge = Array.from({ length: 1000 }, () => '10.0.0.1').join(', ');
    const out = boundInboundXff(huge);
    expect(out.length).toBe(MAX_INBOUND_XFF_LEN);
    expect(out).toBe(huge.slice(0, MAX_INBOUND_XFF_LEN));
  });

  it('uses the header name the API reads back', () => {
    expect(INBOUND_XFF_HEADER).toBe('x-ws-inbound-xff');
  });
});

describe('resolveClientIpFromXff (attribution unaffected by the diagnostic)', () => {
  it('picks the entry TRUST_PROXY_HOPS from the right', () => {
    // One trusted hop → rightmost entry is the trusted proxy; the entry
    // to its left is the real client.
    expect(resolveClientIpFromXff('1.2.3.4, 10.0.0.1', 1)).toBe('10.0.0.1');
    expect(resolveClientIpFromXff('1.2.3.4, 10.0.0.1', 2)).toBe('1.2.3.4');
  });

  it('returns null when there is no trust (hops <= 0) or no chain', () => {
    expect(resolveClientIpFromXff('1.2.3.4', 0)).toBeNull();
    expect(resolveClientIpFromXff(null, 1)).toBeNull();
    expect(resolveClientIpFromXff('', 1)).toBeNull();
  });
});
