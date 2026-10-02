import {
  deriveDomainStatus,
  isNoSite,
  runDomainCheck,
} from './engine.js';
import { __resetRdapCacheForTests } from './rdap.js';
import type { EnginePorts } from './types.js';

/**
 * Phase 8 — DomainCheckEngine unit tests.
 *
 * We stub every "port" so the tests never touch the network. Each case
 * exercises exactly one branch of the state machine.
 */

interface StubOptions {
  bootstrapBody?: unknown;
  bootstrapStatus?: number;
  rdapBody?: unknown;
  rdapStatus?: number;
  whoisPayload?: string;
  whoisThrows?: boolean;
  a?: string[];
  aaaa?: string[];
  mx?: Array<{ exchange: string; priority: number }>;
  ns?: string[];
  dnsThrows?: boolean;
  tls?: {
    validFrom: string | null;
    validTo: string | null;
    issuer: string | null;
    subjectAltNames: string[];
    chainLength: number;
    protocol: string | null;
    authorized: boolean;
    authorizationError: string | null;
    keyAlgo?: string | null;
    keyBits?: number | null;
    sigAlgo?: string | null;
    mustStaple?: boolean;
    ocspStapled?: boolean;
  };
  tlsThrows?: string;
  now?: Date;
}

function makePorts(opts: StubOptions = {}): EnginePorts {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.includes('data.iana.org/rdap/dns.json')) {
      return {
        ok: (opts.bootstrapStatus ?? 200) < 400,
        status: opts.bootstrapStatus ?? 200,
        json: async () =>
          opts.bootstrapBody ?? {
            services: [
              [['com'], ['https://rdap.example.test/com/v1/']],
            ],
          },
        text: async () => '',
      };
    }
    return {
      ok: (opts.rdapStatus ?? 200) < 400,
      status: opts.rdapStatus ?? 200,
      json: async () => opts.rdapBody ?? {},
      text: async () => '',
    };
  });

  return {
    clock: { now: () => opts.now ?? new Date('2026-01-01T00:00:00Z') },
    dns: {
      resolve4: jest.fn(async () => {
        if (opts.dnsThrows) throw Object.assign(new Error('dns'), { code: 'ESERVFAIL' });
        return opts.a ?? ['1.2.3.4'];
      }),
      resolve6: jest.fn(async () => opts.aaaa ?? []),
      resolveMx: jest.fn(async () => opts.mx ?? [{ exchange: 'mx.example.test', priority: 10 }]),
      resolveNs: jest.fn(async () => opts.ns ?? ['ns1.example.test']),
      resolveTxt: jest.fn(async () => [] as string[][]),
      resolveCaa: jest.fn(async () => []),
      resolve: jest.fn(async () => [] as unknown[]),
    },
    tls: {
      probe: jest.fn(async () => {
        if (opts.tlsThrows) throw new Error(opts.tlsThrows);
        const stub = opts.tls ?? {
          validFrom: '2025-01-01T00:00:00.000Z',
          validTo: '2027-01-01T00:00:00.000Z',
          issuer: 'CN=Test CA',
          subjectAltNames: ['example.com'],
          chainLength: 3,
          protocol: 'TLSv1.3',
          authorized: true,
          authorizationError: null,
        };
        return {
          ...stub,
          keyAlgo: stub.keyAlgo ?? 'RSA',
          keyBits: stub.keyBits ?? 2048,
          sigAlgo: stub.sigAlgo ?? 'RSA-SHA256',
          mustStaple: stub.mustStaple ?? false,
          ocspStapled: stub.ocspStapled ?? false,
        };
      }),
    },
    whois43: {
      query: jest.fn(async () => {
        if (opts.whoisThrows) throw new Error('whois closed');
        return opts.whoisPayload ?? '';
      }),
    },
    fetch: fetchMock as unknown as EnginePorts['fetch'],
  };
}

beforeEach(() => {
  __resetRdapCacheForTests();
});

describe('runDomainCheck — WHOIS (RDAP first)', () => {
  it('returns OK when RDAP yields an expiry date', async () => {
    const ports = makePorts({
      rdapBody: {
        events: [
          { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
          { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' },
        ],
        entities: [
          {
            roles: ['registrar'],
            vcardArray: ['vcard', [['fn', {}, 'text', 'Acme Registrar']]],
          },
        ],
      },
    });

    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: true,
      checkDns: false,
      checkTls: false,
      timeoutMs: 1_000,
    });

    expect(res.whois.status).toBe('OK');
    expect(res.whois.data?.source).toBe('rdap');
    expect(res.whois.data?.registrar).toBe('Acme Registrar');
    expect(res.whois.data?.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('falls back to whois:43 when RDAP has no expiry', async () => {
    const ports = makePorts({
      rdapBody: {},
      whoisPayload: [
        'Domain Name: example.com',
        'Registrar: Fallback Registrar, Inc.',
        'Registry Expiry Date: 2028-06-15T00:00:00Z',
      ].join('\n'),
    });

    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: true,
      checkDns: false,
      checkTls: false,
      timeoutMs: 1_000,
    });

    expect(res.whois.status).toBe('OK');
    expect(res.whois.data?.source).toBe('whois43');
    expect(res.whois.data?.registrar).toBe('Fallback Registrar, Inc.');
    expect(res.whois.data?.expiresAt?.toISOString()).toBe('2028-06-15T00:00:00.000Z');
  });

  it('returns FAIL when no source produces a result', async () => {
    const ports = makePorts({
      rdapStatus: 404,
      rdapBody: {},
      whoisPayload: '',
    });
    const res = await runDomainCheck(ports, {
      hostname: 'unsupported.zz',
      checkWhois: true,
      checkDns: false,
      checkTls: false,
      timeoutMs: 500,
    });
    expect(res.whois.status).toBe('FAIL');
    expect(res.whois.data).toBeNull();
  });
});

describe('runDomainCheck — DNS', () => {
  it('classifies fully-populated records as OK', async () => {
    const ports = makePorts();
    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: false,
      checkDns: true,
      checkTls: false,
      timeoutMs: 500,
    });
    expect(res.dns.status).toBe('OK');
    expect(res.dns.data?.a).toEqual(['1.2.3.4']);
    expect(res.dns.data?.mx?.[0]?.preference).toBe(10);
  });

  it('returns WARN when A + AAAA are empty', async () => {
    const ports = makePorts({ a: [], aaaa: [] });
    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: false,
      checkDns: true,
      checkTls: false,
      timeoutMs: 500,
    });
    expect(res.dns.status).toBe('WARN');
  });
});

describe('runDomainCheck — TLS', () => {
  it('returns FAIL for expired certificates', async () => {
    const ports = makePorts({
      now: new Date('2026-06-01T00:00:00Z'),
      tls: {
        validFrom: '2020-01-01T00:00:00Z',
        validTo: '2026-01-01T00:00:00Z',
        issuer: 'CN=Old CA',
        subjectAltNames: ['example.com'],
        chainLength: 3,
        protocol: 'TLSv1.2',
        authorized: false,
        authorizationError: 'CERT_HAS_EXPIRED',
      },
    });

    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: false,
      checkDns: false,
      checkTls: true,
      timeoutMs: 500,
    });
    expect(res.tls.status).toBe('FAIL');
    expect(res.tls.error).toContain('expired');
  });

  it('returns FAIL when the TLS probe throws', async () => {
    const ports = makePorts({ tlsThrows: 'econnrefused' });
    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: false,
      checkDns: false,
      checkTls: true,
      timeoutMs: 500,
    });
    expect(res.tls.status).toBe('FAIL');
    expect(res.tls.error).toContain('econnrefused');
  });
});

describe('skipped sub-checks', () => {
  it('records SKIP + null data for disabled checks', async () => {
    const ports = makePorts();
    const res = await runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: false,
      checkDns: false,
      checkTls: false,
      timeoutMs: 500,
    });
    expect(res.whois.status).toBe('SKIP');
    expect(res.dns.status).toBe('SKIP');
    expect(res.tls.status).toBe('SKIP');
    // v2 — `details.schemaVersion` and the `email.hasMx` shim are
    // always emitted so the consumers don't have to null-check.
    expect(res.details.whois).toBeUndefined();
    expect(res.details.dns).toBeUndefined();
    expect(res.details.tls).toBeUndefined();
  });
});

describe('deriveDomainStatus', () => {
  // Stub for the v2 sub-checks. `deriveDomainStatus` only reads
  // status / whois / tls fields so the placeholders are enough.
  const emptyV2Subs = {
    email: { status: 'SKIP' as const, data: null, error: null },
    dnssec: { status: 'SKIP' as const, data: null, error: null },
    nsMatch: { status: 'SKIP' as const, data: null, error: null },
    http: { status: 'SKIP' as const, data: null, error: null },
    score: null,
    noSite: false,
  };

  it('returns EXPIRED when whois expiry is in the past', () => {
    const status = deriveDomainStatus(
      {
        checkedAt: new Date('2026-06-01T00:00:00Z'),
        whois: {
          status: 'OK',
          data: {
            registrar: null,
            registeredAt: null,
            expiresAt: new Date('2026-05-01T00:00:00Z'),
            source: 'rdap',
            statusCodes: [],
            locked: false,
            hold: false,
            whoisNs: [],
            secureDns: null,
          },
          error: null,
        },
        dns: { status: 'OK', data: null, error: null },
        tls: { status: 'SKIP', data: null, error: null },
        details: {},
        aggregateError: null,
        ...emptyV2Subs,
      },
      30,
    );
    expect(status).toBe('EXPIRED');
  });

  it('returns EXPIRING inside the threshold window', () => {
    const status = deriveDomainStatus(
      {
        checkedAt: new Date('2026-06-01T00:00:00Z'),
        whois: {
          status: 'OK',
          data: {
            registrar: null,
            registeredAt: null,
            expiresAt: new Date('2026-06-20T00:00:00Z'),
            source: 'rdap',
            statusCodes: [],
            locked: false,
            hold: false,
            whoisNs: [],
            secureDns: null,
          },
          error: null,
        },
        dns: { status: 'OK', data: null, error: null },
        tls: { status: 'SKIP', data: null, error: null },
        details: {},
        aggregateError: null,
        ...emptyV2Subs,
      },
      30,
    );
    expect(status).toBe('EXPIRING');
  });

  it('returns OK when every sub-check is healthy and no expiry is near', () => {
    const status = deriveDomainStatus(
      {
        checkedAt: new Date('2026-06-01T00:00:00Z'),
        whois: {
          status: 'OK',
          data: {
            registrar: null,
            registeredAt: null,
            expiresAt: new Date('2028-01-01T00:00:00Z'),
            source: 'rdap',
            statusCodes: [],
            locked: false,
            hold: false,
            whoisNs: [],
            secureDns: null,
          },
          error: null,
        },
        dns: { status: 'OK', data: null, error: null },
        tls: {
          status: 'OK',
          data: {
            validFrom: null,
            validTo: new Date('2028-01-01T00:00:00Z'),
            issuer: null,
            subjectAltNames: [],
            chainLength: 3,
            protocol: null,
            authorized: true,
            authorizationError: null,
            keyAlgo: 'RSA',
            keyBits: 2048,
            sigAlgo: 'RSA-SHA256',
            mustStaple: false,
            ocspStapled: false,
            daysUntilExpiry: 365,
          },
          error: null,
        },
        details: {},
        aggregateError: null,
        ...emptyV2Subs,
      },
      30,
    );
    expect(status).toBe('OK');
  });
});

describe('no site (parked domain)', () => {
  const dnsWith = (a: string[], aaaa: string[] = [], ns: string[] = ['a.ns.cloudflare.com']) =>
    ({
      status: 'WARN' as const,
      data: { a, aaaa, mx: [], ns, txt: [], caa: [] } as never,
      error: null,
    });

  it('is no site when DNS answers but the name has no A/AAAA', () => {
    expect(isNoSite(true, dnsWith([]))).toBe(true);
    expect(isNoSite(true, dnsWith(['192.0.2.1']))).toBe(false);
    expect(isNoSite(true, dnsWith([], ['2001:db8::1']))).toBe(false);
  });

  it('is not no site when nothing answers (NXDOMAIN / REFUSED come back empty)', () => {
    expect(isNoSite(true, dnsWith([], [], []))).toBe(false);
  });

  it('is not no site when DNS failed or was not checked: that is a real problem', () => {
    expect(isNoSite(true, { status: 'FAIL', data: null, error: 'SERVFAIL' })).toBe(false);
    expect(isNoSite(false, dnsWith([]))).toBe(false);
  });

  const base = (overrides: Record<string, unknown>) =>
    ({
      checkedAt: new Date('2026-06-01T00:00:00Z'),
      whois: {
        status: 'OK',
        data: {
          registrar: null,
          registeredAt: null,
          expiresAt: new Date('2028-01-01T00:00:00Z'),
          source: 'rdap',
          statusCodes: [],
          locked: false,
          hold: false,
          whoisNs: [],
          secureDns: null,
        },
        error: null,
      },
      dns: { status: 'OK', data: null, error: null },
      tls: { status: 'SKIP', data: null, error: null },
      email: { status: 'SKIP', data: null, error: null },
      dnssec: { status: 'SKIP', data: null, error: null },
      nsMatch: { status: 'SKIP', data: null, error: null },
      http: { status: 'SKIP', data: null, error: null },
      details: {},
      aggregateError: null,
      score: null,
      noSite: true,
      ...overrides,
    }) as never;

  it('a healthy parked domain is NO_SITE, not FAIL or OK', () => {
    expect(deriveDomainStatus(base({}), 30)).toBe('NO_SITE');
  });

  it('registration problems still win over no site', () => {
    expect(
      deriveDomainStatus(
        base({
          whois: {
            status: 'OK',
            data: { expiresAt: new Date('2026-06-10T00:00:00Z'), hold: false },
            error: null,
          },
        }),
        30,
      ),
    ).toBe('EXPIRING');
  });
});

describe('no-site scoring', () => {
  it('drops web-only items from the score, keeps DNS hygiene items', async () => {
    const { computeScore } = await import('./score.js');
    const details = {
      dns: { a: [], aaaa: [], mx: [], ns: ['a.ns.cloudflare.com'], caa: [] },
      whois: { expiresAt: '2028-01-01T00:00:00Z', locked: true },
    } as never;
    const parked = computeScore(details, new Date('2026-06-01T00:00:00Z'), { noSite: true })!;
    const naive = computeScore(details, new Date('2026-06-01T00:00:00Z'))!;
    const skipped = parked.breakdown.filter((i) => i.status === 'skip').map((i) => i.id);
    expect(skipped).toEqual(expect.arrayContaining(['tls_validity', 'tls_crypto', 'http_redirect', 'hsts', 'addr']));
    expect(parked.breakdown.find((i) => i.id === 'caa')?.status).not.toBe('skip');
    // Not penalised for a website it does not have.
    expect(parked.percent).toBeGreaterThan(naive.percent);
  });
});

describe('runDomainCheck: no-site detection', () => {
  const run = (ports: EnginePorts) =>
    runDomainCheck(ports, {
      hostname: 'example.com',
      checkWhois: true,
      checkDns: true,
      checkTls: true,
      timeoutMs: 1000,
    });

  it('a parked name (no A/AAAA on apex or www, TLS cannot connect) is no site', async () => {
    const res = await run(makePorts({ a: [], aaaa: [], tlsThrows: 'getaddrinfo ENOTFOUND example.com' }));
    expect(res.noSite).toBe(true);
    expect(res.tls.status).toBe('SKIP');
  });

  it('a working TLS probe means there is a site, whatever the A lookup said', async () => {
    const res = await run(makePorts({ a: [], aaaa: [] }));
    expect(res.noSite).toBe(false);
    expect(res.tls.status).not.toBe('SKIP');
  });

  it('a bare domain with a working www has a site', async () => {
    const ports = makePorts({ a: [], aaaa: [], tlsThrows: 'getaddrinfo ENOTFOUND example.com' });
    (ports.dns.resolve4 as jest.Mock).mockImplementation(async (name: string) =>
      name.startsWith('www.') ? ['192.0.2.10'] : [],
    );
    const res = await run(ports);
    expect(res.noSite).toBe(false);
  });

  it('an uncertain www lookup (resolver error) does not count as no site', async () => {
    const ports = makePorts({ a: [], aaaa: [], tlsThrows: 'getaddrinfo ENOTFOUND example.com' });
    (ports.dns.resolve4 as jest.Mock).mockImplementation(async (name: string) => {
      if (name.startsWith('www.')) throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
      return [];
    });
    const res = await run(ports);
    expect(res.noSite).toBe(false);
  });
});

