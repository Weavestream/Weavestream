import { safeExternalHref, safeProseHref } from './safe-external-href';

describe('safeExternalHref', () => {
  it('passes http/https through, case-insensitively', () => {
    expect(safeExternalHref('https://portal.example.com/login')).toBe(
      'https://portal.example.com/login',
    );
    expect(safeExternalHref('http://10.0.0.1:8443/admin')).toBe(
      'http://10.0.0.1:8443/admin',
    );
    expect(safeExternalHref('HTTPS://Example.com/A')).toBe('https://example.com/A');
  });

  it('promotes a scheme-less host to https instead of a relative route', () => {
    // A raw <a href="portal.example.com"> would navigate to
    // /m/passwords/portal.example.com — the exact bug this exists for.
    expect(safeExternalHref('portal.example.com')).toBe('https://portal.example.com/');
    expect(safeExternalHref('example.com/path?q=1')).toBe('https://example.com/path?q=1');
    // Protocol-relative input is attacker-shaped ambiguity; it gets the
    // same https promotion, never the page's scheme.
    expect(safeExternalHref('//example.com/x')).toBe('https://example.com/x');
  });

  it('classifies host:port as a host, not a scheme — the field-gear shape', () => {
    // A bare scheme regex reads `example.com:` as a scheme and would
    // reject exactly the URLs technicians store most (device admin UIs).
    expect(safeExternalHref('example.com:8443')).toBe('https://example.com:8443/');
    expect(safeExternalHref('localhost:8080')).toBe('https://localhost:8080/');
    expect(safeExternalHref('router.local:8443/admin')).toBe(
      'https://router.local:8443/admin',
    );
    expect(safeExternalHref('10.0.0.1:8443')).toBe('https://10.0.0.1:8443/');
    // An out-of-range port fails URL parsing → copy-only, not a throw.
    expect(safeExternalHref('example.com:99999')).toBeNull();
  });

  it('rejects control characters BEFORE parsing — the parser would strip them', () => {
    // WHATWG URL silently removes \t\n\r: without the pre-check these
    // would become a merged host and a smuggled executable scheme.
    expect(safeExternalHref('example.com\n.evil')).toBeNull();
    expect(safeExternalHref('java\tscript:alert(1)')).toBeNull();
    expect(safeExternalHref('https://exa\rmple.com')).toBeNull();
  });

  it('rejects every non-http scheme', () => {
    // eslint-disable-next-line no-script-url -- the rejected input under test
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('data:text/html,hi')).toBeNull();
    expect(safeExternalHref('file:///etc/passwd')).toBeNull();
    expect(safeExternalHref('vbscript:x')).toBeNull();
    expect(safeExternalHref('ssh://host')).toBeNull();
    expect(safeExternalHref('JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects unparseable and empty values', () => {
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref('   ')).toBeNull();
    expect(safeExternalHref('https://')).toBeNull();
    expect(safeExternalHref('http://')).toBeNull();
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(safeExternalHref('  https://example.com  ')).toBe('https://example.com/');
  });
});

describe('safeProseHref', () => {
  it('passes rooted same-origin paths verbatim instead of promoting them to hosts', () => {
    expect(safeProseHref('/docs/x')).toBe('/docs/x');
    expect(safeProseHref('/api/v1/companies/c/uploads/u/image')).toBe(
      '/api/v1/companies/c/uploads/u/image',
    );
  });

  it('passes fragment and query-only references verbatim', () => {
    expect(safeProseHref('#fn-1')).toBe('#fn-1');
    expect(safeProseHref('?tab=2')).toBe('?tab=2');
  });

  it('passes dot-relative paths verbatim', () => {
    expect(safeProseHref('./runbook')).toBe('./runbook');
    expect(safeProseHref('../runbook')).toBe('../runbook');
  });

  it('never classifies scheme-relative shapes as same-origin', () => {
    // Browsers treat both as authority, not path — they must go through
    // the external policy (which promotes to an https host), never pass
    // verbatim into an href that would silently change origin.
    expect(safeProseHref('//evil.com')).not.toBe('//evil.com');
    expect(safeProseHref('/\\evil.com')).not.toBe('/\\evil.com');
    expect(safeProseHref('//evil.com')?.startsWith('https://')).toBe(true);
  });

  it('rejects control characters before classification', () => {
    expect(safeProseHref('/a\tb')).toBeNull();
    expect(safeProseHref('#fn\n1')).toBeNull();
  });

  it('defers everything else to safeExternalHref', () => {
    // eslint-disable-next-line no-script-url -- the rejected input under test
    expect(safeProseHref('javascript:alert(1)')).toBeNull();
    expect(safeProseHref('mailto:a@b.example')).toBeNull();
    expect(safeProseHref('portal.example.com')).toBe('https://portal.example.com/');
    expect(safeProseHref('https://example.com/x')).toBe('https://example.com/x');
  });

  it('is idempotent for every passing form', () => {
    for (const input of ['/docs/x', '#fn-1', '?tab=2', './runbook', '../runbook', 'portal.example.com', 'https://example.com/x']) {
      const once = safeProseHref(input);
      expect(once).not.toBeNull();
      expect(safeProseHref(once as string)).toBe(once);
    }
  });
});
