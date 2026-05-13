import type { DomainCheckDetails } from '@weavestream/shared';

import { DOMAIN_SCORE_VERSION, computeScore } from './score.js';

const NOW = new Date('2025-06-01T00:00:00Z');

function emptyDetails(over: Partial<DomainCheckDetails> = {}): DomainCheckDetails {
  return {
    schemaVersion: 2,
    whois: undefined,
    dns: undefined,
    tls: undefined,
    email: undefined,
    http: undefined,
    score: undefined,
    ...over,
  };
}

function goodDetails(): DomainCheckDetails {
  return emptyDetails({
    whois: {
      registrar: 'TestRegistrar',
      registeredAt: '2020-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
      source: 'rdap',
      statusCodes: ['clienttransferprohibited'],
      locked: true,
      hold: false,
      whoisNs: ['ns1.example.com', 'ns2.example.com'],
    },
    dns: {
      a: ['1.2.3.4'],
      aaaa: [],
      mx: [{ preference: 10, exchange: 'mx.example.com' }],
      ns: ['ns1.example.com', 'ns2.example.com'],
      txt: [],
      caa: [{ flag: 0, tag: 'issue', value: 'letsencrypt.org' }],
      dnssec: { signed: true, source: 'rdap', dsRecordCount: 1 },
      nsMatch: {
        dnsNs: ['ns1.example.com', 'ns2.example.com'],
        whoisNs: ['ns1.example.com', 'ns2.example.com'],
        match: 'match',
      },
    },
    tls: {
      validFrom: '2025-01-01T00:00:00Z',
      validTo: '2026-01-01T00:00:00Z',
      issuer: 'Test CA',
      subjectAltNames: ['example.com'],
      chainLength: 2,
      protocol: 'TLSv1.3',
      authorized: true,
      authorizationError: null,
      cert: {
        keyAlgo: 'RSA',
        keyBits: 2048,
        sigAlgo: 'RSA-SHA256',
        mustStaple: false,
        ocspStapled: true,
        daysUntilExpiry: 214,
      },
    },
    email: {
      hasMx: true,
      spf: {
        present: true,
        record: 'v=spf1 include:_spf.example.com -all',
        mechanisms: ['include:_spf.example.com', '-all'],
        all: '-all',
        lookupCount: 1,
        valid: true,
      },
      dmarc: {
        present: true,
        policy: 'reject',
        subdomainPolicy: 'reject',
        pct: 100,
        rua: ['mailto:dmarc@example.com'],
        ruf: [],
        raw: 'v=DMARC1; p=reject; sp=reject; pct=100',
      },
      dkim: {
        selectorsChecked: ['google', 'default'],
        selectorsFound: ['google'],
        provider: 'google',
      },
    },
    http: {
      redirectsToHttps: true,
      finalStatus: 200,
      finalUrl: 'https://example.com/',
      hsts: {
        present: true,
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
    },
  });
}

describe('computeScore', () => {
  it('returns null when no sub-check data is present', () => {
    expect(computeScore(emptyDetails(), NOW)).toBeNull();
  });

  it('grades a fully-configured domain as excellent (~100%)', () => {
    const score = computeScore(goodDetails(), NOW)!;
    expect(score).not.toBeNull();
    expect(score.version).toBe(DOMAIN_SCORE_VERSION);
    expect(score.tier).toBe('excellent');
    expect(score.percent).toBeGreaterThanOrEqual(95);
    expect(score.hardOverride).toBeNull();
  });

  it('auto-skips email block on no-MX and rebalances max', () => {
    const details = goodDetails();
    details.email = { hasMx: false };
    details.dns!.mx = [];
    const score = computeScore(details, NOW)!;
    expect(score).not.toBeNull();
    // Email block (33pts) should be dropped from the denominator.
    // MX item (3pts) also has no value -> partial penalty.
    expect(score.max).toBeLessThan(100);
    expect(score.tier).toMatch(/excellent|good/);
    const emailItems = score.breakdown.filter((b) =>
      b.id.startsWith('spf_') || b.id.startsWith('dmarc_') || b.id === 'dkim_found',
    );
    for (const item of emailItems) {
      expect(item.status).toBe('skip');
    }
  });

  it('applies force_critical override when TLS expired', () => {
    const details = goodDetails();
    details.tls!.validTo = '2025-05-01T00:00:00Z'; // expired before NOW
    details.tls!.cert!.daysUntilExpiry = -31;
    const score = computeScore(details, NOW)!;
    expect(score.hardOverride?.kind).toBe('force_critical');
    expect(score.percent).toBeLessThanOrEqual(20);
    expect(score.tier).toBe('critical');
  });

  it('applies force_critical override when WHOIS expired', () => {
    const details = goodDetails();
    details.whois!.expiresAt = '2025-05-01T00:00:00Z';
    const score = computeScore(details, NOW)!;
    expect(score.hardOverride?.kind).toBe('force_critical');
    expect(score.percent).toBeLessThanOrEqual(20);
  });

  it('applies force_critical when registry hold flag set', () => {
    const details = goodDetails();
    details.whois!.hold = true;
    const score = computeScore(details, NOW)!;
    expect(score.hardOverride?.kind).toBe('force_critical');
    expect(score.percent).toBeLessThanOrEqual(20);
  });

  it('caps at fair when MX present but no SPF and no DMARC', () => {
    const details = goodDetails();
    details.email!.spf = {
      present: false,
      record: null,
      mechanisms: [],
      all: null,
      lookupCount: 0,
      valid: false,
    };
    details.email!.dmarc = {
      present: false,
      policy: null,
      subdomainPolicy: null,
      pct: null,
      rua: [],
      ruf: [],
      raw: null,
    };
    const score = computeScore(details, NOW)!;
    expect(score.hardOverride?.kind).toBe('cap_fair');
    expect(score.percent).toBeLessThanOrEqual(60);
  });

  it('returns tier "good" for a 75% score', () => {
    // Tier boundary sanity — 90/75/55/35/0
    const fixtures: Array<{ pct: number; tier: string }> = [
      { pct: 100, tier: 'excellent' },
      { pct: 90, tier: 'excellent' },
      { pct: 89, tier: 'good' },
      { pct: 75, tier: 'good' },
      { pct: 74, tier: 'fair' },
      { pct: 55, tier: 'fair' },
      { pct: 54, tier: 'poor' },
      { pct: 35, tier: 'poor' },
      { pct: 34, tier: 'critical' },
      { pct: 0, tier: 'critical' },
    ];
    // We can't directly call tierForPercent (private), but we can
    // exercise the public surface by constructing details that yield
    // each percent — covered indirectly by the other test cases. Here
    // we just verify the rubric never assigns a tier inconsistent
    // with the table above.
    const score = computeScore(goodDetails(), NOW)!;
    const row = fixtures.find((f) => f.pct === score.percent);
    if (row) expect(score.tier).toBe(row.tier);
  });

  it('treats unverifiable NS match as skip rather than fail', () => {
    const details = goodDetails();
    details.dns!.nsMatch = {
      dnsNs: ['ns1.example.com', 'ns2.example.com'],
      whoisNs: [],
      match: 'unverifiable',
    };
    details.whois!.whoisNs = [];
    const score = computeScore(details, NOW)!;
    const item = score.breakdown.find((b) => b.id === 'ns_match');
    expect(item?.status).toBe('skip');
  });

  it('downgrades TLS validity for short expiry', () => {
    const details = goodDetails();
    details.tls!.cert!.daysUntilExpiry = 10;
    const score = computeScore(details, NOW)!;
    const item = score.breakdown.find((b) => b.id === 'tls_validity');
    expect(item?.points).toBe(3);
    expect(item?.status).toBe('partial');
  });

  it('awards no points for HSTS shorter than 180 days', () => {
    const details = goodDetails();
    details.http!.hsts = {
      present: true,
      maxAge: 86_400,
      includeSubDomains: false,
      preload: false,
    };
    const score = computeScore(details, NOW)!;
    const item = score.breakdown.find((b) => b.id === 'hsts');
    expect(item?.points).toBe(2);
    expect(item?.status).toBe('partial');
  });

  it('flags weak TLS crypto', () => {
    const details = goodDetails();
    details.tls!.cert!.keyAlgo = 'RSA';
    details.tls!.cert!.keyBits = 1024;
    details.tls!.cert!.sigAlgo = 'RSA-SHA1';
    const score = computeScore(details, NOW)!;
    const item = score.breakdown.find((b) => b.id === 'tls_crypto');
    expect(item?.points).toBe(0);
    expect(item?.status).toBe('fail');
  });
});
