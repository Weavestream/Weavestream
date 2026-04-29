import {
  deriveDomainStatus,
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
    },
    tls: {
      probe: jest.fn(async () => {
        if (opts.tlsThrows) throw new Error(opts.tlsThrows);
        return (
          opts.tls ?? {
            validFrom: '2025-01-01T00:00:00.000Z',
            validTo: '2027-01-01T00:00:00.000Z',
            issuer: 'CN=Test CA',
            subjectAltNames: ['example.com'],
            chainLength: 3,
            protocol: 'TLSv1.3',
            authorized: true,
            authorizationError: null,
          }
        );
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
    expect(res.details).toEqual({});
  });
});

describe('deriveDomainStatus', () => {
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
          },
          error: null,
        },
        dns: { status: 'OK', data: null, error: null },
        tls: { status: 'SKIP', data: null, error: null },
        details: {},
        aggregateError: null,
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
          },
          error: null,
        },
        dns: { status: 'OK', data: null, error: null },
        tls: { status: 'SKIP', data: null, error: null },
        details: {},
        aggregateError: null,
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
          },
          error: null,
        },
        details: {},
        aggregateError: null,
      },
      30,
    );
    expect(status).toBe('OK');
  });
});
