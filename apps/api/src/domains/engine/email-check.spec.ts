import {
  parseSpfRecord,
  parseDmarcRecord,
  runEmailAuthCheck,
} from './email-check.js';
import type { DnsPort, CaaRecord } from './types.js';

describe('parseSpfRecord', () => {
  it('parses a typical Google Workspace SPF record', () => {
    const r = parseSpfRecord('v=spf1 include:_spf.google.com ~all');
    expect(r.present).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.all).toBe('~all');
    expect(r.lookupCount).toBe(1);
    expect(r.mechanisms).toContain('include:_spf.google.com');
  });

  it('detects hard-fail -all', () => {
    const r = parseSpfRecord('v=spf1 mx -all');
    expect(r.all).toBe('-all');
  });

  it('detects neutral ?all', () => {
    const r = parseSpfRecord('v=spf1 ?all');
    expect(r.all).toBe('?all');
  });

  it('flags records exceeding 10-lookup limit as invalid', () => {
    const includes = Array(11)
      .fill(0)
      .map((_, i) => `include:_spf${i}.example.com`)
      .join(' ');
    const r = parseSpfRecord(`v=spf1 ${includes} -all`);
    expect(r.valid).toBe(false);
    expect(r.lookupCount).toBe(11);
  });

  it('counts redirect= as a lookup', () => {
    const r = parseSpfRecord('v=spf1 redirect=_spf.example.com');
    expect(r.lookupCount).toBe(1);
  });

  it('rejects non-spf prefix', () => {
    const r = parseSpfRecord('v=DMARC1; p=reject');
    expect(r.valid).toBe(false);
  });

  it('returns no all qualifier when missing', () => {
    const r = parseSpfRecord('v=spf1 mx');
    expect(r.all).toBeNull();
  });
});

describe('parseDmarcRecord', () => {
  it('parses a full DMARC record', () => {
    const r = parseDmarcRecord(
      'v=DMARC1; p=reject; sp=quarantine; pct=100; rua=mailto:agg@example.com; ruf=mailto:fa@example.com',
    );
    expect(r.present).toBe(true);
    expect(r.policy).toBe('reject');
    expect(r.subdomainPolicy).toBe('quarantine');
    expect(r.pct).toBe(100);
    expect(r.rua).toEqual(['mailto:agg@example.com']);
    expect(r.ruf).toEqual(['mailto:fa@example.com']);
  });

  it('handles p=none', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none');
    expect(r.policy).toBe('none');
  });

  it('handles p=quarantine', () => {
    const r = parseDmarcRecord('v=DMARC1; p=quarantine');
    expect(r.policy).toBe('quarantine');
  });

  it('returns nulls when v tag missing', () => {
    const r = parseDmarcRecord('p=reject');
    expect(r.policy).toBeNull();
    expect(r.pct).toBeNull();
  });

  it('ignores invalid pct', () => {
    const r = parseDmarcRecord('v=DMARC1; p=reject; pct=abc');
    expect(r.pct).toBeNull();
  });

  it('splits multiple rua addresses', () => {
    const r = parseDmarcRecord(
      'v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:b@y.com',
    );
    expect(r.rua).toEqual(['mailto:a@x.com', 'mailto:b@y.com']);
  });
});

function makeDns(map: Record<string, string[][]>): DnsPort {
  return {
    resolve4: jest.fn(async () => []),
    resolve6: jest.fn(async () => []),
    resolveMx: jest.fn(async () => []),
    resolveNs: jest.fn(async () => []),
    resolveTxt: jest.fn(async (hostname: string) => {
      if (hostname in map) return map[hostname]!;
      const err = new Error('NODATA') as NodeJS.ErrnoException;
      err.code = 'ENODATA';
      throw err;
    }),
    resolveCaa: jest.fn(async (): Promise<CaaRecord[]> => []),
    resolve: jest.fn(async () => []),
  };
}

describe('runEmailAuthCheck', () => {
  it('auto-skips when no MX records', async () => {
    const dns = makeDns({});
    const res = await runEmailAuthCheck(dns, {
      hostname: 'example.com',
      mxHosts: [],
    });
    expect(res.status).toBe('SKIP');
    expect(res.data?.hasMx).toBe(false);
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it('detects Google MX provider and probes Google selectors', async () => {
    const dns = makeDns({
      'example.com': [['v=spf1 include:_spf.google.com -all']],
      '_dmarc.example.com': [['v=DMARC1; p=reject']],
      'google._domainkey.example.com': [['v=DKIM1; p=AAAA']],
    });
    const res = await runEmailAuthCheck(dns, {
      hostname: 'example.com',
      mxHosts: ['smtp.google.com'],
    });
    expect(res.data?.dkim?.provider).toBe('google');
    expect(res.data?.dkim?.selectorsFound).toContain('google');
    expect(res.data?.spf?.all).toBe('-all');
    expect(res.data?.dmarc?.policy).toBe('reject');
  });

  it('returns WARN when SPF missing but DMARC present', async () => {
    const dns = makeDns({
      'example.com': [],
      '_dmarc.example.com': [['v=DMARC1; p=quarantine']],
    });
    const res = await runEmailAuthCheck(dns, {
      hostname: 'example.com',
      mxHosts: ['mx.example.com'],
    });
    expect(res.status).toBe('WARN');
    expect(res.data?.spf?.present).toBe(false);
    expect(res.data?.dmarc?.present).toBe(true);
  });

  it('honours user-supplied selector override', async () => {
    const dns = makeDns({
      'example.com': [['v=spf1 -all']],
      '_dmarc.example.com': [['v=DMARC1; p=reject']],
      'custom._domainkey.example.com': [['v=DKIM1; p=ZZZ']],
    });
    const res = await runEmailAuthCheck(dns, {
      hostname: 'example.com',
      mxHosts: ['mx.example.com'],
      dkimSelectorOverride: ['custom'],
    });
    expect(res.data?.dkim?.selectorsFound).toContain('custom');
    expect(res.data?.dkim?.selectorsChecked).toContain('custom');
  });
});
