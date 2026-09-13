import {
  INBOUND_XFF_HEADER,
  MAX_INBOUND_XFF_LEN,
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  WEB_TRUST_PROXY_HOPS_HEADER,
  boundInboundXff,
  getResolvedClientIp,
  resolveClientIpFromXff,
  trustProxyHops,
} from './client-ip';

// Pure-lib coverage only. The proxy.ts wiring that sets
// `x-ws-inbound-xff` pulls in Next.js server modules and is out of scope
// for this node/ts-jest setup (see jest.config.js); it is exercised via
// typecheck, `next build`, and manual verification. How api-proxy.ts
// scopes the display-only headers to whoami is covered in
// api-proxy.spec.ts.

const savedHops = process.env.TRUST_PROXY_HOPS;

function restoreHops() {
  if (savedHops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = savedHops;
}

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

  it('falls back to the leftmost entry when the chain is shorter than the hops', () => {
    // The case the whoami diagnostic flags: nothing signals the fallback
    // here, so the API compares the chain length with the hop count.
    expect(resolveClientIpFromXff('172.18.0.3', 2)).toBe('172.18.0.3');
  });
});

describe('trustProxyHops (the one read the resolver and the diagnostic share)', () => {
  afterEach(restoreHops);

  const cases: Array<[string | undefined, number]> = [
    [undefined, 1],
    ['', 1],
    ['0', 0],
    ['2', 2],
    ['10', 10],
    ['15', 10],
    ['-1', 1],
    ['abc', 1],
  ];

  it.each(cases)('reads TRUST_PROXY_HOPS=%p as %p', (raw, expected) => {
    if (raw === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = raw;
    expect(trustProxyHops()).toBe(expected);
  });

  it('is the value the resolver applies when no hop count is passed', () => {
    process.env.TRUST_PROXY_HOPS = '2';
    expect(resolveClientIpFromXff('198.51.100.7, 172.18.0.4')).toBe('198.51.100.7');
    process.env.TRUST_PROXY_HOPS = '1';
    expect(resolveClientIpFromXff('198.51.100.7, 172.18.0.4')).toBe('172.18.0.4');
  });

  it('uses the header name the API reads back', () => {
    expect(WEB_TRUST_PROXY_HOPS_HEADER).toBe('x-ws-web-trust-proxy-hops');
  });
});

describe('getResolvedClientIp', () => {
  afterEach(restoreHops);

  it('prefers the IP that proxy.ts stashed', () => {
    const headers = new Headers({
      [RESOLVED_CLIENT_IP_HEADER]: '::ffff:198.51.100.7',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(getResolvedClientIp(headers)).toBe('198.51.100.7');
  });

  it('resolves X-Forwarded-For when nothing was stashed', () => {
    process.env.TRUST_PROXY_HOPS = '1';
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' });
    expect(getResolvedClientIp(headers)).toBe('198.51.100.7');
  });

  it('never reads X-Real-IP', () => {
    // Next.js fills a missing X-Forwarded-For with the TCP peer before
    // proxy.ts runs, so an X-Real-IP fallback never applied in
    // production; here it would only trust a client-controlled header in
    // the one path where that fill-in did not happen.
    process.env.TRUST_PROXY_HOPS = '1';
    const headers = new Headers({ 'x-real-ip': '1.2.3.4' });
    expect(getResolvedClientIp(headers)).toBe(UNKNOWN_CLIENT_IP);
  });
});
